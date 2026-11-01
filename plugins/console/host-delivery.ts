import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { mergeBack, pushBranch, reportWorktrees } from "./worktrees";
import { parseChangeSet, type ChangeFile, type ChangeHunk, type ListedFile } from "./review-tour";
import { hostContract, hostProofInput, proofReceiptSchema } from "./delivery-contract";
import type { z } from "zod";
import {
  PROOF_MAX_FILE_BYTES,
  parseGithubPr,
  proofCommentBody,
  proofMedia,
  proofName,
  proofPolicy,
  proofUrl,
  PROOF_BRANCH_MESSAGE,
  proofBranchConflict,
  validProofBranch,
} from "./src/delivery-proof";
const exec = promisify(execFile);
export type Run = (command: string, args: string[], cwd: string) => Promise<string>;
const run: Run = async (command, args, cwd) =>
  (
    await exec(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
        PAGER: "cat",
        GH_PAGER: "cat",
      },
    })
  ).stdout;
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
export function parseRemote(raw: string) {
  const value = raw
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
  const url = new URL(value);
  if (!/^(https?|ssh):$/.test(url.protocol) || url.username || url.password || !url.hostname)
    throw new Error("Unsupported credential-bearing Git remote.");
  const repo = url.pathname.replace(/^\//, "");
  if (!repo || repo.startsWith("-") || !/^[\w./-]+$/.test(repo))
    throw new Error("Unsupported Git remote repository path.");
  return {
    host: url.hostname,
    repo,
    provider:
      url.hostname === "github.com" || /github/i.test(url.hostname)
        ? ("github" as const)
        : url.hostname === "gitlab.com" || /gitlab/i.test(url.hostname)
          ? ("gitlab" as const)
          : ("unknown" as const),
  };
}
export type HostKind = "github" | "gitlab" | "bitbucket" | "azure" | "other";
/** Which Git service a remote host name belongs to, and whether this plugin can read its reviews. */
export function classifyHost(hostname: string): { kind: HostKind; label: string; reviewAdapter: boolean } {
  const name = hostname.toLowerCase();
  if (name === "github.com" || /github/.test(name)) return { kind: "github", label: "GitHub", reviewAdapter: true };
  if (name === "gitlab.com" || /gitlab/.test(name)) return { kind: "gitlab", label: "GitLab", reviewAdapter: true };
  if (/bitbucket/.test(name)) return { kind: "bitbucket", label: "Bitbucket", reviewAdapter: false };
  if (name === "dev.azure.com" || /visualstudio\.com$|azure/.test(name)) return { kind: "azure", label: "Azure DevOps", reviewAdapter: false };
  return { kind: "other", label: hostname, reviewAdapter: false };
}
/** The Git service behind a workspace's origin, from the remote URL alone. */
export async function readGitHost(cwd: string, command: Run = run) {
  if (!path.isAbsolute(cwd)) throw new Error("A host-owned absolute workspace is required.");
  const remote = parseRemote(await command("git", ["remote", "get-url", "origin"], cwd));
  const { kind, label, reviewAdapter } = classifyHost(remote.host);
  return { host: remote.host, hostKind: kind, label, reviewAdapter };
}
/** A diff larger than the process buffer is cut, not fatal: the review reports truncation. */
async function readBoundedDiff(command: Run, program: string, args: string[], cwd: string) {
  try {
    return await command(program, args, cwd);
  } catch (cause) {
    const partial = cause as { code?: string; stdout?: unknown };
    if (partial.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && typeof partial.stdout === "string")
      // The buffer (2 MiB) is far above the 160k review slice, so the result is marked truncated.
      return partial.stdout;
    throw cause;
  }
}
const digest = (algorithm: "sha256" | "sha1", value: string) =>
  createHash(algorithm).update(value).digest("hex");
const githubLines = (hunk: ChangeHunk) => {
  const side = hunk.new ? { mark: "R", span: hunk.new } : { mark: "L", span: hunk.old! };
  const { start, end } = side.span;
  return end > start ? `${side.mark}${start}-${side.mark}${end}` : `${side.mark}${start}`;
};
/** Links every file and hunk on the provider's own review page; GitLab only anchors whole files. */
export function linkChanges(
  files: ChangeFile[],
  url: string,
  provider: "github" | "gitlab",
): ChangeFile[] {
  return files.map((file) => {
    const link =
      provider === "github"
        ? `${url}/files#diff-${digest("sha256", file.path)}`
        : `${url}/diffs#${digest("sha1", file.path)}`;
    return {
      ...file,
      link,
      hunks: file.hunks.map((hunk) => ({
        ...hunk,
        link: provider === "github" && (hunk.new || hunk.old) ? `${link}${githubLines(hunk)}` : link,
      })),
    };
  });
}
export async function readReview(cwd: string, expectedUrl: string | null, command: Run = run) {
  if (!path.isAbsolute(cwd)) throw new Error("A host-owned absolute workspace is required.");
  const remote = parseRemote(await command("git", ["remote", "get-url", "origin"], cwd));
  const readAt = Date.now();
  const named = classifyHost(remote.host);
  if (remote.provider === "unknown")
    return {
      provider: remote.provider,
      host: remote.host,
      hostKind: named.kind,
      url: null,
      revision: null,
      text: `${named.label} (${remote.host}) has no published review adapter. Use its existing repository integration.`,
      diff: "",
      changes: [] as ChangeFile[],
      truncated: false,
      readAt,
      warnings: [
        `${named.label} review API parity requires a provider adapter; no review or permission state was inferred.`,
      ],
    };
  let text: string, diff: string, url: string, revision: string;
  let listed: ListedFile[] = [];
  const warnings: string[] = [];
  if (remote.provider === "github") {
    // Repository host is passed separately so a local gh login never leaks to another hostname.
    const envArgs = ["--repo", `${remote.host}/${remote.repo}`];
    // gh refuses `pr view --repo` without a selector, so name the workspace branch;
    // the identity check below still compares it with the native watcher's PR.
    const branch = (await command("git", ["branch", "--show-current"], cwd)).trim();
    if (!branch)
      throw new Error("The workspace has no current branch (detached HEAD); no PR can be resolved.");
    const pr = JSON.parse(
      await command(
        "gh",
        [
          "pr",
          "view",
          branch,
          ...envArgs,
          "--json",
          "number,url,headRefOid,title,body,comments,reviews,files,statusCheckRollup",
        ],
        cwd,
      ),
    );
    url = String(pr.url);
    revision = String(pr.headRefOid);
    listed = Array.isArray(pr.files)
      ? pr.files
          .filter((file: { path?: unknown }) => typeof file?.path === "string")
          .map((file: { path: string; additions?: unknown; deletions?: unknown }) => ({
            path: file.path,
            additions: typeof file.additions === "number" ? file.additions : null,
            deletions: typeof file.deletions === "number" ? file.deletions : null,
          }))
      : [];
    text = JSON.stringify(pr, null, 2);
    if (expectedUrl && expectedUrl !== url)
      throw new Error("The branch now resolves to another PR. Refresh before reviewing.");
    let reviewThreads: unknown = null;
    try {
      const [owner, name] = remote.repo.split("/");
      if (!owner || !name || !Number.isSafeInteger(pr.number))
        throw new Error("The provider omitted the PR number or repository identity.");
      const query =
        "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved isOutdated path line comments(first:100){pageInfo{hasNextPage}nodes{body url createdAt author{login}}}}}}}}";
      reviewThreads = JSON.parse(
        await command(
          "gh",
          [
            "api",
            "graphql",
            "--hostname",
            remote.host,
            "-f",
            `query=${query}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `name=${name}`,
            "-F",
            `number=${pr.number}`,
          ],
          cwd,
        ),
      );
      const parsed = reviewThreads as {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                pageInfo?: { hasNextPage?: boolean };
                nodes?: { comments?: { pageInfo?: { hasNextPage?: boolean } } }[];
              };
            };
          };
        };
        errors?: unknown[];
      };
      if (parsed.errors?.length)
        warnings.push(
          "The provider returned review-thread errors; conversation coverage is partial.",
        );
      const threads = parsed.data?.repository?.pullRequest?.reviewThreads;
      if (
        threads?.pageInfo?.hasNextPage ||
        threads?.nodes?.some((thread) => thread.comments?.pageInfo?.hasNextPage)
      )
        warnings.push(
          "Review-thread pagination exceeded 100 rows; inspect the host for remaining comments.",
        );
    } catch (cause) {
      warnings.push(
        `Inline review threads unavailable: ${message(cause)}. Conversation coverage is partial.`,
      );
    }
    text = JSON.stringify({ pullRequest: pr, reviewThreads }, null, 2);
    diff = await readBoundedDiff(command, "gh", ["pr", "diff", url], cwd);
    const after = JSON.parse(await command("gh", ["pr", "view", url, "--json", "headRefOid"], cwd));
    if (after.headRefOid !== revision)
      throw new Error("The PR head changed during the review read. Refresh before reviewing.");
  } else {
    const mr = JSON.parse(
      await command(
        "glab",
        ["mr", "view", "--repo", `${remote.host}/${remote.repo}`, "--output", "json"],
        cwd,
      ),
    );
    url = String(mr.web_url);
    revision = String(mr.sha ?? mr.diff_refs?.head_sha ?? "unknown");
    if (expectedUrl && expectedUrl !== url)
      throw new Error(
        "The branch now resolves to another merge request. Refresh before reviewing.",
      );
    const notes = await command(
      "glab",
      [
        "api",
        `projects/${encodeURIComponent(remote.repo)}/merge_requests/${Number(mr.iid)}/notes`,
        "--hostname",
        remote.host,
      ],
      cwd,
    );
    text = JSON.stringify({ mergeRequest: mr, notes: JSON.parse(notes) }, null, 2);
    diff = await readBoundedDiff(
      command,
      "glab",
      ["mr", "diff", String(Number(mr.iid)), "--repo", `${remote.host}/${remote.repo}`],
      cwd,
    );
    const after = JSON.parse(
      await command(
        "glab",
        [
          "mr",
          "view",
          String(Number(mr.iid)),
          "--repo",
          `${remote.host}/${remote.repo}`,
          "--output",
          "json",
        ],
        cwd,
      ),
    );
    if (String(after.sha ?? after.diff_refs?.head_sha ?? "unknown") !== revision)
      throw new Error(
        "The merge request head changed during the review read. Refresh before reviewing.",
      );
    warnings.push(
      "GitLab notes are bounded by the CLI API page; inspect the host for remaining discussion pages.",
    );
  }
  if (!/^https:\/\//.test(url) || !revision || revision === "undefined")
    throw new Error("The provider returned incomplete review identity.");
  const truncated = text.length > 80_000 || diff.length > 160_000;
  return {
    provider: remote.provider,
    host: remote.host,
    hostKind: named.kind,
    url,
    revision,
    text: text.slice(0, 80_000),
    diff: diff.slice(0, 160_000),
    changes: linkChanges(parseChangeSet(diff, listed), url, remote.provider),
    truncated,
    readAt,
    warnings: [
      ...warnings,
      ...(truncated
        ? ["Review evidence was truncated; inspect the full native diff before deciding."]
        : []),
      "Review evidence is a point-in-time read. Repository permissions and branch rules remain authoritative.",
    ],
  };
}
export async function auditCleanup(cwd: string, command: Run = run) {
  const reasons: string[] = [];
  const revision = (await command("git", ["rev-parse", "HEAD"], cwd)).trim();
  const status = await command(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    cwd,
  );
  const lines = status.split("\n").filter(Boolean),
    ignored = lines.some((line) => line.startsWith("!!")),
    dirty = lines.some((line) => !line.startsWith("!!"));
  const worktrees = await command("git", ["worktree", "list", "--porcelain"], cwd);
  const record = worktrees.split("\n\n").find((entry) => entry.startsWith(`worktree ${cwd}\n`));
  const locked = !record || /^locked(?: |$)/m.test(record);
  let processState: "clear" | "busy" | "unknown" = "unknown";
  // A diagnostic only: deletion still needs core's atomic owner/lease guard.
  try {
    const output = await command("lsof", ["-a", "-d", "cwd", "+D", cwd, "-F", "p"], cwd);
    processState = /^p\d+/m.test(output) ? "busy" : "clear";
  } catch {
    reasons.push("Process ownership could not be exhaustively verified.");
  }
  if (dirty) reasons.push("Tracked changes or untracked files are present.");
  if (ignored) reasons.push("Ignored local files are present and must be retained.");
  if (locked) reasons.push("The worktree is locked or its identity could not be verified.");
  if (processState === "busy") reasons.push("A process holds this workspace.");
  return { revision, dirty, ignored, locked, processState, reasons };
}
export class GhError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export type GhApi = (endpoint: string, method?: string, body?: unknown) => Promise<any>;
const defaultGh: GhApi = (endpoint, method = "GET", body) =>
  new Promise((resolve, reject) => {
    const args = ["api", ...(method === "GET" ? [] : ["-X", method]), endpoint, ...(body === undefined ? [] : ["--input", "-"])];
    const child = execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", PAGER: "cat" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim() ? JSON.parse(stdout) : {});
        const detail = (stderr || stdout || error.message).trim().split("\n")[0];
        const status = Number(/HTTP (\d{3})/.exec(stderr || stdout || "")?.[1] ?? 0);
        reject(new GhError(`gh api ${method} ${endpoint.split("?")[0]} failed: ${detail}`, status));
      },
    );
    if (body !== undefined) child.stdin?.end(JSON.stringify(body));
    else child.stdin?.end();
  });
type ProofInput = z.infer<typeof hostProofInput>;
export type ProofReceipt = z.infer<typeof proofReceiptSchema>;
type StoredFile = {
  name: string;
  bytes: number;
  mime: string;
  inline: boolean;
  sha256: string;
  data: Buffer;
  path: string;
  blobSha: string;
  url: string;
  verified: boolean;
};
function describeProof(file: ProofInput["files"][number]): Omit<StoredFile, "path" | "blobSha" | "url" | "verified"> {
  const media = proofMedia(file.name);
  if (!media) throw new Error(`${file.name} is not a supported screenshot or video.`);
  const data = Buffer.from(file.dataBase64, "base64");
  if (!data.length) throw new Error(`${file.name} is empty.`);
  if (data.length > PROOF_MAX_FILE_BYTES) throw new Error(`${file.name} is above the ${PROOF_MAX_FILE_BYTES} byte limit.`);
  if (!media.sniff(data.subarray(0, 16))) throw new Error(`${file.name} does not look like ${media.mime} data.`);
  return {
    name: proofName(file.name),
    bytes: data.length,
    mime: media.mime,
    inline: media.inline,
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
}
async function storeProof(gh: GhApi, repo: string, number: number, branch: string, files: StoredFile[]) {
  const base = `repos/${repo}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  for (const file of files) {
    file.path = `pr-${number}/${stamp}/${file.sha256.slice(0, 12)}-${file.name}`;
    file.blobSha = (await gh(`${base}/git/blobs`, "POST", { content: file.data.toString("base64"), encoding: "base64" })).sha;
  }
  const ref = encodeURIComponent(branch).replace(/%2F/g, "/");
  for (let attempt = 0; attempt < 3; attempt++) {
    let head: string | null = null;
    try {
      head = (await gh(`${base}/git/ref/heads/${ref}`)).object.sha;
    } catch (cause) {
      if (!(cause instanceof GhError) || cause.status !== 404) throw cause;
    }
    const tree = await gh(`${base}/git/trees`, "POST", {
      tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", sha: file.blobSha })),
      ...(head ? { base_tree: (await gh(`${base}/git/commits/${head}`)).tree.sha } : {}),
    });
    const commit = await gh(`${base}/git/commits`, "POST", {
      message: `Delivery proof for pull request #${number}`,
      tree: tree.sha,
      parents: head ? [head] : [],
    });
    try {
      if (head) await gh(`${base}/git/refs/heads/${ref}`, "PATCH", { sha: commit.sha, force: false });
      else await gh(`${base}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: commit.sha });
      return commit.sha as string;
    } catch (cause) {
      if (attempt === 2) throw cause;
    }
  }
  throw new Error("Could not update the proof branch.");
}
const failure = (cause: unknown) => (cause instanceof Error ? cause.message.split("\n")[0] : String(cause));
export async function attachProof(input: ProofInput, gh: GhApi = defaultGh): Promise<ProofReceipt> {
  const pr = parseGithubPr(input.prUrl);
  if (!pr) throw new Error("Attaching proof is only available for github.com pull requests.");
  if (!validProofBranch(input.branch)) throw new Error(PROOF_BRANCH_MESSAGE);
  if (!input.files.length) throw new Error("Choose at least one screenshot or video.");
  const files = input.files.map((file) => ({ ...describeProof(file), path: "", blobSha: "", url: "", verified: false }));
  const info = await gh(`repos/${pr.repo}`);
  const pull = await gh(`repos/${pr.repo}/pulls/${pr.number}`);
  if (pull.state !== "open")
    throw new Error(`Pull request #${pr.number} is ${pull.state}; proof is only added to open pull requests.`);
  const conflict = proofBranchConflict(input.branch, {
    defaultBranch: info.default_branch,
    headRef: pull.head?.ref,
    baseRef: pull.base?.ref,
  });
  if (conflict) throw new Error(conflict);
  const policy = proofPolicy(pr.repo, Boolean(info.private));
  const commit = await storeProof(gh, pr.repo, pr.number, input.branch, files);
  for (const file of files) {
    file.url = proofUrl(pr.repo, commit, file.path);
    const found = await gh(`repos/${pr.repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`);
    file.verified = found.sha === file.blobSha && found.size === file.bytes;
  }
  if (!files.every((file) => file.verified))
    throw new Error("Stored bytes could not be verified against the upload; no comment was posted.");
  const receipt: ProofReceipt = {
    uploaded: true,
    repo: pr.repo,
    pr: pr.number,
    prUrl: String(pull.html_url ?? input.prUrl),
    branch: input.branch,
    commit,
    uploadedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    accessPolicy: policy,
    expiry: `None: kept until the ${input.branch} branch is deleted.`,
    files: files.map(({ name, bytes, mime, sha256, path, url, verified }) => ({ name, bytes, mime, sha256, path, url, verified })),
    comment: null,
  };
  try {
    const body = proofCommentBody(files, input.note, input.branch, commit, policy);
    const posted = await gh(`repos/${pr.repo}/issues/${pr.number}/comments`, "POST", { body });
    const reread = await gh(`repos/${pr.repo}/issues/comments/${posted.id}`);
    const intact = files.every((file) => String(reread.body ?? "").includes(file.url));
    receipt.comment = { id: Number(posted.id), url: String(posted.html_url), verified: intact };
    if (!intact) receipt.error = "The comment was posted but the re-read body is missing media URLs.";
  } catch (cause) {
    receipt.error = `The media is stored but the comment failed: ${failure(cause)}`;
  }
  return proofReceiptSchema.parse(receipt);
}
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    review: ({ cwd, url }) => readReview(cwd, url),
    gitHost: ({ cwd }) => readGitHost(cwd),
    cleanupAudit: ({ cwd }) => auditCleanup(cwd),
    worktrees: ({ cwd, base }) => reportWorktrees(cwd, base),
    mergeBack: ({ cwd, ...request }) => mergeBack(cwd, request),
    pushBranch: ({ cwd, ...request }) => pushBranch(cwd, request),
    attachProof: (input) => attachProof(input),
  },
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const exec = promisify(execFile);
export type Run = (command: string, args: string[], cwd: string) => Promise<string>;
export type WorktreeFile = { path: string; additions: number; deletions: number };
export type WorktreeRow = {
  path: string;
  branch: string | null;
  head: string;
  mergeBase: string | null;
  ahead: number;
  behind: number;
  additions: number;
  deletions: number;
  files: WorktreeFile[];
  filesTruncated: boolean;
  dirty: boolean;
  locked: boolean;
  conflicts: string[] | null;
};
export type WorktreeReport = {
  cwd: string;
  base: { ref: string; sha: string };
  worktrees: WorktreeRow[];
  overlaps: { path: string; branches: string[] }[];
};
export type MergeRequest = { branch: string; expectedHead: string; expectedBaseHead: string; expectedBaseRef: string; fetch: boolean };
export type MergeOutcome =
  | { merged: true; sha: string; previous: string; conflicts: [] }
  | { merged: false; sha: null; previous: string; conflicts: string[] };
const MAX_FILES = 200;
const defaultRun: Run = async (command, args, cwd) =>
  (
    await exec(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", PAGER: "cat" },
    })
  ).stdout;
const trimmed = async (command: Run, args: string[], cwd: string) => (await command("git", args, cwd)).trim();
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
async function checkedBranch(command: Run, branch: string, cwd: string) {
  if (!SAFE_BRANCH.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock"))
    throw new Error("Unsupported branch name.");
  await command("git", ["check-ref-format", "--branch", branch], cwd);
}
function parseWorktreeList(raw: string, keepBare = false) {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split("\n")) {
        const space = line.indexOf(" ");
        fields.set(space < 0 ? line : line.slice(0, space), space < 0 ? "" : line.slice(space + 1));
      }
      const ref = fields.get("branch") ?? null;
      return {
        path: fields.get("worktree") ?? "",
        head: fields.get("HEAD") ?? "",
        branch: ref ? ref.replace(/^refs\/heads\//, "") : null,
        locked: fields.has("locked"),
        bare: fields.has("bare"),
      };
    })
    .filter((entry) => entry.path && (keepBare || !entry.bare));
}
/** Git lists the main working tree first. A bare repository has none, so the asking workspace stands in as the base. */
async function baseCheckout(command: Run, cwd: string): Promise<{ path: string; branch: string | null }> {
  const [first] = parseWorktreeList(await command("git", ["worktree", "list", "--porcelain"], cwd), true);
  return first && !first.bare ? { path: first.path, branch: first.branch } : { path: cwd, branch: null };
}
function parseNumstat(raw: string): WorktreeFile[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split("\t");
      return { path: rest.join("\t"), additions: added === "-" ? 0 : Number(added), deletions: removed === "-" ? 0 : Number(removed) };
    });
}
/** Conflicting paths a merge of `head` into `base` would produce, or null when git cannot say. Touches no ref or working file. */
export async function mergeConflicts(command: Run, cwd: string, base: string, head: string): Promise<string[] | null> {
  try {
    await command("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, head], cwd);
    return [];
  } catch (cause) {
    const failure = cause as { code?: unknown; stdout?: unknown };
    if (failure.code === 1 && typeof failure.stdout === "string") {
      const [, ...names] = failure.stdout.split("\n");
      const files = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
      return files.length ? files : ["(conflict reported without file names)"];
    }
    return null;
  }
}
export async function reportWorktrees(
  cwd: string,
  baseRef: string | null,
  command: Run = defaultRun,
): Promise<WorktreeReport> {
  if (!path.isAbsolute(cwd)) throw new Error("A host-owned absolute workspace is required.");
  const ref = baseRef ?? (await baseCheckout(command, cwd)).branch ?? (await trimmed(command, ["branch", "--show-current"], cwd));
  if (!ref) throw new Error("The workspace has no current branch (detached HEAD); name a base to compare against.");
  const sha = await trimmed(command, ["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  const listed = parseWorktreeList(await command("git", ["worktree", "list", "--porcelain"], cwd));
  const rows: WorktreeRow[] = [];
  for (const entry of listed) {
    if (entry.head === sha && entry.branch === ref) continue;
    if (entry.branch === ref) continue;
    const mergeBase = await trimmed(command, ["merge-base", sha, entry.head], cwd).catch(() => null);
    let ahead = 0,
      behind = 0;
    if (mergeBase) {
      const [left, right] = (await trimmed(command, ["rev-list", "--left-right", "--count", `${sha}...${entry.head}`], cwd)).split(/\s+/);
      behind = Number(left) || 0;
      ahead = Number(right) || 0;
    }
    const all = mergeBase
      ? parseNumstat(await command("git", ["diff", "--numstat", "--no-renames", mergeBase, entry.head], cwd))
      : [];
    const dirty = (await command("git", ["status", "--porcelain=v1", "--untracked-files=normal"], entry.path).catch(() => "?")).trim() !== "";
    rows.push({
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      mergeBase,
      ahead,
      behind,
      additions: all.reduce((sum, file) => sum + file.additions, 0),
      deletions: all.reduce((sum, file) => sum + file.deletions, 0),
      files: all.slice(0, MAX_FILES),
      filesTruncated: all.length > MAX_FILES,
      dirty,
      locked: entry.locked,
      conflicts: mergeBase ? await mergeConflicts(command, cwd, sha, entry.head) : null,
    });
  }
  const touched = new Map<string, string[]>();
  for (const row of rows)
    for (const file of row.files) touched.set(file.path, [...(touched.get(file.path) ?? []), row.branch ?? row.path]);
  return {
    cwd,
    base: { ref, sha },
    worktrees: rows,
    overlaps: [...touched]
      .filter(([, branches]) => branches.length > 1)
      .map(([file, branches]) => ({ path: file, branches }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
/** Merges one reviewed branch into the repository's main checkout, whichever worktree asked. Refuses on anything that moved since the panel read it. */
export async function mergeBack(asked: string, request: MergeRequest, command: Run = defaultRun): Promise<MergeOutcome> {
  if (!path.isAbsolute(asked)) throw new Error("A host-owned absolute workspace is required.");
  const cwd = (await baseCheckout(command, asked)).path;
  await checkedBranch(command, request.branch, cwd);
  const current = await trimmed(command, ["branch", "--show-current"], cwd);
  if (!current) throw new Error("The base workspace is on a detached HEAD; check out the base branch first.");
  if (current !== request.expectedBaseRef)
    throw new Error(`The base is on ${current}, not ${request.expectedBaseRef} as this panel showed. Refresh and review the new state.`);
  if (current === request.branch) throw new Error(`Branch ${request.branch} cannot be merged into itself.`);
  const baseHead = await trimmed(command, ["rev-parse", "HEAD"], cwd);
  if (baseHead !== request.expectedBaseHead)
    throw new Error(`The base ${current} moved after this panel read it. Refresh and review the new state.`);
  if ((await command("git", ["status", "--porcelain=v1", "--untracked-files=no"], cwd)).trim())
    throw new Error("The base workspace has uncommitted changes. Commit or stash them before merging back.");
  if (request.fetch) await command("git", ["fetch", "--no-tags", "origin", `refs/heads/${request.branch}`], cwd);
  const head = await trimmed(command, ["rev-parse", "--verify", request.fetch ? "FETCH_HEAD" : `refs/heads/${request.branch}`], cwd);
  if (head !== request.expectedHead)
    throw new Error(`Branch ${request.branch} changed after this panel read it. Refresh and review the new commits.`);
  const conflicts = await mergeConflicts(command, cwd, baseHead, head);
  if (conflicts && conflicts.length) return { merged: false, sha: null, previous: baseHead, conflicts };
  try {
    await command("git", ["merge", "--no-ff", "--no-edit", "-m", `Merge branch '${request.branch}'`, head], cwd);
  } catch (cause) {
    await command("git", ["merge", "--abort"], cwd).catch(() => "");
    throw cause;
  }
  return { merged: true, sha: await trimmed(command, ["rev-parse", "HEAD"], cwd), previous: baseHead, conflicts: [] };
}
/** Publishes one reviewed branch so another machine can fetch it. Never forces. */
export async function pushBranch(
  cwd: string,
  request: { branch: string; expectedHead: string },
  command: Run = defaultRun,
): Promise<{ pushed: true }> {
  if (!path.isAbsolute(cwd)) throw new Error("A host-owned absolute workspace is required.");
  await checkedBranch(command, request.branch, cwd);
  const head = await trimmed(command, ["rev-parse", "--verify", `refs/heads/${request.branch}`], cwd);
  if (head !== request.expectedHead)
    throw new Error(`Branch ${request.branch} changed after this panel read it. Refresh and review the new commits.`);
  await command("git", ["push", "origin", `refs/heads/${request.branch}:refs/heads/${request.branch}`], cwd);
  return { pushed: true };
}

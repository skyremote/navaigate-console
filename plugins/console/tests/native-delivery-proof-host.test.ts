import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { attachProof, GhError, type GhApi } from "../host-delivery";
import { hostProofInput } from "../delivery-contract";
import { proofCommentBody } from "../src/delivery-proof";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const mp4 = Buffer.from("00000018667479706d703432", "hex");
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const b64 = (data: Buffer) => data.toString("base64");

type Call = { method: string; endpoint: string; body: any };
function fakeGithub(over: Partial<{ repo: string; private: boolean; prState: string; lieAboutSize: boolean; commentFails: boolean; defaultBranch: string; headRef: string; baseRef: string; refs: Record<string, string>; commits: Record<string, any> }> = {}) {
  const state = { repo: "acme/widgets", private: true, prState: "open", lieAboutSize: false, commentFails: false, defaultBranch: "main", headRef: "fix/widgets", baseRef: "main", refs: {} as Record<string, string>, commits: {} as Record<string, any>, trees: {} as Record<string, Record<string, string>>, blobs: {} as Record<string, number>, comments: {} as Record<string, string>, calls: [] as Call[], ...over };
  const stable = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");
  const gh: GhApi = async (endpoint, method = "GET", body) => {
    state.calls.push({ method, endpoint, body });
    const prefix = `repos/${state.repo}`;
    const [route, query = ""] = endpoint.split("?");
    const missing = () => new GhError(`Not Found ${endpoint}`, 404);
    if (route === prefix) return { full_name: state.repo, private: state.private, default_branch: state.defaultBranch };
    let m = new RegExp(`^${prefix}/pulls/(\\d+)$`).exec(route);
    if (m && method === "GET") return m[1] === "7" ? { number: 7, state: state.prState, html_url: `https://github.com/${state.repo}/pull/7`, head: { ref: state.headRef }, base: { ref: state.baseRef } } : (() => { throw missing(); })();
    m = new RegExp(`^${prefix}/git/ref/heads/(.+)$`).exec(route);
    if (m && method === "GET") { const head = state.refs[decodeURIComponent(m[1])]; if (!head) throw missing(); return { object: { sha: head } }; }
    m = new RegExp(`^${prefix}/git/commits/(\\w+)$`).exec(route);
    if (m && method === "GET") { const commit = state.commits[m[1]]; if (!commit) throw missing(); return { sha: m[1], tree: { sha: commit.tree } }; }
    if (route === `${prefix}/git/blobs` && method === "POST") {
      const raw = Buffer.from(body.content, "base64");
      const id = createHash("sha1").update(raw).digest("hex");
      state.blobs[id] = raw.length;
      return { sha: id };
    }
    if (route === `${prefix}/git/trees` && method === "POST") {
      const id = stable(body);
      state.trees[id] = Object.fromEntries(body.tree.map((entry: any) => [entry.path, entry.sha]));
      return { sha: id };
    }
    if (route === `${prefix}/git/commits` && method === "POST") {
      const id = stable(body);
      state.commits[id] = { tree: body.tree, parents: body.parents, message: body.message };
      return { sha: id };
    }
    if (route === `${prefix}/git/refs` && method === "POST") { state.refs[body.ref.replace("refs/heads/", "")] = body.sha; return { ref: body.ref }; }
    m = new RegExp(`^${prefix}/git/refs/heads/(.+)$`).exec(route);
    if (m && method === "PATCH") { if (body.force) throw new GhError("force not allowed", 422); state.refs[decodeURIComponent(m[1])] = body.sha; return {}; }
    m = new RegExp(`^${prefix}/contents/(.+)$`).exec(route);
    if (m && method === "GET") {
      const commit = state.commits[query.replace("ref=", "")];
      const blob = commit ? state.trees[commit.tree]?.[decodeURIComponent(m[1])] : undefined;
      if (!blob) throw missing();
      return { sha: blob, size: state.blobs[blob] + (state.lieAboutSize ? 1 : 0) };
    }
    m = new RegExp(`^${prefix}/issues/(\\d+)/comments$`).exec(route);
    if (m && method === "POST") {
      if (state.commentFails) throw new GhError("Resource not accessible", 403);
      const id = Object.keys(state.comments).length + 1;
      state.comments[String(id)] = body.body;
      return { id, html_url: `https://github.com/${state.repo}/pull/7#issuecomment-${9000 + id}` };
    }
    m = new RegExp(`^${prefix}/issues/comments/(\\d+)$`).exec(route);
    if (m && method === "GET") { const text = state.comments[m[1]]; if (text === undefined) throw missing(); return { id: Number(m[1]), body: text }; }
    throw new GhError(`unhandled ${method} ${endpoint}`, 404);
  };
  return { gh, state };
}

const input = (over: Record<string, unknown> = {}) => ({
  cwd: "/work/tree",
  prUrl: "https://github.com/acme/widgets/pull/7",
  note: "Fix verified on Laptop",
  branch: "delivery-proof",
  files: [{ name: "after.png", dataBase64: b64(png) }],
  ...over,
}) as Parameters<typeof attachProof>[0];

describe("host attachProof", () => {
  it("stores the screenshot on a first-time proof branch, comments and returns a verified receipt", async () => {
    const { gh, state } = fakeGithub();
    const receipt = await attachProof(input(), gh);
    const commit = state.refs["delivery-proof"];
    expect(commit).toBeTruthy();
    expect(state.commits[commit].parents).toEqual([]);
    expect(receipt).toMatchObject({ uploaded: true, repo: "acme/widgets", pr: 7, branch: "delivery-proof", commit, prUrl: "https://github.com/acme/widgets/pull/7" });
    expect(receipt.accessPolicy).toMatch(/private/i);
    expect(receipt.expiry).toMatch(/none/i);
    const file = receipt.files[0];
    expect(file.path).toMatch(/^pr-7\/.+\/.{12}-after\.png$/);
    expect(file.url).toBe(`https://github.com/acme/widgets/blob/${commit}/${file.path}?raw=true`);
    expect(file).toMatchObject({ name: "after.png", bytes: png.length, mime: "image/png", sha256: sha(png), verified: true });
    expect(receipt.comment).toEqual({ id: 1, url: "https://github.com/acme/widgets/pull/7#issuecomment-9001", verified: true });
    expect(state.comments["1"]).toContain(`![after.png](${file.url})`);
    expect(state.comments["1"]).toContain("Fix verified on Laptop");
    expect(state.comments["1"]).toContain(sha(png));
    expect(receipt.error).toBeUndefined();
  });

  it("appends to an existing proof branch and never forces the ref", async () => {
    const parent = "a".repeat(40);
    const { gh, state } = fakeGithub({ refs: { "delivery-proof": parent }, commits: { [parent]: { tree: "b".repeat(40), parents: [] } } });
    await attachProof(input(), gh);
    const tree = state.calls.find((c) => c.endpoint.endsWith("/git/trees"))!;
    expect(tree.body.base_tree).toBe("b".repeat(40));
    const commit = state.calls.find((c) => c.endpoint.endsWith("/git/commits") && c.method === "POST")!;
    expect(commit.body.parents).toEqual([parent]);
    const patch = state.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.force).not.toBe(true);
  });

  it("uses the branch the user chose under the delivery-proof name", async () => {
    const { gh, state } = fakeGithub();
    const receipt = await attachProof(input({ branch: "delivery-proof/qa" }), gh);
    expect(receipt.branch).toBe("delivery-proof/qa");
    expect(state.refs["delivery-proof/qa"]).toBe(receipt.commit);
    expect(state.comments["1"]).toContain("Stored on branch `delivery-proof/qa`");
  });

  it.each([["the default branch", { defaultBranch: "delivery-proof" }], ["the PR head branch", { headRef: "delivery-proof" }], ["the PR base branch", { baseRef: "delivery-proof" }]])("refuses to store proof on %s without writing anything", async (_label, over) => {
    const { gh, state } = fakeGithub(over);
    await expect(attachProof(input(), gh)).rejects.toThrow(/dedicated|default|head|base/i);
    expect(state.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(Object.keys(state.refs)).toEqual([]);
    expect(Object.keys(state.comments)).toEqual([]);
  });

  it.each([["main"], ["master"], ["fix/widgets"], ["qa/proof"], ["release"]])("refuses %s because it is not a delivery-proof branch, before any GitHub call", async (branch) => {
    const { gh, state } = fakeGithub();
    await expect(attachProof(input({ branch }), gh)).rejects.toThrow(/delivery-proof/);
    expect(state.calls).toEqual([]);
  });

  it("links a video instead of embedding it", async () => {
    const { gh, state } = fakeGithub();
    await attachProof(input({ files: [{ name: "demo.mp4", dataBase64: b64(mp4) }] }), gh);
    expect(state.comments["1"]).toContain("[demo.mp4](");
    expect(state.comments["1"]).not.toContain("![demo.mp4]");
  });

  it("says a public repository is public", async () => {
    const { gh } = fakeGithub({ private: false });
    expect((await attachProof(input(), gh)).accessPolicy).toMatch(/public/i);
  });

  it.each([
    ["a non-media name", [{ name: "diagnosis.json", dataBase64: b64(Buffer.from("{}")) }]],
    ["text renamed to png", [{ name: "fake.png", dataBase64: b64(Buffer.from("not an image at all!")) }]],
    ["an empty file", [{ name: "empty.png", dataBase64: "" }]],
  ])("rejects %s before any network call", async (_label, files) => {
    const { gh, state } = fakeGithub();
    await expect(attachProof(input({ files }), gh)).rejects.toThrow();
    expect(state.calls).toHaveLength(0);
  });

  it("rejects a pull request URL that is not on github.com", async () => {
    const { gh, state } = fakeGithub();
    await expect(attachProof(input({ prUrl: "https://gitlab.com/acme/widgets/-/merge_requests/7" }), gh)).rejects.toThrow(/github\.com/);
    expect(state.calls).toHaveLength(0);
  });

  it("refuses a closed pull request before storing anything", async () => {
    const { gh, state } = fakeGithub({ prState: "closed" });
    await expect(attachProof(input(), gh)).rejects.toThrow(/closed/);
    expect(state.calls.some((c) => c.endpoint.endsWith("/git/blobs"))).toBe(false);
  });

  it("does not comment when the stored bytes cannot be verified", async () => {
    const { gh, state } = fakeGithub({ lieAboutSize: true });
    await expect(attachProof(input(), gh)).rejects.toThrow(/verif/i);
    expect(state.comments).toEqual({});
  });

  it("returns the stored URLs with an error when only the comment fails", async () => {
    const { gh } = fakeGithub({ commentFails: true });
    const receipt = await attachProof(input(), gh);
    expect(receipt.comment).toBeNull();
    expect(receipt.files[0].url).toMatch(/\?raw=true$/);
    expect(receipt.error).toMatch(/comment/i);
  });

  it("matches the comment the delivery-proof skill would post", () => {
    const script = new URL("../skills/delivery-proof/upload.py", import.meta.url).pathname;
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "proof-parity-"));
    const file = require("node:path").join(dir, "after.png");
    require("node:fs").writeFileSync(file, png);
    const run = spawnSync("python3", ["-I", script, "--repo", "acme/widgets", "--pr", "7", "--note", "Fix verified on Laptop", file], { encoding: "utf8" });
    require("node:fs").rmSync(dir, { recursive: true, force: true });
    const plan = JSON.parse(run.stdout);
    const mine = proofCommentBody([{ name: "after.png", url: "<url returned after upload>", inline: true, bytes: png.length, sha256: sha(png) }], "Fix verified on Laptop", "delivery-proof", "<commit>", "Access follows the repository.");
    expect(plan.proposedComment).toBe(mine);
  });

  it("bounds the request: too many files, over the total size, bad branch names", () => {
    const one = { name: "a.png", dataBase64: b64(png) };
    const base = { cwd: "/w", prUrl: "https://github.com/acme/widgets/pull/7", note: "", branch: "delivery-proof", files: [one] };
    expect(hostProofInput.safeParse(base).success).toBe(true);
    expect(hostProofInput.safeParse({ ...base, files: Array(7).fill(one) }).success).toBe(false);
    expect(hostProofInput.safeParse({ ...base, branch: "../x" }).success).toBe(false);
    expect(hostProofInput.safeParse({ ...base, branch: "a b" }).success).toBe(false);
    expect(hostProofInput.safeParse({ ...base, branch: "main" }).success).toBe(false);
    expect(hostProofInput.safeParse({ ...base, branch: "delivery-proof/qa" }).success).toBe(true);
    const big = { name: "b.png", dataBase64: "A".repeat(Math.ceil((7 * 1024 * 1024 * 4) / 3)) };
    expect(hostProofInput.safeParse({ ...base, files: [big, big] }).success).toBe(false);
  });
});

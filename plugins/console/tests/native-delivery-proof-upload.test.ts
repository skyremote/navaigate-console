import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "..", "skills", "delivery-proof", "upload.py");
const fakeGh = join(__dirname, "fixtures", "fake-gh.py");
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

type Call = { args: string[]; body: Record<string, any> };
let dir: string;
let state: Record<string, any>;

function writeState(extra: Record<string, unknown> = {}) {
  state = { repo: "acme/widgets", private: true, pr: 7, refs: {}, commits: {}, trees: {}, blobs: {}, comments: {}, calls: [], ...extra };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}
function readState() {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}
function calls(): Call[] {
  return readState().calls;
}
function file(name: string, bytes: Buffer = png) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}
function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("python3", ["-I", script, ...args], {
    encoding: "utf8",
    env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, FAKE_GH_STATE: join(dir, "state.json"), ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const upload = ["--repo", "acme/widgets", "--pr", "7", "--upload", "--confirm-redacted"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "delivery-proof-upload-"));
  mkdirSync(join(dir, "bin"));
  copyFileSync(fakeGh, join(dir, "bin", "gh"));
  chmodSync(join(dir, "bin", "gh"), 0o755);
  writeState();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("delivery-proof upload", { timeout: 60_000 }, () => {
  it("previews checksums and the proposed comment without touching GitHub by default", () => {
    const shot = file("after.png");
    const result = run(["--repo", "acme/widgets", "--pr", "7", shot]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.out);
    expect(plan.uploaded).toBe(false);
    expect(plan.files[0]).toMatchObject({ name: "after.png", bytes: png.length, mime: "image/png", sha256: createHash("sha256").update(png).digest("hex") });
    expect(plan.proposedComment).toContain("after.png");
    expect(calls()).toHaveLength(0);
  });

  it("refuses an upload that has not confirmed the media was reviewed and redacted", () => {
    const result = run(["--repo", "acme/widgets", "--pr", "7", "--upload", file("after.png")]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/confirm-redacted/);
    expect(calls()).toHaveLength(0);
  });

  it("stores media on a first-time proof branch, comments on the PR and returns a verified receipt", () => {
    const shot = file("after.png");
    const receiptPath = join(dir, "receipt.json");
    const result = run([...upload, "--receipt", receiptPath, "--note", "Fix verified on Laptop", shot]);
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.out);
    const commit = readState().refs["delivery-proof"];
    expect(commit).toBeTruthy();
    expect(readState().commits[commit].parents).toEqual([]);
    expect(receipt).toMatchObject({ uploaded: true, repo: "acme/widgets", pr: 7, branch: "delivery-proof", commit });
    expect(receipt.accessPolicy).toMatch(/private/i);
    expect(receipt.expiry).toMatch(/none/i);
    const entry = receipt.files[0];
    expect(entry.url).toBe(`https://github.com/acme/widgets/blob/${commit}/${entry.path}?raw=true`);
    expect(entry.path).toMatch(/^pr-7\/.+after\.png$/);
    expect(entry).toMatchObject({ bytes: png.length, verified: true, sha256: createHash("sha256").update(png).digest("hex") });
    expect(receipt.comment).toMatchObject({ verified: true, url: "https://github.com/acme/widgets/pull/7#issuecomment-9001" });
    const body = readState().comments["1"];
    expect(body).toContain(`![after.png](${entry.url})`);
    expect(body).toContain("Fix verified on Laptop");
    expect(body).toContain(createHash("sha256").update(png).digest("hex"));
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(receiptPath, "utf8")).comment.url).toBe(receipt.comment.url);
  });

  it("appends to an existing proof branch without force", () => {
    writeState({ refs: { "delivery-proof": "a".repeat(40) }, commits: { ["a".repeat(40)]: { tree: "b".repeat(40), parents: [] } } });
    const result = run([...upload, file("one.png")]);
    expect(result.code).toBe(0);
    const log = calls();
    const tree = log.find((c) => c.args.some((a) => a.endsWith("/git/trees")))!;
    expect(tree.body.base_tree).toBe("b".repeat(40));
    const commit = log.find((c) => c.args.some((a) => a.endsWith("/git/commits") && c.body.message))!;
    expect(commit.body.parents).toEqual(["a".repeat(40)]);
    const patch = log.find((c) => c.args.includes("PATCH"))!;
    expect(patch.body.force).not.toBe(true);
  });

  it.each([["main"], ["fix/widgets"], ["qa/proof"]])("refuses --branch %s that is not a delivery-proof branch, before any network call", (branch) => {
    const result = run([...upload, "--branch", branch, file("one.png")]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/delivery-proof/);
    expect(calls()).toHaveLength(0);
  });

  it("previews nothing for a branch that is not a delivery-proof branch", () => {
    const result = run(["--repo", "acme/widgets", "--pr", "7", "--branch", "main", file("one.png")]);
    expect(result.code).not.toBe(0);
    expect(calls()).toHaveLength(0);
  });

  it.each([["defaultBranch"], ["headRef"], ["baseRef"]])("refuses a branch equal to the pull request %s without writing", (key) => {
    writeState({ [key]: "delivery-proof" });
    const result = run([...upload, file("one.png")]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/default|head|base|dedicated/i);
    expect(calls().filter((c) => c.args.includes("POST") || c.args.includes("PATCH"))).toEqual([]);
    expect(readState().comments).toEqual({});
  });

  it("links a video instead of embedding it", () => {
    const result = run([...upload, file("demo.mp4", Buffer.from("00000018667479706d703432", "hex"))]);
    expect(result.code).toBe(0);
    const body = readState().comments["1"];
    expect(body).toContain("[demo.mp4](");
    expect(body).not.toContain("![demo.mp4]");
  });

  it("accepts a full PR URL in place of repo and number", () => {
    const result = run(["https://github.com/acme/widgets/pull/7", "--upload", "--confirm-redacted", file("x.png")]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).repo).toBe("acme/widgets");
  });

  it("can skip the comment and still return URLs", () => {
    const result = run([...upload, "--no-comment", file("x.png")]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).comment).toBeNull();
    expect(readState().comments).toEqual({});
  });

  it.each([
    ["a non-media file", () => file("diagnosis.json", Buffer.from("{}"))],
    ["a missing file", () => join(dir, "nope.png")],
    ["a symlink", () => { const link = join(dir, "link.png"); symlinkSync(file("real.png"), link); return link; }],
    ["an empty file", () => file("empty.png", Buffer.alloc(0))],
    ["text renamed to png", () => file("fake.png", Buffer.from("not an image at all"))],
  ])("rejects %s before any network call", (_label, make) => {
    const result = run([...upload, make()]);
    expect(result.code).not.toBe(0);
    expect(calls()).toHaveLength(0);
  });

  it("rejects files above the size limit", () => {
    const result = run([...upload, "--max-bytes", "8", file("big.png")]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/limit/);
    expect(calls()).toHaveLength(0);
  });

  it("refuses a closed pull request", () => {
    writeState({ prState: "closed" });
    const result = run([...upload, file("x.png")]);
    expect(result.code).not.toBe(0);
    expect(calls().some((c) => c.args.some((a) => a.endsWith("/git/blobs")))).toBe(false);
  });

  it("does not post a comment when the stored bytes cannot be verified", () => {
    writeState({ lieAboutSize: true });
    const result = run([...upload, file("x.png")]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/verif/i);
    expect(readState().comments).toEqual({});
  });

  it("reports a failed comment with the uploaded URLs and a distinct exit code", () => {
    writeState({ commentFails: true });
    const result = run([...upload, file("x.png")]);
    expect(result.code).toBe(3);
    const receipt = JSON.parse(result.out);
    expect(receipt.comment).toBeNull();
    expect(receipt.files[0].url).toMatch(/\?raw=true$/);
    expect(receipt.error).toMatch(/comment/i);
  });

  it("never prints or reads credentials", () => {
    const result = run([...upload, file("x.png")], { GH_TOKEN: "ghp_secret_value" });
    expect(result.out + result.err).not.toContain("ghp_secret_value");
    expect(existsSync(script)).toBe(true);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { checkTour, parseChangeSet, tourManifest } from "../review-tour";
import { linkChanges, readReview } from "../host-delivery";
import { deliveryPrompt, reviewTaskContext } from "../src/delivery-prompts";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -9,0 +10,2 @@ export const x = 1;",
  "+added",
  "+again",
  "@@ -30,2 +33,2 @@ function y() {",
  "--- a/old-heading",
  "+++ b/other.ts",
  " keep",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-one",
  "-two",
  "diff --git a/docs/old name.md b/docs/new name.md",
  "similarity index 90%",
  "rename from docs/old name.md",
  "rename to docs/new name.md",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "diff --git a/notes.md b/notes.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1 @@",
  "+hello",
  "",
].join("\n");
const URL = "https://github.com/a/b/pull/7";
const sha = (path: string) => createHash("sha256").update(path).digest("hex");
const changes = linkChanges(parseChangeSet(DIFF), URL, "github");

describe("parseChangeSet", () => {
  it("lists every file once with status, hunks and line counts, including renames and binaries", () => {
    expect(changes.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["src/a.ts", "modified", 3, 1],
      ["src/gone.ts", "deleted", 0, 2],
      ["docs/new name.md", "renamed", 0, 0],
      ["img.png", "modified", 0, 0],
      ["notes.md", "added", 1, 0],
    ]);
    expect(changes[2].previousPath).toBe("docs/old name.md");
    expect(changes[3].hunks).toEqual([]);
  });
  it("reads a removed or added header-looking line inside a hunk as source, not a new file", () => {
    expect(changes[0].hunks.map((hunk) => [hunk.old, hunk.new])).toEqual([
      [null, { start: 10, end: 11 }],
      [{ start: 30, end: 31 }, { start: 33, end: 34 }],
    ]);
    expect(changes.map((file) => file.path)).not.toContain("other.ts");
  });
  it("adds files the provider listed but the diff did not carry", () => {
    const merged = parseChangeSet(DIFF, [
      { path: "src/a.ts", additions: 9, deletions: 4 },
      { path: "big/generated.json", additions: 5000, deletions: 0 },
    ]);
    expect(merged.find((file) => file.path === "src/a.ts")).toMatchObject({ additions: 9, deletions: 4 });
    expect(merged.at(-1)).toMatchObject({ path: "big/generated.json", status: "unknown", hunks: [] });
  });
});

describe("hunk links", () => {
  it("anchors each hunk on the PR files page by the path hash and the side's lines", () => {
    const file = changes[0];
    expect(file.link).toBe(`${URL}/files#diff-${sha("src/a.ts")}`);
    expect(file.hunks[0].link).toBe(`${file.link}R10-R11`);
    expect(file.hunks[1].link).toBe(`${file.link}R33-R34`);
    expect(changes[1].hunks[0].link).toBe(`${changes[1].link}L1-L2`);
  });
  it("links GitLab to the file only", () => {
    const [file] = linkChanges(parseChangeSet(DIFF), "https://gitlab.com/a/b/-/merge_requests/3", "gitlab");
    expect(file.link).toMatch(/\/diffs#[0-9a-f]{40}$/);
    expect(file.hunks.every((hunk) => hunk.link === file.link)).toBe(true);
  });
});

describe("tour manifest", () => {
  it("names every file and hunk with its link so the model has nothing to invent", () => {
    const manifest = tourManifest(changes);
    for (const file of changes) expect(manifest).toContain(file.path);
    expect(manifest).toContain(`F1.H1 new 10-11 ${changes[0].hunks[0].link}`);
    expect(manifest).toContain("F3 docs/new name.md [renamed +0 -0] (was docs/old name.md)");
  });
  it("keeps every file in a large change by dropping hunks first, then admitting what did not fit", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      ...changes[0],
      path: `src/file-${index}.ts`,
    }));
    const manifest = tourManifest(many, { full: 3000, compact: 25000 });
    expect(manifest).toContain("src/file-399.ts");
    expect(manifest.length).toBeLessThan(26000);
    expect(manifest).toContain("Files listed without hunks above");
    const tight = tourManifest(many, { full: 1000, compact: 2000 });
    expect(tight).toMatch(/\d+ further files did not fit this manifest/);
  });
});

describe("checkTour", () => {
  const tour = `Stop 1 ${changes[0].path} ${changes[0].hunks[0].link}\nStop 2 ${changes[1].path}, docs/new name.md, img.png, notes.md`;
  it("accepts a tour that places every file and links only real hunks", () => {
    const result = checkTour(changes, tour);
    expect(result).toMatchObject({ ok: true, missing: [], invalidLinks: [], total: 5 });
  });
  it("lists the files the tour left out and builds the Other files stop for them", () => {
    const result = checkTour(changes, `Only ${changes[0].path}`);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["src/gone.ts", "docs/new name.md", "img.png", "notes.md"]);
    expect(result.otherFiles).toContain("Other files");
    expect(result.otherFiles).toContain("- notes.md");
  });
  it("rejects a link into lines no hunk covers and a link to a file outside the change", () => {
    const bad = `${tour}\n${changes[0].link}R500-R510\n${URL}/files#diff-${sha("elsewhere.ts")}R1`;
    const result = checkTour(changes, bad);
    expect(result.invalidLinks.map((item) => item.link)).toEqual([
      `${changes[0].link}R500-R510`,
      `${URL}/files#diff-${sha("elsewhere.ts")}R1`,
    ]);
    expect(result.ok).toBe(false);
  });
  it("accepts a link on the old side of a deleted file", () => {
    expect(checkTour(changes, `${tour}\n${changes[1].link}L1-L2`).invalidLinks).toEqual([]);
  });
});

describe("review read and task", () => {
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === "remote") return "https://github.com/a/b";
    if (args[0] === "branch") return "fix";
    if (args[0] === "api") return JSON.stringify({ data: {} });
    if (args.includes("view"))
      return JSON.stringify({
        number: 7,
        url: URL,
        headRefOid: "sha",
        files: [
          { path: "src/a.ts", additions: 2, deletions: 0 },
          { path: "big/generated.json", additions: 9000, deletions: 0 },
        ],
      });
    return DIFF;
  });
  it("returns the change set computed from the full diff and the provider's file list", async () => {
    const review = await readReview("/work/tree", URL, run);
    expect(review.changes.map((file) => file.path)).toContain("big/generated.json");
    expect(review.changes[0].hunks[0].link).toBe(`${URL}/files#diff-${sha("src/a.ts")}R10-R11`);
  });
  it("keeps files past the 160k diff slice in the change set", async () => {
    const long = `${DIFF}diff --git a/late.ts b/late.ts\n--- a/late.ts\n+++ b/late.ts\n@@ -1 +1 @@\n-a\n+b\n`;
    const padded = vi.fn(async (command: string, args: string[]) =>
      command === "gh" && args[0] === "pr" && args[1] === "diff" ? `${"x\n".repeat(90_000)}${long}` : run(command, args),
    );
    const review = await readReview("/work/tree", URL, padded);
    expect(review.diff).not.toContain("late.ts");
    expect(review.changes.map((file) => file.path)).toContain("late.ts");
  });
  it("puts the manifest ahead of the bounded evidence in the task and asks for coverage", () => {
    const context = reviewTaskContext({
      url: URL,
      revision: "sha",
      text: "{}",
      diff: DIFF,
      changes,
      truncated: false,
      warnings: [],
    });
    expect(context.indexOf("Coverage manifest")).toBeLessThan(context.indexOf("diff --git"));
    expect(context).toContain(changes[0].hunks[0].link!);
    const prompt = deliveryPrompt("review", context);
    expect(prompt).toContain("every manifest file appears in exactly one stop");
    expect(prompt).toContain("Coverage table");
    expect(prompt).toContain("copied exactly from the manifest");
  });
  it("still lists every file when an older host sent no change set", () => {
    const context = reviewTaskContext({ url: URL, revision: "sha", text: "{}", diff: DIFF, truncated: false, warnings: [] });
    expect(context).toContain("5 changed files");
    expect(context).toContain("notes.md");
  });
});

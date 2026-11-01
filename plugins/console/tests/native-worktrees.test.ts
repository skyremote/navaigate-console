import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeBack, pushBranch, reportWorktrees } from "../worktrees";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
const identity = ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
const commit = (cwd: string, file: string, text: string, message: string) => {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, ...identity, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wt-")));
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  const base = commit(main, "src/shared.ts", "line1\nline2\nline3\n", "base");
  git(main, "worktree", "add", "-q", "-b", "task-a", join(root, "a"));
  git(main, "worktree", "add", "-q", "-b", "task-b", join(root, "b"));
  return { root, main, a: join(root, "a"), b: join(root, "b"), base };
}
const run = async (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8" });

describe("worktree report", () => {
  it("names the shared base commit and each worktree's own changes", async () => {
    const f = fixture();
    commit(f.a, "src/a.ts", "a\n", "a work");
    commit(f.b, "src/b.ts", "b\nb\n", "b work");
    const report = await reportWorktrees(f.main, null);
    expect(report.base).toEqual({ ref: "main", sha: f.base });
    const a = report.worktrees.find((w) => w.branch === "task-a")!;
    expect(a).toMatchObject({ ahead: 1, behind: 0, additions: 1, deletions: 0, dirty: false, mergeBase: f.base, conflicts: [] });
    expect(a.files).toEqual([{ path: "src/a.ts", additions: 1, deletions: 0 }]);
    expect(report.worktrees.find((w) => w.branch === "task-b")!.additions).toBe(2);
    expect(report.worktrees.some((w) => w.branch === "main")).toBe(false);
    expect(report.overlaps).toEqual([]);
  });

  it("flags two worktrees that edit the same file and lists the conflict before any merge", async () => {
    const f = fixture();
    commit(f.a, "src/shared.ts", "line1\nA\nline3\n", "a edits line 2");
    commit(f.b, "src/shared.ts", "line1\nB\nline3\n", "b edits line 2");
    commit(f.main, "src/shared.ts", "line1\nline2\nline3\nmain\n", "main moves");
    const report = await reportWorktrees(f.main, null);
    expect(report.overlaps).toEqual([{ path: "src/shared.ts", branches: ["task-a", "task-b"] }]);
    const a = report.worktrees.find((w) => w.branch === "task-a")!;
    expect(a.behind).toBe(1);
    expect(a.conflicts).toEqual([]);
  });

  it("reports a conflict with the base and marks uncommitted work as dirty", async () => {
    const f = fixture();
    commit(f.a, "src/shared.ts", "line1\nA\nline3\n", "a edits line 2");
    commit(f.main, "src/shared.ts", "line1\nMAIN\nline3\n", "main edits line 2");
    writeFileSync(join(f.b, "scratch.txt"), "x");
    const report = await reportWorktrees(f.main, null);
    expect(report.worktrees.find((w) => w.branch === "task-a")!.conflicts).toEqual(["src/shared.ts"]);
    expect(report.worktrees.find((w) => w.branch === "task-b")!.dirty).toBe(true);
  });

  it("falls back to unknown conflicts when git cannot run merge-tree", async () => {
    const f = fixture();
    commit(f.a, "src/a.ts", "a\n", "a work");
    const noMergeTree = async (command: string, args: string[], cwd: string) => {
      if (args[0] === "merge-tree") throw Object.assign(new Error("usage: git merge-tree"), { code: 129 });
      return run(command, args, cwd);
    };
    const report = await reportWorktrees(f.main, null, noMergeTree);
    expect(report.worktrees.find((w) => w.branch === "task-a")!.conflicts).toBeNull();
  });
});

describe("worktree report from a worktree", () => {
  it("takes the main checkout as the base even when asked from a linked worktree", async () => {
    const f = fixture();
    commit(f.a, "src/a.ts", "a\n", "a work");
    commit(f.b, "src/b.ts", "b\n", "b work");
    const report = await reportWorktrees(f.a, null);
    expect(report.base).toEqual({ ref: "main", sha: f.base });
    expect(report.worktrees.map((w) => w.branch).sort()).toEqual(["task-a", "task-b"]);
    expect(report.worktrees.some((w) => w.branch === "main")).toBe(false);
  });

  it("falls back to the asking workspace when the repository is bare", async () => {
    const f = fixture();
    const bare = join(f.root, "bare.git");
    git(f.root, "clone", "-q", "--bare", f.main, bare);
    git(bare, "worktree", "add", "-q", "-b", "task-c", join(f.root, "c"), "main");
    const report = await reportWorktrees(join(f.root, "c"), null);
    expect(report.base.ref).toBe("task-c");
  });
});

describe("reviewed merge back", () => {
  it("merges a clean worktree branch into the base with a merge commit", async () => {
    const f = fixture();
    const head = commit(f.a, "src/a.ts", "a\n", "a work");
    const result = await mergeBack(f.main, { branch: "task-a", expectedHead: head, expectedBaseHead: f.base, expectedBaseRef: "main", fetch: false });
    expect(result.merged).toBe(true);
    expect(git(f.main, "rev-parse", "HEAD")).toBe(result.sha);
    expect(git(f.main, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(git(f.main, "show", "HEAD:src/a.ts")).toBe("a");
  });

  it("refuses and lists the files when the merge would conflict, leaving the base untouched", async () => {
    const f = fixture();
    const head = commit(f.a, "src/shared.ts", "line1\nA\nline3\n", "a");
    const mainHead = commit(f.main, "src/shared.ts", "line1\nMAIN\nline3\n", "main");
    const result = await mergeBack(f.main, { branch: "task-a", expectedHead: head, expectedBaseHead: mainHead, expectedBaseRef: "main", fetch: false });
    expect(result).toMatchObject({ merged: false, conflicts: ["src/shared.ts"] });
    expect(git(f.main, "rev-parse", "HEAD")).toBe(mainHead);
    expect(git(f.main, "status", "--porcelain")).toBe("");
  });

  it("refuses when the branch or the base moved after the panel read them", async () => {
    const f = fixture();
    const head = commit(f.a, "src/a.ts", "a\n", "a work");
    commit(f.a, "src/a.ts", "a2\n", "a more");
    await expect(mergeBack(f.main, { branch: "task-a", expectedHead: head, expectedBaseHead: f.base, expectedBaseRef: "main", fetch: false })).rejects.toThrow(/changed after/);
    const latest = git(f.a, "rev-parse", "HEAD");
    commit(f.main, "other.txt", "x\n", "base moves");
    await expect(mergeBack(f.main, { branch: "task-a", expectedHead: latest, expectedBaseHead: f.base, expectedBaseRef: "main", fetch: false })).rejects.toThrow(/base .* moved/i);
  });

  it("refuses a dirty base workspace and an option-shaped branch name", async () => {
    const f = fixture();
    const head = commit(f.a, "src/a.ts", "a\n", "a work");
    writeFileSync(join(f.main, "src/shared.ts"), "edited\n");
    await expect(mergeBack(f.main, { branch: "task-a", expectedHead: head, expectedBaseHead: f.base, expectedBaseRef: "main", fetch: false })).rejects.toThrow(/uncommitted/);
    await expect(mergeBack(f.main, { branch: "--abort", expectedHead: head, expectedBaseHead: f.base, expectedBaseRef: "main", fetch: false })).rejects.toThrow(/branch name/i);
  });

  it("brings a branch from another machine's clone: push there, fetch and merge here", async () => {
    const f = fixture();
    const remote = join(f.root, "origin.git");
    git(f.root, "init", "-q", "--bare", "-b", "main", remote);
    git(f.main, "remote", "add", "origin", remote);
    git(f.main, "push", "-q", "origin", "main");
    const other = join(f.root, "m1");
    git(f.root, "clone", "-q", remote, other);
    git(other, "checkout", "-q", "-b", "m1-task");
    const head = commit(other, "src/m1.ts", "m1\n", "m1 work");
    await pushBranch(other, { branch: "m1-task", expectedHead: head });
    const result = await mergeBack(f.main, { branch: "m1-task", expectedHead: head, expectedBaseHead: f.base, expectedBaseRef: "main", fetch: true });
    expect(result.merged).toBe(true);
    expect(git(f.main, "show", "HEAD:src/m1.ts")).toBe("m1");
    await expect(pushBranch(other, { branch: "m1-task", expectedHead: f.base })).rejects.toThrow(/changed after/);
  });

  it("lands in the main checkout when asked from a linked worktree, never in the worktree it was asked from", async () => {
    const f = fixture();
    const head = commit(f.b, "src/b.ts", "b\n", "b work");
    const aHead = git(f.a, "rev-parse", "HEAD");
    const result = await mergeBack(f.a, { branch: "task-b", expectedHead: head, expectedBaseHead: f.base, expectedBaseRef: "main", fetch: false });
    expect(result.merged).toBe(true);
    expect(git(f.main, "show", "HEAD:src/b.ts")).toBe("b");
    expect(git(f.a, "rev-parse", "HEAD")).toBe(aHead);
    expect(git(f.a, "branch", "--show-current")).toBe("task-a");
  });

  it("refuses when the base branch is no longer the one the panel showed", async () => {
    const f = fixture();
    const head = commit(f.a, "src/a.ts", "a\n", "a work");
    git(f.main, "checkout", "-q", "-b", "other");
    await expect(mergeBack(f.main, { branch: "task-a", expectedHead: head, expectedBaseHead: f.base, expectedBaseRef: "main", fetch: false })).rejects.toThrow(/other.*not main|expected main/i);
  });

  it("refuses to merge a branch into itself", async () => {
    const f = fixture();
    const head = commit(f.main, "src/m.ts", "m\n", "m work");
    await expect(mergeBack(f.main, { branch: "main", expectedHead: head, expectedBaseHead: head, expectedBaseRef: "main", fetch: false })).rejects.toThrow(/into itself/);
  });
});

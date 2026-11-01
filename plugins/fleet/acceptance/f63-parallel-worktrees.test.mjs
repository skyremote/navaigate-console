import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXPECT, FIXTURE_CALC, FIXTURE_TEST, LINES,
  forcedRemovalCommands, intervalsOverlap, isTransient, parseConflictedPaths, resolveConflictBlock, reviewDiff, validateProof,
} from "./f63-parallel-worktrees.mjs";

const probe = async (source) => {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return { top: mod.top(" ab "), bottom: mod.bottom(" ab ") };
};
const edit = (source, from, to) => {
  expect(source.split("\n").filter((l) => l === from)).toHaveLength(1);
  return source.replace(from, to);
};

describe("intervalsOverlap", () => {
  it("detects overlap and its length", () => {
    expect(intervalsOverlap([{ start: 0, end: 100 }, { start: 50, end: 200 }])).toMatchObject({ overlapped: true, overlapMs: 50 });
  });
  it("rejects disjoint intervals and ones the clock uncertainty can close", () => {
    expect(intervalsOverlap([{ start: 0, end: 100 }, { start: 150, end: 200 }]).overlapped).toBe(false);
    expect(intervalsOverlap([{ start: 0, end: 100 }, { start: 90, end: 200 }], 6).overlapped).toBe(false);
  });
  it("rejects missing or inverted intervals", () => {
    expect(intervalsOverlap([{ start: 0, end: 100 }]).overlapped).toBe(false);
    expect(intervalsOverlap([{ start: 0, end: 100 }, { start: 50, end: Number.NaN }]).overlapped).toBe(false);
    expect(intervalsOverlap([{ start: 0, end: 100 }, { start: 60, end: 50 }]).overlapped).toBe(false);
  });
});

describe("fixture design", () => {
  it("each edit line is unique and yields the expected behaviour", async () => {
    expect(await probe(FIXTURE_CALC)).toEqual(EXPECT.base);
    expect(await probe(edit(FIXTURE_CALC, LINES.topBase, LINES.topEdit))).toEqual(EXPECT.c1Top);
    expect(await probe(edit(FIXTURE_CALC, LINES.bottomBase, LINES.bottomEdit))).toEqual(EXPECT.c1Bottom);
    const merged = edit(edit(FIXTURE_CALC, LINES.topBase, LINES.topEdit), LINES.bottomBase, LINES.bottomEdit);
    expect(await probe(merged)).toEqual(EXPECT.merged);
    expect(await probe(edit(merged, LINES.topEdit, LINES.trimEdit))).toEqual(EXPECT.c2Trim);
    expect(await probe(edit(merged, LINES.topEdit, LINES.upperEdit))).toEqual(EXPECT.c2Upper);
    expect(await probe(edit(merged, LINES.topEdit, LINES.resolved))).toEqual(EXPECT.resolved);
  });

  it("merges the region edits cleanly and the same-line edits with exactly one conflicted path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "f63-unit-"));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_EDITOR: "true" };
    const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { env, encoding: "utf8" });
    const tryGit = (...args) => { try { git(...args); return 0; } catch (e) { return e.status ?? 1; } };
    const file = path.join(dir, "calc.mjs");
    const commitEdit = (branch, base, from, to) => {
      git("checkout", "-q", "-b", branch, base);
      writeFileSync(file, edit(readFileSync(file, "utf8"), from, to));
      git("commit", "-qam", branch);
    };
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(file, FIXTURE_CALC);
      writeFileSync(path.join(dir, "test.mjs"), FIXTURE_TEST);
      git("add", ".");
      git("commit", "-qm", "base");
      commitEdit("top", "main", LINES.topBase, LINES.topEdit);
      commitEdit("bottom", "main", LINES.bottomBase, LINES.bottomEdit);
      git("checkout", "-q", "main");
      expect(tryGit("merge", "--no-ff", "--no-edit", "top")).toBe(0);
      expect(tryGit("merge", "--no-ff", "--no-edit", "bottom")).toBe(0);
      expect(await probe(readFileSync(file, "utf8"))).toEqual(EXPECT.merged);
      execFileSync("node", ["test.mjs"], { cwd: dir });

      commitEdit("trim", "main", LINES.topEdit, LINES.trimEdit);
      commitEdit("upper", "main", LINES.topEdit, LINES.upperEdit);
      git("checkout", "-q", "main");
      expect(tryGit("merge", "--no-ff", "--no-edit", "trim")).toBe(0);
      expect(tryGit("merge", "--no-ff", "--no-edit", "upper")).not.toBe(0);
      expect(parseConflictedPaths(git("diff", "--name-only", "--diff-filter=U"))).toEqual(["calc.mjs"]);
      const resolved = resolveConflictBlock(readFileSync(file, "utf8"), { ours: LINES.trimEdit, theirs: LINES.upperEdit, resolution: LINES.resolved });
      writeFileSync(file, resolved);
      git("add", "calc.mjs");
      git("commit", "--no-edit", "-q");
      expect(git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toHaveLength(3);
      expect(await probe(git("show", "HEAD:calc.mjs"))).toEqual(EXPECT.resolved);
      execFileSync("node", ["test.mjs"], { cwd: dir });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("resolveConflictBlock", () => {
  const block = (ours, theirs) => ["a", "<<<<<<< HEAD", ours, "=======", theirs, ">>>>>>> upper", "b"].join("\n");
  it("replaces the single block with the resolution", () => {
    expect(resolveConflictBlock(block("x", "y"), { ours: "x", theirs: "y", resolution: "xy" })).toBe("a\nxy\nb");
  });
  it("refuses unexpected sides, missing blocks and second blocks", () => {
    expect(() => resolveConflictBlock(block("x", "z"), { ours: "x", theirs: "y", resolution: "xy" })).toThrow("Unexpected");
    expect(() => resolveConflictBlock("a\nb", { ours: "x", theirs: "y", resolution: "xy" })).toThrow("No well-formed");
    expect(() => resolveConflictBlock(`${block("x", "y")}\n${block("x", "y")}`, { ours: "x", theirs: "y", resolution: "xy" })).toThrow("More than one");
  });
});

describe("reviewDiff and forcedRemovalCommands", () => {
  it("accepts exactly the expected one-line change", () => {
    const patch = `--- a/calc.mjs\n+++ b/calc.mjs\n@@ -4 +4 @@\n-${LINES.topBase}\n+${LINES.topEdit}`;
    expect(reviewDiff({ numstat: "1\t1\tcalc.mjs\n", patch }, { from: LINES.topBase, to: LINES.topEdit }).passed).toBe(true);
    expect(reviewDiff({ numstat: "2\t1\tcalc.mjs\n", patch }, { from: LINES.topBase, to: LINES.topEdit }).passed).toBe(false);
    expect(reviewDiff({ numstat: "1\t1\tcalc.mjs\n", patch }, { from: LINES.topBase, to: LINES.trimEdit }).passed).toBe(false);
  });
  it("flags forced or manual worktree removal", () => {
    const ok = [{ command: "bb environment cleanup env_1 --json" }, { command: "bb environment archive-threads env_1 --json" }, { command: "rm -r /private/tmp/f63-parallel/run-x" }];
    expect(forcedRemovalCommands(ok)).toEqual([]);
    for (const bad of ["git worktree remove /x --force", "bb environment cleanup env_1 --recover", "rm -rf /Users/x/.bb/worktrees/a", "git -C x worktree prune"]) {
      expect(forcedRemovalCommands([...ok, { command: bad }])).toHaveLength(1);
    }
  });
});

describe("isTransient", () => {
  it("retries bb restarts but never the live-thread refusal", () => {
    expect(isTransient("Error: fetch failed: connect ECONNRESET 127.0.0.1:38886")).toBe(true);
    expect(isTransient('HTTP 503: plugin "fleet" is not running')).toBe(true);
    expect(isTransient("HTTP 409: Environment still has live threads")).toBe(false);
  });
});

describe("validateProof", () => {
  const base = "b".repeat(40);
  const task = (machine, start, end, extra = {}) => ({
    machine, route: { machine }, target: { machineKey: machine },
    environment: { managed: true, isWorktree: true, path: `/wt/${machine}` },
    start, end, commit: { sha: `${machine}sha`, parent: base }, mergeBase: base,
    review: { passed: true }, testOnHost: { exit: 0 }, ...extra,
  });
  const env = (machine, n) => ({ machine, envId: `env_${n}`, refusedWhileLive: { exit: 1, message: "Error: HTTP 409: Environment still has live threads" }, cleanup: { exit: 0 }, finalStatus: "destroyed", teardownStatus: "removed", pathGone: true, listedInWorktreeList: false, branchKept: true });
  const good = () => ({
    fixture: { baseSha: base },
    case1: {
      tasks: [task("studio", 0, 100), task("laptop", 10, 120)],
      overlap: { overlapped: true },
      merge: { merges: [{ exit: 0 }, { exit: 0 }], conflicted: false, test: { exit: 0 }, behaviour: EXPECT.merged, bothEditsPresent: true, fetched: { studio: "studiosha", laptop: "laptopsha" } },
    },
    case2: {
      tasks: [task("studio", 200, 300, { baseIsCase1Merge: true }), task("laptop", 210, 320, { baseIsCase1Merge: true })],
      merge: { first: { exit: 0 }, second: { exit: 1, conflictedPaths: ["calc.mjs"] }, resolution: { sha: "r", parents: ["p1", "p2"], behaviour: EXPECT.resolved, test: { exit: 0 }, markersRemaining: false, containsBothTasks: true } },
    },
    cleanup: { environments: [env("studio", 1), env("laptop", 2), env("studio", 3), env("laptop", 4)], forcedRemovalByHarness: false },
  });

  it("passes a complete proof", () => {
    expect(validateProof(good())).toMatchObject({ ok: true, failures: [] });
  });
  it("fails each criterion on its own defect", () => {
    const p1 = good(); p1.case1.overlap.overlapped = false;
    const p1b = good(); p1b.case1.tasks[1].commit.parent = "other";
    const p1c = good(); p1c.case1.tasks[1].environment.path = "/wt/studio"; p1c.case1.tasks[1].machine = "studio";
    const p2 = good(); p2.case1.merge.merges[1].exit = 1;
    const p3 = good(); p3.case2.merge.second.conflictedPaths = ["calc.mjs", "test.mjs"];
    const p3b = good(); p3b.case2.merge.resolution.behaviour = EXPECT.c2Upper;
    const p4 = good(); p4.cleanup.forcedRemovalByHarness = true;
    const p4b = good(); p4b.cleanup.environments[2].refusedWhileLive = { exit: 0, message: "" };
    const p4c = good(); p4c.cleanup.environments.pop();
    expect(validateProof(p1).criteria.overlapSameBase).toBe(false);
    expect(validateProof(p1b).criteria.overlapSameBase).toBe(false);
    expect(validateProof(p1c).criteria.overlapSameBase).toBe(false);
    expect(validateProof(p2).criteria).toMatchObject({ overlapSameBase: true, cleanMerge: false });
    expect(validateProof(p3).criteria.conflictResolved).toBe(false);
    expect(validateProof(p3b).criteria.conflictResolved).toBe(false);
    for (const p of [p4, p4b, p4c]) expect(validateProof(p)).toMatchObject({ ok: false, criteria: { protectedCleanup: false } });
  });
});

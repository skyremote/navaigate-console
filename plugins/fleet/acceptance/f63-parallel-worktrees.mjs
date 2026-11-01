#!/usr/bin/env node
// F63 acceptance harness: parallel studio/laptop managed worktrees through the
// installed Fleet, a clean merge back on laptop, a same-lines conflict resolved on
// laptop, and protected cleanup through BB's own worktree removal.
//
// Usage: node fleet/acceptance/f63-parallel-worktrees.mjs
// Writes /tmp/f63-parallel/proof.json and exits 0 only when every acceptance
// check passes. It creates (and removes) only its own throwaway fixture: a bare
// origin and clone on studio, a clone on laptop, one bb project per machine named
// "F63 fixture <run>", and the managed worktrees its four tasks receive.
// It never reinstalls Fleet, never edits ~/.bb, and never force-removes a
// worktree: worktrees are removed only by `bb environment cleanup`.

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

export const OUT_DIR = "/tmp/f63-parallel";
export const PROOF_PATH = path.join(OUT_DIR, "proof.json");
const SCRATCH_ROOT = "/private/tmp/f63-parallel";
const studio_BB = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb";
const studio_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const PROVIDER = process.env.F63_PROVIDER ?? "claude-code";
const MODEL = process.env.F63_MODEL ?? "claude-sonnet-5-5";
const TASK_TIMEOUT_MS = 15 * 60_000;
const IDENTITY = ["-c", "user.name=F63 harness", "-c", "user.email=f63@example.invalid"];
export const PROVIDER_REMOVAL_NOTE = "The installed git-worktree environment provider removes a worktree after the live-thread guard with `git worktree remove <path> --force` followed by a recursive directory removal (bb core plugins/environment-git-worktree/host/worktree.ts, removeWorktree). The harness itself issued no forced removal: only `bb environment archive-threads` and `bb environment cleanup <id>` without --recover.";

// ---------- fixture content ----------

export const LINES = {
  topBase: "  return String(value);",
  topEdit: '  return "top:" + String(value);',
  bottomBase: "  return String(input);",
  bottomEdit: '  return String(input) + ":bottom";',
  trimEdit: '  return "top:" + String(value).trim();',
  upperEdit: '  return "top:" + String(value).toUpperCase();',
  resolved: '  return "top:" + String(value).trim().toUpperCase();',
};

export const FIXTURE_CALC = [
  "// F63 fixture. top() is at the top of the file and bottom() at the bottom,",
  "// so two tasks can edit the same file in different regions.",
  "export function top(value) {",
  LINES.topBase,
  "}",
  "",
  ...Array.from({ length: 12 }, (_, i) => `// filler ${String(i + 1).padStart(2, "0")}: keeps the two functions far apart.`),
  "",
  "export function bottom(input) {",
  LINES.bottomBase,
  "}",
  "",
].join("\n");

export const FIXTURE_TEST = [
  'import assert from "node:assert/strict";',
  'import { top, bottom } from "./calc.mjs";',
  "for (const fn of [top, bottom]) {",
  '  const out = fn(" ab ");',
  '  assert.equal(typeof out, "string");',
  '  assert.ok(out.toLowerCase().includes("ab"), `${fn.name} lost its input: ${out}`);',
  "}",
  'console.log("fixture test passed");',
  "",
].join("\n");

/** Expected outputs of top(" ab ") and bottom(" ab ") at each stage. */
export const EXPECT = {
  base: { top: " ab ", bottom: " ab " },
  c1Top: { top: "top: ab ", bottom: " ab " },
  c1Bottom: { top: " ab ", bottom: " ab :bottom" },
  merged: { top: "top: ab ", bottom: " ab :bottom" },
  c2Trim: { top: "top:ab", bottom: " ab :bottom" },
  c2Upper: { top: "top: AB ", bottom: " ab :bottom" },
  resolved: { top: "top:AB", bottom: " ab :bottom" },
};

// ---------- pure helpers (unit tested) ----------

/** Shell single-quote. */
export const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Overlap of task intervals measured on two clocks. Each interval is already
 * expressed on the laptop clock; `uncertaintyMs` widens starts and narrows ends.
 */
export function intervalsOverlap(intervals, uncertaintyMs = 0) {
  if (intervals.length < 2 || intervals.some((i) => !Number.isFinite(i.start) || !Number.isFinite(i.end) || i.end < i.start)) {
    return { overlapped: false, latestStart: null, earliestEnd: null, overlapMs: 0 };
  }
  const latestStart = Math.max(...intervals.map((i) => i.start)) + uncertaintyMs;
  const earliestEnd = Math.min(...intervals.map((i) => i.end)) - uncertaintyMs;
  return { overlapped: latestStart < earliestEnd, latestStart, earliestEnd, overlapMs: Math.max(0, earliestEnd - latestStart) };
}

/** Paths git lists as unmerged (`git diff --name-only --diff-filter=U`). */
export function parseConflictedPaths(text) {
  return String(text).split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Resolve the single conflict block in `text`, which must contain exactly the
 * expected ours/theirs lines, with `resolution`. Throws on anything else.
 */
export function resolveConflictBlock(text, { ours, theirs, resolution }) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => l.startsWith("<<<<<<< "));
  const middle = lines.findIndex((l) => l === "=======");
  const end = lines.findIndex((l) => l.startsWith(">>>>>>> "));
  if (start < 0 || middle < start || end < middle) throw new Error("No well-formed conflict block");
  if (lines.slice(end + 1).some((l) => l.startsWith("<<<<<<< "))) throw new Error("More than one conflict block");
  const oursLines = lines.slice(start + 1, middle);
  const theirsLines = lines.slice(middle + 1, end);
  if (oursLines.join("\n") !== ours || theirsLines.join("\n") !== theirs) throw new Error(`Unexpected conflict sides: ${JSON.stringify({ oursLines, theirsLines })}`);
  return [...lines.slice(0, start), resolution, ...lines.slice(end + 1)].join("\n");
}

/** A reviewed single-line change: numstat `1 1 calc.mjs` and the exact -/+ lines. */
export function reviewDiff({ numstat, patch }, { from, to }) {
  const problems = [];
  if (numstat.trim() !== "1\t1\tcalc.mjs") problems.push(`numstat was ${JSON.stringify(numstat.trim())}`);
  const removed = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  if (removed.length !== 1 || removed[0] !== from) problems.push(`removed ${JSON.stringify(removed)}`);
  if (added.length !== 1 || added[0] !== to) problems.push(`added ${JSON.stringify(added)}`);
  return { passed: problems.length === 0, problems };
}

const FORBIDDEN = [/--force\b/, /--recover\b/, /\brm\s+-[a-z]*f/i, /worktree\s+remove/, /\bgit\b[^\n]*\bworktree\s+prune/];
/** Commands in the log that would be a forced or manual worktree removal. */
export function forcedRemovalCommands(commandLog) {
  return commandLog.filter((entry) => FORBIDDEN.some((pattern) => pattern.test(entry.command)));
}

const sameBehaviour = (a, b) => !!a && !!b && a.top === b.top && a.bottom === b.bottom;

/** The four acceptance criteria evaluated over a proof object. */
export function validateProof(proof) {
  const failures = [];
  const c1 = proof.case1 ?? {};
  const tasks = c1.tasks ?? [];
  const machines = tasks.map((t) => t.machine).sort().join(",");
  const crit1 = machines === "laptop,studio"
    && c1.overlap?.overlapped === true
    && tasks.every((t) => t.environment?.managed === true && t.environment?.isWorktree === true && typeof t.environment?.path === "string")
    && new Set(tasks.map((t) => `${t.machine}:${t.environment?.path}`)).size === 2
    && tasks.every((t) => t.target?.machineKey === t.machine && t.route?.machine === t.machine)
    && tasks.every((t) => t.commit?.parent === proof.fixture?.baseSha && t.mergeBase === proof.fixture?.baseSha)
    && tasks.every((t) => t.review?.passed === true && t.testOnHost?.exit === 0);
  if (!crit1) failures.push("(1) tasks did not overlap on studio and laptop in separate managed worktrees from the same base, or a task commit/test failed");
  const m = c1.merge ?? {};
  const crit2 = Array.isArray(m.merges) && m.merges.length === 2 && m.merges.every((x) => x.exit === 0)
    && m.conflicted === false && m.test?.exit === 0 && sameBehaviour(m.behaviour, EXPECT.merged)
    && m.bothEditsPresent === true
    && tasks.every((t) => m.fetched?.[t.machine] === t.commit?.sha);
  if (!crit2) failures.push("(2) the clean merge on laptop did not bring both commits back with a passing test and both edits");
  const c2 = proof.case2 ?? {};
  const r = c2.merge?.resolution ?? {};
  const crit3 = (c2.tasks ?? []).length === 2
    && c2.tasks.every((t) => t.baseIsCase1Merge === true && t.review?.passed === true && t.testOnHost?.exit === 0)
    && c2.merge?.first?.exit === 0
    && r.containsBothTasks === true
    && c2.merge?.second?.exit !== 0
    && Array.isArray(c2.merge?.second?.conflictedPaths) && c2.merge.second.conflictedPaths.length === 1
    && typeof r.sha === "string" && (r.parents ?? []).length === 2
    && sameBehaviour(r.behaviour, EXPECT.resolved) && r.test?.exit === 0 && r.markersRemaining === false;
  if (!crit3) failures.push("(3) the overlapping edit did not produce exactly one conflicted path resolved with both behaviours and a passing test");
  const envs = proof.cleanup?.environments ?? [];
  const crit4 = envs.length === 4
    && envs.every((e) => e.refusedWhileLive?.exit !== 0 && /live threads/i.test(e.refusedWhileLive?.message ?? "")
      && e.cleanup?.exit === 0 && e.finalStatus === "destroyed" && e.teardownStatus === "removed"
      && e.pathGone === true && e.listedInWorktreeList === false && e.branchKept === true)
    && proof.cleanup?.forcedRemovalByHarness === false;
  if (!crit4) failures.push("(4) the created worktrees were not all removed through BB cleanup without forced removal");
  return { criteria: { overlapSameBase: crit1, cleanMerge: crit2, conflictResolved: crit3, protectedCleanup: crit4 }, failures, ok: failures.length === 0 };
}

// ---------- process helpers ----------

const commandLog = [];
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no",
});

function run(file, args, { input, cwd, timeoutMs = 120_000, host = "laptop", label } = {}) {
  const command = label ?? [file, ...args].join(" ");
  const at = Date.now();
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env: cleanEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      commandLog.push({ host, command, exit: code, at });
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Run a bash script on studio over the pre-existing `studio` SSH alias. */
function studio(script, { timeoutMs = 120_000, label } = {}) {
  const full = `set -o pipefail\nexport PATH=${studio_PATH}\nB=${studio_BB}\n${script}\n`;
  return run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "studio", "bash -s"], { input: full, timeoutMs, host: "studio", label: label ?? script.trim() });
}

async function must(promise, what) {
  const r = await promise;
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 1500)}`);
  return r;
}
const json = (r) => JSON.parse(r.stdout);
const bb5 = (args, opts) => run("bb", args, opts);
const bb1 = (args, opts) => studio(`"$B" ${args.map(q).join(" ")}`, { ...opts, label: `bb ${args.join(" ")}` });
const git5 = (repo, args, opts) => run("git", ["-C", repo, ...args], opts);
const git1 = (repo, args, opts) => studio(`git -C ${q(repo)} ${args.map(q).join(" ")}`, { ...opts, label: `git -C ${repo} ${args.join(" ")}` });
const bbOn = (machine, args, opts) => (machine === "studio" ? bb1(args, opts) : bb5(args, opts));
const gitOn = (machine, repo, args, opts) => (machine === "studio" ? git1(repo, args, opts) : git5(repo, args, opts));
const nowOn = async (machine) => machine === "studio" ? Number((await must(studio("node -e 'console.log(Date.now())'"), "studio clock")).stdout.trim()) : Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ_ONLY_RPC = new Set(["route_preview", "thread_target_get"]);
async function fleetRpc(runDir, method, input) {
  const file = path.join(runDir, `rpc-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(file, JSON.stringify(input));
  const call = () => bb5(["plugin", "rpc", "call", "fleet", method, "--input-file", file, "--json"], { timeoutMs: 180_000 });
  let r = await call();
  // A plugin reload by someone else briefly answers 503. Retry reads only;
  // a mutation (work_start) is never resent automatically.
  for (let i = 0; r.code !== 0 && READ_ONLY_RPC.has(method) && /HTTP 503|not running/.test(r.stdout + r.stderr) && i < 24; i++) {
    await sleep(5000);
    r = await call();
  }
  return json(await must(Promise.resolve(r), `fleet ${method}`));
}

/** Behaviour of a calc.mjs source text, evaluated in-process. */
async function probe(source) {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return { top: mod.top(" ab "), bottom: mod.bottom(" ab ") };
}

// ---------- harness ----------

async function measureSkew() {
  const before = Date.now();
  const studioNow = await nowOn("studio");
  const after = Date.now();
  return { skewMs: studioNow - Math.round((before + after) / 2), uncertaintyMs: Math.ceil((after - before) / 2) };
}

function taskPrompt({ machine, label, from, to }) {
  return [
    `F63 acceptance task (${label}) on ${machine}. You are in a throwaway fixture git repository in a managed worktree; work only here.`,
    `1. In calc.mjs replace exactly this one line:`,
    from,
    `with exactly this line (keep the two-space indent, change nothing else in the file):`,
    to,
    `2. Run exactly: git add calc.mjs && git -c user.name="F63 ${machine} task" -c user.email=f63@example.invalid commit -m "F63 ${label} (${machine})"`,
    `3. Run exactly: node test.mjs`,
    `Do not push, do not create or switch branches, do not touch any other file, and do not ask questions.`,
    `Finish with three lines: the output of pwd, the output of git rev-parse HEAD, and the last line printed by node test.mjs.`,
  ].join("\n");
}

const SETTLED = new Set(["idle", "error", "failed", "stopped", "interrupted", "completed"]);

/** True for a bb server that is restarting or reloading, not a real refusal. */
export const isTransient = (text) => /ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|HTTP 50[23]|not running|not provider-managed/i.test(String(text));

/** Repeat an idempotent bb call while the bb server is restarting (up to three minutes). */
async function bbRetry(machine, args, { retryOn = isTransient } = {}) {
  const deadline = Date.now() + 180_000;
  let r = await bbOn(machine, args);
  while (r.code !== 0 && retryOn(r.stdout + r.stderr) && Date.now() < deadline) {
    await sleep(5000);
    r = await bbOn(machine, args);
  }
  return r;
}

async function threadShow(machine, threadId) {
  return json(await must(bbRetry(machine, ["thread", "show", threadId, "--json"]), `${machine} thread show ${threadId}`));
}

async function startPair(ctx, caseName, specs) {
  const dispatched = await Promise.all(specs.map(async (spec) => {
    const requestId = `f63-${ctx.runId}-${caseName}-${spec.machine.toLowerCase()}`;
    const input = {
      machine: spec.machine, providerId: PROVIDER, model: MODEL, projectName: ctx.projectName,
      workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
      title: `F63 ${ctx.runId} ${caseName} ${spec.machine} ${spec.label}`, requestId,
      prompt: taskPrompt(spec),
    };
    const dispatchedAt = Date.now();
    const result = await fleetRpc(ctx.runDir, "work_start", input);
    return { ...spec, requestId, dispatchedAt, acceptedAt: Date.now(), result };
  }));
  for (const d of dispatched) {
    if (d.result.outcome !== "started" || !d.result.threadId) throw new Error(`${d.machine} work_start did not start a thread: ${JSON.stringify(d.result)}`);
    ctx.threads.push({ machine: d.machine, threadId: d.result.threadId });
  }
  // Poll both owners together until both turns settle.
  const settled = new Map();
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (settled.size < dispatched.length) {
    if (Date.now() > deadline) throw new Error(`${caseName}: tasks did not settle within ${TASK_TIMEOUT_MS / 60000} minutes (a thread may be waiting for input)`);
    await Promise.all(dispatched.filter((d) => !settled.has(d.machine)).map(async (d) => {
      const shown = await threadShow(d.machine, d.result.threadId);
      if (SETTLED.has(shown.thread.status)) settled.set(d.machine, { observedAt: Date.now(), shown });
    }));
    if (settled.size < dispatched.length) await sleep(3000);
  }
  const tasks = [];
  for (const d of dispatched) {
    const { observedAt, shown } = settled.get(d.machine);
    const env = shown.environment;
    if (shown.thread.status !== "idle") throw new Error(`${d.machine} task ended in ${shown.thread.status}`);
    if (!env?.path) throw new Error(`${d.machine} task has no environment path`);
    const skew = d.machine === "studio" ? ctx.clock.skewMs : 0;
    const target = d.machine === "studio"
      ? await (async () => { const f = `${ctx.studioRunDir}/target-${d.result.threadId}.json`; await must(studio(`printf '%s' ${q(JSON.stringify({ threadId: d.result.threadId }))} > ${q(f)}`), "studio input"); return json(await must(bb1(["plugin", "rpc", "call", "fleet", "thread_target_get", "--input-file", f, "--json"]), "studio thread_target_get")); })()
      : await fleetRpc(ctx.runDir, "thread_target_get", { threadId: d.result.threadId });
    const log = (await must(gitOn(d.machine, env.path, ["log", "-1", "--format=%H%x1f%P%x1f%an%x1f%ct%x1f%s"]), `${d.machine} git log`)).stdout.trim().split("\x1f");
    const [sha, parent, author, committedAt, subject] = log;
    const mergeBase = (await must(gitOn(d.machine, env.path, ["merge-base", "HEAD", "main"]), "merge-base")).stdout.trim();
    const numstat = (await must(gitOn(d.machine, env.path, ["diff", "--numstat", `${parent}`, sha]), "numstat")).stdout;
    const patch = (await must(gitOn(d.machine, env.path, ["diff", "-U0", `${parent}`, sha]), "diff")).stdout;
    const dirty = (await must(gitOn(d.machine, env.path, ["status", "--porcelain", "--untracked-files=no"]), "status")).stdout.trim();
    const source = (await must(gitOn(d.machine, env.path, ["show", `${sha}:calc.mjs`]), "show calc")).stdout;
    const testRun = d.machine === "studio" ? await studio(`cd ${q(env.path)} && node test.mjs`, { label: `node test.mjs (in ${env.path})` }) : await run("node", ["test.mjs"], { cwd: env.path, label: `node test.mjs (in ${env.path})` });
    const behaviour = await probe(source);
    const review = reviewDiff({ numstat, patch }, { from: d.from, to: d.to });
    if (!sameBehaviour(behaviour, d.expect)) review.problems.push(`behaviour ${JSON.stringify(behaviour)} != ${JSON.stringify(d.expect)}`);
    review.passed = review.problems.length === 0 && dirty === "";
    if (dirty) review.problems.push(`uncommitted tracked changes: ${dirty}`);
    const createdAtHost = shown.thread.createdAt;
    const settledAtHost = shown.thread.updatedAt;
    tasks.push({
      machine: d.machine, label: d.label, requestId: d.requestId, threadId: d.result.threadId, url: d.result.url,
      route: { machine: d.result.route.machine, serverId: d.result.route.serverId, hostId: d.result.route.hostId, mode: d.result.route.mode },
      target,
      environment: { id: env.id, path: env.path, branchName: env.branchName, hostId: env.hostId, managed: env.managed, isWorktree: env.isWorktree, workspaceProvisionType: env.workspaceProvisionType, providerSelection: env.environmentProviderSelection?.inputs ?? null },
      provider: { providerId: shown.thread.providerId, model: MODEL },
      dispatchedAt: d.dispatchedAt, acceptedAt: d.acceptedAt,
      createdAtHost, settledAtHost, observedSettledAt: observedAt,
      start: createdAtHost - skew, end: settledAtHost - skew,
      commit: { sha, parent, author, committedAtSeconds: Number(committedAt), subject },
      mergeBase, diffNumstat: numstat.trim(), patch: patch.trim(), review, behaviour,
      testOnHost: { exit: testRun.code, stdout: testRun.stdout.trim(), stderr: testRun.stderr.trim().slice(0, 500) },
      answer: await answerOf(d.machine, d.result.threadId),
    });
  }
  const overlap = intervalsOverlap(tasks.map((t) => ({ start: t.start, end: t.end })), ctx.clock.uncertaintyMs);
  return { tasks, overlap };
}

async function answerOf(machine, threadId) {
  const r = await bbRetry(machine, ["thread", "output", threadId]);
  return r.stdout.trim().slice(-600);
}

async function behaviourAt(repo, rev) {
  return probe((await must(git5(repo, ["show", `${rev}:calc.mjs`]), "show")).stdout);
}

async function setupFixture(ctx) {
  const seed = path.join(ctx.runDir, "seed");
  await mkdir(seed, { recursive: true });
  await writeFile(path.join(seed, "calc.mjs"), FIXTURE_CALC);
  await writeFile(path.join(seed, "test.mjs"), FIXTURE_TEST);
  await writeFile(path.join(seed, "README.md"), "Throwaway F63 acceptance fixture. Safe to delete.\n");
  await must(run("git", ["init", "-q", "-b", "main", seed]), "seed init");
  await must(git5(seed, ["add", "."]), "seed add");
  await must(git5(seed, [...IDENTITY, "commit", "-q", "-m", "F63 fixture base"]), "seed commit");
  ctx.fixture.baseSha = (await must(git5(seed, ["rev-parse", "HEAD"]), "base sha")).stdout.trim();
  await must(studio(`mkdir -p ${q(ctx.studioRunDir)} && git init -q --bare -b main ${q(ctx.fixture.origin)}`), "studio bare origin");
  ctx.created.studioRunDir = true;
  await must(git5(seed, ["push", "-q", ctx.fixture.originUrl, "main"]), "push base");
  const remote = (await must(run("git", ["ls-remote", ctx.fixture.originUrl, "refs/heads/main"]), "ls-remote")).stdout.split("\t")[0];
  if (remote !== ctx.fixture.baseSha) throw new Error("Pushed base does not match");
  ctx.fixture.pushedBase = remote;
  await must(run("git", ["clone", "-q", ctx.fixture.originUrl, ctx.fixture.laptopClone]), "laptop clone");
  await must(studio(`git clone -q ${q(ctx.fixture.origin)} ${q(ctx.fixture.studioClone)}`), "studio clone");
  for (const [machine, clone] of [["laptop", ctx.fixture.laptopClone], ["studio", ctx.fixture.studioClone]]) {
    const head = (await must(gitOn(machine, clone, ["rev-parse", "HEAD"]), "clone head")).stdout.trim();
    if (head !== ctx.fixture.baseSha) throw new Error(`${machine} clone is not at the base`);
    const test = machine === "studio" ? await studio(`cd ${q(clone)} && node test.mjs`) : await run("node", ["test.mjs"], { cwd: clone });
    if (test.code !== 0) throw new Error(`${machine} fixture test failed at base`);
    const project = json(await must(bbOn(machine, ["project", "create", "--name", ctx.projectName, "--root", clone, "--json"]), `${machine} project create`));
    ctx.fixture.projects[machine] = { id: project.id, root: clone };
  }
  const previews = {};
  for (const machine of ["studio", "laptop"]) {
    // Fleet caches studio's owner snapshot for about 10 seconds, so a project
    // created moments ago can be missing from the first preview. Wait for it.
    const deadline = Date.now() + 90_000;
    for (let attempt = 1; ; attempt++) {
      previews[machine] = await fleetRpc(ctx.runDir, "route_preview", { machine, providerId: PROVIDER, model: MODEL, projectName: ctx.projectName, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } } });
      previews[machine].attempts = attempt;
      if (previews[machine].candidates?.some((c) => c.machine === machine && c.eligible)) break;
      if (Date.now() > deadline) throw new Error(`${machine} is not eligible: ${JSON.stringify(previews[machine])}`);
      await sleep(5000);
    }
  }
  ctx.fixture.routePreview = previews;
}

async function fetchTaskCommits(ctx, tasks) {
  const fetched = {};
  for (const t of tasks) {
    if (t.machine === "studio") {
      await must(git1(ctx.fixture.studioClone, ["push", "-q", "origin", `${t.environment.branchName}`]), "studio push task branch");
      await must(git5(ctx.fixture.laptopClone, ["fetch", "-q", "origin", `+refs/heads/${t.environment.branchName}:refs/remotes/origin/${t.environment.branchName}`]), "laptop fetch studio task");
      t.mergeRef = `origin/${t.environment.branchName}`;
    } else {
      t.mergeRef = t.environment.branchName; // same repository on laptop
    }
    fetched[t.machine] = (await must(git5(ctx.fixture.laptopClone, ["rev-parse", t.mergeRef]), "rev-parse fetched")).stdout.trim();
  }
  return fetched;
}

async function mergeRef(ctx, ref, message) {
  const r = await git5(ctx.fixture.laptopClone, [...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", message, ref]);
  return { ref, exit: r.code, output: (r.stdout + r.stderr).trim().slice(0, 2000) };
}

async function fixtureTest(machine, dir) {
  const r = machine === "studio" ? await studio(`cd ${q(dir)} && node test.mjs`) : await run("node", ["test.mjs"], { cwd: dir });
  return { exit: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim().slice(0, 500) };
}

async function case1(ctx) {
  const pair = await startPair(ctx, "c1", [
    { machine: "studio", label: "top function", from: LINES.topBase, to: LINES.topEdit, expect: EXPECT.c1Top },
    { machine: "laptop", label: "bottom function", from: LINES.bottomBase, to: LINES.bottomEdit, expect: EXPECT.c1Bottom },
  ]);
  const fetched = await fetchTaskCommits(ctx, pair.tasks);
  const order = [pair.tasks.find((t) => t.machine === "studio"), pair.tasks.find((t) => t.machine === "laptop")];
  const merges = [];
  for (const t of order) merges.push(await mergeRef(ctx, t.mergeRef, `F63 merge ${t.machine} ${t.label}`));
  const conflicted = parseConflictedPaths((await git5(ctx.fixture.laptopClone, ["diff", "--name-only", "--diff-filter=U"])).stdout).length > 0;
  const mainSha = (await must(git5(ctx.fixture.laptopClone, ["rev-parse", "HEAD"]), "main sha")).stdout.trim();
  const file = await readFile(path.join(ctx.fixture.laptopClone, "calc.mjs"), "utf8");
  const test = await fixtureTest("laptop", ctx.fixture.laptopClone);
  const behaviour = await behaviourAt(ctx.fixture.laptopClone, "HEAD");
  const contains = (await Promise.all(order.map((t) => git5(ctx.fixture.laptopClone, ["merge-base", "--is-ancestor", t.commit.sha, "HEAD"])))).map((r) => r.code === 0);
  // Publish the merged main as the base for the conflict case on both clones.
  await must(git5(ctx.fixture.laptopClone, ["push", "-q", "origin", "main"]), "push merged main");
  await must(git1(ctx.fixture.studioClone, ["pull", "-q", "--ff-only", "origin", "main"]), "studio fast-forward main");
  const studioMain = (await must(git1(ctx.fixture.studioClone, ["rev-parse", "main"]), "studio main")).stdout.trim();
  return {
    ...pair,
    merge: {
      fetched, merges, conflicted, mainSha, test, behaviour,
      bothEditsPresent: file.includes(LINES.topEdit) && file.includes(LINES.bottomEdit) && contains.every(Boolean),
      finalFile: file, publishedToOrigin: true, studioMainAfterPull: studioMain,
    },
  };
}

async function case2(ctx, base) {
  const pair = await startPair(ctx, "c2", [
    { machine: "studio", label: "top trim", from: LINES.topEdit, to: LINES.trimEdit, expect: EXPECT.c2Trim },
    { machine: "laptop", label: "top upper-case", from: LINES.topEdit, to: LINES.upperEdit, expect: EXPECT.c2Upper },
  ]);
  for (const t of pair.tasks) t.baseIsCase1Merge = t.commit.parent === base && t.mergeBase === base;
  const fetched = await fetchTaskCommits(ctx, pair.tasks);
  const first = pair.tasks.find((t) => t.machine === "studio");
  const second = pair.tasks.find((t) => t.machine === "laptop");
  const firstMerge = await mergeRef(ctx, first.mergeRef, `F63 merge ${first.machine} ${first.label}`);
  const secondMerge = await mergeRef(ctx, second.mergeRef, `F63 merge ${second.machine} ${second.label}`);
  const conflictedPaths = parseConflictedPaths((await git5(ctx.fixture.laptopClone, ["diff", "--name-only", "--diff-filter=U"])).stdout);
  const statusDuring = (await git5(ctx.fixture.laptopClone, ["status", "--porcelain"])).stdout.trim();
  const conflictedText = await readFile(path.join(ctx.fixture.laptopClone, "calc.mjs"), "utf8");
  let resolution = { sha: null };
  if (secondMerge.exit !== 0 && conflictedPaths.length === 1 && conflictedPaths[0] === "calc.mjs") {
    const resolvedText = resolveConflictBlock(conflictedText, { ours: LINES.trimEdit, theirs: LINES.upperEdit, resolution: LINES.resolved });
    await writeFile(path.join(ctx.fixture.laptopClone, "calc.mjs"), resolvedText);
    await must(git5(ctx.fixture.laptopClone, ["add", "calc.mjs"]), "add resolution");
    await must(git5(ctx.fixture.laptopClone, [...IDENTITY, "commit", "--no-edit", "-q"]), "commit resolution");
    const sha = (await must(git5(ctx.fixture.laptopClone, ["rev-parse", "HEAD"]), "resolution sha")).stdout.trim();
    const parents = (await must(git5(ctx.fixture.laptopClone, ["rev-list", "--parents", "-n", "1", sha]), "parents")).stdout.trim().split(" ").slice(1);
    const committed = (await must(git5(ctx.fixture.laptopClone, ["show", `${sha}:calc.mjs`]), "show resolution")).stdout;
    resolution = {
      sha, parents, subject: (await git5(ctx.fixture.laptopClone, ["log", "-1", "--format=%s", sha])).stdout.trim(),
      resolvedLine: LINES.resolved, markersRemaining: /^(<<<<<<<|=======|>>>>>>>)/m.test(committed),
      behaviour: await probe(committed), test: await fixtureTest("laptop", ctx.fixture.laptopClone),
      containsBothTasks: (await Promise.all([first, second].map((t) => git5(ctx.fixture.laptopClone, ["merge-base", "--is-ancestor", t.commit.sha, sha])))).every((r) => r.code === 0),
    };
  }
  return {
    ...pair,
    base,
    merge: {
      fetched,
      first: { ...firstMerge, machine: first.machine },
      second: { ...secondMerge, machine: second.machine, conflictedPaths, statusDuring, conflictedText },
      resolution,
    },
  };
}

async function cleanupEnvironments(ctx) {
  const environments = [];
  for (const { machine, threadId } of ctx.threads) {
    const shown = await threadShow(machine, threadId).catch(() => null);
    const env = shown?.environment;
    if (!env?.id) { environments.push({ machine, threadId, error: "no environment recorded" }); continue; }
    const clone = machine === "studio" ? ctx.fixture.studioClone : ctx.fixture.laptopClone;
    const sha = (await gitOn(machine, clone, ["rev-parse", env.branchName])).stdout.trim();
    const entry = { machine, threadId, envId: env.id, path: env.path, branchName: env.branchName, taskSha: sha };
    // The guard must refuse for the right reason: retry only while bb restarts.
    const refused = await bbRetry(machine, ["environment", "cleanup", env.id, "--json"], { retryOn: (t) => !/live threads/i.test(t) && isTransient(t) });
    entry.refusedWhileLive = { exit: refused.code, message: (refused.stderr + refused.stdout).trim().split("\n")[0] };
    const archived = await bbRetry(machine, ["environment", "archive-threads", env.id, "--json"]);
    entry.archive = { exit: archived.code, output: archived.stdout.trim() };
    const cleaned = await bbRetry(machine, ["environment", "cleanup", env.id, "--json"]);
    entry.cleanup = { exit: cleaned.code, output: cleaned.stdout.trim() };
    environments.push(entry);
  }
  const deadline = Date.now() + 5 * 60_000;
  for (const entry of environments.filter((e) => e.envId)) {
    let shown;
    for (;;) {
      shown = json(await must(bbRetry(entry.machine, ["environment", "show", entry.envId, "--json"]), "environment show"));
      if (shown.status === "destroyed" || Date.now() > deadline) break;
      await sleep(3000);
    }
    entry.finalStatus = shown.status;
    entry.lifecyclePhase = shown.lifecycle?.phase ?? null;
    entry.teardownStatus = shown.lifecycle?.teardown?.status ?? null;
    entry.teardownAttempt = shown.lifecycle?.teardown?.attempt ?? null;
    const clone = entry.machine === "studio" ? ctx.fixture.studioClone : ctx.fixture.laptopClone;
    const exists = entry.machine === "studio" ? await studio(`test -e ${q(entry.path)}`, { label: `test -e ${entry.path}` }) : await run("test", ["-e", entry.path]);
    entry.pathGone = exists.code !== 0;
    const list = (await gitOn(entry.machine, clone, ["worktree", "list", "--porcelain"])).stdout;
    entry.listedInWorktreeList = list.split("\n").some((l) => l === `worktree ${entry.path}`);
    const contains = await gitOn(entry.machine, clone, ["branch", "--list", "--contains", entry.taskSha, entry.branchName]);
    entry.branchKept = contains.code === 0 && contains.stdout.includes(entry.branchName);
  }
  const offending = forcedRemovalCommands(commandLog);
  return { environments, forcedRemovalByHarness: offending.length > 0, offendingCommands: offending, providerNote: PROVIDER_REMOVAL_NOTE };
}

async function removeFixture(ctx) {
  const out = { projects: {}, dirs: {} };
  for (const [machine, project] of Object.entries(ctx.fixture.projects)) {
    const r = await bbOn(machine, ["project", "delete", project.id, "--yes", "--json"]);
    out.projects[machine] = { id: project.id, exit: r.code };
  }
  if (ctx.created.studioRunDir) {
    // Only this run's directory (bare origin and clone); never a worktree path.
    const r = await studio(`rm -r ${q(ctx.studioRunDir)} && (rmdir ${q(SCRATCH_ROOT)} 2>/dev/null || true) && test ! -e ${q(ctx.studioRunDir)}`, { label: `rm -r ${ctx.studioRunDir}` });
    out.dirs.studio = { path: ctx.studioRunDir, removed: r.code === 0 };
  }
  await rm(ctx.runDir, { recursive: true });
  out.dirs.laptop = { path: ctx.runDir, removed: true };
  return out;
}

export async function main() {
  const runId = `${Date.now().toString(36)}`;
  const runDir = path.join(SCRATCH_ROOT, `run-${runId}`);
  const studioRunDir = `${SCRATCH_ROOT}/run-${runId}`;
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(runDir, { recursive: true });
  const ctx = {
    runId, runDir, studioRunDir, projectName: `F63 fixture ${runId}`, threads: [], created: {},
    fixture: {
      origin: `${studioRunDir}/origin.git`, originUrl: `studio:${studioRunDir}/origin.git`,
      laptopClone: path.join(runDir, "laptop"), studioClone: `${studioRunDir}/studio`, projects: {}, baseSha: null,
    },
  };
  const proof = { item: "F63", runId, startedAt: new Date().toISOString(), provider: PROVIDER, model: MODEL };
  const write = () => writeFile(PROOF_PATH, JSON.stringify({ ...proof, commandLog }, null, 2) + "\n");
  try {
    proof.harness = {
      script: fileURLToPath(import.meta.url),
      commit: (await run("git", ["-C", path.dirname(fileURLToPath(import.meta.url)), "rev-parse", "HEAD"])).stdout.trim(),
    };
    const studioHost = await must(studio("hostname; whoami; \"$B\" --version"), "studio identity");
    proof.hosts = {
      laptop: { hostname: os.hostname(), user: os.userInfo().username, bb: (await run("bb", ["--version"])).stdout.trim() },
      studio: Object.fromEntries(["hostname", "user", "bb"].map((k, i) => [k, studioHost.stdout.trim().split("\n")[i]])),
    };
    ctx.clock = await measureSkew();
    proof.clock = { ...ctx.clock, note: "studio timestamps are converted to the laptop clock by subtracting skewMs; overlap is narrowed by uncertaintyMs at both ends." };
    await setupFixture(ctx);
    proof.fixture = ctx.fixture;
    await write();
    proof.case1 = await case1(ctx);
    await write();
    proof.case2 = await case2(ctx, proof.case1.merge.mainSha);
    await write();
  } catch (cause) {
    proof.error = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
    await write();
  }
  try {
    proof.cleanup = await cleanupEnvironments(ctx);
  } catch (cause) {
    proof.cleanupError = cause instanceof Error ? cause.message : String(cause);
  }
  proof.clockAfter = await measureSkew().catch(() => null);
  proof.validation = validateProof(proof);
  await write(); // complete evidence before the projects (and their threads) are deleted
  try {
    // Deleting a clone under a live worktree would orphan it, so the fixture
    // stays (and is reported) until BB has destroyed every worktree.
    const pending = (proof.cleanup?.environments ?? []).filter((e) => e.finalStatus !== "destroyed").map((e) => e.envId ?? e.threadId);
    if (proof.cleanupError || pending.length > 0 || (proof.cleanup?.environments?.length ?? 0) < ctx.threads.length) {
      throw new Error(`Fixture kept for inspection: worktree cleanup incomplete (${pending.join(", ") || proof.cleanupError || "missing environments"}); projects ${JSON.stringify(ctx.fixture.projects)}, laptop ${ctx.runDir}, studio ${ctx.studioRunDir}`);
    }
    proof.fixtureRemoval = await removeFixture(ctx);
  } catch (cause) {
    proof.fixtureRemovalError = cause instanceof Error ? cause.message : String(cause);
  }
  proof.finishedAt = new Date().toISOString();
  proof.ok = proof.validation.ok && !proof.error && !proof.cleanupError && !proof.fixtureRemovalError;
  await write();
  console.log(JSON.stringify({ ok: proof.ok, runId, proof: PROOF_PATH, criteria: proof.validation.criteria, failures: proof.validation.failures, error: proof.error ?? proof.cleanupError ?? proof.fixtureRemovalError ?? null }, null, 2));
  return proof.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (cause) => { console.error(cause); process.exit(1); });
}

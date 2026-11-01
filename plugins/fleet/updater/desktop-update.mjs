// Fleet desktop update helper. Runs OUTSIDE the bb process it restarts, so its
// intent file is the durable record across the restart. Plain Node, no
// dependencies, argv-only child processes (no shell strings).
//
// Modes:
//   native     drain -> backup -> `bb updates app apply` (exact when the server
//              advertises experimental_exactApply) -> reconnect proof -> rollback
//              from the backup if the target version never comes back.
//   bootstrap  for hosts whose server cannot relay updates (desktop < 0.46.1):
//              drain -> verify the vendor's own staged ShipIt update, or the
//              official release zip (sha512 from latest-mac.yml at the exact tag,
//              codesign team/identifier, Gatekeeper) -> backup -> graceful quit
//              -> install -> relaunch -> reconnect proof -> rollback.
//   rollback   swap a verified backup back in, with the same guards.
//   status     print the intent file.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleepTimer } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

export const BUNDLE_ID = "dev.bb.desktop";
export const TEAM_ID = "9QCU24SXK5";
export const RELEASE_BASE = "https://github.com/get-bb/bb/releases/download/";
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export const INTENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
export const TERMINAL = new Set(["updated", "failed", "rolled-back", "rollback-failed", "rollback-held", "install-held", "refused"]);
export const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function childEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("BB_") || key.startsWith("ELECTRON_") || key === "NODE_OPTIONS" || key === "PATH") continue;
    clean[key] = value;
  }
  clean.PATH = CHILD_PATH;
  return clean;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/**
 * Exclusive host lock: an atomic mkdir claim with the holder and a random
 * token written inside. It fails closed and never reclaims: an existing
 * directory (live, dead, half-written or unreadable holder) means busy until
 * a person removes it. Release removes the directory only while it still
 * holds this claim's token.
 */
export async function acquireHostLock(dir, owner) {
  await mkdir(dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let holder = null;
    try { holder = JSON.parse(await readFile(join(dir, "holder.json"), "utf8")); } catch { holder = null; }
    if (holder === null || !Number.isInteger(holder.pid)) return { acquired: false, holder: null, reason: "unreadable" };
    return { acquired: false, holder, reason: alive(holder.pid) ? "live" : "stale" };
  }
  const token = randomUUID();
  await writeFile(join(dir, "holder.json.tmp"), JSON.stringify({ ...owner, pid: process.pid, token }));
  await rename(join(dir, "holder.json.tmp"), join(dir, "holder.json"));
  return {
    acquired: true,
    async release() {
      let holder = null;
      try { holder = JSON.parse(await readFile(join(dir, "holder.json"), "utf8")); } catch { holder = null; }
      if (holder?.token === token) await rm(dir, { recursive: true, force: true });
    },
  };
}

export function releaseUrls(version) {
  if (!VERSION_RE.test(version)) throw new Error(`Invalid version ${version}`);
  const base = `${RELEASE_BASE}desktop-v${version}/`;
  return { fileName: `bb-${version}-arm64.zip`, zip: `${base}bb-${version}-arm64.zip`, manifest: `${base}latest-mac.yml` };
}

export function parseLatestMacYml(text, fileName) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*-\s*url:\s*(\S+)\s*$/.exec(lines[i]);
    if (!match || match[1] !== fileName) continue;
    let sha512 = null;
    let size = null;
    for (let j = i + 1; j < lines.length && !/^\s*-\s*url:/.test(lines[j]) && /^\s+/.test(lines[j]); j += 1) {
      const sha = /^\s*sha512:\s*(\S+)\s*$/.exec(lines[j]);
      const sz = /^\s*size:\s*(\d+)\s*$/.exec(lines[j]);
      if (sha) sha512 = sha[1];
      if (sz) size = Number(sz[1]);
    }
    if (sha512 && size) return { sha512, size };
  }
  throw new Error(`latest-mac.yml has no entry for ${fileName}`);
}

export function defaultDeps() {
  return {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    exec(bin, args, timeoutMs = 120_000, extraEnv = {}) {
      return new Promise((resolve) => {
        execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...childEnv(), ...extraEnv } }, (error, stdout, stderr) => {
          const failedToRun = Boolean(error) && (typeof error.code !== "number" || error.killed === true || error.signal != null);
          const code = error ? (failedToRun ? -1 : error.code) : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
        });
      });
    },
    async download(url, path) {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
      await mkdir(dirname(path), { recursive: true });
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(`${path}.part`, buffer);
      await rename(`${path}.part`, path);
    },
    async sha512(path) {
      const hash = createHash("sha512");
      await new Promise((resolve, reject) => createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject));
      return hash.digest("base64");
    },
    readText: (path) => readFile(path, "utf8"),
    writeText: async (path, text) => { await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.tmp`, text); await rename(`${path}.tmp`, path); },
    exists: (path) => existsSync(path),
    move: async (from, to) => { await mkdir(dirname(to), { recursive: true }); await rename(from, to); },
    mkdir: (path) => mkdir(path, { recursive: true }),
    sleep: (ms) => sleepTimer(ms),
    now: () => Date.now(),
    lock: (path, owner) => acquireHostLock(path, owner),
  };
}

function intentPath(plan) { return join(plan.stateDir, "intents", `${plan.intentId}.json`); }

export async function readIntent(plan, deps) {
  const path = intentPath(plan);
  if (!deps.exists(path)) return null;
  return JSON.parse(await deps.readText(path));
}

async function record(plan, deps, state, patch) {
  const next = { ...state, ...patch, history: [...(state.history ?? []), { phase: patch.phase ?? state.phase, at: deps.now(), ...(patch.reason ? { reason: patch.reason } : {}) }], updatedAt: deps.now() };
  await deps.writeText(intentPath(plan), JSON.stringify(next, null, 2));
  return next;
}

async function plistVersion(appPath, deps) {
  const result = await deps.exec("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(appPath, "Contents", "Info.plist")]);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function verifyBundle(appPath, version, deps, options = { gatekeeper: true }) {
  const strict = await deps.exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], 300_000);
  if (strict.code !== 0) return `codesign verification failed: ${strict.stderr.trim().split("\n")[0]}`;
  const info = await deps.exec("/usr/bin/codesign", ["-dv", "--verbose=2", appPath]);
  const text = `${info.stdout}\n${info.stderr}`;
  if (!new RegExp(`^Identifier=${BUNDLE_ID.replace(/\./g, "\\.")}$`, "m").test(text)) return "bundle identifier is not dev.bb.desktop";
  if (!new RegExp(`^TeamIdentifier=${TEAM_ID}$`, "m").test(text)) return `team identifier is not ${TEAM_ID}`;
  const found = await plistVersion(appPath, deps);
  if (found !== version) return `bundle version is ${found ?? "unreadable"}, expected ${version}`;
  if (options.gatekeeper) {
    const gate = await deps.exec("/usr/sbin/spctl", ["--assess", "--type", "execute", "-v", appPath]);
    if (gate.code !== 0) return `Gatekeeper refused the bundle: ${gate.stderr.trim().split("\n")[0]}`;
  }
  return null;
}

function bbCli(plan, deps, args, timeoutMs) {
  return deps.exec(plan.nodeBin, [plan.bbCli, ...args], timeoutMs, plan.nodeEnv ?? {});
}

async function appStatus(plan, deps) {
  const result = await bbCli(plan, deps, ["updates", "app", "--json"], 60_000);
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

export function parseProcessTable(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] });
  }
  return rows;
}

async function processTable(deps) {
  const result = await deps.exec("/bin/ps", ["-axo", "pid=,ppid=,comm="]);
  if (result.code !== 0 || result.stdout.trim() === "") return null;
  return parseProcessTable(result.stdout);
}

function isBbShipIt(plan, row) {
  return row.comm.startsWith(`${plan.appPath}/Contents/Frameworks/Squirrel.framework/`) && row.comm.endsWith("/ShipIt");
}

/** Every bb app process (executable inside the bundle), by executable path, not argv. The vendor installer is excluded: it is never signalled. */
async function bundleProcesses(plan, deps) {
  const rows = await processTable(deps);
  if (rows === null) return null;
  const prefix = `${plan.appPath}/Contents/`;
  return rows.filter((row) => row.comm.startsWith(prefix) && !isBbShipIt(plan, row));
}

/** bb's own ShipIt only (another app's ShipIt is ignored); null when the table cannot be read. */
async function bbShipItRunning(plan, deps) {
  const rows = await processTable(deps);
  if (rows === null) return null;
  return rows.some((row) => isBbShipIt(plan, row));
}

/**
 * The owner's admission drain must report safeToQuit right before bb is
 * stopped or told to apply. Without a drain target the helper refuses unless
 * the operator explicitly ran it unguarded.
 */
async function drainSafe(plan, deps) {
  if (!plan.drain) return plan.allowUngatedQuit === true ? { ok: true, reason: "operator-run without a drain" } : { ok: false, reason: "No admission drain was supplied; refusing to stop bb" };
  const inputPath = join(plan.stateDir, `drain-${plan.intentId}.json`);
  await deps.writeText(inputPath, JSON.stringify(plan.drain));
  const until = deps.now() + (plan.drainTimeoutMs ?? 6 * 3_600_000);
  for (;;) {
    const result = await bbCli(plan, deps, ["plugin", "rpc", "call", "fleet", "update_drain_status", "--input-file", inputPath, "--json"], 60_000);
    let body = null;
    try { body = JSON.parse(result.stdout); } catch { body = null; }
    const status = body?.ok === true ? body.result : body;
    if (status && (status.cancelRequested === true || String(status.reason ?? "").includes("core-drain-cancel-requested"))) return { ok: false, reason: "The update was cancelled on the owner before bb was stopped" };
    if (result.code === 0 && status && status.intentId === plan.drain.intentId && status.safeToQuit === true && status.gateActive === true) return { ok: true, reason: null };
    if (status && (status.state === "released" || status.state === "refused" || status.state === "unavailable")) return { ok: false, reason: `The admission drain is ${status.state}: ${status.reason ?? ""}`.trim() };
    if (deps.now() >= until) return { ok: false, reason: `The admission drain never reported safe to quit${status?.reason ? `: ${status.reason}` : ""}` };
    await deps.sleep(plan.drainEveryMs ?? 30_000);
  }
}

async function appProcess(plan, deps) {
  const rows = await bundleProcesses(plan, deps);
  if (rows === null) return "unknown";
  return rows.length > 0 ? "running" : "stopped";
}

async function waitFor(deps, timeoutMs, step, everyMs = 2_000) {
  const until = deps.now() + timeoutMs;
  for (;;) {
    const value = await step();
    if (value) return value;
    if (deps.now() >= until) return null;
    await deps.sleep(everyMs);
  }
}

async function drain(plan, deps, state) {
  const idle = await waitFor(deps, plan.drainTimeoutMs ?? 6 * 3_600_000, async () => {
    const status = await appStatus(plan, deps);
    if (status === null) return null;
    return status.runningThreadCount === 0 ? status : null;
  }, plan.drainEveryMs ?? 30_000);
  if (idle === null) return record(plan, deps, state, { phase: "refused", reason: "Threads kept running; nothing was restarted. Run again when the host is idle." });
  return idle;
}

async function quitApp(plan, deps) {
  if (plan.quitMode !== "signal") {
    const asked = await deps.exec("/usr/bin/osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`], 60_000);
    const quit = await waitFor(deps, asked.code === 0 ? (plan.quitTimeoutMs ?? 180_000) : 0, async () => (await appProcess(plan, deps)) === "stopped");
    if (quit) return { quit: true, via: "apple-event" };
  }
  const signalled = new Set();
  const stopped = await waitFor(deps, plan.quitTimeoutMs ?? 180_000, async () => {
    const rows = await bundleProcesses(plan, deps);
    if (rows === null) return null;
    if (rows.length === 0) return "stopped";
    const pids = new Set(rows.map((row) => row.pid));
    for (const root of rows.filter((row) => !pids.has(row.ppid) && !signalled.has(row.pid))) {
      signalled.add(root.pid);
      await deps.exec("/bin/kill", ["-TERM", String(root.pid)]);
    }
    return null;
  });
  return { quit: stopped === "stopped", via: "sigterm", signalled: [...signalled] };
}

async function launchAndProve(plan, deps, version) {
  await deps.exec("/usr/bin/open", [plan.appPath]);
  return waitFor(deps, plan.reconnectTimeoutMs ?? 300_000, async () => {
    const status = await appStatus(plan, deps);
    return status?.current?.version === version ? status : null;
  }, 5_000);
}

async function backupApp(plan, deps, fromVersion) {
  const backup = join(plan.stateDir, "backups", `bb-${fromVersion}.app`);
  if (!deps.exists(backup)) {
    await deps.mkdir(dirname(backup));
    const copied = await deps.exec("/usr/bin/ditto", [plan.appPath, backup], 900_000);
    if (copied.code !== 0) throw new Error(`Backup copy failed: ${copied.stderr.trim()}`);
  }
  const problem = await verifyBundle(backup, fromVersion, deps, { gatekeeper: false });
  if (problem) throw new Error(`Backup is not a verified bb ${fromVersion}: ${problem}`);
  return backup;
}

async function rollbackTo(plan, deps, state, backup, fromVersion, reason) {
  const presence = await appProcess(plan, deps);
  if (presence !== "stopped") {
    const status = presence === "running" ? await appStatus(plan, deps) : null;
    if (status === null || status.runningThreadCount !== 0) {
      return record(plan, deps, state, { phase: "rollback-held", reason: `${reason}; ${status === null ? (presence === "unknown" ? "whether bb is running could not be determined" : "the running bb did not answer, so its work is unknown") : `${status.runningThreadCount} thread(s) are running on bb ${status.current?.version ?? "unknown"}`}. Nothing was interrupted. The verified backup ${backup} is kept for an explicit rollback.`, backup });
    }
    state = await record(plan, deps, state, { phase: "rolling-back", reason });
    if (!(await quitApp(plan, deps)).quit) return record(plan, deps, state, { phase: "rollback-failed", reason: `${reason}; the new app did not quit, so the backup at ${backup} was not swapped in` });
  } else {
    state = await record(plan, deps, state, { phase: "rolling-back", reason });
  }
  const failed = join(plan.stateDir, "backups", `failed-${plan.intentId}.app`);
  if (deps.exists(plan.appPath)) await deps.move(plan.appPath, failed);
  const copied = await deps.exec("/usr/bin/ditto", [backup, plan.appPath], 900_000);
  const restored = copied.code === 0 ? await verifyBundle(plan.appPath, fromVersion, deps, { gatekeeper: false }) : `ditto failed: ${copied.stderr.trim()}`;
  if (restored !== null) return record(plan, deps, state, { phase: "rollback-failed", reason: `${reason}; restoring ${backup} failed (${restored}). The failed bundle is at ${failed}; bb was not relaunched.` });
  const proved = await launchAndProve(plan, deps, fromVersion);
  return record(plan, deps, state, proved ? { phase: "rolled-back", reason, failedBundle: failed } : { phase: "rollback-failed", reason: `${reason}; bb ${fromVersion} was restored but did not reconnect` });
}

async function snapshotDatabase(plan, deps) {
  if (!plan.databasePath || !deps.exists(plan.databasePath)) return null;
  const size = await deps.exec("/usr/bin/stat", ["-f", "%z", plan.databasePath]);
  const bytes = Number(size.stdout.trim());
  if (size.code !== 0 || !Number.isFinite(bytes) || bytes > (plan.databaseSnapshotMaxBytes ?? 8 * 1024 ** 3)) return { path: null, reason: "skipped: database size unknown or above the snapshot limit" };
  const dest = join(plan.stateDir, "database", `bb-${plan.fromVersion}-${plan.intentId}.db`);
  await deps.mkdir(dirname(dest));
  const result = await deps.exec("/usr/bin/sqlite3", [plan.databasePath, `.backup '${dest.replace(/'/g, "''")}'`], 900_000);
  return result.code === 0 ? { path: dest, bytes, restore: "manual only: the helper never restores a database automatically" } : { path: null, reason: `snapshot failed: ${result.stderr.trim().split("\n")[0]}` };
}

async function prepareOfficial(plan, deps, version) {
  const urls = releaseUrls(version);
  const dir = join(plan.stateDir, "downloads", version);
  const manifestPath = join(dir, "latest-mac.yml");
  const zipPath = join(dir, urls.fileName);
  await deps.download(urls.manifest, manifestPath);
  const expected = parseLatestMacYml(await deps.readText(manifestPath), urls.fileName);
  if (!deps.exists(zipPath) || (await deps.sha512(zipPath)) !== expected.sha512) await deps.download(urls.zip, zipPath);
  if ((await deps.sha512(zipPath)) !== expected.sha512) throw new Error("The release zip does not match the sha512 the vendor published for that exact tag");
  const staged = join(plan.stateDir, "staged", version);
  const app = join(staged, "bb.app");
  if (!deps.exists(app)) {
    await deps.mkdir(staged);
    const unpacked = await deps.exec("/usr/bin/ditto", ["-x", "-k", zipPath, staged], 600_000);
    if (unpacked.code !== 0) throw new Error(`Unpacking failed: ${unpacked.stderr.trim()}`);
  }
  const problem = await verifyBundle(app, version, deps);
  if (problem) throw new Error(`Official package refused: ${problem}`);
  await deps.exec("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app]);
  return { app, sha512: expected.sha512, url: urls.zip };
}

async function vendorStaged(plan, deps, version) {
  const statePath = join(plan.home, "Library", "Caches", `${BUNDLE_ID}.ShipIt`, "ShipItState.plist");
  if (!deps.exists(statePath)) return null;
  const json = await deps.exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", statePath]);
  if (json.code !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(json.stdout); } catch { return null; }
  if (parsed.bundleIdentifier !== BUNDLE_ID || typeof parsed.updateBundleURL !== "string" || parsed.targetBundleURL !== pathToFileURL(`${plan.appPath}/`).href) return null;
  const bundle = fileURLToPath(parsed.updateBundleURL).replace(/\/$/, "");
  const problem = await verifyBundle(bundle, version, deps, { gatekeeper: false });
  return problem ? null : { app: bundle };
}

export async function run(plan, deps = defaultDeps()) {
  if (!INTENT_RE.test(plan.intentId)) throw new Error("Invalid intent id");
  if (!VERSION_RE.test(plan.targetVersion) || !VERSION_RE.test(plan.fromVersion)) throw new Error("Versions must be exact x.y.z");
  if (!["native", "bootstrap", "rollback"].includes(plan.mode)) throw new Error("Mode must be native, bootstrap or rollback");
  if (plan.quitMode !== undefined && !["signal", "apple-event"].includes(plan.quitMode)) throw new Error("quitMode must be signal or apple-event");
  const lock = await deps.lock(join(plan.stateDir, "host.lock.d"), { intentId: plan.intentId, mode: plan.mode, startedAt: deps.now() });
  if (!lock.acquired) {
    const existing = await readIntent(plan, deps);
    const where = join(plan.stateDir, "host.lock.d");
    const why = lock.reason === "stale" ? `a stopped helper for intent ${lock.holder?.intentId} still holds the host lock; check its intent file, then remove ${where} by hand` : lock.reason === "unreadable" ? `the host lock at ${where} has no readable holder; it was left in place` : `another update helper is running on this host${lock.holder?.intentId ? ` (intent ${lock.holder.intentId})` : ""}`;
    return { v: 1, intentId: plan.intentId, phase: "busy", reason: `${why}; nothing was changed`, current: existing };
  }
  try { return await runLocked(plan, deps); }
  finally { await lock.release(); }
}

async function runLocked(plan, deps) {
  const existing = await readIntent(plan, deps);
  if (existing && (existing.fromVersion !== plan.fromVersion || existing.targetVersion !== plan.targetVersion || existing.mode !== plan.mode)) {
    return { v: 1, intentId: plan.intentId, phase: "conflict", reason: "This intent id was already used for another update; nothing was changed", current: existing };
  }
  if (existing && TERMINAL.has(existing.phase)) return existing;
  let state = existing ?? { v: 1, intentId: plan.intentId, mode: plan.mode, fromVersion: plan.fromVersion, targetVersion: plan.targetVersion, appPath: plan.appPath, phase: "planned", createdAt: deps.now(), history: [] };
  if (existing && existing.phase !== "planned") {
    const current = await plistVersion(plan.appPath, deps);
    const status = await appStatus(plan, deps);
    if (current === plan.targetVersion && status?.current?.version === plan.targetVersion) return record(plan, deps, state, { phase: "updated", reason: "Reconciled after the helper was interrupted" });
    return record(plan, deps, state, { phase: "failed", reason: `The helper was interrupted at ${existing.phase}; bb is ${current ?? "unknown"}. Nothing was retried automatically.` });
  }
  if (deps.platform !== "darwin") return record(plan, deps, state, { phase: "refused", reason: "Desktop updates through this helper are macOS only; other hosts use bb updates app apply" });
  const installed = await plistVersion(plan.appPath, deps);
  if (installed !== plan.fromVersion) return record(plan, deps, state, { phase: "refused", reason: `bb is ${installed ?? "unreadable"}, not the expected ${plan.fromVersion}` });
  const gui = await deps.exec("/bin/launchctl", ["print", `gui/${deps.uid}`]);
  if (gui.code !== 0) return record(plan, deps, state, { phase: "refused", reason: "No logged-in GUI session; bb could not be relaunched after a restart or rollback" });
  state = await record(plan, deps, state, { phase: "draining" });
  const idle = await drain(plan, deps, state);
  if (idle.phase === "refused") return idle;
  let backup;
  try { backup = await backupApp(plan, deps, plan.fromVersion); }
  catch (cause) { return record(plan, deps, state, { phase: "refused", reason: String(cause?.message ?? cause) }); }
  const snapshot = await snapshotDatabase(plan, deps);
  state = await record(plan, deps, state, { phase: "backed-up", backup, databaseSnapshot: snapshot });

  if (plan.mode === "native") {
    const exact = idle.experimental_exactApply === true;
    if (idle.available?.version !== plan.targetVersion) return record(plan, deps, state, { phase: "refused", reason: `bb ${idle.available?.version ?? "none"} is available, not ${plan.targetVersion}` });
    if (idle.desktopUpdateSupported !== true && idle.support?.kind !== "supported") return record(plan, deps, state, { phase: "refused", reason: "This server cannot apply its own update; use bootstrap" });
    if (!exact) return record(plan, deps, state, { phase: "refused", reason: "This server cannot pin the update to an exact version (no experimental_exactApply); use bootstrap with the exact official tag instead" });
    const args = ["updates", "app", "apply", "--no-wait", "--json", ...(exact ? ["--expect-version", plan.targetVersion, "--request-id", plan.intentId] : [])];
    const gate = await drainSafe(plan, deps);
    if (!gate.ok) return record(plan, deps, state, { phase: "refused", reason: `${gate.reason}; bb was not asked to update` });
    state = await record(plan, deps, state, { phase: "applying", exact, drain: gate.reason ?? "safe" });
    const applied = await bbCli(plan, deps, args, 300_000);
    if (applied.code !== 0) return record(plan, deps, state, { phase: "failed", reason: `bb refused the update: ${(applied.stderr || applied.stdout).trim().split("\n")[0]}` });
    state = await record(plan, deps, state, { phase: "restarting" });
    const proved = await waitFor(deps, plan.reconnectTimeoutMs ?? 1_200_000, async () => {
      const status = await appStatus(plan, deps);
      return status?.current?.version === plan.targetVersion && (!exact || status.lastResult?.id === plan.intentId) ? status : null;
    }, 10_000);
    if (proved) return record(plan, deps, state, { phase: "updated", proof: { version: proved.current.version, resultId: proved.lastResult?.id ?? null } });
    const now = await appStatus(plan, deps);
    if (now?.current?.version === plan.fromVersion) return record(plan, deps, state, { phase: "failed", reason: "bb came back on the old version; nothing was swapped" });
    return rollbackTo(plan, deps, state, backup, plan.fromVersion, `bb ${plan.targetVersion} did not reconnect`);
  }

  let candidate = null;
  let fallback = null;
  try {
    if (plan.mode === "rollback") {
      const problem = await verifyBundle(plan.backupPath, plan.targetVersion, deps, { gatekeeper: false });
      if (problem) return record(plan, deps, state, { phase: "refused", reason: `Backup refused: ${problem}` });
      candidate = { app: plan.backupPath, source: "backup" };
    } else {
      const staged = plan.allowVendorStaged === false || plan.quitMode === "signal" ? null : await vendorStaged(plan, deps, plan.targetVersion);
      if (staged) candidate = { ...staged, source: "vendor-shipit" };
      if (!staged || plan.prepareFallback !== false) {
        const official = await prepareOfficial(plan, deps, plan.targetVersion);
        if (candidate) fallback = { ...official, source: "official-release" }; else candidate = { ...official, source: "official-release" };
      }
    }
  } catch (cause) {
    if (!candidate) return record(plan, deps, state, { phase: "refused", reason: String(cause?.message ?? cause) });
  }
  state = await record(plan, deps, state, { phase: "verified", source: candidate.source, ...(fallback ? { fallback: fallback.source } : {}) });
  const recheck = await appStatus(plan, deps);
  if (recheck === null || recheck.runningThreadCount !== 0) return record(plan, deps, state, { phase: "refused", reason: recheck === null ? "bb did not answer the final idle check; nothing was restarted" : "A thread started while the update was verified; nothing was restarted" });
  const gate = await drainSafe(plan, deps);
  if (!gate.ok) return record(plan, deps, state, { phase: "refused", reason: `${gate.reason}; nothing was stopped` });
  state = await record(plan, deps, state, { phase: "quitting", drain: gate.reason ?? "safe" });
  const quit = await quitApp(plan, deps);
  if (!quit.quit) return record(plan, deps, state, { phase: "failed", reason: `bb did not fully stop (signalled ${quit.signalled?.join(", ") || "none"}); nothing was installed`, signalled: quit.signalled ?? [] });
  const shipItDone = await waitFor(deps, plan.shipItTimeoutMs ?? 120_000, async () => ((await bbShipItRunning(plan, deps)) === false ? "stopped" : null));
  if (shipItDone !== "stopped") return record(plan, deps, state, { phase: "install-held", reason: "bb's vendor installer (its own ShipIt) is still running or could not be checked, so /Applications/bb.app was not touched. bb is stopped. Check ShipIt has finished, then open bb; start a new intent to update again." });
  const afterQuit = await plistVersion(plan.appPath, deps);
  state = await record(plan, deps, state, { phase: "installing", quitVia: quit.via, versionAfterQuit: afterQuit });
  let installedVersion = candidate.source === "vendor-shipit" && afterQuit === plan.targetVersion ? plan.targetVersion : null;
  if (candidate.source === "vendor-shipit" && !installedVersion) {
    installedVersion = await waitFor(deps, plan.shipItTimeoutMs ?? 120_000, async () => ((await plistVersion(plan.appPath, deps)) === plan.targetVersion ? plan.targetVersion : null));
    if (!installedVersion && fallback) candidate = fallback;
  }
  if (!installedVersion) {
    if (candidate.source === "vendor-shipit") {
      await deps.exec("/usr/bin/open", [plan.appPath]);
      return record(plan, deps, state, { phase: "failed", reason: "The vendor's staged update did not install on quit; bb was relaunched unchanged" });
    }
    const displaced = join(plan.stateDir, "backups", `displaced-${plan.intentId}.app`);
    if (deps.exists(plan.appPath)) await deps.move(plan.appPath, displaced);
    const copied = await deps.exec("/usr/bin/ditto", [candidate.app, plan.appPath], 900_000);
    if (copied.code !== 0) {
      const partial = join(plan.stateDir, "backups", `partial-${plan.intentId}.app`);
      if (deps.exists(plan.appPath)) await deps.move(plan.appPath, partial);
      if (deps.exists(displaced)) await deps.move(displaced, plan.appPath);
      const previous = afterQuit ?? plan.fromVersion;
      const back = await verifyBundle(plan.appPath, previous, deps, { gatekeeper: false });
      if (back !== null) return record(plan, deps, state, { phase: "rollback-failed", reason: `Copying the verified bundle failed and the previous bb could not be put back (${back}); the backup ${backup} is kept. bb was not relaunched.` });
      const proved = await launchAndProve(plan, deps, previous);
      return record(plan, deps, state, { phase: "failed", reason: `Copying the verified bundle failed (${copied.stderr.trim()}); the partial copy is at ${partial}. ${proved ? `bb ${previous} was put back and reconnected.` : `bb ${previous} was put back but did not reconnect.`}` });
    }
    const problem = await verifyBundle(plan.appPath, plan.targetVersion, deps, { gatekeeper: false });
    if (problem) return rollbackTo(plan, deps, state, backup, plan.fromVersion, `Installed bundle failed verification: ${problem}`);
  }
  state = await record(plan, deps, state, { phase: "relaunching", installedFrom: candidate.source });
  const proved = await launchAndProve(plan, deps, plan.targetVersion);
  if (proved) return record(plan, deps, state, { phase: "updated", proof: { version: proved.current.version } });
  return rollbackTo(plan, deps, state, backup, plan.fromVersion, `bb ${plan.targetVersion} did not reconnect`);
}

export function defaultPlan(input) {
  const home = input.home ?? homedir();
  return {
    appPath: "/Applications/bb.app",
    bbCli: "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb",
    nodeBin: process.execPath,
    databasePath: join(home, ".bb", "bb.db"),
    stateDir: join(home, "Library", "Application Support", "bb-fleet-updates"),
    home,
    ...input,
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const [mode, planFile] = process.argv.slice(2);
  const raw = JSON.parse(await readFile(planFile, "utf8"));
  const plan = defaultPlan({ ...raw, mode: mode === "status" ? raw.mode : mode });
  const result = mode === "status" ? await readIntent(plan, defaultDeps()) : await run(plan);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

#!/usr/bin/env node
// F10 live acceptance: unavailable-model refusal before spawn, and Auto placement.
//
// Drives the INSTALLED Fleet plugin through `bb plugin rpc call fleet ...` on this
// Mac. It never installs, restarts or edits anything. Remote reads on studio use the
// existing `studio` SSH alias and the read-only `bb thread` / `bb plugin rpc` commands.
//
//   node fleet/acceptance/f10-placement.mjs            cases (a) and (b)
//   node fleet/acceptance/f10-placement.mjs --with-f14 also case (c): CPU load on studio, Auto must choose laptop
//
// Environment overrides: F10_PROJECT (default "Native Fleet acceptance"),
// F10_MODEL (a valid Codex model on both Macs, default gpt-6.1-sol),
// F10_REASONING (default high), F10_OUT (default /tmp/f10-placement).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const OUT = process.env.F10_OUT ?? "/tmp/f10-placement";
const PROJECT = process.env.F10_PROJECT ?? "Native Fleet acceptance";
const VALID_MODEL = process.env.F10_MODEL ?? "gpt-6.1-sol";
const REASONING = process.env.F10_REASONING ?? "high";
const MISSING_MODEL = "gpt-missing";
const WITH_F14 = process.argv.includes("--with-f14");
const REMOTE_PATH = "export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";
mkdirSync(OUT, { recursive: true });

const log = [];
let inputSeq = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function run(bin, args, { timeoutMs = 120_000 } = {}) {
  const command = [bin, ...args].map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : quote(part))).join(" ");
  const started = Date.now();
  try {
    const stdout = execFileSync(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    log.push({ command, exit: 0, ms: Date.now() - started });
    return { exit: 0, stdout, stderr: "" };
  } catch (error) {
    const stdout = String(error.stdout ?? ""); const stderr = String(error.stderr ?? error.message ?? "");
    log.push({ command, exit: error.status ?? null, ms: Date.now() - started, stderr: stderr.slice(0, 2000) });
    return { exit: error.status ?? 1, stdout, stderr };
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Call a Fleet RPC on this Mac's installed Fleet; returns {ok, result} or {ok:false, error}. */
function rpc(method, input) {
  const file = join(OUT, `input-${String(++inputSeq).padStart(2, "0")}-${method}.json`);
  writeFileSync(file, JSON.stringify(input, null, 2));
  const out = run("bb", ["plugin", "rpc", "call", "fleet", method, "--input-file", file, "--json"]);
  const parsed = parseJson(out.stdout);
  if (out.exit === 0 && parsed !== undefined && !(parsed && parsed.ok === false && parsed.error)) return { ok: true, result: parsed, inputFile: file };
  const text = parsed?.error?.message ?? (out.stdout.trim() || out.stderr.trim());
  return { ok: false, error: text, exit: out.exit, raw: parsed ?? out.stdout.trim(), stderr: out.stderr.trim().slice(0, 2000), inputFile: file };
}

let localMachine = null;
/** Run a read-only bb command on a machine: locally, or on studio through the existing studio SSH alias. */
function bbOn(machine, args, opts) {
  if (machine === localMachine) return run("bb", args, opts);
  if (machine === "studio") return run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "studio", `${REMOTE_PATH}; bb ${args.map(quote).join(" ")}`], opts);
  throw new Error(`No read route from ${localMachine} to ${machine} in this acceptance script`);
}

function threadIdsOn(machine, projectId) {
  const out = bbOn(machine, ["thread", "list", "--include-hidden", "--json", ...(projectId ? ["--project", projectId] : [])]);
  const list = parseJson(out.stdout);
  if (!Array.isArray(list)) throw new Error(`Could not list threads on ${machine}: ${out.stderr || out.stdout.slice(0, 500)}`);
  return list.map((thread) => thread.id);
}

function ownerSnapshot(machine) {
  const out = bbOn(machine, ["plugin", "rpc", "call", "fleet", "snapshot_get", "--json"]);
  const snapshot = parseJson(out.stdout);
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.threads)) throw new Error(`Could not read ${machine}'s Fleet snapshot: ${out.stderr || out.stdout.slice(0, 500)}`);
  return snapshot;
}

function commandOutcome(started) {
  // A broker route returns a durable command, not execution; resolve it read-only.
  if (started.outcome !== "sent" || !started.commandId) return Promise.resolve(started);
  return (async () => {
    for (let i = 0; i < 40; i += 1) {
      const status = rpc("command_get", { commandId: started.commandId });
      if (status.ok && ["started", "failed", "unknown"].includes(status.result.status)) return { ...started, command: status.result, threadId: status.result.threadId, error: status.result.error };
      await sleep(3_000);
    }
    return { ...started, command: null };
  })();
}

const proof = { item: "F10", startedAt: new Date().toISOString(), project: PROJECT, cases: {}, commands: log };
let failed = false;
function settle(name, record) {
  proof.cases[name] = record;
  if (record.pass === false) failed = true;
  console.log(`${name}: ${record.pass === true ? "PASS" : record.pass === false ? "FAIL" : "SKIPPED"}${record.why ? ` (${record.why})` : ""}`);
}

async function caseA() {
  const expected = `Model ${MISSING_MODEL} is not available for codex on studio`;
  // The refused start targets the acceptance project, so its native thread count is the
  // no-spawn measure; the host-wide id diff also proves no new thread appeared anywhere.
  // (Host-wide counts alone move when other agents archive or delete their own threads.)
  const projectId = ownerSnapshot("studio").projects?.find((project) => project.name === PROJECT)?.id;
  if (!projectId) throw new Error(`${PROJECT} does not exist on studio`);
  const beforeProject = threadIdsOn("studio", projectId);
  const before = threadIdsOn("studio");
  const requestId = randomUUID();
  const input = { machine: "studio", prompt: "F10 acceptance (a). This start must be refused before any spawn.", title: "F10 refusal acceptance (must not exist)", providerId: "codex", model: MISSING_MODEL, reasoningLevel: REASONING, projectName: PROJECT, requestId };
  const preview = rpc("route_preview", { machine: "studio", providerId: "codex", model: MISSING_MODEL, reasoningLevel: REASONING, projectName: PROJECT });
  let response = rpc("work_start", input);
  let rejection = response.ok ? null : response.error;
  if (response.ok) {
    const resolved = await commandOutcome(response.result);
    response = { ...response, resolved };
    if (resolved.command?.status === "failed") rejection = resolved.command.error;
  }
  await sleep(5_000);
  const afterProject = threadIdsOn("studio", projectId);
  const after = threadIdsOn("studio");
  const added = after.filter((id) => !before.includes(id));
  const receipt = rpc("work_receipt", { requestId });
  const refused = typeof rejection === "string" && rejection.includes(expected);
  const noSpawn = beforeProject.length === afterProject.length && added.length === 0;
  settle("a", {
    pass: refused && noSpawn,
    why: !refused ? `expected rejection text not found: ${rejection ?? "work_start succeeded"}` : !noSpawn ? `studio acceptance-project thread count changed ${beforeProject.length} -> ${afterProject.length}; new host threads ${added.join(", ") || "none"}` : undefined,
    request: input, requestId, routePreview: preview.ok ? preview.result : preview,
    rejection, expectedText: expected, response: response.ok ? response.result : response.raw,
    receipt: receipt.ok ? receipt.result : receipt,
    studioThreadCount: { projectId, before: beforeProject.length, after: afterProject.length, hostWide: { before: before.length, after: after.length }, newThreadIds: added },
  });
}

async function verifyThread(machine, threadId, hostId) {
  const shown = parseJson(bbOn(machine, ["thread", "show", threadId, "--json"]).stdout);
  let entry = null;
  for (let i = 0; i < 20 && !(entry?.model && entry?.reasoningLevel); i += 1) {
    if (i > 0) await sleep(3_000);
    entry = ownerSnapshot(machine).threads.find((thread) => thread.id === threadId) ?? null;
  }
  return {
    thread: shown?.thread ? { id: shown.thread.id, providerId: shown.thread.providerId, projectId: shown.thread.projectId, status: shown.thread.status, title: shown.thread.title } : null,
    environmentHostId: shown?.environment?.hostId ?? null,
    routeHostId: hostId,
    ownerSnapshotEntry: entry ? { id: entry.id, providerId: entry.providerId, model: entry.model, reasoningLevel: entry.reasoningLevel, projectName: entry.projectName, state: entry.state } : null,
  };
}

async function caseB() {
  const requestId = randomUUID();
  const selection = { providerId: "codex", model: VALID_MODEL, reasoningLevel: REASONING };
  const preview = rpc("route_preview", { machine: "auto", ...selection, projectName: PROJECT });
  const input = { machine: "auto", prompt: "F10 Auto placement acceptance. Reply with the single word ok. Do not run tools or change files.", title: "F10 Auto placement acceptance", ...selection, projectName: PROJECT, requestId };
  const response = rpc("work_start", input);
  if (!response.ok) {
    settle("b", { pass: false, why: `Auto start was refused: ${response.error}`, request: input, routePreview: preview.ok ? preview.result : preview, response: response.raw });
    return;
  }
  const receipt = await commandOutcome(response.result);
  const machine = receipt.route?.machine ?? null;
  const threadId = receipt.threadId ?? null;
  if (!["studio", "laptop"].includes(machine) || !threadId) {
    settle("b", { pass: false, why: `no started thread on studio/laptop (machine ${machine}, thread ${threadId})`, request: input, routePreview: preview.ok ? preview.result : preview, receipt });
    return;
  }
  const native = await verifyThread(machine, threadId, receipt.route.hostId ?? null);
  const e = native.ownerSnapshotEntry;
  const matches = native.thread?.providerId === "codex" && e?.providerId === "codex" && e?.model === VALID_MODEL && e?.reasoningLevel === REASONING && (!native.environmentHostId || !receipt.route.hostId || native.environmentHostId === receipt.route.hostId);
  settle("b", { pass: matches, why: matches ? undefined : "native thread does not match the requested provider/model/reasoning", request: input, routePreview: preview.ok ? preview.result : preview, receipt, native });
}

async function caseC() {
  const studio = ownerSnapshot("studio");
  const workers = Math.max(2, (studio.resources?.cpuCount ?? 10) + 2);
  const seconds = 90;
  // Each worker is a self-bounded busy loop, so the load ends even if this script dies.
  const load = `for i in $(seq 1 ${workers}); do perl -e 'my $e=time+${seconds}; 1 while time<$e' & done; wait`;
  const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "studio", load], { stdio: "ignore" });
  const startedAt = Date.now();
  log.push({ command: `ssh studio ${quote(load)}`, background: true });
  const selection = { providerId: "codex", model: VALID_MODEL, reasoningLevel: REASONING };
  const samples = [];
  let chosen = null;
  try {
    await sleep(20_000);
    while (Date.now() - startedAt < (seconds - 10) * 1000) {
      const preview = rpc("route_preview", { machine: "auto", ...selection });
      const board = rpc("board_get", null);
      const studioColumn = board.ok ? board.result.columns.find((column) => column.key === "studio") : null;
      const laptopColumn = board.ok ? board.result.columns.find((column) => column.key === "laptop") : null;
      samples.push({ at: new Date().toISOString(), preview: preview.ok ? preview.result : preview, studioResources: studioColumn?.resources ?? null, laptopResources: laptopColumn?.resources ?? null });
      const studioBusy = (studioColumn?.resources?.cpuUtilization ?? 0) >= 0.9;
      if (preview.ok && studioBusy) { chosen = preview.result; break; }
      await sleep(8_000);
    }
  } finally {
    child.kill("SIGTERM");
  }
  const pass = chosen?.machine === "laptop";
  settle("c", { pass, why: pass ? undefined : chosen ? `Auto chose ${chosen.machine} under studio load: ${chosen.reason}` : "studio load was never observed as busy", load: { workers, seconds, project: "none (the acceptance project exists only on studio, so Auto could never choose laptop with it)" }, decision: chosen, samples });
}

async function main() {
  const me = rpc("board_get", null);
  if (!me.ok) throw new Error(`Installed Fleet is not reachable: ${me.error}`);
  localMachine = me.result.me.machineKey;
  proof.localMachine = localMachine;
  proof.transport = me.result.transport ?? null;
  await caseA();
  await caseB();
  if (WITH_F14) await caseC();
  else settle("c", { pass: null, why: "not run (pass --with-f14)" });
}

try { await main(); }
catch (error) { failed = true; proof.error = error instanceof Error ? error.message : String(error); console.error(proof.error); }
proof.finishedAt = new Date().toISOString();
proof.pass = !failed;
writeFileSync(join(OUT, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
console.log(`proof: ${join(OUT, "proof.json")}`);
process.exit(failed ? 1 : 0);

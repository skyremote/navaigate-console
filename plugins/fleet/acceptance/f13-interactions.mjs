#!/usr/bin/env node
// F13 live acceptance: one client (laptop) answers a real native provider question
// raised by a thread that runs on studio, through mirror-interactions-v1.
//
// Run on laptop:  node fleet/acceptance/f13-interactions.mjs
// Writes:     /tmp/f13-interactions/proof.json (exit 0 only when every criterion holds)
//
// Every mutation goes through laptop's own Fleet (`bb plugin rpc call fleet ...`):
// work_start, mirror_open, interaction_respond. The studio owner is only read
// (thread_target_get, thread_events_get, thread_answer_get, snapshot_get) over
// the existing `studio` SSH alias with the same fixed command Fleet itself uses.
// Nothing is installed, restarted or deleted. The studio thread and the laptop mirror
// copy are left in place as evidence.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = process.env.F13_OUT_DIR ?? "/tmp/f13-interactions";
const BB = process.env.BB_CLI ?? "bb";
const STUDIO_ALIAS = process.env.F13_STUDIO_ALIAS ?? "studio";
const studio_BB_CLI = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb";
const studio_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const FEATURE = "mirror-interactions-v1";
const APPEAR_LIMIT_MS = 120_000;
const TURN_LIMIT_MS = Number(process.env.F13_TURN_LIMIT_MS ?? 6 * 60_000);
const MIRROR_LIMIT_MS = Number(process.env.F13_MIRROR_LIMIT_MS ?? 120_000);
const CHOICE = "Blue";
const EXPECTED_LINE = `F13-ANSWER: ${CHOICE}`;
const PROMPT = [
  "This is an automated Fleet acceptance check (F13). It needs no files, no repository and no research.",
  "Call the AskUserQuestion tool exactly once, with exactly one question:",
  "header \"F13\", question \"Which colour should the F13 check record?\", single select, with exactly two options labelled \"Red\" and \"Blue\".",
  "Do not call any other tool at any point.",
  "When the answer arrives, reply with exactly one line and nothing else: F13-ANSWER: <the label of the chosen option>",
].join("\n");

mkdirSync(OUT_DIR, { recursive: true });
const startedAt = Date.now();
const log = [];
const proof = {
  item: "F13", clickUp: "123nafj55z4", startedAt: new Date(startedAt).toISOString(), finishedAt: null,
  features: {}, fleetCommits: {}, start: null, ownerTarget: null, mirror: {}, interaction: null,
  respond: {}, owner: {}, criteria: {}, passed: false, error: null, log,
};
const note = (line) => { const entry = `${new Date().toISOString()} ${line}`; log.push(entry); process.stdout.write(`${entry}\n`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = () => writeFileSync(join(OUT_DIR, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);

function run(file, args, input, timeout = 60_000) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input === undefined ? "" : input);
  });
}
function envelope(label, { error, stdout, stderr }) {
  let body;
  try { body = JSON.parse(stdout); } catch { throw new Error(`${label}: no JSON (${(stderr || error?.message || stdout).trim().slice(0, 400)})`); }
  if (body && typeof body === "object" && body.ok === false) throw new Error(`${label}: ${body.error?.code ?? "error"}: ${body.error?.message ?? "refused"}`);
  return body && typeof body === "object" && body.ok === true && "result" in body ? body.result : body;
}
/** laptop's own Fleet, through the bb CLI with server-side schema validation. */
async function laptop(method, input) {
  return envelope(`laptop fleet.${method}`, await run(BB, ["plugin", "rpc", "call", "fleet", method, "--input-file", "/dev/stdin", "--json"], JSON.stringify(input ?? null)));
}
/** Idempotent calls only (reads, mirror_open reuse): retry transient route errors such as EAGAIN. */
async function retry(label, call, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await call(); }
    catch (cause) {
      if (attempt >= attempts || !/EAGAIN|temporarily|timed out|ECONNRESET|unavailable/i.test(String(cause?.message ?? cause))) throw cause;
      note(`${label}: transient failure, retry ${attempt}: ${String(cause?.message ?? cause).slice(0, 160)}`);
      await sleep(2_000 * attempt);
    }
  }
}
/** laptop bb CLI (read-only thread inspection of the local mirror copy). */
async function laptopcli(args) {
  return envelope(`laptop bb ${args.join(" ")}`, await run(BB, [...args, "--json"]));
}
/** A read-only owner method on studio's Fleet over the existing SSH alias. */
async function studio(method, input) {
  return retry(`studio fleet.${method}`, () => studioonce(method, input));
}
async function studioonce(method, input) {
  const command = `PATH='${studio_PATH}' '${studio_BB_CLI}' plugin rpc call 'fleet' '${method}' --input-file /dev/stdin --json`;
  return envelope(`studio fleet.${method}`, await run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", STUDIO_ALIAS, command], JSON.stringify(input ?? null)));
}
async function studioshell(command) {
  const result = await run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", STUDIO_ALIAS, `PATH='${studio_PATH}'; ${command}`]);
  return result.stdout.trim();
}
async function laptopshell(file, args) { return (await run(file, args)).stdout.trim(); }

/** Every owner event of the given types, oldest first. */
async function ownerEvents(threadId, types) {
  const all = [];
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const rows = await studio("thread_events_get", { threadId, afterSeq: String(after), order: "asc", limit: "100", ...(types ? { types } : {}) });
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    after = rows.at(-1).seq;
    if (rows.length < 100) break;
  }
  return all;
}
const lifecycleOf = (event) => event?.data?.interaction ?? null;
const flipHex = (value) => value.slice(0, -1) + (value.at(-1) === "0" ? "1" : "0");

async function main() {
  // (0) Both ends advertise mirror-interactions-v1, and record which Fleet each runs.
  const laptopSnap = await laptop("snapshot_get", null);
  const studioSnap = await studio("snapshot_get", null);
  proof.features = {
    laptop: { serverId: laptopSnap.serverId, machineKey: laptopSnap.machineKey, appVersion: laptopSnap.appVersion, features: laptopSnap.features, advertises: (laptopSnap.features ?? []).includes(FEATURE) },
    studio: { serverId: studioSnap.serverId, machineKey: studioSnap.machineKey, appVersion: studioSnap.appVersion, features: studioSnap.features, advertises: (studioSnap.features ?? []).includes(FEATURE) },
  };
  const pluginRoot = (list) => (list?.plugins ?? []).find((plugin) => plugin.id === "fleet")?.rootDir ?? null;
  const laptopRoot = pluginRoot(await laptopcli(["plugin", "list"]).catch(() => null));
  const studioRoot = pluginRoot(JSON.parse(await studioshell(`'${studio_BB_CLI}' plugin list --json`).catch(() => "null") || "null"));
  proof.fleetCommits = {
    laptop: { rootDir: laptopRoot, head: laptopRoot ? await laptopshell("git", ["-C", laptopRoot, "log", "-1", "--format=%h %s"]) : null },
    studio: { rootDir: studioRoot, head: studioRoot ? await studioshell(`git -C '${studioRoot}' log -1 --format='%h %s'`) : null },
  };
  note(`features laptop=${proof.features.laptop.advertises} studio=${proof.features.studio.advertises}; Fleet laptop ${proof.fleetCommits.laptop.head} / studio ${proof.fleetCommits.studio.head}`);
  if (!proof.features.laptop.advertises || !proof.features.studio.advertises) throw new Error(`${FEATURE} is not advertised on both Macs`);

  // (1) Start the studio thread from laptop.
  const personal = (studioSnap.projects ?? []).find((project) => project.id === "proj_personal" || project.name === "Personal");
  const projectId = process.env.F13_PROJECT_ID ?? personal?.id;
  if (!projectId) throw new Error("No destination project on studio");
  const requestId = `f13ix-${startedAt.toString(36)}-${randomUUID().slice(0, 8)}`;
  const t0 = Date.now();
  const started = await laptop("work_start", { machine: "studio", providerId: "claude-code", prompt: PROMPT, title: "F13 mirror interaction acceptance", requestId, projectId });
  proof.start = { requestId, projectId, result: started, at: new Date(t0).toISOString() };
  if (started.outcome !== "started" || !started.threadId) throw new Error(`work_start did not start an owner thread: ${JSON.stringify(started)}`);
  const threadId = started.threadId;
  note(`work_start -> studio thread ${threadId} (${started.url})`);
  save();

  // The owner thread's exact workspace target, read on the owner.
  const target = await studio("thread_target_get", { threadId });
  proof.ownerTarget = target;
  if (target.serverId !== studioSnap.serverId || target.threadId !== threadId) throw new Error("Owner target does not match the started thread");

  // Open the laptop mirror copy before the question exists, so it raises the prompt.
  const opened = await retry("laptop mirror_open", () => laptop("mirror_open", { machine: "studio", threadId }));
  proof.mirror.localThreadId = opened.localThreadId;
  note(`laptop mirror copy ${opened.localThreadId}`);

  // (2) Poll laptop interaction_list until the owner question appears.
  let listed = null;
  let polls = 0;
  while (Date.now() - t0 < APPEAR_LIMIT_MS) {
    polls += 1;
    const page = await retry("laptop interaction_list", () => laptop("interaction_list", { target }));
    if (page.interactions?.length) { listed = page; break; }
    await sleep(2_000);
  }
  if (!listed) throw new Error(`No owner interaction appeared in laptop interaction_list within ${APPEAR_LIMIT_MS / 1000} s (${polls} polls)`);
  const item = listed.interactions[0];
  const appearedAfterMs = Date.now() - t0;
  proof.interaction = { id: item.id, kind: item.kind, fingerprint: item.fingerprint, turnId: item.turnId, createdAt: item.createdAt, payload: item.payload, listedOwner: listed.owner, appearedAfterMs, polls, listedCount: listed.interactions.length };
  note(`interaction ${item.id} (${item.kind}) listed on laptop after ${appearedAfterMs} ms`);
  save();

  // Evidence only: the laptop copy raises the owner prompt as its own native pending prompt.
  const beforeStart = Date.now();
  proof.mirror.beforeAnswer = null;
  while (Date.now() - beforeStart < 45_000) {
    const list = await laptopcli(["thread", "interactions", "list", opened.localThreadId]).catch(() => []);
    const mine = (Array.isArray(list) ? list : []).filter((entry) => String(entry.providerRequestId ?? "").endsWith(`fleet-ix:${item.id}`));
    if (mine.length) { proof.mirror.beforeAnswer = { seenAfterMs: Date.now() - t0, prompts: mine.map((entry) => ({ id: entry.id, status: entry.status, providerRequestId: entry.providerRequestId })) }; break; }
    await sleep(3_000);
  }
  note(`laptop copy prompt before answer: ${JSON.stringify(proof.mirror.beforeAnswer?.prompts ?? null)}`);

  // (3) Answer it exactly once, from the listed payload.
  let response;
  if (item.kind === "user_question") {
    const questions = item.payload.questions ?? [];
    const answers = {};
    for (const question of questions) {
      const options = question.options ?? [];
      const chosen = options.find((option) => String(option.label ?? option.value).trim().toLowerCase() === CHOICE.toLowerCase()) ?? options[0];
      if (!chosen) throw new Error(`Question ${question.id} has no options to choose`);
      answers[question.id] = { selected: [chosen.value] };
    }
    response = { kind: "user_answer", answers };
  } else if (item.kind === "approval") {
    response = { kind: "approval", decision: (item.payload.availableDecisions ?? []).includes("allow_once") ? "allow_once" : "deny" };
  } else throw new Error(`Unexpected interaction kind ${item.kind}`);
  const respondInput = { target, requestId: randomUUID(), interactionId: item.id, expectedFingerprint: item.fingerprint, response };
  const first = await laptop("interaction_respond", respondInput);
  proof.respond.first = { input: { ...respondInput, target: undefined }, receipt: first };
  note(`interaction_respond -> ${first.outcome}${first.message ? ` (${first.message})` : ""}`);
  save();

  // (4) Replays: the exact same request is idempotent (same stored receipt, no new
  // dispatch); a fresh request for the same id and a stale fingerprint are refused.
  const replay = await laptop("interaction_respond", respondInput);
  const again = await laptop("interaction_respond", { ...respondInput, requestId: randomUUID() });
  const stale = await laptop("interaction_respond", { ...respondInput, requestId: randomUUID(), expectedFingerprint: flipHex(item.fingerprint) });
  proof.respond.exactReplay = { requestId: respondInput.requestId, receipt: replay, identicalToFirst: JSON.stringify(replay) === JSON.stringify(first) };
  proof.respond.sameIdFreshRequest = { requestId: again.requestId, receipt: again };
  proof.respond.modifiedFingerprint = { requestId: stale.requestId, fingerprint: flipHex(item.fingerprint), receipt: stale };
  note(`replay=${replay.outcome} (identical=${proof.respond.exactReplay.identicalToFirst}) sameId=${again.outcome} staleFingerprint=${stale.outcome}`);
  save();

  // (5) Owner: the turn continues to completion with exactly one answer for this id.
  let answer = null;
  const turnStart = Date.now();
  while (Date.now() - turnStart < TURN_LIMIT_MS) {
    const events = (await ownerEvents(threadId).catch(() => [])).filter((event) => /^turn\/(completed|failed|interrupted)$/.test(event.type));
    if (events.length) {
      answer = await studio("thread_answer_get", { threadId }).catch((cause) => ({ error: String(cause?.message ?? cause) }));
      proof.owner.turnEnd = events.map((event) => ({ seq: event.seq, type: event.type, createdAt: event.createdAt }));
      break;
    }
    await sleep(3_000);
  }
  const lifecycle = (await ownerEvents(threadId)).filter((event) => event.type === "system/interaction/lifecycle");
  const forId = lifecycle.filter((event) => lifecycleOf(event)?.id === item.id).map((event) => ({ seq: event.seq, status: lifecycleOf(event).status, resolution: lifecycleOf(event).resolution ?? null, createdAt: event.createdAt }));
  const all = await ownerEvents(threadId);
  const requested = all.filter((event) => event.type === "client/turn/requested");
  const types = {};
  for (const event of all) types[event.type] = (types[event.type] ?? 0) + 1;
  const pendingAfter = await retry("laptop interaction_list", () => laptop("interaction_list", { target }));
  proof.owner = {
    ...proof.owner,
    threadId,
    lifecycleForId: forId,
    resolvedCount: forId.filter((entry) => entry.status === "resolved").length,
    otherInteractionIds: [...new Set(lifecycle.map((event) => lifecycleOf(event)?.id).filter((id) => id && id !== item.id))],
    clientTurnRequested: requested.map((event) => ({ seq: event.seq, createdAt: event.createdAt })),
    eventTypeCounts: types,
    answer,
    pendingAfterOnLaptop: pendingAfter.interactions,
  };
  note(`owner lifecycle ${JSON.stringify(forId.map((entry) => entry.status))}, turn requests ${requested.length}, answer state ${answer?.state} output ${JSON.stringify(answer?.output ?? "").slice(0, 120)}`);
  save();

  // (6) Reload the laptop mirror copy and confirm the prompt shows resolved, not pending.
  let mirrorView = null;
  const mirrorStart = Date.now();
  while (Date.now() - mirrorStart < MIRROR_LIMIT_MS) {
    const reopened = await retry("laptop mirror_open", () => laptop("mirror_open", { machine: "studio", threadId }));
    const local = reopened.localThreadId;
    const interactions = await laptopcli(["thread", "interactions", "list", local]).catch((cause) => ({ error: String(cause?.message ?? cause) }));
    const listedCopy = await laptopcli(["thread", "list", "--thread", local, "--include-hidden"]).catch(() => null);
    const thread = Array.isArray(listedCopy) ? listedCopy.find((entry) => entry.id === local) ?? null : null;
    const localEvents = await laptopcli(["thread", "log", local, "--format", "json", "--all"]).catch(() => []);
    // The pending list shows only open prompts; the copy's own lifecycle events show every prompt it raised for this owner id and its latest state.
    const latest = new Map();
    for (const event of Array.isArray(localEvents) ? localEvents : []) {
      const entry = event?.type === "system/interaction/lifecycle" ? event.data?.interaction : null;
      if (entry && String(entry.origin?.providerRequestId ?? entry.providerRequestId ?? "").endsWith(`fleet-ix:${item.id}`)) latest.set(entry.id, { id: entry.id, status: entry.status, resolution: entry.resolution ?? null, seq: event.seq });
    }
    const list = Array.isArray(interactions) ? interactions : [];
    const prompts = [...latest.values()];
    mirrorView = {
      reopenedLocalThreadId: local, sameCopy: local === proof.mirror.localThreadId,
      pendingLocalInteractions: list.map((entry) => ({ id: entry.id, status: entry.status, providerRequestId: entry.providerRequestId ?? null, kind: entry.payload?.kind ?? null })),
      promptForOwnerId: prompts,
      pendingCount: list.length,
      hasPendingInteraction: thread?.hasPendingInteraction ?? null,
      copyEventCount: Array.isArray(localEvents) ? localEvents.length : null,
    };
    if (mirrorView.pendingCount === 0 && thread?.hasPendingInteraction === false && prompts.length > 0 && prompts.every((entry) => entry.status === "resolved")) break;
    await sleep(5_000);
  }
  proof.mirror.afterReload = mirrorView;
  note(`mirror after reload: ${JSON.stringify(mirrorView?.promptForOwnerId)} pending=${mirrorView?.pendingCount} hasPending=${mirrorView?.hasPendingInteraction}`);

  // Criteria.
  const output = String(answer?.output ?? "");
  proof.criteria = {
    "1_appeared_in_laptop_list_within_120s": proof.interaction.appearedAfterMs <= APPEAR_LIMIT_MS && proof.interaction.listedOwner?.serverId === studioSnap.serverId,
    "2_one_respond_accepted": first.outcome === "applied",
    "2_owner_recorded_exactly_one_answer": proof.owner.resolvedCount === 1 && forId.filter((entry) => entry.status === "resolving").length <= 1 && forId.every((entry) => ["pending", "resolving", "resolved"].includes(entry.status)) && new Set(forId.filter((entry) => entry.resolution).map((entry) => JSON.stringify(entry.resolution))).size === 1,
    "2_turn_continued_to_completion": (proof.owner.turnEnd ?? []).some((event) => event.type === "turn/completed") && output.includes(EXPECTED_LINE),
    "3_exact_replay_idempotent": replay.outcome === first.outcome && proof.respond.exactReplay.identicalToFirst,
    "3_same_id_refused": again.outcome === "refused",
    "3_modified_fingerprint_refused": stale.outcome === "refused",
    "3_no_extra_owner_input": requested.length === 1 && proof.owner.resolvedCount === 1 && proof.owner.otherInteractionIds.length === 0,
    "4_mirror_reload_shows_resolved": !!mirrorView && mirrorView.sameCopy && mirrorView.pendingCount === 0 && mirrorView.hasPendingInteraction === false && mirrorView.promptForOwnerId.length > 0 && mirrorView.promptForOwnerId.every((entry) => entry.status === "resolved"),
    "no_pending_left_on_owner": pendingAfter.interactions.length === 0,
  };
  proof.passed = Object.values(proof.criteria).every(Boolean);
}

main().catch((cause) => {
  proof.error = String(cause?.stack ?? cause);
  note(`error: ${cause?.message ?? cause}`);
}).finally(() => {
  proof.finishedAt = new Date().toISOString();
  save();
  note(`proof: ${join(OUT_DIR, "proof.json")} passed=${proof.passed}`);
  process.exit(proof.passed ? 0 : 1);
});

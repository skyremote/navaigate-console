// Run with: node --test tests/server-fleet.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleetLink } from "../server-fleet.ts";

type Call = { pluginId: string; method: string; input: unknown; outputSchema: { parse: (v: unknown) => unknown } };

function fakeBb(answer: (call: Call) => unknown) {
  return {
    sdk: {
      plugins: {
        callRpc: async (call: Call) => call.outputSchema.parse(await answer(call)),
      },
    },
  } as never;
}

const fleetBoard = {
  me: { serverId: "srv-laptop", machineKey: "laptop", label: "laptop home", joined: true, brain: true },
  columns: [
    { key: "laptop", label: "laptop home", serverId: "srv-laptop", url: "https://laptop.example.test", online: true, local: true, lastSeenAt: 10, capabilities: ["NAS"], counts: { running: 0, needsYou: 0, queued: 0 }, threads: [] },
    {
      key: "work", label: "work Client", serverId: "srv-work", url: "https://work.example.test", online: true, local: false, lastSeenAt: 9, capabilities: ["VPN"], counts: { running: 1, needsYou: 0, queued: 0 },
      threads: [{ id: "thr_a", title: "Master Reports Insights", state: "running", machine: "work", projectId: "p", projectName: "10_Atlas", providerId: "claude-code", parentThreadId: null, createdAt: 1, updatedAt: 2, url: "https://work.example.test/threads/thr_a", via: "srv-work", extra: "ignored" }],
    },
  ],
  commands: [],
  error: null,
  at: 11,
};

test("board maps Fleet's board and takes this bb's key from Fleet", async () => {
  const calls: string[] = [];
  const link = createFleetLink(fakeBb((c) => { calls.push(`${c.pluginId}.${c.method}`); return fleetBoard; }));
  const r = await link.board();
  assert.deepEqual(calls, ["fleet.board_get"]);
  assert.equal(r.available, true);
  assert.equal(r.board?.serverId, "srv-laptop");
  assert.equal(r.board?.serverKey, "laptop");
  assert.deepEqual(r.board?.columns.map((c) => c.key), ["laptop", "work"]);
  assert.equal(r.board?.columns[1].threads[0].title, "Master Reports Insights");
  assert.equal(r.board?.columns[1].threads[0].state, "running");
});

test("board carries whether each Mac's Fleet can mirror its chats", async () => {
  const withMirror = structuredClone(fleetBoard);
  (withMirror.columns[1] as { mirror?: boolean }).mirror = true;
  const r = await createFleetLink(fakeBb(() => withMirror)).board();
  assert.equal(r.board?.columns[1].mirror, true);
  assert.equal(r.board?.columns[0].mirror, false);
});

test("board is unavailable, not an error, when Fleet is missing or failing", async () => {
  const link = createFleetLink(fakeBb(() => { throw new Error("plugin fleet is not loaded"); }));
  const r = await link.board();
  assert.equal(r.available, false);
  assert.equal(r.board, null);
  assert.match(r.error ?? "", /not loaded/);
});

test("an unknown thread state from a newer Fleet reads as idle", async () => {
  const odd = structuredClone(fleetBoard);
  (odd.columns[1].threads[0] as { state: string }).state = "dreaming";
  const r = await createFleetLink(fakeBb(() => odd)).board();
  assert.equal(r.board?.columns[1].threads[0].state, "idle");
});

test("start hands the prompt to Fleet's work_start", async () => {
  let seen: unknown = null;
  const link = createFleetLink(fakeBb((c) => { seen = { method: c.method, input: c.input }; return { outcome: "sent", threadId: null, commandId: "cmd_1" }; }));
  const r = await link.start({ machine: "work", prompt: "Check the VPN" });
  assert.deepEqual(seen, { method: "work_start", input: { machine: "work", prompt: "Check the VPN" } });
  assert.deepEqual(r, { outcome: "sent", threadId: null, commandId: "cmd_1" });
});

test("mirrorOpen asks Fleet's mirror_open for the local copy of a remote chat", async () => {
  let seen: unknown = null;
  const link = createFleetLink(fakeBb((c) => { seen = { pluginId: c.pluginId, method: c.method, input: c.input }; return { localThreadId: "thr_copy", extra: "ignored" }; }));
  const r = await link.mirrorOpen({ machine: "work", threadId: "thr_a" });
  assert.deepEqual(seen, { pluginId: "fleet", method: "mirror_open", input: { machine: "work", threadId: "thr_a" } });
  assert.deepEqual(r, { localThreadId: "thr_copy" });
});

test("mirrorOpen fails loudly so the rail can fall back to the remote page", async () => {
  const link = createFleetLink(fakeBb(() => { throw new Error("The other Mac has not sent this chat yet (is it awake?)"); }));
  await assert.rejects(() => link.mirrorOpen({ machine: "work", threadId: "thr_a" }), /not sent this chat/);
  const empty = createFleetLink(fakeBb(() => ({ localThreadId: "" })));
  await assert.rejects(() => empty.mirrorOpen({ machine: "work", threadId: "thr_a" }));
});

test("native placement preserves execution, workspace intent and durable receipt", async () => {
  const route = { machine: "studio", serverId: "srv-studio", hostId: "h", mode: "auto", reason: "Fresh owner with NAS", warnings: [], candidates: [] };
  const input = { machine: "Auto", prompt: "Read this synthetic brief", requestId: "00000000-0000-4000-8000-000000000001", projectName: "Atlas", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default", workspace: { type: "unmanaged", path: null }, routing: { needsNas: true } } as const;
  const link = createFleetLink(fakeBb((call) => {
    assert.equal(call.method, "work_start");
    assert.deepEqual(call.input, input);
    return { outcome: "started", threadId: "thr_started", requestId: input.requestId, commandId: null, url: "https://studio.example.test/threads/thr_started", route };
  }));
  assert.deepEqual(await link.start(input), { outcome: "started", threadId: "thr_started", requestId: input.requestId, commandId: null, url: "https://studio.example.test/threads/thr_started", route });
});

test("board retains independent owner and resource observations", async () => {
  const resources = { observedAt: 99, cpuCount: 8, cpuUtilization: 0.25, totalMemoryBytes: 16e9, availableMemoryBytes: 8e9 };
  const input = { ...fleetBoard, columns: [{ ...fleetBoard.columns[0], ownerStatus: "live", ownerOnline: true, enrolledOnline: true, resources }] };
  const result = await createFleetLink(fakeBb(() => input)).board();
  assert.equal(result.board?.columns[0].ownerStatus, "live");
  assert.deepEqual(result.board?.columns[0].resources, resources);
});

test("board carries Fleet's system snapshot, and null or missing system stays out", async () => {
  const system = { cpuPercent: 12, cores: 8, loadAvg: [1, 2, 3], memUsedBytes: 8e9, memTotalBytes: 16e9, memPressure: "normal", swapUsedBytes: 0, diskFreeBytes: 1e11, diskTotalBytes: 5e11, keepAwake: ["Amphetamine"] };
  const withSystem = await createFleetLink(fakeBb(() => ({ ...fleetBoard, columns: [{ ...fleetBoard.columns[0], system }] }))).board();
  assert.deepEqual(withSystem.board?.columns[0].system, system);
  const nulled = await createFleetLink(fakeBb(() => ({ ...fleetBoard, columns: [{ ...fleetBoard.columns[0], system: null }] }))).board();
  assert.equal(nulled.board?.columns[0].system, null);
  const missing = await createFleetLink(fakeBb(() => fleetBoard)).board();
  assert.equal("system" in (missing.board?.columns[0] ?? {}), false);
});

test("native attachment references and verified metadata survive the Fleet bridge", async () => {
  const attachments = [{ type: "localFile" as const, sourceProjectId: "proj_source", path: "upload.txt", name: "brief.txt", mimeType: "text/plain" }];
  const verified = [{ name: "brief.txt", sha256: "a".repeat(64), sizeBytes: 10, verified: true as const }];
  const link = createFleetLink(fakeBb((call) => {
    assert.deepEqual((call.input as { attachments: unknown[] }).attachments, attachments);
    return { outcome: "started", threadId: "thr_owner", attachments: verified };
  }));
  assert.deepEqual((await link.start({ machine: "studio", prompt: "Read this", attachments })).attachments, verified);
});

test("only the positive notStarted field distinguishes a known failure from a plain missing receipt", async () => {
  const detail = { reason: "unavailable", message: "Nothing was sent to Studio" };
  const known = createFleetLink(fakeBb(() => ({ state: "missing", result: null, notStarted: detail })));
  assert.deepEqual(await known.workReceipt({ requestId: "req" }), { state: "missing", result: null, notStarted: detail });
  const missing = createFleetLink(fakeBb(() => ({ state: "missing", result: null })));
  assert.deepEqual(await missing.workReceipt({ requestId: "req" }), { state: "missing", result: null });
});

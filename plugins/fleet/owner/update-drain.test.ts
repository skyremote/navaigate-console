import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOwnerUpdateDrain, updateDrainRpcContract, type OwnerUpdateDrainOptions, type UpdateDrainCoreProof } from "./update-drain";
const NOW = 1_800_000_000_000;
const input = { v: 1 as const, ownerServerId: "owner_fixture", hostId: "host_fixture", intentId: "update-fixture-1", fromVersion: "0.47.0", targetVersion: "0.48.0" };
const target = { v: input.v, ownerServerId: input.ownerServerId, hostId: input.hostId, intentId: input.intentId };
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
function fixture(withCore = true) {
  const directory = mkdtempSync(join(tmpdir(), "owner-update-drain-"));
  let db = new Database(join(directory, "drain.sqlite"));
  const hosts: ReturnType<typeof createFakePluginHost>[] = [];
  let coreClosed = false;
  let coreArmed = false;
  let activeOperations = 0;
  let currentProof: unknown = null;
  let helper: unknown = null;
  let own = { ownerServerId: input.ownerServerId, hostId: input.hostId as string | null };
  let rows: any[] = [];
  let running: { id: string; hostId: string | null }[] = [];
  const proof = (): UpdateDrainCoreProof => ({ requestId: input.intentId, ownerServerId: input.ownerServerId, hostId: input.hostId, admissionClosed: coreClosed, armed: coreArmed, activeOperations, atomic: true, persistent: true });
  const gate = {
    acquire: vi.fn(async () => { coreClosed = true; return (currentProof ?? proof()) as UpdateDrainCoreProof; }),
    status: vi.fn(async () => (currentProof ?? proof()) as UpdateDrainCoreProof),
    arm: vi.fn(async () => { coreArmed = true; return (currentProof ?? proof()) as UpdateDrainCoreProof; }),
    cancel: vi.fn(async () => { if (!coreArmed) coreClosed = false; return (currentProof ?? proof()) as UpdateDrainCoreProof; }),
    release: vi.fn(async () => { coreClosed = false; coreArmed = false; return (currentProof ?? proof()) as UpdateDrainCoreProof; }),
  };
  const options: OwnerUpdateDrainOptions = { identity: async () => own, coreGate: withCore ? gate as OwnerUpdateDrainOptions["coreGate"] : undefined, readHelperIntent: async () => helper, now: () => NOW, pollMs: 250 };
  function load() {
    const host = createFakePluginHost({ pluginId: "fleet-update-drain-fixture", sdk: { threads: {
      listRunning: async () => running,
      list: async ({ archived, offset = 0, limit = 200 } = {}) => rows.filter((item) => (item.archivedAt !== null) === archived).slice(offset, offset + limit),
    } } });
    Object.defineProperty(host.bb.storage, "database", { value: () => db });
    hosts.push(host);
    const service = createOwnerUpdateDrain(host.bb, options);
    host.bb.rpc.register(updateDrainRpcContract, service.handlers);
    return { ...host, service };
  }
  const initial = load();
  disposals.push(async () => { for (const host of hosts) await host.harness.lifecycle.dispose(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    ...initial, gate, options, proof, db,
    reload: load,
    reopen() { db.close(); db = new Database(join(directory, "drain.sqlite")); return load(); },
    active(value: number) { activeOperations = value; },
    proofOverride(value: unknown) { currentProof = value; },
    helper(value: unknown) { helper = value; },
    terminal(phase = "updated", overrides: Record<string, unknown> = {}) { helper = { ...input, phase, updatedAt: NOW, ...overrides }; },
    own(value: typeof own) { own = value; },
    rows(value: any[]) { rows = value; },
    running(value: typeof running) { running = value; },
    closed() { return coreClosed; },
  };
}
function row(overrides: Record<string, unknown> = {}) {
  return { id: "thr_fixture", status: "idle", archivedAt: null, visibility: "hidden", runtime: { displayStatus: "idle" }, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeWorkflowCount: 0, activeGoalCount: 0, activePlanModeCount: 0 }, ...overrides };
}

describe("owner update admission and proof", () => {
  it("does not change admission when the required native atomic gate is absent", async () => {
    const f = fixture(false);
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "unavailable", gateActive: false, safeToQuit: false });
    expect(f.service.dispatchDecision()).toEqual({ action: "proceed" });
    expect(f.db.prepare("SELECT count(*) AS n FROM fleet_owner_update_drain_v1").get()).toEqual({ n: 0 });
  });
  it("durably queues normal dispatches before awaiting core acquisition", async () => {
    const f = fixture();
    let resolve!: (value: UpdateDrainCoreProof) => void;
    f.gate.acquire.mockImplementationOnce(async () => new Promise<UpdateDrainCoreProof>((done) => { resolve = done; }));
    const pending = f.service.handlers.update_drain_begin(input);
    await vi.waitFor(() => expect(f.gate.acquire).toHaveBeenCalledOnce());
    expect(f.service.dispatchDecision()).toMatchObject({ action: "wait", sendAt: null });
    expect(f.db.prepare("SELECT value FROM fleet_owner_update_drain_v1").get()).toMatchObject({ value: expect.stringContaining('"phase":"acquiring"') });
    resolve({ ...f.proof(), admissionClosed: true });
    expect(await pending).toMatchObject({ safeToQuit: false });
  });
  it("requires actual held core proof and zero admitted work before arming", async () => {
    const f = fixture(); f.active(2);
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "busy", safeToQuit: false, core: { activeOperations: 2 } });
    expect(await f.service.handlers.update_drain_arm_helper(target)).toMatchObject({ helperArmed: true, safeToQuit: false });
    f.active(0);
    expect(await f.service.handlers.update_drain_arm_helper(target)).toMatchObject({ state: "held", helperArmed: true, safeToQuit: true });
    expect(await f.service.handlers.update_drain_cancel(target)).toMatchObject({ state: "refused", gateActive: true });
    expect(f.gate.release).not.toHaveBeenCalled();
  });
  it.each(["owner", "host", "intent", "atomic", "persistent", "not held"])("cannot claim idle with %s core proof", async (kind) => {
    const f = fixture();
    const changed = { ...f.proof(), admissionClosed: true };
    f.proofOverride(kind === "owner" ? { ...changed, ownerServerId: "other" } : kind === "host" ? { ...changed, hostId: "other" } : kind === "intent" ? { ...changed, requestId: "different-intent" } : kind === "atomic" ? { ...changed, atomic: false } : kind === "persistent" ? { ...changed, persistent: false } : { ...changed, admissionClosed: false });
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "unknown", gateActive: true, safeToQuit: false });
    expect(f.service.dispatchDecision()).toMatchObject({ action: "wait" });
  });
  it("rejects wrong owner and competing intents without releasing the original gate", async () => {
    const f = fixture();
    await expect(f.service.handlers.update_drain_begin({ ...input, hostId: "foreign" })).rejects.toThrow("primary host");
    expect(f.gate.acquire).not.toHaveBeenCalled();
    await f.service.handlers.update_drain_begin(input);
    expect(await f.service.handlers.update_drain_begin({ ...input, intentId: "another-update" })).toMatchObject({ state: "refused", gateActive: true, safeToQuit: false });
    expect(await f.service.handlers.update_drain_begin({ ...input, targetVersion: "0.49.0" })).toMatchObject({ state: "refused" });
    await expect(f.service.handlers.update_drain_cancel({ ...target, intentId: "another-update" })).rejects.toThrow("intent");
    expect(f.gate.release).not.toHaveBeenCalled();
  });
  it("deduplicates a repeated begin and never reacquires after an unknown acquisition reply", async () => {
    const f = fixture();
    f.gate.acquire.mockRejectedValueOnce(new Error("Synthetic acquire reply lost"));
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "unknown" });
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "unknown", safeToQuit: false });
    expect(f.gate.acquire).toHaveBeenCalledOnce();
  });
});

describe("actual SDK work diagnostics", () => {
  it.each(["active", "starting", "stopping", "provisioning", "background agent", "background command", "workflow", "archived background"])("keeps gate busy for %s", async (kind) => {
    const f = fixture();
    const activity = { activeBackgroundAgentCount: kind === "background agent" ? 1 : 0, activeBackgroundCommandCount: kind === "background command" || kind === "archived background" ? 1 : 0, activeWorkflowCount: kind === "workflow" ? 1 : 0, activeGoalCount: 0, activePlanModeCount: 0 };
    f.rows([row({ status: ["active", "starting", "stopping"].includes(kind) ? kind : "idle", runtime: { displayStatus: kind === "provisioning" ? "provisioning" : "idle" }, archivedAt: kind === "archived background" ? 12 : null, activity })]);
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "busy", safeToQuit: false });
    expect(f.harness.sdk.calls.find((call) => call.path === "threads.list")?.args).toBeDefined();
  });
  it("does not confuse cheap hook-queued pending threads with pre-admitted core work", async () => {
    const f = fixture(); f.rows([row({ status: "pending", runtime: { displayStatus: "pending" } })]);
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "held", safeToQuit: true, activity: { pendingThreadCount: 1, busyThreadCount: 0 } });
    f.active(1);
    expect(await f.service.handlers.update_drain_status(target)).toMatchObject({ state: "busy", safeToQuit: false });
  });
  it("fails closed on an incomplete or failed SDK diagnostic read", async () => {
    const f = fixture();
    f.harness.sdk.stub("threads.list", async () => Array.from({ length: 200 }, () => row()) as never);
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "busy", safeToQuit: false, activity: { complete: false } });
    f.harness.sdk.stub("threads.listRunning", async () => { throw new Error("Synthetic owner read unavailable"); });
    expect(await f.service.handlers.update_drain_status(target)).toMatchObject({ state: "unknown", safeToQuit: false, gateActive: true });
  });
});

describe("queue preservation and helper lifecycle", () => {
  it("waits without rewriting authored text, attachments, origin, retry or start intent", async () => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input);
    const queued = makeQueueEntry({ id: "queue_fixture", threadId: "thr_fixture" });
    const context = makeMessageDispatchHookContext({ queuedMessages: [queued], input: { text: "Exact unsent fixture", blocks: [{ type: "text", text: "Exact unsent fixture", mentions: [] }] } });
    const before = JSON.stringify(context);
    const hook = f.harness.inspection.registrations.hooks["message.dispatch"]!;
    expect(await hook(context)).toMatchObject({ action: "wait", sendAt: null });
    expect(await hook({ ...context, attempt: "join-turn" })).toMatchObject({ action: "wait" });
    expect(JSON.stringify(context)).toBe(before);
    expect(f.harness.sdk.calls.some((call) => /queuedMessages\.(delete|update)|threads\.send|threads\.spawn/.test(call.path))).toBe(false);
  });
  it.each(["updated", "failed", "rolled-back", "rollback-failed", "rollback-held", "install-held", "refused"])("releases only after exact helper terminal %s", async (phase) => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input); await f.service.handlers.update_drain_arm_helper(target);
    f.terminal(phase);
    expect(await f.service.handlers.update_drain_release(target)).toMatchObject({ state: "released", gateActive: false, safeToQuit: false, helperPhase: phase });
    expect(f.service.dispatchDecision()).toEqual({ action: "proceed" });
    expect(f.harness.inspection.recheckCount).toBe(1);
  });
  it.each(["missing", "nonterminal", "wrong intent", "wrong from", "wrong target", "stale"])("keeps messages held for %s helper receipt", async (kind) => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input); await f.service.handlers.update_drain_arm_helper(target);
    if (kind !== "missing") f.terminal(kind === "nonterminal" ? "quitting" : "updated", kind === "wrong intent" ? { intentId: "other-intent" } : kind === "wrong from" ? { fromVersion: "0.46.0" } : kind === "wrong target" ? { targetVersion: "0.49.0" } : kind === "stale" ? { updatedAt: NOW - 1 } : {});
    expect(await f.service.handlers.update_drain_release(target)).toMatchObject({ state: "unknown", gateActive: true, safeToQuit: false });
    expect(f.gate.release).not.toHaveBeenCalled(); expect(f.harness.inspection.recheckCount).toBe(0);
  });
  it("cancels only a never-armed helper and keeps historical intent IDs closed", async () => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input);
    expect(await f.service.handlers.update_drain_cancel(target)).toMatchObject({ state: "released", gateActive: false });
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "refused" });
    const next = { ...input, intentId: "update-fixture-2" };
    f.proofOverride({ ...f.proof(), requestId: next.intentId, admissionClosed: true });
    await f.service.handlers.update_drain_begin(next);
    f.proofOverride({ ...f.proof(), requestId: next.intentId, admissionClosed: false });
    await f.service.handlers.update_drain_cancel({ ...target, intentId: next.intentId });
    expect(await f.service.handlers.update_drain_begin(input)).toMatchObject({ state: "refused" });
  });
});

describe("restart and uncertain recovery", () => {
  it("restores the armed queue hold immediately and releases only exact same-owner terminal recovery", async () => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input); await f.service.handlers.update_drain_arm_helper(target);
    const restarted = f.reopen();
    expect(restarted.service.dispatchDecision()).toMatchObject({ action: "wait" });
    await restarted.service.recover();
    expect(f.gate.release).not.toHaveBeenCalled();
    f.terminal();
    expect(await restarted.service.recover()).toMatchObject({ state: "released", gateActive: false });
    expect(restarted.harness.inspection.recheckCount).toBe(1);
  });
  it("recovers an unarmed interrupted preparation without assuming any helper ran", async () => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input);
    const restarted = f.reopen();
    expect(restarted.service.dispatchDecision()).toMatchObject({ action: "wait" });
    expect(await restarted.service.recover()).toMatchObject({ state: "released", gateActive: false });
    expect(f.gate.cancel).toHaveBeenCalledOnce();
  });
  it("never resumes queued work at a changed owner after restart", async () => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input);
    f.own({ ownerServerId: "foreign-owner", hostId: input.hostId });
    const restarted = f.reopen(); f.terminal();
    expect(await restarted.service.recover()).toMatchObject({ state: "unknown", gateActive: true, safeToQuit: false });
    expect(restarted.service.dispatchDecision()).toMatchObject({ action: "wait" });
    expect(f.gate.release).not.toHaveBeenCalled(); expect(restarted.harness.inspection.recheckCount).toBe(0);
  });
  it("does not unlock after a lost release reply and retries only the same exact core release", async () => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input); await f.service.handlers.update_drain_arm_helper(target); f.terminal();
    f.gate.release.mockRejectedValueOnce(new Error("Synthetic release reply lost"));
    expect(await f.service.handlers.update_drain_release(target)).toMatchObject({ state: "unknown", gateActive: true });
    expect(f.harness.inspection.recheckCount).toBe(0);
    expect(await f.service.handlers.update_drain_release(target)).toMatchObject({ state: "released" });
    expect(f.gate.release.mock.calls).toMatchObject([[target, { intentId: input.intentId, phase: "updated" }], [target, { intentId: input.intentId, phase: "updated" }]]);
  });
  it("retains a durable queue wake retry when release succeeded but recheck failed", async () => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input);
    vi.spyOn(f.bb.experimental_hooks, "recheck").mockRejectedValueOnce(new Error("Synthetic queue wake failure"));
    expect(await f.service.handlers.update_drain_cancel(target)).toMatchObject({ state: "released", gateActive: false });
    expect(f.service.dispatchDecision()).toEqual({ action: "proceed" });
    expect(f.db.prepare("SELECT value FROM fleet_owner_update_drain_v1").get()).toMatchObject({ value: expect.stringContaining('"wakePending":true') });
    const restarted = f.reopen(); await restarted.service.recover();
    expect(restarted.harness.inspection.recheckCount).toBe(1);
    expect(f.gate.cancel).toHaveBeenCalledOnce();
  });
  it("fails closed on corrupt durable state and bounds the public RPC inputs", async () => {
    const f = fixture(); f.db.prepare("INSERT INTO fleet_owner_update_drain_v1 VALUES (1, ?)").run("not json");
    const restarted = f.reload();
    expect(restarted.service.dispatchDecision()).toMatchObject({ action: "wait" });
    await expect(restarted.service.handlers.update_drain_begin(input)).rejects.toThrow("unreadable");
    expect(updateDrainRpcContract.update_drain_begin.input.safeParse({ ...input, genericProxy: "anything" }).success).toBe(false);
    expect(updateDrainRpcContract.update_drain_release.input.safeParse({ ...target, force: true }).success).toBe(false);
  });
});


describe("native helper authority acknowledgement", () => {
  it("retains possible launch intent after an uncertain native arm reply and refuses blind cancellation", async () => {
    const f = fixture(); await f.service.handlers.update_drain_begin(input);
    f.gate.arm.mockRejectedValueOnce(new Error("Synthetic native arm reply lost"));
    expect(await f.service.handlers.update_drain_arm_helper(target)).toMatchObject({ state: "unknown", helperArmed: true, safeToQuit: false });
    expect(await f.service.handlers.update_drain_cancel(target)).toMatchObject({ state: "refused", gateActive: true });
    expect(f.gate.cancel).not.toHaveBeenCalled();
  });
});

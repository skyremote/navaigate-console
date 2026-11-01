import { defineRpcContract, type BbPluginApi, type MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(250);
const intentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/);
const version = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const target = z.object({ v: z.literal(1), ownerServerId: id, hostId: id, intentId }).strict();
const beginInput = target.extend({ fromVersion: version, targetVersion: version }).strict();
export type UpdateDrainTarget = z.infer<typeof target>;
export type UpdateDrainBeginInput = z.infer<typeof beginInput>;
export const updateDrainCoreProofSchema = z.object({
  requestId: intentId, ownerServerId: id, hostId: id,
  admissionClosed: z.boolean(), armed: z.boolean(), activeOperations: z.number().int().nonnegative(),
  atomic: z.literal(true), persistent: z.literal(true),
}).strict();
export type UpdateDrainCoreProof = z.infer<typeof updateDrainCoreProofSchema>;
export interface UpdateDrainCoreGate {
  acquire(input: UpdateDrainTarget): Promise<UpdateDrainCoreProof>;
  status(input: UpdateDrainTarget): Promise<UpdateDrainCoreProof>;
  arm(input: UpdateDrainTarget): Promise<UpdateDrainCoreProof>;
  cancel(input: UpdateDrainTarget): Promise<UpdateDrainCoreProof>;
  release(input: UpdateDrainTarget, terminal: z.infer<typeof helperIntent>): Promise<UpdateDrainCoreProof>;
}
const helperIntent = z.object({ intentId, fromVersion: version, targetVersion: version, phase: id, updatedAt: z.number().int().nonnegative() }).passthrough();
export interface OwnerUpdateDrainOptions {
  identity(): Promise<{ ownerServerId: string; hostId: string | null }>;
  coreGate?: UpdateDrainCoreGate;
  readHelperIntent(intentId: string): Promise<unknown>;
  now?: () => number;
  pollMs?: number;
}
const diagnosticSchema = z.object({
  runningThreadCount: z.number().int().nonnegative(), pendingThreadCount: z.number().int().nonnegative(),
  busyThreadCount: z.number().int().nonnegative(), backgroundAgentCount: z.number().int().nonnegative(),
  backgroundCommandCount: z.number().int().nonnegative(), workflowCount: z.number().int().nonnegative(),
  complete: z.boolean(),
});
const stateSchema = z.object({
  input: beginInput, armed: z.boolean(), phase: z.enum(["acquiring", "held", "unknown", "released", "cancelled"]),
  startedAt: z.number(), updatedAt: z.number(), wakePending: z.boolean().default(false), reason: z.string().nullable(), helperPhase: z.string().nullable(),
});
type State = z.infer<typeof stateSchema>;
const resultSchema = z.object({
  ownerServerId: id, hostId: id, intentId, state: z.enum(["held", "busy", "released", "refused", "unknown", "unavailable"]),
  gateActive: z.boolean(), helperArmed: z.boolean(), safeToQuit: z.boolean(),
  core: updateDrainCoreProofSchema.nullable(), activity: diagnosticSchema.nullable(),
  helperPhase: z.string().nullable(), reason: z.string().nullable(),
});
export type UpdateDrainResult = z.infer<typeof resultSchema>;
export const updateDrainRpcContract = defineRpcContract({
  update_drain_begin: { input: beginInput, output: resultSchema },
  update_drain_status: { input: target, output: resultSchema },
  update_drain_arm_helper: { input: target, output: resultSchema },
  update_drain_cancel: { input: target, output: resultSchema },
  update_drain_release: { input: target, output: resultSchema },
});
const terminalPhases = new Set(["updated", "failed", "rolled-back", "rollback-failed", "rollback-held", "install-held", "refused"]);
const sameTarget = (left: UpdateDrainTarget, right: UpdateDrainTarget) => left.intentId === right.intentId && left.ownerServerId === right.ownerServerId && left.hostId === right.hostId;
const isActive = (state: State | null) => state !== null && state.phase !== "released" && state.phase !== "cancelled";
const detail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000);

export function createOwnerUpdateDrain(bb: BbPluginApi, options: OwnerUpdateDrainOptions) {
  const now = options.now ?? Date.now;
  const db = bb.storage.database();
  db.exec("CREATE TABLE IF NOT EXISTS fleet_owner_update_drain_v1 (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS fleet_owner_update_drain_history_v1 (intent_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM fleet_owner_update_drain_v1 WHERE singleton = 1").get() as { value: string } | undefined;
  let state: State | null = null;
  let corrupt: string | null = null;
  if (row) {
    try { state = stateSchema.parse(JSON.parse(row.value)); }
    catch { corrupt = "Stored update admission state is unreadable; queued work remains held"; }
  }
  let warmedUnarmed = isActive(state) && !state!.armed;
  function store(next: State) {
    db.transaction(() => {
      const value = JSON.stringify(next);
      db.prepare("INSERT INTO fleet_owner_update_drain_v1 VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET value=excluded.value").run(value);
      db.prepare("INSERT INTO fleet_owner_update_drain_history_v1 VALUES (?, ?) ON CONFLICT(intent_id) DO UPDATE SET value=excluded.value").run(next.input.intentId, value);
    })();
    state = next;
  }
  function patch(values: Partial<State>) {
    if (!state) throw new Error("No update gate intent exists");
    store({ ...state, ...values, updatedAt: now() });
  }
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(action, action);
    tail = result.catch(() => {});
    return result;
  }
  function result(input: UpdateDrainTarget, kind: UpdateDrainResult["state"], reason: string | null, core: UpdateDrainCoreProof | null = null, activity: UpdateDrainResult["activity"] = null): UpdateDrainResult {
    const matching = state !== null && sameTarget(state.input, input);
    const active = isActive(state) || corrupt !== null;
    return {
      ownerServerId: input.ownerServerId, hostId: input.hostId, intentId: input.intentId,
      state: kind, gateActive: active, helperArmed: matching && state!.armed,
      safeToQuit: kind === "held" && matching && active && core !== null && core.admissionClosed && core.activeOperations === 0 && activity !== null && activity.complete && activity.busyThreadCount === 0 && activity.backgroundAgentCount === 0 && activity.backgroundCommandCount === 0 && activity.workflowCount === 0,
      core, activity, helperPhase: matching ? state!.helperPhase : null, reason,
    };
  }
  async function identity(input: UpdateDrainTarget) {
    const own = await options.identity();
    if (own.ownerServerId !== input.ownerServerId || own.hostId !== input.hostId) throw new Error("Update drain does not belong to this owner server and primary host");
    if (corrupt) throw new Error(corrupt);
  }
  function activeIntent(input: UpdateDrainTarget) {
    if (!state || !sameTarget(state.input, input)) throw new Error("Update drain intent does not match the stored owner intent");
  }
  function proof(input: UpdateDrainTarget, value: unknown) {
    const parsed = updateDrainCoreProofSchema.parse(value);
    if (parsed.requestId !== input.intentId || parsed.ownerServerId !== input.ownerServerId || parsed.hostId !== input.hostId) throw new Error("Core update gate proof names another owner or intent");
    return parsed;
  }
  async function activity() {
    const running = await bb.sdk.threads.listRunning();
    const rows: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
    let complete = true;
    for (const archived of [false, true]) {
      for (let page = 0; page < 50; page++) {
        const batch = await bb.sdk.threads.list({ archived, includeHidden: true, limit: 200, offset: page * 200 });
        rows.push(...batch);
        if (batch.length < 200) break;
        if (page === 49) complete = false;
      }
    }
    const unique = [...new Map(rows.map((item) => [item.id, item])).values()];
    return {
      runningThreadCount: running.length,
      pendingThreadCount: unique.filter((item) => item.status === "pending").length,
      busyThreadCount: Math.max(running.length, unique.filter((item) => item.status === "starting" || item.status === "active" || item.status === "stopping" || item.runtime.displayStatus === "provisioning").length),
      backgroundAgentCount: unique.reduce((sum, item) => sum + item.activity.activeBackgroundAgentCount, 0),
      backgroundCommandCount: unique.reduce((sum, item) => sum + item.activity.activeBackgroundCommandCount, 0),
      workflowCount: unique.reduce((sum, item) => sum + item.activity.activeWorkflowCount, 0),
      complete,
    };
  }
  async function statusInternal(input: UpdateDrainTarget): Promise<UpdateDrainResult> {
    await identity(input);
    activeIntent(input);
    if (!isActive(state)) return result(input, "released", null);
    if (!options.coreGate) return result(input, "unavailable", "Native atomic admission gate is unavailable; plugin waits alone do not cover Send-now or pre-admitted work");
    try {
      const core = proof(input, await options.coreGate.status(input));
      const snapshot = await activity();
      if (!core.admissionClosed) return result(input, "unknown", "The native admission gate is not held; do not quit", core, snapshot);
      const busy = core.activeOperations > 0 || !snapshot.complete || snapshot.busyThreadCount > 0 || snapshot.backgroundAgentCount > 0 || snapshot.backgroundCommandCount > 0 || snapshot.workflowCount > 0;
      patch({ phase: "held", reason: null, armed: state!.armed || core.armed });
      return result(input, busy ? "busy" : "held", busy ? "Waiting for already admitted native work to finish" : null, core, snapshot);
    } catch (cause) { patch({ phase: "unknown", reason: detail(cause) }); return result(input, "unknown", detail(cause)); }
  }
  async function begin(raw: UpdateDrainBeginInput): Promise<UpdateDrainResult> {
    const input = beginInput.parse(raw);
    await identity(input);
    if (isActive(state)) {
      if (!sameTarget(state!.input, input) || state!.input.fromVersion !== input.fromVersion || state!.input.targetVersion !== input.targetVersion) return result(input, "refused", "Another durable update intent already owns admission");
      return statusInternal(input);
    }
    if ((state && sameTarget(state.input, input)) || db.prepare("SELECT 1 FROM fleet_owner_update_drain_history_v1 WHERE intent_id = ?").get(input.intentId)) return result(input, "refused", "This update intent already reached its terminal gate state; use a new intent");
    if (!options.coreGate) return result(input, "unavailable", "Native atomic update gate capability is required; no admission flag was changed");
    store({ input, armed: false, phase: "acquiring", startedAt: now(), updatedAt: now(), wakePending: false, reason: null, helperPhase: null });
    warmedUnarmed = false;
    try {
      const core = proof(input, await options.coreGate.acquire(input));
      if (!core.admissionClosed) throw new Error("Native admission gate was not acquired; do not launch the helper");
      patch({ phase: "held", armed: core.armed });
      return statusInternal(input);
    } catch (cause) { patch({ phase: "unknown", reason: detail(cause) }); return result(input, "unknown", detail(cause)); }
  }
  async function arm(input: UpdateDrainTarget) {
    const current = await statusInternal(input);
    if (!current.gateActive || !current.core?.admissionClosed || (current.state !== "held" && current.state !== "busy")) return current;
    patch({ armed: true });
    try {
      const core = proof(input, await options.coreGate!.arm(input));
      if (!core.admissionClosed || !core.armed) throw new Error("Native admission did not acknowledge armed helper authority");
      return result(input, current.state === "busy" || core.activeOperations > 0 ? "busy" : "held", current.reason, core, current.activity);
    } catch (cause) { patch({ phase: "unknown", reason: detail(cause) }); return result(input, "unknown", detail(cause)); }
  }
  async function wakeQueued() {
    if (!state?.wakePending || isActive(state)) return;
    await identity(state.input);
    await bb.experimental_hooks.recheck("message.dispatch");
    patch({ wakePending: false });
  }
  async function releaseInternal(input: UpdateDrainTarget, cancel: boolean): Promise<UpdateDrainResult> {
    await identity(input);
    activeIntent(input);
    if (!isActive(state)) { try { await wakeQueued(); } catch (cause) { return result(input, "released", detail(cause)); } return result(input, "released", null); }
    if (!options.coreGate) return result(input, "unavailable", "Native update gate is unavailable; queued work remains held");
    let verifiedTerminal: z.infer<typeof helperIntent> | null = null;
    if (cancel) {
      if (state!.armed) return result(input, "refused", "Helper launch was armed; only a verified terminal helper receipt can release this intent");
    } else {
      const terminal = helperIntent.safeParse(await options.readHelperIntent(input.intentId));
      if (!terminal.success || terminal.data.intentId !== input.intentId || terminal.data.fromVersion !== state!.input.fromVersion || terminal.data.targetVersion !== state!.input.targetVersion || terminal.data.updatedAt < state!.startedAt || !terminalPhases.has(terminal.data.phase)) return result(input, "unknown", "No exact terminal helper receipt exists; queued work remains held");
      verifiedTerminal = terminal.data;
      patch({ helperPhase: terminal.data.phase });
    }
    try {
      const core = proof(input, cancel ? await options.coreGate.cancel(input) : await options.coreGate.release(input, verifiedTerminal!));
      if (core.admissionClosed) return result(input, "unknown", "The native admission gate remains held", core);
      patch({ phase: cancel ? "cancelled" : "released", reason: null, wakePending: true });
      warmedUnarmed = false;
      try { await wakeQueued(); } catch (cause) { return result(input, "released", `Admission released; retained queue wake will retry: ${detail(cause)}`, core); }
      return result(input, "released", null, core);
    } catch (cause) { patch({ phase: "unknown", reason: detail(cause) }); return result(input, "unknown", detail(cause)); }
  }
  async function recoverInternal() {
    if (corrupt || !state) return;
    if (!isActive(state)) { try { await wakeQueued(); } catch { /* Durable wake intent is retried by the recovery service. */ } return; }
    const input = state!.input;
    try {
      await identity(input);
      if (warmedUnarmed) return releaseInternal(input, true);
      const terminal = helperIntent.safeParse(await options.readHelperIntent(input.intentId));
      if (terminal.success && terminalPhases.has(terminal.data.phase)) return releaseInternal(input, false);
      return statusInternal(input);
    } catch (cause) { patch({ phase: "unknown", reason: detail(cause) }); return result(input, "unknown", detail(cause)); }
  }
  function dispatchDecision(): MessageDispatchHookDecision {
    if (corrupt) return { action: "wait", reason: corrupt, sendAt: null };
    if (!isActive(state)) return { action: "proceed" };
    return { action: "wait", reason: `Owner update ${state!.input.intentId} is draining or restarting; this message is retained until verified recovery`, sendAt: null };
  }
  bb.experimental_hooks.on("message.dispatch", dispatchDecision);
  bb.background.service("fleet-owner-update-drain", { async start(signal) {
    while (!signal.aborted) {
      await serial(recoverInternal);
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, Math.max(250, options.pollMs ?? 1000));
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  } });
  return {
    recover: () => serial(recoverInternal), dispatchDecision,
    handlers: {
      update_drain_begin: (input: UpdateDrainBeginInput) => serial(() => begin(input)),
      update_drain_status: (input: UpdateDrainTarget) => serial(() => statusInternal(target.parse(input))),
      update_drain_arm_helper: (input: UpdateDrainTarget) => serial(() => arm(target.parse(input))),
      update_drain_cancel: (input: UpdateDrainTarget) => serial(() => releaseInternal(target.parse(input), true)),
      update_drain_release: (input: UpdateDrainTarget) => serial(() => releaseInternal(target.parse(input), false)),
    },
  };
}

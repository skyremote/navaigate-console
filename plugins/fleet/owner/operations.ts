import { createHash, randomUUID } from "node:crypto";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Snapshot } from "../model";
import type { OwnerCallOutcome, OwnerMethod, OwnerPlugin } from "./transport";

const id = z.string().min(1).max(128);
const machine = z.string().min(1).max(40);
type Machine = z.infer<typeof machine>;
const automationInput = z
  .object({
    v: z.literal(1),
    ownerServerId: id,
    hostId: id,
    projectId: id,
    automationId: id,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
const automationDispatch = automationInput.extend({ machine }).strict();
export const automationReceipt = z
  .object({
    state: z.enum(["started", "deduped", "refused", "unknown", "unavailable"]),
    ownerServerId: id.nullable(),
    hostId: id.nullable(),
    runId: z.string().nullable(),
    threadId: z.string().nullable(),
    runStatus: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
const usageSnapshot = z.object({
  ownerServerId: id,
  hostId: id.nullable(),
  observedAt: z.number(),
  providers: z
    .array(
      z.object({
        providerId: id,
        status: z.enum(["ok", "unavailable", "error"]),
        subscriptionId: z.string().nullable(),
        identity: z.enum(["unknown", "verified"]),
        planLabel: z.string().nullable(),
        windows: z
          .array(
            z.object({
              label: z.string().min(1).max(128),
              usedPercent: z.number().nullable(),
              resetsAt: z.string().nullable(),
            }),
          )
          .max(50),
        method: z.literal("bb.system.usageLimits"),
        observationId: z.string(),
      }),
    )
    .max(30),
});
const usageResult = z
  .object({
    state: z.enum(["ok", "unavailable"]),
    reason: z.string().nullable(),
    snapshot: usageSnapshot.nullable(),
  })
  .strict();
const attentionPolicy = z
  .object({
    autoMerge: z.boolean().default(false),
    requiredPrUrls: z.array(z.string().url().max(500)).max(20).default([]),
    requiredPrEnvironments: z.record(z.string(), id).default({}),
    acceptancePending: z.boolean().default(true),
    inactiveAfterMs: z
      .number()
      .int()
      .min(3_600_000)
      .max(365 * 86400_000)
      .nullable()
      .default(null),
  })
  .strict();
const attentionInput = z
  .object({
    threadIds: z.array(id).min(1).max(200),
    action: z.enum(["settle", "snooze", "restore", "retitle", "stash"]),
    wakeAt: z.number().int().optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const attentionRowFields = {
  threadId: id,
  remote: z.boolean().optional(),
  policy: attentionPolicy.optional(),
  ownerServerId: z.string().nullable().optional(),
  ownerHostId: z.string().nullable().optional(),
  machine: machine.optional(),
  title: z.string(),
  hostId: z.string().nullable(),
  environmentId: z.string().nullable(),
  question: z.string().nullable(),
  updatedAt: z.number(),
  pinned: z.boolean(),
  wakeAt: z.number().nullable(),
};
// "stashed" is a real Console status (a quiet chat moved to the Stash).
const attentionStatusName = z.enum([
  "running",
  "waiting",
  "needs-you",
  "failed",
  "reviewable",
  "accepted",
  "snoozed",
  "stashed",
]);
const attentionRow = z.object({ ...attentionRowFields, status: attentionStatusName });
const snapshotFields = {
  v: z.literal(1),
  ownerServerId: id,
  hostId: id.nullable(),
  observedAt: z.number(),
  truncated: z.boolean(),
};
const attentionSnapshot = z
  .object({ ...snapshotFields, rows: z.array(attentionRow).max(500) })
  .strict();
// What an owner sends back is read with the status as it comes. A status Fleet
// has not heard of, or none, is shown as needs-you (so the row can be seen and
// settled) instead of an error that drops every row of that Mac.
const attentionSnapshotRaw = z
  .object({
    ...snapshotFields,
    rows: z.array(z.object({ ...attentionRowFields, status: z.unknown().optional() })).max(500),
  })
  .strict();
const attentionCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("apply"), input: attentionInput }).strict(),
  z.object({ kind: z.literal("undo"), receiptId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal("policy"),
      threadId: id,
      policy: attentionPolicy,
    })
    .strict(),
]);
const attentionAction = z
  .object({
    v: z.literal(1),
    ownerServerId: id,
    hostId: id,
    requestId: z.string().uuid(),
    command: attentionCommand,
  })
  .strict();
const attentionStatus = z
  .object({ v: z.literal(1), ownerServerId: id, requestId: z.string().uuid() })
  .strict();
export const attentionReceipt = z
  .object({
    v: z.literal(1),
    state: z.enum(["completed", "refused", "unknown", "unavailable"]),
    ownerServerId: id.nullable(),
    hostId: id.nullable(),
    requestId: z.string().uuid(),
    receiptId: z.string().nullable(),
    results: z
      .array(
        z.object({
          threadId: id,
          ok: z.boolean(),
          error: z.string().nullable(),
        }),
      )
      .max(200),
    reason: z.string().nullable(),
  })
  .strict();
export const operationsRpcContract = defineRpcContract({
  automation_run: { input: automationInput, output: automationReceipt },
  automation_run_status: { input: automationInput, output: automationReceipt },
  automation_dispatch: { input: automationDispatch, output: automationReceipt },
  usage_snapshot_get: { input: z.null(), output: usageSnapshot },
  usage_snapshot_fetch: {
    input: z.object({ machine }).strict(),
    output: usageResult,
  },
  attention_inbox_fetch: {
    input: z.object({ machine }).strict(),
    output: z
      .object({
        state: z.enum(["ok", "unavailable"]),
        reason: z.string().nullable(),
        snapshot: attentionSnapshot.nullable(),
      })
      .strict(),
  },
  attention_action_dispatch: {
    input: attentionAction.extend({ machine }).strict(),
    output: attentionReceipt,
  },
  attention_action_status: {
    input: attentionStatus.extend({ machine }).strict(),
    output: attentionReceipt,
  },
});
export interface OwnerTransport {
  call<P extends OwnerPlugin>(
    plugin: P,
    method: OwnerMethod<P>,
    input: unknown,
    mutation: boolean,
  ): Promise<OwnerCallOutcome>;
}
type Identity = { serverId: string; hostId: string | null };
export interface OwnerOperationsDeps {
  bb: BbPluginApi;
  localOwner(): Promise<Identity>;
  localMachine: Machine;
  snapshot(machine: Machine): Promise<Snapshot | null>;
  transport(machine: Machine): OwnerTransport | null;
  now?: () => number;
}
const hash = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
const message = (error: unknown) =>
  error instanceof Error
    ? error.message.slice(0, 500)
    : "Owner operation failed";

export function createOwnerOperations(deps: OwnerOperationsDeps) {
  const { bb } = deps,
    now = deps.now ?? Date.now,
    db = bb.storage.database();
  db.exec(
    "CREATE TABLE IF NOT EXISTS fleet_owner_operations(namespace TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,request_key))",
  );
  const loggedStatuses = new Set<string>();
  type Stored = { fingerprint: string; value: string };
  const get = (namespace: string, key: string) =>
    db
      .prepare(
        "SELECT fingerprint,value FROM fleet_owner_operations WHERE namespace=? AND request_key=?",
      )
      .get(namespace, key) as Stored | undefined;
  const save = (namespace: string, key: string, value: unknown) =>
    db
      .prepare(
        "UPDATE fleet_owner_operations SET value=? WHERE namespace=? AND request_key=?",
      )
      .run(JSON.stringify(value), namespace, key);
  const claim = (
    namespace: string,
    key: string,
    fingerprint: string,
    value: unknown,
  ) =>
    db
      .prepare("INSERT OR IGNORE INTO fleet_owner_operations VALUES(?,?,?,?)")
      .run(namespace, key, fingerprint, JSON.stringify(value)).changes > 0;
  const auto = (
    input: z.infer<typeof automationInput>,
    state: z.infer<typeof automationReceipt>["state"],
    reason: string | null,
  ): z.infer<typeof automationReceipt> => ({
    state,
    ownerServerId: input.ownerServerId,
    hostId: input.hostId,
    runId: null,
    threadId: null,
    runStatus: null,
    reason,
  });
  const attention = (
    input: z.infer<typeof attentionStatus>,
    state: z.infer<typeof attentionReceipt>["state"],
    reason: string | null,
    hostId: string | null = null,
  ): z.infer<typeof attentionReceipt> => ({
    v: 1,
    state,
    ownerServerId: input.ownerServerId,
    hostId,
    requestId: input.requestId,
    receiptId: null,
    results: [],
    reason,
  });
  const rpc = <T>(
    pluginId: string,
    method: string,
    input: unknown,
    outputSchema: z.ZodType<T>,
  ) =>
    bb.sdk.plugins.callRpc({
      pluginId,
      method,
      input: input as Parameters<typeof bb.sdk.plugins.callRpc>[0]["input"],
      outputSchema,
      signal: AbortSignal.timeout(20_000),
    });
  async function route(
    target: Machine,
    expected?: { ownerServerId: string; hostId?: string },
  ): Promise<{
    identity: Identity;
    local: boolean;
    transport: OwnerTransport | null;
  }> {
    if (target === deps.localMachine) {
      const own = await deps.localOwner();
      if (!own.serverId || !own.hostId)
        throw new Error("Local owner identity is unavailable.");
      if (
        expected &&
        (expected.ownerServerId !== own.serverId ||
          (expected.hostId !== undefined && expected.hostId !== own.hostId))
      )
        throw new Error(
          "Requested server or host does not match the local owner.",
        );
      return { identity: own, local: true, transport: null };
    }
    const transport = deps.transport(target);
    if (!transport)
      throw new Error(
        "No authenticated owner route is available for this machine.",
      );
    const snapshot = await deps.snapshot(target);
    if (
      !snapshot ||
      !transport ||
      snapshot.machineKey !== target ||
      !snapshot.ownerHostId ||
      now() - snapshot.publishedAt > 10_000 ||
      snapshot.publishedAt > now() + 5000
    )
      throw new Error(
        "A fresh authenticated owner snapshot is unavailable.",
      );
    if (
      expected &&
      (snapshot.serverId !== expected.ownerServerId ||
        (expected.hostId !== undefined &&
          snapshot.ownerHostId !== expected.hostId))
    )
      throw new Error(
        "Fresh owner server or host does not match the request.",
      );
    return {
      identity: { serverId: snapshot.serverId, hostId: snapshot.ownerHostId },
      local: false,
      transport,
    };
  }
  async function callOwner(
    r: Awaited<ReturnType<typeof route>>,
    plugin: OwnerPlugin,
    method: OwnerMethod,
    input: unknown,
    mutation: boolean,
  ): Promise<OwnerCallOutcome> {
    if (!r.local)
      return r
        .transport!.call(plugin, method, input, mutation)
        .catch((error) => ({
          ok: false,
          kind: mutation ? "unknown" : "unavailable",
          message: message(error),
        }));
    try {
      return {
        ok: true,
        result: await rpc(plugin, method, input, z.unknown()),
      };
    } catch (error) {
      return {
        ok: false,
        kind: mutation ? "unknown" : "unavailable",
        message: message(error),
      };
    }
  }
  async function ownerMatches(input: z.infer<typeof automationInput>) {
    const own = await deps.localOwner();
    if (
      !own.serverId ||
      own.serverId !== input.ownerServerId ||
      own.hostId !== input.hostId
    )
      throw new Error(
        "Automation owner server or primary host does not match.",
      );
    if (
      !(await bb.sdk.hosts.list()).some(
        (host) => host.id === input.hostId && host.status === "connected",
      )
    )
      throw new Error("Requested execution host is not connected.");
  }
  async function automationRunStatus(raw: z.infer<typeof automationInput>) {
    const input = automationInput.parse(raw);
    const own = await deps.localOwner();
    if (own.serverId !== input.ownerServerId || own.hostId !== input.hostId)
      return auto(input, "refused", "Automation owner does not match.");
    const prior = get("automation-owner", input.idempotencyKey);
    if (!prior) return auto(input, "unavailable", "no-receipt");
    if (prior.fingerprint !== hash(input))
      return auto(
        input,
        "refused",
        "Idempotency key was reused with different intent.",
      );
    const stored = automationReceipt.parse(JSON.parse(prior.value));
    if (
      !stored.runId ||
      stored.state === "unknown" ||
      stored.state === "refused"
    )
      return stored;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const response = await rpc(
          "automations",
          "automations_runs",
          {
            projectId: input.projectId,
            automationId: input.automationId,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          },
          z
            .object({
              runs: z
                .array(
                  z
                    .object({
                      id: z.string(),
                      automationId: z.string(),
                      threadId: z.string().nullable(),
                      status: z.enum([
                        "running",
                        "succeeded",
                        "failed",
                        "skipped",
                      ]),
                    })
                    .passthrough(),
                )
                .max(200),
              nextCursor: z.string().nullable(),
            })
            .strict(),
        );
        const run = response.runs.find(
          (run) =>
            run.id === stored.runId && run.automationId === input.automationId,
        );
        if (run) {
          const current = {
            ...stored,
            threadId: run.threadId,
            runStatus: run.status,
            reason: null,
          };
          save("automation-owner", input.idempotencyKey, current);
          return current;
        }
        if (!response.nextCursor || response.nextCursor === cursor) break;
        cursor = response.nextCursor;
      }
      return {
        ...stored,
        runStatus: null,
        reason:
          "Run receipt exists; current status was not found within the bounded owner history.",
      };
    } catch (error) {
      return {
        ...stored,
        runStatus: null,
        reason: `Run receipt exists; current owner status is unavailable: ${message(error)}`,
      };
    }
  }
  async function automationRun(raw: z.infer<typeof automationInput>) {
    const input = automationInput.parse(raw),
      fingerprint = hash(input);
    const prior = get("automation-owner", input.idempotencyKey);
    if (prior) {
      const own = await deps.localOwner();
      if (
        own.serverId !== input.ownerServerId ||
        own.hostId !== input.hostId ||
        prior.fingerprint !== fingerprint
      )
        return auto(
          input,
          "refused",
          "Owner or idempotency intent does not match.",
        );
      const result = automationReceipt.parse(JSON.parse(prior.value));
      return result.state === "started"
        ? { ...result, state: "deduped" as const }
        : result;
    }
    let guard: {
      updatedAt: number;
      executionFingerprint: string;
      resolvedHostId: string | null;
      experimental_hostGuard: true;
      execution: { mode: "agent" | "script" };
    };
    try {
      await ownerMatches(input);
      guard = await rpc(
        "automations",
        "experimental_automations_execution_guard",
        { projectId: input.projectId, automationId: input.automationId },
        z
          .object({
            updatedAt: z.number().int().nonnegative(),
            executionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            resolvedHostId: z.string().nullable(),
            experimental_hostGuard: z.literal(true),
            execution: z
              .object({ mode: z.enum(["agent", "script"]) })
              .passthrough(),
          })
          .strict(),
      );
      if (guard.resolvedHostId !== input.hostId)
        throw new Error(
          "Saved automation resolves to a different or unknown execution host.",
        );
      await ownerMatches(input);
    } catch (error) {
      return auto(input, "refused", message(error));
    }
    const pending = auto(
      input,
      "unknown",
      "Durable execution intent recorded; completion unknown. Do not resend.",
    );
    if (!claim("automation-owner", input.idempotencyKey, fingerprint, pending))
      return automationRunStatus(input);
    let result = pending;
    try {
      const response = await rpc(
        "automations",
        "automations_run",
        {
          projectId: input.projectId,
          automationId: input.automationId,
          idempotencyKey: input.idempotencyKey,
          experimental_expectedUpdatedAt: guard.updatedAt,
          experimental_expectedHostId: input.hostId,
          experimental_expectedExecutionFingerprint: guard.executionFingerprint,
        },
        z
          .object({
            run: z
              .object({
                id: z.string(),
                automationId: z.string(),
                threadId: z.string().nullable(),
                status: z.string(),
              })
              .passthrough(),
          })
          .strict(),
      );
      if (response.run.automationId !== input.automationId)
        throw new Error("Automation run receipt names another saved task.");
      result = {
        ...pending,
        state: "started",
        runId: response.run.id,
        threadId: response.run.threadId,
        runStatus: response.run.status,
        reason: null,
      };
    } catch (error) {
      result = { ...pending, reason: message(error) };
    }
    save("automation-owner", input.idempotencyKey, result);
    return result;
  }
  async function automationDispatchHandler(
    raw: z.infer<typeof automationDispatch>,
  ) {
    const { machine: target, ...input } = automationDispatch.parse(raw);
    let r: Awaited<ReturnType<typeof route>>;
    try {
      r = await route(target, input);
    } catch (error) {
      return auto(input, "unavailable", message(error));
    }
    if (r.local) return automationRun(input);
    const fingerprint = hash(input),
      prior = get("automation-source", input.idempotencyKey);
    if (prior && prior.fingerprint !== fingerprint)
      return auto(
        input,
        "refused",
        "Idempotency key was reused with different intent.",
      );
    if (prior) {
      const stored = automationReceipt.parse(JSON.parse(prior.value));
      if (stored.state !== "unknown" && stored.state !== "unavailable")
        return stored.state === "started"
          ? { ...stored, state: "deduped" as const }
          : stored;
      if (stored.state === "unknown") {
        const response = await callOwner(
          r,
          "fleet",
          "automation_run_status",
          input,
          false,
        );
        if (response.ok) {
          const parsed = automationReceipt.safeParse(response.result);
          if (
            parsed.success &&
            parsed.data.ownerServerId === input.ownerServerId &&
            parsed.data.hostId === input.hostId &&
            ["started", "deduped", "refused"].includes(parsed.data.state)
          ) {
            save("automation-source", input.idempotencyKey, parsed.data);
            return parsed.data;
          }
        }
        return stored;
      }
    }
    const pending = auto(
      input,
      "unknown",
      "Owner delivery outcome is unknown; use status, never resend.",
    );
    if (
      !prior &&
      !claim("automation-source", input.idempotencyKey, fingerprint, pending)
    )
      return auto(
        input,
        "unknown",
        "Concurrent dispatch claimed this intent; inspect its receipt.",
      );
    if (prior) save("automation-source", input.idempotencyKey, pending);
    const response = await callOwner(r, "fleet", "automation_run", input, true);
    let result = response.ok
      ? automationReceipt.safeParse(response.result)
      : null;
    const receipt =
      result?.success &&
      result.data.ownerServerId === input.ownerServerId &&
      result.data.hostId === input.hostId
        ? result.data
        : auto(
            input,
            response.ok ? "unknown" : response.kind,
            response.ok
              ? "Owner receipt was invalid or mismatched."
              : response.message,
          );
    save("automation-source", input.idempotencyKey, receipt);
    return receipt;
  }
  async function usageSnapshotGet(raw: null) {
    z.null().parse(raw);
    const own = await deps.localOwner();
    if (!own.serverId || !own.hostId)
      throw new Error("Owner identity unavailable.");
    const limits = await bb.sdk.system.usageLimits({
      hostId: own.hostId,
      refresh: true,
    });
    const providers = Object.entries(limits)
      .slice(0, 30)
      .map(([providerId, value]) => {
        const stable = z
          .string()
          .regex(/^bbsub1:[0-9a-f]{40}$/)
          .safeParse(
            value.status === "ok"
              ? (value as { experimental_subscriptionId?: unknown })
                  .experimental_subscriptionId
              : null,
          );
        const windows =
          value.status === "ok"
            ? value.windows.slice(0, 50).map((w) => ({
                label: w.label,
                usedPercent: Number.isFinite(w.usedPercent)
                  ? w.usedPercent
                  : null,
                resetsAt: w.resetsAt,
              }))
            : [];
        return {
          providerId,
          status:
            value.status === "ok"
              ? ("ok" as const)
              : value.status === "error"
                ? ("error" as const)
                : ("unavailable" as const),
          subscriptionId: stable.success ? stable.data : null,
          identity: stable.success
            ? ("verified" as const)
            : ("unknown" as const),
          planLabel:
            "planLabel" in value && typeof value.planLabel === "string"
              ? value.planLabel
              : null,
          windows,
          method: "bb.system.usageLimits" as const,
          observationId: randomUUID(),
        };
      });
    return usageSnapshot.parse({
      ownerServerId: own.serverId,
      hostId: own.hostId,
      observedAt: now(),
      providers,
    });
  }
  async function usageSnapshotFetch(raw: { machine: Machine }) {
    const { machine: target } =
      operationsRpcContract.usage_snapshot_fetch.input.parse(raw);
    try {
      const r = await route(target),
        response = r.local
          ? { ok: true as const, result: await usageSnapshotGet(null) }
          : await callOwner(r, "fleet", "usage_snapshot_get", null, false);
      if (!response.ok) throw new Error(response.message);
      const snapshot = usageSnapshot.parse(response.result);
      if (
        snapshot.ownerServerId !== r.identity.serverId ||
        snapshot.hostId !== r.identity.hostId ||
        now() - snapshot.observedAt > 30_000 ||
        snapshot.observedAt > now() + 5000
      )
        throw new Error(
          "Usage observation identity or freshness does not match the owner.",
        );
      return { state: "ok" as const, reason: null, snapshot };
    } catch (error) {
      return {
        state: "unavailable" as const,
        reason: message(error),
        snapshot: null,
      };
    }
  }
  async function attentionInboxFetch(raw: { machine: Machine }) {
    const { machine: target } =
      operationsRpcContract.attention_inbox_fetch.input.parse(raw);
    try {
      const r = await route(target),
        response = await callOwner(
          r,
          "navaigate-skin",
          "attention_owner_inbox",
          { v: 1, ownerServerId: r.identity.serverId },
          false,
        );
      if (!response.ok) throw new Error(response.message);
      const read = attentionSnapshotRaw.parse(response.result);
      const odd = new Map<string, number>();
      const snapshot = attentionSnapshot.parse({
        ...read,
        rows: read.rows.map((row) => {
          const known = attentionStatusName.safeParse(row.status);
          if (known.success) return { ...row, status: known.data };
          const name =
            typeof row.status === "string" && row.status
              ? row.status.slice(0, 60)
              : row.status == null
                ? "(missing)"
                : "(not text)";
          odd.set(name, (odd.get(name) ?? 0) + 1);
          return { ...row, status: "needs-you" as const };
        }),
      });
      // One log line per Mac per odd status, not one per row or per read.
      for (const [name, count] of odd) {
        const key = `${target}:${name}`;
        if (loggedStatuses.has(key)) continue;
        if (loggedStatuses.size > 200) loggedStatuses.clear();
        loggedStatuses.add(key);
        bb.log.warn(
          `${target} sent ${count} attention row(s) with status ${JSON.stringify(name)}; shown as needs-you`,
        );
      }
      if (
        snapshot.ownerServerId !== r.identity.serverId ||
        snapshot.hostId !== r.identity.hostId ||
        now() - snapshot.observedAt > 30_000 ||
        snapshot.observedAt > now() + 5000
      )
        throw new Error(
          "Attention observation identity or freshness does not match the owner.",
        );
      return { state: "ok" as const, reason: null, snapshot };
    } catch (error) {
      return {
        state: "unavailable" as const,
        reason: message(error),
        snapshot: null,
      };
    }
  }
  async function attentionActionStatus(
    raw: z.infer<typeof attentionStatus> & { machine: Machine },
  ) {
    const { machine: target, ...input } =
      operationsRpcContract.attention_action_status.input.parse(raw);
    try {
      const r = await route(target, input),
        response = await callOwner(
          r,
          "navaigate-skin",
          "attention_owner_receipt",
          input,
          false,
        );
      if (!response.ok)
        return attention(
          input,
          "unavailable",
          response.message,
          r.identity.hostId,
        );
      const result = attentionReceipt.parse(response.result);
      if (
        result.ownerServerId !== input.ownerServerId ||
        result.hostId !== r.identity.hostId ||
        result.requestId !== input.requestId
      )
        throw new Error("Attention receipt identity does not match.");
      return result;
    } catch (error) {
      return attention(input, "unavailable", message(error));
    }
  }
  async function attentionActionDispatch(
    raw: z.infer<typeof attentionAction> & { machine: Machine },
  ) {
    const { machine: target, ...input } =
      operationsRpcContract.attention_action_dispatch.input.parse(raw);
    let r: Awaited<ReturnType<typeof route>>;
    try {
      r = await route(target, input);
    } catch (error) {
      return attention(input, "unavailable", message(error), input.hostId);
    }
    const fingerprint = hash(input),
      prior = get("attention-source", input.requestId);
    if (prior && prior.fingerprint !== fingerprint)
      return attention(
        input,
        "refused",
        "Request ID was reused with different attention intent.",
        input.hostId,
      );
    if (prior) {
      const stored = attentionReceipt.parse(JSON.parse(prior.value));
      if (stored.state !== "unknown" && stored.state !== "unavailable")
        return stored;
      if (stored.state === "unknown") {
        const result = await attentionActionStatus({
          machine: target,
          v: 1,
          ownerServerId: input.ownerServerId,
          requestId: input.requestId,
        });
        if (result.state === "completed" || result.state === "refused") {
          save("attention-source", input.requestId, result);
          return result;
        }
        return stored;
      }
    }
    const pending = attention(
      input,
      "unknown",
      "Durable owner dispatch intent recorded; use status, never resend.",
      input.hostId,
    );
    if (
      !prior &&
      !claim("attention-source", input.requestId, fingerprint, pending)
    )
      return pending;
    if (prior) save("attention-source", input.requestId, pending);
    const response = await callOwner(
      r,
      "navaigate-skin",
      "attention_owner_action",
      input,
      true,
    );
    const parsed = response.ok
      ? attentionReceipt.safeParse(response.result)
      : null;
    const result =
      parsed?.success &&
      parsed.data.ownerServerId === input.ownerServerId &&
      parsed.data.hostId === input.hostId &&
      parsed.data.requestId === input.requestId
        ? parsed.data
        : attention(
            input,
            response.ok ? "unknown" : response.kind,
            response.ok
              ? "Owner receipt was invalid or mismatched."
              : response.message,
            input.hostId,
          );
    save("attention-source", input.requestId, result);
    return result;
  }
  return {
    handlers: {
      automation_run: automationRun,
      automation_run_status: automationRunStatus,
      automation_dispatch: automationDispatchHandler,
      usage_snapshot_get: usageSnapshotGet,
      usage_snapshot_fetch: usageSnapshotFetch,
      attention_inbox_fetch: attentionInboxFetch,
      attention_action_dispatch: attentionActionDispatch,
      attention_action_status: attentionActionStatus,
    } satisfies PluginRpcHandlers<typeof operationsRpcContract>,
  };
}

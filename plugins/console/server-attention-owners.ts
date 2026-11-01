import { createHash } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  attentionInput,
  attentionPolicy,
  attentionRow,
  type createAttention,
} from "./server-attention";
import { knownMachine, machineKeys, machineName } from "./server-words";
const id = z.string().min(1).max(128);
const machine = z.string().min(1).max(40);
export const ownerAttentionRead = z.object({ v: z.literal(1), ownerServerId: id }).strict();
export const ownerAttentionSnapshot = z
  .object({
    v: z.literal(1),
    ownerServerId: id,
    hostId: id.nullable(),
    observedAt: z.number(),
    rows: z.array(attentionRow).max(500),
    truncated: z.boolean(),
  })
  .strict();
export const ownerAttentionCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("apply"), input: attentionInput }).strict(),
  z.object({ kind: z.literal("undo"), receiptId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("policy"), threadId: id, policy: attentionPolicy }).strict(),
]);
export const ownerAttentionAction = ownerAttentionRead
  .extend({ hostId: id, requestId: z.string().uuid(), command: ownerAttentionCommand })
  .strict();
export const ownerAttentionStatus = ownerAttentionRead
  .extend({ requestId: z.string().uuid() })
  .strict();
export const ownerAttentionReceipt = z
  .object({
    v: z.literal(1),
    state: z.enum(["completed", "refused", "unknown", "unavailable"]),
    ownerServerId: id.nullable(),
    hostId: id.nullable(),
    requestId: z.string().uuid(),
    receiptId: z.string().nullable(),
    results: z
      .array(z.object({ threadId: id, ok: z.boolean(), error: z.string().nullable() }))
      .max(200),
    reason: z.string().nullable(),
  })
  .strict();
export const fleetAttentionTarget = z
  .object({ machine: machine.optional(), ownerServerId: id, hostId: id, threadId: id })
  .strict();
export const fleetAttentionApply = z
  .object({
    requestId: z.string().uuid(),
    targets: z.array(fleetAttentionTarget).min(1).max(200),
    action: z.enum(["settle", "snooze", "restore", "retitle", "stash"]),
    wakeAt: z.number().int().optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const fleetAttentionPolicy = z
  .object({ requestId: z.string().uuid(), target: fleetAttentionTarget, policy: attentionPolicy })
  .strict();
export const fleetAttentionUndo = z
  .object({ requestId: z.string().uuid(), receiptId: z.string().uuid() })
  .strict();
// What another Mac's owner sends back. The status is read as it comes: one this
// Console has not heard of (a newer Mac), or none at all, is shown as needs-you
// so the row can be seen and settled, and it never costs the whole Mac.
const remoteAttentionRow = attentionRow.extend({ status: z.unknown().optional() });
const remoteAttentionSnapshot = ownerAttentionSnapshot.extend({ rows: z.array(remoteAttentionRow).max(500) });
type RemoteRow = z.infer<typeof remoteAttentionRow>;
export function normaliseOwnerRows(rows: readonly RemoteRow[]) {
  const unknown = new Map<string, number>();
  const out = rows.map((row) => {
    const known = attentionRow.shape.status.safeParse(row.status);
    if (known.success) return { ...row, status: known.data };
    const name = typeof row.status === "string" && row.status ? row.status.slice(0, 60) : row.status == null ? "(missing)" : "(not text)";
    unknown.set(name, (unknown.get(name) ?? 0) + 1);
    return { ...row, status: "needs-you" as const };
  });
  return { rows: out, unknown };
}
export const fetched = z
  .object({
    state: z.enum(["ok", "unavailable"]),
    reason: z.string().nullable(),
    snapshot: remoteAttentionSnapshot.nullable(),
  })
  .strict();
/** A reason that is a pasted validation dump ("[{ code: ...") reads as a plain sentence; anything else stays as written. */
export const RAW_REASON_LOG_MAX = 2000;
export const plainReason = (reason: string | null) =>
  !reason ? "owner attention unavailable" : /^\s*[[{]/.test(reason) ? "owner attention could not be read (unexpected reply)" : reason;
type OwnerReceipt = z.infer<typeof ownerAttentionReceipt>;
const planSchema = z.object({
  machine: machine.optional(),
  threadIds: z.array(id).max(200),
  input: ownerAttentionAction,
  receipt: ownerAttentionReceipt.nullable(),
});
type Planned = z.infer<typeof planSchema>;
const uuid = (value: string) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function createAttentionOwners(
  bb: BbPluginApi,
  attention: ReturnType<typeof createAttention>,
  localOwner: () => Promise<string | null>,
) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS nav_attention_owner_requests(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nav_attention_source_requests(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,value TEXT NOT NULL);`);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  };
  const receipt = (
    input: z.infer<typeof ownerAttentionStatus>,
    state: OwnerReceipt["state"],
    reason: string | null,
    hostId: string | null = null,
  ): OwnerReceipt => ({
    v: 1,
    state,
    ownerServerId: input.ownerServerId,
    hostId,
    requestId: input.requestId,
    receiptId: null,
    results: [],
    reason,
  });
  async function identity() {
    return {
      ownerServerId: await localOwner(),
      hostId: (await bb.sdk.system.config()).primaryHostId,
    };
  }
  async function ownerInbox(raw: z.infer<typeof ownerAttentionRead>) {
    const input = ownerAttentionRead.parse(raw),
      own = await identity();
    if (!own.ownerServerId || own.ownerServerId !== input.ownerServerId)
      throw new Error("This is not the requested attention owner.");
    const result = await attention.inbox();
    return {
      v: 1 as const,
      ownerServerId: own.ownerServerId,
      hostId: own.hostId,
      observedAt: Date.now(),
      rows: result.rows.slice(0, 500),
      truncated: result.truncated || result.rows.length > 500,
    };
  }
  async function ownerStatus(raw: z.infer<typeof ownerAttentionStatus>) {
    const input = ownerAttentionStatus.parse(raw),
      own = await identity();
    if (!own.ownerServerId || own.ownerServerId !== input.ownerServerId)
      return receipt(input, "refused", "This is not the requested attention owner.", own.hostId);
    const row = db
      .prepare("SELECT value FROM nav_attention_owner_requests WHERE request_id=?")
      .get(input.requestId) as { value: string } | undefined;
    return row
      ? ownerAttentionReceipt.parse(JSON.parse(row.value))
      : receipt(input, "unavailable", "no-receipt", own.hostId);
  }
  async function ownerAction(raw: z.infer<typeof ownerAttentionAction>) {
    const input = ownerAttentionAction.parse(raw);
    return serial(async () => {
      const own = await identity();
      if (
        !own.ownerServerId ||
        own.ownerServerId !== input.ownerServerId ||
        own.hostId !== input.hostId
      )
        return receipt(
          input,
          "refused",
          "Owner server or primary host does not match.",
          own.hostId,
        );
      const fingerprint = digest({
        ownerServerId: input.ownerServerId,
        hostId: input.hostId,
        command: input.command,
      });
      const prior = db
        .prepare("SELECT fingerprint,value FROM nav_attention_owner_requests WHERE request_id=?")
        .get(input.requestId) as { fingerprint: string; value: string } | undefined;
      if (prior)
        return prior.fingerprint === fingerprint
          ? ownerAttentionReceipt.parse(JSON.parse(prior.value))
          : receipt(
              input,
              "refused",
              "Request ID was reused with different attention intent.",
              own.hostId,
            );
      const claimed = receipt(
        input,
        "unknown",
        "Action intent is durable; completion is not yet recorded. Do not repeat it.",
        own.hostId,
      );
      db.prepare("INSERT INTO nav_attention_owner_requests VALUES(?,?,?)").run(
        input.requestId,
        fingerprint,
        JSON.stringify(claimed),
      );
      let result: OwnerReceipt;
      try {
        if (input.command.kind === "policy") {
          const thread = await bb.sdk.threads.get({ threadId: input.command.threadId });
          if (thread.visibility === "hidden" || thread.deletedAt || thread.archivedAt)
            throw new Error("Policy target is not a visible owning thread.");
          await attention.configure(input.command.threadId, input.command.policy);
          result = {
            ...claimed,
            state: "completed",
            results: [{ threadId: input.command.threadId, ok: true, error: null }],
            reason: null,
          };
        } else {
          const applied =
            input.command.kind === "apply"
              ? await attention.apply(input.command.input)
              : await attention.undo(input.command.receiptId);
          result = {
            ...claimed,
            state: "completed",
            receiptId: applied.receiptId,
            results: applied.results,
            reason: null,
          };
        }
      } catch (e) {
        result = {
          ...claimed,
          state: "unknown",
          reason: `Action outcome is unknown: ${String(e).slice(0, 400)}`,
        };
      }
      db.prepare("UPDATE nav_attention_owner_requests SET value=? WHERE request_id=?").run(
        JSON.stringify(result),
        input.requestId,
      );
      return result;
    });
  }
  async function send(plan: Planned, statusOnly: boolean) {
    if ((await localOwner()) === plan.input.ownerServerId)
      return statusOnly
        ? ownerStatus({
            v: 1,
            ownerServerId: plan.input.ownerServerId,
            requestId: plan.input.requestId,
          })
        : ownerAction(plan.input);
    if (!plan.machine)
      return receipt(plan.input, "unavailable", "No verified destination machine was selected.");
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "fleet",
        method: statusOnly ? "attention_action_status" : "attention_action_dispatch",
        input: statusOnly
          ? {
              machine: plan.machine,
              v: 1,
              ownerServerId: plan.input.ownerServerId,
              requestId: plan.input.requestId,
            }
          : { machine: plan.machine, ...plan.input },
        outputSchema: ownerAttentionReceipt,
        signal: AbortSignal.timeout(20_000),
      });
      if (
        result.requestId !== plan.input.requestId ||
        (result.ownerServerId !== null && result.ownerServerId !== plan.input.ownerServerId) ||
        (result.hostId !== null && result.hostId !== plan.input.hostId)
      )
        return receipt(
          plan.input,
          "unknown",
          "Owner receipt identity does not match this request.",
        );
      return result;
    } catch {
      return receipt(
        plan.input,
        "unknown",
        "Owner response is unknown; only a receipt status read is allowed.",
      );
    }
  }
  const sourceRow = (requestId: string) =>
    db
      .prepare("SELECT fingerprint,value FROM nav_attention_source_requests WHERE request_id=?")
      .get(requestId) as { fingerprint: string; value: string } | undefined;
  const sourceSave = (requestId: string, plans: Planned[]) =>
    db
      .prepare("UPDATE nav_attention_source_requests SET value=? WHERE request_id=?")
      .run(JSON.stringify(plans), requestId);
  const resultFor = (requestId: string, plans: Planned[]) => ({
    receiptId: requestId,
    results: plans.flatMap((plan) => {
      const targetIds = plan.threadIds;
      return targetIds.map(
        (threadId) =>
          plan.receipt?.results.find((r) => r.threadId === threadId) ??
          (plan.receipt?.state === "completed" &&
          plan.input.command.kind === "undo" &&
          plan.receipt.results.length === 0
            ? { threadId, ok: true, error: null }
            : {
                threadId,
                ok: false,
                error: `${plan.machine}: ${plan.receipt?.reason ?? "Owner completion is unknown"}`,
              }),
      );
    }),
  });
  async function sourceRun(requestId: string, fingerprint: string, plans: Planned[]) {
    const prior = sourceRow(requestId);
    if (prior && prior.fingerprint !== fingerprint)
      throw new Error("Request ID was reused with different attention intent.");
    const statusOnly = !!prior;
    if (prior) plans = z.array(planSchema).parse(JSON.parse(prior.value));
    else
      db.prepare("INSERT INTO nav_attention_source_requests VALUES(?,?,?)").run(
        requestId,
        fingerprint,
        JSON.stringify(plans),
      );
    for (const plan of plans) {
      if (plan.receipt && plan.receipt.state !== "unknown") continue;
      plan.receipt = await send(plan, statusOnly);
      sourceSave(requestId, plans);
    }
    inboxCache = null;
    bb.realtime.publish("attention", null);
    return resultFor(requestId, plans);
  }
  async function fleetApply(raw: z.infer<typeof fleetAttentionApply>) {
    const input = fleetAttentionApply.parse(raw),
      groups = new Map<string, z.infer<typeof fleetAttentionTarget>[]>();
    for (const target of input.targets)
      groups.set(target.ownerServerId, [...(groups.get(target.ownerServerId) ?? []), target]);
    const plans: Planned[] = [...groups.values()].map((targets) => {
      const first = targets[0]!;
      if (targets.some((t) => t.hostId !== first.hostId || t.machine !== first.machine))
        throw new Error("One owner cannot be addressed as different hosts or machines.");
      return {
        machine: first.machine,
        threadIds: [...new Set(targets.map((t) => t.threadId))],
        input: {
          v: 1,
          ownerServerId: first.ownerServerId,
          hostId: first.hostId,
          requestId: uuid(`${input.requestId}:${first.ownerServerId}`),
          command: {
            kind: "apply",
            input: {
              threadIds: [...new Set(targets.map((t) => t.threadId))],
              action: input.action,
              ...(input.wakeAt === undefined ? {} : { wakeAt: input.wakeAt }),
              ...(input.title === undefined ? {} : { title: input.title }),
            },
          },
        },
        receipt: null,
      };
    });
    return sourceRun(input.requestId, digest(input), plans);
  }
  async function sourceStatus(requestId: string) {
    const prior = sourceRow(z.string().uuid().parse(requestId));
    if (!prior) throw new Error("Unknown source attention receipt.");
    return sourceRun(
      requestId,
      prior.fingerprint,
      z.array(planSchema).parse(JSON.parse(prior.value)),
    );
  }
  async function fleetUndo(raw: z.infer<typeof fleetAttentionUndo>) {
    const input = fleetAttentionUndo.parse(raw),
      prior = sourceRow(input.receiptId);
    if (!prior) throw new Error("Unknown source attention receipt.");
    const previous = z.array(planSchema).parse(JSON.parse(prior.value));
    const plans: Planned[] = previous
      .filter((p) => p.receipt?.state === "completed" && p.receipt.receiptId)
      .map((p) => ({
        machine: p.machine,
        threadIds: p.threadIds,
        input: {
          ...p.input,
          requestId: uuid(`${input.requestId}:${p.input.ownerServerId}`),
          command: { kind: "undo", receiptId: p.receipt!.receiptId! },
        },
        receipt: null,
      }));
    return sourceRun(input.requestId, digest(input), plans);
  }
  async function fleetPolicy(raw: z.infer<typeof fleetAttentionPolicy>) {
    const input = fleetAttentionPolicy.parse(raw),
      target = input.target;
    return sourceRun(input.requestId, digest(input), [
      {
        machine: target.machine,
        threadIds: [target.threadId],
        input: {
          v: 1,
          ownerServerId: target.ownerServerId,
          hostId: target.hostId,
          requestId: uuid(`${input.requestId}:${target.ownerServerId}`),
          command: { kind: "policy", threadId: target.threadId, policy: input.policy },
        },
        receipt: null,
      },
    ]);
  }
  // One log line per Mac per odd status or refusal, not one per row or per refresh.
  const logged = new Set<string>();
  const logOnce = (key: string, line: string) => {
    if (logged.has(key)) return;
    if (logged.size > 200) logged.clear();
    logged.add(key);
    bb.log.warn(line);
  };
  type InboxValue = Awaited<ReturnType<typeof collectInbox>>;
  const INBOX_TTL_MS = 5000;
  const INBOX_FAILURE_COOLDOWN_MS = 3000;
  const INBOX_STALE_LIMIT_MS = 120_000;
  let inboxCache: { until: number; at: number; value: InboxValue } | null = null;
  let inboxPending: Promise<InboxValue> | null = null;
  let inboxFailure: { until: number; error: unknown } | null = null;
  let inboxEpoch = 0;
  async function collectInbox() {
    const own = await identity(),
      local = await attention.inbox();
    const rows = local.rows.map((r) => ({
      ...r,
      remote: false,
      ownerServerId: own.ownerServerId,
      ownerHostId: own.hostId,
      machine: undefined as z.infer<typeof machine> | undefined,
    }));
    const notices: string[] = [],
      seen = new Set(own.ownerServerId ? [own.ownerServerId] : []);
    const targets = machineKeys();
    const fetchedByTarget = await Promise.all(
      targets.map((target) =>
        bb.sdk.plugins
          .callRpc({
            pluginId: "fleet",
            method: "attention_inbox_fetch",
            input: { machine: target },
            outputSchema: fetched,
            signal: AbortSignal.timeout(10_000),
          })
          .then(
            (result) => ({ result }),
            () => ({ result: null }),
          ),
      ),
    );
    targets.forEach((target, index) => {
      const result = fetchedByTarget[index]!.result;
      if (!result) {
        notices.push(`${machineName(target)}: owner attention read unavailable`);
        return;
      }
      const s = result.snapshot;
      if (result.state !== "ok" || !s) {
        notices.push(`${machineName(target)}: ${plainReason(result.reason)}`);
        if (result.reason && plainReason(result.reason) !== result.reason) logOnce(`reason:${target}:${result.reason.slice(0, 200)}`, `${target} attention read refused: ${result.reason.slice(0, RAW_REASON_LOG_MAX)}`);
        return;
      }
      if (s.ownerServerId === own.ownerServerId) {
        for (const row of rows) if (!row.remote) row.machine = target;
        return;
      }
      if (seen.has(s.ownerServerId)) return;
      seen.add(s.ownerServerId);
      if (Date.now() - s.observedAt > 30_000 || s.observedAt > Date.now() + 5000) {
        notices.push(`${machineName(target)}: attention owner snapshot is stale`);
        return;
      }
      const normal = normaliseOwnerRows(s.rows);
      for (const [name, count] of normal.unknown) {
        notices.push(`${machineName(target)}: ${count} chat${count === 1 ? "" : "s"} with an unfamiliar status are shown as needing you`);
        logOnce(`status:${target}:${name}`, `${target} sent ${count} attention row(s) with status ${JSON.stringify(name)}; shown as needs-you`);
      }
      rows.push(
        ...normal.rows.map((r) => ({
          ...r,
          remote: true,
          ownerServerId: s.ownerServerId,
          ownerHostId: s.hostId,
          machine: target,
        })),
      );
      if (s.truncated) notices.push(`${machineName(target)}: first 500 threads shown`);
    });
    return {
      rows: rows.map(({ machine: target, ...row }) => ({
        ...row,
        ...(target ? { machine: target } : {}),
      })),
      truncated: local.truncated,
      notices,
    };
  }
  async function fleetInbox() {
    if (inboxCache && inboxCache.until > Date.now()) return inboxCache.value;
    if (inboxPending) return inboxPending;
    if (inboxFailure && inboxFailure.until > Date.now()) return staleOrThrow(inboxFailure.error);
    const epoch = inboxEpoch;
    const pending: Promise<InboxValue> = collectInbox()
      .then(
        (value) => {
          const now = Date.now();
          inboxCache = { until: epoch === inboxEpoch ? now + INBOX_TTL_MS : 0, at: now, value };
          inboxFailure = null;
          return value;
        },
        (error: unknown) => {
          inboxFailure = { until: Date.now() + INBOX_FAILURE_COOLDOWN_MS, error };
          return staleOrThrow(error);
        },
      )
      .finally(() => {
        if (inboxPending === pending) inboxPending = null;
      });
    inboxPending = pending;
    return pending;
  }
  function staleOrThrow(error: unknown): InboxValue {
    if (!inboxCache || Date.now() - inboxCache.at > INBOX_STALE_LIMIT_MS) throw error;
    const { value } = inboxCache;
    return { ...value, notices: [...value.notices, "Showing the last answer; refreshing owner attention failed"] };
  }
  const invalidateInbox = () => {
    inboxEpoch++;
    if (inboxCache) inboxCache.until = 0;
    inboxFailure = null;
  };
  bb.events.on("thread.active", invalidateInbox);
  bb.events.on("thread.idle", invalidateInbox);
  bb.events.on("thread.failed", invalidateInbox);
  bb.events.on("interaction.pending", invalidateInbox);
  return {
    ownerInbox,
    ownerAction,
    ownerStatus,
    fleetApply,
    fleetUndo,
    fleetPolicy,
    fleetInbox,
    sourceStatus,
  };
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const text = z.string().min(1).max(128);
export const hookConfig = z
  .object({
    id: text.regex(/^[a-z0-9_-]+$/),
    enabled: z.boolean().default(false),
    ownerServerId: text,
    machine: z.string().min(1).max(40).optional(),
    hostId: text,
    projectId: text,
    automationId: text,
    holdOffline: z.boolean().default(false),
    coalesceSeconds: z.number().int().min(0).max(3600).default(0),
    filters: z
      .array(
        z
          .object({
            path: z
              .string()
              .regex(/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/)
              .max(150),
            equals: z.union([z.string().max(300), z.number().finite(), z.boolean(), z.null()]),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type HookConfig = z.infer<typeof hookConfig>;
const hookBinding = hookConfig.pick({
  id: true,
  ownerServerId: true,
  machine: true,
  hostId: true,
  projectId: true,
  automationId: true,
});
const bindingFor = (hook: HookConfig) => hookBinding.strip().parse(hook);
const bindingHash = (hook: HookConfig) =>
  createHash("sha256")
    .update(JSON.stringify(bindingFor(hook)))
    .digest("hex");
export const eventReceipt = z.object({
  id: text,
  hookId: text,
  binding: hookBinding,
  bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  deliveryId: text,
  receivedAt: z.number(),
  expiresAt: z.number(),
  dueAt: z.number(),
  state: z.enum([
    "held",
    "refused",
    "accepted",
    "dispatching",
    "owner-accepted",
    "unknown",
    "expired",
    "coalesced",
  ]),
  runId: z.string().nullable(),
  count: z.number(),
  error: z.string().nullable(),
});
export const eventInboxState = z.object({
  enabled: z.boolean(),
  endpoint: z.string().nullable(),
  hooks: z.array(hookConfig),
  receipts: z.array(eventReceipt),
});
export type DispatchResult =
  | { kind: "offline" }
  | { kind: "admitted"; runId: string }
  | { kind: "refused"; reason: string }
  | { kind: "unknown" };
export type EventTransport = {
  available(config: HookConfig): Promise<boolean>;
  run(config: HookConfig, idempotencyKey: string): Promise<DispatchResult>;
};
const DAY = 86400_000,
  MAX_BYTES = 64 * 1024;
export function webhookSignature(
  secret: string,
  hookId: string,
  timestamp: string,
  deliveryId: string,
  body: string,
) {
  return `sha256=${createHmac("sha256", secret).update(`v1.${hookId}.${timestamp}.${deliveryId}.${body}`).digest("hex")}`;
}
export function verifyWebhook(
  secret: string,
  hookId: string,
  timestamp: string,
  deliveryId: string,
  body: string,
  signature: string,
  now: number,
) {
  if (
    !/^sha256=[0-9a-f]{64}$/.test(signature) ||
    secret.length < 32 ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 300_000 ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(deliveryId)
  )
    return false;
  const expected = webhookSignature(secret, hookId, timestamp, deliveryId, body);
  return (
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
function matches(body: unknown, config: HookConfig) {
  return config.filters.every((f) => {
    let v: unknown = body;
    for (const part of f.path.split(".")) {
      if (
        ["__proto__", "prototype", "constructor"].includes(part) ||
        !v ||
        typeof v !== "object" ||
        !Object.hasOwn(v, part)
      )
        return false;
      v = (v as Record<string, unknown>)[part];
    }
    return v === f.equals;
  });
}

/** Durable admission, replay receipts and coalescing; Automations remains the execution owner. */
export function createEventInbox(bb: BbPluginApi, transport: EventTransport, clock = Date.now, featureOn: (id: string) => boolean = () => true) {
  const settings = bb.settings.define({
    webhookEnabled: { type: "boolean", label: "Enable automation webhooks", default: false },
    webhookSecret: {
      type: "string",
      secret: true,
      label: "Webhook HMAC secret",
      description: "At least 32 characters. Shared with sender only; never returned to clients.",
      default: "",
    },
    webhookHooks: {
      type: "string",
      experimental_multiline: true,
      label: "Webhook tasks (stored by the Automation webhooks form)",
      description: "Written by the Automation webhooks section on this page. Edit tasks there; this field is the stored copy and the way to clear it from the CLI.",
      default: "[]",
      experimental_schema: z.string().refine((s) => {
        try {
          return z.array(hookConfig).max(50).safeParse(JSON.parse(s)).success;
        } catch {
          return false;
        }
      }, "Expected at most 50 valid task configurations"),
    },
    webhookPublicBaseUrl: {
      type: "string",
      label: "Existing BB Connect public base URL",
      description:
        "Optional HTTPS origin already exposed by BB Connect. No tunnel is created here.",
      default: "",
      experimental_schema: z.string().refine((s) => {
        if (!s) return true;
        try {
          const u = new URL(s);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash &&
            u.pathname === "/"
          );
        } catch {
          return false;
        }
      }, "Use an HTTPS origin without credentials or a path"),
    },
  });
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS nav_hook_events(id TEXT PRIMARY KEY, hook_id TEXT NOT NULL, delivery_id TEXT NOT NULL, digest TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(hook_id,delivery_id));
    CREATE INDEX IF NOT EXISTS nav_hook_events_task ON nav_hook_events(hook_id);`);
  type Receipt = z.infer<typeof eventReceipt>;
  const rows = () =>
    (
      db.prepare("SELECT value FROM nav_hook_events ORDER BY rowid").all() as { value: string }[]
    ).map((r) => eventReceipt.parse(JSON.parse(r.value)));
  const save = (r: Receipt) =>
    db.prepare("UPDATE nav_hook_events SET value = ? WHERE id = ?").run(JSON.stringify(r), r.id);
  const signal = () => bb.realtime.publish("automation-events", null);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  };
  async function config() {
    const s = await settings.get();
    return { ...s, hooks: z.array(hookConfig).max(50).parse(JSON.parse(s.webhookHooks)) };
  }
  async function state() {
    const s = await config();
    return {
      enabled: s.webhookEnabled,
      endpoint: s.webhookPublicBaseUrl
        ? `${s.webhookPublicBaseUrl.replace(/\/$/, "")}/api/v1/plugins/${bb.pluginId}/http/automation-hook`
        : null,
      hooks: s.hooks,
      receipts: rows().slice(-200).reverse(),
    };
  }
  async function tick() {
    return serial(async () => {
      const s = await config();
      for (const r of rows()) {
        if (r.receivedAt < clock() - 7 * DAY) {
          db.prepare("DELETE FROM nav_hook_events WHERE id = ?").run(r.id);
          continue;
        }
        if (["owner-accepted", "expired", "coalesced", "unknown", "refused"].includes(r.state))
          continue;
        // A process stopped after dispatch intent: ask the idempotent automation owner again using the same key.
        const hook = s.hooks.find((h) => h.id === r.hookId && h.enabled);
        if (r.expiresAt <= clock()) {
          save({ ...r, state: "expired", error: "Offline holding expired after 24 hours." });
          continue;
        }
        if (!s.webhookEnabled || !hook || r.dueAt > clock()) continue;
        if (bindingHash(hook) !== r.bindingFingerprint) {
          save({
            ...r,
            state: r.state === "dispatching" ? "unknown" : "refused",
            error:
              "Admitted execution binding changed; this event will not be rerouted or replayed.",
          });
          continue;
        }
        const boundHook = { ...hook, ...r.binding };
        if (!(await transport.available(boundHook).catch(() => false))) {
          save({ ...r, state: "held", error: "Owning server or execution host is offline." });
          continue;
        }
        const latest = await config(),
          currentHook = latest.hooks.find((h) => h.id === r.hookId && h.enabled);
        if (!latest.webhookEnabled || !currentHook) continue;
        if (bindingHash(currentHook) !== r.bindingFingerprint) {
          save({
            ...r,
            state: r.state === "dispatching" ? "unknown" : "refused",
            error: "Admitted execution binding changed during owner availability check.",
          });
          continue;
        }
        save({ ...r, state: "dispatching", error: null });
        try {
          const result = await transport.run(boundHook, `nav-hook:${r.id}`);
          save({
            ...r,
            state:
              result.kind === "admitted"
                ? "owner-accepted"
                : result.kind === "offline"
                  ? "held"
                  : result.kind === "refused"
                    ? "refused"
                    : "unknown",
            runId: result.kind === "admitted" ? result.runId : null,
            error:
              result.kind === "unknown"
                ? "Owner effect is unknown; automatic replay stopped."
                : result.kind === "refused"
                  ? result.reason.slice(0, 400)
                  : null,
          });
        } catch {
          save({
            ...r,
            state: "unknown",
            error: "Owner effect is unknown; automatic replay stopped.",
          });
        }
      }
      signal();
    });
  }
  const INVALID_SIGNATURE = { error: "Invalid webhook signature or timestamp." };
  async function receive(
    headers: Headers,
    raw: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (Buffer.byteLength(raw) > MAX_BYTES)
      return { status: 413, body: { error: "Payload exceeds 64 KiB." } };
    const s = await config();
    const hook = s.hooks.find((h) => h.id === headers.get("x-nav-hook") && h.enabled);
    // An unknown or disabled hook answers exactly like a bad signature, so hook names cannot be guessed.
    // Webhooks switched off in the feature picker answer the same way (F51).
    if (!s.webhookEnabled || !hook || !featureOn("F51")) return { status: 401, body: INVALID_SIGNATURE };
    const deliveryId = headers.get("x-nav-delivery") ?? "";
    if (
      !verifyWebhook(
        s.webhookSecret,
        hook.id,
        headers.get("x-nav-timestamp") ?? "",
        deliveryId,
        raw,
        headers.get("x-nav-signature") ?? "",
        clock(),
      )
    )
      return { status: 401, body: INVALID_SIGNATURE };
    let body: unknown;
    try {
      body = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
    } catch {
      return { status: 400, body: { error: "Invalid JSON." } };
    }
    if (!matches(body, hook)) return { status: 200, body: { filtered: true } };
    return serial(async () => {
      const digest = createHash("sha256").update(raw).digest("hex");
      const prior = db
        .prepare("SELECT value,digest FROM nav_hook_events WHERE hook_id=? AND delivery_id=?")
        .get(hook.id, deliveryId) as { value: string; digest: string } | undefined;
      if (prior)
        return prior.digest !== digest
          ? { status: 409, body: { error: "Delivery ID reused with different content." } }
          : {
              status: 200,
              body: { duplicate: true, receipt: eventReceipt.parse(JSON.parse(prior.value)) },
            };
      const all = rows();
      const pending = all.filter((r) => ["accepted", "held", "dispatching"].includes(r.state));
      if (
        pending.length >= 1000 ||
        pending.filter((r) => r.hookId === hook.id).length >= 100 ||
        all.length >= 10_000
      )
        return { status: 429, body: { error: "Durable inbox is full." } };
      const available = await transport.available(hook).catch(() => false);
      // F52: with offline holding unticked a delivery for an offline owner is refused, not held.
      if (!available && !(hook.holdOffline && featureOn("F52")))
        return { status: 503, body: { error: "Owner is offline; offline holding is disabled." } };
      const coalesced =
        hook.coalesceSeconds > 0 && featureOn("S04")
          ? pending.find(
              (r) =>
                r.hookId === hook.id &&
                r.bindingFingerprint === bindingHash(hook) &&
                r.state !== "dispatching" &&
                r.dueAt > clock(),
            )
          : undefined;
      const receipt: Receipt = {
        id: createHash("sha256").update(`${hook.id}\0${deliveryId}`).digest("hex"),
        hookId: hook.id,
        binding: bindingFor(hook),
        bindingFingerprint: bindingHash(hook),
        deliveryId,
        receivedAt: clock(),
        expiresAt: clock() + DAY,
        dueAt: coalesced?.dueAt ?? clock() + hook.coalesceSeconds * 1000,
        state: coalesced ? "coalesced" : available ? "accepted" : "held",
        runId: null,
        count: 1,
        error: coalesced ? `Coalesced into ${coalesced.id}` : null,
      };
      db.prepare("INSERT INTO nav_hook_events VALUES (?,?,?,?,?)").run(
        receipt.id,
        hook.id,
        deliveryId,
        digest,
        JSON.stringify(receipt),
      );
      if (coalesced) save({ ...coalesced, count: coalesced.count + 1 });
      signal();
      return { status: 202, body: { accepted: true, executed: false, receipt } };
    });
  }
  bb.http.route(
    "POST",
    "/automation-hook",
    async (c) => {
      // Read a bounded stream; do not allocate an unbounded request body before checking.
      const reader = c.req.raw.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > MAX_BYTES) {
            await reader.cancel();
            return c.json({ error: "Payload exceeds 64 KiB." }, 413);
          }
          chunks.push(part.value);
        }
      }
      const result = await receive(c.req.raw.headers, Buffer.concat(chunks).toString("utf8"));
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
    { auth: "none" },
  ); // Every request verifies our timestamped HMAC above, including replay key and raw body.
  bb.background.schedule("automation-event-inbox", "* * * * *", tick);
  return { state, tick, receive, settings };
}

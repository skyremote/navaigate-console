// Usage trend for the hover card under the chat box: a background sampler that
// records every account's plan windows over time, a ledger of which chats used
// the tokens, and the card payload (series, forecasts, burn rate, busiest chats).
//
// Reads are cached only: the Account Pooler with refresh:false (it refreshes on
// its own schedule; we record its observedAt, so a stale reading is never
// counted twice), Cursor through Home's cached usage call at most every 15 min.
//
// Storage: one kv row per account, "usage-trend:v1:<id>", holding for each
// window a fine ring (3-min points, last 48 h) and a coarse ring (15-min
// buckets, up to 14 days). Points are [minute since epoch, per-mille used].
// The turns ledger "usage-turns:v1" keeps 26 h of per-turn token use per chat.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { shortName } from "./server-pool";
import { fleetUsageCoverageSchema, usageSourceSchema, allowanceIdFor, canonicalUsageProvider, mergeUsageReadings, ownerLinkKey, poolLinkKey, tokenBoundPoolSubscriptionId, usageWindowKind, USAGE_FRESH_MS, type FleetUsageRead, type UsageReading, type UsageReadingWindow, type UsageSource, type UsageHarness } from "./server-usage-fleet";

type Harness = UsageHarness;
type CursorReading = { email: string | null; plan: string | null; week: number | null; weekResetsAt: string | null; status: "ok" | "error" } | null;

export type TrendDeps = {
  fleetUsage?(): Promise<FleetUsageRead>;
  cursorUsage(): Promise<CursorReading>;
  planLabel(harness: "claude" | "codex", raw: string | null, email: string | null): Promise<string | null>;
  /** Pool account a provider session runs on, or the provider's current account. */
  accountFor(provider: "claude" | "codex", sessionId: string | null): string | null;
  /** The shared subscription a reading is mapped to by settings or by the owner's confirmation. */
  identityFor?(linkKey: string): Promise<string | null>;
  /** The machine this server runs on, used when Fleet does not name it. */
  localMachine?(): Promise<string | null>;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const FINE_KEEP = 48 * HOUR;
const COARSE_KEEP = 14 * 24 * HOUR;
const COARSE_STEP = 15 * MIN;
const CURSOR_EVERY = 15 * MIN;
const TURNS_KEEP = 26 * HOUR;

const usageSchema = z
  .object({
    observedAt: z.number().nullable().optional(),
    accountKey: z.string().nullable().optional(),
    usage: z
      .object({
        status: z.string(),
        accountEmail: z.string().nullable().optional(),
        planLabel: z.string().nullable().optional(),
        windows: z
          .array(z.object({ id: z.string().optional(), label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable(), kind: z.string().optional(), model: z.string().nullable().optional() }).passthrough())
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
const listSchema = z.object({ resources: z.array(z.object({ id: z.string(), providerId: z.string(), label: z.string() }).passthrough()) }).passthrough();

// ---------- Card payload ----------
const point = z.tuple([z.number(), z.number()]); // [epoch ms, percent]
export const trendWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** session = the five-hour window; long = weekly or monthly. */
  span: z.enum(["session", "long"]),
  model: z.string().nullable(),
  pct: z.number(),
  startsAt: z.number().nullable(),
  resetsAt: z.number().nullable(),
  /** True when a five-hour window has lapsed and no session is running. */
  idle: z.boolean(),
  series: z.array(point),
  /** Percent per hour used for the forecast, and how it was measured. */
  rate: z.number().nullable(),
  rateBasis: z.enum(["recent", "pace", "none"]),
  samples: z.number(),
  forecastAtReset: z.number().nullable(),
  hits90At: z.number().nullable(),
  hits100At: z.number().nullable(),
  /** Percent per hour over the last 30 minutes of readings. */
  burn: z.number().nullable(),
});
export const trendAccountSchema = z.object({
  id: z.string(),
  harness: z.enum(["claude", "codex", "cursor", "other"]),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  status: z.enum(["ok", "error"]),
  observedAt: z.number().nullable(),
  windows: z.array(trendWindowSchema),
  source: usageSourceSchema.optional(),
  /** Burn rate of the shortest window over the last 30 minutes, percent per hour. */
  burn: z.number().nullable(),
  busiest: z.object({
    mode: z.enum(["tokens", "activity", "none"]),
    since: z.number(),
    sinceLabel: z.string(),
    rows: z.array(z.object({ threadId: z.string(), title: z.string(), share: z.number(), tokens: z.number(), turns: z.number() })),
  }),
});
export const threadAccountsSchema = z.object({
  threads: z.record(
    z.string(),
    z.object({
      accountId: z.string(),
      label: z.string(),
      email: z.string().nullable(),
      harness: z.enum(["claude", "codex", "cursor", "other"]),
    }),
  ),
});
export type ThreadAccounts = z.infer<typeof threadAccountsSchema>;
export const usageMachineWindowSchema = z.object({ kind: z.string(), label: z.string(), model: z.string().nullable(), pct: z.number(), resetsAt: z.number().nullable() });
export const usageMachineRowSchema = z.object({
  key: z.string(),
  provider: z.string(),
  harness: z.enum(["claude", "codex", "cursor", "other"]),
  machine: z.string(),
  label: z.string().nullable(),
  plan: z.string().nullable(),
  observedAt: z.number().nullable(),
  freshness: z.enum(["fresh", "stale", "unavailable"]),
  identity: z.enum(["token-verified", "confirmed", "unknown"]),
  allowanceId: z.string(),
  windows: z.array(usageMachineWindowSchema),
});
export type UsageMachineRow = z.infer<typeof usageMachineRowSchema>;
export const trendSchema = z.object({ now: z.number(), sampledFrom: z.number().nullable(), accounts: z.array(trendAccountSchema), sources: z.array(fleetUsageCoverageSchema).optional(), machines: z.array(usageMachineRowSchema).optional() });
export type TrendAccount = z.infer<typeof trendAccountSchema>;
export type TrendWindow = z.infer<typeof trendWindowSchema>;
export type Trend = z.infer<typeof trendSchema>;

// ---------- Storage shapes ----------
type Ring = { fine: number[]; coarse: number[] }; // flat [minute, permille, minute, permille, ...]
type WinMeta = { label: string; kind: string; model: string | null; resetsAt: number | null; pct: number; observedAt?: number; source?: UsageSource };
type Stored = { v: 1; first: number; lastObservedAt: number; harness: Harness; email: string | null; plan: string | null; status: "ok" | "error"; source?: UsageSource; meta: Record<string, WinMeta>; rings: Record<string, Ring> };
type Turns = { v: 1; seen: Record<string, [number, number]>; scannedAt: number; turns: Array<[number, string, string, number]> }; // seen: threadId -> [lastSeq, at]; turn: [at, threadId, accountId, weighted tokens]

const key = (id: string) => `usage-trend:v1:${id}`;

function pairs(flat: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i] * MIN, flat[i + 1] / 10]);
  return out;
}

/** Append one reading; fold fine points older than 48 h into 15-min buckets (last value wins) and trim at 14 days. */
function push(ring: Ring, at: number, pct: number) {
  const m = Math.round(at / MIN);
  const v = Math.round(pct * 10);
  const n = ring.fine.length;
  if (n >= 2 && ring.fine[n - 2] >= m) {
    if (ring.fine[n - 2] === m) ring.fine[n - 1] = v;
    return;
  }
  ring.fine.push(m, v);
  const cutoff = (at - FINE_KEEP) / MIN;
  let i = 0;
  while (i < ring.fine.length && ring.fine[i] < cutoff) {
    const bucket = Math.floor((ring.fine[i] * MIN) / COARSE_STEP) * (COARSE_STEP / MIN);
    const cn = ring.coarse.length;
    if (cn >= 2 && ring.coarse[cn - 2] === bucket) ring.coarse[cn - 1] = ring.fine[i + 1];
    else ring.coarse.push(bucket, ring.fine[i + 1]);
    i += 2;
  }
  if (i > 0) ring.fine.splice(0, i);
  const oldest = (at - COARSE_KEEP) / MIN;
  let j = 0;
  while (j < ring.coarse.length && ring.coarse[j] < oldest) j += 2;
  if (j > 0) ring.coarse.splice(0, j);
}

/** Least-squares slope in percent per hour, or null with fewer than three points or no time spread. */
function slope(pts: Array<[number, number]>): number | null {
  if (pts.length < 3) return null;
  const t0 = pts[0][0];
  const xs = pts.map(([t]) => (t - t0) / HOUR);
  const ys = pts.map(([, p]) => p);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den <= 0 || xs[xs.length - 1] < 10 / 60) return null;
  return Math.max(0, num / den);
}

function spanOf(kind: string, label: string): { span: "session" | "long"; ms: number } {
  if (kind === "five-hour" || /five|5h|session/i.test(label)) return { span: "session", ms: 5 * HOUR };
  if (kind === "daily") return { span: "long", ms: 24 * HOUR };
  if (kind === "monthly") return { span: "long", ms: 30 * 24 * HOUR };
  return { span: "long", ms: 7 * 24 * HOUR };
}

function prettyLabel(kind: string, label: string, model: string | null): string {
  const m = model ? `${model.charAt(0).toUpperCase()}${model.slice(1)}` : null;
  if (kind === "five-hour" || /five|5h|session/i.test(label)) return "Session";
  if (kind === "monthly") return m ? `Month · ${m}` : "Month";
  if (kind === "daily") return m ? `Day · ${m}` : "Day";
  return m ? `Week · ${m}` : "Week";
}

/** Claude limits weigh tokens roughly like API prices: cache reads cheap, output dear. */
function weigh(provider: string, u: Record<string, number | undefined>): number {
  const input = u.inputTokens ?? 0;
  const out = u.outputTokens ?? 0;
  if (provider.includes("claude")) return input + 1.25 * (u.cacheWriteInputTokens ?? 0) + 0.1 * (u.cacheReadInputTokens ?? u.cachedInputTokens ?? 0) + 5 * out;
  const cached = u.cachedInputTokens ?? 0;
  return Math.max(0, input - cached) + 0.1 * cached + 4 * out;
}

const fmtSince = (start: number) => new Date(start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function createUsageTrend(bb: BbPluginApi, deps: TrendDeps) {
  let cursorAt = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  async function load(id: string): Promise<Stored | null> {
    return ((await bb.storage.kv.get<Stored>(key(id))) ?? null) as Stored | null;
  }

  async function record(id: string, harness: Harness, email: string | null, plan: string | null, status: "ok" | "error", observedAt: number, wins: UsageReadingWindow[], source?: UsageSource) {
    const s: Stored = (await load(id)) ?? { v: 1, first: observedAt, lastObservedAt: 0, harness, email, plan, status, meta: {}, rings: {} };
    s.harness = harness;
    s.email = email;
    s.plan = plan;
    s.status = status;
    if (source) s.source = source;
    const previousObservedAt = s.lastObservedAt;
    if (status === "ok") {
      for (const w of wins) {
        const at = w.observedAt ?? observedAt;
        const previousWindow = s.meta[w.id];
        const previousAt = previousWindow ? previousWindow.observedAt ?? previousObservedAt : 0;
        if (!Number.isFinite(at) || at <= 0 || at <= previousAt) continue;
        // A lapsed five-hour window reads as its last value until the next message; it is really 0.
        const lapsed = (w.source?.kind ?? source?.kind) !== "owner" && w.resetsAt !== null && w.resetsAt < at;
        push((s.rings[w.id] ??= { fine: [], coarse: [] }), at, lapsed ? 0 : w.pct);
        s.meta[w.id] = { label: w.label, kind: w.kind, model: w.model, resetsAt: w.resetsAt, pct: w.pct, observedAt: at, source: w.source ?? source };
        s.lastObservedAt = Math.max(s.lastObservedAt, at);
        if (s.first <= 0) s.first = at;
      }
    }
    await bb.storage.kv.set(key(id), s);
  }

  async function markUnavailable(id: string) {
    const stored = await load(id);
    if (!stored) return;
    stored.status = "error";
    if (stored.source) stored.source.freshness = "unavailable";
    await bb.storage.kv.set(key(id), stored);
  }

  // ---------- One sampling pass ----------
  async function samplePlans() {
    let list: z.infer<typeof listSchema> | null = null;
    try {
      list = await bb.sdk.plugins.callRpc({ pluginId: "account-pool", method: "provider-usage.v1.listResources", input: {} as never, outputSchema: listSchema });
    } catch {
      list = null;
    }
    const ids: string[] = [];
    const readings: UsageReading[] = [];
    const primaryHostId = (await Promise.resolve().then(() => bb.sdk.system.config()).catch(() => null))?.primaryHostId ?? "unknown-owner-host";
    if (!list) {
      for (const accountId of (await bb.storage.kv.get<string[]>("usage-trend:v1:accounts")) ?? []) if (accountId !== "cursor" && !accountId.startsWith("fleet-usage:")) await markUnavailable(accountId);
    }
    for (const res of list?.resources ?? []) {
      const harness = res.providerId.includes("codex") ? "codex" : res.providerId.includes("claude") ? "claude" : null;
      if (!harness) continue;
      ids.push(res.id);
      try {
        const r = await bb.sdk.plugins.callRpc({ pluginId: "account-pool", method: "provider-usage.v1.getResource", input: { resourceId: res.id, refresh: false } as never, outputSchema: usageSchema });
        const email = r.usage.accountEmail ?? res.label;
        const plan = await deps.planLabel(harness, r.usage.planLabel ?? null, email);
        const observedAt = r.observedAt ?? 0;
        const wins = (r.usage.windows ?? []).map((w) => ({
          id: w.id ?? `${w.kind ?? "w"}:${w.model ?? ""}:${w.label}`,
          label: w.label,
          kind: usageWindowKind(w.label, w.kind ?? ""),
          model: w.model ?? null,
          pct: w.usedPercent,
          resetsAt: w.resetsAt ? Date.parse(w.resetsAt) || null : null,
        }));
        const provider = canonicalUsageProvider(res.providerId);
        const tokenBound = tokenBoundPoolSubscriptionId(provider, r.accountKey);
        const linkKey = poolLinkKey(harness, primaryHostId, res.id);
        const confirmed = tokenBound ? null : await deps.identityFor?.(linkKey).catch(() => null) ?? null;
        const subscriptionId = tokenBound ?? confirmed;
        readings.push({ linkKey, id: res.id, provider, harness, email, plan, status: r.usage.status === "ok" ? "ok" : "error", observedAt, subscriptionId, windows: wins, source: { kind: "pool", provider, label: "Account Pooler", machines: [], ownerServerId: null, hostId: null, identity: tokenBound ? "token-verified" : confirmed ? "confirmed" : "unknown", freshness: "fresh" } });
      } catch (e) {
        await markUnavailable(res.id);
        bb.log.warn(`usage trend ${res.id}: ${String(e)}`);
      }
    }
    const previousCoverage = (await bb.storage.kv.get<FleetUsageRead["coverage"]>("usage-trend:v1:fleet-sources")) ?? [];
    const fleet = deps.fleetUsage ? await deps.fleetUsage().catch(() => ({ readings: [], coverage: previousCoverage.map((source) => ({ ...source, state: source.state === "self" ? ("self" as const) : ("unavailable" as const) })) })) : { readings: [], coverage: [] };
    await bb.storage.kv.set("usage-trend:v1:fleet-sources", fleet.coverage);
    await recordMachineRows(readings, fleet, list !== null);
    for (const reading of mergeUsageReadings(readings, fleet.readings)) {
      if (reading.source.kind === "owner" && reading.windows.length === 0 && !(await load(reading.id))) continue;
      ids.push(reading.id);
      await record(reading.id, reading.harness, reading.email, reading.plan, reading.status, reading.observedAt, reading.windows, reading.source);
    }
    const knownOwners = (await bb.storage.kv.get<string[]>("usage-trend:v1:accounts")) ?? [];
    for (const accountId of knownOwners.filter((accountId) => accountId.startsWith("fleet-usage:") && !ids.includes(accountId))) {
      const stored = await load(accountId);
      if (stored?.source) { stored.source.freshness = "unavailable"; stored.status = "error"; await bb.storage.kv.set(key(accountId), stored); }
    }
    if (Date.now() - cursorAt >= CURSOR_EVERY) {
      cursorAt = Date.now();
      const c = await deps.cursorUsage().catch(() => null);
      if (c) {
        ids.push("cursor");
        const resetsAt = c.weekResetsAt ? Date.parse(c.weekResetsAt) || null : null;
        await record("cursor", "cursor", c.email, c.plan, c.status, c.status === "ok" ? Date.now() : 0, c.week === null ? [] : [{ id: "month", label: "This month", kind: "monthly", model: null, pct: c.week, resetsAt }]);
        await recordCursorMachineRow(c, resetsAt);
      }
    }
    // Remember which accounts exist so the card can list them without touching providers.
    const known = new Set(((await bb.storage.kv.get<string[]>("usage-trend:v1:accounts")) ?? []) as string[]);
    if (list) for (const k of [...known]) if (k !== "cursor" && !k.startsWith("fleet-usage:") && !ids.includes(k)) known.delete(k);
    for (const id of ids) known.add(id);
    await bb.storage.kv.set("usage-trend:v1:accounts", [...known]);
  }

  // ---------- One row per provider and machine, for the Home table ----------
  const ROWS = "usage-trend:v1:machine-rows";
  const ROWS_KEEP = 14 * 24 * HOUR;
  const mainWindows = (windows: UsageReadingWindow[]) => windows.map((w) => ({ kind: usageWindowKind(w.label, w.kind), label: w.label, model: w.model, pct: w.pct, resetsAt: w.resetsAt }));
  const localName = async (fleet: FleetUsageRead) => fleet.coverage.find((item) => item.state === "self")?.machine ?? (await deps.localMachine?.().catch(() => null)) ?? "This Mac";
  const localPart = (email: string | null) => (email ? email.split("@")[0].slice(0, 20) : null);

  async function recordMachineRows(local: UsageReading[], fleet: FleetUsageRead, poolListed: boolean) {
    const now = Date.now();
    const previous = ((await bb.storage.kv.get<Record<string, UsageMachineRow>>(ROWS)) ?? {}) as Record<string, UsageMachineRow>;
    const self = await localName(fleet);
    const next: Record<string, UsageMachineRow> = {};
    for (const [key, row] of Object.entries(previous)) {
      if (row.observedAt !== null && now - row.observedAt > ROWS_KEEP) continue;
      if (row.freshness === "unavailable" && row.observedAt === null) continue;
      if (poolListed && row.machine === self && row.harness !== "cursor" && !local.some((item) => item.linkKey === key)) continue;
      next[key] = row;
    }
    const touched = new Set<string>();
    for (const reading of [...local, ...fleet.readings]) {
      if (!reading.linkKey) continue;
      touched.add(reading.linkKey);
      const prior = next[reading.linkKey];
      const ok = reading.status === "ok" && reading.windows.length > 0;
      const pool = reading.source.kind === "pool";
      const freshness: UsageMachineRow["freshness"] = pool ? (ok ? "fresh" : "unavailable") : reading.source.freshness === "fresh" ? "fresh" : reading.source.freshness === "stale" ? "stale" : "unavailable";
      const keepWindows = !ok && prior;
      next[reading.linkKey] = {
        key: reading.linkKey,
        provider: reading.provider,
        harness: reading.harness,
        machine: pool ? self : reading.source.machines[0] ?? "Unknown",
        label: localPart(reading.email) ?? prior?.label ?? null,
        plan: reading.plan ?? prior?.plan ?? null,
        observedAt: keepWindows ? prior.observedAt : reading.observedAt > 0 ? reading.observedAt : null,
        freshness,
        identity: reading.source.identity,
        allowanceId: allowanceIdFor(local, reading),
        windows: keepWindows ? prior.windows : mainWindows(reading.windows),
      };
    }
    for (const row of Object.values(next)) {
      if (touched.has(row.key) || row.harness === "cursor") continue;
      const coverage = fleet.coverage.find((item) => item.machine === row.machine);
      if (row.machine === self || coverage?.state === "unavailable") row.freshness = "unavailable";
      else if (coverage?.state === "stale") row.freshness = "stale";
    }
    await bb.storage.kv.set(ROWS, next);
  }

  async function recordCursorMachineRow(c: NonNullable<CursorReading>, resetsAt: number | null) {
    const previous = ((await bb.storage.kv.get<Record<string, UsageMachineRow>>(ROWS)) ?? {}) as Record<string, UsageMachineRow>;
    const self = await localName({ readings: [], coverage: (await bb.storage.kv.get<FleetUsageRead["coverage"]>("usage-trend:v1:fleet-sources")) ?? [] });
    const key = "cursor:local:cursor";
    const prior = previous[key];
    const ok = c.status === "ok" && c.week !== null;
    previous[key] = {
      key,
      provider: "cursor",
      harness: "cursor",
      machine: self,
      label: localPart(c.email) ?? prior?.label ?? null,
      plan: c.plan ?? prior?.plan ?? null,
      observedAt: ok ? Date.now() : prior?.observedAt ?? null,
      freshness: ok ? "fresh" : "unavailable",
      identity: "unknown",
      allowanceId: "cursor",
      windows: ok ? [{ kind: "monthly", label: "This month", model: null, pct: c.week!, resetsAt }] : prior?.windows ?? [],
    };
    await bb.storage.kv.set(ROWS, previous);
  }

  async function machineRows(): Promise<UsageMachineRow[]> {
    const rows = Object.values(((await bb.storage.kv.get<Record<string, UsageMachineRow>>(ROWS)) ?? {}) as Record<string, UsageMachineRow>);
    const order: Record<string, number> = { claude: 0, codex: 1, cursor: 2, other: 3 };
    return rows.sort((a, b) => order[a.harness] - order[b.harness] || a.machine.localeCompare(b.machine));
  }

  async function sampleTurns() {
    const now = Date.now();
    const t = ((await bb.storage.kv.get<Turns>("usage-turns:v1")) ?? { v: 1, seen: {}, scannedAt: 0, turns: [] }) as Turns;
    const since = Math.max(t.scannedAt - 5 * MIN, now - 6 * HOUR);
    const threads = (await bb.sdk.threads.list({ includeHidden: true })) as unknown as Array<{ id: string; providerId: string; updatedAt: number }>;
    for (const th of threads) {
      if (!th.updatedAt || th.updatedAt < since) continue;
      const provider = th.providerId.includes("codex") ? "codex" : th.providerId.includes("claude") ? "claude" : th.providerId.includes("cursor") ? "cursor" : null;
      if (!provider) continue;
      const after = t.seen[th.id]?.[0];
      // The events API returns at most 100 rows: a chat seen for the first time
      // reads its newest 100 reports; after that, every report since the last one.
      type Row = { seq: number; createdAt: number; type: string; data: unknown };
      let rows: Row[] = [];
      try {
        const types = ["thread/tokenUsage/updated", "turn/completed"] as const;
        if (after === undefined) {
          rows = ((await bb.sdk.threads.events.list({ threadId: th.id, types: [...types], order: "desc", limit: "100" })) as unknown as Row[]).reverse();
        } else {
          let cursor = after;
          for (let page = 0; page < 20; page++) {
            const got = (await bb.sdk.threads.events.list({ threadId: th.id, types: [...types], order: "asc", limit: "100", afterSeq: String(cursor) })) as unknown as Row[];
            rows.push(...got);
            if (got.length < 100) break;
            cursor = got[got.length - 1].seq;
          }
        }
      } catch (e) {
        bb.log.warn(`usage turns ${th.id}: ${String(e)}`);
        continue;
      }
      let last = after ?? 0;
      for (const r of rows) {
        last = Math.max(last, r.seq);
        if (r.createdAt < now - TURNS_KEEP) continue;
        if (r.type === "thread/tokenUsage/updated") {
          const d = r.data as { providerThreadId?: string; tokenUsage?: { last?: Record<string, number> } };
          const acct = provider === "cursor" ? "cursor" : deps.accountFor(provider, d.providerThreadId ?? null);
          if (acct && d.tokenUsage?.last) t.turns.push([r.createdAt, th.id, acct, Math.round(weigh(th.providerId, d.tokenUsage.last))]);
        } else if (provider === "cursor" || !rows.some((x) => x.type === "thread/tokenUsage/updated")) {
          // Turns with no token report still count as activity.
          const acct = provider === "cursor" ? "cursor" : deps.accountFor(provider, null);
          if (acct) t.turns.push([r.createdAt, th.id, acct, 0]);
        }
      }
      t.seen[th.id] = [last, now];
    }
    t.turns = t.turns.filter((x) => x[0] >= now - TURNS_KEEP).sort((a, b) => a[0] - b[0]);
    for (const [id, [, at]] of Object.entries(t.seen)) if (at < now - 3 * 24 * HOUR) delete t.seen[id];
    t.scannedAt = now;
    await bb.storage.kv.set("usage-turns:v1", t);
  }

  function sample(): Promise<void> {
    return serial(async () => {
      await samplePlans().catch((e) => bb.log.warn(`usage trend: ${String(e)}`));
      await sampleTurns().catch((e) => bb.log.warn(`usage turns: ${String(e)}`));
    });
  }

  // ---------- Card payload ----------
  function windowOf(id: string, meta: WinMeta, ring: Ring | undefined, now: number, daily: Record<string, number>, available = true): TrendWindow {
    const { span, ms } = spanOf(meta.kind, meta.label);
    const idle = span === "session" && (meta.resetsAt === null || meta.resetsAt <= now);
    const knownPeriod = meta.source?.kind !== "owner" || ["five-hour", "weekly", "daily", "monthly"].includes(meta.kind);
    const startsAt = knownPeriod && meta.resetsAt !== null && (!idle || meta.source?.kind === "owner") ? meta.resetsAt - ms : null;
    const all = ring ? [...pairs(ring.coarse), ...pairs(ring.fine)] : [];
    const series = startsAt !== null ? all.filter(([t]) => t >= startsAt && t <= now) : [];
    const pct = idle && meta.source?.kind !== "owner" ? 0 : meta.pct;
    // Forecast: the session from a linear fit on the last 30 to 60 minutes of
    // readings. A week or month from its average pace since it began, once a
    // day of it is behind us (one busy morning would read as a runaway week).
    const recent = series.filter(([t]) => t >= now - 60 * MIN);
    let rate: number | null = null;
    let basis: "recent" | "pace" | "none" = "none";
    if (available && span === "session") {
      rate = slope(recent);
      if (rate !== null) basis = "recent";
    } else if (available && startsAt !== null && now - startsAt >= 24 * HOUR) {
      rate = pct / ((now - startsAt) / HOUR);
      basis = "pace";
    }
    let forecastAtReset: number | null = null;
    let hits90At: number | null = null;
    let hits100At: number | null = null;
    if (rate !== null && meta.resetsAt !== null && !idle) {
      forecastAtReset = Math.min(100, Math.max(pct, pct + (rate * (meta.resetsAt - now)) / HOUR));
      if (rate > 0) {
        if (pct < 90) hits90At = now + ((90 - pct) / rate) * HOUR;
        if (pct < 100) hits100At = now + ((100 - pct) / rate) * HOUR;
      }
    }
    // Long windows ship at 30-minute resolution; the chart cannot show more.
    let shipped = series;
    if (span === "long") {
      const byBucket = new Map<number, [number, number]>();
      for (const p of series) byBucket.set(Math.floor(p[0] / (30 * MIN)), p);
      shipped = [...byBucket.values()];
      // Before the sampler's first reading, the daily peaks Home already keeps
      // (main weekly or monthly window only), each placed at the end of its day.
      if (!meta.model && startsAt !== null) {
        const first = shipped[0]?.[0] ?? now;
        const firstValue = shipped[0]?.[1] ?? pct;
        const early: Array<[number, number]> = [];
        for (const [day, peak] of Object.entries(daily)) {
          const end = Date.parse(`${day}T23:59:00Z`); // Home keys days in UTC
          // A day that began before the window opened also holds the last window's peak.
          if (Date.parse(`${day}T00:00:00Z`) >= startsAt && end < first && end < now) early.push([end, Math.min(peak, firstValue)]);
        }
        shipped = [...early.sort((a, b) => a[0] - b[0]), ...shipped];
      }
    }
    // Preserve local opening baselines; owner curves contain observed points only.
    if (meta.source?.kind !== "owner" && startsAt !== null && (shipped[0]?.[0] ?? Infinity) > startsAt) shipped = [[startsAt, 0], ...shipped];
    return {
      id,
      label: knownPeriod ? prettyLabel(meta.kind, meta.label, meta.model) : meta.label,
      span,
      model: meta.model,
      pct,
      startsAt,
      resetsAt: meta.resetsAt,
      idle,
      series: shipped,
      rate,
      rateBasis: basis,
      samples: recent.length,
      forecastAtReset,
      hits90At,
      hits100At,
      burn: available ? slope(series.filter(([t]) => t >= now - 30 * MIN)) : null,
    };
  }

  /** The account each chat last ran a turn on, from the last 26 hours of the turns ledger. */
  async function threadAccounts(): Promise<ThreadAccounts> {
    const turns = ((await bb.storage.kv.get<Turns>("usage-turns:v1")) ?? { turns: [] }) as Turns;
    const ids = ((await bb.storage.kv.get<string[]>("usage-trend:v1:accounts")) ?? []) as string[];
    const known = new Map<string, Stored>();
    for (const id of ids) {
      const s = await load(id);
      if (s) known.set(id, s);
    }
    const last = new Map<string, string>();
    for (const [, threadId, accountId] of [...turns.turns].sort((a, b) => a[0] - b[0])) last.set(threadId, accountId);
    const out: ThreadAccounts["threads"] = {};
    for (const [threadId, accountId] of last) {
      const s = known.get(accountId);
      if (!s) continue;
      out[threadId] = { accountId, label: s.harness === "cursor" ? "Cursor" : shortName(s.email, null), email: s.email, harness: s.harness };
    }
    return { threads: out };
  }

  async function card(): Promise<Trend> {
    const now = Date.now();
    const ids = ((await bb.storage.kv.get<string[]>("usage-trend:v1:accounts")) ?? []) as string[];
    const sources = (await bb.storage.kv.get<FleetUsageRead["coverage"]>("usage-trend:v1:fleet-sources")) ?? [];
    const turns = ((await bb.storage.kv.get<Turns>("usage-turns:v1")) ?? { turns: [] }) as Turns;
    const history = ((await bb.storage.kv.get<Record<string, Record<string, number>>>("usage-history")) ?? {}) as Record<string, Record<string, number>>;
    let titles: Map<string, string> | null = null;
    const titleOf = async (id: string) => {
      if (!titles) {
        const list = (await bb.sdk.threads.list({ includeHidden: true }).catch(() => [])) as unknown as Array<{ id: string; title: string | null; titleFallback?: string | null }>;
        titles = new Map(list.map((x) => [x.id, x.title || x.titleFallback || "Untitled chat"]));
      }
      return titles.get(id) ?? "Untitled chat";
    };
    const accounts: TrendAccount[] = [];
    let sampledFrom: number | null = null;
    for (const id of ids) {
      const s = await load(id);
      if (!s) continue;
      if (s.first > 0) sampledFrom = sampledFrom === null ? s.first : Math.min(sampledFrom, s.first);
      const windows = Object.entries(s.meta)
        .map(([wid, m]) => {
          const available = m.source?.kind === "owner" ? !!m.observedAt && now - m.observedAt <= USAGE_FRESH_MS && m.observedAt <= now + 5000 && (m.resetsAt === null || m.resetsAt > now) && sources.some((item) => item.ownerServerId === m.source?.ownerServerId && item.hostId === m.source?.hostId && item.state === "fresh" && item.providers?.[m.source!.provider] === "fresh") && s.status === "ok" : s.status === "ok";
          return windowOf(wid, m, s.rings[wid], now, history[id] ?? {}, available);
        })
        .sort((a, b) => (a.span === b.span ? (a.model ? 1 : 0) - (b.model ? 1 : 0) : a.span === "session" ? -1 : 1));
      const shortest = windows.find((w) => w.span === "session" && !w.idle) ?? windows.find((w) => !w.model) ?? null;
      const burn = shortest?.burn ?? null;
      // Busiest chats over this session's window, or the last five hours (a day for Cursor).
      const session = windows.find((w) => w.span === "session" && !w.idle);
      const since = session?.startsAt ?? now - (s.harness === "cursor" ? 24 : 5) * HOUR;
      const sinceLabel = session ? `since ${fmtSince(since)}` : s.harness === "cursor" ? "in the last 24 hours" : "in the last 5 hours";
      const mine = turns.turns.filter((x) => x[2] === id && x[0] >= since);
      const per = new Map<string, { tokens: number; turns: number }>();
      for (const [, th, , w] of mine) {
        const e = per.get(th) ?? { tokens: 0, turns: 0 };
        e.tokens += w;
        e.turns += 1;
        per.set(th, e);
      }
      const totalTokens = [...per.values()].reduce((a, b) => a + b.tokens, 0);
      const mode = per.size === 0 ? "none" : totalTokens > 0 ? "tokens" : "activity";
      const totalTurns = [...per.values()].reduce((a, b) => a + b.turns, 0);
      const ranked = [...per.entries()].sort((a, b) => (mode === "tokens" ? b[1].tokens - a[1].tokens : b[1].turns - a[1].turns)).slice(0, 3);
      const rows = [];
      for (const [threadId, e] of ranked)
        rows.push({ threadId, title: await titleOf(threadId), share: mode === "tokens" ? e.tokens / totalTokens : e.turns / Math.max(1, totalTurns), tokens: e.tokens, turns: e.turns });
      const machines = [...new Set([...s.source?.machines ?? [], ...Object.values(s.meta).flatMap((meta) => meta.source?.kind === "owner" && meta.source.identity !== "unknown" ? meta.source.machines : [])])];
      accounts.push({ id, harness: s.harness, email: s.email, plan: s.plan, status: s.status, observedAt: s.lastObservedAt || null, ...(s.source ? { source: { ...s.source, machines, freshness: s.source.kind === "owner" && s.source.freshness === "fresh" && (s.status !== "ok" || now - s.lastObservedAt > USAGE_FRESH_MS) ? s.status === "ok" ? "stale" as const : "unavailable" as const : s.source.freshness } } : {}), windows, burn, busiest: { mode, since, sinceLabel, rows } });
    }
    const order: Record<Harness, number> = { claude: 0, codex: 1, cursor: 2, other: 3 };
    accounts.sort((a, b) => order[a.harness] - order[b.harness]);
    return { now, sampledFrom, accounts, sources, machines: await machineRows() };
  }

  return { sample, card, machineRows, threadAccounts };
}

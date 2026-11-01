import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createUsageTrend } from "../server-usage-trend";
import { createFleetUsageBridge, mergeUsageReadings, tokenBoundPoolSubscriptionId, type FleetUsageRead, type UsageReading } from "../server-usage-fleet";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const SESSION_RESET = NOW + 3 * HOUR;
const WEEK_RESET = NOW + 4 * 24 * HOUR;
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { vi.useRealTimers(); for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
const key = "openai:chatgpt:account_fixture_123";
const subscriptionId = tokenBoundPoolSubscriptionId("codex", key)!;
function remote(overrides: Partial<UsageReading> = {}): UsageReading {
  const source = { kind: "owner" as const, provider: "codex", label: "Codex · Studio", machines: ["studio"], ownerServerId: "owner_m1", hostId: "host_m1", identity: "token-verified" as const, freshness: "fresh" as const };
  return { id: `fleet-usage:codex:subscription:${subscriptionId}`, provider: "codex", harness: "codex", email: null, plan: "Pro", status: "ok", observedAt: NOW, subscriptionId, source, windows: [{ id: "owner:five-hour:", label: "5-hour limit", kind: "five-hour", model: null, pct: 31, resetsAt: SESSION_RESET }, { id: "owner:weekly:", label: "Weekly limit", kind: "weekly", model: null, pct: 43, resetsAt: WEEK_RESET }], ...overrides };
}
function coverage(reading = remote()): FleetUsageRead["coverage"] { return [{ machine: "studio", ownerServerId: reading.source.ownerServerId, hostId: reading.source.hostId, state: "fresh", providers: { codex: "fresh" } }]; }
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  let localAt = NOW - 60_000;
  let localStatus = "ok";
  let localPct = 20;
  let localReset = SESSION_RESET;
  let localKey: string | null = key;
  let includeWeekly = true;
  let fleet: FleetUsageRead = { readings: [remote()], coverage: coverage() };
  let failLocal = false;
  const host = createFakePluginHost({ sdk: {
    plugins: { callRpc: async (args) => {
      if (failLocal) throw new Error("Synthetic account pool unavailable");
      const value = args.method === "provider-usage.v1.listResources" ? { resources: [{ id: "stable-pool-id", providerId: "codex", label: "Existing account" }] } : { accountKey: localKey, observedAt: localAt, usage: { status: localStatus, accountEmail: "same@example.test", planLabel: "Pro", windows: [{ id: "five-hour", label: "Five-hour limit", kind: "five-hour", model: null, usedPercent: localPct, resetsAt: new Date(localReset).toISOString() }, { id: "weekly", label: "Weekly limit", kind: "weekly", model: null, usedPercent: 40, resetsAt: new Date(WEEK_RESET).toISOString() }] } };
      if (!includeWeekly && args.method !== "provider-usage.v1.listResources") value.usage!.windows = value.usage!.windows!.slice(0, 1);
      return args.outputSchema ? (args.outputSchema as any).parse(value) : value as never;
    } },
    threads: { list: async () => [] },
  } });
  hosts.push(host);
  const trend = createUsageTrend(host.bb, { cursorUsage: async () => null, planLabel: async (_provider, raw) => raw, accountFor: () => "stable-pool-id", fleetUsage: async () => fleet });
  return { ...host, trend, fleet(value: FleetUsageRead) { fleet = value; }, local(value: { at?: number; status?: string; pct?: number; reset?: number; accountKey?: string | null; includeWeekly?: boolean }) { localAt = value.at ?? localAt; localStatus = value.status ?? localStatus; localPct = value.pct ?? localPct; localReset = value.reset ?? localReset; includeWeekly = value.includeWeekly ?? includeWeekly; if ("accountKey" in value) localKey = value.accountKey!; }, failLocal() { failLocal = true; } };
}

describe("existing graph subscription integration", () => {
  it("keeps legacy Cursor history a JSON-only RPC result when it has no source metadata", async () => {
    const f = fixture();
    await f.bb.storage.kv.set("usage-trend:v1:accounts", ["cursor"]);
    await f.bb.storage.kv.set("usage-trend:v1:cursor", { v: 1, first: NOW - HOUR, lastObservedAt: NOW, harness: "cursor", email: null, plan: null, status: "ok", meta: { month: { label: "This month", kind: "monthly", model: null, resetsAt: WEEK_RESET, pct: 20 } }, rings: { month: { fine: [], coarse: [] } } });
    const account = (await f.trend.card()).accounts[0];
    expect(account.id).toBe("cursor");
    expect(account).not.toHaveProperty("source");
    const assertJson = (value: unknown): void => {
      expect(value).not.toBeUndefined();
      if (value && typeof value === "object") for (const item of Object.values(value)) assertJson(item);
    };
    assertJson(await f.trend.card());
  });
  it("uses only token-bound Codex identities and never email, plan, Claude or configured labels", () => {
    expect(subscriptionId).toMatch(/^bbsub1:[a-f0-9]{40}$/);
    expect(tokenBoundPoolSubscriptionId("claude", "anthropic:account:fixture")).toBeNull();
    expect(tokenBoundPoolSubscriptionId("codex", "same@example.test")).toBeNull();
    expect(tokenBoundPoolSubscriptionId("toString", key)).toBeNull();
  });
  it("keeps the local Pooler ID and chooses the newest verified same-window observation without adding percentages", async () => {
    const f = fixture(); await f.trend.sample();
    const card = await f.trend.card();
    expect(card.accounts.map((account) => account.id)).toEqual(["stable-pool-id"]);
    expect(card.accounts[0].windows.map((window) => [window.id, window.pct])).toEqual([["five-hour", 31], ["weekly", 43]]);
    expect(card.accounts[0].source).toMatchObject({ kind: "pool", machines: ["studio"] });
    expect(card.accounts[0].windows[0].series).toEqual([[NOW, 31]]);
    f.local({ at: NOW + 60_000, pct: 33 }); vi.setSystemTime(NOW + 60_000);
    await f.trend.sample();
    expect((await f.trend.card()).accounts[0].windows[0].pct).toBe(33);
    f.local({ at: NOW + 65_000, pct: 35 }); vi.setSystemTime(NOW + 65_000); await f.trend.sample();
    expect((await f.trend.card()).accounts[0].windows[0].series.at(-1)?.[1]).toBe(35);
  });

  it("retains a newly observed weekly window even when another window already has a newer sample", async () => {
    const f = fixture();
    f.local({ at: NOW, includeWeekly: false });
    f.fleet({ readings: [], coverage: [] });
    await f.trend.sample();
    vi.setSystemTime(NOW + 60_000);
    f.local({ at: NOW + 60_000, pct: 22 });
    const weekly = remote({ observedAt: NOW - 30_000, windows: [remote().windows[1]] });
    f.fleet({ readings: [weekly], coverage: coverage(weekly) });
    await f.trend.sample();
    const account = (await f.trend.card()).accounts[0];
    expect(account.windows).toContainEqual(expect.objectContaining({ label: "Week", pct: 43 }));
    expect(account.windows.find((window) => window.label === "Session")?.pct).toBe(22);
  });
  it("keeps unknown owner accounts separate even when email/plan or provider labels match", async () => {
    const f = fixture();
    f.local({ accountKey: null });
    f.fleet({ readings: [remote({ id: "fleet-usage:codex:owner:m1", subscriptionId: null, email: "same@example.test", source: { ...remote().source, identity: "unknown" } })], coverage: coverage() });
    await f.trend.sample();
    expect((await f.trend.card()).accounts.map((account) => account.id)).toEqual(["stable-pool-id", "fleet-usage:codex:owner:m1"]);
  });
  it("deduplicates verified observations across owners using newest per window, never another provider", () => {
    const first = remote();
    const newest = remote({ observedAt: NOW + 1000, windows: [{ ...first.windows[0], pct: 45 }], source: { ...first.source, label: "Codex · Work", machines: ["work"], ownerServerId: "owner_m4", hostId: "host_m4" } });
    const output = mergeUsageReadings([], [newest, first]);
    expect(output).toHaveLength(1); expect(output[0].windows[0].pct).toBe(45); expect(output[0].windows[1].pct).toBe(43);
    expect(mergeUsageReadings([], [first, remote({ id: "fleet-usage:claude:separate", provider: "claude", harness: "claude", subscriptionId: null })])).toHaveLength(2);
  });
  it("preserves previous window history across real reset boundaries and does not combine periods", async () => {
    const f = fixture(); f.fleet({ readings: [], coverage: [] });
    await f.trend.sample();
    const previous = (await f.trend.card()).accounts[0].windows[0].series;
    vi.setSystemTime(SESSION_RESET + 60_000);
    f.local({ at: SESSION_RESET + 60_000, reset: SESSION_RESET + 5 * HOUR, pct: 4 });
    await f.trend.sample();
    const current = (await f.trend.card()).accounts[0].windows[0];
    expect(current.pct).toBe(4); expect(current.resetsAt).toBe(SESSION_RESET + 5 * HOUR);
    expect(current.series.filter(([at]) => at < SESSION_RESET)).toEqual([]);
    expect(previous.some(([, pct]) => pct === 20)).toBe(true);
    const stored = await f.bb.storage.kv.get<any>("usage-trend:v1:stable-pool-id");
    expect(stored.rings["five-hour"].fine).toContain(200);
  });
  it("retains old local IDs, rings, daily history and busiest chat ledger when sources fail", async () => {
    const f = fixture(); f.fleet({ readings: [], coverage: [] });
    await f.trend.sample();
    await f.bb.storage.kv.set("usage-history", { "stable-pool-id": { "2027-01-13": 15 } });
    await f.bb.storage.kv.set("usage-turns:v1", { v: 1, seen: {}, scannedAt: NOW, turns: [[NOW - 1000, "thr_busy", "stable-pool-id", 42]] });
    f.failLocal(); vi.setSystemTime(NOW + 3 * 60_000); await f.trend.sample();
    const account = (await f.trend.card()).accounts[0];
    expect(account.id).toBe("stable-pool-id"); expect(account.windows[0].pct).toBe(20);
    expect(account.busiest.rows[0]).toMatchObject({ threadId: "thr_busy", tokens: 42 });
    expect(await f.bb.storage.kv.get("usage-history")).toEqual({ "stable-pool-id": { "2027-01-13": 15 } });
  });
  it("does not fabricate owner points, zeros, burn or forecasts when an owner becomes unavailable or stale", async () => {
    const f = fixture(); f.local({ accountKey: null });
    const r = remote({ id: "fleet-usage:codex:owner:m1", subscriptionId: null, source: { ...remote().source, identity: "unknown" } });
    f.fleet({ readings: [r], coverage: coverage(r) }); await f.trend.sample();
    const before = (await f.trend.card()).accounts.find((account) => account.id === r.id)!;
    expect(before.windows[0].series).toEqual([[NOW, 31]]);
    f.fleet({ readings: [], coverage: [{ machine: "studio", ownerServerId: null, hostId: null, state: "unavailable" }] });
    vi.setSystemTime(NOW + 10 * 60_000); await f.trend.sample();
    const after = (await f.trend.card()).accounts.find((account) => account.id === r.id)!;
    expect(after.windows[0].series).toEqual(before.windows[0].series);
    expect(after.windows[0]).toMatchObject({ pct: 31, burn: null, forecastAtReset: null, hits100At: null, rate: null });
    expect(after.source?.freshness).toBe("unavailable");
    f.fleet({ readings: [remote({ ...r, status: "error", observedAt: NOW - 600_000, windows: [], source: { ...r.source, freshness: "stale" } })], coverage: [{ machine: "studio", ownerServerId: "owner_m1", hostId: "host_m1", state: "stale" }] });
    await f.trend.sample();
    expect((await f.trend.card()).accounts.find((account) => account.id === r.id)?.windows[0].series).toEqual(before.windows[0].series);
  });
  it("does not create tabs for unavailable owners with no observed history", async () => {
    const f = fixture(); f.fleet({ readings: [remote({ status: "error", windows: [], source: { ...remote().source, freshness: "unavailable" } })], coverage: [] });
    await f.trend.sample();
    expect((await f.trend.card()).accounts.map((account) => account.id)).toEqual(["stable-pool-id"]);
  });
});

describe("actual finite Fleet usage bridge", () => {
  it("omits self feed, ignores unavailable/broker data, checks sample freshness and never exposes raw transport errors", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const calls: unknown[] = [];
    const snapshot = (ownerServerId: string, hostId: string, observedAt: number) => ({ ownerServerId, hostId, observedAt, providers: [{ providerId: "codex", status: "ok", identity: "verified", subscriptionId, planLabel: "Pro", observationId: "obs_fixture", method: "bb.system.usageLimits", windows: [{ label: "5-hour limit", usedPercent: 36, resetsAt: new Date(SESSION_RESET).toISOString() }] }] });
    const host = createFakePluginHost({ sdk: { system: { config: async () => ({ primaryHostId: "host_local" }) }, plugins: { callRpc: async (args) => {
      calls.push(args.input);
      const machine = (args.input as { machine: string }).machine;
      return (machine === "laptop" ? { state: "ok", reason: null, snapshot: snapshot("owner_local", "host_local", NOW) } : machine === "studio" ? { state: "ok", reason: null, snapshot: snapshot("owner_m1", "host_m1", NOW - 600_000) } : { state: "unavailable", reason: "raw ssh credential/backend diagnostic must never render", snapshot: snapshot("broker", "host_broker", NOW) }) as never;
    } } } }); hosts.push(host);
    const result = await createFleetUsageBridge(host.bb, { localOwner: async () => "owner_local", now: () => NOW })();
    expect(calls).toEqual([{ machine: "laptop" }, { machine: "studio" }, { machine: "work" }]);
    expect(result.readings).toHaveLength(1); expect(result.readings[0]).toMatchObject({ status: "error", windows: [], source: { freshness: "stale" } });
    expect(result.coverage).toContainEqual({ machine: "laptop", ownerServerId: "owner_local", hostId: "host_local", state: "self" });
    expect(JSON.stringify(result)).not.toContain("credential/backend");
  });
});


describe("owner rates use only current reported readings", () => {
  it("preserves the original graph burn/forecast calculation for fresh owner samples and disables it on provider failure", async () => {
    const f = fixture(); f.local({ accountKey: null });
    for (let index = 0; index < 3; index++) {
      const at = NOW + index * 10 * 60_000; vi.setSystemTime(at);
      const r = remote({ id: "fleet-usage:codex:owner:fresh", subscriptionId: null, observedAt: at, windows: [{ ...remote().windows[0], pct: 30 + index * 5 }], source: { ...remote().source, identity: "unknown" } });
      f.fleet({ readings: [r], coverage: coverage(r) }); await f.trend.sample();
    }
    const fresh = (await f.trend.card()).accounts.find((account) => account.id === "fleet-usage:codex:owner:fresh")!;
    expect(fresh.windows[0].burn).toBeCloseTo(30); expect(fresh.windows[0].forecastAtReset).not.toBeNull();
    f.fleet({ readings: [], coverage: [{ ...coverage()[0], providers: { codex: "unavailable" } }] }); await f.trend.sample();
    const failed = (await f.trend.card()).accounts.find((account) => account.id === fresh.id)!;
    expect(failed.windows[0].series).toEqual(fresh.windows[0].series);
    expect(failed.windows[0]).toMatchObject({ burn: null, rate: null, forecastAtReset: null });
  });
});


describe("expired owner windows", () => {
  it("does not import a new zero or an expired period as a fresh owner sample", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const host = createFakePluginHost({ sdk: { system: { config: async () => ({ primaryHostId: "local" }) }, plugins: { callRpc: async ({ input }) => ({ state: "ok", reason: null, snapshot: { ownerServerId: `owner_${(input as { machine: string }).machine}`, hostId: `host_${(input as { machine: string }).machine}`, observedAt: NOW, providers: [{ providerId: "codex", status: "ok", identity: "verified", subscriptionId, planLabel: "Pro", observationId: "actual_read", method: "bb.system.usageLimits", windows: [{ label: "5-hour limit", usedPercent: 87, resetsAt: new Date(NOW - 1).toISOString() }] }] } }) as never } } }); hosts.push(host);
    const result = await createFleetUsageBridge(host.bb, { localOwner: async () => "local-owner", now: () => NOW })();
    expect(result.readings.every((reading) => reading.status === "error" && reading.windows.length === 0)).toBe(true);
  });
});

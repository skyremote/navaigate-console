import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createUsageTrend, type UsageMachineRow } from "../server-usage-trend";
import { createFleetUsageBridge, ownerLinkKey, poolLinkKey, type FleetUsageRead, type UsageReading } from "../server-usage-fleet";
import { createUsageLinkAction, createUsageLinks, linkGroupId } from "../server-usage-links";
import { createAttentionIntegrations, deduplicateSubscriptions } from "../server-attention-integrations";
import { allowancesOf, longOf, readState, sameAccountHints, sessionOf, usageTotals } from "../src/usage-machines";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const SESSION_RESET = NOW + 3 * HOUR;
const WEEK_RESET = NOW + 4 * 24 * HOUR;
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { vi.useRealTimers(); for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

const ownerKey = ownerLinkKey("claude", "host_m1");
const poolKey = poolLinkKey("claude", "host_m5", "claude-pool");

function ownerReading(over: Partial<UsageReading> = {}): UsageReading {
  const source = { kind: "owner" as const, provider: "claude", label: "Claude · Studio", machines: ["studio"], ownerServerId: "owner_m1", hostId: "host_m1", identity: "unknown" as const, freshness: "fresh" as const };
  return {
    linkKey: ownerKey, id: "fleet-usage:claude:owner:m1", provider: "claude", harness: "claude", email: null, plan: "Max 20x", status: "ok", observedAt: NOW - 3 * 60_000, subscriptionId: null, source,
    windows: [{ id: "owner:five-hour:", label: "5-hour limit", kind: "five-hour", model: null, pct: 30, resetsAt: SESSION_RESET }, { id: "owner:weekly:", label: "Weekly limit", kind: "weekly", model: null, pct: 41, resetsAt: WEEK_RESET }],
    ...over,
  };
}
const coverage = (m1: "fresh" | "stale" | "unavailable" = "fresh"): FleetUsageRead["coverage"] => [
  { machine: "laptop", ownerServerId: "owner_m5", hostId: "host_m5", state: "self" },
  { machine: "studio", ownerServerId: "owner_m1", hostId: "host_m1", state: m1, providers: { claude: m1 === "fresh" ? "fresh" : "unavailable" } },
  { machine: "work", ownerServerId: null, hostId: null, state: "unavailable" },
];

function trendFixture(opts: { identity?: Record<string, string> } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  let fleet: FleetUsageRead = { readings: [ownerReading()], coverage: coverage() };
  let weekReset = WEEK_RESET;
  const host = createFakePluginHost({ sdk: {
    system: { config: async () => ({ primaryHostId: "host_m5" }) },
    plugins: { callRpc: async (args) => {
      const value = args.method === "provider-usage.v1.listResources"
        ? { resources: [{ id: "claude-pool", providerId: "claude-code", label: "pat@example.com" }] }
        : { accountKey: null, observedAt: NOW - 60_000, usage: { status: "ok", accountEmail: "pat@example.com", planLabel: "20x", windows: [{ id: "five-hour", label: "Session", kind: "five-hour", model: null, usedPercent: 28, resetsAt: new Date(SESSION_RESET).toISOString() }, { id: "weekly", label: "Weekly", kind: "weekly", model: null, usedPercent: 40, resetsAt: new Date(weekReset).toISOString() }] } };
      return args.outputSchema ? (args.outputSchema as any).parse(value) : value as never;
    } },
    threads: { list: async () => [] },
  } });
  hosts.push(host);
  const trend = createUsageTrend(host.bb, { cursorUsage: async () => null, planLabel: async (_h, raw) => raw, accountFor: () => "claude-pool", fleetUsage: async () => fleet, identityFor: async (key) => opts.identity?.[key] ?? null, localMachine: async () => "laptop" });
  return { ...host, trend, setFleet(value: FleetUsageRead) { fleet = value; }, setWeekReset(value: number) { weekReset = value; } };
}

describe("one row per provider and machine with its own read time", () => {
  it("records the Account Pooler as this machine and each owner feed as its machine, each with its observedAt", async () => {
    const f = trendFixture(); await f.trend.sample();
    const rows = (await f.trend.card()).machines!;
    expect(rows.map((r) => [r.machine, r.harness, r.observedAt, r.freshness])).toEqual([["laptop", "claude", NOW - 60_000, "fresh"], ["studio", "claude", NOW - 3 * 60_000, "fresh"]]);
    expect(rows.find((r) => r.machine === "laptop")).toMatchObject({ key: poolKey, label: "pat", identity: "unknown" });
    expect(rows.find((r) => r.machine === "studio")).toMatchObject({ key: ownerKey, plan: "Max 20x" });
    expect(new Set(rows.map((r) => r.allowanceId)).size).toBe(2);
    expect(rows.find((r) => r.machine === "studio")!.windows.map((w) => [w.kind, w.pct])).toEqual([["five-hour", 30], ["weekly", 41]]);
  });

  it("names this machine from Fleet's self entry before falling back to the local board", async () => {
    const f = trendFixture();
    f.setFleet({ readings: [], coverage: [{ machine: "studio", ownerServerId: "owner_m1", hostId: "host_m1", state: "self" }] });
    await f.trend.sample();
    expect((await f.trend.card()).machines!.map((r) => r.machine)).toEqual(["studio"]);
  });

  it("keeps the last reading of a machine that goes quiet and marks it unavailable, not current", async () => {
    const f = trendFixture(); await f.trend.sample();
    vi.setSystemTime(NOW + 20 * 60_000);
    f.setFleet({ readings: [], coverage: coverage("unavailable") });
    await f.trend.sample();
    const m1 = (await f.trend.card()).machines!.find((r) => r.machine === "studio")!;
    expect(m1.freshness).toBe("unavailable");
    expect(m1.observedAt).toBe(NOW - 3 * 60_000);
    expect(m1.windows.find((w) => w.kind === "weekly")?.pct).toBe(41);
  });
});

describe("one subscription counted once", () => {
  it("keeps same-email Claude readings on two machines as two allowances until they are confirmed", async () => {
    const f = trendFixture(); await f.trend.sample();
    const card = await f.trend.card();
    expect(card.accounts.filter((a) => a.harness === "claude")).toHaveLength(2);
  });

  it("merges the pool and owner reading into one allowance once both keys map to the same subscription", async () => {
    const id = linkGroupId([poolKey, ownerKey]);
    const f = trendFixture({ identity: { [poolKey]: id, [ownerKey]: id } });
    f.setFleet({ readings: [], coverage: coverage() });
    f.setFleet({ readings: [ownerReading({ subscriptionId: id, source: { ...ownerReading().source, identity: "confirmed" } })], coverage: coverage() });
    await f.trend.sample();
    const card = await f.trend.card();
    const claude = card.accounts.filter((a) => a.harness === "claude");
    expect(claude).toHaveLength(1);
    expect(claude[0].source).toMatchObject({ kind: "pool", identity: "confirmed", machines: ["studio"] });
    const rows = card.machines!;
    expect(new Set(rows.map((r) => r.allowanceId)).size).toBe(1);
    expect(rows.map((r) => r.identity)).toEqual(["confirmed", "confirmed"]);
    expect(usageTotals(rows)).toEqual({ readings: 2, allowances: 1, countedOnce: 1 });
  });

  it("stamps the Fleet bridge's owner readings with their link key and the confirmed subscription", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const snapshot = { ownerServerId: "owner_m1", hostId: "host_m1", observedAt: NOW - 1000, providers: [{ providerId: "claude-code", status: "ok", identity: "unknown", subscriptionId: null, planLabel: "Max", observationId: "o", method: "bb.system.usageLimits", windows: [{ label: "Weekly limit", usedPercent: 41, resetsAt: new Date(WEEK_RESET).toISOString() }] }] };
    const host = createFakePluginHost({ sdk: { system: { config: async () => ({ primaryHostId: "host_m5" }) }, plugins: { callRpc: async (args) => ((args.input as { machine: string }).machine === "studio" ? { state: "ok", reason: null, snapshot } : { state: "unavailable", reason: "x", snapshot: null }) as never } } });
    hosts.push(host);
    const plain = await createFleetUsageBridge(host.bb, { localOwner: async () => "owner_m5", now: () => NOW })();
    expect(plain.readings[0]).toMatchObject({ linkKey: ownerKey, subscriptionId: null, source: { identity: "unknown" } });
    const mapped = await createFleetUsageBridge(host.bb, { localOwner: async () => "owner_m5", now: () => NOW, identityFor: async (key) => (key === ownerKey ? "linked:claude:abc" : null) })();
    expect(mapped.readings[0]).toMatchObject({ subscriptionId: "linked:claude:abc", id: "fleet-usage:claude:subscription:linked:claude:abc", source: { identity: "confirmed" } });
  });
});

describe("confirmed links", () => {
  function linkFixture() {
    const host = createFakePluginHost({ sdk: {} }); hosts.push(host);
    return createUsageLinks(host.bb);
  }
  it("gives every member of a group the same id, and none to a reading that is not in one", async () => {
    const links = linkFixture();
    await links.link([poolKey, ownerKey]);
    expect(await links.idFor(poolKey)).toBe(await links.idFor(ownerKey));
    expect(await links.idFor(poolKey)).toMatch(/^linked:claude:[a-f0-9]{20}$/);
    expect(await links.idFor("claude:host_m4:native-default")).toBeNull();
  });
  it("grows a group when a third machine is added and separates it again on unlink", async () => {
    const links = linkFixture();
    await links.link([poolKey, ownerKey]);
    await links.link([ownerKey, "claude:host_m4:native-default"]);
    expect(await links.groups()).toEqual([[ "claude:host_m1:native-default", "claude:host_m4:native-default", poolKey].sort()]);
    await links.unlink([ownerKey]);
    expect(await links.groups()).toEqual([]);
    expect(await links.idFor(poolKey)).toBeNull();
  });
});

describe("the link action refuses what cannot be one subscription", () => {
  const rows = [{ key: poolKey, machine: "laptop" }, { key: ownerKey, machine: "studio" }, { key: "claude:host_m5:second", machine: "laptop" }, { key: "codex:host_m1:native-default", machine: "studio" }];
  function action() {
    const host = createFakePluginHost({ sdk: {} }); hosts.push(host);
    const links = createUsageLinks(host.bb);
    const changed = vi.fn(async () => {});
    return { links, changed, run: createUsageLinkAction({ links, rows: async () => rows, changed }) };
  }
  it("links two machines of one provider and tells the caller to re-read", async () => {
    const a = action();
    expect(await a.run({ keys: [poolKey, ownerKey], linked: true })).toEqual({ ok: true, groups: [[ownerKey, poolKey].sort()] });
    expect(a.changed).toHaveBeenCalledTimes(1);
    expect(await a.run({ keys: [poolKey], linked: false })).toEqual({ ok: true, groups: [] });
    expect(a.changed).toHaveBeenCalledTimes(2);
  });
  it.each([
    [["claude:host_m5:nobody", ownerKey], "no longer listed"],
    [[poolKey, "codex:host_m1:native-default"], "same provider"],
    [[poolKey, "claude:host_m5:second"], "two subscriptions"],
  ])("refuses %j", async (keys, message) => {
    const a = action();
    await expect(a.run({ keys, linked: true })).rejects.toThrow(message);
    expect(await a.links.groups()).toEqual([]);
    expect(a.changed).not.toHaveBeenCalled();
  });
});

describe("Home's allowance count (attention usage) follows confirmed links and equivalent window names", () => {
  const owner = { ownerServerId: "owner_m1", hostId: "host_m1", observedAt: Date.now(), providers: [{ providerId: "claude-code", status: "ok", subscriptionId: null, identity: "unknown", planLabel: null, windows: [{ label: "Weekly limit", usedPercent: 41, resetsAt: null }], method: "bb.system.usageLimits", observationId: "s" }] };
  function integrationFixture() {
    const host = createFakePluginHost({ pluginId: "usage-links-test", sdk: { system: { config: async () => ({ primaryHostId: "host_m5" }) }, plugins: { callRpc: async (args) => (((args.input as { machine?: string })?.machine === "studio") ? { state: "ok", reason: null, snapshot: owner } : { state: "unavailable", reason: "no", snapshot: null }) as never } } });
    hosts.push(host);
    const links = createUsageLinks(host.bb);
    const account = { id: "claude-pool", harness: "claude" as const, label: "Claude", email: null, plan: null, session: 20, sessionResetsAt: null, week: 40, weekResetsAt: null, cycleLabel: "This week", history: [], advice: null, status: "ok" as const };
    const integrations = createAttentionIntegrations(host.bb, { accounts: async () => [account], localOwner: async () => "owner_m5", links });
    return { host, links, integrations };
  }
  it("counts the same Claude account on Laptop and Studio once after the owner confirms it, with no JSON edited", async () => {
    const f = integrationFixture();
    const before = await f.integrations.usage();
    expect(before.subscriptions.filter((s) => s.window.toLowerCase().includes("week"))).toHaveLength(2);
    await f.links.link([poolKey, ownerKey]);
    f.integrations.forgetUsage();
    const after = await f.integrations.usage();
    const weekly = after.subscriptions.filter((s) => /week/i.test(s.window));
    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toMatchObject({ identityVerified: true });
    expect(weekly[0].hosts.sort()).toEqual(["host_m1", "host_m5"]);
  });
  it("matches a window by what it means, so a local week and a remote Weekly limit are one window", () => {
    const base = { provider: "claude", subscriptionId: "s1", observedAt: 1, collectedAt: 1, resetsAt: null, accountId: "a" };
    const out = deduplicateSubscriptions([
      { ...base, hostId: "h1", usedPercent: 40, window: "week" },
      { ...base, hostId: "h2", usedPercent: 41, window: "Weekly limit", observedAt: 2 },
      { ...base, hostId: "h1", usedPercent: 20, window: "session" },
      { ...base, hostId: "h2", usedPercent: 21, window: "5-hour limit", observedAt: 2 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((s) => /week/i.test(s.window))?.remainingPercent).toBe(59);
  });
});

describe("the Home table model", () => {
  const row = (over: Partial<UsageMachineRow> = {}): UsageMachineRow => ({
    key: "claude:h:a", provider: "claude", harness: "claude", machine: "laptop", label: null, plan: "Max 20x", observedAt: NOW - 60_000, freshness: "fresh", identity: "unknown", allowanceId: "a",
    windows: [{ kind: "five-hour", label: "Session", model: null, pct: 30, resetsAt: SESSION_RESET }, { kind: "weekly", label: "Week", model: null, pct: 41, resetsAt: WEEK_RESET }, { kind: "weekly", label: "Week · Opus", model: "opus", pct: 90, resetsAt: WEEK_RESET }],
    ...over,
  });
  it("reads the session and the week from the unmodelled windows only", () => {
    expect(sessionOf(row())).toMatchObject({ pct: 30, remaining: 70 });
    expect(longOf(row())).toMatchObject({ pct: 41, remaining: 59 });
  });
  it("never adds two machines' readings of one allowance: it takes the freshest", () => {
    const a = row({ key: "k1", machine: "laptop", allowanceId: "x", observedAt: NOW - 10 * 60_000 });
    const b = row({ key: "k2", machine: "studio", allowanceId: "x", observedAt: NOW - 60_000, windows: [{ kind: "weekly", label: "Week", model: null, pct: 44, resetsAt: WEEK_RESET }] });
    const [only] = allowancesOf([a, b]);
    expect(only.machines).toEqual(["laptop", "studio"]);
    expect(only.shared).toBe(true);
    expect(only.long?.pct).toBe(44);
    expect(only.session?.pct).toBe(30);
  });
  it("suggests, but does not merge, two Claude readings with the same weekly reset", () => {
    const a = row({ key: "k1", machine: "laptop", allowanceId: "a" });
    const b = row({ key: "k2", machine: "studio", allowanceId: "b" });
    expect(sameAccountHints([a, b])).toEqual([{ harness: "claude", keys: ["k1", "k2"], machines: ["laptop", "studio"], resetsAt: WEEK_RESET }]);
    expect(allowancesOf([a, b])).toHaveLength(2);
  });
  it("does not suggest when resets differ, a reading is unavailable, the provider is Cursor, or they are already one allowance", () => {
    const a = row({ key: "k1", machine: "laptop", allowanceId: "a" });
    const other = (over: Partial<UsageMachineRow>) => row({ key: "k2", machine: "studio", allowanceId: "b", ...over });
    expect(sameAccountHints([a, other({ windows: [{ kind: "weekly", label: "Week", model: null, pct: 41, resetsAt: WEEK_RESET + 5 * 60_000 }] })])).toEqual([]);
    expect(sameAccountHints([a, other({ freshness: "unavailable" })])).toEqual([]);
    expect(sameAccountHints([{ ...a, harness: "cursor" }, other({ harness: "cursor" })])).toEqual([]);
    expect(sameAccountHints([a, other({ allowanceId: "a" })])).toEqual([]);
  });
  it("calls a reading current, kept or unavailable", () => {
    expect(readState(row())).toBe("current");
    expect(readState(row({ freshness: "stale" }))).toBe("retained");
    expect(readState(row({ freshness: "unavailable", observedAt: NOW - HOUR }))).toBe("retained");
    expect(readState(row({ freshness: "unavailable", observedAt: null, windows: [] }))).toBe("unavailable");
  });
});

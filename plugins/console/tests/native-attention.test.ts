import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createAttention } from "../server-attention";
import { deduplicateSubscriptions } from "../server-attention-integrations";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
});
function fixture() {
  let now = 1_800_000_000_000;
  const rows = new Map(
    ["one", "two", "three"].map((id) => [
      id,
      makeThreadResponse({
        id,
        title: id,
        sectionId: "section-original",
        pinnedAt: 17,
        status: "idle",
        updatedAt: now - 10_000,
        runtime: { displayStatus: "idle" },
      }),
    ]),
  );
  let queued: unknown[] = [],
    interactions: unknown[] = [],
    childBusy = false,
    archived = 0;
  const nativeUpdates: unknown[] = [];
  let prRows: unknown = {};
  let beforePR: (() => Promise<void>) | null = null;
  const prCalls: string[] = [];
  const host = createFakePluginHost({
    pluginId: "attention-test",
    sdk: {
      plugins: {
        callRpc: async ({ method }) => {
          prCalls.push(method);
          if (method === "refresh" && beforePR) await beforePR();
          return (method === "refresh" ? { ok: true } : prRows) as never;
        },
      },
      threads: {
        get: async ({ threadId }) => {
          const r = rows.get(threadId);
          if (!r) throw new Error("404");
          return r;
        },
        list: async (args) =>
          (args?.parentThreadId
            ? childBusy
              ? [
                  {
                    ...rows.get("two")!,
                    activity: {
                      activeBackgroundAgentCount: 1,
                      activeBackgroundCommandCount: 0,
                      activeGoalCount: 0,
                      activePlanModeCount: 0,
                      activeWorkflowCount: 0,
                    },
                    queuedWork: "none",
                  },
                ]
              : []
            : [...rows.values()]
                .filter((r) => !args?.threadIds || args.threadIds.includes(r.id))
                .map((r) => ({
                  ...r,
                  activity: {
                    activeBackgroundAgentCount: r.activeBackgroundAgentCount,
                    activeBackgroundCommandCount: 0,
                    activeGoalCount: 0,
                    activePlanModeCount: 0,
                    activeWorkflowCount: 0,
                  },
                  queuedWork: "none",
                  hasPendingInteraction: false,
                  environmentHostId: "owner-host",
                }))) as never,
        queue: { list: async () => queued as never },
        interactions: { list: async () => interactions as never },
        update: async (args) => {
          nativeUpdates.push(args);
          const t = { ...rows.get(args.threadId)!, ...args };
          rows.set(args.threadId, t);
          return t;
        },
        archive: async () => {
          archived++;
          throw new Error("archive must not be called");
        },
      },
    },
  });
  hosts.push(host);
  const engine = createAttention(host.bb, () => now);
  return {
    ...host,
    engine,
    rows,
    nativeUpdates,
    prCalls,
    interceptPR(fn: () => Promise<void>) {
      beforePR = fn;
    },
    setPR(value: unknown) {
      prRows = value;
    },
    get archived() {
      return archived;
    },
    setQueue(v: unknown[]) {
      queued = v;
    },
    setInteractions(v: unknown[]) {
      interactions = v;
    },
    setChild(v: boolean) {
      childBusy = v;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}
describe("reversible native attention", () => {
  it("settles without altering native section/pin/order or invoking archive, and reload preserves Undo", async () => {
    const f = fixture();
    const original = structuredClone(f.rows.get("one"));
    const receipt = await f.engine.apply({ threadIds: ["one"], action: "settle" });
    expect((await f.engine.state()).records[0]?.mode).toBe("settled");
    expect(f.rows.get("one")).toEqual(original);
    expect(f.nativeUpdates).toEqual([]);
    expect(f.archived).toBe(0);
    let reloaded!: ReturnType<typeof createAttention>;
    await f.harness.lifecycle.reload((bb) => {
      reloaded = createAttention(bb, () => 1_800_000_000_000);
    });
    expect((await reloaded.undo(receipt.receiptId)).results[0]?.ok).toBe(true);
    expect((await reloaded.state()).records[0]?.mode).toBe("open");
    expect(await reloaded.undo(receipt.receiptId)).toEqual({
      receiptId: receipt.receiptId,
      results: [],
    });
    expect(f.rows.get("one")).toEqual(original);
  });
  it("protects active, queued, pending interaction and child jobs with independent bulk outcomes", async () => {
    const f = fixture();
    f.rows.set("two", {
      ...f.rows.get("two")!,
      status: "active",
      runtime: { displayStatus: "active" },
    });
    const r = await f.engine.apply({ threadIds: ["one", "two"], action: "settle" });
    expect(r.results.map((x) => x.ok)).toEqual([true, false]);
    f.setQueue([{}]);
    expect((await f.engine.apply({ threadIds: ["three"], action: "settle" })).results[0]?.ok).toBe(
      false,
    );
    f.setQueue([]);
    f.setInteractions([{}]);
    expect((await f.engine.apply({ threadIds: ["three"], action: "settle" })).results[0]?.ok).toBe(
      false,
    );
    f.setInteractions([]);
    f.setChild(true);
    expect((await f.engine.apply({ threadIds: ["three"], action: "settle" })).results[0]?.ok).toBe(
      false,
    );
  });
  it("wakes once on clock and pending decisions, refusing stale Undo", async () => {
    const f = fixture();
    const r = await f.engine.apply({
      threadIds: ["one"],
      action: "snooze",
      wakeAt: 1_800_000_001_000,
    });
    f.advance(1000);
    await f.engine.tick();
    const snapshot = await f.engine.state();
    await f.engine.tick();
    expect(await f.engine.state()).toEqual(snapshot);
    expect((await f.engine.undo(r.receiptId)).results[0]?.ok).toBe(false);
    await f.engine.apply({ threadIds: ["two"], action: "snooze", wakeAt: 1_800_001_001_000 });
    await f.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: f.rows.get("two")!,
      interaction: {} as never,
    });
    expect((await f.engine.state()).records.find((r) => r.threadId === "two")?.mode).toBe("open");
  });
  it("protects hidden top-level logical model members and wakes their root without changing core parentage", async () => {
    const f = fixture();
    f.rows.set("two", {
      ...f.rows.get("two")!,
      visibility: "hidden",
      parentThreadId: null,
      status: "active",
      runtime: { displayStatus: "active" },
    });
    await f.bb.storage.kv.set("native-conversation-root:two", "one");
    await f.bb.storage.kv.set("native-conversation:one", {
      rootThreadId: "one",
      members: [{ id: "one" }, { id: "two" }],
      arms: {},
    });
    expect((await f.engine.apply({ threadIds: ["one"], action: "settle" })).results[0]?.ok).toBe(
      false,
    );
    await f.engine.apply({ threadIds: ["one"], action: "snooze", wakeAt: 1_800_000_100_000 });
    await f.harness.behavior.emitThreadEvent("thread.active", { thread: f.rows.get("two")! });
    expect((await f.engine.state()).records.find((r) => r.threadId === "one")?.mode).toBe("open");
    expect(f.rows.get("two")?.parentThreadId).toBeNull();
    expect(f.rows.get("two")?.visibility).toBe("hidden");
  });
  it("detects intervening same-clock edits with receipt revisions", async () => {
    const f = fixture();
    const first = await f.engine.apply({ threadIds: ["one"], action: "settle" });
    await f.engine.apply({ threadIds: ["one"], action: "settle" });
    expect((await f.engine.undo(first.receiptId)).results[0]?.ok).toBe(false);
    expect((await f.engine.state()).records[0]?.mode).toBe("settled");
  });
  it("rejects invalid snooze times and keeps all automatic policies off", async () => {
    const f = fixture();
    await expect(
      f.engine.apply({ threadIds: ["one"], action: "snooze", wakeAt: 1 }),
    ).rejects.toThrow("future");
    await f.engine.configure("one", {
      autoMerge: false,
      requiredPrUrls: [],
      acceptancePending: true,
      inactiveAfterMs: null,
    });
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });
  it("only auto-settles a verified merged PR when every required URL is merged and acceptance is complete", async () => {
    const f = fixture();
    f.rows.set("one", { ...f.rows.get("one")!, pinnedAt: null, environmentId: "env-one" });
    const policy = {
      autoMerge: true,
      requiredPrUrls: ["https://github.com/org/repo/pull/1", "https://github.com/org/repo/pull/2"],
      requiredPrEnvironments: {
        "https://github.com/org/repo/pull/1": "env-one",
        "https://github.com/org/repo/pull/2": "env-two",
      },
      acceptancePending: false,
      inactiveAfterMs: null,
    };
    const prState = (merged: boolean) => ({
      "env-one": {
        outcome: "available",
        pullRequest: { state: "merged", url: policy.requiredPrUrls[0] },
      },
      "env-two": {
        outcome: "available",
        pullRequest: { state: merged ? "merged" : "open", url: policy.requiredPrUrls[1] },
      },
    });
    f.setPR(prState(false));
    await f.engine.configure("one", policy);
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
    f.setPR(prState(true));
    await f.engine.configure("one", { ...policy, acceptancePending: true });
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
    await f.engine.configure("one", policy);
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("settled");
    expect(f.prCalls).toEqual([
      "refresh",
      "refresh",
      "pullRequests",
      "refresh",
      "refresh",
      "pullRequests",
    ]);
  });
  it("honours a policy revision changed while a PR refresh is awaiting the owner", async () => {
    const f = fixture();
    f.rows.set("one", { ...f.rows.get("one")!, pinnedAt: null, environmentId: "env-one" });
    const policy = {
      autoMerge: true,
      requiredPrUrls: ["https://github.com/o/r/pull/1"],
      requiredPrEnvironments: {},
      acceptancePending: false,
      inactiveAfterMs: null,
    };
    f.setPR({
      "env-one": {
        outcome: "available",
        pullRequest: { state: "merged", url: policy.requiredPrUrls[0] },
      },
    });
    await f.engine.configure("one", policy);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
    f.interceptPR(async () => {
      entered();
      await blocked;
    });
    const tick = f.engine.tick();
    await reached;
    await f.engine.configure("one", { ...policy, autoMerge: false, acceptancePending: true });
    release();
    await tick;
    expect((await f.engine.state()).records.find((r) => r.threadId === "one")?.mode).toBe("open");
  });
  it("does not wake an extended snooze from an older timer snapshot", async () => {
    const f = fixture();
    f.rows.set("one", { ...f.rows.get("one")!, pinnedAt: null, environmentId: "env-one" });
    const policy = {
      autoMerge: true,
      requiredPrUrls: ["https://github.com/o/r/pull/1"],
      requiredPrEnvironments: {},
      acceptancePending: false,
      inactiveAfterMs: null,
    };
    f.setPR({
      "env-one": {
        outcome: "available",
        pullRequest: { state: "open", url: policy.requiredPrUrls[0] },
      },
    });
    await f.engine.configure("one", policy);
    await f.engine.apply({ threadIds: ["two"], action: "snooze", wakeAt: 1_800_000_001_000 });
    f.advance(1000);
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
    f.interceptPR(async () => {
      entered();
      await blocked;
    });
    const tick = f.engine.tick();
    await reached;
    await f.engine.apply({ threadIds: ["two"], action: "snooze", wakeAt: 1_800_003_601_000 });
    release();
    await tick;
    const current = (await f.engine.state()).records.find((r) => r.threadId === "two");
    expect(current?.mode).toBe("snoozed");
    expect(current?.wakeAt).toBe(1_800_003_601_000);
  });
  it("inactive settlement is opt-in, protects pins, and remains reversible", async () => {
    const f = fixture();
    await f.engine.configure("one", {
      autoMerge: false,
      requiredPrUrls: [],
      requiredPrEnvironments: {},
      acceptancePending: false,
      inactiveAfterMs: 3600_000,
    });
    f.advance(3600_001);
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
    f.rows.set("one", { ...f.rows.get("one")!, pinnedAt: null });
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("settled");
  });
  it("retitles through SDK and undo refuses concurrent title edits", async () => {
    const f = fixture();
    const r = await f.engine.apply({
      threadIds: ["one"],
      action: "retitle",
      title: "Reviewed title",
    });
    expect(f.nativeUpdates).toHaveLength(1);
    f.rows.set("one", { ...f.rows.get("one")!, title: "User's newer title" });
    expect((await f.engine.undo(r.receiptId)).results[0]?.ok).toBe(false);
    expect(f.rows.get("one")?.title).toBe("User's newer title");
  });
});
describe("exact subscription aggregation", () => {
  const observation = {
    provider: "codex",
    accountId: "a",
    hostId: "m1",
    subscriptionId: "sub-123",
    observedAt: 10,
    collectedAt: 20,
    usedPercent: 70,
    resetsAt: "2026-10-31T00:00:00Z",
    window: "week" as const,
  };
  it("counts an exact subscription once across hosts, using the freshest sample rather than summing allowances", () => {
    const rows = deduplicateSubscriptions([
      observation,
      { ...observation, hostId: "m5", observedAt: 12, usedPercent: 80 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.remainingPercent).toBe(20);
    expect(rows[0]?.hosts).toEqual(["m5", "m1"]);
  });
  it("keeps unknown identity separate and unknown allowance unknown", () => {
    const rows = deduplicateSubscriptions([
      { ...observation, subscriptionId: null, usedPercent: null },
      { ...observation, hostId: "m5", subscriptionId: null },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.remainingPercent).toBeNull();
    expect(rows.every((r) => !r.identityVerified)).toBe(true);
  });
});

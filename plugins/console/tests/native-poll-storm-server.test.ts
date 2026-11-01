import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createAttention } from "../server-attention";
import { createAttentionOwners } from "../server-attention-owners";
import { createFleetLink } from "../server-fleet";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CROWD = 50;

function fixture(options: { fetchDelayMs?: number } = {}) {
  const fetches: string[] = [];
  let inFlight = 0;
  let peak = 0;
  let localReads = 0;
  let failLocal = false;
  const host = createFakePluginHost({
    pluginId: "navaigate-skin",
    sdk: {
      system: { config: async () => ({ primaryHostId: "source-host" }) },
      plugins: {
        callRpc: async (args) => {
          fetches.push((args.input as { machine: string }).machine);
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(options.fetchDelayMs ?? 0);
          inFlight--;
          return { state: "unavailable", reason: "no-authenticated-owner-route", snapshot: null } as never;
        },
      },
      threads: {
        list: async () => {
          localReads++;
          if (failLocal) throw new Error("local thread list unavailable");
          return [{
            ...makeThreadResponse({ id: "local-1", title: "Local", status: "idle", runtime: { displayStatus: "idle" }, environmentId: null }),
            activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
            environmentHostId: "source-host",
            hasPendingInteraction: false,
            queuedWork: "none",
          }] as never;
        },
        interactions: { list: async () => [] },
        queue: { list: async () => [] },
      },
    },
  });
  hosts.push(host);
  const engine = createAttention(host.bb);
  const manager = createAttentionOwners(host.bb, engine, async () => "source-owner");
  return {
    ...host,
    manager,
    fetches,
    get peak() {
      return peak;
    },
    get localReads() {
      return localReads;
    },
    failLocal(value: boolean) {
      failLocal = value;
    },
  };
}

describe("attention fleet inbox under a polling storm", () => {
  it("answers 50 concurrent calls with one sweep of the owners", async () => {
    const f = fixture({ fetchDelayMs: 20 });
    const answers = await Promise.all(Array.from({ length: CROWD }, () => f.manager.fleetInbox()));
    expect(f.fetches.sort()).toEqual(["laptop", "studio", "work"]);
    expect(f.localReads).toBe(1);
    expect(new Set(answers).size).toBe(1);
  });

  it("asks the three owners at the same time instead of one after another", async () => {
    const f = fixture({ fetchDelayMs: 30 });
    await f.manager.fleetInbox();
    expect(f.peak).toBe(3);
  });

  it("does not keep an answer that began before a thread event", async () => {
    const f = fixture({ fetchDelayMs: 30 });
    const first = f.manager.fleetInbox();
    await sleep(5);
    await f.harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "local-1" }) } as never);
    await first;
    await f.manager.fleetInbox();
    expect(f.localReads).toBe(2);
  });

  it("serves the last good answer, with a notice, when a refresh fails, and does not retry at once", async () => {
    const f = fixture();
    const good = await f.manager.fleetInbox();
    await f.harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "local-1" }) } as never);
    f.failLocal(true);
    const stale = await Promise.all(Array.from({ length: CROWD }, () => f.manager.fleetInbox()));
    expect(f.localReads).toBe(2);
    for (const answer of stale) {
      expect(answer.rows).toEqual(good.rows);
      expect(answer.notices.join()).toContain("last answer");
    }
    await f.manager.fleetInbox();
    expect(f.localReads).toBe(2);
  });

  it("raises the failure when there is no earlier answer, and does not retry at once", async () => {
    const f = fixture();
    f.failLocal(true);
    const results = await Promise.allSettled(Array.from({ length: CROWD }, () => f.manager.fleetInbox()));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    await expect(f.manager.fleetInbox()).rejects.toThrow("local thread list unavailable");
    expect(f.localReads).toBe(1);
  });
});

describe("fleet board under a polling storm", () => {
  const raw = {
    me: { serverId: "sky", machineKey: "laptop", label: "laptop home", joined: true, brain: true },
    columns: [{ key: "laptop", label: "laptop home", serverId: "sky", url: "https://laptop.example.test", online: true, local: true, lastSeenAt: 10, capabilities: ["NAS"], counts: { running: 0, needsYou: 0, queued: 0 }, threads: [] }],
    commands: [],
    error: null,
    at: 11,
  };
  function link(answer: () => Promise<unknown>) {
    let calls = 0;
    const bb = {
      sdk: {
        plugins: {
          callRpc: async (call: { method: string; outputSchema: { parse: (value: unknown) => unknown } }) => {
            if (call.method === "board_get") calls++;
            return call.outputSchema.parse(await answer());
          },
        },
      },
    } as never;
    return { link: createFleetLink(bb), get calls() { return calls; } };
  }

  it("makes one Fleet board read for 50 concurrent calls", async () => {
    const f = link(async () => { await sleep(20); return raw; });
    const answers = await Promise.all(Array.from({ length: CROWD }, () => f.link.board()));
    expect(f.calls).toBe(1);
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]?.available).toBe(true);
  });

  it("reuses the answer for a moment, including a failed one, and then asks again", async () => {
    let failing = true;
    const f = link(async () => { if (failing) throw new Error("Fleet is not installed"); return raw; });
    expect((await f.link.board()).available).toBe(false);
    expect((await Promise.all(Array.from({ length: CROWD }, () => f.link.board()))).every((r) => !r.available)).toBe(true);
    expect(f.calls).toBe(1);
    failing = false;
    await sleep(3100);
    expect((await f.link.board()).available).toBe(true);
    expect(f.calls).toBe(2);
  });
});

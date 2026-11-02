import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createAttention, summarisePr } from "../server-attention";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
});

type Over = Partial<ReturnType<typeof makeThreadResponse>> & { queuedWork?: string; hasPendingInteraction?: boolean; busy?: boolean };

function fixture(opts: { settings?: Record<string, number | boolean>; pr?: Record<string, unknown>; features?: Record<string, boolean> } = {}) {
  let now = NOW;
  const rows = new Map<string, ReturnType<typeof makeThreadResponse> & { queuedWork?: string; hasPendingInteraction?: boolean }>();
  const sent: { threadId: string; text: string }[] = [];
  let prRows: Record<string, unknown> = opts.pr ?? {};
  let prFails: (keys: string[]) => boolean = () => false;
  let prCalls = 0;
  let eventCalls = 0;
  let folderCalls = 0;
  /** A folder as project-folders' `list` returns it. */
  const folder = (id: string) => ({ id, projectId: "p1", hostId: "owner-host", parentId: null, name: id, path: `/work/${id}`, sort: 0, kind: "folder" });
  let folderData: Record<string, unknown> = { folders: [], roots: [], bindings: {}, places: {}, errors: [], machines: [] };
  let foldersFail = false;
  /** project-folders as bb's plugin list shows it; null when it is not installed. */
  let foldersPlugin: { id: string; enabled: boolean; status: string } | null = { id: "project-folders", enabled: true, status: "running" };
  const turns = new Map<string, number>();
  const add = (id: string, over: Over = {}) => {
    const { busy, ...rest } = over;
    rows.set(
      id,
      makeThreadResponse({
        id,
        title: id,
        status: "idle",
        updatedAt: now - 10 * DAY,
        pinnedAt: null,
        runtime: { displayStatus: busy ? "active" : "idle" },
        ...rest,
      }) as never,
    );
  };
  const host = createFakePluginHost({
    pluginId: "rail-stash-test",
    settings: opts.settings,
    sdk: {
      plugins: {
        list: async () => ({ plugins: foldersPlugin ? [foldersPlugin] : [] }) as never,
        callRpc: async (args: { pluginId: string; method: string; input?: { keys?: string[] }; outputSchema?: { parse: (v: unknown) => unknown } }) => {
          if (args.pluginId === "project-folders") {
            folderCalls++;
            if (foldersFail) throw new Error("project-folders is not running");
            return (args.outputSchema ? args.outputSchema.parse(folderData) : folderData) as never;
          }
          prCalls++;
          const keys = args.input?.keys ?? [];
          if (prFails(keys)) throw new Error("pr plugin batch failed");
          return Object.fromEntries(Object.entries(prRows).filter(([k]) => keys.includes(k))) as never;
        },
      },
      threads: {
        get: async ({ threadId }) => rows.get(threadId) as never,
        list: async (args) =>
          [...rows.values()]
            .filter((r) => (args?.parentThreadId ? r.parentThreadId === args.parentThreadId : !args?.threadIds || args.threadIds.includes(r.id)))
            .map((r) => ({
              ...r,
              activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
              queuedWork: r.queuedWork ?? "none",
              hasPendingInteraction: r.hasPendingInteraction ?? false,
              environmentHostId: "owner-host",
            })) as never,
        events: { list: async (args: { threadId: string }) => (eventCalls++, turns.has(args.threadId) ? [{ createdAt: turns.get(args.threadId)! }] : []) as never },
        queue: { list: async () => [] as never },
        interactions: { list: async () => [] as never },
        send: async (args: { threadId: string; input: { text: string }[] }) => {
          sent.push({ threadId: args.threadId, text: args.input[0]!.text });
          return {} as never;
        },
      },
    },
  });
  hosts.push(host);
  const featureOn = (id: string) => opts.features?.[id] ?? true;
  const engine = createAttention(host.bb, () => now, featureOn);
  return {
    ...host,
    engine,
    rows,
    sent,
    add,
    setPr: (v: Record<string, unknown>) => {
      prRows = v;
    },
    failPrBatches: (fails: (keys: string[]) => boolean) => {
      prFails = fails;
    },
    prCalls: () => prCalls,
    eventCalls: () => eventCalls,
    folderCalls: () => folderCalls,
    /** What project-folders answers: the folders that exist, chats filed by hand ("" is the project root) and working folders. */
    setFolders: (v: { folders?: string[]; places?: Record<string, string>; bindings?: Record<string, string> }) => {
      folderData = { folders: (v.folders ?? []).map(folder), roots: [], bindings: v.bindings ?? {}, places: v.places ?? {}, errors: [], machines: [] };
    },
    failFolders: (fail: boolean) => {
      foldersFail = fail;
    },
    /** project-folders in bb's plugin list: null when not installed, enabled false when switched off. */
    setFoldersPlugin: (v: { enabled: boolean } | null) => {
      foldersPlugin = v ? { id: "project-folders", enabled: v.enabled, status: v.enabled ? "running" : "disabled" } : null;
    },
    /** The plugin reloaded: a new engine on the same settings, kv and database. */
    restart: async () => {
      let next: ReturnType<typeof createAttention> | undefined;
      hosts.push(await host.harness.lifecycle.reload((bb) => void (next = createAttention(bb, () => now, featureOn))));
      return next!;
    },
    warnings: () => host.harness.logEntries.filter((e) => e.level === "warn").map((e) => e.message),
    /** The time of the chat's newest user message or finished turn. */
    turnAt: (id: string, at: number) => {
      turns.set(id, at);
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const pr = (checks: "passing" | "failing" | "pending", failedCount = 0, state = "open") => ({
  outcome: "available",
  pullRequest: { number: 12, url: "https://github.com/example/x/pull/12", state, checks: { state: checks, failedCount, totalCount: 5 } },
});

describe("Stash is a mode beside settled and snoozed", () => {
  it("stashes on request, lists the chat as stashed, and Restore returns it to open", async () => {
    const f = fixture();
    f.add("a");
    const done = await f.engine.apply({ threadIds: ["a"], action: "stash" });
    expect(done.results[0]?.ok).toBe(true);
    expect((await f.engine.state()).records[0]?.mode).toBe("stashed");
    expect((await f.engine.inbox()).rows[0]?.status).toBe("stashed");
    const back = await f.engine.apply({ threadIds: ["a"], action: "restore" });
    expect(back.results[0]?.ok).toBe(true);
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
    expect((await f.engine.inbox()).rows[0]?.status).not.toBe("stashed");
  });

  it("Undo of a stash puts the chat back", async () => {
    const f = fixture();
    f.add("a");
    const done = await f.engine.apply({ threadIds: ["a"], action: "stash" });
    await f.engine.undo(done.receiptId);
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });

  it("refuses to stash a chat that is running", async () => {
    const f = fixture();
    f.add("busy", { busy: true });
    const done = await f.engine.apply({ threadIds: ["busy"], action: "stash" });
    expect(done.results[0]?.ok).toBe(false);
    expect((await f.engine.state()).records).toEqual([]);
  });

  it("a stashed chat that starts working again leaves the Stash", async () => {
    const f = fixture();
    f.add("a");
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    await f.engine.wake("a");
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });
});

describe("a stashed chat comes back when anything happens in it", () => {
  const touch = (f: ReturnType<typeof fixture>, id: string, over: Record<string, unknown> = {}) =>
    f.rows.set(id, { ...f.rows.get(id)!, ...over } as never);

  it("records when the chat was stashed", async () => {
    const f = fixture();
    f.add("a");
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    expect((await f.engine.state()).records[0]?.stashedAt).toBe(NOW);
    await f.engine.apply({ threadIds: ["a"], action: "restore" });
    expect((await f.engine.state()).records[0]?.stashedAt).toBeUndefined();
  });

  it("stashed, then a new turn, then opened: the chat is out of the Stash and stays out", async () => {
    const f = fixture();
    f.add("a");
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    f.advance(3_600_000);
    touch(f, "a", { updatedAt: NOW + 3_600_000 });
    f.turnAt("a", NOW + 3_500_000);
    const row = (await f.engine.inbox()).rows[0];
    expect(row?.status).toBe("reviewable");
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
    f.advance(60_000);
    expect((await f.engine.inbox()).rows[0]?.status).toBe("reviewable");
  });

  it("a rename or other edit after stashing moves updatedAt but does not bring the chat back", async () => {
    const f = fixture();
    f.add("a");
    f.turnAt("a", NOW - DAY); // its last real turn was before it was stashed
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    f.advance(3_600_000);
    touch(f, "a", { updatedAt: NOW + 3_600_000 });
    expect((await f.engine.inbox()).rows[0]?.status).toBe("stashed");
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("stashed");
  });

  it("reads a stashed chat's events once per change, not on every look", async () => {
    const f = fixture();
    f.add("a");
    f.turnAt("a", NOW - DAY);
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    f.advance(3_600_000);
    touch(f, "a", { updatedAt: NOW + 3_600_000 }); // a rename: updatedAt moved, no turn
    await f.engine.inbox();
    expect(f.eventCalls()).toBe(1);
    await f.engine.inbox();
    await f.engine.tick();
    expect(f.eventCalls()).toBe(1);
    touch(f, "a", { updatedAt: NOW + 3_700_000 }); // changed again: read again
    await f.engine.inbox();
    expect(f.eventCalls()).toBe(2);
    f.turnAt("a", NOW + 3_650_000); // and now it holds a real turn
    touch(f, "a", { updatedAt: NOW + 3_800_000 });
    expect((await f.engine.inbox()).rows[0]?.status).toBe("reviewable");
    expect(f.eventCalls()).toBe(3);
  });

  it("forgets what it read for a chat once it is out of the Stash, so a second stash reads afresh", async () => {
    const f = fixture();
    f.add("a");
    f.turnAt("a", NOW - DAY);
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    f.advance(1_000);
    touch(f, "a", { updatedAt: NOW + 1_000 });
    await f.engine.inbox();
    expect(f.eventCalls()).toBe(1);
    await f.engine.apply({ threadIds: ["a"], action: "restore" });
    f.advance(1_000);
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    f.advance(1_000);
    touch(f, "a", { updatedAt: NOW + 3_000 });
    expect((await f.engine.inbox()).rows[0]?.status).toBe("stashed");
    expect(f.eventCalls()).toBe(2);
  });

  it("stashed with no activity stays stashed", async () => {
    const f = fixture();
    f.add("a");
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    f.advance(3_600_000);
    expect((await f.engine.inbox()).rows[0]?.status).toBe("stashed");
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("stashed");
  });

  it("a queued message brings the chat back", async () => {
    const f = fixture();
    f.add("a");
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    touch(f, "a", { queuedWork: "queued" });
    expect((await f.engine.inbox()).rows[0]?.status).toBe("waiting");
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });

  it("a question waiting for a reply brings the chat back", async () => {
    const f = fixture();
    f.add("a");
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    touch(f, "a", { hasPendingInteraction: true });
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });

  it("a turn that starts and finishes between two looks still brings the chat back, on the next minute tick", async () => {
    const f = fixture();
    f.add("a");
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    f.advance(120_000);
    touch(f, "a", { updatedAt: NOW + 60_000 });
    f.turnAt("a", NOW + 60_000);
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });

  it("a chat stashed before the stash time was recorded comes back from its change time", async () => {
    const f = fixture();
    f.add("a");
    await f.engine.apply({ threadIds: ["a"], action: "stash" });
    const stored = (await f.engine.state()).records[0]!;
    const { stashedAt: _gone, ...legacy } = stored;
    f.bb.storage.database().prepare("UPDATE nav_attention SET value = ? WHERE thread_id = ?").run(JSON.stringify(legacy), "a");
    f.advance(1000);
    touch(f, "a", { updatedAt: NOW + 500 });
    f.turnAt("a", NOW + 500);
    expect((await f.engine.inbox()).rows[0]?.status).toBe("reviewable");
  });
});

describe("the minute-clock sweep", () => {
  it("stashes chats idle for seven days by default", async () => {
    const f = fixture();
    f.add("old", { updatedAt: NOW - 8 * DAY });
    f.add("fresh", { updatedAt: NOW - 2 * DAY });
    await f.engine.tick();
    const modes = Object.fromEntries((await f.engine.state()).records.map((r) => [r.threadId, r.mode]));
    expect(modes).toEqual({ old: "stashed" });
  });

  it("follows the days setting", async () => {
    const f = fixture({ settings: { stashAfterDays: 2 } });
    f.add("three", { updatedAt: NOW - 3 * DAY });
    f.add("one", { updatedAt: NOW - 1 * DAY });
    await f.engine.tick();
    expect((await f.engine.state()).records.map((r) => r.threadId)).toEqual(["three"]);
  });

  it("is switched off by 0 days", async () => {
    const f = fixture({ settings: { stashAfterDays: 0 } });
    f.add("old", { updatedAt: NOW - 30 * DAY });
    await f.engine.tick();
    expect((await f.engine.state()).records).toEqual([]);
  });

  it("skips running, pinned, waiting and needs-you chats", async () => {
    const f = fixture();
    f.add("running", { busy: true });
    f.add("pinned", { pinnedAt: 5 });
    f.add("waiting", { queuedWork: "queued" });
    f.add("needs", { hasPendingInteraction: true });
    f.add("idle");
    await f.engine.tick();
    expect((await f.engine.state()).records.map((r) => [r.threadId, r.mode])).toEqual([["idle", "stashed"]]);
  });

  it("leaves settled and snoozed chats alone and skips sub-agent children", async () => {
    const f = fixture();
    f.add("settled");
    f.add("kid", { parentThreadId: "parent" });
    await f.engine.apply({ threadIds: ["settled"], action: "settle" });
    await f.engine.tick();
    const modes = Object.fromEntries((await f.engine.state()).records.map((r) => [r.threadId, r.mode]));
    expect(modes).toEqual({ settled: "settled" });
  });

  it("checks no more often than every ten minutes", async () => {
    const f = fixture();
    await f.engine.tick();
    f.add("late");
    await f.engine.tick();
    expect((await f.engine.state()).records).toEqual([]);
    f.advance(11 * 60_000);
    await f.engine.tick();
    expect((await f.engine.state()).records.map((r) => r.threadId)).toEqual(["late"]);
  });
});

describe("the sweep only stashes chats that are not in a folder", () => {
  it("leaves a chat filed in a folder by hand where it is and stashes the loose one", async () => {
    const f = fixture();
    f.setFolders({ folders: ["f1"], places: { filed: "f1" } });
    f.add("filed");
    f.add("loose");
    await f.engine.stashSweep(true);
    expect((await f.engine.state()).records.map((r) => [r.threadId, r.mode])).toEqual([["loose", "stashed"]]);
  });

  it("leaves a chat whose working folder is a folder where it is", async () => {
    const f = fixture();
    f.setFolders({ folders: ["f1"], bindings: { envF: "f1" } });
    f.add("works-in-folder", { environmentId: "envF" });
    f.add("loose", { environmentId: "envRoot" });
    await f.engine.stashSweep(true);
    expect((await f.engine.state()).records.map((r) => r.threadId)).toEqual(["loose"]);
  });

  it("stashes a chat filed at the project root, even when its working folder is a folder: filing by hand wins", async () => {
    const f = fixture();
    f.setFolders({ folders: ["f1"], places: { root: "" }, bindings: { envF: "f1" } });
    f.add("root", { environmentId: "envF" });
    await f.engine.stashSweep(true);
    expect((await f.engine.state()).records.map((r) => r.threadId)).toEqual(["root"]);
  });

  it("stashes a chat whose folder no longer exists, as the sidebar shows it loose", async () => {
    const f = fixture();
    f.setFolders({ folders: [], places: { orphan: "gone" } });
    f.add("orphan");
    await f.engine.stashSweep(true);
    expect((await f.engine.state()).records.map((r) => r.threadId)).toEqual(["orphan"]);
  });

  it("stashes nothing when project-folders cannot answer, says so once, and catches up on the next sweep", async () => {
    const f = fixture();
    f.add("loose");
    f.failFolders(true);
    expect((await f.engine.stashSweep(true)).stashed).toEqual([]);
    expect((await f.engine.stashSweep(true)).stashed).toEqual([]);
    expect((await f.engine.state()).records).toEqual([]);
    expect(f.warnings().filter((m) => m.includes("project-folders"))).toHaveLength(1);
    f.failFolders(false);
    expect((await f.engine.stashSweep(true)).stashed).toEqual(["loose"]);
  });

  it("treats every chat as loose when project-folders is not installed, as the sidebar shows them", async () => {
    const f = fixture();
    f.setFoldersPlugin(null);
    f.setFolders({ folders: ["f1"], places: { filed: "f1" } });
    f.add("filed");
    expect((await f.engine.stashSweep(true)).stashed).toEqual(["filed"]);
    expect(f.folderCalls()).toBe(0);
    expect(f.warnings()).toEqual([]);
  });

  it("treats every chat as loose when project-folders is switched off", async () => {
    const f = fixture();
    f.setFoldersPlugin({ enabled: false });
    f.setFolders({ folders: ["f1"], places: { filed: "f1" } });
    f.add("filed");
    expect((await f.engine.stashSweep(true)).stashed).toEqual(["filed"]);
    expect(f.folderCalls()).toBe(0);
  });

  it("treats every chat as loose when the folders feature is off in the picker", async () => {
    const f = fixture({ features: { "EXTRA-X": false } });
    f.setFolders({ folders: ["f1"], places: { filed: "f1" } });
    f.add("filed");
    expect((await f.engine.stashSweep(true)).stashed).toEqual(["filed"]);
    expect(f.folderCalls()).toBe(0);
  });

  it("filed chats do not use up the batch, so loose chats behind them are still stashed", async () => {
    const f = fixture();
    const filed = Array.from({ length: 30 }, (_, i) => `filed${i}`);
    f.setFolders({ folders: ["f1"], places: Object.fromEntries(filed.map((id) => [id, "f1"])) });
    for (const id of filed) f.add(id, { updatedAt: NOW - 40 * DAY });
    f.add("loose", { updatedAt: NOW - 8 * DAY });
    expect((await f.engine.stashSweep(true)).stashed).toEqual(["loose"]);
  });

  it("does not ask project-folders when no chat is old enough", async () => {
    const f = fixture();
    f.add("fresh", { updatedAt: NOW - DAY });
    await f.engine.stashSweep(true);
    expect(f.folderCalls()).toBe(0);
  });

  it("a stash by hand still works on a chat in a folder", async () => {
    const f = fixture();
    f.setFolders({ folders: ["f1"], places: { filed: "f1" } });
    f.add("filed");
    const done = await f.engine.apply({ threadIds: ["filed"], action: "stash" });
    expect(done.results[0]?.ok).toBe(true);
    expect((await f.engine.state()).records[0]?.mode).toBe("stashed");
  });
});

describe("chats stashed out of folders before the rule go back once", () => {
  it("returns filed chats to their folders, leaves loose ones stashed, and does it only once", async () => {
    const f = fixture();
    f.add("filed");
    f.add("bound", { environmentId: "envF" });
    f.add("loose");
    await f.engine.apply({ threadIds: ["filed", "bound", "loose"], action: "stash" });
    f.setFolders({ folders: ["f1"], places: { filed: "f1" }, bindings: { envF: "f1" } });
    expect((await f.engine.releaseFiled(true)).released.sort()).toEqual(["bound", "filed"]);
    const modes = Object.fromEntries((await f.engine.state()).records.map((r) => [r.threadId, r.mode]));
    expect(modes).toEqual({ filed: "open", bound: "open", loose: "stashed" });
    await f.engine.apply({ threadIds: ["filed"], action: "stash" });
    expect((await f.engine.releaseFiled(true)).released).toEqual([]);
    expect((await f.engine.state()).records.find((r) => r.threadId === "filed")?.mode).toBe("stashed");
  });

  it("tries again when project-folders cannot answer, without marking itself done", async () => {
    const f = fixture();
    f.add("filed");
    await f.engine.apply({ threadIds: ["filed"], action: "stash" });
    f.setFolders({ folders: ["f1"], places: { filed: "f1" } });
    f.failFolders(true);
    expect((await f.engine.releaseFiled(true)).released).toEqual([]);
    expect((await f.engine.state()).records[0]?.mode).toBe("stashed");
    f.failFolders(false);
    expect((await f.engine.releaseFiled(true)).released).toEqual(["filed"]);
  });

  it("while it waits for project-folders, a chat stashed by hand stays stashed", async () => {
    const f = fixture();
    f.add("early");
    f.add("late");
    f.setFolders({ folders: ["f1"], places: { early: "f1", late: "f1" } });
    await f.engine.apply({ threadIds: ["early"], action: "stash" });
    f.failFolders(true);
    await f.engine.releaseFiled(true);
    f.advance(60_000);
    await f.engine.apply({ threadIds: ["late"], action: "stash" });
    f.failFolders(false);
    expect((await f.engine.releaseFiled(true)).released).toEqual(["early"]);
    expect((await f.engine.state()).records.find((r) => r.threadId === "late")?.mode).toBe("stashed");
  });

  it("stays done after a restart, so a later stash by hand is never undone", async () => {
    const f = fixture();
    f.add("filed");
    f.setFolders({ folders: ["f1"], places: { filed: "f1" } });
    await f.engine.releaseFiled(true);
    const again = await f.restart();
    f.advance(60_000);
    await again.apply({ threadIds: ["filed"], action: "stash" });
    expect((await again.releaseFiled(true)).released).toEqual([]);
    expect((await again.state()).records[0]?.mode).toBe("stashed");
  });

  it("runs from the minute clock before the sweep", async () => {
    const f = fixture();
    f.add("filed");
    await f.engine.apply({ threadIds: ["filed"], action: "stash" });
    f.setFolders({ folders: ["f1"], places: { filed: "f1" } });
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });
});

describe("owner-sourced PR on attention rows", () => {
  it("summarises the owner's pull request for each row", async () => {
    const f = fixture({ pr: { env1: pr("failing", 2) } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    const row = (await f.engine.inbox()).rows[0]!;
    expect(row.pr).toEqual({ number: 12, url: "https://github.com/example/x/pull/12", state: "open", checks: "failing", failedCount: 2 });
  });

  it("leaves pr out when the branch has no pull request", async () => {
    const f = fixture({ pr: { env1: { outcome: "absent" } } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    expect((await f.engine.inbox()).rows[0]?.pr).toBeUndefined();
    expect(summarisePr(undefined)).toBeNull();
  });
});

describe("CI failed wakes the owning chat", () => {
  const run = async (f: ReturnType<typeof fixture>) => f.engine.ciCheck(true);

  it("stays quiet on the first look, then posts CI failed when checks turn to failing", async () => {
    const f = fixture({ pr: { env1: pr("passing") } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    expect((await run(f)).notified).toEqual([]);
    f.setPr({ env1: pr("failing", 2) });
    expect((await run(f)).notified).toEqual(["a"]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.threadId).toBe("a");
    expect(f.sent[0]?.text).toContain("CI failed: 2 checks failing on PR #12");
    expect(f.sent[0]?.text).toContain("https://github.com/example/x/pull/12");
  });

  it("does not repeat while the checks stay failing, and posts again after a pass and a new failure", async () => {
    const f = fixture({ pr: { env1: pr("passing") } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    await run(f);
    f.setPr({ env1: pr("failing", 1) });
    await run(f);
    await run(f);
    expect(f.sent).toHaveLength(1);
    f.setPr({ env1: pr("pending") });
    await run(f);
    f.setPr({ env1: pr("failing", 1) });
    await run(f);
    expect(f.sent).toHaveLength(2);
  });

  it("does not wake a settled chat, and does nothing when switched off", async () => {
    const f = fixture({ pr: { env1: pr("passing") } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    await run(f);
    await f.engine.apply({ threadIds: ["a"], action: "settle" });
    f.setPr({ env1: pr("failing", 1) });
    await run(f);
    expect(f.sent).toEqual([]);
    const off = fixture({ settings: { ciWake: false }, pr: { env1: pr("failing", 1) } });
    off.add("b", { environmentId: "env1", updatedAt: NOW - DAY });
    expect((await off.engine.ciCheck(true)).notified).toEqual([]);
  });

  it("ignores merged or closed pull requests", async () => {
    const f = fixture({ pr: { env1: pr("passing") } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    await run(f);
    f.setPr({ env1: pr("failing", 1, "merged") });
    await run(f);
    expect(f.sent).toEqual([]);
  });

  it("runs on its own minute schedule, no more often than every two minutes", async () => {
    const f = fixture({ pr: { env1: pr("passing") } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    await f.harness.runSchedule("attention-ci");
    f.setPr({ env1: pr("failing", 1) });
    await f.harness.runSchedule("attention-ci");
    expect(f.sent).toEqual([]);
    f.advance(3 * 60_000);
    await f.harness.runSchedule("attention-ci");
    expect(f.sent).toHaveLength(1);
  });
});

describe("Restore and Undo hold against the next sweep", () => {
  const TEN_MINUTES_AND_A_BIT = 11 * 60_000;

  it("a chat the sweep stashed and the user restored is not stashed again ten minutes later", async () => {
    const f = fixture();
    f.add("old", { updatedAt: NOW - 8 * DAY });
    await f.engine.stashSweep(true);
    expect((await f.engine.state()).records[0]?.mode).toBe("stashed");
    await f.engine.apply({ threadIds: ["old"], action: "restore" });
    f.advance(TEN_MINUTES_AND_A_BIT);
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
    expect((await f.engine.inbox()).rows[0]?.status).not.toBe("stashed");
  });

  it("an Undo of a stash is not stashed again ten minutes later", async () => {
    const f = fixture();
    f.add("old", { updatedAt: NOW - 8 * DAY });
    const done = await f.engine.apply({ threadIds: ["old"], action: "stash" });
    await f.engine.undo(done.receiptId);
    f.advance(TEN_MINUTES_AND_A_BIT);
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });

  it("an Undo of a settle on an old chat is not stashed again ten minutes later", async () => {
    const f = fixture();
    f.add("old", { updatedAt: NOW - 8 * DAY });
    const done = await f.engine.apply({ threadIds: ["old"], action: "settle" });
    await f.engine.undo(done.receiptId);
    f.advance(TEN_MINUTES_AND_A_BIT);
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });

  it("a restored chat is stashed again once it has then been idle for the full period", async () => {
    const f = fixture();
    f.add("old", { updatedAt: NOW - 8 * DAY });
    await f.engine.apply({ threadIds: ["old"], action: "stash" });
    await f.engine.apply({ threadIds: ["old"], action: "restore" });
    f.advance(8 * DAY);
    await f.engine.tick();
    expect((await f.engine.state()).records[0]?.mode).toBe("stashed");
  });

  it("an Undo still refuses when the chat changed since the receipt", async () => {
    const f = fixture();
    f.add("a", { updatedAt: NOW - 8 * DAY });
    const done = await f.engine.apply({ threadIds: ["a"], action: "stash" });
    await f.engine.apply({ threadIds: ["a"], action: "restore" });
    const undone = await f.engine.undo(done.receiptId);
    expect(undone.results[0]?.ok).toBe(false);
    expect((await f.engine.state()).records[0]?.mode).toBe("open");
  });
});

describe("the sweep leaves failed chats where the user can see them", () => {
  it("does not stash a chat whose last run failed", async () => {
    const f = fixture();
    f.add("broken", { status: "error", updatedAt: NOW - 30 * DAY });
    f.add("quiet", { updatedAt: NOW - 30 * DAY });
    await f.engine.tick();
    expect((await f.engine.state()).records.map((r) => [r.threadId, r.mode])).toEqual([["quiet", "stashed"]]);
    expect((await f.engine.inbox()).rows.find((r) => r.threadId === "broken")?.status).toBe("failed");
  });
});

describe("the PR lookups behind Work needs you", () => {
  it("asks the PR plugin once for repeated polls inside a minute, and again after it", async () => {
    const f = fixture({ pr: { env1: pr("passing") } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    await f.engine.inbox();
    await f.engine.inbox();
    await f.engine.inbox();
    expect(f.prCalls()).toBe(1);
    f.advance(61_000);
    await f.engine.inbox();
    expect(f.prCalls()).toBe(2);
  });

  it("serves a changed PR once the minute has passed", async () => {
    const f = fixture({ pr: { env1: pr("passing") } });
    f.add("a", { environmentId: "env1", updatedAt: NOW - DAY });
    expect((await f.engine.inbox()).rows[0]?.pr?.checks).toBe("passing");
    f.setPr({ env1: pr("failing", 1) });
    f.advance(61_000);
    expect((await f.engine.inbox()).rows[0]?.pr?.checks).toBe("failing");
  });
});

describe("CI failed is posted once even when a PR lookup batch fails in between", () => {
  it("keeps what it knew about chats whose batch failed, so the same failure is not posted twice", async () => {
    const fillers = Array.from({ length: 200 }, (_, i) => `fill${i}`);
    const prs = (target: ReturnType<typeof pr>) => ({ ...Object.fromEntries(fillers.map((id) => [id, pr("passing")])), target });
    const f = fixture({ pr: prs(pr("passing")) });
    for (const id of fillers) f.add(`t-${id}`, { environmentId: id, updatedAt: NOW - 2 * DAY });
    f.add("a", { environmentId: "target", updatedAt: NOW - DAY });
    const scan = () => f.engine.ciCheck(true);
    await scan();
    f.setPr(prs(pr("failing", 1)));
    expect((await scan()).notified).toEqual(["a"]);
    f.failPrBatches((keys) => keys.includes("target"));
    await scan();
    f.failPrBatches(() => false);
    expect((await scan()).notified).toEqual([]);
    expect(f.sent).toHaveLength(1);
  });
});

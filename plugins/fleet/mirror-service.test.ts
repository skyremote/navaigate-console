// The mirror service end to end, in process: a fake bb (events, spawn, send)
// and the brain as an in-memory SQLite database. Covers the watch, the sealed
// rows, the copy's feed, the order of spawn and sends, and pruning.
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorPath, feedPath } from "./mirror/feed";
import type { FeedRecord } from "./mirror/protocol";
import { createMirror, type CopyState, type MirrorDeps } from "./mirror/service";
import type { Row, SqlArg } from "./turso";

class FakeBrain {
  readonly db = new Database(":memory:");
  async batch(statements: { sql: string; args?: SqlArg[] }[]): Promise<Row[][]> {
    return statements.map((s) => {
      const stmt = this.db.prepare(s.sql);
      const args = s.args ?? [];
      return stmt.reader ? (stmt.all(...args) as Row[]) : (stmt.run(...args), []);
    });
  }
  async query(sql: string, args: SqlArg[] = []): Promise<Row[]> {
    return (await this.batch([{ sql, args }]))[0] ?? [];
  }
}

type Event = { seq: number; type: string; createdAt: number; scope: { kind: string; turnId?: string }; data: Record<string, unknown> };

function fakeBb(dir: string) {
  const events = new Map<string, Event[]>();
  const threads = new Map<string, Record<string, unknown>>();
  const kv = new Map<string, unknown>();
  const spawned: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const environments = new Map([["env_ready", { id: "env_ready", projectId: "proj_x", status: "ready", hostId: "host_1", path: dir, updatedAt: 1 }]]);
  const bb = {
    pluginId: "fleet",
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    storage: {
      kv: {
        get: async (k: string) => kv.get(k),
        set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
        delete: async (k: string) => void kv.delete(k),
        list: async (prefix = "") => [...kv.keys()].filter((k) => k.startsWith(prefix)),
      },
    },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (t === undefined) throw new Error("thread_not_found");
          return t;
        },
        events: {
          list: async (args: { threadId: string; afterSeq?: string; beforeSeq?: string; order?: string; limit?: string; types?: string[] }) => {
            let list = [...(events.get(args.threadId) ?? [])];
            if (args.types) list = list.filter((e) => args.types!.includes(e.type));
            if (args.afterSeq !== undefined) list = list.filter((e) => e.seq > Number(args.afterSeq));
            if (args.beforeSeq !== undefined) list = list.filter((e) => e.seq < Number(args.beforeSeq));
            if (args.order === "desc") list.reverse();
            const limit = Number(args.limit ?? 100);
            if (limit > 100) throw new Error("Thread event limit cannot exceed 100");
            return list.slice(0, limit);
          },
        },
        spawn: async (args: Record<string, unknown>) => {
          // BB resolves fields without explicit provenance from its current defaults.
          // Keep this fake sensitive to a mirror accidentally starting a real provider.
          const sources = args.executionInputSources as Record<string, string> | undefined;
          spawned.push({ ...args,
            providerId: sources?.providerId === "explicit" ? args.providerId : "core-default-provider",
            model: sources?.model === "explicit" ? args.model : "core-default-model",
            reasoningLevel: sources?.reasoningLevel === "explicit" ? args.reasoningLevel : "core-default-reasoning",
          });
          const id = `thr_copy${spawned.length}`;
          threads.set(id, { id, status: "active", runtime: { displayStatus: "active" }, deletedAt: null, archivedAt: null });
          return threads.get(id);
        },
        send: async (args: Record<string, unknown>) => {
          sent.push(args);
          return { delivery: "sent" };
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          const environment = environments.get(environmentId);
          if (!environment) throw new Error("environment_not_found");
          return environment;
        },
        list: async () => [...environments.values()],
      },
    },
  };
  return { bb, events, threads, spawned, sent, environments };
}

let now = 1_800_000_000_000;
let seq = 0;
function ev(type: string, data: Record<string, unknown>, turnId: string | null = null): Event {
  seq += 1;
  return { seq, type, createdAt: now, scope: turnId === null ? { kind: "thread" } : { kind: "turn", turnId }, data };
}
const turn = (requestId: string, text: string, turnId: string, reply: string, target = "new-turn"): Event[] => [
  ev("client/turn/requested", { requestId, input: [{ type: "text", text, mentions: [] }], target: { kind: target } }),
  ev("turn/started", {}, turnId),
  ev("turn/input/accepted", { clientRequestId: requestId }, turnId),
  ev("item/completed", { item: { type: "commandExecution", id: `${turnId}-i1`, command: "ls /tmp", cwd: "", status: "completed", aggregatedOutput: "a\nb\nc\n", exitCode: 0 } }, turnId),
  ev("item/completed", { item: { type: "agentMessage", id: `${turnId}-i2`, text: reply } }, turnId),
  ev("turn/completed", { status: "completed" }, turnId),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function selectEvents(events: Event[], query: { types?: string[]; afterSeq?: string; beforeSeq?: string; order?: string; limit?: string }): Event[] {
  let selected = events.filter((event) => !query.types || query.types.includes(event.type));
  if (query.afterSeq !== undefined) selected = selected.filter((event) => event.seq > Number(query.afterSeq));
  if (query.beforeSeq !== undefined) selected = selected.filter((event) => event.seq < Number(query.beforeSeq));
  if (query.order === "desc") selected = [...selected].reverse();
  return selected.slice(0, Number(query.limit ?? "100"));
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("mirror service through a fake brain", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet-mirror-service-"));
    seq = 0;
    now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens a copy of a chat on this same bb through the brain, then sends the next turn when the copy is ready", async () => {
    const brain = new FakeBrain();
    const fake = fakeBb(dir);
    fake.threads.set("thr_src", { id: "thr_src", title: "List files", status: "idle", runtime: { displayStatus: "idle" }, deletedAt: null });
    fake.events.set("thr_src", turn("creq_1", "list three files in /tmp", "t1", "Done: a, b, c.", "thread-start"));
    const mirror = createMirror({
      bb: fake.bb as never,
      turso: brain as never,
      joined: () => true,
      me: async () => ({ serverId: "laptop-srv", url: null }),
      machineKey: "laptop",
      dataDir: join(dir, "fleet"),
      remote: () => [],
      serverHostId: async () => "host_1",
    });

    const opening = mirror.open({ machine: "laptop", threadId: "thr_src", title: "Mirror test: List files" });
    for (let i = 0; i < 3 && fake.spawned.length === 0; i += 1) await mirror.tick();
    const { localThreadId } = await opening;
    expect(localThreadId).toBe("thr_copy1");
    expect(fake.spawned[0]).toMatchObject({
      projectId: "proj_x",
      environment: { type: "reuse", environmentId: "env_ready" },
      providerId: "fleet-mirror",
      model: "mirror",
      reasoningLevel: "medium",
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit" },
      visibility: "hidden",
      title: "Mirror test: List files",
      input: [{ type: "text", text: "list three files in /tmp" }],
      pluginMetadata: { machine: "laptop", serverId: "laptop-srv", remoteThreadId: "thr_src" },
    });

    // The brain holds ciphertext only.
    const rows = brain.db.prepare("SELECT payload FROM fleet_mirror_events").all() as { payload: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.payload).not.toContain("list three files");

    const feed = readFileSync(feedPath(join(dir, "fleet", "mirror-feed"), localThreadId), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as FeedRecord);
    expect(feed.map((r) => r.t)).toEqual(["header", "turn", "item", "item", "end"]);

    // A second remote turn: not sent until the bridge has reached it and the copy is idle.
    now += 10_000;
    fake.events.get("thr_src")!.push(...turn("creq_2", "and say done", "t2", "done"));
    await mirror.tick();
    expect(fake.sent).toEqual([]);
    writeFileSync(cursorPath(join(dir, "fleet", "mirror-feed"), localThreadId), JSON.stringify({ next: 5 }));
    fake.threads.set(localThreadId, { id: localThreadId, status: "idle", runtime: { displayStatus: "idle" }, deletedAt: null, archivedAt: null });
    now += 10_000;
    await mirror.tick();
    expect(fake.sent).toEqual([{ threadId: localThreadId, mode: "auto", input: [{ type: "text", text: "and say done", mentions: [] }] }]);

    // Opening it again reuses the copy at once.
    await expect(mirror.open({ machine: "laptop", threadId: "thr_src" })).resolves.toEqual({ localThreadId });
    expect(fake.spawned).toHaveLength(1);
  });

  it("records raw broker rows (seq and sealed payload) before decrypt for F77, never the decoded records", async () => {
    const brain = new FakeBrain();
    const fake = fakeBb(dir);
    fake.threads.set("thr_src", { id: "thr_src", title: "List files", status: "idle", runtime: { displayStatus: "idle" }, deletedAt: null });
    fake.events.set("thr_src", turn("creq_1", "list three files in /tmp", "t1", "Done: a, b, c.", "thread-start"));
    const brokerReads: { openId?: string; mode: string; rows: { seq: number; payload: string }[] | null; cursorBefore: number | null; cursorAfter: number | null; failed?: boolean }[] = [];
    const finished: string[] = [];
    const mirror = createMirror({
      bb: fake.bb as never, turso: brain as never, joined: () => true,
      me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"),
      remote: () => [], serverHostId: async () => "host_1",
      metrics: {
        beginOpen: (input) => input.openId,
        finishOpen: (_openId, outcome) => { finished.push(outcome); },
        recordRead: () => true,
        recordBrokerRead: (input) => { brokerReads.push(input as never); return true; },
      },
    });
    const opening = mirror.open({ machine: "laptop", threadId: "thr_src", title: "Mirror test: List files" });
    for (let i = 0; i < 3 && fake.spawned.length === 0; i += 1) await mirror.tick();
    await opening;
    expect(finished).toEqual(["ready"]);
    const withRows = brokerReads.filter((read) => (read.rows?.length ?? 0) > 0);
    expect(withRows.length).toBeGreaterThan(0);
    for (const read of withRows) for (const row of read.rows!) {
      expect(Object.keys(row).sort()).toEqual(["payload", "seq"]);
      expect(row.payload).not.toContain("list three files");
    }
    expect(brokerReads[0]).toMatchObject({ mode: "initial", cursorBefore: 0 });
    expect(withRows.at(-1)!.cursorAfter).toBe(Math.max(...withRows.at(-1)!.rows!.map((row) => row.seq)));
  });

  it("prunes rows older than 7 days and ends a watch 7 days after the last open", async () => {
    const brain = new FakeBrain();
    const fake = fakeBb(dir);
    fake.threads.set("thr_src", { id: "thr_src", status: "idle", runtime: { displayStatus: "idle" }, deletedAt: null });
    fake.events.set("thr_src", turn("creq_1", "hello", "t1", "hi", "thread-start"));
    const mirror = createMirror({
      bb: fake.bb as never,
      turso: brain as never,
      joined: () => true,
      me: async () => ({ serverId: "laptop-srv", url: null }),
      machineKey: "laptop",
      dataDir: join(dir, "fleet"),
      remote: () => [],
      serverHostId: async () => "host_1",
    });
    const opening = mirror.open({ machine: "laptop", threadId: "thr_src" });
    for (let i = 0; i < 3 && fake.spawned.length === 0; i += 1) await mirror.tick();
    await opening;
    const day = 86_400_000;
    brain.db
      .prepare("INSERT INTO fleet_mirror_events (server_id, thread_id, recipient, generation, seq, payload, created_at) VALUES ('laptop-srv', 'thr_old', 'laptop-srv', 'g', 1, 'x', ?)")
      .run(now - 8 * day);
    now += 11 * 60_000; // past the prune interval
    await mirror.tick();
    expect(brain.db.prepare("SELECT COUNT(*) AS n FROM fleet_mirror_events WHERE thread_id = 'thr_old'").get()).toEqual({ n: 0 });
    expect(brain.db.prepare("SELECT state FROM fleet_mirror_watch").get()).toEqual({ state: "active" });

    now += 8 * day;
    await mirror.tick();
    expect(brain.db.prepare("SELECT state FROM fleet_mirror_watch").get()).toEqual({ state: "ended" });
    expect(brain.db.prepare("SELECT COUNT(*) AS n FROM fleet_mirror_events WHERE thread_id = 'thr_src'").get()).toEqual({ n: 0 });
  });
});

describe("writable mirror service transports", () => {
  it.each([
    { admitted: "accepted", rejected: "failed" },
    { admitted: "accepted", rejected: "unknown" },
    { admitted: "queued", rejected: "failed" },
  ] as const)("reconciles $admitted admission to $rejected without another delivery, including after restart", async ({ admitted, rejected }) => {
    const { controlId, readControlState, writeControl } = await import("./mirror/control");
    const dir = mkdtempSync(join(tmpdir(), "fleet-mirror-receipt-"));
    const brain = new FakeBrain();
    let stamp = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => stamp);
    try {
      const fake = fakeBb(dir);
      fake.threads.set("thr_src", { id: "thr_src", title: "Source", status: "idle", deletedAt: null });
      fake.events.set("thr_src", turn("creq_first", "First", "source_t1", "One", "thread-start"));
      const forwarded: string[] = [];
      const lookedUp: string[] = [];
      let receipt: import("./mirror/control").MirrorControlResult | null = null;
      let lookupFails = false;
      const deps = {
        bb: fake.bb as never, turso: brain as never, joined: () => true,
        me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"), remote: () => [], serverHostId: async () => "host_1",
        forwardControl: async (request: import("./mirror/control").MirrorControlRequest) => { forwarded.push(request.id); return { state: admitted, remoteRequestId: request.id }; },
        controlReceipt: async (request: import("./mirror/control").MirrorControlRequest) => {
          lookedUp.push(request.id);
          if (lookupFails) throw new Error("receipt route temporarily offline");
          return receipt;
        },
      };
      const mirror = createMirror(deps);
      const opening = mirror.open({ machine: "laptop", threadId: "thr_src" });
      for (let i = 0; i < 3 && fake.spawned.length === 0; i++) await mirror.tick();
      const { localThreadId } = await opening;
      const request = { v: 1 as const, id: controlId(localThreadId, "creq_admitted", "send"), localThreadId, targetServer: "laptop-srv", remoteThreadId: "thr_src", action: "send" as const, text: "Next", createdAt: stamp };
      writeControl(mirror.feedDir, request);
      await mirror.processControls();
      await mirror.processControls(); // no owner receipt yet
      expect(readControlState(mirror.feedDir, request.id)).toMatchObject({ state: admitted, attempts: 1 });
      const restarted = createMirror(deps);
      await restarted.processControls();
      expect(lookedUp).toEqual([request.id]); // persisted read-only polling throttle
      stamp += 3001;
      lookupFails = true;
      await restarted.processControls();
      expect(readControlState(mirror.feedDir, request.id)?.state).toBe(admitted);
      stamp += 3001;
      lookupFails = false;
      receipt = { state: "unavailable", message: "Receipt route unavailable" };
      await restarted.processControls();
      expect(readControlState(mirror.feedDir, request.id)?.state).toBe(admitted);
      stamp += 3001;
      receipt = { state: rejected, remoteRequestId: request.id, message: "The owner did not confirm the admitted input." };
      await restarted.processControls();
      expect(readControlState(mirror.feedDir, request.id)).toMatchObject({ state: rejected, attempts: 1, message: receipt.message });
      await createMirror(deps).processControls();
      expect(forwarded).toEqual([request.id]);
      expect(lookedUp).toEqual([request.id, request.id, request.id, request.id]);
    } finally { clock.mockRestore(); brain.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("opens and streams from an authenticated direct owner without any broker connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-direct-mirror-"));
    try {
      const fake = fakeBb(dir);
      const sourceEvents = turn("creq_direct", "Read the build", "direct_t1", "The build passed.", "thread-start");
      const calls: Record<string, unknown>[] = [];
      const mirror = createMirror({
        bb: fake.bb as never, turso: null, joined: () => true,
        me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"),
        remote: () => [{ serverId: "studio-srv", machineKey: "studio", publishedAt: Date.now(), threads: [{ id: "thr_owned", title: "Build" }] }],
        serverHostId: async () => "host_1",
        forwardControl: async () => ({ state: "sent" }),
        direct: { events: async (input) => {
          calls.push(input);
          let events = sourceEvents.filter((event) => !input.types || input.types.includes(event.type));
          if (input.afterSeq) events = events.filter((event) => event.seq > Number(input.afterSeq));
          if (input.beforeSeq) events = events.filter((event) => event.seq < Number(input.beforeSeq));
          if (input.order === "desc") events = [...events].reverse();
          return events.slice(0, Number(input.limit ?? "100"));
        } },
      });
      const opened = await mirror.open({ machine: "studio", threadId: "thr_owned" });
      expect(opened.localThreadId).toBe("thr_copy1");
      expect(await mirror.copyOwner("thr_copy1")).toEqual({ machine: "studio", serverId: "studio-srv", remoteThreadId: "thr_owned" });
      expect(await mirror.copyOwner("thr_owned")).toBeNull();
      const contents = readFileSync(feedPath(mirror.feedDir, opened.localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      expect(contents[0]).toMatchObject({ t: "header", serverId: "studio-srv", control: { v: 1 } });
      expect(contents.some((record) => record.t === "item" && record.close.item.text === "The build passed.")).toBe(true);
      expect(fake.spawned[0]?.input).toEqual(expect.arrayContaining([expect.objectContaining({ visibility: "agent-only" })]));
      const before = contents.length;
      await mirror.tick();
      expect(readFileSync(feedPath(mirror.feedDir, opened.localThreadId), "utf8").trim().split("\n")).toHaveLength(before);
      expect(calls.every((call) => call.serverId === "studio-srv" && call.machine === "studio")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("measures each direct owner read and the native open through the F77 hooks, without changing the copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-direct-metrics-"));
    try {
      const fake = fakeBb(dir);
      const sourceEvents = turn("creq_metric", "Read the build", "metric_t1", "The build passed.", "thread-start");
      const opens: { openId: string; stream: { serverId: string; threadId: string; generation: string } }[] = [];
      const finished: [string, string][] = [];
      const reads: { readId: string; openId?: string; mode: string; startedAt: number; endedAt: number; events: unknown[] | null; cursorBefore: number | null; cursorAfter: number | null; failed?: boolean }[] = [];
      let fail = false;
      const deps = {
        bb: fake.bb as never, turso: null, joined: () => true,
        me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"),
        remote: () => [{ serverId: "studio-srv", machineKey: "studio", publishedAt: Date.now(), threads: [{ id: "thr_owned", title: "Build" }] }],
        serverHostId: async () => "host_1",
        direct: { events: async (input: { types?: string[]; afterSeq?: string; beforeSeq?: string; order?: string; limit?: string }) => {
          if (fail) throw new Error("ssh: connection reset");
          let events = sourceEvents.filter((event) => !input.types || input.types.includes(event.type));
          if (input.afterSeq) events = events.filter((event) => event.seq > Number(input.afterSeq));
          if (input.beforeSeq) events = events.filter((event) => event.seq < Number(input.beforeSeq));
          if (input.order === "desc") events = [...events].reverse();
          return events.slice(0, Number(input.limit ?? "100"));
        } },
        metrics: {
          beginOpen: (input: (typeof opens)[number]) => { opens.push(input); return input.openId; },
          finishOpen: (openId: string, outcome: string) => { finished.push([openId, outcome]); },
          recordRead: (input: (typeof reads)[number]) => { reads.push(input); if (input.mode === "history") throw new Error("metrics store failed"); return true; },
        },
      };
      const mirror = createMirror(deps as never);
      const opened = await mirror.open({ machine: "studio", threadId: "thr_owned" });
      expect(opened.localThreadId).toBe("thr_copy1");
      expect(opens).toHaveLength(1);
      expect(opens[0]!.stream).toMatchObject({ serverId: "studio-srv", threadId: "thr_owned" });
      expect(finished).toEqual([[opens[0]!.openId, "ready"]]);
      expect(reads[0]).toMatchObject({ openId: opens[0]!.openId, mode: "history", cursorBefore: null, cursorAfter: null });
      const initial = reads.find((read) => read.mode === "initial")!;
      expect(initial.events).toEqual(sourceEvents.filter((event) => event.seq > initial.cursorBefore!));
      expect(initial.cursorAfter).toBe(sourceEvents.at(-1)!.seq);
      expect(initial.endedAt).toBeGreaterThanOrEqual(initial.startedAt);
      expect(new Set(reads.map((read) => read.readId)).size).toBe(reads.length);
      await mirror.tick();
      expect(reads.at(-1)).toMatchObject({ mode: "delta", events: [], cursorBefore: sourceEvents.at(-1)!.seq, cursorAfter: sourceEvents.at(-1)!.seq });
      fail = true;
      await mirror.tick();
      expect(reads.at(-1)).toMatchObject({ mode: "delta", events: null, failed: true, cursorAfter: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("retries a failed owner interaction detail read until it arrives, and an owner end stops the retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-detail-retry-"));
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const fake = fakeBb(dir);
      const source = turn("creq_ix", "Test", "t_ix", "unused", "thread-start").slice(0, 3);
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_wait", status: "pending", origin: { kind: "provider" }, payload: { kind: "user_question" } } }, "t_ix"));
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_gone", status: "pending", origin: { kind: "provider" }, payload: { kind: "approval" } } }, "t_ix"));
      let recover = false;
      const reads: string[] = [];
      const mirror = createMirror({
        bb: fake.bb as never, turso: null, joined: () => true,
        me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"),
        remote: () => [{ serverId: "studio-srv", machineKey: "studio", publishedAt: Date.now(), threads: [{ id: "thr_owned", title: "Waiting" }] }],
        serverHostId: async () => "host_1",
        forwardControl: async () => ({ state: "sent" }),
        interactionDetail: async ({ serverId, threadId, interactionId }) => {
          reads.push(`${serverId}:${threadId}:${interactionId}`);
          if (!recover) throw new Error("temporary owner read failure");
          return { payload: { kind: "user_question", questions: [] }, fingerprint: "a".repeat(64) };
        },
        direct: { events: async (input) => {
          let events = source.filter((e) => !input.types || input.types.includes(e.type));
          if (input.afterSeq) events = events.filter((e) => e.seq > Number(input.afterSeq));
          if (input.beforeSeq) events = events.filter((e) => e.seq < Number(input.beforeSeq));
          if (input.order === "desc") events = [...events].reverse();
          return events.slice(0, Number(input.limit ?? 100));
        } },
      });
      const opened = await mirror.open({ machine: "studio", threadId: "thr_owned" });
      const feed = () => readFileSync(feedPath(mirror.feedDir, opened.localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      expect(feed().filter((r) => r.t === "interaction").map((r) => r.t === "interaction" && r.detail)).toEqual([null, null]);
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_gone", status: "resolved", origin: { kind: "provider" }, payload: { kind: "approval" } } }, "t_ix"));
      recover = true;
      now += 5_000;
      await mirror.tick();
      const enriched = feed().filter((r) => r.t === "interaction" && r.detail !== null);
      expect(enriched).toEqual([expect.objectContaining({ id: "int_wait", kind: "user_question", turn: expect.any(String), detail: { payload: { kind: "user_question", questions: [] }, fingerprint: "a".repeat(64) } })]);
      expect(reads.every((read) => read.startsWith("studio-srv:thr_owned:"))).toBe(true);
      expect(reads.filter((read) => read.endsWith(":int_gone"))).toHaveLength(1);
      const count = reads.length;
      now += 60_000;
      await mirror.tick();
      expect(reads).toHaveLength(count);
    } finally { clock.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("settles a copy's prompt with the owner's answer once the owner ended it, on read and again on reopen, since provider prompts cannot be cancelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-ended-prompt-"));
    try {
      const fake = fakeBb(dir);
      const answer = { kind: "user_answer", answers: { q1: { selected: ["q1:blue"] } } };
      const source = turn("creq_ix", "Ask", "t_ix", "unused", "thread-start").slice(0, 3);
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_done", status: "pending", origin: { kind: "provider" }, payload: { kind: "user_question" } } }, "t_ix"));
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_cmd", status: "pending", origin: { kind: "provider" }, payload: { kind: "approval" } } }, "t_ix"));
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_live", status: "pending", origin: { kind: "provider" }, payload: { kind: "approval" } } }, "t_ix"));
      type Local = { id: string; status: string; providerRequestId: string; payload: { kind: string } };
      const local: Local[] = [];
      const resolved: { interactionId: string; resolution: unknown }[] = [];
      Object.assign(fake.bb.sdk.threads, { interactions: {
        list: async () => local.filter((entry) => entry.status === "pending").map((entry) => ({ ...entry })),
        // Core cancels only plugin prompts; a provider prompt is refused.
        cancel: async () => { throw new Error("Plugin interaction expected"); },
        resolve: async ({ interactionId, resolution }: { interactionId: string; resolution: unknown }) => {
          const found = local.find((entry) => entry.id === interactionId && entry.status === "pending");
          if (!found) throw new Error("Interaction is not pending");
          found.status = "resolved";
          resolved.push({ interactionId, resolution });
          return found;
        },
      } });
      const mirror = createMirror({
        bb: fake.bb as never, turso: null, joined: () => true,
        me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"),
        remote: () => [{ serverId: "studio-srv", machineKey: "studio", publishedAt: Date.now(), threads: [{ id: "thr_owned", title: "Ask" }] }],
        serverHostId: async () => "host_1",
        forwardControl: async () => ({ state: "sent" }),
        interactionDetail: async () => ({ payload: { kind: "user_question", questions: [] }, fingerprint: "a".repeat(64) }),
        direct: { events: async (input) => {
          let events = source.filter((e) => !input.types || input.types.includes(e.type));
          if (input.afterSeq) events = events.filter((e) => e.seq > Number(input.afterSeq));
          if (input.beforeSeq) events = events.filter((e) => e.seq < Number(input.beforeSeq));
          if (input.order === "desc") events = [...events].reverse();
          return events.slice(0, Number(input.limit ?? "100"));
        } },
      });
      const opened = await mirror.open({ machine: "studio", threadId: "thr_owned" });
      const prompt = (id: string, owner: string, kind: string): Local => ({ id, status: "pending", providerRequestId: `rpc-${id}:fleet-ix:${owner}`, payload: { kind } });
      local.push(prompt("pint_done", "int_done", "user_question"), prompt("pint_cmd", "int_cmd", "approval"), prompt("pint_live", "int_live", "approval"), { ...prompt("pint_other", "x", "approval"), providerRequestId: "rpc-3:something-else" });
      // The owner answers one question and interrupts one approval: the next read settles both here.
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_done", status: "resolved", origin: { kind: "provider" }, payload: { kind: "user_question" }, resolution: answer } }, "t_ix"));
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_cmd", status: "interrupted", origin: { kind: "provider" }, payload: { kind: "approval" } } }, "t_ix"));
      await mirror.tick();
      const feed = readFileSync(feedPath(mirror.feedDir, opened.localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      expect(feed.filter((record) => record.t === "interaction-end")).toEqual([{ t: "interaction-end", id: "int_done", status: "resolved", resolution: answer }, { t: "interaction-end", id: "int_cmd", status: "interrupted" }]);
      expect(resolved).toEqual([{ interactionId: "pint_done", resolution: answer }, { interactionId: "pint_cmd", resolution: { decision: "deny" } }]);
      // A prompt the copy raised only after the owner's end was read is settled when the copy is reopened.
      local.push(prompt("pint_late", "int_done", "user_question"));
      expect(await mirror.open({ machine: "studio", threadId: "thr_owned" })).toEqual(opened);
      await vi.waitFor(() => expect(resolved.map((entry) => entry.interactionId)).toEqual(["pint_done", "pint_cmd", "pint_late"]));
      expect(resolved[2]!.resolution).toEqual(answer);
      expect(local.filter((entry) => entry.status === "pending").map((entry) => entry.id)).toEqual(["pint_live", "pint_other"]);
      await mirror.open({ machine: "studio", threadId: "thr_owned" });
      for (let i = 0; i < 20; i += 1) await flush();
      expect(resolved).toHaveLength(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps a failed interaction detail read pending across a service restart and raises it once the owner answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-detail-reload-"));
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const fake = fakeBb(dir);
      const source = turn("creq_ix", "Test", "t_ix", "unused", "thread-start").slice(0, 3);
      source.push(ev("system/interaction/lifecycle", { interaction: { id: "int_wait", status: "pending", origin: { kind: "provider" }, payload: { kind: "user_question" } } }, "t_ix"));
      let recover = false;
      let reads = 0;
      const deps = {
        bb: fake.bb as never, turso: null, joined: () => true,
        me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"),
        remote: () => [{ serverId: "studio-srv", machineKey: "studio", publishedAt: Date.now(), threads: [{ id: "thr_owned", title: "Waiting" }] }],
        serverHostId: async () => "host_1",
        forwardControl: async () => ({ state: "sent" as const }),
        interactionDetail: async () => { reads += 1; if (!recover) throw new Error("temporary owner read failure"); return { payload: { kind: "user_question", questions: [] }, fingerprint: "a".repeat(64) }; },
        direct: { events: async (input: { types?: string[]; afterSeq?: string; beforeSeq?: string; order?: string; limit?: string }) => {
          let events = source.filter((e) => !input.types || input.types.includes(e.type));
          if (input.afterSeq) events = events.filter((e) => e.seq > Number(input.afterSeq));
          if (input.beforeSeq) events = events.filter((e) => e.seq < Number(input.beforeSeq));
          if (input.order === "desc") events = [...events].reverse();
          return events.slice(0, Number(input.limit ?? "100"));
        } },
      };
      const mirror = createMirror(deps as never);
      const opened = await mirror.open({ machine: "studio", threadId: "thr_owned" });
      const feed = () => readFileSync(feedPath(mirror.feedDir, opened.localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      expect(reads).toBe(1);
      recover = true;
      const restarted = createMirror(deps as never);
      now += 5_000;
      expect(await restarted.open({ machine: "studio", threadId: "thr_owned" })).toEqual(opened);
      await restarted.tick();
      expect(feed().filter((r) => r.t === "interaction" && r.detail !== null)).toEqual([expect.objectContaining({ id: "int_wait", detail: expect.objectContaining({ fingerprint: "a".repeat(64) }) })]);
      const count = reads;
      now += 60_000;
      await restarted.tick();
      await createMirror(deps as never).tick();
      expect(reads).toBe(count);
    } finally { clock.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("answers a copy's owner only after the shared saved-copy load, and retries a failed load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-owner-load-"));
    try {
      const fake = fakeBb(dir);
      const key = "studio-srv:thr_owned";
      await fake.bb.storage.kv.set(`mirror:copy:${key}`, { key, machine: "studio", serverId: "studio-srv", remoteThreadId: "thr_owned", localThreadId: "thr_copy" });
      const list = fake.bb.storage.kv.list;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let fail = true;
      let calls = 0;
      fake.bb.storage.kv.list = async (prefix?: string) => {
        calls += 1;
        if (calls === 1 && fail) { fail = false; throw new Error("storage busy"); }
        await gate;
        return list(prefix);
      };
      const mirror = createMirror({ bb: fake.bb as never, turso: null, joined: () => false, me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"), remote: () => [], serverHostId: async () => "host_1" });
      await expect(mirror.copyOwner("thr_copy")).rejects.toThrow("could not be read yet");
      const first = mirror.copyOwner("thr_copy");
      const second = mirror.copyOwner("thr_copy");
      release();
      const owner = { machine: "studio", serverId: "studio-srv", remoteThreadId: "thr_owned" };
      expect(await first).toEqual(owner);
      expect(await second).toEqual(owner);
      expect(calls).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not replay an owner prompt twice when opening overlaps the polling cycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-overlap-mirror-"));
    try {
      const fake = fakeBb(dir);
      const sourceEvents = turn("creq_overlap", "One owner prompt", "owner_t1", "One answer", "thread-start");
      let announceRead: () => void = () => undefined;
      let releaseRead: () => void = () => undefined;
      let entered = new Promise<void>((resolve) => { announceRead = resolve; });
      let released = new Promise<void>((resolve) => { releaseRead = resolve; });
      let firstRead = true;
      const mirror = createMirror({
        bb: fake.bb as never, turso: null, joined: () => true,
        me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"),
        remote: () => [{ serverId: "studio-srv", machineKey: "studio", publishedAt: now, threads: [{ id: "thr_owned", title: "Build" }] }],
        serverHostId: async () => "host_1",
        forwardControl: async () => ({ state: "sent" }),
        direct: { events: async (input) => {
          if (input.afterSeq !== undefined && firstRead) {
            firstRead = false;
            announceRead();
            await released;
          }
          let events = sourceEvents.filter((event) => !input.types || input.types.includes(event.type));
          if (input.afterSeq) events = events.filter((event) => event.seq > Number(input.afterSeq));
          if (input.beforeSeq) events = events.filter((event) => event.seq < Number(input.beforeSeq));
          if (input.order === "desc") events = [...events].reverse();
          return events.slice(0, Number(input.limit ?? "100"));
        } },
      });
      const opening = mirror.open({ machine: "studio", threadId: "thr_owned" });
      await entered;
      const polling = mirror.tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseRead();
      const [opened] = await Promise.all([opening, polling]);
      const contents = readFileSync(feedPath(mirror.feedDir, opened.localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      expect(fake.spawned).toHaveLength(1);
      expect(contents.filter((record) => record.t === "turn" && record.user?.requestId === "creq_overlap")).toHaveLength(1);
      expect(contents.filter((record) => record.t === "steer")).toHaveLength(0);
      expect(contents.filter((record) => record.t === "item" && record.close.item.text === "One answer")).toHaveLength(1);
      expect(fake.sent).toHaveLength(0);
      entered = new Promise<void>((resolve) => { announceRead = resolve; });
      released = new Promise<void>((resolve) => { releaseRead = resolve; });
      firstRead = true;
      const stalePolling = mirror.tick();
      await entered;
      fake.threads.delete(opened.localThreadId);
      const reopening = mirror.open({ machine: "studio", threadId: "thr_owned" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseRead();
      const [replacement] = await Promise.all([reopening, stalePolling]);
      expect(replacement.localThreadId).toBe("thr_copy2");
      expect((await mirror.open({ machine: "studio", threadId: "thr_owned" })).localThreadId).toBe(replacement.localThreadId);
      const replacementContents = readFileSync(feedPath(mirror.feedDir, replacement.localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      expect(replacementContents.filter((record) => record.t === "turn" && record.user?.requestId === "creq_overlap")).toHaveLength(1);
      expect(fake.spawned).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("deduplicates durable controls, skips local reply echoes, and does not repeat an uncertain dispatch", async () => {
    const { controlId, listControls, mirrorControlInput, readControlState, writeControl, writeControlState } = await import("./mirror/control");
    const dir = mkdtempSync(join(tmpdir(), "fleet-writable-service-"));
    const brain = new FakeBrain();
    try {
      const fake = fakeBb(dir);
      fake.threads.set("thr_src", { id: "thr_src", title: "Source", status: "idle", deletedAt: null });
      fake.events.set("thr_src", turn("creq_first", "First", "source_t1", "One", "thread-start"));
      const forwarded: string[] = [];
      const deps = {
        bb: fake.bb as never, turso: brain as never, joined: () => true,
        me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"), remote: () => [], serverHostId: async () => "host_1",
        forwardControl: async (request: import("./mirror/control").MirrorControlRequest) => { forwarded.push(request.id); return { state: "sent" as const }; },
      };
      const mirror = createMirror(deps);
      const opening = mirror.open({ machine: "laptop", threadId: "thr_src" });
      for (let i = 0; i < 3 && fake.spawned.length === 0; i++) await mirror.tick();
      const { localThreadId } = await opening;
      const request = { v: 1 as const, id: controlId(localThreadId, "creq_native_reply", "send"), localThreadId, targetServer: "laptop-srv", remoteThreadId: "thr_src", action: "send" as const, text: "Next", createdAt: Date.now() };
      writeControl(mirror.feedDir, request);
      await mirror.processControls();
      await mirror.processControls();
      expect(forwarded).toEqual([request.id]);
      expect(readControlState(mirror.feedDir, request.id)?.state).toBe("sent");
      const restarted = createMirror(deps);
      await restarted.processControls();
      expect(forwarded).toEqual([request.id]);

      // A native reply's source echo has no second locally generated user bubble.
      const nextEvents = turn("creq_owner_reply", "Next", "source_t2", "Two");
      nextEvents[0]!.data.input = mirrorControlInput(request);
      fake.events.get("thr_src")!.push(...nextEvents);
      await mirror.tick();
      const state = await fake.bb.storage.kv.get(`mirror:copy:laptop-srv:thr_src`) as { sentThrough: number };
      const saved = readFileSync(feedPath(mirror.feedDir, localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      const echo = saved.find((record) => record.t === "turn" && record.user?.controlId === request.id);
      // Publisher cadence can defer the next snapshot; advancing its known write clock is deterministic.
      if (!echo) {
        const stamp = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(stamp + 10_000);
        try { await mirror.tick(); } finally { clock.mockRestore(); }
      }
      const finalFeed = readFileSync(feedPath(mirror.feedDir, localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      expect(finalFeed.find((record) => record.t === "turn" && record.user?.controlId === request.id)).toMatchObject({ user: { text: "Next", controlId: request.id } });
      expect(fake.sent).toEqual([]);
      expect(state.sentThrough).toBeGreaterThan(0);
      expect(listControls(mirror.feedDir)).toHaveLength(1);

      const uncertain = { ...request, id: controlId(localThreadId, "creq_uncertain", "send"), text: "Another", createdAt: Date.now() + 1 };
      writeControl(mirror.feedDir, uncertain);
      writeControlState(mirror.feedDir, uncertain.id, { state: "sending", at: Date.now(), attempts: 1 });
      await restarted.processControls();
      expect(readControlState(mirror.feedDir, uncertain.id)?.state).toBe("unknown");
      expect(forwarded).toEqual([request.id]);
    } finally { brain.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("mirror route continuity", () => {
  it("keeps explicit local project copies separate without stealing the legacy copy's watch or feed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-mirror-project-"));
    const brain = new FakeBrain();
    let stamp = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => stamp);
    try {
      const fake = fakeBb(dir);
      fake.environments.set("env_project_y", { id: "env_project_y", projectId: "proj_y", status: "ready", hostId: "host_1", path: dir, updatedAt: 2 });
      fake.threads.set("thr_src", { id: "thr_src", title: "Source", status: "idle", deletedAt: null });
      fake.events.set("thr_src", turn("creq_project", "Read source", "source_t1", "Result", "thread-start"));
      const mirror = createMirror({ bb: fake.bb as never, turso: brain as never, joined: () => true, me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"), remote: () => [], serverHostId: async () => "host_1", environmentSetting: () => "env_ready" });
      const original = mirror.open({ machine: "laptop", threadId: "thr_src" });
      for (let i = 0; i < 3 && fake.spawned.length < 1; i++) await mirror.tick();
      const legacy = await original;
      const placed = mirror.open({ machine: "laptop", threadId: "thr_src", localProjectId: "proj_y" });
      for (let i = 0; i < 3 && fake.spawned.length < 2; i++) await mirror.tick();
      const projectCopy = await placed;
      expect(projectCopy.localThreadId).not.toBe(legacy.localThreadId);
      expect(fake.spawned[0]).toMatchObject({ projectId: "proj_x", environment: { type: "reuse", environmentId: "env_ready" }, providerId: "fleet-mirror" });
      expect(fake.spawned[1]).toMatchObject({ projectId: "proj_y", environment: { type: "reuse", environmentId: "env_project_y" }, providerId: "fleet-mirror" });
      expect(brain.db.prepare("SELECT COUNT(DISTINCT generation) AS n FROM fleet_mirror_events").get()).toEqual({ n: 2 });
      expect(brain.db.prepare("SELECT COUNT(*) AS n FROM fleet_mirror_watch WHERE state = 'active'").get()).toEqual({ n: 2 });
      expect(await mirror.open({ machine: "laptop", threadId: "thr_src" })).toEqual(legacy);
      expect(await mirror.open({ machine: "laptop", threadId: "thr_src", localProjectId: "proj_y" })).toEqual(projectCopy);
      await expect(mirror.open({ machine: "laptop", threadId: "thr_src", localProjectId: "../path" })).rejects.toThrow("Invalid local project");

      // Ending one project watch must not delete the other copy's generation.
      brain.db.prepare("UPDATE fleet_mirror_watch SET opened_at = ? WHERE id LIKE '%:project:proj_y'").run(stamp - 8 * 86_400_000);
      stamp += 11_000;
      await mirror.tick();
      expect(brain.db.prepare("SELECT COUNT(*) AS n FROM fleet_mirror_watch WHERE state = 'active'").get()).toEqual({ n: 1 });
      expect(brain.db.prepare("SELECT COUNT(DISTINCT generation) AS n FROM fleet_mirror_events").get()).toEqual({ n: 1 });
      expect(readFileSync(feedPath(mirror.feedDir, legacy.localThreadId), "utf8")).toContain("Result");
    } finally { clock.mockRestore(); brain.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("upgrades the existing copy to direct reads by matching its exact last owner event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-mirror-route-"));
    const brain = new FakeBrain();
    try {
      const fake = fakeBb(dir);
      fake.threads.set("thr_src", { id: "thr_src", title: "Source", status: "idle", deletedAt: null });
      const source = turn("creq_route", "Read result", "route_t1", "Done", "thread-start");
      fake.events.set("thr_src", source);
      const base = { bb: fake.bb as never, turso: brain as never, joined: () => true, me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"), remote: () => [], serverHostId: async () => "host_1" };
      const old = createMirror(base);
      const opening = old.open({ machine: "laptop", threadId: "thr_src" });
      for (let i = 0; i < 3 && fake.spawned.length === 0; i++) await old.tick();
      const { localThreadId } = await opening;
      const before = readFileSync(feedPath(old.feedDir, localThreadId), "utf8").trim().split("\n");
      writeFileSync(cursorPath(old.feedDir, localThreadId), JSON.stringify({ next: before.length }));
      fake.threads.set(localThreadId, { id: localThreadId, status: "idle", deletedAt: null, archivedAt: null });
      const fail = vi.spyOn(brain, "batch").mockRejectedValue(new Error("broker read denied"));
      const upgraded = createMirror({ ...base, forwardControl: async () => ({ state: "sent" }), direct: { events: async (query) => {
        let list = source.filter((event) => !query.types || query.types.includes(event.type));
        if (query.afterSeq) list = list.filter((event) => event.seq > Number(query.afterSeq));
        if (query.beforeSeq) list = list.filter((event) => event.seq < Number(query.beforeSeq));
        if (query.order === "desc") list = [...list].reverse();
        return list.slice(0, Number(query.limit ?? "100"));
      } } });
      expect(await upgraded.open({ machine: "laptop", threadId: "thr_src" })).toEqual({ localThreadId });
      expect(fake.spawned).toHaveLength(1);
      const after = readFileSync(feedPath(upgraded.feedDir, localThreadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
      expect(after.filter((record) => record.t === "turn")).toHaveLength(1);
      expect(after.at(-1)).toMatchObject({ t: "control", v: 1 });
      expect(fail).not.toHaveBeenCalled();
      fail.mockRestore();
    } finally { brain.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("fast local mirror opening", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleet-mirror-open-"));
    seq = 0;
    now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const fake = fakeBb(dir);
    const source = turn("creq_first", "First owner message", "owner_t1", "First answer", "thread-start");
    const deps: MirrorDeps = {
      bb: fake.bb as never, turso: null, joined: () => true,
      me: async () => ({ serverId: "laptop-srv", url: null }), machineKey: "laptop", dataDir: join(dir, "fleet"),
      remote: () => [{ serverId: "studio-srv", machineKey: "studio", publishedAt: now, threads: [{ id: "thr_owned", title: "Source" }] }],
      serverHostId: async () => "host_1",
      direct: { events: async (query) => selectEvents(source, query) },
    };
    return { fake, source, deps, mirror: createMirror(deps) };
  }

  function records(mirror: ReturnType<typeof createMirror>, threadId: string): FeedRecord[] {
    return readFileSync(feedPath(mirror.feedDir, threadId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as FeedRecord);
  }

  it("returns a saved copy while identity lookup is hung and its coalesced owner read is still pending", async () => {
    const { fake, deps, mirror } = setup();
    const opened = await mirror.open({ machine: "studio", threadId: "thr_owned" });
    const identity = deferred<{ serverId: string; url: null }>();
    const ownerRead = deferred<Event[]>();
    const me = vi.fn(() => identity.promise);
    const read = vi.fn(() => ownerRead.promise);
    const resumed = createMirror({ ...deps, remote: () => [], me, direct: { events: read } });
    let response: { localThreadId: string } | undefined;
    const opening = resumed.open({ machine: "studio", threadId: "thr_owned" }).then((result) => { response = result; return result; });
    await flush();
    expect(response).toEqual(opened);
    expect(me).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    const again = resumed.open({ machine: "studio", threadId: "thr_owned" });
    const polling = resumed.tick();
    await flush();
    expect(await again).toEqual(opened);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await fake.bb.storage.kv.get("mirror:copy:studio-srv:thr_owned")).toMatchObject({ directSeq: 6, localThreadId: opened.localThreadId });
    ownerRead.resolve([]);
    await Promise.all([opening, polling]);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.sent).toHaveLength(0);
  });

  it("keeps a broker-backed copy available when broker setup is hung, then saves the connection error", async () => {
    const { fake, deps, mirror } = setup();
    const opened = await mirror.open({ machine: "studio", threadId: "thr_owned" });
    const key = "mirror:copy:studio-srv:thr_owned";
    const state = await fake.bb.storage.kv.get(key) as CopyState;
    delete state.transport;
    delete state.directSeq;
    await fake.bb.storage.kv.set(key, state);
    const broker = deferred<Row[][]>();
    const batch = vi.fn(() => broker.promise);
    let identityOffline = true;
    const me = vi.fn(async () => {
      if (identityOffline) throw new Error("identity service offline");
      return { serverId: "laptop-srv", url: null };
    });
    const warn = vi.spyOn(fake.bb.log, "warn");
    const resumed = createMirror({ ...deps, direct: undefined, me, turso: { batch, query: async () => [] } as never });
    let response: { localThreadId: string } | undefined;
    const opening = resumed.open({ machine: "studio", threadId: "thr_owned" }).then((result) => { response = result; });
    await flush();
    expect(response).toEqual(opened);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(me).not.toHaveBeenCalled();
    expect(await resumed.open({ machine: "studio", threadId: "thr_owned" })).toEqual(opened);
    expect(batch).toHaveBeenCalledTimes(1);
    broker.reject(new Error("broker unavailable"));
    await flush();
    await opening;
    expect(await fake.bb.storage.kv.get(key)).toMatchObject({ error: "Connection to studio: broker unavailable", localThreadId: opened.localThreadId });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broker unavailable"));
    expect(resumed.lastError()).toContain("broker unavailable");
    expect(fake.spawned).toHaveLength(1);
    batch.mockResolvedValue([]);
    identityOffline = false;
    expect(await resumed.open({ machine: "studio", threadId: "thr_owned" })).toEqual(opened);
    await flush();
    expect(await fake.bb.storage.kv.get(key)).toMatchObject({ error: null });
    expect(resumed.lastError()).toBeNull();
  });

  it("shares one first-open preparation and copy across concurrent callers", async () => {
    const { fake, deps, source } = setup();
    const history = deferred<void>();
    const entered = deferred<void>();
    let historyReads = 0;
    const mirror = createMirror({ ...deps, direct: { events: async (query) => {
      if (query.types) {
        historyReads += 1;
        entered.resolve();
        await history.promise;
      }
      return selectEvents(source, query);
    } } });
    const first = mirror.open({ machine: "studio", threadId: "thr_owned" });
    await entered.promise;
    const second = mirror.open({ machine: " studio ", threadId: "thr_owned" });
    await flush();
    expect(historyReads).toBe(1);
    history.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(two).toEqual(one);
    expect(fake.spawned).toHaveLength(1);
    expect(records(mirror, one.localThreadId).filter((record) => record.t === "turn")).toHaveLength(1);
  });

  it("opens after the first useful page and catches up the remaining pages without skipping or replaying records", async () => {
    const { fake, deps, source } = setup();
    for (let index = 2; index <= 10; index += 1) source.push(...turn(`creq_${index}`, `Owner message ${index}`, `owner_t${index}`, `Answer ${index}`));
    const remainder = deferred<void>();
    const reads: string[] = [];
    const mirror = createMirror({ ...deps, direct: { events: async (query) => {
      if (query.afterSeq !== undefined) {
        reads.push(query.afterSeq);
        if (Number(query.afterSeq) >= 25) await remainder.promise;
      }
      return selectEvents(source, query);
    } } });
    let opened: { localThreadId: string } | undefined;
    const opening = mirror.open({ machine: "studio", threadId: "thr_owned" }).then((result) => { opened = result; return result; });
    await flush();
    expect(opened).toEqual({ localThreadId: "thr_copy1" });
    expect(reads).toEqual(["0", "25"]);
    expect(await fake.bb.storage.kv.get("mirror:copy:studio-srv:thr_owned")).toMatchObject({ directSeq: 25 });
    const polling = mirror.tick();
    remainder.resolve();
    await Promise.all([opening, polling]);
    const feed = records(mirror, opened!.localThreadId);
    expect(feed.filter((record) => record.t === "turn")).toHaveLength(10);
    expect(feed.filter((record) => record.t === "item")).toHaveLength(20);
    expect(feed.filter((record) => record.t === "end")).toHaveLength(10);
    expect(await fake.bb.storage.kv.get("mirror:copy:studio-srv:thr_owned")).toMatchObject({ directSeq: source.at(-1)!.seq });
    expect(fake.spawned).toHaveLength(1);
    expect(fake.sent).toHaveLength(0);
  });

  it("reads past a page ending at turn-start before spawning, retaining the exact replay boundary", async () => {
    const { fake, deps } = setup();
    seq = 0;
    const source = Array.from({ length: 23 }, () => ev("system/metadata", {}));
    source.push(...turn("creq_boundary", "Message at the boundary", "boundary_t1", "Boundary answer", "thread-start"));
    const secondPage = deferred<void>();
    const entered = deferred<void>();
    const queries: string[] = [];
    const mirror = createMirror({ ...deps, direct: { events: async (query) => {
      if (query.afterSeq !== undefined) {
        queries.push(query.afterSeq);
        if (query.afterSeq === "24") { entered.resolve(); await secondPage.promise; }
      }
      return selectEvents(source, query);
    } } });
    const opening = mirror.open({ machine: "studio", threadId: "thr_owned" });
    await entered.promise;
    expect(fake.spawned).toHaveLength(0);
    expect(queries).toEqual(["0", "24"]);
    secondPage.resolve();
    const opened = await opening;
    const feed = records(mirror, opened.localThreadId);
    expect(fake.spawned[0]?.input).toEqual([{ type: "text", text: "Message at the boundary", mentions: [] }]);
    expect(feed.filter((record) => record.t === "turn" && record.user?.requestId === "creq_boundary")).toHaveLength(1);
    expect(feed.filter((record) => record.t === "steer")).toHaveLength(0);
    expect(feed.filter((record) => record.t === "end")).toHaveLength(1);
  });

  it("catches up once from the saved cursor in the background and resumes from that cursor after restart", async () => {
    const { fake, deps, source, mirror } = setup();
    const opened = await mirror.open({ machine: "studio", threadId: "thr_owned" });
    const initial = records(mirror, opened.localThreadId);
    fake.threads.set(opened.localThreadId, { id: opened.localThreadId, status: "idle", deletedAt: null, archivedAt: null });
    writeFileSync(cursorPath(mirror.feedDir, opened.localThreadId), JSON.stringify({ next: initial.length }));
    source.push(...turn("creq_second", "Second owner message", "owner_t2", "Second answer"));
    const ownerRead = deferred<void>();
    const queries: string[] = [];
    const resumed = createMirror({ ...deps, direct: { events: async (query) => {
      if (query.afterSeq !== undefined) queries.push(query.afterSeq);
      await ownerRead.promise;
      return selectEvents(source, query);
    } } });
    expect(await resumed.open({ machine: "studio", threadId: "thr_owned" })).toEqual(opened);
    expect(await resumed.open({ machine: "studio", threadId: "thr_owned" })).toEqual(opened);
    const polling = resumed.tick();
    await flush();
    expect(queries).toEqual(["6"]);
    ownerRead.resolve();
    await polling;
    expect(fake.sent).toHaveLength(1);
    expect(records(resumed, opened.localThreadId).filter((record) => record.t === "turn" && record.user?.requestId === "creq_second")).toHaveLength(1);
    expect(await fake.bb.storage.kv.get("mirror:copy:studio-srv:thr_owned")).toMatchObject({ directSeq: 12 });
    const restartedQueries: string[] = [];
    const restarted = createMirror({ ...deps, direct: { events: async (query) => {
      if (query.afterSeq !== undefined) restartedQueries.push(query.afterSeq);
      return selectEvents(source, query);
    } } });
    expect(await restarted.open({ machine: "studio", threadId: "thr_owned" })).toEqual(opened);
    await restarted.tick();
    expect(restartedQueries).toEqual(["12"]);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.sent).toHaveLength(1);
    expect(records(restarted, opened.localThreadId).filter((record) => record.t === "turn")).toHaveLength(2);
  });

  it("does not let a replacement owner server inherit the saved server's copy", async () => {
    const { fake, deps, source, mirror } = setup();
    const original = await mirror.open({ machine: "studio", threadId: "thr_owned" });
    const directReads: string[] = [];
    const changed = createMirror({ ...deps,
      remote: () => [{ serverId: "replacement-studio", machineKey: "studio", publishedAt: now, threads: [{ id: "thr_owned", title: "Replacement" }] }],
      direct: { events: async (query) => { directReads.push(query.serverId); return selectEvents(source, query); } },
    });
    const replacement = await changed.open({ machine: "studio", threadId: "thr_owned" });
    expect(replacement.localThreadId).not.toBe(original.localThreadId);
    expect(await changed.copyOwner(original.localThreadId)).toMatchObject({ serverId: "studio-srv" });
    expect(await changed.copyOwner(replacement.localThreadId)).toMatchObject({ serverId: "replacement-studio" });
    expect(directReads.every((serverId) => serverId === "replacement-studio")).toBe(true);
    expect(fake.spawned).toHaveLength(2);
    expect(records(changed, original.localThreadId)[0]).toMatchObject({ serverId: "studio-srv" });
  });
});

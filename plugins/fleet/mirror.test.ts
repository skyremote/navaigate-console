import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { generateMirrorKeyPair, loadOrCreateMirrorKey, open, rowAad, seal } from "./mirror/crypto";
import { appendFeed, FeedReader } from "./mirror/feed";
import { capText, mapEvents, mapItem, missingRequestIds, newMapperState, replayStart, watchLive, type StoredEvent } from "./mirror/mapping";
import { ITEM_OUTPUT_MAX_BYTES, promptText, sameText, watchOnlyLine, type MirrorRecord } from "./mirror/protocol";
import { snapshotSchema } from "./model";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-mirror-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_800_000_000_000;
let seq = 0;
function ev(type: string, data: Record<string, unknown>, turnId: string | null = null, createdAt = T0): StoredEvent {
  seq += 1;
  return { seq, type, createdAt, scope: turnId === null ? { kind: "thread" } : { kind: "turn", turnId }, data };
}
function request(requestId: string, text: string, target: "thread-start" | "new-turn" | "steer" = "new-turn"): StoredEvent {
  return ev("client/turn/requested", { requestId, input: [{ type: "text", text, mentions: [] }], target: { kind: target }, initiator: "user" });
}
const presentation = { label: { pending: "Running command", completed: "Ran command" }, icon: { glyph: "Terminal" }, title: "ls" };

describe("sealing", () => {
  it("opens with the recipient's key and the same row identity", () => {
    const watcher = generateMirrorKeyPair();
    const aad = rowAad({ serverId: "work-srv", threadId: "thr_a", recipient: "laptop-srv", generation: "g1", seq: 1 });
    const sealed = seal(JSON.stringify({ hello: "work" }), watcher.publicKey, aad);
    expect(sealed).not.toContain("hello");
    expect(JSON.parse(open(sealed, watcher, aad))).toEqual({ hello: "work" });
  });

  it("refuses a wrong key, a moved row and a changed byte", () => {
    const watcher = generateMirrorKeyPair();
    const other = generateMirrorKeyPair();
    const aad = rowAad({ serverId: "work-srv", threadId: "thr_a", recipient: "laptop-srv", generation: "g1", seq: 1 });
    const sealed = seal("secret", watcher.publicKey, aad);
    expect(() => open(sealed, other, aad)).toThrow();
    expect(() => open(sealed, watcher, rowAad({ serverId: "work-srv", threadId: "thr_a", recipient: "laptop-srv", generation: "g1", seq: 2 }))).toThrow();
    const parsed = JSON.parse(sealed) as { ct: string };
    const bytes = Buffer.from(parsed.ct, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => open(JSON.stringify({ ...JSON.parse(sealed), ct: bytes.toString("base64") }), watcher, aad)).toThrow();
  });

  it("compresses: a large chat batch shrinks well below its JSON size", () => {
    const watcher = generateMirrorKeyPair();
    const text = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ t: "item", id: `i${i}`, text: "Ran npm test, 34 passed" })));
    const sealed = seal(text, watcher.publicKey, "aad");
    expect(sealed.length).toBeLessThan(text.length / 4);
  });

  it("keeps the private key in a 0600 file and reads the same key back", () => {
    const path = join(tempDir(), "fleet", "mirror-key.json");
    const first = loadOrCreateMirrorKey(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = loadOrCreateMirrorKey(path);
    expect(again.publicKey).toBe(first.publicKey);
    const aad = "x";
    expect(open(seal("round trip", first.publicKey, aad), again, aad)).toBe("round trip");
    expect(readFileSync(path, "utf8")).not.toContain("BEGIN");
  });
});

describe("mapItem", () => {
  const asDelta = (close: NonNullable<ReturnType<typeof mapItem>>, id = "r1") => threadDeltaSchema.safeParse({ kind: "item.close", key: { providerItemId: id }, ...close });

  it("maps a command with its output and presentation, as bb's grammar accepts it", () => {
    const close = mapItem({ type: "commandExecution", id: "i1", command: "ls /tmp", cwd: "", status: "completed", aggregatedOutput: "a\nb\n", exitCode: 0, presentation });
    expect(close).toMatchObject({ status: "completed", exitCode: 0, aggregatedOutput: "a\nb\n", item: { type: "command", command: "ls /tmp", cwd: "", exitCode: 0 } });
    expect(asDelta(close!).success).toBe(true);
  });

  it("maps tools, messages, reasoning, reads, file changes and sub-agents", () => {
    const items: Record<string, unknown>[] = [
      { type: "toolCall", id: "i2", tool: "list_whiteboards", server: "bluplai", arguments: { limit: 2 }, result: "[]", status: "completed", presentation: { label: { pending: "Running", completed: "Ran" }, icon: { glyph: "Toolbox" } } },
      { type: "agentMessage", id: "i3", text: "| a | b |\n|---|---|\n| 1 | 2 |" },
      { type: "reasoning", id: "i4", content: ["thinking"], summary: [] },
      { type: "fileRead", id: "i5", path: "/tmp/a.txt", status: "completed" },
      { type: "fileChange", id: "i6", changes: [{ path: "/tmp/a.ts", kind: "add", diff: "+x" }], status: "completed", approvalStatus: null },
      { type: "delegation", id: "i7", childRef: "toolu_1", label: "Build it", status: "completed", background: true, summary: "done" },
      { type: "backgroundTask", id: "i8", familyId: "f1", taskType: "local_bash", description: "Download", status: "completed", taskStatus: "completed", skipTranscript: false, foreground: false },
      { type: "search", id: "i9", mode: "content", query: "TODO", status: "completed" },
      { type: "webFetch", id: "i10", url: "https://example.com", pattern: null, prompt: null, resultText: null, status: "completed" },
      { type: "planSteps", id: "i11", steps: [{ step: "One", status: "completed" }], status: "completed" },
    ];
    for (const raw of items) {
      const close = mapItem(raw);
      expect(close, String(raw.type)).not.toBeNull();
      const parsed = asDelta(close!);
      expect(parsed.success, `${String(raw.type)}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it("leaves out what a copy cannot show (user messages, extension kinds)", () => {
    expect(mapItem({ type: "userMessage", id: "u", content: [] })).toBeNull();
    expect(mapItem({ type: "extension", id: "x", kind: "other/thing", payload: {}, status: "completed" })).toBeNull();
  });

  it("caps tool output at 32 KB per item without splitting a character", () => {
    const big = "é".repeat(40_000);
    const close = mapItem({ type: "commandExecution", id: "i1", command: "cat big", cwd: "", status: "completed", aggregatedOutput: big, exitCode: 0 });
    expect(Buffer.byteLength(close!.aggregatedOutput!, "utf8")).toBeLessThanOrEqual(ITEM_OUTPUT_MAX_BYTES);
    expect(close!.aggregatedOutput).toContain("cut to 32 KB");
    expect(close!.aggregatedOutput).not.toContain("�");
    const tool = mapItem({ type: "toolCall", id: "i2", tool: "read", result: { rows: "x".repeat(50_000) }, status: "completed" });
    expect(Buffer.byteLength(String(tool!.item.result), "utf8")).toBeLessThanOrEqual(ITEM_OUTPUT_MAX_BYTES);
    expect(capText("short")).toBe("short");
  });

  it("swaps a glyph only its own plugin may use for a host glyph", () => {
    const close = mapItem({ type: "toolCall", id: "i2", tool: "kanban_move", server: "bb", status: "completed", presentation: { label: { pending: "a", completed: "b" }, icon: { glyph: "kanban/board" } } });
    expect((close!.presentation as { icon: { glyph: string } }).icon.glyph).toBe("Toolbox");
  });

  it("never leaves a finished item pending", () => {
    expect(mapItem({ type: "fileRead", id: "i", path: "/a", status: "pending" })!.status).toBe("completed");
  });
});

describe("mapEvents", () => {
  it("turns requests, accepts and items into turn, steer, item and end records", () => {
    seq = 0;
    const events = [
      request("creq_1", "list three files", "thread-start"),
      ev("system/thread-provisioning", {}),
      ev("turn/started", {}, "t1"),
      ev("turn/input/accepted", { clientRequestId: "creq_1" }, "t1"),
      ev("item/completed", { item: { type: "commandExecution", id: "i1", command: "ls", cwd: "", status: "completed", aggregatedOutput: "a", exitCode: 0, presentation } }, "t1"),
      request("creq_2", "and say done", "steer"),
      ev("turn/input/accepted", { clientRequestId: "creq_2" }, "t1"),
      ev("item/completed", { item: { type: "agentMessage", id: "i2", text: "done" } }, "t1"),
      ev("item/backgroundTask/completed", { item: { type: "backgroundTask", id: "i3", familyId: "f", taskType: "local_bash", description: "bg", status: "completed", taskStatus: "completed", skipTranscript: false, foreground: false } }),
      ev("turn/completed", { status: "completed" }, "t1"),
    ];
    const state = newMapperState();
    const { records, lastSeq } = mapEvents(events, state, { now: T0 });
    expect(lastSeq).toBe(events[events.length - 1]!.seq);
    expect(records.map((r) => r.t)).toEqual(["turn", "item", "steer", "item", "item", "end"]);
    expect(records[0]).toEqual({ t: "turn", turn: "t1", user: { requestId: "creq_1", text: "list three files" } });
    expect(records[2]).toMatchObject({ t: "steer", turn: "t1", user: { text: "and say done" } });
    expect(records[4]).toMatchObject({ t: "item", turn: "t1", id: "i3" });
  });

  it("marks a turn the agent opened itself (no user message) and drops an empty one", () => {
    seq = 0;
    const events = [
      ev("turn/started", {}, "t2"),
      ev("item/completed", { item: { type: "agentMessage", id: "i9", text: "The background job finished." } }, "t2"),
      ev("turn/completed", { status: "completed" }, "t2"),
      ev("turn/started", {}, "t3"),
      ev("turn/completed", { status: "completed" }, "t3"),
    ];
    const { records } = mapEvents(events, newMapperState(), { now: T0 });
    expect(records).toEqual([
      { t: "turn", turn: "t2", user: null },
      { t: "item", turn: "t2", id: "i9", close: { status: "completed", item: { type: "agentMessage", text: "The background job finished." } } },
      { t: "end", turn: "t2", status: "completed" },
    ]);
  });

  it("holds back a trailing turn/started until its first event, unless it is old", () => {
    seq = 0;
    const events = [request("creq_1", "hi"), ev("turn/started", {}, "t1", T0)];
    const state = newMapperState();
    const held = mapEvents(events, state, { now: T0 + 1000 });
    expect(held.records).toEqual([]);
    expect(held.lastSeq).toBe(events[0]!.seq);
    const late = mapEvents(events.slice(1), state, { now: T0 + 120_000 });
    expect(late.lastSeq).toBe(events[1]!.seq);
  });

  it("stops at the byte budget with the state matching what it published", () => {
    seq = 0;
    const events = [request("creq_1", "go"), ev("turn/started", {}, "t1"), ev("turn/input/accepted", { clientRequestId: "creq_1" }, "t1")];
    for (let i = 0; i < 20; i += 1) events.push(ev("item/completed", { item: { type: "agentMessage", id: `m${i}`, text: "x".repeat(1000) } }, "t1"));
    events.push(ev("turn/completed", { status: "completed" }, "t1"));
    const state = newMapperState();
    const first = mapEvents(events, state, { now: T0, maxBytes: 5000 });
    expect(first.records.length).toBeLessThan(10);
    const rest = mapEvents(events.filter((e) => e.seq > first.lastSeq!), state, { now: T0 });
    const all: MirrorRecord[] = [...first.records, ...rest.records];
    expect(all.filter((r) => r.t === "item")).toHaveLength(20);
    expect(all.filter((r) => r.t === "turn")).toHaveLength(1);
    expect(all[all.length - 1]).toMatchObject({ t: "end", turn: "t1" });
  });

  it("names the request ids it still needs the text of", () => {
    seq = 0;
    const events = [ev("turn/started", {}, "t1"), ev("turn/input/accepted", { clientRequestId: "creq_old" }, "t1")];
    expect(missingRequestIds(events, newMapperState())).toEqual(["creq_old"]);
  });
});

describe("replay window and retention", () => {
  it("starts 30 turns back (steers do not count) and says so", () => {
    seq = 0;
    const reqs: StoredEvent[] = [];
    for (let i = 0; i < 40; i += 1) {
      reqs.push(request(`c${i}`, `turn ${i}`, i === 0 ? "thread-start" : "new-turn"));
      if (i % 3 === 0) reqs.push(request(`s${i}`, `steer ${i}`, "steer"));
    }
    const newestFirst = [...reqs].reverse();
    const start = replayStart(newestFirst);
    expect(start.earlier).toBe(true);
    const opening = reqs.filter((e) => (e.data?.target as { kind: string }).kind !== "steer");
    expect(start.afterSeq).toBe(opening[10]!.seq - 1);
    expect(replayStart(newestFirst.slice(-5))).toEqual({ afterSeq: 0, earlier: false });
  });

  it("keeps a watch while the chat runs, and for 7 days after it was opened", () => {
    const day = 86_400_000;
    expect(watchLive({ openedAt: T0 - 6 * day, running: false, now: T0 })).toBe(true);
    expect(watchLive({ openedAt: T0 - 8 * day, running: false, now: T0 })).toBe(false);
    expect(watchLive({ openedAt: T0 - 30 * day, running: true, now: T0 })).toBe(true);
  });
});

describe("feed and protocol", () => {
  it("reads only whole lines, even when a line is half written", () => {
    const path = join(tempDir(), "thr_copy.ndjson");
    appendFeed(path, [{ t: "header", machine: "work", serverId: "work-srv", remoteThreadId: "thr_a" }]);
    const reader = new FeedReader(path);
    expect(reader.poll().added).toBe(1);
    const line = JSON.stringify({ t: "note", text: "ünïcödé line" });
    const bytes = Buffer.from(`${line}\n`, "utf8");
    appendFileSync(path, bytes.subarray(0, 12));
    expect(reader.poll().added).toBe(0);
    appendFileSync(path, bytes.subarray(12));
    expect(reader.poll().added).toBe(1);
    expect(reader.records[1]).toEqual({ t: "note", text: "ünïcödé line" });
  });

  it("names the machine in the watch-only line", () => {
    expect(watchOnlyLine("work")).toBe("This chat runs on the work. Replying from here is coming later.");
    expect(promptText([{ type: "text", text: "look" }, { type: "localImage", path: "/tmp/a.png" }])).toBe("look\n[image: a.png]");
    expect(sameText("a\r\nb ", "a\nb")).toBe(true);
  });

  it("snapshots stay backward compatible with the new optional fields", () => {
    const base = { serverId: "laptop-srv", label: "laptop", url: null, machineKey: "laptop", machines: [], publishedAt: T0 };
    const thread = { id: "t", title: "t", state: "idle", machine: "laptop", projectId: "p", projectName: null, providerId: null, parentThreadId: null, createdAt: T0, updatedAt: T0, url: null };
    expect(snapshotSchema.safeParse({ ...base, threads: [thread] }).success).toBe(true);
    const full = snapshotSchema.parse({ ...base, mirrorKey: "k", features: ["messages", "outputs", "mirror"], threads: [{ ...thread, model: "claude-opus-5-5", reasoningLevel: "max", pinned: true, sectionName: "Clients" }] });
    expect(full.threads[0]).toMatchObject({ model: "claude-opus-5-5", pinned: true, sectionName: "Clients" });
    expect(full.mirrorKey).toBe("k");
  });
});

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine, pump, resetBridgeForTests, sessionForTests } from "./mirror/bridge";
import { appendFeed, cursorPath, feedPath, readCursor } from "./mirror/feed";
import { controlId, listControls, mirrorReplayInput, readControlState, writeControlState } from "./mirror/control";
import type { FeedRecord } from "./mirror/protocol";

let dir: string;
const threadId = "thr_native_copy";
const copyReplay = "only-this-copy-replay";
const options = () => ({ model: "mirror", reasoningLevel: "medium", providerOptions: { feedDir: dir }, permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null });
const text = (value: string) => [{ type: "text", text: value, mentions: [] }];
type Message = { method?: string; params?: { threadId?: string; deltas?: Array<Record<string, unknown>> } };
const deltas = (messages: Message[]) => messages.filter((m) => m.method === "thread/delta").flatMap((m) => m.params?.deltas ?? []);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet-writable-bridge-")); resetBridgeForTests(); });
afterEach(() => { resetBridgeForTests(); rmSync(dir, { recursive: true, force: true }); });

async function open(initialEnd = true) {
  mkdirSync(dir, { recursive: true });
  const records: FeedRecord[] = [
    { t: "header", machine: "studio", serverId: "studio-srv", remoteThreadId: "thr_owned", control: { v: 1, replayToken: copyReplay } },
    { t: "turn", turn: "owner_turn_1", user: { requestId: "creq_owner_1", text: "Check build" } },
    ...(initialEnd ? [{ t: "end", turn: "owner_turn_1", status: "completed" } as const] : []),
  ];
  appendFeed(feedPath(dir, threadId), records);
  const harness = createHarness(handleLine);
  harness.sendRequest(1, "thread/start", { threadId, cwd: dir, instructionMode: "append", options: options() });
  await harness.waitForResponse(1);
  harness.sendRequest(2, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_aaaaaaaaaa", input: mirrorReplayInput("Check build", { requestId: "creq_owner_1", token: copyReplay }), options: options() });
  await harness.waitForResponse(2);
  harness.takeMessages();
  return harness;
}

describe("native writable mirror bridge", () => {
  it("forwards a real reply exactly once and consumes its owner echo without a second user acceptance", async () => {
    const harness = await open();
    try {
      expect(listControls(dir)).toHaveLength(0);
      harness.sendRequest(3, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_bbbbbbbbbb", input: text("Check build"), options: options() });
      await harness.waitForResponse(3);
      const sent = deltas(harness.takeMessages() as Message[]);
      expect(sent.map((d) => d.kind)).toEqual(["input.accepted", "turn.open"]);
      const commands = listControls(dir);
      expect(commands).toHaveLength(1);
      const command = commands[0]!;
      expect(command).toMatchObject({ id: controlId(threadId, "creq_bbbbbbbbbb", "send"), targetServer: "studio-srv", remoteThreadId: "thr_owned", action: "send", text: "Check build" });
      writeControlState(dir, command.id, { state: "sent", at: Date.now(), attempts: 1 });
      appendFeed(feedPath(dir, threadId), [
        { t: "turn", turn: "owner_turn_2", user: { requestId: "creq_owner_2", text: command.text, controlId: command.id } },
        { t: "item", turn: "owner_turn_2", id: "owner_result_2", close: { status: "completed", item: { type: "agentMessage", text: "Build passed on studio." } } },
        { t: "end", turn: "owner_turn_2", status: "completed" },
      ]);
      pump(sessionForTests(threadId)!);
      const echoed = deltas(harness.takeMessages() as Message[]);
      expect(echoed.map((d) => d.kind)).toEqual(["item.close", "turn.boundary"]);
      expect(echoed[0]?.item).toEqual({ type: "agentMessage", text: "Build passed on studio." });
      expect(listControls(dir)).toHaveLength(1);
    } finally { harness.restore(); }
  });

  it("releases only the waiting placeholder when an earlier external owner turn precedes the reply echo", async () => {
    const harness = await open(); // owner turn 1 has completed
    try {
      harness.sendRequest(3, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_bbbbbbbbbb", input: text("My follow-up"), options: options() });
      await harness.waitForResponse(3);
      const local = deltas(harness.takeMessages() as Message[]);
      expect(local.map((delta) => delta.kind)).toEqual(["input.accepted", "turn.open"]);
      const command = listControls(dir)[0]!;
      writeControlState(dir, command.id, { state: "accepted", at: Date.now(), attempts: 1 });
      const before = readCursor(cursorPath(dir, threadId));
      appendFeed(feedPath(dir, threadId), [
        { t: "turn", turn: "owner_turn_2", user: { requestId: "creq_external", text: "Earlier external message" } },
        { t: "item", turn: "owner_turn_2", id: "external_answer", close: { status: "completed", item: { type: "agentMessage", text: "Earlier answer" } } },
        { t: "end", turn: "owner_turn_2", status: "completed" },
        { t: "turn", turn: "owner_turn_3", user: { requestId: "creq_owned", text: command.text, controlId: command.id } },
        { t: "item", turn: "owner_turn_3", id: "owned_answer", close: { status: "completed", item: { type: "agentMessage", text: "My answer" } } },
        { t: "end", turn: "owner_turn_3", status: "completed" },
      ]);
      pump(sessionForTests(threadId)!);
      const released = deltas(harness.takeMessages() as Message[]);
      expect(released.map((delta) => delta.kind)).toEqual(["item.close", "turn.boundary"]);
      expect((released[0]?.item as { text?: string }).text).toContain("earlier owner turn");
      expect(released[1]).toMatchObject({ status: "completed" });
      expect(sessionForTests(threadId)?.open).toBeNull();
      expect(sessionForTests(threadId)?.forwarded.has(command.id)).toBe(true);
      expect(readCursor(cursorPath(dir, threadId))).toBe(before);

      // An idle copy now lets the service deliver the earlier source replay.
      harness.sendRequest(4, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_gggggggggg", input: mirrorReplayInput("Earlier external message", { requestId: "creq_external", token: copyReplay }), options: options() });
      await harness.waitForResponse(4);
      const resumed = deltas(harness.takeMessages() as Message[]);
      expect(resumed.filter((delta) => delta.kind === "input.accepted")).toEqual([{ kind: "input.accepted", clientRequestId: "creq_gggggggggg" }]);
      expect(resumed.filter((delta) => delta.kind === "item.close").map((delta) => (delta.item as { text: string }).text)).toEqual(["Earlier answer", "My answer"]);
      expect(resumed.filter((delta) => delta.kind === "turn.boundary")).toHaveLength(2);
      expect(sessionForTests(threadId)?.forwarded.size).toBe(0);
      pump(sessionForTests(threadId)!);
      expect(deltas(harness.takeMessages() as Message[])).toEqual([]);
      expect(listControls(dir)).toHaveLength(1);
    } finally { harness.restore(); }
  });

  it("settles a pending placeholder when admitted input later receives an owner failure receipt", async () => {
    const harness = await open();
    try {
      harness.sendRequest(3, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_hhhhhhhhhh", input: text("Waiting message"), options: options() });
      await harness.waitForResponse(3); harness.takeMessages();
      const command = listControls(dir)[0]!;
      writeControlState(dir, command.id, { state: "accepted", at: Date.now(), attempts: 1 });
      pump(sessionForTests(threadId)!);
      expect(deltas(harness.takeMessages() as Message[])).toEqual([]);
      writeControlState(dir, command.id, { state: "failed", at: Date.now(), attempts: 1, message: "The owner rejected this input." });
      pump(sessionForTests(threadId)!);
      const output = deltas(harness.takeMessages() as Message[]);
      expect(output.map((delta) => delta.kind)).toEqual(["item.close", "turn.boundary"]);
      expect(output.at(-1)).toMatchObject({ status: "failed", error: { message: "The owner rejected this input." } });
      expect(sessionForTests(threadId)?.open).toBeNull();
      pump(sessionForTests(threadId)!);
      expect(deltas(harness.takeMessages() as Message[])).toEqual([]);
      expect(listControls(dir)).toHaveLength(1);
    } finally { harness.restore(); }
  });

  it("forwards native steering and a targeted interrupt but never stops the owner on shutdown", async () => {
    const harness = await open(false);
    try {
      harness.sendRequest(3, "turn/steer", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_cccccccccc", expectedTurnId: "local_turn", input: text("Only inspect the log"), options: options() });
      await harness.waitForResponse(3);
      expect(listControls(dir)[0]).toMatchObject({ action: "steer", expectedRemoteTurnId: "owner_turn_1", text: "Only inspect the log" });
      harness.sendRequest(4, "thread/stop", { threadId, providerThreadId: `mirror_${threadId}`, activeTurnId: "t1", intent: "release" });
      await harness.waitForResponse(4);
      expect(listControls(dir).filter((c) => c.action === "stop")).toHaveLength(0);
    } finally { harness.restore(); }
    resetBridgeForTests();
    const next = await open(false);
    try {
      next.sendRequest(5, "thread/stop", { threadId, providerThreadId: `mirror_${threadId}`, activeTurnId: "t1", intent: "interrupt" });
      await next.waitForResponse(5);
      expect(listControls(dir).find((c) => c.action === "stop")).toMatchObject({ expectedRemoteTurnId: "owner_turn_1", remoteThreadId: "thr_owned" });
    } finally { next.restore(); }
  });

  it("restores an active owner on native resume and gives each explicit interrupt its own durable identity", async () => {
    const harness = await open(false);
    try {
      appendFeed(feedPath(dir, threadId), [
        { t: "item", turn: "owner_turn_1", id: "before_reload", close: { status: "completed", item: { type: "agentMessage", text: "Already displayed" } } },
      ]);
      pump(sessionForTests(threadId)!);
      harness.sendRequest(3, "turn/steer", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_bbbbbbbbbb", expectedTurnId: "local_turn", input: text("First pending instruction"), options: options() });
      await harness.waitForResponse(3);
      const firstInput = listControls(dir)[0]!;
      writeControlState(dir, firstInput.id, { state: "sent", at: Date.now(), attempts: 1 });
      harness.sendRequest(4, "thread/stop", { threadId, providerThreadId: `mirror_${threadId}`, activeTurnId: "local_turn", intent: "interrupt" });
      await harness.waitForResponse(4);
      const firstStop = listControls(dir).find((control) => control.action === "stop")!;
      expect(firstStop).toMatchObject({ expectedRemoteTurnId: "owner_turn_1", cancelRequestIds: [firstInput.id] });
      writeControlState(dir, firstStop.id, { state: "failed", at: Date.now(), attempts: 1, message: "The owner is still active; the first stop did not complete." });
      const cursor = readCursor(cursorPath(dir, threadId));
      harness.takeMessages();

      // thread/resume has no active-turn field in the actual SDK contract.
      harness.sendRequest(5, "thread/resume", { threadId, providerThreadId: `mirror_${threadId}`, cwd: dir, instructionMode: "append", options: options() });
      await harness.waitForResponse(5);
      expect(deltas(harness.takeMessages() as Message[]).map((delta) => delta.kind)).toEqual(["session.reset"]);
      expect(sessionForTests(threadId)).toMatchObject({ owner: { serverId: "studio-srv", remoteThreadId: "thr_owned" }, ownerTurn: "owner_turn_1", replayToken: copyReplay, open: null });
      expect(readCursor(cursorPath(dir, threadId))).toBe(cursor);
      expect(listControls(dir)).toHaveLength(2); // resume wrote/dispatched nothing

      harness.sendRequest(6, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_cccccccccc", input: text("New pending instruction"), options: options() });
      await harness.waitForResponse(6);
      const secondInput = listControls(dir).find((control) => control.action === "send")!;
      expect(secondInput).toMatchObject({ targetServer: "studio-srv", remoteThreadId: "thr_owned", expectedRemoteTurnId: "owner_turn_1" });
      writeControlState(dir, secondInput.id, { state: "accepted", at: Date.now(), attempts: 1 });
      const resumed = sessionForTests(threadId)!;
      harness.sendRequest(7, "thread/stop", { threadId, providerThreadId: `mirror_${threadId}`, activeTurnId: "new_local_turn", intent: "interrupt" });
      await harness.waitForResponse(7);
      const stops = listControls(dir).filter((control) => control.action === "stop");
      expect(stops).toHaveLength(2);
      expect(new Set(stops.map((control) => control.id)).size).toBe(2);
      const secondStop = stops.find((control) => control.id !== firstStop.id)!;
      expect(secondStop).toMatchObject({ expectedRemoteTurnId: "owner_turn_1" });
      expect(new Set(secondStop.cancelRequestIds)).toEqual(new Set([firstInput.id, secondInput.id]));
      pump(resumed); pump(resumed);
      expect(listControls(dir)).toHaveLength(4); // no automatic stop reissue

      harness.sendRequest(8, "thread/resume", { threadId, providerThreadId: `mirror_${threadId}`, cwd: dir, instructionMode: "append", options: options() });
      await harness.waitForResponse(8);
      harness.sendRequest(9, "thread/stop", { threadId, providerThreadId: `mirror_${threadId}`, activeTurnId: null, intent: "release" });
      await harness.waitForResponse(9);
      expect(listControls(dir).filter((control) => control.action === "stop")).toHaveLength(2);
    } finally { harness.restore(); }
  });

  it("hydrates latest writable metadata on resume without making a finished owner turn active or replaying items", async () => {
    const harness = await open();
    try {
      const latestToken = "upgraded-replay-token";
      appendFeed(feedPath(dir, threadId), [
        { t: "control", v: 1, replayToken: latestToken },
        { t: "item", turn: "owner_turn_1", id: "completed_background", close: { status: "completed", item: { type: "backgroundTask", taskId: "task_1", description: "Settled task" } } },
      ]);
      pump(sessionForTests(threadId)!);
      const cursor = readCursor(cursorPath(dir, threadId));
      harness.takeMessages();
      resetBridgeForTests(); // process/session state is gone; only the feed and cursor remain
      harness.sendRequest(3, "thread/resume", { threadId, providerThreadId: `mirror_${threadId}`, cwd: dir, instructionMode: "append", options: options() });
      await harness.waitForResponse(3);
      expect(deltas(harness.takeMessages() as Message[]).map((delta) => delta.kind)).toEqual(["session.reset"]);
      expect(sessionForTests(threadId)).toMatchObject({ machine: "studio", owner: { serverId: "studio-srv", remoteThreadId: "thr_owned" }, ownerTurn: null, replayToken: latestToken, open: null });
      expect(readCursor(cursorPath(dir, threadId))).toBe(cursor);
      expect(listControls(dir)).toEqual([]);
      harness.sendRequest(4, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_jjjjjjjjjj", input: text("Reply after reload"), options: options() });
      await harness.waitForResponse(4);
      const command = listControls(dir)[0]!;
      expect(command).toMatchObject({ action: "send", text: "Reply after reload", targetServer: "studio-srv", remoteThreadId: "thr_owned" });
      expect(command.expectedRemoteTurnId).toBeUndefined();
      const output = deltas(harness.takeMessages() as Message[]);
      expect(output.map((delta) => delta.kind)).toEqual(["input.accepted", "turn.open"]);
      harness.sendRequest(5, "thread/stop", { threadId, providerThreadId: `mirror_${threadId}`, activeTurnId: "reply_wait", intent: "interrupt" });
      await harness.waitForResponse(5);
      expect(listControls(dir).filter((control) => control.action === "stop")).toEqual([]);
      expect(readControlState(dir, command.id)?.state).toBe("cancelled");
    } finally { harness.restore(); }
  });

  it("cancels a reply before dispatch without sending a broad stop to an unrelated owner turn", async () => {
    const harness = await open();
    try {
      harness.sendRequest(3, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_dddddddddd", input: text("Inspect receipts"), options: options() });
      await harness.waitForResponse(3);
      harness.sendRequest(4, "thread/stop", { threadId, providerThreadId: `mirror_${threadId}`, activeTurnId: "t1", intent: "interrupt" });
      await harness.waitForResponse(4);
      const commands = listControls(dir);
      expect(commands).toHaveLength(1);
      expect(readControlState(dir, commands[0]!.id)?.state).toBe("cancelled");
    } finally { harness.restore(); }
  });

  it("keeps unavailable delivery pending and reports an uncertain outcome without resending", async () => {
    const harness = await open();
    try {
      harness.sendRequest(3, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_eeeeeeeeee", input: text("Inspect the result"), options: options() });
      await harness.waitForResponse(3); harness.takeMessages();
      const command = listControls(dir)[0]!;
      writeControlState(dir, command.id, { state: "unavailable", at: 1, attempts: 1, message: "offline" });
      pump(sessionForTests(threadId)!);
      let output = deltas(harness.takeMessages() as Message[]);
      expect(output.some((d) => d.kind === "turn.boundary")).toBe(false);
      expect((output[0]?.item as { text?: string }).text).toContain("saved here");
      writeControlState(dir, command.id, { state: "unknown", at: 2, attempts: 2, message: "No owner receipt; check before retrying." });
      pump(sessionForTests(threadId)!);
      output = deltas(harness.takeMessages() as Message[]);
      expect(output.at(-1)).toMatchObject({ kind: "turn.boundary", status: "failed" });
      pump(sessionForTests(threadId)!);
      expect(deltas(harness.takeMessages() as Message[])).toEqual([]);
      expect(listControls(dir)).toHaveLength(1);
    } finally { harness.restore(); }
  });

  it("refuses attachments instead of sending an unreadable local path to the other Mac", async () => {
    const harness = await open();
    try {
      harness.sendRequest(3, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_ffffffffff", input: [{ type: "localFile", path: "/tmp/local-only.pdf", name: "receipt.pdf" }], options: options() });
      await harness.waitForResponse(3);
      const output = deltas(harness.takeMessages() as Message[]);
      expect(output.at(-1)).toMatchObject({ kind: "turn.boundary", status: "failed" });
      expect((output.find((d) => d.kind === "item.close")?.item as { text: string }).text).toContain("not sent");
      expect(listControls(dir)).toEqual([]);
    } finally { harness.restore(); }
  });
});

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_createBridgeJsonRpcTestHarness as createHarness,
  experimental_createDeltaAssembler as createAssembler,
  experimental_formatConformanceReport as formatReport,
  experimental_runBridgeConformance as runConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine, pump, resetBridgeForTests, sessionForTests } from "./mirror/bridge";
import { appendFeed, cursorPath, feedPath, readCursor } from "./mirror/feed";
import type { FeedRecord } from "./mirror/protocol";

const root = mkdtempSync(join(tmpdir(), "fleet-mirror-bridge-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const presentation = { label: { pending: "Running command", completed: "Ran command" }, icon: { glyph: "Terminal" }, title: "ls /tmp" };
const options = (feedDir: string | null) => ({
  model: "mirror",
  reasoningLevel: "medium",
  providerOptions: feedDir === null ? {} : { feedDir },
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
});
const text = (t: string) => [{ type: "text", text: t, mentions: [] }];

type Message = { id?: number | string; method?: string; params?: { threadId?: string; deltas?: Array<Record<string, unknown>> }; result?: unknown; error?: unknown };

/** Every delta the bridge sent for a thread since the last call. */
function deltasOf(messages: Message[], threadId: string): Array<Record<string, unknown>> {
  return messages.filter((m) => m.method === "thread/delta" && m.params?.threadId === threadId).flatMap((m) => m.params?.deltas ?? []);
}

describe("fleet-mirror bridge", () => {
  beforeEach(() => resetBridgeForTests());

  it("passes bb's provider bridge conformance kit (a typed prompt gets the watch-only line)", async () => {
    const harness = createHarness(handleLine);
    try {
      const report = await runConformance({
        transport: { send: handleLine, takeMessages: harness.takeMessages },
        providerId: "fleet-mirror",
        session: { cwd: join(root, "conformance"), promptInput: text("hello from here") as never },
        timeoutMs: 5000,
      });
      expect(report.passed, formatReport(report)).toBe(true);
    } finally {
      harness.restore();
    }
  });

  it("replays a remote turn: user bubble, items, a remote steer, then the end", async () => {
    const feedDir = join(root, "replay");
    const threadId = "thr_copy1";
    const records: FeedRecord[] = [
      { t: "header", machine: "work", serverId: "work-srv", remoteThreadId: "thr_remote" },
      { t: "turn", turn: "rt1", user: { requestId: "creq_r1", text: "list three files in /tmp" } },
      { t: "item", turn: "rt1", id: "ri1", close: { status: "completed", exitCode: 0, aggregatedOutput: "a\nb\nc\n", item: { type: "command", command: "ls /tmp", cwd: "", exitCode: 0, aggregatedOutput: "a\nb\nc\n" }, presentation } },
      { t: "steer", turn: "rt1", user: { requestId: "creq_r2", text: "and say done" } },
      { t: "item", turn: "rt1", id: "ri2", close: { status: "completed", item: { type: "agentMessage", text: "done" } } },
      { t: "end", turn: "rt1", status: "completed" },
    ];
    const { mkdirSync } = await import("node:fs");
    mkdirSync(feedDir, { recursive: true });
    appendFeed(feedPath(feedDir, threadId), records);

    const harness = createHarness(handleLine);
    const assembler = createAssembler({ providerId: "fleet-mirror" });
    try {
      harness.sendRequest(1, "initialize", { protocolVersion: 2, client: { name: "bb", version: "1" }, grammarVersions: [3, 3] });
      await harness.waitForResponse(1);
      harness.sendRequest(2, "thread/start", { threadId, cwd: feedDir, instructionMode: "append", options: options(feedDir) });
      await harness.waitForResponse(2);
      harness.sendRequest(3, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_aaaaaaaaaa", input: text("list three files in /tmp"), options: options(feedDir) });
      await harness.waitForResponse(3);
      let deltas = deltasOf(harness.takeMessages() as Message[], threadId);
      expect(deltas.map((d) => d.kind)).toEqual(["session.reset", "input.accepted", "turn.open", "item.close"]);
      expect(readCursor(cursorPath(feedDir, threadId))).toBe(3); // waiting at the remote steer

      harness.sendRequest(4, "turn/steer", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_bbbbbbbbbb", expectedTurnId: "t1", input: text("and say done"), options: options(feedDir) });
      await harness.waitForResponse(4);
      const second = deltasOf(harness.takeMessages() as Message[], threadId);
      expect(second.map((d) => d.kind)).toEqual(["input.accepted", "item.close", "turn.boundary"]);
      deltas = [...deltas, ...second];

      const events = assembler.assemble({ threadId, deltas: deltas as never });
      expect(events.map((e) => e.type)).toEqual([
        "turn/started",
        "turn/input/accepted",
        "item/completed",
        "turn/input/accepted",
        "item/completed",
        "turn/completed",
      ]);
      expect(readCursor(cursorPath(feedDir, threadId))).toBe(records.length);
    } finally {
      harness.restore();
    }
  });

  it("answers typed input with the watch-only line naming the machine, and streams later remote items", async () => {
    const feedDir = join(root, "watch");
    const threadId = "thr_copy2";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(feedDir, { recursive: true });
    appendFeed(feedPath(feedDir, threadId), [
      { t: "header", machine: "work", serverId: "work-srv", remoteThreadId: "thr_remote2" },
      { t: "turn", turn: "rt1", user: { requestId: "c1", text: "first" } },
      { t: "end", turn: "rt1", status: "completed" },
    ]);
    const harness = createHarness(handleLine);
    try {
      harness.sendRequest(1, "thread/start", { threadId, cwd: feedDir, instructionMode: "append", options: options(feedDir) });
      await harness.waitForResponse(1);
      harness.sendRequest(2, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_cccccccccc", input: text("first"), options: options(feedDir) });
      await harness.waitForResponse(2);
      harness.takeMessages();

      harness.sendRequest(3, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_dddddddddd", input: text("can you also check the logs?"), options: options(feedDir) });
      await harness.waitForResponse(3);
      const typed = deltasOf(harness.takeMessages() as Message[], threadId);
      expect(typed.map((d) => d.kind)).toEqual(["input.accepted", "turn.open", "item.close", "turn.boundary"]);
      expect((typed[2]!.item as { text: string }).text).toBe("This chat runs on the work. Replying from here is coming later.");

      // The agent on the work opens a turn itself (a background job ended); it streams in.
      appendFeed(feedPath(feedDir, threadId), [
        { t: "turn", turn: "rt2", user: null },
        { t: "item", turn: "rt2", id: "ri5", close: { status: "completed", item: { type: "agentMessage", text: "The build finished." } } },
      ]);
      pump(sessionForTests(threadId)!);
      let streamed = deltasOf(harness.takeMessages() as Message[], threadId);
      expect(streamed.map((d) => d.kind)).toEqual(["turn.open", "item.close"]);
      appendFileSync(feedPath(feedDir, threadId), `${JSON.stringify({ t: "end", turn: "rt2", status: "completed" })}\n`);
      pump(sessionForTests(threadId)!);
      streamed = deltasOf(harness.takeMessages() as Message[], threadId);
      expect(streamed.map((d) => d.kind)).toEqual(["turn.boundary"]);
    } finally {
      harness.restore();
    }
  });

  it("hides the provider from pickers: health says not installed", async () => {
    const harness = createHarness(handleLine);
    try {
      harness.sendRequest(1, "provider/health", { providerId: "fleet-mirror" });
      const response = (await harness.waitForResponse(1)) as Message;
      expect(response.result).toMatchObject({ supported: true, health: { status: "not_installed" } });
    } finally {
      harness.restore();
    }
  });
});

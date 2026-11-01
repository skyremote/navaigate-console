import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine, pump, resetBridgeForTests, sessionForTests } from "./mirror/bridge";
import { appendFeed, feedPath } from "./mirror/feed";
import { controlId, interactionResponseFrom, listControls, mirrorReplayInput } from "./mirror/control";
import { mapEvents, newMapperState } from "./mirror/mapping";
import type { FeedRecord } from "./mirror/protocol";

let dir: string;
const threadId = "thr_native_copy";
const copyReplay = "only-this-copy-replay";
const options = () => ({ model: "mirror", reasoningLevel: "medium", providerOptions: { feedDir: dir }, permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null });
type Message = { id?: string | number; method?: string; params?: Record<string, unknown> };
const approval = { kind: "approval", subject: { kind: "command", itemId: "item_cmd", command: "rm -rf build" }, availableDecisions: ["deny", "allow_once"] };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fleet-mirror-ix-")); resetBridgeForTests(); });
afterEach(() => { resetBridgeForTests(); rmSync(dir, { recursive: true, force: true }); });

async function openRunning(records: FeedRecord[] = []) {
  mkdirSync(dir, { recursive: true });
  appendFeed(feedPath(dir, threadId), [
    { t: "header", machine: "studio", serverId: "studio-srv", remoteThreadId: "thr_owned", control: { v: 1, replayToken: copyReplay } },
    { t: "turn", turn: "owner_turn_1", user: { requestId: "creq_owner_1", text: "Build it" } },
    ...records,
  ]);
  const harness = createHarness(handleLine);
  harness.sendRequest(1, "thread/start", { threadId, cwd: dir, instructionMode: "append", options: options() });
  await harness.waitForResponse(1);
  harness.sendRequest(2, "turn/start", { threadId, providerThreadId: `mirror_${threadId}`, clientRequestId: "creq_aaaaaaaaaa", input: mirrorReplayInput("Build it", { requestId: "creq_owner_1", token: copyReplay }), options: options() });
  await harness.waitForResponse(2);
  return harness;
}

describe("owner interaction lifecycle mapping", () => {
  it("emits a pending provider question or approval and its end, and ignores plugin-origin ones", () => {
    const state = newMapperState();
    const at = Date.now() - 120_000;
    const events = [
      { seq: 1, type: "turn/started", createdAt: at, scope: { kind: "turn", turnId: "t1" } },
      { seq: 2, type: "system/interaction/lifecycle", createdAt: at, scope: { kind: "turn", turnId: "t1" }, data: { interaction: { id: "int_a", status: "pending", origin: { kind: "provider" }, payload: { kind: "approval" } } } },
      { seq: 3, type: "system/interaction/lifecycle", createdAt: at, scope: { kind: "turn", turnId: "t1" }, data: { interaction: { id: "int_p", status: "pending", origin: { kind: "plugin" }, payload: { kind: "plugin" } } } },
      { seq: 4, type: "system/interaction/lifecycle", createdAt: at, scope: { kind: "turn", turnId: "t1" }, data: { interaction: { id: "int_a", status: "resolved", origin: { kind: "provider" }, payload: { kind: "approval" } } } },
    ];
    const { records } = mapEvents(events, state);
    expect(records).toEqual([
      { t: "turn", turn: "t1", user: null },
      { t: "interaction", turn: "t1", id: "int_a", kind: "approval", detail: null },
      { t: "interaction-end", id: "int_a", status: "resolved" },
    ]);
  });

  it("carries the owner's own answer on the end record so the copy can show it answered", () => {
    const state = newMapperState();
    const at = Date.now() - 120_000;
    const answer = { kind: "user_answer", answers: { q1: { selected: ["q1:b"] } } };
    const { records } = mapEvents([
      { seq: 1, type: "turn/started", createdAt: at, scope: { kind: "turn", turnId: "t1" } },
      { seq: 2, type: "system/interaction/lifecycle", createdAt: at, scope: { kind: "turn", turnId: "t1" }, data: { interaction: { id: "int_q", status: "resolving", origin: { kind: "provider" }, payload: { kind: "user_question" }, resolution: answer } } },
      { seq: 3, type: "system/interaction/lifecycle", createdAt: at, scope: { kind: "turn", turnId: "t1" }, data: { interaction: { id: "int_q", status: "resolved", origin: { kind: "provider" }, payload: { kind: "user_question" }, resolution: answer } } },
      { seq: 4, type: "system/interaction/lifecycle", createdAt: at, scope: { kind: "turn", turnId: "t1" }, data: { interaction: { id: "int_big", status: "resolved", origin: { kind: "provider" }, payload: { kind: "user_question" }, resolution: { kind: "user_answer", answers: { q: { selected: [], freeText: "x".repeat(70_000) } } } } } },
    ], state);
    expect(records.filter((record) => record.t === "interaction-end")).toEqual([
      { t: "interaction-end", id: "int_q", status: "resolved", resolution: answer },
      { t: "interaction-end", id: "int_big", status: "resolved" },
    ]);
  });
});

describe("native answers", () => {
  it("maps only real approval decisions and question answers", () => {
    expect(interactionResponseFrom("approval", { decision: "allow_once", grantedPermissions: null })).toEqual({ kind: "approval", decision: "allow_once" });
    expect(interactionResponseFrom("approval", { decision: "approve_everything" })).toBeNull();
    expect(interactionResponseFrom("user_question", { kind: "user_answer", answers: { q1: { selected: ["a"], freeText: " " } } })).toEqual({ kind: "user_answer", answers: { q1: { selected: ["a"] } } });
    expect(interactionResponseFrom("user_question", { decision: "deny" })).toBeNull();
  });
});

describe("native mirror questions and approvals", () => {
  it("raises the owner's approval as a native request on the open turn and saves the answer as one durable respond control", async () => {
    const harness = await openRunning();
    try {
      harness.takeMessages();
      appendFeed(feedPath(dir, threadId), [{ t: "interaction", turn: "owner_turn_1", id: "int_a", kind: "approval", detail: { payload: approval, fingerprint: "f".repeat(64) } }]);
      pump(sessionForTests(threadId)!);
      pump(sessionForTests(threadId)!);
      const requests = (harness.takeMessages() as Message[]).filter((m) => m.method === "interaction/request");
      expect(requests).toEqual([{ jsonrpc: "2.0", id: "fleet-ix:int_a", method: "interaction/request", params: { providerThreadId: `mirror_${threadId}`, threadId, turnId: null, payload: approval } }]);
      handleLine(JSON.stringify({ jsonrpc: "2.0", id: "fleet-ix:int_a", result: { decision: "allow_once", grantedPermissions: null } }));
      handleLine(JSON.stringify({ jsonrpc: "2.0", id: "fleet-ix:int_a", result: { decision: "deny" } }));
      const controls = listControls(dir);
      expect(controls).toHaveLength(1);
      expect(controls[0]).toMatchObject({ id: controlId(threadId, "ix:int_a", "respond"), action: "respond", targetServer: "studio-srv", remoteThreadId: "thr_owned", interaction: { interactionId: "int_a", fingerprint: "f".repeat(64), response: { kind: "approval", decision: "allow_once" } } });
    } finally { harness.restore(); }
  });

  it("raises nothing without owner detail or after the owner ended it, and a cancelled prompt sends no answer", async () => {
    const harness = await openRunning([
      { t: "interaction", turn: "owner_turn_1", id: "int_no_detail", kind: "approval", detail: null },
      { t: "interaction-end", id: "int_gone", status: "resolved" },
      { t: "interaction", turn: "owner_turn_1", id: "int_gone", kind: "approval", detail: { payload: approval, fingerprint: "e".repeat(64) } },
      { t: "interaction", turn: "owner_turn_1", id: "int_cancel", kind: "approval", detail: { payload: approval, fingerprint: "d".repeat(64) } },
    ]);
    try {
      pump(sessionForTests(threadId)!);
      const requests = (harness.takeMessages() as Message[]).filter((m) => m.method === "interaction/request");
      expect(requests.map((m) => m.id)).toEqual(["fleet-ix:int_cancel"]);
      handleLine(JSON.stringify({ jsonrpc: "2.0", id: "fleet-ix:int_cancel", error: { code: -32000, message: "Interaction cancelled" } }));
      expect(listControls(dir)).toHaveLength(0);
    } finally { harness.restore(); }
  });

  it("raises nothing when the owner's end already follows the prompt in the feed, as when a copy starts after the owner answered", async () => {
    const question = { kind: "user_question", questions: [{ id: "q1", prompt: "Colour?", multiSelect: false, allowFreeText: false, options: [{ value: "q1:a", label: "Red" }, { value: "q1:b", label: "Blue" }] }] };
    const harness = await openRunning([
      { t: "interaction", turn: "owner_turn_1", id: "int_late", kind: "user_question", detail: { payload: question, fingerprint: "c".repeat(64) } },
      { t: "interaction-end", id: "int_late", status: "resolved" },
      { t: "interaction", turn: "owner_turn_1", id: "int_open", kind: "approval", detail: { payload: approval, fingerprint: "b".repeat(64) } },
    ]);
    try {
      pump(sessionForTests(threadId)!);
      pump(sessionForTests(threadId)!);
      const requests = (harness.takeMessages() as Message[]).filter((m) => m.method === "interaction/request");
      expect(requests.map((m) => m.id)).toEqual(["fleet-ix:int_open"]);
      handleLine(JSON.stringify({ jsonrpc: "2.0", id: "fleet-ix:int_late", result: { kind: "user_answer", answers: { q1: { selected: ["q1:b"] } } } }));
      expect(listControls(dir)).toHaveLength(0);
    } finally { harness.restore(); }
  });

  it("sends no owner answer when the copy settles a raised prompt after the owner's end reached the feed", async () => {
    const harness = await openRunning([{ t: "interaction", turn: "owner_turn_1", id: "int_a", kind: "approval", detail: { payload: approval, fingerprint: "f".repeat(64) } }]);
    try {
      pump(sessionForTests(threadId)!);
      expect((harness.takeMessages() as Message[]).filter((m) => m.method === "interaction/request").map((m) => m.id)).toEqual(["fleet-ix:int_a"]);
      // The service appends the owner's end, then settles the copy's prompt before the next pump.
      appendFeed(feedPath(dir, threadId), [{ t: "interaction-end", id: "int_a", status: "resolved", resolution: { decision: "allow_once", grantedPermissions: null } }]);
      handleLine(JSON.stringify({ jsonrpc: "2.0", id: "fleet-ix:int_a", result: { decision: "allow_once", grantedPermissions: null } }));
      expect(listControls(dir)).toHaveLength(0);
    } finally { harness.restore(); }
  });

  it("declares provider-enforced approvals so the copy's own permission policy never answers an owner approval", async () => {
    const harness = createHarness(handleLine);
    try {
      harness.sendRequest(9, "initialize", { protocolVersion: 2, client: { name: "bb", version: "1" }, grammarVersions: [3, 3] });
      const response = await harness.waitForResponse(9) as { result?: { capabilities?: { approvalEnforcedBy?: string } } } | Record<string, unknown>;
      expect(JSON.stringify(response)).toContain('"approvalEnforcedBy":"provider"');
    } finally { harness.restore(); }
  });
});

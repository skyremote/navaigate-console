// Native model continuations: Helper Desk follows the whole logical conversation
// and marks each model switch. Shapes mirror a Sol -> Opus continuation
// (root thr_examplera on Codex, continuation thr_examplenx on Claude Code).
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  assembleConversation,
  followedThread,
  historyTimeline,
  modelAt,
  modelSwitches,
  parseNativeClaim,
  type Conversation,
} from "../conversation";
import { emptyState, reduceEvents, restoreState, serialiseState, type RawEvent } from "../model";
import plugin, { modelLabel } from "../server";

const ROOT = "thr_examplera";
const NEXT = "thr_examplenx";
const SIDE = "thr_examplesd"; // a hidden side chat with no skin claim
const T0 = 1793373752349;
const SWITCH_AT = 1793398591054;

const turn = (seq: number, at: number, model: string, text = "Please carry on"): RawEvent => ({
  seq,
  type: "client/turn/requested",
  createdAt: at,
  data: { initiator: "user", input: [{ type: "text", text }], execution: { model, reasoningLevel: "high" } },
});
const delegation = (seq: number, at: number, id: string, label: string, done = false): RawEvent => ({
  seq,
  type: done ? "item/completed" : "item/started",
  createdAt: at,
  data: { item: { type: "delegation", id, label, presentation: { detail: "general-purpose agent · model opus" } }, ...(done ? {} : {}) },
});

describe("reading the skin's grouping", () => {
  it("reads a continuation claim and ignores other metadata", () => {
    expect(parseNativeClaim({ nativeConversation: { rootThreadId: ROOT, sourceThreadId: ROOT, kind: "continuation" } })).toEqual({ rootThreadId: ROOT, sourceThreadId: ROOT, kind: "continuation" });
    expect(parseNativeClaim({ nativeConversation: { rootThreadId: ROOT, sourceThreadId: NEXT, kind: "parallel" } })?.kind).toBe("parallel");
    expect(parseNativeClaim({})).toBeNull();
    expect(parseNativeClaim(null)).toBeNull();
    expect(parseNativeClaim({ nativeConversation: { rootThreadId: "", kind: "continuation" } })).toBeNull();
    expect(parseNativeClaim({ nativeConversation: { rootThreadId: ROOT, kind: "something-else" } })).toBeNull();
  });

  it("assembles root first, then members by start time, and drops unrelated threads", () => {
    const c = assembleConversation({ id: ROOT, createdAt: T0, status: "idle" }, [
      { id: SIDE, createdAt: T0 + 5, status: "idle", claim: null },
      { id: "thr_other", createdAt: T0 + 6, status: "idle", claim: { rootThreadId: "thr_elsewhere", sourceThreadId: null, kind: "continuation" } },
      { id: NEXT, createdAt: SWITCH_AT, status: "idle", claim: { rootThreadId: ROOT, sourceThreadId: ROOT, kind: "continuation" } },
    ]);
    expect(c?.members.map((m) => [m.threadId, m.kind])).toEqual([[ROOT, "root"], [NEXT, "continuation"]]);
    expect(assembleConversation({ id: ROOT, createdAt: T0, status: "idle" }, [{ id: SIDE, createdAt: T0, status: "idle", claim: null }])).toBeNull();
  });
});

describe("which session the live view follows", () => {
  const conv = (statuses: Record<string, string>): Conversation => ({
    rootThreadId: ROOT,
    members: [
      { threadId: ROOT, kind: "root", sourceThreadId: null, createdAt: T0, status: statuses[ROOT] ?? "idle" },
      { threadId: NEXT, kind: "continuation", sourceThreadId: ROOT, createdAt: SWITCH_AT, status: statuses[NEXT] ?? "idle" },
      { threadId: "thr_par", kind: "parallel", sourceThreadId: NEXT, createdAt: SWITCH_AT + 10, status: statuses.thr_par ?? "idle" },
    ],
  });
  it("follows the newest continuation from the root when nothing is working", () => {
    expect(followedThread(ROOT, conv({}))).toBe(NEXT);
  });
  it("follows the session that is working", () => {
    expect(followedThread(ROOT, conv({ [ROOT]: "active" }))).toBe(ROOT);
  });
  it("never follows a parallel session, and keeps a member route on that member", () => {
    expect(followedThread(ROOT, conv({ thr_par: "active" }))).toBe(NEXT);
    expect(followedThread(NEXT, conv({ [ROOT]: "active" }))).toBe(NEXT);
    expect(followedThread(ROOT, null)).toBe(ROOT);
  });
});

describe("model of each turn", () => {
  it("records execution.model from every turn and survives the history cache", () => {
    const s = reduceEvents(emptyState(), [turn(1, T0, "gpt-6.1-sol"), turn(5, T0 + 100, "gpt-6.1-sol"), { seq: 6, type: "client/turn/requested", createdAt: T0 + 200, data: { initiator: "user", input: [] } }]);
    expect(s.turns).toEqual([{ seq: 1, at: T0, model: "gpt-6.1-sol" }, { seq: 5, at: T0 + 100, model: "gpt-6.1-sol" }]);
    const back = restoreState(JSON.parse(JSON.stringify(serialiseState(s))));
    expect(back?.turns).toEqual(s.turns);
    // A cache written before turns were kept is rebuilt from the event log.
    expect(restoreState({ ...serialiseState(s), version: 3 } as never)).toBeNull();
  });
  it("finds the model in force at a batch", () => {
    const turns = [{ seq: 1, at: 1, model: "a" }, { seq: 10, at: 2, model: "b" }];
    expect(modelAt(turns, 1)).toBe("a");
    expect(modelAt(turns, 9)).toBe("a");
    expect(modelAt(turns, 10)).toBe("b");
    expect(modelAt([], 3)).toBe("");
  });
  it("labels Codex and Claude models", () => {
    expect(modelLabel("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelLabel("gpt-6-sol")).toBe("GPT-6 Sol");
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
  });
});

describe("model-switch markers", () => {
  const root = [{ seq: 1, at: T0, model: "gpt-6.1-sol" }, { seq: 37214, at: 1793397415507, model: "gpt-6.1-sol" }];
  const next = [{ seq: 1, at: SWITCH_AT, model: "claude-opus-5-5" }, { seq: 67, at: 1793398622843, model: "claude-opus-5-5" }];

  it("marks Sol to Opus at the continuation's first turn", () => {
    const s = modelSwitches([{ threadId: ROOT, kind: "root", turns: root }, { threadId: NEXT, kind: "continuation", turns: next }], modelLabel);
    expect(s).toEqual([{ at: SWITCH_AT, fromModel: "GPT-6.1 Sol", toModel: "Opus 5.5", fromThreadId: ROOT, toThreadId: NEXT, kind: "continuation" }]);
  });

  it("marks a switch back, a change inside one session, and ignores parallel sessions", () => {
    const s = modelSwitches(
      [
        { threadId: ROOT, kind: "root", turns: [...root, { seq: 40000, at: SWITCH_AT + 60_000, model: "gpt-6.1-sol" }, { seq: 40100, at: SWITCH_AT + 90_000, model: "gpt-6-sol" }] },
        { threadId: NEXT, kind: "continuation", turns: next },
        { threadId: "thr_par", kind: "parallel", turns: [{ seq: 1, at: SWITCH_AT + 1, model: "claude-sonnet-5-5" }] },
      ],
      modelLabel,
    );
    expect(s.map((x) => `${x.fromModel} > ${x.toModel} (${x.kind})`)).toEqual([
      "GPT-6.1 Sol > Opus 5.5 (continuation)",
      "Opus 5.5 > GPT-6.1 Sol (continuation)",
      "GPT-6.1 Sol > GPT-6 Sol (same-session)",
    ]);
  });

  it("interleaves switches with agent runs, newest first", () => {
    const sw = modelSwitches([{ threadId: ROOT, kind: "root", turns: root }, { threadId: NEXT, kind: "continuation", turns: next }], modelLabel);
    const items = historyTimeline([{ startedAt: SWITCH_AT + 5_000, key: "after" }, { startedAt: T0 + 5_000, key: "before" }], sw);
    expect(items.map((i) => (i.type === "batch" ? i.batch.key : "switch"))).toEqual(["after", "switch", "before"]);
  });
});

describe("Helper Desk server across a continuation", () => {
  function host(rootStatus = "idle", nextStatus = "idle") {
    const events: Record<string, RawEvent[]> = {
      [ROOT]: [turn(1, T0, "gpt-6.1-sol", "Extract features from the transcript"), delegation(2, T0 + 10, "dlg_root", "Read transcript"), delegation(3, T0 + 900, "dlg_root", "Read transcript", true)],
      [NEXT]: [turn(1, SWITCH_AT, "claude-opus-5-5", "Fix thread creation timing"), delegation(2, SWITCH_AT + 10, "dlg_next", "Audit timing"), delegation(3, SWITCH_AT + 800, "dlg_next", "Audit timing", true)],
      [SIDE]: [],
    };
    const thread = (id: string, createdAt: number, status: string, visibility: "visible" | "hidden") => ({ id, projectId: "proj_1", providerId: id === ROOT ? "codex" : "claude-code", createdAt, status, visibility, deletedAt: null });
    const rows = [thread(ROOT, T0, rootStatus, "visible"), thread(NEXT, SWITCH_AT, nextStatus, "hidden"), thread(SIDE, T0 + 5, "idle", "hidden")];
    const meta: Record<string, object> = { [NEXT]: { nativeConversation: { rootThreadId: ROOT, sourceThreadId: ROOT, kind: "continuation" } }, [SIDE]: {} };
    return createFakePluginHost({
      pluginId: "helper-desk",
      sdk: {
        threads: {
          get: (async ({ threadId }: { threadId: string }) => rows.find((r) => r.id === threadId)) as never,
          list: (async () => rows) as never,
          getPluginMetadata: (async ({ threadId, pluginId }: { threadId: string; pluginId: string }) => (pluginId === "navaigate-skin" ? meta[threadId] ?? {} : {})) as never,
          experimental_listPluginMetadata: (async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, metadata: meta[threadId] ?? {} })) })) as never,
          events: { list: (async ({ threadId, afterSeq }: { threadId: string; afterSeq: string }) => (events[threadId] ?? []).filter((e) => e.seq > Number(afterSeq))) as never },
          timeline: (async () => ({})) as never,
          interactions: { list: (async () => []) as never },
        },
        status: { get: (async () => ({})) as never },
      },
    });
  }

  it("shows both sessions' runs in History with each lead model and the switch", async () => {
    const { bb, harness } = host();
    plugin(bb);
    const h = (await harness.callRpc("history", { threadId: ROOT })) as { lead: { model: string }; batches: { threadId?: string; model?: string; request: string }[]; switches: { fromModel: string; toModel: string; at: number }[]; members: number };
    expect(h.members).toBe(2);
    expect(h.lead.model).toBe("Opus 5.5");
    expect(h.batches.map((b) => [b.threadId, b.model, b.request])).toEqual([
      [NEXT, "Opus 5.5", "Fix thread creation timing"],
      [ROOT, "GPT-6.1 Sol", "Extract features from the transcript"],
    ]);
    expect(h.switches).toEqual([expect.objectContaining({ fromModel: "GPT-6.1 Sol", toModel: "Opus 5.5", at: SWITCH_AT, kind: "continuation" })]);
    // The same view from the continuation's own route.
    const fromMember = (await harness.callRpc("history", { threadId: NEXT })) as { batches: unknown[]; switches: unknown[] };
    expect(fromMember.batches).toHaveLength(2);
    expect(fromMember.switches).toHaveLength(1);
  });

  it("follows the continuation in the live view opened on the root", async () => {
    const { bb, harness } = host();
    plugin(bb);
    const snap = (await harness.callRpc("snapshot", { threadId: ROOT })) as { threadId: string; lead: { model: string }; agents: { name: string }[]; conversation: { followedThreadId: string; members: number; switches: { toModel: string }[] } };
    expect(snap.threadId).toBe(ROOT);
    expect(snap.lead.model).toBe("Opus 5.5");
    expect(snap.agents.map((a) => a.name)).toEqual(["Audit timing"]);
    expect(snap.conversation).toMatchObject({ followedThreadId: NEXT, members: 2 });
    expect(snap.conversation.switches.at(-1)?.toModel).toBe("Opus 5.5");
    // The contract: members are found among the project's hidden top-level threads.
    expect(harness.sdk.callsTo("threads.list")[0][0]).toMatchObject({ projectId: "proj_1", includeHidden: true, hasParent: false });
    expect(harness.sdk.callsTo("threads.experimental_listPluginMetadata")[0][0]).toMatchObject({ pluginId: "navaigate-skin" });
  });

  it("picks up a continuation the moment it starts, while the root's panel is open", async () => {
    const { bb, harness } = host();
    // Before the switch: no member carries a claim yet.
    const claim = { nativeConversation: { rootThreadId: ROOT, sourceThreadId: ROOT, kind: "continuation" } };
    let switched = false;
    harness.sdk.stub("threads.getPluginMetadata", (async ({ threadId }: { threadId: string }) => (switched && threadId === NEXT ? claim : {})) as never);
    harness.sdk.stub("threads.experimental_listPluginMetadata", (async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, metadata: switched && threadId === NEXT ? claim : {} })) })) as never);
    plugin(bb);
    const before = (await harness.callRpc("snapshot", { threadId: ROOT })) as { lead: { model: string }; conversation?: unknown };
    expect(before.lead.model).toBe("GPT-6.1 Sol");
    expect(before.conversation ?? null).toBeNull();
    switched = true;
    await harness.emitThreadEvent("experimental_thread.events", { thread: { id: NEXT, projectId: "proj_1", visibility: "hidden", parentThreadId: null } as never, sequence: 1 });
    const targets = harness.realtimeSignals.filter((s) => s.channel === "desk-changed").map((s) => (s.payload as { threadId: string }).threadId);
    expect(targets).toEqual([ROOT]);
    const after = (await harness.callRpc("snapshot", { threadId: ROOT })) as { lead: { model: string }; conversation: { followedThreadId: string } };
    expect(after.lead.model).toBe("Opus 5.5");
    expect(after.conversation.followedThreadId).toBe(NEXT);
  });

  it("refreshes the root's panel when the continuation moves", async () => {
    const { bb, harness } = host();
    plugin(bb);
    await harness.callRpc("snapshot", { threadId: ROOT });
    await harness.emitThreadEvent("experimental_thread.events", { thread: { id: NEXT } as never, sequence: 4 });
    const targets = harness.realtimeSignals.filter((s) => s.channel === "desk-changed").map((s) => (s.payload as { threadId: string }).threadId);
    expect(targets).toEqual([NEXT, ROOT]);
  });

  it("leaves an ordinary chat as it was", async () => {
    const { bb, harness } = host();
    plugin(bb);
    const snap = (await harness.callRpc("snapshot", { threadId: SIDE })) as { conversation?: unknown };
    expect(snap.conversation ?? null).toBeNull();
  });
});

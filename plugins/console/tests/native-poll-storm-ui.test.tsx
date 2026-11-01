// @vitest-environment jsdom
import React from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { z } from "zod";
import type { nativeSessionStateSchema } from "../server-native-sessions";
import { resetRpcFlight } from "../src/rpc-flight";
import { useAttention } from "../src/attention";
import { NativeConversationPanel } from "../src/native-sessions";
import { useFleetBoard } from "../src/machine-row";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

type Session = z.infer<typeof nativeSessionStateSchema>;
const CROWD = 50;

function session(root: string, active = root): Session {
  return {
    rootThreadId: root, title: `${root} title`, projectId: "proj_test", activeThreadId: active,
    version: 1, pending: null, warning: null,
    members: [root].map((id) => ({
      id, sourceThreadId: null, kind: "root", providerId: "codex", environmentId: "env_shared", model: `${id}-model`, reasoningLevel: "high",
      serviceTier: "default", status: "idle", title: `${id} title`, createdAt: 1,
    })),
  };
}
const row = { threadId: "t", title: "Review client output", hostId: "m1", environmentId: null, status: "reviewable" as const, question: null, updatedAt: 10, pinned: false, wakeAt: null };

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  resetRpcFlight();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
  vi.restoreAllMocks();
});

function AttentionProbe() {
  useAttention(true);
  return null;
}

describe("attention polling storm", () => {
  it("answers 50 mounted consumers with one fleet inbox call and one state call", async () => {
    let inbox = 0;
    let state = 0;
    renderSlot({ component: () => <>{Array.from({ length: CROWD }, (_, index) => <AttentionProbe key={index} />)}</> }, {}, {
      rpc: {
        attention_state: () => { state++; return { records: [], foldWorking: false }; },
        attention_fleet_inbox: () => { inbox++; return { rows: [row], truncated: false }; },
      },
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(inbox).toBe(1);
    expect(state).toBe(1);
  });

  it("does not poll while the document is hidden and reads once when it returns", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let inbox = 0;
    renderSlot({ component: AttentionProbe }, {}, {
      rpc: { attention_state: () => ({ records: [], foldWorking: false }), attention_fleet_inbox: () => { inbox++; return { rows: [], truncated: false }; } },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(inbox).toBe(1);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(inbox).toBe(1);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10);
    expect(inbox).toBe(2);
  });

  it("backs off a failing owner read instead of asking on every poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let inbox = 0;
    let failing = false;
    renderSlot({ component: AttentionProbe }, {}, {
      rpc: {
        attention_state: () => ({ records: [], foldWorking: false }),
        attention_fleet_inbox: () => { inbox++; if (failing) throw Object.assign(new Error("Failed to fetch"), { code: "transport_error" }); return { rows: [row], truncated: false }; },
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    failing = true;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(inbox).toBeGreaterThan(2);
    expect(inbox).toBeLessThanOrEqual(10);
  });
});

describe("realtime while hidden", () => {
  it("holds 50 attention events while the document is hidden and reads once on return", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let inbox = 0;
    const view = renderSlot({ component: AttentionProbe }, {}, {
      rpc: { attention_state: () => ({ records: [], foldWorking: false }), attention_fleet_inbox: () => { inbox++; return { rows: [], truncated: false }; } },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(inbox).toBe(1);
    setVisibility("hidden");
    await act(async () => {
      await Promise.all(Array.from({ length: CROWD }, () => view.behavior.emitRealtime("attention", {})));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(inbox).toBe(1);
    setVisibility("visible");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(inbox).toBeLessThanOrEqual(3);
    expect(inbox).toBeGreaterThan(1);
  });
});

describe("native session state polling storm", () => {
  it("reads one thread once for 50 mounted panels", async () => {
    let reads = 0;
    renderSlot({ component: () => <>{Array.from({ length: CROWD }, (_, index) => <NativeConversationPanel key={index} threadId="thr_root" />)}</> }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: () => { reads++; return session("thr_root"); } },
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(reads).toBe(1);
  });

  it("coalesces a burst of 50 realtime events into at most one follow-up read", async () => {
    let reads = 0;
    const view = renderSlot({ component: () => <NativeConversationPanel threadId="thr_root" /> }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: async () => { reads++; await new Promise((resolve) => setTimeout(resolve, 20)); return session("thr_root"); } },
    });
    await waitFor(() => expect(reads).toBe(1));
    await act(async () => {
      await Promise.all(Array.from({ length: CROWD }, () => view.behavior.emitRealtime("native-sessions", {})));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(reads).toBeLessThanOrEqual(3);
  });

  it("keeps the 400ms spacing between reads when the burst arrives with default pacing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetRpcFlight();
    const starts: number[] = [];
    const view = renderSlot({ component: () => <NativeConversationPanel threadId="thr_root" /> }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: async () => { starts.push(Date.now()); await new Promise((resolve) => setTimeout(resolve, 10)); return session("thr_root"); } },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(starts.length).toBe(1);
    await act(async () => {
      await Promise.all(Array.from({ length: CROWD }, () => view.behavior.emitRealtime("native-sessions", {})));
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(starts.length).toBeGreaterThan(1);
    expect(starts.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(400);
  });
});

function BoardProbe() {
  useFleetBoard();
  return null;
}

describe("machine row polling storm", () => {
  function BoardView() {
    const board = useFleetBoard();
    return <p data-testid="board">{board === null ? "loading" : board.available ? `columns:${board.board?.columns.length}` : `unavailable:${board.error}`}</p>;
  }
  const goodBoard = { available: true as const, board: { serverId: "sky", serverKey: "laptop", columns: [{ key: "laptop", label: "laptop", serverId: "sky", online: true, lastSeenAt: 1, threads: [] }] }, error: null };

  it("keeps showing the last good board through a failed refresh, then gives up after three minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failing = false;
    renderSlot({ component: BoardView }, {}, {
      rpc: { fleet_board: () => failing ? { available: false, board: null, error: "Fleet is busy" } : goodBoard },
    });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await advance(10);
    expect(document.body.textContent).toBe("columns:1");
    failing = true;
    await advance(60_000);
    expect(document.body.textContent).toBe("columns:1");
    await advance(240_000);
    expect(document.body.textContent).toContain("unavailable:Fleet is busy");
  });

  it("keeps the board current when Fleet answers slowly, and asks again at once on focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let boards = 0;
    renderSlot({ component: BoardView }, {}, {
      rpc: { fleet_board: async () => { boards++; await new Promise((resolve) => setTimeout(resolve, 5_000)); return goodBoard; } },
    });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await advance(5_100);
    expect(boards).toBe(1);
    await advance(75_000);
    expect(boards).toBeGreaterThanOrEqual(5);
    const before = boards;
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(10); });
    expect(boards).toBe(before + 1);
  });

  it("shows the recovered board on the first poll after a run of failures", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failing = false;
    let recovered = false;
    const twoColumns = { ...goodBoard, board: { ...goodBoard.board, columns: [...goodBoard.board.columns, { ...goodBoard.board.columns[0], key: "studio", label: "studio" }] } };
    renderSlot({ component: BoardView }, {}, {
      rpc: { fleet_board: () => failing ? { available: false, board: null, error: "Fleet is busy" } : recovered ? twoColumns : goodBoard },
    });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await advance(10);
    failing = true;
    await advance(62_000);
    failing = false;
    recovered = true;
    await advance(18_000);
    expect(document.body.textContent).toBe("columns:2");
  });

  it("marks a kept board stale once it is more than 30 seconds old and clears it on recovery", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failing = false;
    function StaleView() {
      const board = useFleetBoard();
      return <p>{board === null ? "loading" : board.stale ? "stale" : "current"}</p>;
    }
    renderSlot({ component: StaleView }, {}, {
      rpc: { fleet_board: () => failing ? { available: false, board: null, error: "Fleet is busy" } : goodBoard },
    });
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    await advance(10);
    expect(document.body.textContent).toBe("current");
    failing = true;
    await advance(20_000);
    expect(document.body.textContent).toBe("current");
    await advance(30_000);
    expect(document.body.textContent).toBe("stale");
    failing = false;
    await advance(16_000);
    expect(document.body.textContent).toBe("current");
  });

  it("asks for the fleet board once for 50 mounted rows and pauses while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let boards = 0;
    renderSlot({ component: () => <>{Array.from({ length: CROWD }, (_, index) => <BoardProbe key={index} />)}</> }, {}, {
      rpc: { fleet_board: () => { boards++; return { available: false, board: null, error: "offline" }; } },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(boards).toBe(1);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(boards).toBe(1);
  });
});

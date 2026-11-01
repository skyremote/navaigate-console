// @vitest-environment jsdom
// The native conversation index is the heaviest read the plugin makes. Home, the Machines
// card, the control room and the rail all need it, and together they must cost one read
// and one timer, however many of them are mounted.
import React from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import fixture from "./fixtures/running-live-2026-11-01.json";
import { HomePage } from "../src/home";
import { MachinesCard } from "../src/home-panels";
import { ControlRoom } from "../src/control-room";
import { Rail } from "../src/rail";
import { INDEX_POLL_BUSY_MS, INDEX_POLL_UNKNOWN_MS } from "../src/native-session-rail";
import { resetRpcFlight } from "../src/rpc-flight";

// Every interval the index could be polled on goes through useVisiblePoll or startVisiblePoll; count the 10 s and 30 s ones.
const polls = vi.hoisted(() => {
  const state = { active: new Map<number, number>(), created: 0, peak: 0, next: 0, reset() { state.active.clear(); state.created = 0; state.peak = 0; } };
  return state;
});
vi.mock("../src/visible-poll", async (original) => {
  const mod = await original<typeof import("../src/visible-poll")>();
  const React = await import("react");
  const track = (ms: number) => {
    if (ms !== 10_000 && ms !== 30_000) return () => {};
    const id = ++polls.next;
    polls.active.set(id, ms);
    polls.created++;
    polls.peak = Math.max(polls.peak, polls.active.size);
    return () => { polls.active.delete(id); };
  };
  return {
    ...mod,
    startVisiblePoll: (run: () => void, ms: number) => { const untrack = track(ms); const stop = mod.startVisiblePoll(run, ms); return () => { untrack(); stop(); }; },
    useVisiblePoll: (run: () => void, ms: number | null) => {
      React.useEffect(() => (ms === null ? undefined : track(ms)), [ms]);
      return mod.useVisiblePoll(run, ms);
    },
  };
});
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(() => 1), error: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn(), warning: vi.fn() }) }));

const NOW = fixture.now;
const copy = <T,>(v: T): T => structuredClone(v);
const thread = (t: { id: string; title: string; updatedAt: number; providerId: string }) => ({
  id: t.id, projectId: "proj_01", title: t.title, titleFallback: null, displayTitle: t.title, parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
  sectionId: null, originKind: null, originPluginId: null, providerId: t.providerId, status: "idle", runtimeStatus: "idle", queuedWork: "none",
  hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 }, indicator: "none", indicatorLabel: null,
  isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/proj_01/threads/${t.id}`,
  isHidden: false, environment: null, host: null, createdAt: 1, updatedAt: t.updatedAt, lastActivityAt: 1,
}) as unknown as PluginSidebarThread;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (n: string) => items.get(n) ?? null, setItem: (n: string, v: string) => { items.set(n, String(v)); }, removeItem: (n: string) => { items.delete(n); }, clear: () => items.clear(), key: (i: number) => [...items.keys()][i] ?? null, get length() { return items.size; } });
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  resetRpcFlight();
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("one index poll for the whole app", () => {
  it("mounting Home, the Rail, the Machines card and the control room starts one timer and makes one read", async () => {
    polls.reset();
    let reads = 0;
    const rpc = {
      home_accounts: () => ({ accounts: [] }), usage_trend: () => ({ now: NOW, sampledFrom: null, accounts: [] }), home_brief: () => ({ headline: null, date: null }),
      home_agenda: () => ({ configured: true, error: null, reconnect: [], events: [] }), ask_log: () => ({ recent: [], jevDecisions: 0, overrides: 0 }),
      attention_state: () => ({ records: [], foldWorking: false }), attention_fleet_inbox: () => ({ rows: [], truncated: false, notices: [] }), thread_accounts: () => ({ threads: {} }),
      fleet_board: () => ({ available: true, board: copy(fixture.board), error: null }), native_session_index: () => { reads++; return copy(fixture.index); },
      state_get: () => ({ tags: [], assign: {}, later: {}, order: [], collapsed: [], groups: [], within: {}, colors: {}, subOpen: [] }),
    };
    const callRpc = async ({ method }: { method: string }) => {
      if (method === "list") return { folders: [], roots: [], bindings: {}, places: {} };
      if (method === "prefs_get") return { prefs: {}, items: {}, stored: true };
      throw new Error(`no ${method}`);
    };
    const threads = fixture.sidebar.map(thread);
    const projects = [{ id: "proj_01", name: "Project", isPersonal: false, href: "/p", settingsHref: "/s", experimental_icon: { imageUrl: null, monogram: "P", hue: 260 } }];
    const view = renderSlot({
      component: () => (
        <>
          <HomePage />
          <MachinesCard threads={threads} />
          <ControlRoom {...({} as never)} />
          <Rail activeThreadId="x" activeProjectId="proj_01" onNavigate={() => {}} />
        </>
      ),
    }, {}, { rpc: rpc as never, sidebarThreads: { status: "ready", threads, projects: projects as never, sections: [] } as never, context: { projectId: "proj_01", threadId: "x" }, sdk: { plugins: { callRpc } } as never });

    await waitFor(() => expect(reads).toBeGreaterThan(0));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(reads).toBe(1);
    // A running member makes the poll 30 s; before the first answer it was 10 s. Never both at once, never two of either.
    expect(polls.peak).toBe(1);
    expect([...polls.active.values()]).toEqual([INDEX_POLL_BUSY_MS]);
    expect(polls.created).toBe(2);
    const before = reads;
    await act(async () => { await vi.advanceTimersByTimeAsync(INDEX_POLL_BUSY_MS * 4); });
    expect(reads - before).toBeLessThanOrEqual(4);
    expect(reads - before).toBeGreaterThanOrEqual(3);
    expect(polls.peak).toBe(1);
    view.unmount();
    expect(polls.active.size).toBe(0);
  });
});

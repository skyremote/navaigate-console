// @vitest-environment jsdom
// How often the rail re-renders when its background reads come back unchanged.
// Every poll answers with a new object (as an RPC does); nothing on screen
// differs, so no poll should cost the rail a render.
import React, { Profiler } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Rail } from "../src/rail";
import { resetRpcFlight } from "../src/rpc-flight";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(() => 1), error: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn() }) }));
// ensureRailLook() runs once per Rail render, so it counts them.
const railRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock("../src/rail-look", async (original) => {
  const mod = await original<typeof import("../src/rail-look")>();
  return { ...mod, ensureRailLook: () => { railRenders.n++; mod.ensureRailLook(); } };
});
const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: 1_800_000_000_000 });
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (n: string) => items.get(n) ?? null, setItem: (n: string, v: string) => { items.set(n, String(v)); }, removeItem: (n: string) => { items.delete(n); }, clear: () => items.clear(), key: (i: number) => [...items.keys()][i] ?? null, get length() { return items.size; } });
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  resetRpcFlight();
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const thread = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, projectId: "p1", title, titleFallback: null, displayTitle: title, parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
  sectionId: null, originKind: null, originPluginId: null, providerId: "claude-code", status: "idle", runtimeStatus: "idle", queuedWork: "none",
  hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", indicatorLabel: null,
  isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/p1/threads/${id}`,
  isHidden: false, environment: null, host: null, createdAt: 1, updatedAt: Date.now() - 17 * HOUR, lastActivityAt: 1, ...over,
}) as unknown as PluginSidebarThread;
const live = (id: string, over: Record<string, unknown> = {}) => ({ id, projectId: "p1", providerId: "claude-code", status: "idle", isHidden: true, isArchived: false, hasPendingInteraction: false, model: null, reasoningLevel: null, ...over });

describe("rail render cost", () => {
  it("does not re-render when the background reads return what it already shows", async () => {
    const copy = <T,>(v: T): T => structuredClone(v);
    const conversation = { rootThreadId: "root", activeThreadId: "run", memberIds: ["root", "run"], members: [live("root", { isHidden: false }), live("run", { status: "active", model: "claude-opus-5-5", reasoningLevel: "high" })] };
    const board = { serverId: "srv-laptop", serverKey: "laptop", columns: [{ key: "laptop", label: "laptop", serverId: "srv-laptop", online: true, lastSeenAt: 1, threads: [] }, { key: "studio", label: "studio", serverId: "m1", online: true, lastSeenAt: 1, mirror: true, threads: [] }] };
    const callRpc = async ({ method }: { method: string }) => {
      if (method === "list") return copy({ folders: [{ id: "f1", projectId: "p1", hostId: "h", parentId: null, name: "REA", path: "/p1/REA" }], roots: [{ id: "root:p1", projectId: "p1", hostId: "h", parentId: null, name: "Away", path: "/p1" }], bindings: {}, places: { root: "f1" } });
      if (method === "prefs_get") return { prefs: {}, items: {}, stored: true };
      throw new Error(`no ${method}`);
    };
    const reads = { index: 0 };
    let commits = 0;
    renderSlot(
      { component: () => <Profiler id="rail" onRender={() => { commits++; }}><Rail activeThreadId="x" activeProjectId="p1" onNavigate={() => {}} /></Profiler> },
      {},
      {
        sidebarThreads: { status: "ready", threads: [thread("root", "Extract features from video transcript"), thread("other", "Another chat")], projects: [{ id: "p1", name: "Shared (away)", isPersonal: false, href: "/p1", settingsHref: "/s/p1", experimental_icon: { imageUrl: null, monogram: "NA", hue: 260 } }] as never, sections: [] },
        rpc: {
          attention_state: () => copy({ records: [], foldWorking: false }), attention_fleet_inbox: () => copy({ rows: [], truncated: false, notices: [] }),
          thread_accounts: () => copy({ threads: { other: { accountId: "a", label: "dw", email: null, harness: "claude" } } }), fleet_board: () => copy({ available: true, board, error: null }),
          native_session_index: () => { reads.index++; return copy({ conversations: [conversation] }); },
          state_get: () => copy({ tags: [], assign: {}, later: {}, order: [], collapsed: [], groups: [], within: {}, colors: {}, subOpen: [] }),
        } as never,
        context: { projectId: "p1", threadId: "x" },
        sdk: { plugins: { callRpc } } as never,
      },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await waitFor(() => expect(document.querySelector('[data-sidebar-thread-id="root"] svg.nav-spin')).toBeTruthy());
    const settled = commits;
    const railBefore = railRenders.n;
    const readsBefore = reads.index;
    for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    const extra = railRenders.n - railBefore;
    const extraCommits = commits - settled;
    console.log(`RENDER-COST commits after settle: ${settled}; Rail renders over 120 s of unchanged polls: ${extra}; profiler commits (incl. the machine row's own 5 s clock): ${extraCommits}; index reads: ${reads.index - readsBefore}`);
    expect(reads.index - readsBefore).toBeGreaterThan(0);
    // The only change allowed is the machine row's own clock tick (every 5 s, it does not touch the rail).
    expect(extra).toBe(0);
  });
});

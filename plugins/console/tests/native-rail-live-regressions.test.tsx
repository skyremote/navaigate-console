// @vitest-environment jsdom
// The 1 Nov live rail: a grouped conversation row that does not run while its
// hidden member does, a project heading that will not unfold, and machine-view
// rows that do not open. Each case is the live shape, driven through the Rail.
import React from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Rail } from "../src/rail";
import { resetRpcFlight } from "../src/rpc-flight";
import type { FleetBoard } from "../src/machines";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(() => 1), error: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn() }) }));
const HOUR = 3_600_000;

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (n: string) => items.get(n) ?? null, setItem: (n: string, v: string) => { items.set(n, String(v)); }, removeItem: (n: string) => { items.delete(n); }, clear: () => items.clear(), key: (i: number) => [...items.keys()][i] ?? null, get length() { return items.size; } });
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  resetRpcFlight();
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function thread(id: string, title: string, projectId = "p1", over: Record<string, unknown> = {}): PluginSidebarThread {
  return {
    id, projectId, title, titleFallback: null, displayTitle: title, parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
    sectionId: null, originKind: null, originPluginId: null, providerId: "claude-code", status: "idle", runtimeStatus: "idle", queuedWork: "none",
    hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", indicatorLabel: null,
    isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/${projectId}/threads/${id}`,
    isHidden: false, environment: null, host: null, createdAt: 1, updatedAt: Date.now() - 17 * HOUR, lastActivityAt: 1,
    ...over,
  } as unknown as PluginSidebarThread;
}
const live = (id: string, over: Record<string, unknown> = {}) => ({ id, projectId: "p1", providerId: "claude-code", status: "idle", isHidden: true, isArchived: false, hasPendingInteraction: false, model: null, reasoningLevel: null, ...over });
const project = { id: "p1", name: "Shared (away)", isPersonal: false, href: "/p1", settingsHref: "/s/p1", experimental_icon: { imageUrl: null, monogram: "NA", hue: 260 } };
const EMPTY_STATE = { tags: [], assign: {}, later: {}, order: [], collapsed: [], groups: [], within: {}, colors: {}, subOpen: [] };

// The live conversation: the visible root plus three hidden members, one failed, the active one running.
const conversation = (active: Record<string, unknown> = { status: "active" }) => ({
  rootThreadId: "thr_root", activeThreadId: "thr_active", memberIds: ["thr_root", "thr_idle", "thr_failed", "thr_active"],
  members: [live("thr_root", { isHidden: false }), live("thr_idle"), live("thr_failed", { status: "error" }), live("thr_active", { model: "claude-opus-5-5", reasoningLevel: "high", ...active })],
});

type Mount = { index?: () => unknown; rpc?: Record<string, (input: never) => unknown>; board?: FleetBoard; threads?: PluginSidebarThread[]; projects?: unknown[] };
function mount(o: Mount = {}) {
  const callRpc = async ({ method }: { method: string }) => {
    if (method === "list") return { folders: [{ id: "f1", projectId: "p1", hostId: "h", parentId: null, name: "REA", path: "/p1/REA" }], roots: [{ id: "root:p1", projectId: "p1", hostId: "h", parentId: null, name: "Away", path: "/p1" }], bindings: {}, places: { thr_root: "f1" } };
    if (method === "prefs_get") return { prefs: {}, items: {}, stored: true };
    throw new Error(`no ${method}`);
  };
  return renderSlot(
    { component: () => <Rail activeThreadId="x" activeProjectId="p1" onNavigate={() => {}} /> },
    {},
    {
      sidebarThreads: { status: "ready", threads: o.threads ?? [thread("thr_root", "Extract features from video transcript")], projects: (o.projects ?? [project]) as never, sections: [] },
      rpc: {
        attention_state: () => ({ records: [], foldWorking: false }), attention_fleet_inbox: () => ({ rows: [], truncated: false, notices: [] }),
        thread_accounts: () => ({ threads: {} }), fleet_board: () => ({ available: Boolean(o.board), board: o.board ?? null, error: null }),
        native_session_index: o.index ?? (() => ({ conversations: [conversation()] })),
        ...(o.rpc ?? {}),
      } as never,
      context: { projectId: "p1", threadId: "x" },
      sdk: { plugins: { callRpc } } as never,
    },
  );
}
const row = (id = "thr_root") => document.querySelector(`[data-sidebar-thread-id="${id}"]`) as HTMLElement | null;
const spinning = () => row()?.querySelector("svg.nav-spin") != null;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const fakeClock = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: 1_800_000_000_000 });

describe("a grouped conversation row inside a folder", () => {
  it("runs when its hidden active member is only in the index snapshot", async () => {
    mount();
    await waitFor(() => expect(row()).toBeTruthy());
    await waitFor(() => expect(spinning()).toBe(true));
  });

  it("runs after the first index read failed (no event arrives to trigger another)", async () => {
    fakeClock();
    let reads = 0;
    mount({ index: () => { if (++reads === 1) throw new Error("plugin server not ready"); return { conversations: [conversation()] }; } });
    await advance(1_000);
    expect(row()).toBeTruthy();
    expect(spinning()).toBe(false);
    await advance(30_000);
    expect(spinning()).toBe(true);
  });

  it("runs after a missed event: the index said idle, the member then became active, and nothing was published", async () => {
    fakeClock();
    let active = false;
    mount({ index: () => ({ conversations: [conversation({ status: active ? "active" : "idle" })] }) });
    await advance(1_000);
    expect(spinning()).toBe(false);
    active = true;
    await advance(75_000);
    expect(spinning()).toBe(true);
  });

  it("stops running when the member goes idle and no event arrives", async () => {
    fakeClock();
    let status = "active";
    mount({ index: () => ({ conversations: [conversation({ status })] }) });
    await advance(1_000);
    expect(spinning()).toBe(true);
    status = "idle";
    await advance(35_000);
    expect(spinning()).toBe(false);
  });
});

describe("a project heading", () => {
  it("unfolds when a stale read of the folded state lands after the click", async () => {
    let release!: () => void;
    const stale = new Promise<typeof EMPTY_STATE>((resolve) => { release = () => resolve({ ...EMPTY_STATE, collapsed: ["project:p1"] }); });
    let reads = 0;
    const view = mount({
      rpc: {
        state_get: () => (++reads === 1 ? { ...EMPTY_STATE, collapsed: ["project:p1"] } : stale),
        collapsed_set: () => ({ ...EMPTY_STATE, collapsed: [] }),
      },
    });
    const head = await waitFor(() => { const el = document.querySelector('[data-nav-part="section-head"]') as HTMLElement; expect(el).toBeTruthy(); return el; });
    await waitFor(() => expect(row()).toBeNull());
    // Another window changes something: the realtime read starts now and answers late.
    await view.behavior.emitRealtime("rail-state", {});
    fireEvent.click(head);
    await waitFor(() => expect(row()).toBeTruthy());
    await act(async () => { release(); });
    expect(row()).toBeTruthy();
  });
});

describe("machine view rows", () => {
  const board = (threadId: string): FleetBoard => ({
    serverId: "sky", serverKey: "laptop",
    columns: [
      { key: "laptop", label: "laptop", serverId: "sky", online: true, lastSeenAt: 1, threads: [{ id: threadId, title: "Extract features from video transcript", state: "idle", machine: "laptop", projectName: "Shared (away)", providerId: "claude-code", updatedAt: Date.now() - 17 * HOUR, url: null, via: "m5-desktop" }] },
      { key: "studio", label: "studio", serverId: "m1", online: true, lastSeenAt: 1, mirror: true, threads: [] },
    ],
  });
  const click = async (view: ReturnType<typeof mount>) => {
    const button = await waitFor(() => {
      const el = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Extract features from video transcript") && !b.closest("[data-sidebar-thread-id]")) as HTMLButtonElement | undefined;
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    expect(button.disabled).toBe(false);
    await act(async () => { fireEvent.click(button); });
    return view;
  };

  it("opens this Mac's own chat in the window instead of asking Fleet for a copy", async () => {
    const mirror = vi.fn(() => ({ localThreadId: "thr_copy" }));
    const view = await click(mount({ board: board("thr_root"), rpc: { fleet_mirror_open: mirror } }));
    expect(mirror).not.toHaveBeenCalled();
    expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_root" }]);
  });

  it("opens the conversation's root when the listed chat is a hidden member of a grouped conversation", async () => {
    const mirror = vi.fn(() => ({ localThreadId: "thr_copy" }));
    const view = await click(mount({ board: board("thr_active"), rpc: { fleet_mirror_open: mirror } }));
    expect(mirror).not.toHaveBeenCalled();
    expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_root" }]);
  });

  it("still asks Fleet for a copy of a chat this window does not have", async () => {
    const mirror = vi.fn(() => ({ localThreadId: "thr_copy" }));
    const withUrl = board("thr_elsewhere");
    withUrl.columns[0]!.threads[0]!.url = "https://m5/threads/thr_elsewhere";
    const view = await click(mount({ board: withUrl, rpc: { fleet_mirror_open: mirror } }));
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_copy" }]);
  });
});

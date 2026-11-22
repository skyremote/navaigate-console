// @vitest-environment jsdom
// A chat colour draws a bar down its rail row, open or not, and the row's
// right-click menu sets and clears it through thread_color_set.
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Rail } from "../src/rail";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(() => 1), error: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn() }) }));

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, String(value)); },
    removeItem: (name: string) => { items.delete(name); }, clear: () => items.clear(), key: (index: number) => [...items.keys()][index] ?? null,
    get length() { return items.size; },
  });
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function thread(id: string, title: string): PluginSidebarThread {
  return {
    id, projectId: "p1", title, titleFallback: null, displayTitle: title, parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
    sectionId: null, originKind: null, originPluginId: null, providerId: "claude-code", status: "idle", runtimeStatus: "idle", queuedWork: "none",
    hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", indicatorLabel: null,
    isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/p1/threads/${id}`,
    isHidden: false, environment: null, host: null, createdAt: NOW - 5 * HOUR, updatedAt: NOW - HOUR, lastActivityAt: NOW - HOUR,
  } as unknown as PluginSidebarThread;
}

const EMPTY = { tags: [], assign: {}, later: {}, order: [], collapsed: [], groups: [], within: {}, colors: {}, subOpen: [] };

function renderRail(threadColors: Record<string, string>) {
  let state = { ...EMPTY, threadColors };
  const sets: Array<{ threadIds: string[]; color: string | null }> = [];
  const callRpc = vi.fn(async ({ method }: { method: string }) => {
    if (method === "list") return { folders: [], roots: [], bindings: {}, places: {} };
    if (method === "prefs_get") return { prefs: {}, items: {}, stored: true };
    throw new Error(`no ${method}`);
  });
  const rpc = {
    attention_state: () => ({ records: [], foldWorking: false }),
    attention_fleet_inbox: () => ({ rows: [], truncated: false, notices: [] }),
    thread_accounts: () => ({ threads: {} }),
    fleet_board: () => ({ available: false, board: null, error: null }),
    state_get: () => state,
    thread_color_set: (input: { threadIds: string[]; color: string | null }) => {
      sets.push(input);
      const next = { ...state.threadColors };
      for (const id of input.threadIds) {
        if (input.color) next[id] = input.color;
        else delete next[id];
      }
      state = { ...state, threadColors: next };
      return state;
    },
  };
  renderSlot(
    { component: () => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} /> },
    {},
    {
      sidebarThreads: { status: "ready", threads: [thread("t1", "Open chat"), thread("t2", "Closed chat"), thread("t3", "Plain chat")], projects: [{ id: "p1", name: "Atlas", isPersonal: false, href: "/p1", settingsHref: "/s/p1" }] as never, sections: [] },
      rpc: rpc as never,
      context: { projectId: "p1", threadId: "t1" },
      sdk: { plugins: { callRpc } } as never,
    },
  );
  return { sets };
}

const rowOf = (id: string) => document.querySelector(`[data-sidebar-thread-id="${id}"]`) as HTMLElement | null;
const barOf = (id: string) => rowOf(id)?.querySelector('[data-nav-part="row-color"]') as HTMLElement | null;

describe("chat colours on the rail", () => {
  it("draws a coloured bar on coloured rows, open or not, and the plain bar only on an open uncoloured row", async () => {
    renderRail({ t1: "blue", t2: "orange" });
    await waitFor(() => expect(barOf("t2")).toBeTruthy());
    expect(barOf("t2")?.style.background).toBe("var(--nav-tc-orange)");
    expect(barOf("t1")?.style.background).toBe("var(--nav-tc-blue)");
    // The whole card takes the colour too, stronger on the open chat.
    const tintOf = (id: string) => (rowOf(id)?.querySelector('[data-nav-part="row-tint"]') as HTMLElement | null)?.getAttribute("style") ?? "";
    expect(tintOf("t2")).toContain("var(--nav-tc-orange) 18%");
    expect(tintOf("t1")).toContain("var(--nav-tc-blue) 30%");
    expect(rowOf("t3")?.querySelector('[data-nav-part="row-tint"]')).toBeNull();
    // The open row's colour replaces the plain white bar rather than stacking with it.
    expect(rowOf("t1")?.querySelector('[data-nav-part="row-bar"]')).toBeNull();
    expect(barOf("t3")).toBeNull();
    expect(rowOf("t3")?.querySelector('[data-nav-part="row-bar"]')).toBeNull();
  });

  it("ignores a stored colour name it does not know", async () => {
    renderRail({ t2: "chartreuse" });
    await waitFor(() => expect(rowOf("t2")).toBeTruthy());
    expect(barOf("t2")).toBeNull();
    expect(rowOf("t1")?.querySelector('[data-nav-part="row-bar"]')).toBeTruthy();
  });

  it("sets and clears a chat's colour from its right-click menu", async () => {
    const { sets } = renderRail({});
    const row = await waitFor(() => {
      const el = rowOf("t2");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const pick = async (label: string) => {
      fireEvent.contextMenu(row);
      const sub = (await screen.findByText("Colour")).closest('[role="menuitem"]') as HTMLElement;
      sub.focus();
      fireEvent.keyDown(sub, { key: "ArrowRight" });
      const item = await screen.findByText(label);
      await act(async () => { fireEvent.click(item); });
    };
    await pick("Green");
    await waitFor(() => expect(barOf("t2")?.style.background).toBe("var(--nav-tc-green)"));
    expect(sets.at(-1)).toEqual({ threadIds: ["t2"], color: "green" });
    await pick("No colour");
    await waitFor(() => expect(barOf("t2")).toBeNull());
    expect(sets.at(-1)).toEqual({ threadIds: ["t2"], color: null });
  });
});

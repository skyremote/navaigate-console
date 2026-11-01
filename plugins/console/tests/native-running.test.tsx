// @vitest-environment jsdom
// "What is running" from real payloads (1 Nov 2026, ids, titles, urls and paths removed).
// Sam Example saw Home say "Nothing running right now" and 0 while the rail said "1 cooking",
// the Machines card said Laptop 2 and Studio 1, and the rail's machine tiles said Laptop 3 and Studio 1.
// The chat running was one grouped conversation whose active member is hidden; the other
// "running" rows were copies from a stale snapshot, 33 hours old.
import React from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import fixture from "./fixtures/running-live-2026-11-01.json";
import { foldNativeMembers } from "../src/native-session-rail";
import { STUCK_AFTER_MS, ownIdsOf, runningView } from "../src/running";
import { chipsFor, type FleetBoard } from "../src/machines";
import { HomePage } from "../src/home";
import { Rail } from "../src/rail";
import { resetRpcFlight } from "../src/rpc-flight";
import { getProfile } from "../src/use-profile";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(() => 1), error: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn(), warning: vi.fn() }) }));

const NOW = fixture.now;
const HOUR = 3_600_000;
const board = fixture.board as unknown as FleetBoard;

const thread = (t: { id: string; title: string; updatedAt: number; providerId: string }, over: Record<string, unknown> = {}) => ({
  id: t.id, projectId: "proj_01", title: t.title, titleFallback: null, displayTitle: t.title, parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
  sectionId: null, originKind: null, originPluginId: null, providerId: t.providerId, status: "idle", runtimeStatus: "idle", queuedWork: "none",
  hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 }, indicator: "none", indicatorLabel: null,
  isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/proj_01/threads/${t.id}`,
  isHidden: false, environment: null, host: null, createdAt: 1, updatedAt: t.updatedAt, lastActivityAt: 1, ...over,
}) as unknown as PluginSidebarThread;

const physical = fixture.sidebar.map((t) => thread(t));
const conversations = fixture.index.conversations;

describe("the folded row of a grouped conversation", () => {
  it("runs and carries the newest member's time, not the root session's", () => {
    const folded = foldNativeMembers(physical, conversations);
    const root = folded.find((t) => t.id === "thr_root")!;
    expect(root.status).toBe("active");
    expect(root.updatedAt).toBe(1793561622083);
    expect(physical.find((t) => t.id === "thr_root")!.updatedAt).toBe(1793528615246);
  });

  it("puts the running conversation first in Recent, where it sat seventh", () => {
    const newestFirst = (list: readonly PluginSidebarThread[]) => [...list].sort((a, b) => b.updatedAt - a.updatedAt).map((t) => t.id);
    expect(newestFirst(physical).indexOf("thr_root")).toBe(5);
    expect(newestFirst(foldNativeMembers(physical, conversations))[0]).toBe("thr_root");
  });

  it("keeps the root's own time when it is the newest, and leaves a conversation with no hidden member alone", () => {
    const quiet = [{ ...conversations[0]!, members: [conversations[0]!.members[0]!, { ...conversations[0]!.members[1]!, status: "idle", updatedAt: 5 }] }];
    expect(foldNativeMembers(physical, quiet).find((t) => t.id === "thr_root")!.updatedAt).toBe(1793528615246);
    expect(foldNativeMembers(physical, [])).toBe(physical);
  });
});

describe("one definition of running", () => {
  const folded = foldNativeMembers(physical, conversations);
  const view = runningView({ threads: folded, ownIds: ownIdsOf(physical, conversations), serverKey: "laptop", board, now: NOW });

  it("counts the grouped conversation once, on its Mac, and not Fleet's stale copy of it", () => {
    expect(view.running.map((i) => i.id)).toEqual(["thr_root"]);
    expect(view.running[0]).toMatchObject({ machine: "laptop", source: "here" });
    expect(view.byMachine.laptop).toMatchObject({ running: 1 });
    expect(view.byMachine.studio?.running ?? 0).toBe(0);
  });

  it("lists the two 33-hour-old running rows as stuck, with their age, and does not count them", () => {
    expect(view.stuck.map((i) => i.id).sort()).toEqual(["thr_ghost_m1", "thr_ghost_m5"]);
    expect(view.stuck.every((i) => NOW - i.updatedAt > 32 * HOUR)).toBe(true);
    expect(view.byMachine.laptop).toMatchObject({ running: 1, stuck: 1 });
    expect(view.byMachine.studio).toMatchObject({ running: 0, stuck: 1 });
  });

  it("gives the machine tiles and the Machines card the same numbers", () => {
    const chips = chipsFor(board, view.byMachine, getProfile());
    expect(chips.map((c) => [c.key, c.cooking])).toEqual([["laptop", 1], ["studio", 0], ["work", 0]]);
    expect(chips.reduce((n, c) => n + c.cooking, 0)).toBe(view.running.length);
    expect(chips.find((c) => c.key === "studio")).toMatchObject({ stuck: 1 });
  });

  it("counts a conversation once however many of its members run", () => {
    const both = [{ ...conversations[0]!, members: [{ ...conversations[0]!.members[0]!, status: "active" }, conversations[0]!.members[1]!] }];
    const rows = foldNativeMembers(physical, both);
    expect(runningView({ threads: rows, ownIds: ownIdsOf(physical, both), serverKey: "laptop", board: null, now: NOW }).running).toHaveLength(1);
  });

  it("turns another Mac's row stuck after two hours with no activity, and not before", () => {
    const withRow = (age: number) => {
      const fresh = structuredClone(board);
      for (const c of fresh.columns) c.threads = [];
      fresh.columns[1]!.threads = [{ id: "thr_x", title: "X", state: "running", machine: "studio", projectName: null, providerId: "codex", updatedAt: NOW - age, url: null, via: "srv-studio" }];
      return runningView({ threads: [], serverKey: "laptop", board: fresh, now: NOW });
    };
    expect(withRow(STUCK_AFTER_MS - 1_000).running).toHaveLength(1);
    expect(withRow(STUCK_AFTER_MS + 1_000).running).toHaveLength(0);
    expect(withRow(STUCK_AFTER_MS + 1_000).stuck).toHaveLength(1);
  });

  it("never second-guesses a live status in this bb's own list, however long since updatedAt moved", () => {
    const long = thread({ id: "thr_long", title: "Long turn", updatedAt: NOW - 5 * HOUR, providerId: "claude-code" }, { status: "active" });
    const v = runningView({ threads: [long], serverKey: "laptop", board: null, now: NOW });
    expect(v.running.map((i) => i.id)).toEqual(["thr_long"]);
    expect(v.stuck).toHaveLength(0);
  });

  it("dedupes only ids it counts itself: a hidden chat with no visible root still counts from Fleet", () => {
    const hidden = thread({ id: "thr_hidden", title: "Hidden", updatedAt: NOW - 60_000, providerId: "codex" }, { isHidden: true });
    const orphan = [{ rootThreadId: "thr_gone", memberIds: ["thr_gone", "thr_hidden"] }];
    const ids = ownIdsOf([hidden, ...physical], orphan);
    expect(ids.has("thr_hidden")).toBe(false);
    expect(ids.has("thr_root")).toBe(true);
    expect(ownIdsOf(physical, conversations).has("thr_member")).toBe(true);
    const fresh = structuredClone(board);
    fresh.columns[0]!.threads.unshift({ id: "thr_hidden", title: "Hidden", state: "running", machine: "laptop", projectName: null, providerId: "codex", updatedAt: NOW - 60_000, url: null, via: "local-m5" });
    const v = runningView({ threads: physical, ownIds: ids, serverKey: "laptop", board: fresh, now: NOW });
    expect(v.running.map((i) => i.id)).toContain("thr_hidden");
  });

  it("counts a running chat that only another Mac's bb knows, on that Mac", () => {
    const fresh = structuredClone(board);
    fresh.columns[1]!.threads.unshift({ id: "thr_m1_live", title: "Live on Studio", state: "running", machine: "studio", projectName: null, providerId: "codex", updatedAt: NOW - 60_000, url: null, via: "srv-studio" });
    const v = runningView({ threads: folded, ownIds: ownIdsOf(physical, conversations), serverKey: "laptop", board: fresh, now: NOW });
    expect(v.running.map((i) => `${i.machine}:${i.id}`)).toEqual(["studio:thr_m1_live", "laptop:thr_root"]);
    expect(v.byMachine.studio).toMatchObject({ running: 1, stuck: 1 });
  });
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  const items = new Map<string, string>([["nav-skin:recent", "true"]]);
  vi.stubGlobal("localStorage", { getItem: (n: string) => items.get(n) ?? null, setItem: (n: string, v: string) => { items.set(n, String(v)); }, removeItem: (n: string) => { items.delete(n); }, clear: () => items.clear(), key: (i: number) => [...items.keys()][i] ?? null, get length() { return items.size; } });
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  resetRpcFlight();
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const copy = <T,>(v: T): T => structuredClone(v);
const boardWithResources = () => ({ ...copy(fixture.board), columns: copy(fixture.board).columns.map((c) => ({ ...c, resources: { observedAt: NOW, cpuCount: 12, cpuUtilization: 0.25, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 16 * 1024 ** 3 } })) });
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Home and the rail say the same thing", () => {
  it("Home: header, Running tile and Machines card agree, with the split per Mac and the stuck rows named", async () => {
    const rpc = {
      home_accounts: () => ({ accounts: [] }), usage_trend: () => ({ now: NOW, sampledFrom: null, accounts: [] }), home_brief: () => ({ headline: null, date: null }),
      home_agenda: () => ({ configured: true, error: null, reconnect: [], events: [] }), ask_log: () => ({ recent: [], jevDecisions: 0, overrides: 0 }),
      fleet_board: () => ({ available: true, board: boardWithResources(), error: null }), native_session_index: () => copy(fixture.index),
    };
    renderSlot({ component: HomePage }, {}, { rpc: rpc as never, sidebarThreads: { status: "ready", threads: physical, projects: [], sections: [] } as never });
    await waitFor(() => expect(text(document.querySelector('[data-nav-part="home"] header'))).toContain("1 agent working right now"));
    const header = text(document.querySelector('[data-nav-part="home"] header'));
    expect(header).not.toContain("Nothing running");
    expect(header).toContain("Laptop 1 · Studio 0 · Work 0");
    expect(header).toContain("2 stuck? (quiet 32h)");
    const tile = document.querySelector('[data-state="running"]')!;
    expect(text(tile)).toContain("Running1");
    expect(text(tile.querySelector('[data-nav-part="stat-note"]'))).toBe("Laptop 1 · Studio 0 · Work 0");
    await waitFor(() => expect(document.querySelectorAll('[data-nav-part="machines-card"] [data-nav-part="machine-tile"]')).toHaveLength(3));
    const tiles = [...document.querySelectorAll('[data-nav-part="machines-card"] [data-nav-part="machine-tile"]')].map((t) => text(t.querySelector('[data-nav-part="count"]')));
    expect(tiles).toEqual(["1 running", "idle", "offline"]);
    expect(text(document.querySelector('[data-nav-part="machines-card"]'))).toContain("1 stuck? · quiet 32h");
    expect(text(document.querySelector('[data-nav-part="machines-card"]'))).toContain("online · 1 running");
  });

  it("Rail: NOW, \"working\" and the machine tiles say 1 and 0, and the running conversation heads Recent", async () => {
    const rpc = {
      attention_state: () => ({ records: [], foldWorking: false }), attention_fleet_inbox: () => ({ rows: [], truncated: false, notices: [] }), thread_accounts: () => ({ threads: {} }),
      fleet_board: () => ({ available: true, board: boardWithResources(), error: null }), native_session_index: () => copy(fixture.index),
      state_get: () => ({ tags: [], assign: {}, later: {}, order: [], collapsed: [], groups: [], within: {}, colors: {}, subOpen: [] }),
    };
    const callRpc = async ({ method }: { method: string }) => {
      if (method === "list") return { folders: [], roots: [], bindings: {}, places: {} };
      if (method === "prefs_get") return { prefs: {}, items: {}, stored: true };
      throw new Error(`no ${method}`);
    };
    const projects = [{ id: "proj_01", name: "Project", isPersonal: false, href: "/p", settingsHref: "/s", experimental_icon: { imageUrl: null, monogram: "P", hue: 260 } }];
    renderSlot({ component: () => <Rail activeThreadId="x" activeProjectId="proj_01" onNavigate={() => {}} /> }, {}, {
      rpc: rpc as never, sidebarThreads: { status: "ready", threads: physical, projects: projects as never, sections: [] }, context: { projectId: "proj_01", threadId: "x" }, sdk: { plugins: { callRpc } } as never,
    });
    await waitFor(() => expect(text(document.querySelector('[data-nav-part="now-headline"]'))).toBe("Now · 1 cooking"));
    expect(text(document.querySelector('[data-nav-part="now-sub"]'))).toContain("1 stuck?");
    await waitFor(() => expect(document.querySelectorAll('[data-nav-part="machines"] [data-nav-part="machine-tile"]')).toHaveLength(3));
    expect(text(document.querySelector('[data-nav-part="rail"]'))).toContain("1 working");
    const counts = [...document.querySelectorAll('[data-nav-part="machines"] [data-nav-part="machine-tile"] [data-nav-part="count"]')].map((c) => text(c));
    expect(counts).toEqual(["1", "0", "0"]);
    const order = [...document.querySelectorAll("[data-sidebar-thread-id]")].map((r) => r.getAttribute("data-sidebar-thread-id"));
    expect(order[0]).toBe("thr_root");
  });
});

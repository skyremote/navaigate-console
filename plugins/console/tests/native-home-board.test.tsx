// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { CountUp, Segmented, cellDelay } from "../src/home-kit";
import { AllowanceCard, WindowCard, threadModel } from "../src/home-panels";
import { ControlRoom } from "../src/control-room";
import type { HomeAccount } from "../server-home";

const NOW = Date.now();
const gb = 1024 ** 3;
let reduce = true;

beforeEach(() => {
  reduce = true;
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce") ? reduce : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function thread(id: string, over: Record<string, unknown> = {}): PluginSidebarThread {
  return {
    id, projectId: "p1", title: id, titleFallback: null, displayTitle: id, parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
    sectionId: null, originKind: null, originPluginId: null, providerId: "claude-code", status: "idle", runtimeStatus: "idle", queuedWork: "none",
    hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", indicatorLabel: null,
    isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/p1/threads/${id}`,
    isHidden: false, environment: null, host: null, createdAt: NOW - 60_000, updatedAt: NOW - 60_000, lastActivityAt: NOW - 60_000,
    ...over,
  } as unknown as PluginSidebarThread;
}

const account = (over: Partial<HomeAccount> = {}): HomeAccount => ({
  id: "c1", harness: "claude", label: "Claude", email: "pat@example.com", plan: "Max 20x", session: 34, sessionResetsAt: null, week: 41,
  weekResetsAt: null, cycleLabel: "Week", history: [{ day: "2026-10-30", peak: 20 }, { day: "2026-10-31", peak: 41 }], advice: null, status: "ok", ...over,
});

describe("Home kit", () => {
  it("shows the final figure at once under reduced motion, and always to screen readers", () => {
    const view = render(<CountUp value={1234} />);
    expect(view.container.querySelector(".sr-only")?.textContent).toBe("1,234");
    expect(view.container.querySelector('[aria-hidden="true"]')?.textContent).toBe("1,234");
  });

  it("counts up from zero when motion is allowed and lands on the value", async () => {
    reduce = false;
    const view = render(<CountUp value={70} ms={60} />);
    const shown = () => view.container.querySelector('[aria-hidden="true"]')?.textContent;
    expect(shown()).toBe("0");
    expect(view.container.querySelector(".sr-only")?.textContent).toBe("70");
    await waitFor(() => expect(shown()).toBe("70"));
  });

  it("moves the segmented selection with aria-pressed and skips disabled options", () => {
    const onChange = vi.fn();
    render(<Segmented label="Harness" value="auto" onChange={onChange} options={[{ value: "auto", label: "Auto" }, { value: "codex", label: "Codex", disabled: true }, { value: "claude", label: "Claude" }]} />);
    expect(screen.getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(onChange).toHaveBeenCalledWith("claude");
  });

  it("scatters cell delays within 0 to 799ms, the same every time", () => {
    const all = Array.from({ length: 18 * 7 }, (_, i) => cellDelay(Math.floor(i / 7), i % 7));
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...all)).toBeLessThan(800);
    expect(new Set(all).size).toBeGreaterThan(60);
    expect(cellDelay(3, 4)).toBe(cellDelay(3, 4));
  });
});

describe("Home panels", () => {
  it("tallies states without archived or hidden chats and lists the newest first", () => {
    const m = threadModel([
      thread("a", { status: "active" }),
      thread("b", { hasPendingInteraction: true, updatedAt: NOW - 1000 }),
      thread("c", { isUnread: true, updatedAt: NOW }),
      thread("d", { isArchived: true }),
      thread("e", { isHidden: true }),
    ]);
    expect(m.tally).toEqual({ running: 1, needs: 1, unread: 1, parked: 0 });
    expect(m.recent[0].id).toBe("c");
    expect(m.needs.map((t) => t.id)).toEqual(["b"]);
  });

  it("draws one bar per real daily peak, and says so plainly when there are none", () => {
    const icon = () => null;
    const view = render(<AllowanceCard accounts={[account()]} value="c1" onChange={() => {}} workingBy={new Set()} icon={icon} />);
    expect(view.container.querySelectorAll('[data-nav-part="track-bars"] .nav-hk-bar')).toHaveLength(2);
    cleanup();
    render(<AllowanceCard accounts={[account({ history: [] })]} value="c1" onChange={() => {}} workingBy={new Set()} icon={icon} />);
    expect(screen.getByText(/No daily peaks yet/)).toBeTruthy();
  });

  it("shows an empty window state rather than a made-up line when there are no samples", () => {
    render(<WindowCard trend={{ now: NOW, sampledFrom: null, accounts: [] }} account={account()} />);
    expect(screen.getByText(/No samples for Claude yet/)).toBeTruthy();
  });
});

describe("Control room", () => {
  it("shows the four states, the harness split and each Mac's load from Fleet", async () => {
    const board = {
      serverId: "sky", serverKey: "laptop",
      columns: [
        { key: "laptop", label: "laptop home", serverId: "sky", online: true, lastSeenAt: NOW, threads: [], resources: { observedAt: NOW, cpuCount: 12, cpuUtilization: 0.25, totalMemoryBytes: 32 * gb, availableMemoryBytes: 16 * gb } },
        { key: "work", label: "work Client", serverId: "m4", online: false, lastSeenAt: NOW - 3_600_000, threads: [], resources: null },
      ],
    };
    const view = renderSlot({ component: ControlRoom as never }, {}, {
      sidebarThreads: { status: "ready", threads: [thread("a", { status: "active" }), thread("b", { hasPendingInteraction: true })], projects: [], sections: [] } as never,
      rpc: { fleet_board: () => ({ available: true, board, error: null }) } as never,
    });
    await waitFor(() => expect(view.container.querySelectorAll('[data-nav-part="machine-tile"]')).toHaveLength(2));
    await act(async () => {});
    const stats = [...view.container.querySelectorAll('[data-nav-part="stat"]')].map((s) => `${s.getAttribute("data-state")}:${s.querySelector(".sr-only")?.textContent}`);
    expect(stats).toEqual(["running:1", "needs:1", "unread:0", "parked:0"]);
    const [m5, m4] = view.container.querySelectorAll('[data-nav-part="machine-tile"]');
    expect(m5.textContent).toContain("25% CPU");
    expect(m5.textContent).toContain("16 of 32 GB");
    expect(m5.querySelector('[data-nav-part="status-dot"]')?.getAttribute("data-online")).toBe("true");
    expect(m4.textContent).toContain("offline");
    expect(view.container.querySelector('[data-nav-part="needs-you"]')?.textContent).toContain("b");
  });
});

describe("Home figure when data arrives late", () => {
  it("still counts up when the first value is zero while loading", async () => {
    reduce = false;
    const view = render(<CountUp value={0} ms={60} />);
    const shown = () => view.container.querySelector('[aria-hidden="true"]');
    expect(shown()?.textContent).toBe("0");
    view.rerender(<CountUp value={12} ms={60} />);
    expect(shown()?.className ?? "").not.toContain("nav-hk-fade");
    await waitFor(() => expect(shown()?.textContent).toBe("12"));
    view.rerender(<CountUp value={13} ms={60} />);
    expect(shown()?.textContent).toBe("13");
    expect(shown()?.className).toContain("nav-hk-fade");
  });
});

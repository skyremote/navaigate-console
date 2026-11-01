// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Meter, Segmented, TrackBars } from "../src/home-kit";
import { ActivityCard, AllowanceCard, MachinesCard, WindowCard } from "../src/home-panels";
import { HomePage } from "../src/home";
import { COMMUNITY_DEFAULTS } from "../profile/schema";
import { setProfileState } from "../src/use-profile";
import { useFleetBoard } from "../src/machine-row";
import type { HomeAccount } from "../server-home";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const gb = 1024 ** 3;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setVisibility("visible");
});

const board = (now: number) => ({
  serverId: "srv-laptop", serverKey: "laptop",
  columns: [
    { key: "laptop", label: "laptop home", serverId: "srv-laptop", online: true, lastSeenAt: now, threads: [], resources: { observedAt: now, cpuCount: 12, cpuUtilization: 0.25, totalMemoryBytes: 32 * gb, availableMemoryBytes: 16 * gb } },
    { key: "studio", label: "Studio home", serverId: "m1", online: true, lastSeenAt: now, threads: [], resources: { observedAt: now, cpuCount: 8, cpuUtilization: 0.5, totalMemoryBytes: 16 * gb, availableMemoryBytes: 8 * gb } },
  ],
});

const account = (over: Partial<HomeAccount> = {}): HomeAccount => ({
  id: "c1", harness: "claude", label: "Claude", email: "pat@example.com", plan: "Max 20x", session: 34, sessionResetsAt: null, week: 41,
  weekResetsAt: null, cycleLabel: "Week", history: [{ day: "2026-10-30", peak: 20 }, { day: "2026-10-31", peak: 41 }], advice: null, status: "ok", ...over,
});

describe("one fleet board for the Rail and the Home card", () => {
  function RailProbe() {
    useFleetBoard();
    return null;
  }

  it("keeps one timer and one fleet_board call per refresh with both mounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const timers = vi.spyOn(window, "setInterval");
    let calls = 0;
    const rpc = { fleet_board: () => { calls++; return { available: true, board: board(Date.now()), error: null }; } };
    const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    renderSlot({ component: RailProbe }, {}, { rpc: rpc as never });
    await advance(10);
    await advance(7_000);
    renderSlot({ component: () => <MachinesCard threads={[]} /> }, {}, { rpc: rpc as never });
    await advance(10);
    expect(document.querySelectorAll('[data-nav-part="machine-tile"]')).toHaveLength(2);
    expect(timers.mock.calls.filter(([, ms]) => ms === 15_000)).toHaveLength(1);
    const before = calls;
    await advance(15_000 * 4);
    expect(calls - before).toBe(4);
  });

  it("starts fresh and stops polling once nothing shows the board", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const view = renderSlot({ component: RailProbe }, {}, { rpc: { fleet_board: () => { calls++; return { available: true, board: board(Date.now()), error: null }; } } as never });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(calls).toBe(1);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(calls).toBe(1);
  });
});

describe("Home polls through the shared request layer", () => {
  it("asks for usage_trend and home_accounts once for two Home pages, and pauses while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    const seen: Record<string, number> = {};
    const count = (name: string, value: unknown) => () => { seen[name] = (seen[name] ?? 0) + 1; return value; };
    const rpc = {
      home_accounts: count("home_accounts", { accounts: [account()] }),
      usage_trend: count("usage_trend", { now: Date.now(), sampledFrom: null, accounts: [] }),
      home_brief: count("home_brief", { headline: null, date: null }),
      home_agenda: count("home_agenda", { configured: true, error: null, reconnect: [], events: [] }),
      ask_log: count("ask_log", { recent: [], jevDecisions: 0, overrides: 0 }),
      fleet_board: () => ({ available: false, board: null, error: "offline" }),
    };
    renderSlot({ component: HomePage }, {}, { rpc: rpc as never });
    renderSlot({ component: HomePage }, {}, { rpc: rpc as never });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(seen.usage_trend).toBe(1);
    expect(seen.home_accounts).toBe(1);
    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000); });
    expect(seen.usage_trend).toBe(1);
    expect(seen.home_accounts).toBe(1);
    setVisibility("visible");
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(seen.usage_trend).toBe(2);
    expect(seen.home_accounts).toBe(2);
  });
});

describe("bars and meters animate with transforms", () => {
  it("scales a meter fill on an inner element and leaves the entrance on the outer one", () => {
    const view = render(<Meter value={0.4} label="CPU" />);
    const fill = view.container.querySelector('[role="meter"] i') as HTMLElement;
    expect(fill.style.transform).toBe("scaleX(0.4)");
    expect(fill.style.width).toBe("");
    expect(fill.parentElement?.className).toContain("nav-hk-grow");
    expect(fill.parentElement?.parentElement?.getAttribute("role")).toBe("meter");
  });

  it("scales a bar fill on an inner element and leaves the entrance on the outer one", () => {
    const view = render(<TrackBars label="Peaks" active={null} onActive={() => {}} bars={[{ key: "a", value: 50, tick: "1", title: "a" }, { key: "b", value: 0, tick: "2", title: "b" }]} />);
    const fills = [...view.container.querySelectorAll<HTMLElement>(".nav-hk-bar > i")];
    expect(fills).toHaveLength(2);
    expect(fills[0].style.transform).toBe("scaleY(0.5)");
    expect(fills[1].style.transform).toBe("scaleY(0)");
    expect(fills.every((f) => f.style.height === "")).toBe(true);
  });

  it("never transitions height or width in the Home styles", () => {
    render(<Meter value={0.2} label="CPU" />);
    const css = document.getElementById("nav-hk-style")?.textContent ?? "";
    expect(css).not.toMatch(/transition:\s*(height|width)/);
    expect(css).toMatch(/transition:\s*transform/);
  });
});

describe("account switcher", () => {
  const icon = () => null;
  const two = [
    account(),
    account({ id: "c2", email: "ops@example.com", week: 91, plan: "Pro", advice: "Weekly use is near the ceiling; Max 5x would give more room.", history: [{ day: "2026-10-31", peak: 91 }] }),
  ];

  it("tells two accounts of one harness apart by the start of their email", () => {
    render(<AllowanceCard accounts={two} value="c1" onChange={() => {}} workingBy={new Set()} icon={icon} />);
    const group = screen.getByRole("group", { name: "Account" });
    const names = within(group).getAllByRole("button").map((b) => b.textContent);
    expect(names[0]).toContain("pat");
    expect(names[1]).toContain("ops");
    expect(names[0]).not.toBe(names[1]);
  });

  it("shows advice and high use for every account, not only the selected one", () => {
    render(<AllowanceCard accounts={two} value="c1" onChange={() => {}} workingBy={new Set()} icon={icon} />);
    expect(screen.getByText(/Max 5x would give more room/)).toBeTruthy();
    const group = screen.getByRole("group", { name: "Account" });
    const second = within(group).getAllByRole("button")[1];
    expect(second.textContent).toMatch(/high use/i);
    expect(within(group).getAllByRole("button")[0].textContent).not.toMatch(/high use/i);
  });

  it("turns a bar red from 85 percent", () => {
    const view = render(<AllowanceCard accounts={two} value="c2" onChange={() => {}} workingBy={new Set()} icon={icon} />);
    const fill = view.container.querySelector<HTMLElement>('[data-nav-part="track-bars"] .nav-hk-bar > i')!;
    expect(fill.style.background).toContain("destructive");
  });
});

describe("machine picker", () => {
  it("is a set of toggle buttons with the meters outside every button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = renderSlot({ component: () => <MachinesCard threads={[]} /> }, {}, { rpc: { fleet_board: () => ({ available: true, board: board(Date.now()), error: null }) } as never });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(view.container.querySelectorAll('[role="radio"], [role="radiogroup"]')).toHaveLength(0);
    const tiles = [...view.container.querySelectorAll('[data-nav-part="machine-tile"]')];
    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      const button = tile.querySelector("button")!;
      expect(button.getAttribute("aria-pressed")).toMatch(/true|false/);
      expect(button.querySelector('[role="meter"]')).toBeNull();
      expect(tile.querySelectorAll('[role="meter"]').length).toBe(2);
    }
    expect(tiles[0].querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tiles[1].querySelector("button")!);
    expect(tiles[1].querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
    expect(tiles[0].querySelector("button")!.getAttribute("aria-pressed")).toBe("false");
    expect(view.container.textContent).toContain("New work on Studio");
  });
});

describe("Chats started counts local calendar days", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("puts a chat started at half past midnight on the day the clocks went back on that day", () => {
    process.env.TZ = "Europe/London";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-31T12:00:00Z") });
    const at = new Date("2026-10-24T23:30:00Z").getTime();
    const thread = { id: "a", createdAt: at } as unknown as PluginSidebarThread;
    const view = render(<ActivityCard threads={[thread]} />);
    const titles = [...view.container.querySelectorAll("[title]")].map((el) => el.getAttribute("title") ?? "");
    expect(titles.filter((t) => /25 Oct.*: 1 chat$/.test(t))).toHaveLength(1);
    expect(titles.filter((t) => /24 Oct.*: [1-9]/.test(t))).toHaveLength(0);
  });
});

describe("sliding indicator", () => {
  it("measures when the selection changes, not on every render", () => {
    let reads = 0;
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get() { reads++; return 0; } });
    try {
      const options = [{ value: "a", label: "A" }, { value: "b", label: "B" }];
      const view = render(<Segmented label="Pick" value="a" onChange={() => {}} options={options} />);
      const first = reads;
      expect(first).toBeGreaterThan(0);
      view.rerender(<Segmented label="Pick" value="a" onChange={() => {}} options={options} />);
      view.rerender(<Segmented label="Pick" value="a" onChange={() => {}} options={options} />);
      expect(reads).toBe(first);
      view.rerender(<Segmented label="Pick" value="b" onChange={() => {}} options={options} />);
      expect(reads).toBeGreaterThan(first);
      const after = reads;
      act(() => { window.dispatchEvent(new Event("resize")); });
      expect(reads).toBeGreaterThan(after);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetLeft", original);
      else delete (HTMLElement.prototype as { offsetLeft?: unknown }).offsetLeft;
    }
  });
});

describe("usage chart and reduced motion", () => {
  it("draws the usage window from real samples with the end point as a round-capped dot", () => {
    const t0 = Date.parse("2026-10-31T08:00:00Z");
    const trend = {
      now: t0 + 3_600_000, sampledFrom: t0,
      accounts: [{
        id: "c1", harness: "claude" as const, email: "pat@example.com", plan: "Max 20x", status: "ok" as const, observedAt: t0, burn: 4, busiest: { mode: "none" as const, since: null, sinceLabel: "", rows: [] },
        windows: [{
          id: "w1", label: "Session", span: "session" as const, model: null, pct: 30, startsAt: t0, resetsAt: t0 + 5 * 3_600_000, idle: false,
          series: [[t0, 10], [t0 + 1_800_000, 20], [t0 + 3_600_000, 30]] as Array<[number, number]>, rate: 4, rateBasis: "recent" as const, samples: 3, forecastAtReset: 60, hits90At: null, hits100At: null, burn: 4,
        }],
      }],
    };
    const view = render(<WindowCard trend={trend as never} account={account()} />);
    const svg = view.container.querySelector('[data-nav-part="area-line"]')!;
    expect(svg.querySelectorAll("path")).toHaveLength(2);
    expect(svg.querySelector("circle")).toBeNull();
    const dot = svg.querySelector("line[stroke-linecap='round']")!;
    expect(dot.getAttribute("x1")).toBe(dot.getAttribute("x2"));
    expect(dot.getAttribute("y1")).toBe(dot.getAttribute("y2"));
  });

  it("switches every animation and transition off under reduced motion", () => {
    render(<Meter value={0.2} label="CPU" />);
    const css = document.getElementById("nav-hk-style")?.textContent ?? "";
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
    for (const name of [".nav-hk-rise", ".nav-hk-bar", ".nav-hk-grow", ".nav-hk-wipe", ".nav-hk-pop", ".nav-hk-row"]) expect(reduced).toContain(name);
    expect(reduced).toMatch(/\.nav-hk-bar > i, \.nav-hk-meter i[^}]*transition: none/);
  });
});

describe("the machines card for a single Mac", () => {
  it("keeps a New work entry for this Mac, and no machine tiles, load or other Macs, while the machine dashboard is unticked", () => {
    setProfileState({ profile: COMMUNITY_DEFAULTS, source: "defaults", errors: [], path: "p", stamp: "community" });
    const calls: string[] = [];
    const rpc = { fleet_board: () => { calls.push("fleet_board"); return { available: true, board: board(Date.now()), error: null }; } };
    renderSlot({ component: () => <MachinesCard threads={[]} /> }, {}, { rpc: rpc as never });
    const button = document.querySelector('[data-nav-part="machine-new-work"]') as HTMLElement;
    expect(button.textContent).toBe("New work on This Mac");
    expect(document.querySelectorAll('[data-nav-part="machine-tile"]')).toHaveLength(0);
    expect(document.querySelector('[data-nav-part="machines-card"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/online|CPU|Studio|laptop/);
    expect(calls).toEqual([]);
  });
});

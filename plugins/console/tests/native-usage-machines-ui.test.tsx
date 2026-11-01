// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Trend, UsageMachineRow } from "../server-usage-trend";
import { UsageMachinesCard } from "../src/home-panels";
import { HomePage } from "../src/home";
import { trendWithMachines, CLAUDE_M1, CLAUDE_M5, CODEX_M5 } from "./fixtures/usage-machines";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); toast.success.mockClear(); toast.error.mockClear(); });

const rowsFor = (harness: string) => Array.from(document.querySelectorAll(`[data-nav-part="usage-provider"][data-harness="${harness}"] [data-nav-part="usage-row"]`)) as HTMLElement[];

describe("Usage across machines on Home", () => {
  it("lists Laptop and Studio under Claude, each with remaining allowance and when it was read", () => {
    const now = Date.now();
    render(<UsageMachinesCard trend={trendWithMachines(now)} onLink={vi.fn(async () => {})} />);
    const rows = rowsFor("claude");
    expect(rows.map((r) => r.dataset.machine)).toEqual(["laptop", "studio", "work"]);
    const m5 = within(rows[0]);
    expect(m5.getByText("59% left")).toBeTruthy();
    expect(m5.getByText("70% left")).toBeTruthy();
    expect(rows[0].querySelector('[data-nav-part="updated"]')?.textContent).toBe("Read 1m ago");
    expect(rows[1].querySelector('[data-nav-part="updated"]')?.textContent).toBe("Read 3m ago");
    expect(rows[1].dataset.state).toBe("current");
  });

  it("says why a machine is missing instead of leaving a gap", () => {
    render(<UsageMachinesCard trend={trendWithMachines(Date.now())} onLink={vi.fn(async () => {})} />);
    const m4 = rowsFor("claude").find((r) => r.dataset.machine === "work")!;
    expect(m4.dataset.state).toBe("none");
    expect(m4.textContent).toContain("No Claude reading from this machine");
    expect(m4.textContent).toContain("Unavailable");
  });

  it("marks a kept reading as kept and shows how old it is", () => {
    const now = Date.now();
    const trend = trendWithMachines(now);
    trend.machines = trend.machines!.map((r) => (r.key === CLAUDE_M1.key ? { ...r, freshness: "stale" as const, observedAt: now - 25 * 60_000 } : r));
    render(<UsageMachinesCard trend={trend} onLink={vi.fn(async () => {})} />);
    const m1 = rowsFor("claude").find((r) => r.dataset.machine === "studio")!;
    expect(m1.dataset.state).toBe("retained");
    expect(m1.textContent).toContain("Last reading kept");
    expect(m1.querySelector('[data-nav-part="updated"]')?.textContent).toBe("Read 25m ago");
  });

  it("shows the headline as allowances, not readings, so one subscription on two Macs is not counted twice", () => {
    const now = Date.now();
    const separate = render(<UsageMachinesCard trend={trendWithMachines(now)} onLink={vi.fn(async () => {})} />);
    expect(separate.container.textContent).toContain("allowances · 3 readings");
    expect(separate.container.textContent).not.toContain("counted once");
    separate.unmount();
    const merged = trendWithMachines(now);
    merged.machines = merged.machines!.map((r) => (r.harness === "claude" ? { ...r, allowanceId: "linked:claude:1", identity: "confirmed" as const } : r));
    const view = render(<UsageMachinesCard trend={merged} onLink={vi.fn(async () => {})} />);
    expect(view.container.textContent).toContain("allowances · 3 readings · 1 counted once");
    const one = view.container.querySelector('[data-nav-part="one-allowance"]')!;
    expect(one.textContent).toContain("One allowance · Laptop + Studio");
    expect(one.textContent).toContain("59% left");
    expect(one.textContent).toContain("confirmed by you");
  });

  it("offers Count once when two Claude readings share a weekly reset, and sends exactly those readings", async () => {
    const onLink = vi.fn(async () => {});
    render(<UsageMachinesCard trend={trendWithMachines(Date.now())} onLink={onLink} />);
    const hint = document.querySelector('[data-nav-part="same-account-hint"]') as HTMLElement;
    expect(hint.textContent).toContain("Laptop and Studio report the same reset time");
    expect(hint.textContent).toContain("count as separate allowances");
    await act(async () => { fireEvent.click(within(hint).getByRole("button", { name: "Count once" })); });
    expect(onLink).toHaveBeenCalledWith([CLAUDE_M5.key, CLAUDE_M1.key], true);
    expect(toast.success).toHaveBeenCalledWith("Counted as one allowance");
  });

  it("offers no Count once for Codex readings that are not alike, and none for Cursor", () => {
    render(<UsageMachinesCard trend={trendWithMachines(Date.now())} onLink={vi.fn(async () => {})} />);
    expect(document.querySelectorAll('[data-nav-part="same-account-hint"]')).toHaveLength(1);
    expect(document.querySelector('[data-harness="codex"] [data-nav-part="same-account-hint"]')).toBeNull();
  });

  it("offers Count separately for a confirmed link and none for a provider-verified one", async () => {
    const onLink = vi.fn(async () => {});
    const trend = trendWithMachines(Date.now());
    trend.machines = trend.machines!.map((r) => (r.harness === "claude" ? { ...r, allowanceId: "linked:claude:1", identity: "confirmed" as const } : { ...r, allowanceId: "bbsub1:x", identity: "token-verified" as const }));
    render(<UsageMachinesCard trend={trend} onLink={onLink} />);
    expect(document.querySelectorAll('[data-nav-part="same-account-hint"]')).toHaveLength(0);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Count separately" })); });
    expect(onLink).toHaveBeenCalledWith([CLAUDE_M5.key, CLAUDE_M1.key], false);
    expect(screen.getAllByRole("button", { name: "Count separately" })).toHaveLength(1);
  });

  it("reports a refused link without changing what is shown", async () => {
    const onLink = vi.fn(async () => { throw new Error("Two accounts on one machine are two subscriptions, not one."); });
    render(<UsageMachinesCard trend={trendWithMachines(Date.now())} onLink={onLink} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Count once" })); });
    expect(toast.error).toHaveBeenCalledWith("Two accounts on one machine are two subscriptions, not one.");
    expect(screen.getByRole("button", { name: "Count once" })).toBeTruthy();
  });

  it("waits quietly before the first reading and says so when there are none", () => {
    const first = render(<UsageMachinesCard trend={null} onLink={vi.fn(async () => {})} />);
    expect(first.container.textContent).toContain("Reading usage from every machine");
    first.unmount();
    const empty: Trend = { now: Date.now(), sampledFrom: null, accounts: [], sources: [], machines: [] };
    const second = render(<UsageMachinesCard trend={empty} onLink={vi.fn(async () => {})} />);
    expect(second.container.textContent).toContain("No readings yet");
  });
});

describe("Home mounts the card and re-reads after a link", () => {
  it("calls usage_link with the readings and reloads usage_trend once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    const seen: Record<string, number> = {};
    const links: unknown[] = [];
    const rpc = {
      home_accounts: () => ({ accounts: [] }),
      usage_trend: () => { seen.usage_trend = (seen.usage_trend ?? 0) + 1; return trendWithMachines(Date.now()); },
      usage_link: (input: unknown) => { links.push(input); return { ok: true, groups: [] }; },
      home_brief: () => ({ headline: null, date: null }),
      home_agenda: () => ({ configured: true, error: null, reconnect: [], events: [] }),
      ask_log: () => ({ recent: [], jevDecisions: 0, overrides: 0 }),
      fleet_board: () => ({ available: false, board: null, error: "offline" }),
    };
    renderSlot({ component: HomePage }, {}, { rpc: rpc as never });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(document.querySelector('[data-nav-part="usage-machines-card"]')).toBeTruthy();
    expect(seen.usage_trend).toBe(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Count once" })); await vi.advanceTimersByTimeAsync(50); });
    expect(links).toEqual([{ keys: [CLAUDE_M5.key, CLAUDE_M1.key], linked: true }]);
    expect(seen.usage_trend).toBe(2);
  });
});

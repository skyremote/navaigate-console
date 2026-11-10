// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Trend, TrendAccount, TrendWindow, UsageMachineRow } from "../server-usage-trend";
import { heightForShare, mountOrb } from "../src/usage-orb-engine";
import { hottest, usageOrbs } from "../src/usage-orbs-model";
import { UsageOrbsCard } from "../src/usage-orbs";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 20, 0, 0);

const win = (over: Partial<TrendWindow>): TrendWindow => ({
  id: "w", label: "Week", span: "long", model: null, pct: 0, startsAt: null, resetsAt: NOW + 60 * HOUR, idle: false, series: [], rate: null, rateBasis: "none", samples: 0,
  forecastAtReset: null, hits90At: null, hits100At: null, burn: null, ...over,
});
const account = (over: Partial<TrendAccount>): TrendAccount => ({
  id: "a", harness: "claude", email: null, plan: null, status: "ok", observedAt: NOW, windows: [], burn: null, busiest: { mode: "none", since: NOW, sinceLabel: "", rows: [] }, ...over,
});
const row = (over: Partial<UsageMachineRow>): UsageMachineRow => ({
  key: "k", provider: "claude", harness: "claude", machine: "laptop", label: null, plan: null, observedAt: NOW, freshness: "fresh", identity: "unknown", allowanceId: "a", windows: [], ...over,
});

/** Shaped like a real reading: stale window ids kept in storage, one plan read on two Macs, a machine with no reading. */
function trend(): Trend {
  return {
    now: NOW,
    sampledFrom: NOW - 240 * HOUR,
    accounts: [
      account({
        id: "ultra", email: "pat@example.com", plan: "Claude Ultra",
        windows: [
          win({ id: "five-hour", label: "Session", span: "session", resetsAt: NOW - 200 * HOUR, idle: true }),
          win({ id: "weekly", pct: 7, series: [[NOW - 60 * HOUR, 7]] }),
          win({ id: "secondary", pct: 64, burn: 0, series: [[NOW - 60_000, 64]] }),
          win({ id: "weekly:fable", label: "Week · Fable", model: "fable", pct: 41, burn: 3.77, series: [[NOW - 60_000, 41]] }),
        ],
      }),
      account({ id: "quiet", email: "sam@example.com", plan: "Max 20x", windows: [win({ id: "secondary", pct: 0, burn: 0, series: [[NOW - 60_000, 0]] })] }),
      account({ id: "pro", harness: "codex", email: "pat@example.com", plan: "ChatGPT Pro", windows: [win({ id: "primary", pct: 52, burn: 0, resetsAt: NOW + 12 * HOUR, series: [[NOW - 60_000, 52]] })] }),
      account({ id: "fleet-usage:codex:owner:1", harness: "codex", status: "error", windows: [win({ id: "owner:weekly:", pct: 66, resetsAt: NOW - 150 * HOUR })] }),
      account({ id: "cursor", harness: "cursor", email: "pat@example.com", plan: "Cursor Super", windows: [win({ id: "month", label: "Month", pct: 0, resetsAt: NOW + 480 * HOUR })] }),
    ],
    sources: [],
    machines: [
      row({ key: "claude:studio", machine: "studio", freshness: "unavailable", observedAt: null, allowanceId: "fleet-usage:claude:owner:1" }),
      row({ key: "claude:laptop:ultra", label: "pat", plan: "Claude Ultra", allowanceId: "ultra", windows: [
        { kind: "weekly", label: "Weekly limit", model: null, pct: 64, resetsAt: NOW + 60 * HOUR },
        { kind: "weekly", label: "Weekly · fable", model: "fable", pct: 41, resetsAt: NOW + 60 * HOUR },
      ] }),
      row({ key: "claude:laptop:quiet", label: "sam", plan: "Max 20x", allowanceId: "quiet", windows: [
        { kind: "five-hour", label: "Five-hour limit", model: null, pct: 30, resetsAt: NOW - HOUR },
        { kind: "weekly", label: "Weekly limit", model: null, pct: 0, resetsAt: NOW + 60 * HOUR },
      ] }),
      row({ key: "codex:studio", provider: "codex", harness: "codex", machine: "studio", plan: "Pro", identity: "token-verified", allowanceId: "pro", windows: [{ kind: "weekly", label: "Weekly limit", model: null, pct: 52, resetsAt: NOW + 12 * HOUR }] }),
      row({ key: "codex:laptop", provider: "codex", harness: "codex", label: "pat", plan: "ChatGPT Pro", identity: "token-verified", allowanceId: "pro", windows: [{ kind: "weekly", label: "Weekly limit", model: null, pct: 52, resetsAt: NOW + 12 * HOUR }] }),
      row({ key: "cursor:local:cursor", provider: "cursor", harness: "cursor", label: "pat", plan: "Cursor Super", allowanceId: "cursor", windows: [{ kind: "monthly", label: "This month", model: null, pct: 0, resetsAt: NOW + 480 * HOUR }] }),
      row({ key: "acp-cursor:studio", provider: "acp-cursor", harness: "other", machine: "studio", plan: "Super", allowanceId: "fleet-usage:acp-cursor:owner:1", windows: [{ kind: "plan usage", label: "Plan usage", model: null, pct: 7, resetsAt: NOW + 86 * HOUR }] }),
      row({ key: "acp-opencode:studio", provider: "acp-opencode", harness: "other", machine: "studio", freshness: "unavailable", observedAt: null, allowanceId: "fleet-usage:acp-opencode:owner:1" }),
    ],
  };
}

beforeEach(() => {
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  // jsdom has no canvas: the engine must decline quietly, so silence jsdom's "not implemented" notice.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (n: string) => items.get(n) ?? null, setItem: (n: string, v: string) => { items.set(n, String(v)); }, removeItem: (n: string) => { items.delete(n); } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("usage spheres: the model", () => {
  it("draws one sphere per subscription and none for a machine with no reading", () => {
    const orbs = usageOrbs(trend());
    expect(orbs.map((o) => o.id)).toEqual(["quiet", "ultra", "pro", "cursor", "fleet-usage:acp-cursor:owner:1"]);
    const pro = orbs.find((o) => o.id === "pro")!;
    expect(pro.machines).toEqual(["laptop", "studio"]);
    expect(pro.used).toBe(52);
  });

  it("takes the level from the machine reading, not from a stale window id of the same name", () => {
    const ultra = usageOrbs(trend()).find((o) => o.id === "ultra")!;
    expect(ultra.used).toBe(64);
    expect(ultra.left).toBe(36);
    expect(ultra.period).toBe("week");
    expect(ultra.name).toBe("Claude");
    expect(ultra.plan).toBe("Ultra");
  });

  it("burns on the fastest window, even when the main window is not moving", () => {
    const orbs = usageOrbs(trend());
    const ultra = orbs.find((o) => o.id === "ultra")!;
    expect(ultra.burn).toBeCloseTo(3.77);
    expect(ultra.hot?.label).toBe("Week · Fable");
    // 59% left at 3.77% an hour is about 15.6 hours, well before the reset in 60.
    expect((ultra.hot!.runsOutAt! - NOW) / HOUR).toBeCloseTo(59 / 3.77, 1);
    expect(ultra.hot!.beforeReset).toBe(true);
    expect(ultra.heat).toBeGreaterThan(0.5);
    expect(orbs.filter((o) => o.heat > 0).map((o) => o.id)).toEqual(["ultra"]);
    expect(hottest(orbs)?.id).toBe("ultra");
  });

  it("reads a window that has reset as empty, and a provider it does not know by its own label", () => {
    const orbs = usageOrbs(trend());
    const session = orbs.find((o) => o.id === "quiet")!.windows.find((w) => w.label === "Session")!;
    expect(session.used).toBe(0);
    expect(session.resetsAt).toBeNull();
    const studioCursor = orbs.find((o) => o.id === "fleet-usage:acp-cursor:owner:1")!;
    expect(studioCursor.brand).toBe("cursor");
    expect(studioCursor.used).toBe(7);
    expect(studioCursor.period).toBe("plan usage");
  });

  it("says when the first window runs out, which is not always the one climbing fastest", () => {
    const t = trend();
    // A session climbing 20% an hour with 90% left, and a week climbing 3% an hour with 5% left: the week runs out first.
    t.accounts.find((a) => a.id === "quiet")!.windows = [
      win({ id: "five-hour", label: "Session", span: "session", pct: 10, burn: 20, resetsAt: NOW + 5 * HOUR, series: [[NOW - 60_000, 10]] }),
      win({ id: "secondary", pct: 95, burn: 3, series: [[NOW - 60_000, 95]] }),
    ];
    t.machines!.find((r) => r.key === "claude:laptop:quiet")!.windows = [
      { kind: "five-hour", label: "Five-hour limit", model: null, pct: 10, resetsAt: NOW + 5 * HOUR },
      { kind: "weekly", label: "Weekly limit", model: null, pct: 95, resetsAt: NOW + 60 * HOUR },
    ];
    const quiet = usageOrbs(t).find((o) => o.id === "quiet")!;
    expect(quiet.hot?.label).toBe("Session");
    expect(quiet.burn).toBe(20);
    expect(quiet.first?.label).toBe("Week");
    expect((quiet.first!.runsOutAt! - NOW) / HOUR).toBeCloseTo(5 / 3, 2);
    const { container } = render(<UsageOrbsCard trend={t} />);
    fireEvent.click(container.querySelector('button[data-orb="quiet"]') as HTMLElement);
    const readout = container.querySelector('[data-nav-part="orb-readout"]') as HTMLElement;
    expect(readout.dataset.orb).toBe("quiet");
    expect(within(readout).getByText(/^in 1h 40m$/)).toBeTruthy();
    expect(within(readout).getByText(/^Week: /)).toBeTruthy();
  });

  it("keeps a plan name whole when the provider id holds characters a pattern would choke on", () => {
    const t = trend();
    const row = t.machines!.find((r) => r.key === "acp-cursor:studio")!;
    row.provider = "acp-c++(beta";
    row.plan = "C++(beta Team";
    expect(() => usageOrbs(t)).not.toThrow();
  });

  it("does not burn on a reading that is not current", () => {
    const t = trend();
    t.machines!.find((r) => r.key === "claude:laptop:ultra")!.freshness = "stale";
    const ultra = usageOrbs(t).find((o) => o.id === "ultra")!;
    expect(ultra.state).toBe("retained");
    expect(ultra.burn).toBeNull();
    expect(ultra.heat).toBe(0);
  });
});

describe("usage spheres: the engine", () => {
  it("fills by the volume of a sphere", () => {
    expect(heightForShare(0)).toBeCloseTo(0, 3);
    expect(heightForShare(0.5)).toBeCloseTo(1, 3);
    expect(heightForShare(1)).toBeCloseTo(2, 3);
    expect(heightForShare(0.25)).toBeLessThan(0.7);
  });

  it("declines to mount where a canvas cannot be drawn on", () => {
    expect(mountOrb(document.createElement("canvas"), { level: 0.5, liquid: [1, 2, 3], ink: [0, 0, 0], dark: false, heat: 1, bubbles: true })).toBeNull();
  });
});

describe("usage spheres: the card", () => {
  it("says it is reading before the first trend arrives", () => {
    render(<UsageOrbsCard trend={null} />);
    expect(screen.getByText("Reading your subscriptions")).toBeTruthy();
  });

  it("names every sphere and describes the burning one first", () => {
    const { container } = render(<UsageOrbsCard trend={trend()} workingBy={new Set(["codex"])} />);
    const spheres = container.querySelectorAll('[data-nav-part="usage-orb"]');
    expect(spheres).toHaveLength(5);
    expect(container.querySelectorAll('[data-burning="true"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Claude, Ultra · pat: 36% of the week left, burning 3\.8% an hour/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Codex, ChatGPT Pro · pat: 48% of the week left, not burning/ })).toBeTruthy();
    const readout = container.querySelector('[data-nav-part="orb-readout"]') as HTMLElement;
    expect(readout.dataset.orb).toBe("ultra");
    // The readout describes the burning sphere by default, but nothing is pressed until the reader presses one.
    expect(container.querySelectorAll('[data-nav-part="usage-orb"][aria-pressed="true"]')).toHaveLength(0);
    expect(within(readout).getByText(/Week · Fable, last 30 minutes/)).toBeTruthy();
    expect(within(readout).getByText(/^in 15h 39m$/)).toBeTruthy();
    expect(within(container.querySelector('[data-orb="pro"]') as HTMLElement).getByText("Working now")).toBeTruthy();
  });

  it("does not say every plan of a harness is working when bb only knows the harness", () => {
    const { container } = render(<UsageOrbsCard trend={trend()} workingBy={new Set(["claude"])} />);
    expect(within(container.querySelector('[data-orb="quiet"]') as HTMLElement).queryByText("Working now")).toBeNull();
    expect(within(container.querySelector('[data-orb="quiet"]') as HTMLElement).getByText("Not burning")).toBeTruthy();
  });

  it("gives a sphere's readout on hover and keeps it on a tap", () => {
    const { container } = render(<UsageOrbsCard trend={trend()} />);
    const readout = () => (container.querySelector('[data-nav-part="orb-readout"]') as HTMLElement).dataset.orb;
    const pro = container.querySelector('button[data-orb="pro"]') as HTMLElement;
    fireEvent.pointerEnter(pro, { pointerType: "mouse" });
    expect(readout()).toBe("pro");
    fireEvent.pointerLeave(pro, { pointerType: "mouse" });
    expect(readout()).toBe("ultra");
    fireEvent.pointerDown(pro, { pointerType: "touch" });
    fireEvent.click(pro);
    expect(readout()).toBe("pro");
    expect(pro.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches between what is left and what is used, and remembers it", () => {
    render(<UsageOrbsCard trend={trend()} />);
    fireEvent.click(screen.getByRole("button", { name: "Used" }));
    expect(screen.getByRole("button", { name: /Claude, Ultra · pat: 64% of the week used/ })).toBeTruthy();
    expect(localStorage.getItem("nav-skin:usage-orbs-mode")).toBe("used");
  });
});

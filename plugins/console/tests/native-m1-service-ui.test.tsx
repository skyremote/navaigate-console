// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { M1ServiceCard } from "../src/m1-service";
import { resetRpcFlight } from "../src/rpc-flight";
import type { M1ServiceState } from "../server-m1-service";

const BOOT = 1_793_000_000;
const state = (over: Partial<M1ServiceState> = {}): M1ServiceState => ({
  reachable: true,
  checkedAt: Date.now(),
  error: null,
  probe: {
    bootAt: BOOT * 1000,
    probedAt: (BOOT + 3 * 3600 + 12 * 60) * 1000,
    bbRunning: true,
    bbVersion: "0.48.1",
    bbStartedAt: (BOOT + 90) * 1000,
    gui: "present",
    app: "absent",
    loginItem: "unknown",
    launchAgent: "running",
    awakeHeld: true,
    awakeSetting: { enabled: true, scope: "all hosts" },
  },
  ...over,
});

beforeEach(() => {
  window.matchMedia = vi.fn((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const card = () => document.querySelector('[data-nav-part="m1-service"]') as HTMLElement;

describe("Studio service card", () => {
  it("shows running headless, keep-awake, last boot and the reboot check", async () => {
    renderSlot({ component: () => <M1ServiceCard /> }, {}, { rpc: { m1_service: () => state() } as never });
    await screen.findByText("Running headless");
    const text = card().textContent ?? "";
    expect(text).toContain("bb 0.48.1 is running");
    expect(text).toContain("Desktop app closed");
    expect(text).toContain("Background launch agent is running");
    expect(text).toContain("Keep Awake is on: the Mac stays awake");
    expect(text).toContain("Turned on in bb for all hosts");
    expect(text).toContain("Up 3h 12m");
    expect(card().querySelector('[data-nav-role="reboot-check"]')?.getAttribute("data-state")).toBe("passed");
    expect(text).toContain("bb came up 1m 30s after the last boot with the desktop app closed");
  });

  it("says plainly when Studio does not answer", async () => {
    renderSlot({ component: () => <M1ServiceCard /> }, {}, { rpc: { m1_service: () => ({ reachable: false, probe: null, checkedAt: Date.now(), error: "ssh: timed out" }) } as never });
    await screen.findByText("Studio not reachable");
    expect(card().textContent).toContain("ssh: timed out");
    expect(card().querySelector('[data-nav-role="reboot-check"]')?.getAttribute("data-state")).toBe("waiting");
  });

  it("marks an open desktop app as not headless", async () => {
    const base = state();
    renderSlot({ component: () => <M1ServiceCard /> }, {}, { rpc: { m1_service: () => ({ ...base, probe: { ...base.probe!, app: "present" } }) } as never });
    await screen.findByText("Running with the desktop app open");
    expect(card().querySelector('[data-nav-role="headline"]')?.getAttribute("data-tone")).toBe("warn");
  });

  it("checks again on demand and on a timer while shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    renderSlot({ component: () => <M1ServiceCard /> }, {}, { rpc: { m1_service: () => { calls++; return state(); } } as never });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(calls).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls).toBe(3);
  });

  it("shares one read between every mounted card", async () => {
    let calls = 0;
    renderSlot({ component: () => <><M1ServiceCard /><M1ServiceCard /></> }, {}, { rpc: { m1_service: () => { calls++; return state(); } } as never });
    await screen.findAllByText("Running headless");
    expect(calls).toBe(1);
  });

  it("does not start a second read while a slow Studio check is still running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetRpcFlight({ minGapMs: 0, hangMs: 600_000 });
    let calls = 0;
    let release: () => void = () => undefined;
    renderSlot({ component: () => <M1ServiceCard /> }, {}, { rpc: { m1_service: () => { calls++; return new Promise((resolve) => { release = () => resolve(state()); }); } } as never });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
    expect(calls).toBe(1);
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(31_000); });
    expect(calls).toBe(2);
  });
});

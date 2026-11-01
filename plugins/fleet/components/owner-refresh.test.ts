import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_BACKOFF_MAX_MS, OWNER_REFRESH_MS, OWNER_STALE_AFTER_MS, ago, createOwnerRefresher, readAge, routeChip } from "./owner-refresh";

const now = 1_793_440_000_000;

function setup(visible = true) {
  let calls = 0;
  const data: number[] = [];
  const errors: string[] = [];
  const load = vi.fn(async () => {
    calls += 1;
    return calls;
  });
  const refresher = createOwnerRefresher<number>({ load, onData: (value) => data.push(value), onError: (message) => errors.push(message), visible });
  return { load, data, errors, refresher };
}

describe("owner card refresh", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("loads once on start and again on every interval while visible", async () => {
    const { load, data, refresher } = setup();
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS);
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(3);
    expect(data).toEqual([1, 2, 3]);
    refresher.stop();
  });

  it("refreshes immediately on a realtime event", async () => {
    const { load, refresher } = setup();
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    refresher.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    refresher.stop();
  });

  it("does not poll or react to events while hidden, and catches up when shown", async () => {
    const { load, refresher } = setup(false);
    refresher.start();
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS * 3);
    refresher.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).not.toHaveBeenCalled();
    refresher.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(2);
    refresher.setVisible(false);
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS * 3);
    expect(load).toHaveBeenCalledTimes(2);
    refresher.stop();
  });

  it("queues one reload when an event arrives during a load instead of overlapping", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const load = vi.fn(() => new Promise<number>((resolve) => { calls += 1; const n = calls; release = () => resolve(n); }));
    const data: number[] = [];
    const refresher = createOwnerRefresher<number>({ load, onData: (value) => data.push(value), onError: () => undefined, visible: true });
    refresher.start();
    refresher.refresh();
    refresher.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(data).toEqual([1, 2]);
    refresher.stop();
  });

  it("reports a failed refresh and recovers on the next one", async () => {
    let fail = true;
    const errors: string[] = [];
    const data: number[] = [];
    const refresher = createOwnerRefresher<number>({
      load: async () => { if (fail) throw new Error("owner unreachable"); return 7; },
      onData: (value) => data.push(value),
      onError: (message) => errors.push(message),
      visible: true,
    });
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(["owner unreachable"]);
    fail = false;
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS);
    expect(data).toEqual([7]);
    refresher.stop();
  });

  it("slows to a longer wait after repeated failures and answers a forced refresh anyway", async () => {
    let fail = true;
    const errors: string[] = [];
    const load = vi.fn(async () => { if (fail) throw new Error("owner unreachable"); return 7; });
    const data: number[] = [];
    const refresher = createOwnerRefresher<number>({ load, onData: (value) => data.push(value), onError: (message) => errors.push(message), visible: true });
    refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(2);
    const afterSecondFailure = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(afterSecondFailure);
    refresher.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(afterSecondFailure);
    fail = false;
    refresher.refresh(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(data).toEqual([7]);
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(afterSecondFailure + 2);
    refresher.stop();
  });

  it("never waits longer than the maximum between attempts, and a 10 minute outage costs a handful of loads", async () => {
    const load = vi.fn(async () => { throw new Error("owner unreachable"); });
    const refresher = createOwnerRefresher<number>({ load, onData: () => undefined, onError: () => undefined, visible: true });
    refresher.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(load.mock.calls.length).toBeGreaterThan(3);
    expect(load.mock.calls.length).toBeLessThanOrEqual(12);
    expect(OWNER_BACKOFF_MAX_MS).toBe(120_000);
    refresher.stop();
  });

  it("stops cleanly: no loads and no delivered results after stop", async () => {
    let release: (() => void) | undefined;
    const data: number[] = [];
    const load = vi.fn(() => new Promise<number>((resolve) => { release = () => resolve(1); }));
    const refresher = createOwnerRefresher<number>({ load, onData: (value) => data.push(value), onError: () => undefined, visible: true });
    refresher.start();
    refresher.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(OWNER_REFRESH_MS * 3);
    refresher.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(data).toEqual([]);
  });
});

describe("owner card data age", () => {
  it("shows how long ago the card was read", () => {
    expect(readAge(now - 12_000, false, now)).toEqual({ label: "read 12s ago", tone: "" });
    expect(readAge(now - OWNER_STALE_AFTER_MS - 1_000, false, now).tone).toBe("bad");
  });

  it("flags a failed refresh with the age of the data still on screen", () => {
    expect(readAge(now - 30_000, true, now)).toEqual({ label: "refresh failed, last read 30s ago", tone: "bad" });
  });

  it("never shows a cached green route as healthy once its proof is old", () => {
    expect(routeChip({ kind: "ssh", state: "healthy", detail: null, lastOkAt: now - 4_000 }, now)).toEqual({ label: "ssh healthy · 4s ago", tone: "ok" });
    expect(routeChip({ kind: "ssh", state: "healthy", detail: null, lastOkAt: now - OWNER_STALE_AFTER_MS - 1_000 }, now)).toEqual({ label: "ssh stale · 2m ago", tone: "bad" });
    expect(routeChip({ kind: "connect", state: "healthy", detail: "https://studio", lastOkAt: null }, now)).toEqual({ label: "connect healthy", tone: "ok" });
    expect(routeChip({ kind: "broker", state: "unavailable", detail: "Turso", lastOkAt: null }, now)).toEqual({ label: "broker unavailable", tone: "bad" });
  });

  it("formats ages from an explicit clock", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago(now - 125_000, now)).toBe("2m ago");
  });
});

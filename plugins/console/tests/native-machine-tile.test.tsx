// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineRow } from "../src/machine-row";
import type { Chip } from "../src/machines";

const NOW = Date.now() + 10 * 60_000;
const gb = 1024 ** 3;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function tiles(chips: Chip[]) {
  const view = render(<MachineRow chips={chips} value="laptop" onChange={() => {}} now={NOW} />);
  return [...view.container.querySelectorAll('[data-nav-part="machine-tile"]')];
}

describe("machine tile", () => {
  it("shows CPU %, free RAM and the age of the reading in one tile", () => {
    const [tile] = tiles([{ key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: NOW, ownerStatus: "live", resources: { observedAt: NOW - 27_000, cpuCount: 8, cpuUtilization: 0.42, totalMemoryBytes: 32 * gb, availableMemoryBytes: 28 * gb } }]);
    const text = tile.textContent ?? "";
    expect(text).toContain("42% CPU");
    expect(text).toContain("28 GB free");
    expect(text).toContain("updated 27s ago");
    expect(tile.querySelector('[data-nav-role="age"]')?.getAttribute("data-stale")).toBe("false");
  });

  it("keeps the numbers and marks the tile stale when the reading is old", () => {
    const [tile] = tiles([{ key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: NOW, ownerStatus: "live", resources: { observedAt: NOW - 5 * 60_000, cpuCount: 8, cpuUtilization: 0.99, totalMemoryBytes: 32 * gb, availableMemoryBytes: 3 * gb } }]);
    const text = tile.textContent ?? "";
    expect(text).toContain("99% CPU");
    expect(text).toContain("3 GB free");
    expect(text).toContain("stale · updated 5m ago");
    expect(tile.querySelector('[data-nav-role="age"]')?.getAttribute("data-stale")).toBe("true");
  });

  it("counts the age up and turns stale between fleet refreshes", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const start = Date.now();
    const view = render(<MachineRow chips={[{ key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: start, ownerStatus: "live", resources: { observedAt: start - 50_000, cpuCount: 8, cpuUtilization: 0.4, totalMemoryBytes: 32 * gb, availableMemoryBytes: 8 * gb } }]} value="laptop" onChange={() => {}} now={start} />);
    const age = () => view.container.querySelector('[data-nav-role="age"]');
    expect(age()?.textContent).toBe("updated 50s ago");
    expect(age()?.getAttribute("data-stale")).toBe("false");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(age()?.textContent).toBe("updated 55s ago");
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(age()?.textContent).toBe("stale · updated 1m ago");
    expect(age()?.getAttribute("data-stale")).toBe("true");
  });

  it("labels a live machine with no reading as no health data and not stale", () => {
    const [tile] = tiles([{ key: "studio", sub: "home", online: true, cooking: 0, lastSeenAt: NOW - 5_000, ownerStatus: "live", resources: null }]);
    const age = tile.querySelector('[data-nav-role="age"]');
    expect(age?.textContent).toBe("no health data");
    expect(age?.getAttribute("data-stale")).toBe("false");
  });

  const system = { cpuPercent: 42, cores: 10, loadAvg: [1, 2, 3] as [number, number, number], memUsedBytes: 12 * gb, memTotalBytes: 32 * gb, memPressure: "critical" as const, swapUsedBytes: 2 * gb, diskFreeBytes: 100 * gb, diskTotalBytes: 500 * gb, keepAwake: ["Amphetamine"] };

  it("opens a CPU and RAM card on Studio tile, with pressure in red and no battery or power lines", async () => {
    const [tile] = tiles([{ key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: NOW, system }]);
    await act(async () => { (tile as HTMLElement).focus(); });
    const card = await waitFor(() => { const c = document.querySelector('[data-nav-part="system-card"]'); expect(c).not.toBeNull(); return c!; });
    const text = card.textContent ?? "";
    expect(text).toContain("42%");
    expect(text).toContain("10 cores");
    expect(text).toContain("12.0 GB of 32.0 GB");
    expect(text).toContain("Memory pressure critical");
    expect(text).toContain("2.0 GB in use");
    expect(text).toContain("Kept awake by Amphetamine");
    expect(card.querySelector('[data-nav-part="system-pressure"]')?.getAttribute("style")).toContain("--destructive-text");
    expect(text).not.toMatch(/battery|watt|charging|power/i);
  });

  it("opens no card without system data, and none on Work", async () => {
    const [none, m4] = tiles([
      { key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: NOW, system: null },
      { key: "work", sub: "", online: true, cooking: 0, lastSeenAt: NOW, system },
    ]);
    await act(async () => { (none as HTMLElement).focus(); });
    await act(async () => { (m4 as HTMLElement).focus(); });
    expect(document.querySelector('[data-nav-part="system-card"]')).toBeNull();
  });
});

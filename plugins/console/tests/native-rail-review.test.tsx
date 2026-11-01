// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FOLDERS_FLIGHT_KEY, STYLES_FLIGHT_KEY, useFolders, useItemStyles } from "../src/folders";
import { rpcFlight } from "../src/rpc-flight";
import { CoreEntries } from "../src/delivery";
import { PrBadge } from "../src/rail-extras";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pf() {
  const calls: string[] = [];
  const callRpc = vi.fn(async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === "list") return { folders: [], roots: [], bindings: {}, places: {} };
    if (method === "prefs_get") return { prefs: {}, items: {}, stored: true };
    throw new Error(`no ${method}`);
  });
  return { calls, sdk: { plugins: { callRpc } } as never, count: (m: string) => calls.filter((c) => c === m).length };
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function StylesProbe() {
  useItemStyles(null);
  return null;
}
function FoldersProbe() {
  useFolders(null);
  return null;
}

describe("the project-folders polls go through rpcFlight and useVisiblePoll", () => {
  it("shares one prefs_get request between two mounted style hooks, at start and on each poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sdk, count } = pf();
    renderSlot({ component: () => <><StylesProbe /><StylesProbe /></> }, {}, { sdk });
    await advance(10);
    expect(count("prefs_get")).toBe(1);
    await advance(20_000);
    expect(count("prefs_get")).toBe(2);
    expect(rpcFlight().peek(STYLES_FLIGHT_KEY)).toBeDefined();
  });

  it("shares one list request between two mounted folder hooks on each poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sdk, count } = pf();
    renderSlot({ component: () => <><FoldersProbe /><FoldersProbe /></> }, {}, { sdk });
    await advance(10);
    await advance(20_000);
    expect(count("list")).toBe(2);
    expect(count("prefs_get")).toBe(2);
    expect(rpcFlight().peek(FOLDERS_FLIGHT_KEY)).toBeDefined();
  });

  it("does not poll while the document is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sdk, count } = pf();
    renderSlot({ component: () => <><StylesProbe /><FoldersProbe /></> }, {}, { sdk });
    await advance(10);
    const before = count("prefs_get") + count("list");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await advance(60_000);
    expect(count("prefs_get") + count("list")).toBe(before);
  });

  it("the Delivery page asks for the styles only once the icon chooser is opened", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sdk, count } = pf();
    const full = { plugins: (sdk as { plugins: unknown }).plugins, projects: { get: async () => ({ icon: null }), iconCandidates: async () => ({ candidates: [] }), update: async () => ({}) } };
    renderSlot({ component: () => <CoreEntries projectId="p9" /> }, {}, { sdk: full as never });
    await advance(25_000);
    expect(count("prefs_get")).toBe(0);
    fireEvent.click(screen.getByText("Project icon", { selector: "button" }));
    await advance(10);
    expect(count("prefs_get")).toBe(1);
  });
});

describe("the rail uses the theme, not raw colours", () => {
  const pr = (checks: "passing" | "failing" | "pending" | "none") => ({ number: 41, url: "https://github.com/x/y/pull/41", state: "open" as const, checks, failedCount: 0 });

  it("draws running and passing checks with theme tokens", () => {
    for (const checks of ["pending", "passing", "failing"] as const) {
      const view = renderSlot({ component: () => <PrBadge pr={pr(checks)} /> }, {});
      expect(view.container.innerHTML).not.toMatch(/amber|emerald|yellow|orange|gold|#[0-9a-f]{3,6}\b/i);
      cleanup();
    }
    const view = renderSlot({ component: () => <PrBadge pr={pr("passing")} /> }, {});
    expect(view.container.querySelector("svg[style]")?.getAttribute("style")).toContain("var(--success)");
  });

  it("has no raw Tailwind palette colour class anywhere in src", () => {
    const palette = /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|shadow)-(?:amber|emerald|yellow|orange|gold|lime|red|green|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;
    const offenders = srcFiles().filter((f) => palette.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("no keyboard shortcut is declared twice", () => {
  it("every declared shortcut is unique and none comes from the Stash, icon or PR badge files", () => {
    const declared: string[] = [];
    for (const f of srcFiles()) for (const m of readFileSync(f, "utf8").matchAll(/aria-keyshortcuts="([^"]+)"/g)) declared.push(m[1]!);
    expect(new Set(declared).size).toBe(declared.length);
    for (const name of ["rail-extras.tsx", "rail-icons.tsx", "stash.tsx"]) {
      expect(readFileSync(join(__dirname, "..", "src", name), "utf8")).not.toMatch(/aria-keyshortcuts|accessKey|addEventListener\("key|useHotkey|hotkey/i);
    }
  });
});

function srcFiles(): string[] {
  const dir = join(__dirname, "..", "src");
  return readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f));
}

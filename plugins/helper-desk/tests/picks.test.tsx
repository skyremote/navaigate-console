// @vitest-environment jsdom
// The mascots tick in the Console's setup picker (EXTRA-C): the helper, the server answer and the cards.
import { cleanup, render } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTab } from "../app";
import { picksOff, pickedOff } from "../lib/picks";
import { getMascotsOff, reloadMascotGate, setMascotsOff } from "../mascotgate";
import { reloadChoice } from "../mascotchoice";
import type { DeskSnapshot } from "../model";
import { COMMUNITY_DEFAULTS, type Profile } from "../profile/schema";
import plugin from "../server";
import { installMemoryStorage } from "./memory-storage";
import { silenceCanvas } from "./no-canvas";

installMemoryStorage();
silenceCanvas();

const community = (picks: Record<string, boolean>): Profile => ({ ...COMMUNITY_DEFAULTS, features: { preset: null, picks } });

describe("pickedOff", () => {
  it("is off only for a community profile whose pick is exactly false", () => {
    expect(pickedOff(community({ "EXTRA-C": false }), "EXTRA-C")).toBe(true);
    expect(pickedOff(community({ "EXTRA-C": true }), "EXTRA-C")).toBe(false);
    expect(pickedOff(COMMUNITY_DEFAULTS, "EXTRA-C")).toBe(false);
  });

  it("is never off in the private edition, and lists only Helper Desk's own id", () => {
    expect(pickedOff({ ...community({ "EXTRA-C": false }), edition: "private" }, "EXTRA-C")).toBe(false);
    expect(picksOff(community({ "EXTRA-C": false, F18: false }))).toEqual(["EXTRA-C"]);
  });
});

describe("the picks answer from the server", () => {
  const before = process.env.NAVAIGATE_CONSOLE_PROFILE;
  let dir = "";
  afterEach(() => {
    if (before === undefined) delete process.env.NAVAIGATE_CONSOLE_PROFILE; else process.env.NAVAIGATE_CONSOLE_PROFILE = before;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const answer = async (profile: unknown) => {
    dir = mkdtempSync(join(tmpdir(), "hd-picks-"));
    const path = join(dir, "profile.json");
    writeFileSync(path, JSON.stringify(profile));
    process.env.NAVAIGATE_CONSOLE_PROFILE = path;
    const { bb, harness } = createFakePluginHost({ pluginId: "helper-desk", sdk: {} });
    plugin(bb);
    return harness.callRpc("picks", null) as Promise<{ picksOff: string[] }>;
  };

  it("says the mascots are off when the community profile unticks them, and nothing else", async () => {
    expect(await answer({ edition: "community", features: { picks: { "EXTRA-C": false, F18: false } } })).toEqual({ picksOff: ["EXTRA-C"] });
  });

  it("says nothing is off when the mascots are ticked, unpicked, or the profile is private", async () => {
    expect(await answer({ edition: "community", features: { picks: { "EXTRA-C": true } } })).toEqual({ picksOff: [] });
    expect(await answer({ edition: "community" })).toEqual({ picksOff: [] });
    expect(await answer({ edition: "private", features: { picks: { "EXTRA-C": false } } })).toEqual({ picksOff: [] });
  });
});

const T0 = new Date(2026, 9, 31, 15, 0, 0).getTime();
function snapshot(): DeskSnapshot {
  const agent = { id: "toolu_a", name: "Docs agent", agentType: "general-purpose", model: "Sonnet 5.5", state: "running" as const, background: true, startedAt: T0 - 30_000, finishedAt: null, tokens: 50_000, steps: 3, stepLabel: "Reading files", details: [], progress: 0.4, colour: 0, summary: "", parentId: null };
  return { threadId: "thr_ui", title: "Mascots", turnKey: "thr_ui:1", agents: [agent], todos: [], cost: null, subagentTokens: 100_000, startedAt: T0 - 30_000, endedAt: null, running: true, todosUpdatedAt: null, lead: { label: "Lead", model: "Opus 5.5", state: "working", activity: "Working", contextUsed: 88000, contextPct: 9, costUsd: 1.2, costEstimated: true }, updatedAt: T0 };
}

describe("the cards with the mascots switched off", () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadChoice();
    reloadMascotGate();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setMascotsOff(false);
  });
  const live = () => render(<LiveTab threadId="thr_ui" data={snapshot()} error={null} visibility="live" now={T0} delayMs={8000} onHistory={() => undefined} />);

  it("shows an animated mascot and a Choose mascot button while they are on", () => {
    const { queryAllByRole, container } = live();
    expect(queryAllByRole("button", { name: /^Choose mascot for/ }).length).toBeGreaterThan(0);
    expect([...container.querySelectorAll(".hd-m")].some((m) => m.getAttribute("data-mascot") !== "still")).toBe(true);
  });

  it("shows only a still mark and no way to choose one when they are off", () => {
    setMascotsOff(true);
    expect(getMascotsOff()).toBe(true);
    const { queryAllByRole, container } = live();
    expect(queryAllByRole("button", { name: /^Choose mascot for/ })).toHaveLength(0);
    const marks = [...container.querySelectorAll(".hd-m")];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((m) => m.getAttribute("data-mascot") === "still" && m.querySelector("canvas, svg, .hd-m-strip") === null)).toBe(true);
  });
});

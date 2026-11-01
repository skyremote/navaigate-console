// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTab } from "../app";
import { chooseFor, getChoice, reloadChoice, setCoachCharacter, setCoachColour, setCoachShape } from "../mascotchoice";
import type { DeskSnapshot } from "../model";
import type { DeskTeam, TeamAgent } from "../team";
import { TeamView } from "../teamtab";
import { installMemoryStorage } from "./memory-storage";
import { silenceCanvas } from "./no-canvas";

const T0 = new Date(2026, 9, 31, 15, 0, 0).getTime();

function snapshot(threadId = "thr_ui"): DeskSnapshot {
  const agent = (id: string, name: string, colour: number) => ({ id, name, agentType: "general-purpose", model: "Sonnet 5.5", state: "running" as const, background: true, startedAt: T0 - 30_000, finishedAt: null, tokens: 50_000, steps: 3, stepLabel: "Reading files", details: [], progress: 0.4, colour, summary: "", parentId: null });
  return { threadId, title: "Mascots", turnKey: `${threadId}:1`, agents: [agent("toolu_a", "Docs agent", 0), agent("toolu_b", "Build agent", 1)], todos: [], cost: null, subagentTokens: 100_000, startedAt: T0 - 30_000, endedAt: null, running: true, todosUpdatedAt: null, lead: { label: "Lead", model: "Opus 5.5", state: "working", activity: "Working", contextUsed: 88000, contextPct: 9, costUsd: 1.2, costEstimated: true }, updatedAt: T0 };
}

installMemoryStorage();
silenceCanvas();

beforeEach(() => {
  window.localStorage.clear();
  reloadChoice();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const live = () => render(<LiveTab threadId="thr_ui" data={snapshot()} error={null} visibility="live" now={T0} delayMs={8000} onHistory={() => undefined} />);

describe("the agent cards on the Live tab", () => {
  it("puts a Choose mascot button on every agent card and on the lead card", () => {
    const { getAllByRole } = live();
    const labels = getAllByRole("button", { name: /^Choose mascot for/ }).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(expect.arrayContaining(["Choose mascot for Docs agent", "Choose mascot for Build agent", "Choose mascot for Lead · Opus 5.5"]));
  });

  it("opens the menu under the card and changes that card's mascot only", () => {
    const { getByRole, queryByRole, container } = live();
    expect(queryByRole("group", { name: /Choose mascot/ })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Choose mascot for Docs agent" }));
    const menu = getByRole("group", { name: "Choose mascot for Docs agent" });
    const card = menu.closest("article")!;
    fireEvent.click(menu.querySelector('[data-character="sonar-sweep"]')!);
    expect(card.querySelector(".hd-m")!.getAttribute("data-mascot")).toBe("sonar-sweep");
    expect(getChoice().picks["toolu_a"]).toBe("sonar-sweep");
    const others = [...container.querySelectorAll("article")].filter((a) => a !== card).flatMap((a) => [...a.querySelectorAll(".hd-botwrap > .hd-m")]);
    expect(others.every((m) => m.getAttribute("data-mascot") !== null)).toBe(true);
    expect(getChoice().picks["toolu_b"]).toBeUndefined();
  });

  it("closes the menu when the button is pressed again", () => {
    const { getByRole, queryByRole } = live();
    const button = getByRole("button", { name: "Choose mascot for Docs agent" });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(queryByRole("group", { name: /Choose mascot/ })).toBeNull();
  });

  it("lets the lead card pick its own mascot, keyed by the thread", () => {
    const { getByRole } = live();
    fireEvent.click(getByRole("button", { name: /Choose mascot for Lead/ }));
    fireEvent.click(getByRole("group", { name: /Choose mascot for Lead/ }).querySelector('[data-character="helix-scanner"]')!);
    expect(getChoice().picks["thr_ui"]).toBe("helix-scanner");
  });
});

describe("the Team tab", () => {
  it("lets a team member pick a mascot too", () => {
    const base = { provider: "Claude Code", model: "Opus 5.5", state: "running" as const, parentId: null, startedAt: T0, phase: null, worktree: null, alsoTouched: [], worktreeSource: "none" as const, link: null, note: "" };
    const agents: TeamAgent[] = [{ ...base, id: "lead:thr_root", kind: "lead", name: "Lead", threadId: "thr_root" }];
    const sessions = [{ threadId: "thr_root", title: "Team", provider: "Claude Code", model: "Opus 5.5", role: "root" as const, active: true, status: "active" as const, createdAt: T0 - 1000 }];
    const data: DeskTeam = { threadId: "thr_root", sessions, agents, worktrees: [], omitted: 0, updatedAt: T0 };
    const { getByRole } = render(<TeamView data={data} onOpenThread={() => undefined} />);
    fireEvent.click(getByRole("button", { name: "Choose mascot for Lead" }));
    fireEvent.click(getByRole("group", { name: "Choose mascot for Lead" }).querySelector('[data-character="voxel-matrix-morph"]')!);
    expect(getChoice().picks["thr_root"]).toBe("voxel-matrix-morph");
  });
});

describe("the Mascots tab", () => {
  async function panel() {
    const app = await loadPluginApp(() => import("../app"));
    const action = app.threadPanelActions.find((a) => a.id === "desk")!;
    const slot = renderSlot(action, { threadId: "thr_ui" }, { rpc: { snapshot: () => snapshot(), history: () => ({ batches: [] }) }, settings: { autoHide: false, hideDelaySeconds: 8, companion: true } });
    await act(async () => { await Promise.resolve(); });
    const root = within(slot.container as HTMLElement);
    fireEvent.click(root.getByRole("tab", { name: "Mascots" }));
    return { slot, root };
  }

  it("is a fourth tab beside Live, History and Team", async () => {
    const { root } = await panel();
    expect(root.getAllByRole("tab").map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Live", "History", "Team", "Mascots"]);
    expect(root.getByRole("tab", { name: "Mascots" }).getAttribute("aria-selected")).toBe("true");
  });

  it("toggles animations in and out of the default set, but never leaves it empty", async () => {
    const { root } = await panel();
    const set = root.getByRole("group", { name: "Default mascots" });
    const tile = (id: string) => set.querySelector(`[data-character="${id}"]`) as HTMLElement;
    const all = ["sphere-scan", "crystalline-refraction", "sonar-sweep", "helix-scanner", "interconnecting-waves", "cylindrical-analysis", "voxel-matrix-morph", "phased-array-emitter", "crystalline-cube-refraction"];
    for (const id of all) expect(tile(id).getAttribute("aria-pressed")).toBe("true");
    expect(set.querySelectorAll("canvas")).toHaveLength(9);
    for (const id of all.slice(1)) fireEvent.click(tile(id));
    expect(getChoice().set).toEqual(["sphere-scan"]);
    expect(tile("sphere-scan").getAttribute("aria-pressed")).toBe("true");
    expect(tile("sonar-sweep").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(tile("sphere-scan"));
    expect(getChoice().set).toEqual(["sphere-scan"]);
    fireEvent.click(root.getByRole("button", { name: "Use all nine" }));
    expect(getChoice().set).toEqual([]);
    expect(tile("sonar-sweep").getAttribute("aria-pressed")).toBe("true");
  });

  it("puts an animation on the right-hand mascot and hands it back to the coach", async () => {
    const { root } = await panel();
    const grid = root.getByRole("group", { name: "Right-hand mascot character" });
    fireEvent.click(grid.querySelector('[data-coach="phased-array-emitter"]')!);
    expect(getChoice().coach).toBe("phased-array-emitter");
    expect(root.queryByRole("group", { name: "Right-hand mascot shape" })).toBeNull();
    fireEvent.click(grid.querySelector('[data-coach=""]')!);
    expect(getChoice().coach).toBeNull();
    expect(root.getByRole("group", { name: "Right-hand mascot shape" })).toBeTruthy();
  });

  it("picks the right-hand mascot's shape and colour, and resets both", async () => {
    const { root } = await panel();
    const shapes = root.getByRole("group", { name: "Right-hand mascot shape" });
    fireEvent.click(shapes.querySelector('[data-shape="goutte"]')!);
    expect(getChoice().shape).toBe("goutte");
    expect(shapes.querySelector('[data-shape="goutte"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(shapes.querySelectorAll("[data-shape]")).toHaveLength(8);
    const colours = root.getByRole("group", { name: "Right-hand mascot colour" });
    expect(colours.querySelectorAll("[data-colour]")).toHaveLength(12);
    fireEvent.click(colours.querySelector('[data-colour="violet"]')!);
    expect(getChoice().colour).toBe("violet");
    fireEvent.click(root.getByRole("button", { name: "Back to the cloud" }));
    expect(getChoice().shape).toBeNull();
    expect(getChoice().colour).toBeNull();
  });

  it("counts the cards with their own mascot and clears them", async () => {
    chooseFor("toolu_a", "sonar-sweep");
    chooseFor("toolu_b", "helix-scanner");
    const { root } = await panel();
    expect(root.getByText(/2 cards have their own mascot/)).toBeTruthy();
    fireEvent.click(root.getByRole("button", { name: "Clear card choices" }));
    expect(getChoice().picks).toEqual({});
    expect(root.getByText(/No card has its own mascot/)).toBeTruthy();
  });

  it("is reachable from a card's menu", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const action = app.threadPanelActions.find((a) => a.id === "desk")!;
    const slot = renderSlot(action, { threadId: "thr_ui" }, { rpc: { snapshot: () => snapshot(), history: () => ({ batches: [] }) }, settings: { autoHide: false, hideDelaySeconds: 8, companion: true } });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const root = within(slot.container as HTMLElement);
    fireEvent.click(root.getByRole("tab", { name: /^Live/ }));
    fireEvent.click(root.getByRole("button", { name: "Choose mascot for Docs agent" }));
    fireEvent.click(root.getByRole("button", { name: /Default set and right-hand mascot/ }));
    expect(root.getByRole("tab", { name: "Mascots" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("the right-hand mascot", () => {
  async function companion() {
    const app = await loadPluginApp(() => import("../app"));
    const overlay = app.appOverlays.find((o) => o.id === "coach-companion")!;
    const slot = renderSlot(overlay, {}, { rpc: { snapshot: () => snapshot() }, settings: { companion: true }, context: { threadId: "thr_ui" } });
    await act(async () => { await Promise.resolve(); });
    return slot;
  }

  it("wears the chosen animation when one is picked", async () => {
    const slot = await companion();
    const el = (slot.container as HTMLElement).querySelector(".hd-companion") as HTMLElement;
    act(() => setCoachCharacter("sonar-sweep"));
    expect(el.querySelector("canvas")!.getAttribute("data-avatar")).toBe("sonar-sweep");
    expect(el.querySelector("svg")).toBeNull();
    act(() => setCoachCharacter(null));
    expect(el.querySelector("svg")!.getAttribute("data-bot-shape")).toBe("nuage");
  });

  it("is the cloud in the theme colour until chosen", async () => {
    const slot = await companion();
    const el = (slot.container as HTMLElement).querySelector(".hd-companion") as HTMLElement;
    expect(el.querySelector("svg")!.getAttribute("data-bot-shape")).toBe("nuage");
    expect(el.style.color).toBe("");
  });

  it("takes the chosen shape and colour live", async () => {
    const slot = await companion();
    const el = (slot.container as HTMLElement).querySelector(".hd-companion") as HTMLElement;
    act(() => { setCoachShape("hexagone"); setCoachColour("violet"); });
    expect(el.querySelector("svg")!.getAttribute("data-bot-shape")).toBe("hexagone");
    expect(el.style.color).toBe("rgb(139, 92, 246)");
    act(() => { setCoachShape(null); setCoachColour(null); });
    expect(el.querySelector("svg")!.getAttribute("data-bot-shape")).toBe("nuage");
    expect(el.style.color).toBe("");
  });
});

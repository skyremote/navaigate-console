// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoachBot } from "../coach/CoachBot";
import { ANIMATION_IDS } from "../avatars/animations";
import { Mascot } from "../mascots";
import { MAX_PICKS, STORAGE_KEY, chooseFor, getChoice, reloadChoice, resetChoices, setCoachCharacter, setCoachColour, setCoachShape, setDefaultSet } from "../mascotchoice";
import { MascotChooser } from "../mascotpicker";
import { installMemoryStorage } from "./memory-storage";
import { silenceCanvas } from "./no-canvas";

const EMPTY = { picks: {}, set: [], coach: null, shape: null, colour: null };

installMemoryStorage();
silenceCanvas();

beforeEach(() => {
  window.localStorage.clear();
  reloadChoice();
});
afterEach(cleanup);

describe("the mascot choice store", () => {
  it("starts empty and writes each change to localStorage", () => {
    expect(getChoice()).toEqual(EMPTY);
    chooseFor("agent-1", "sonar-sweep");
    setDefaultSet(["sphere-scan", "helix-scanner"]);
    setCoachShape("goutte");
    setCoachColour("violet");
    setCoachCharacter("voxel-matrix-morph");
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(saved).toEqual({ picks: { "agent-1": "sonar-sweep" }, set: ["sphere-scan", "helix-scanner"], coach: "voxel-matrix-morph", shape: "goutte", colour: "violet" });
  });

  it("survives a reload", () => {
    chooseFor("agent-1", "helix-scanner");
    setCoachShape("hexagone");
    reloadChoice();
    expect(getChoice().picks["agent-1"]).toBe("helix-scanner");
    expect(getChoice().shape).toBe("hexagone");
  });

  it("clears a pick with null, and resets everything", () => {
    chooseFor("agent-1", "helix-scanner");
    chooseFor("agent-1", null);
    expect(getChoice().picks).toEqual({});
    chooseFor("agent-2", "sonar-sweep");
    setDefaultSet(["sphere-scan"]);
    setCoachColour("rose");
    resetChoices();
    expect(getChoice()).toEqual(EMPTY);
  });

  it("drops garbage, and picks left over from the old pixel and 3D mascots, instead of crashing", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ style: "pixel", picks: { a: 4, b: "sonar-sweep", c: "hoot", d: "glass" }, set: ["pip", 3, "sphere-scan", "sphere-scan"], coach: "nebula", shape: "blob", colour: "chartreuse" }));
    reloadChoice();
    expect(getChoice()).toEqual({ picks: { b: "sonar-sweep" }, set: ["sphere-scan"], coach: null, shape: null, colour: null });
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    reloadChoice();
    expect(getChoice().picks).toEqual({});
  });

  it("keeps a saved right-hand pick of the old NavAIgate N as the N, not the cloud", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ picks: {}, set: [], coach: "navn", shape: null, colour: null }));
    reloadChoice();
    expect(getChoice().coach).toBe("navn");
  });

  it("keeps only the newest picks so ephemeral agent ids cannot fill storage", () => {
    for (let i = 0; i < MAX_PICKS + 25; i++) chooseFor(`a${i}`, "sonar-sweep");
    const keys = Object.keys(getChoice().picks);
    expect(keys).toHaveLength(MAX_PICKS);
    expect(keys).not.toContain("a0");
    expect(keys).toContain(`a${MAX_PICKS + 24}`);
  });

  it("re-renders a mounted avatar when its choice changes", () => {
    const { container } = render(<Mascot seed="live-agent" colour="#f26b21" state="idle" />);
    const before = container.querySelector(".hd-m")!.getAttribute("data-mascot");
    const next = ANIMATION_IDS.find((c) => c !== before)!;
    act(() => chooseFor("live-agent", next));
    expect(container.querySelector(".hd-m")!.getAttribute("data-mascot")).toBe(next);
    act(() => chooseFor("live-agent", null));
    expect(container.querySelector(".hd-m")!.getAttribute("data-mascot")).toBe(before);
  });

  it("applies the default set to a mounted avatar", () => {
    const { container } = render(<Mascot seed="another" colour="#f26b21" state="idle" />);
    act(() => setDefaultSet(["voxel-matrix-morph"]));
    expect(container.querySelector(".hd-m")!.getAttribute("data-mascot")).toBe("voxel-matrix-morph");
  });

  it("draws a forced animation for previews, whatever the store says", () => {
    chooseFor("preview-seed", "sonar-sweep");
    const { container } = render(<Mascot seed="preview-seed" character="helix-scanner" colour="#f26b21" state="idle" />);
    expect(container.querySelector(".hd-m")!.getAttribute("data-mascot")).toBe("helix-scanner");
  });
});

describe("the choose-mascot menu", () => {
  it("offers all nine animations by name, with a live preview each, and marks the current one", () => {
    const { container, getByRole } = render(<MascotChooser seed="agent-9" name="Docs agent" />);
    expect(getByRole("group", { name: "Choose mascot for Docs agent" })).toBeTruthy();
    const ids = [...container.querySelectorAll("[data-character]")].map((b) => b.getAttribute("data-character"));
    expect([...ids].sort()).toEqual([...ANIMATION_IDS].sort());
    expect(container.querySelectorAll(".hd-mchoose-tile canvas")).toHaveLength(9);
    expect(getByRole("button", { name: /Automatic/, pressed: true })).toBeTruthy();
  });

  it("stores the pick on click and returns to automatic on request", () => {
    const { container, getByRole } = render(<MascotChooser seed="agent-9" name="Docs agent" />);
    fireEvent.click(container.querySelector('[data-character="sonar-sweep"]')!);
    expect(getChoice().picks["agent-9"]).toBe("sonar-sweep");
    expect(container.querySelector('[data-character="sonar-sweep"]')!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByRole("button", { name: /Automatic/ }));
    expect(getChoice().picks["agent-9"]).toBeUndefined();
  });

  it("links to the Mascots tab when it is given somewhere to go", () => {
    let went = 0;
    const { getByRole } = render(<MascotChooser seed="agent-9" name="Docs agent" onMore={() => void (went += 1)} />);
    fireEvent.click(getByRole("button", { name: /Default set and right-hand mascot/ }));
    expect(went).toBe(1);
  });
});

describe("the coach's shape", () => {
  it("is the cloud unless told otherwise, and follows the shape prop", () => {
    const a = render(<CoachBot size={40} paused />);
    expect(a.container.querySelector("svg")!.getAttribute("data-bot-shape")).toBe("nuage");
    const b = render(<CoachBot size={40} paused shape="goutte" />);
    expect(b.container.querySelector("svg")!.getAttribute("data-bot-shape")).toBe("goutte");
    b.rerender(<CoachBot size={40} paused shape="hexagone" />);
    expect(b.container.querySelector("svg")!.getAttribute("data-bot-shape")).toBe("hexagone");
  });
});

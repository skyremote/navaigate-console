// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { N_ID, PALETTE, loopFor, lookAt, lookForFrame, statesFor } from "../mascots3d/catalog";
import { FIELD_HALF, FIELD_RES, N_PATH, N_WIDTH, flattenPath, nField, nOutline, signedDistance } from "../mascots3d/navmark";
import { fragmentFor } from "../mascots3d/shaders";
import { loadStrips, stripFor, stripKey } from "../mascots3d/strips";
import { STRIPS } from "../mascots3d/strips.generated";
import { Mascot, mascotStateFor } from "../mascots";
import { chooseFor, reloadChoice } from "../mascotchoice";
import type { DeskSnapshot } from "../model";
import { installMemoryStorage } from "./memory-storage";
import { silenceCanvas } from "./no-canvas";

installMemoryStorage();
silenceCanvas();
beforeEach(() => {
  window.localStorage.clear();
  reloadChoice();
});
afterEach(cleanup);

describe("how the N is drawn", () => {
  it("is the favicon's own path, not a redraw", () => {
    const sibling = join(homedir(), "Documents/GitHub/bb-plugin-navaigate-skin-native-sessions/src/navmark.tsx");
    if (existsSync(sibling)) expect(readFileSync(sibling, "utf8")).toContain(`N_PATH = "${N_PATH}"`);
    expect(N_PATH.startsWith("M121.64 0.5C75.04 5.8")).toBe(true);
    const raw = flattenPath(N_PATH);
    const xs = raw.map((p) => p[0]);
    const ys = raw.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(622, -1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(534, -1);
  });

  it("is centred on the origin at the stated width, with the sign right inside and outside the metal", () => {
    const { points, start } = nOutline();
    const xs = points.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(N_WIDTH, 6);
    expect(Math.max(...xs) + Math.min(...xs)).toBeCloseTo(0, 6);
    expect(signedDistance(points, start[0], start[1])).toBeLessThan(0);
    expect(signedDistance(points, -0.62, 0.0)).toBeLessThan(0);
    expect(signedDistance(points, 1.1, 1.1)).toBeGreaterThan(0.3);
    expect(signedDistance(points, -0.4, -0.1)).toBeGreaterThan(0);
  });

  it("bakes a distance field that agrees with the outline and runs along the ribbon", () => {
    const f = nField();
    const { points, start } = nOutline();
    expect(f.size).toBe(FIELD_RES);
    expect(f.data).toHaveLength(FIELD_RES * FIELD_RES * 4);
    const at = (x: number, y: number) => {
      const i = Math.floor(((x / FIELD_HALF) * 0.5 + 0.5) * FIELD_RES);
      const j = Math.floor(((y / FIELD_HALF) * 0.5 + 0.5) * FIELD_RES);
      return (j * FIELD_RES + i) * 4;
    };
    const cell = (2 * FIELD_HALF) / FIELD_RES;
    for (const [x, y] of [[-0.62, 0], [0.5, -0.4], [-0.2, 0.05], [1.0, 1.0], [0.1, 0.3]]) {
      expect(Math.abs(f.data[at(x, y)] - signedDistance(points, x, y))).toBeLessThan(cell * 1.2);
    }
    const g = Math.hypot(f.data[at(1.0, 0.0) + 1], f.data[at(1.0, 0.0) + 2]);
    expect(g).toBeCloseTo(1, 1);
    const near = f.data[at(start[0], start[1]) + 3];
    const far = f.data[at(0.62, 0.62) + 3];
    expect(near).toBeLessThan(0.1);
    expect(far).toBeGreaterThan(0.8);
    expect(f.data[at(0.0, 0.0) + 3]).toBeGreaterThan(0.2);
    expect(f.data[at(0.0, 0.0) + 3]).toBeLessThan(0.8);
  });

  it("has a well-formed shader that reads the field and the state", () => {
    const src = fragmentFor(N_ID);
    expect(src).toContain("uniform sampler2D uSdf");
    expect(src).toContain("uMode");
    expect(src).toContain("texture(uSdf");
    expect(src.split("{").length).toBe(src.split("}").length);
  });
});

describe("how the N moves", () => {
  it("has its own look for waiting for you, and every other character plays idle", () => {
    expect(statesFor(N_ID)).toEqual(["work", "idle", "wait", "done", "error"]);
    expect(statesFor("glass")).not.toContain("wait");
    expect(lookAt(N_ID, "work", 1).mode).toBe(0);
    expect(lookAt(N_ID, "idle", 1).mode).toBe(1);
    expect(lookAt(N_ID, "wait", 1).mode).toBe(2);
    expect(lookAt(N_ID, "done", 9).mode).toBe(3);
    expect(lookAt(N_ID, "error", 0).mode).toBe(4);
    expect(lookAt("glass", "wait", 1)).toEqual(lookAt("glass", "idle", 1));
    expect(loopFor("glass", "wait")).toEqual(loopFor("glass", "idle"));
  });

  it("loops slowly and joins up at the loop point", () => {
    for (const s of ["work", "idle", "wait"] as const) {
      const loop = loopFor(N_ID, s);
      expect(loop.seconds).toBeGreaterThanOrEqual(3);
      expect(lookAt(N_ID, s, loop.seconds).phase).toBeCloseTo(lookAt(N_ID, s, 0).phase, 6);
      expect(lookForFrame(N_ID, s, 0)).toEqual(lookAt(N_ID, s, 0));
    }
    expect(lookAt(N_ID, "error", 0)).toMatchObject({ sat: 0.1, glow: 0 });
    expect(lookAt(N_ID, "done", 60)).toEqual(lookAt(N_ID, "done", 5));
  });

  it("is captured once per state, whatever the card colour", async () => {
    await loadStrips();
    for (const s of statesFor(N_ID)) {
      expect(STRIPS[stripKey(N_ID, s, 0)], s).toMatch(/^data:image\/webp;base64,/);
      PALETTE.forEach((_, i) => expect(stripKey(N_ID, s, i)).toBe(stripKey(N_ID, s, 0)));
    }
    expect(stripFor(N_ID, "wait", PALETTE[3])!.className).toBe(stripFor(N_ID, "wait", PALETTE[5])!.className);
  });

  it("maps a lead that is waiting for you, or needs you, to the waiting look", () => {
    expect(mascotStateFor("waiting")).toBe("wait");
    expect(mascotStateFor("needs-you")).toBe("wait");
    expect(mascotStateFor("working")).toBe("work");
    expect(mascotStateFor("stopped")).toBe("idle");
  });
});

function snapshot(state: "working" | "waiting"): DeskSnapshot {
  const now = Date.now();
  return { threadId: "thr_n", title: "N", turnKey: "thr_n:1", agents: [], todos: [], cost: null, subagentTokens: 0, startedAt: now, endedAt: null, running: false, todosUpdatedAt: null, lead: { label: "Lead", model: "Opus 5.5", state, activity: "Waiting", contextUsed: null, contextPct: null, costUsd: null, costEstimated: false }, updatedAt: now };
}

async function panel(state: "working" | "waiting") {
  const app = await loadPluginApp(() => import("../app"));
  const action = app.threadPanelActions.find((a) => a.id === "desk")!;
  const slot = renderSlot(action, { threadId: "thr_n" }, { rpc: { snapshot: () => snapshot(state), history: () => ({ batches: [] }) }, settings: { autoHide: false, hideDelaySeconds: 8, companion: true } });
  await act(async () => { await Promise.resolve(); });
  return slot.container as HTMLElement;
}

describe("the lead card", () => {
  it("wears the NavAIgate N by default, in the waiting look when it waits for you", async () => {
    await loadStrips();
    const container = await panel("waiting");
    const m = container.querySelector(".hd-leadcard .hd-m") as HTMLElement;
    expect(m.dataset.mascot).toBe(N_ID);
    expect(m.classList.contains("hd-m-wait")).toBe(true);
    expect((m.querySelector("canvas.hd-navn") as HTMLCanvasElement).dataset.state).toBe("wait");
  });

  it("works in the working look, and a pick of its own replaces the N", async () => {
    await loadStrips();
    const container = await panel("working");
    expect((container.querySelector(".hd-leadcard .hd-m") as HTMLElement).classList.contains("hd-m-work")).toBe(true);
    expect(container.querySelector(".hd-leadcard canvas.hd-navn")).not.toBeNull();
    act(() => chooseFor("thr_n", "sonar-sweep"));
    expect(container.querySelector(".hd-leadcard canvas.hd-navn")).toBeNull();
    expect((container.querySelector(".hd-leadcard .hd-m") as HTMLElement).dataset.mascot).toBe("sonar-sweep");
    act(() => chooseFor("thr_n", null));
    expect((container.querySelector(".hd-leadcard .hd-m") as HTMLElement).dataset.mascot).toBe(N_ID);
  });

  it("is offered on every card's menu, and other cards never get it automatically", async () => {
    await loadStrips();
    const container = await panel("waiting");
    fireEvent.click(container.querySelector(".hd-leadcard .hd-mpick") as HTMLElement);
    const menu = within(container.querySelector(".hd-mchoose") as HTMLElement);
    expect(menu.getByText("Automatic (current)")).toBeTruthy();
    const { container: other } = render(<Mascot seed="agent_7" colour={PALETTE[0]!} state="wait" />);
    expect(other.querySelector("canvas.hd-navn")).toBeNull();
    expect((other.querySelector(".hd-m") as HTMLElement).dataset.mascot).not.toBe(N_ID);
  });
});

describe("the Mascots tab", () => {
  it("previews an animation first at 180 px, and the N on request, with a waiting state only it has", async () => {
    await loadStrips();
    const container = await panel("waiting");
    fireEvent.click(within(container).getByRole("tab", { name: "Mascots" }));
    expect(container.querySelector(".hd-mstage strong")?.textContent).toBe("Sphere Scan");
    expect((container.querySelector(".hd-mstage canvas") as HTMLCanvasElement).style.width).toBe("100%");
    expect(within(within(container).getByRole("group", { name: "Preview state" })).queryByText("Waiting for you")).toBeTruthy();
    fireEvent.click(within(container).getByText("Show the NavAIgate N"));
    expect(container.querySelector(".hd-mstage strong")?.textContent).toBe("NavAIgate N");
    fireEvent.click(within(within(container).getByRole("group", { name: "Preview state" })).getByText("Waiting for you"));
    expect((container.querySelector(".hd-mstage canvas.hd-navn") as HTMLCanvasElement).dataset.state).toBe("wait");
    fireEvent.pointerEnter(within(within(container).getByRole("group", { name: "Default mascots" })).getByText("Sonar Sweep").closest("button")!);
    expect(container.querySelector(".hd-mstage strong")?.textContent).toBe("Sonar Sweep");
  });
});

// @vitest-environment jsdom
// The one 3D mascot Helper Desk keeps: the NavAIgate N that the lead card wears. Every other avatar is a canvas
// animation (see avatars.test.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { CHARACTERS_3D, N_ID, PALETTE, animates, hexToRgb, loopFor, lookAt, lookForFrame, paletteIndex, statesFor } from "../mascots3d/catalog";
import { MAX_LIVE, claimSlot, holdsSlot, releaseSlot } from "../mascots3d/live";
import { fragmentFor } from "../mascots3d/shaders";
import { loadStrips, stripFor, stripKey } from "../mascots3d/strips";
import { STRIPS } from "../mascots3d/strips.generated";

afterEach(cleanup);

describe("the NavAIgate N", () => {
  it("is the only 3D character left, with a shader of its own", () => {
    expect(CHARACTERS_3D.map((c) => c.id)).toEqual([N_ID]);
    const src = fragmentFor(N_ID);
    expect(src.startsWith("#version 300 es")).toBe(true);
    expect(src).toContain("vec4 shade(");
    expect(src.split("{").length).toBe(src.split("}").length);
    expect(() => fragmentFor("glass")).toThrow();
  });

  it("is written here: no network, no outside code in the mascot sources", () => {
    const dir = join(__dirname, "..", "mascots3d");
    for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes("generated"))) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//);
      expect(text, f).not.toMatch(/from "three"|originkit/i);
    }
  });
});

describe("how a state moves", () => {
  it("loops working and idle, with a phase that wraps", () => {
    const loop = loopFor(N_ID, "work");
    expect(lookAt(N_ID, "work", 0).phase).toBe(0);
    expect(lookAt(N_ID, "work", loop.seconds).phase).toBeCloseTo(0, 6);
    expect(lookAt(N_ID, "work", loop.seconds * 1.25).phase).toBeCloseTo(0.25, 6);
    expect(lookAt(N_ID, "work", 1).energy).toBeGreaterThan(lookAt(N_ID, "idle", 1).energy);
  });

  it("settles once on done and then holds, and holds one grey pose on error", () => {
    expect(lookAt(N_ID, "done", 0)).toMatchObject({ settle: 0, glow: 0 });
    const end = lookAt(N_ID, "done", 5);
    expect(end.settle).toBe(1);
    expect(lookAt(N_ID, "done", 60)).toEqual(end);
    const err = lookAt(N_ID, "error", 0);
    expect(err.sat).toBeLessThan(0.2);
    expect(lookAt(N_ID, "error", 99)).toEqual(err);
    expect(animates("error") || animates("done")).toBe(false);
    expect(animates("work") && animates("idle")).toBe(true);
  });

  it("gives a strip frame the same look as the live renderer at that time", () => {
    const loop = loopFor(N_ID, "idle");
    for (const f of [0, 3, loop.frames - 1]) expect(lookForFrame(N_ID, "idle", f)).toEqual(lookAt(N_ID, "idle", (f / loop.frames) * loop.seconds));
  });

  it("turns a hex colour into shader input and finds the nearest card colour", () => {
    expect(hexToRgb("#ff8000")).toEqual([1, 128 / 255, 0]);
    PALETTE.forEach((c, i) => expect(paletteIndex(c)).toBe(i));
    expect(paletteIndex("#2f70e0")).toBe(1);
  });
});

describe("the pre-rendered loops", () => {
  it("holds one strip per state for the N and nothing for the characters that were removed", async () => {
    await loadStrips();
    for (const s of statesFor(N_ID)) expect(STRIPS[stripKey(N_ID, s, 0)], s).toMatch(/^data:image\/webp;base64,/);
    expect(Object.keys(STRIPS).sort()).toEqual(statesFor(N_ID).map((s) => `${N_ID}:${s}:0`).sort());
    expect(Object.values(STRIPS).reduce((n, s) => n + s.length, 0)).toBeLessThan(400 * 1024);
  });

  it("makes one CSS class per strip, shared by every card that uses it", async () => {
    await loadStrips();
    const a = stripFor(N_ID, "work", PALETTE[2]!)!;
    const b = stripFor(N_ID, "work", PALETTE[5]!)!;
    expect(a.className).toBe(b.className);
    expect(a.frames).toBe(loopFor(N_ID, "work").frames);
  });
});

describe("live slots", () => {
  it("lets only two mascots draw live at once, highest priority first, and frees a slot when one goes off screen", () => {
    const a = Symbol("coach");
    const b = Symbol("lead");
    const c = Symbol("stage");
    claimSlot(c, 1, true);
    claimSlot(b, 2, true);
    claimSlot(a, 3, true);
    expect(MAX_LIVE).toBe(2);
    expect([a, b, c].filter(holdsSlot)).toEqual([a, b]);
    claimSlot(b, 2, false);
    expect([a, b, c].filter(holdsSlot)).toEqual([a, c]);
    releaseSlot(a);
    claimSlot(b, 2, true);
    expect([a, b, c].filter(holdsSlot)).toEqual([b, c]);
    for (const k of [a, b, c]) releaseSlot(k);
    expect([a, b, c].filter(holdsSlot)).toEqual([]);
  });
});

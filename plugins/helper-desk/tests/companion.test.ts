import { describe, expect, it } from "vitest";
import { decide, isSend, perch, startleFrom, visitSpot, SLEEP_AFTER_MS, type BrainInput } from "../companionmodel";

const NOW = 1_000_000;
const base = (over: Partial<BrainInput> = {}): BrainInput => ({
  now: NOW, vw: 1440, vh: 900, size: 58,
  pos: { x: 1390, y: 700 }, pointer: null, pointerMovedAt: 0,
  field: null, lastKeyAt: 0, lastInputAt: NOW - 1000,
  mode: "waiting", composer: null, home: { x: 1390, y: 700 }, startle: null, prevIntent: "home",
  ...over,
});
const composer = { left: 520, top: 700, width: 680, height: 110 };

describe("send detection", () => {
  it("only Enter without Shift that empties a field with text counts", () => {
    expect(isSend(true, true, true)).toBe(true);
    expect(isSend(false, true, true)).toBe(false);
    expect(isSend(true, false, true)).toBe(false);
    expect(isSend(true, true, false)).toBe(false);
  });
});

describe("perching on a field", () => {
  it("sits on the top edge above the caret", () => {
    const p = perch(composer, { x: 700, y: 716 }, 58, 1440, 900);
    expect(p.x).toBe(700);
    expect(p.y + 29).toBe(700 - 6);
  });
  it("sits below a field with no room above", () => {
    const p = perch({ left: 60, top: 10, width: 200, height: 30 }, null, 58, 1440, 900);
    expect(p.y - 29).toBe(10 + 30 + 6);
  });
});

describe("the brain", () => {
  it("goes to the caret while you type and watches it", () => {
    const d = decide(base({ field: { box: composer, caret: { x: 800, y: 716 }, password: false, focusedAt: NOW - 20_000 }, lastKeyAt: NOW - 200 }));
    expect(d.intent).toBe("typing");
    expect(d.mood).toBe("watch");
    expect(d.target.x).toBe(800);
    expect(d.gaze).toEqual({ x: 800, y: 716 });
  });
  it("ponders when you pause typing", () => {
    const d = decide(base({ field: { box: composer, caret: null, password: false, focusedAt: NOW - 20_000 }, lastKeyAt: NOW - 2000 }));
    expect(d.mood).toBe("ponder");
  });
  it("lets an idle focused composer go after a while", () => {
    const d = decide(base({ field: { box: composer, caret: null, password: false, focusedAt: NOW - 60_000 }, lastKeyAt: NOW - 30_000 }));
    expect(d.intent).not.toBe("typing");
  });
  it("closes his eyes for a password", () => {
    const d = decide(base({ field: { box: composer, caret: null, password: true, focusedAt: NOW - 100 }, lastKeyAt: NOW - 100 }));
    expect(d.intent).toBe("password");
    expect(d.mood).toBe("sleep");
    expect(d.gaze).toBeNull();
  });
  it("goes to the composer when the chat needs you", () => {
    const d = decide(base({ mode: "needs", composer }));
    expect(d.intent).toBe("needs");
    expect(d.target.y).toBeLessThan(composer.top);
  });
  it("falls asleep after long quiet, but never while an agent works", () => {
    expect(decide(base({ lastInputAt: NOW - SLEEP_AFTER_MS - 1 })).intent).toBe("sleep");
    expect(decide(base({ lastInputAt: NOW - SLEEP_AFTER_MS - 1, mode: "working" })).intent).not.toBe("sleep");
  });
  it("visits a resting pointer, and holds still while it moves again", () => {
    const visit = decide(base({ pointer: { x: 600, y: 400 }, pointerMovedAt: NOW - 2000 }));
    expect(visit.intent).toBe("curious");
    expect(visit.gaze).toEqual({ x: 600, y: 400 });
    const moving = decide(base({ pointer: { x: 650, y: 420 }, pointerMovedAt: NOW - 50, prevIntent: "curious", pos: { x: 680, y: 330 } }));
    expect(moving.intent).toBe("curious");
    expect(moving.target).toEqual({ x: 680, y: 330 });
  });
  it("stays home and watches a moving pointer when not visiting", () => {
    const d = decide(base({ pointer: { x: 300, y: 300 }, pointerMovedAt: NOW - 50 }));
    expect(d.intent).toBe("home");
    expect(d.gaze).toEqual({ x: 300, y: 300 });
  });
});

describe("visiting and startling", () => {
  it("stands up and to the right of the pointer, mirrored at the edges", () => {
    const p = visitSpot({ x: 600, y: 400 }, 58, 1440, 900);
    expect(p.x).toBeGreaterThan(600);
    expect(p.y).toBeLessThan(400);
    const edge = visitSpot({ x: 1420, y: 20 }, 58, 1440, 900);
    expect(edge.x).toBeLessThan(1420);
    expect(edge.y).toBeGreaterThan(20);
  });
  it("hops away only from a fast, close pointer", () => {
    expect(startleFrom({ x: 500, y: 500 }, { x: 480, y: 500 }, 1200, 58, 1440, 900)!.x).toBeGreaterThan(500);
    expect(startleFrom({ x: 500, y: 500 }, { x: 480, y: 500 }, 200, 58, 1440, 900)).toBeNull();
    expect(startleFrom({ x: 500, y: 500 }, { x: 300, y: 500 }, 1200, 58, 1440, 900)).toBeNull();
  });
});

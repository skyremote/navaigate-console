import { describe, expect, it } from "vitest";
import { N_ICON_PATH, N_W, N_REACH, N_REACH_FILL, RING_DOT, RING_R, RING_PERIOD, ringDots, ringHead, drawNavN, idleSweep, workSweep, WORK_PERIOD, IDLE_PERIOD, STILL_T, OPEN_SECONDS, BRAND_BLUE, type NCtx } from "../avatars/nmark";
import { N_PATH } from "../mascots3d/navmark";

function recorder() {
  const log: string[] = [];
  let alpha = 1;
  let fill: unknown = "";
  const stops: string[] = [];
  const arcs: { x: number; y: number; r: number; a: number }[] = [];
  const ctx = {
    get globalAlpha() { return alpha; },
    set globalAlpha(v: number) { alpha = v; },
    get fillStyle() { return fill; },
    set fillStyle(v: unknown) { fill = v; },
    save: () => log.push("save"),
    restore: () => log.push("restore"),
    clearRect: (...a: number[]) => log.push(`clear ${a.join(",")}`),
    translate: () => undefined,
    scale: (x: number) => log.push(`scale ${x.toFixed(4)}`),
    beginPath: () => undefined,
    arc: (x: number, y: number, r: number) => (arcs.push({ x, y, r, a: alpha }), log.push(`dot ${r.toFixed(2)}`)),
    fill: (p?: unknown) => log.push(p ? `fillpath ${String(fill)}` : "fill"),
    clip: () => log.push("clip"),
    fillRect: () => log.push(`rect ${typeof fill === "string" ? fill : "gradient"} ${alpha.toFixed(3)}`),
    createLinearGradient: () => ({ addColorStop: (_: number, c: string) => stops.push(c) }),
  };
  return { ctx: ctx as unknown as NCtx, log, stops, arcs };
}

// jsdom has no Path2D; the drawing needs one, so give it a stand-in that only remembers its source.
(globalThis as { Path2D?: unknown }).Path2D ??= class { constructor(public d?: string) {} };

describe("the N the lead card wears", () => {
  it("is the brand icon path verbatim, the same one the favicon and the NavMotion logo set carry", () => {
    expect(N_ICON_PATH).toBe(N_PATH);
    expect(N_ICON_PATH.startsWith("M121.64 0.5C")).toBe(true);
    expect(N_W).toBeCloseTo(622.45, 2);
  });

  it("draws the mark flat in the page ink, scaled to the canvas, and leaves the context balanced", () => {
    const r = recorder();
    drawNavN(r.ctx, 48, STILL_T, { ink: "rgb(20, 20, 20)", moving: false });
    expect(r.log[0]).toBe("clear 0,0,48,48");
    expect(r.log).toContain("fillpath rgb(20, 20, 20)");
    const scale = Number(r.log.find((l) => l.startsWith("scale"))!.split(" ")[1]);
    expect(scale).toBeCloseTo((48 * N_REACH_FILL * 0.5) / N_REACH, 4);
    expect(r.log.filter((l) => l === "save").length).toBe(r.log.filter((l) => l === "restore").length);
  });

  it("holds the resting mark in a still frame: no sweep, no sheen", () => {
    const r = recorder();
    drawNavN(r.ctx, 48, STILL_T, { ink: "rgb(20, 20, 20)", moving: false });
    expect(r.log.some((l) => l.startsWith("rect"))).toBe(false);
    expect(idleSweep(STILL_T)).toBe(-1);
  });

  it("sweeps a light along the ribbon while idle, with long rests, and only in blue while working", () => {
    expect(idleSweep(0)).toBe(0);
    expect(idleSweep(IDLE_PERIOD * 0.15)).toBeGreaterThan(0.3);
    expect(idleSweep(IDLE_PERIOD * 0.6)).toBe(-1);
    expect(workSweep(0)).toBe(0);
    expect(workSweep(WORK_PERIOD * 0.41)).toBeGreaterThan(0.4);
    const idle = recorder();
    drawNavN(idle.ctx, 48, IDLE_PERIOD * 0.15, { ink: "rgb(20, 20, 20)" });
    expect(idle.stops.some((c) => c.includes("42,91,255"))).toBe(false);
    const work = recorder();
    drawNavN(work.ctx, 48, WORK_PERIOD * 0.4, { ink: "rgb(20, 20, 20)", work: 1 });
    expect(work.stops.some((c) => c.includes("42,91,255"))).toBe(true);
    expect(BRAND_BLUE).toBe("#2A5BFF");
  });

  it("fades the sweep out through its own colour, never through grey", () => {
    const r = recorder();
    drawNavN(r.ctx, 48, WORK_PERIOD * 0.4, { ink: "rgb(20, 20, 20)", work: 1 });
    expect(r.stops[0]).toBe("rgba(42,91,255,0)");
    expect(r.stops[2]).toBe("rgba(42,91,255,0)");
  });

  it("breathes the whole mark into the blue while it waits", () => {
    const r = recorder();
    drawNavN(r.ctx, 48, 1.2, { ink: "rgb(20, 20, 20)", wait: 1 });
    expect(r.log.some((l) => l.startsWith("rect #2A5BFF"))).toBe(true);
  });

  it("opens like the films: a dot first, then the mark grows out of it", () => {
    const dot = recorder();
    drawNavN(dot.ctx, 48, 0, { ink: "rgb(20, 20, 20)", born: 0.05 });
    expect(dot.log.some((l) => l.startsWith("dot"))).toBe(true);
    expect(dot.log.some((l) => l.startsWith("fillpath"))).toBe(false);
    const mid = recorder();
    drawNavN(mid.ctx, 48, 0, { ink: "rgb(20, 20, 20)", born: OPEN_SECONDS * 0.6 });
    expect(mid.log.some((l) => l.startsWith("fillpath"))).toBe(true);
    const done = recorder();
    drawNavN(done.ctx, 48, 0, { ink: "rgb(20, 20, 20)", born: null });
    expect(done.log.some((l) => l.startsWith("dot"))).toBe(false);
  });

  it("does not play the open in a still frame, and follows the overall alpha", () => {
    const r = recorder();
    drawNavN(r.ctx, 48, STILL_T, { ink: "rgb(20, 20, 20)", moving: false, born: 0.05, alpha: 0.4 });
    expect(r.log.some((l) => l.startsWith("dot"))).toBe(false);
    expect(r.log.some((l) => l.startsWith("fillpath"))).toBe(true);
  });

  it("lightens the sheen's colour for a dark page and a light page alike (it is lighter than ink on light, grey on dark)", () => {
    const light = recorder();
    drawNavN(light.ctx, 48, IDLE_PERIOD * 0.15, { ink: "rgb(20, 20, 20)" });
    const dark = recorder();
    drawNavN(dark.ctx, 48, IDLE_PERIOD * 0.15, { ink: "rgb(240, 240, 240)" });
    expect(light.stops[1]).toMatch(/^rgba\(255,255,255/);
    expect(dark.stops[1]).toMatch(/^rgba\(120,128,150/);
  });
});

describe("the orbit round the N", () => {
  const INK = "rgb(20, 20, 20)";
  const ringArcs = (r: ReturnType<typeof recorder>, size: number) => r.arcs.filter((a) => Math.hypot(a.x - size / 2, a.y - size / 2) > size * 0.3);

  it("is a ring of evenly spaced dots in the brand blue, with a larger, brighter head and a tail that fades behind it", () => {
    const r = recorder();
    drawNavN(r.ctx, 48, 0.7, { ink: INK, work: 1, ring: 1, born: null });
    const dots = ringArcs(r, 48);
    expect(dots.length).toBeGreaterThanOrEqual(ringDots(48));
    const head = ringHead(0.7, true);
    const R = 48 * RING_R;
    const hx = 24 + R * Math.cos(head);
    const hy = 24 + R * Math.sin(head);
    const biggest = dots.filter((d) => d.a > 0.5).reduce((m, d) => (d.r > m.r ? d : m));
    expect(Math.hypot(biggest.x - hx, biggest.y - hy)).toBeLessThan(0.5);
    expect(biggest.a).toBeCloseTo(1, 2);
    // the dots behind the head get fainter and smaller, one after another
    const step = (Math.PI * 2) / ringDots(48);
    const behind = [1, 2, 3, 4].map((i) => dots.find((d) => Math.hypot(d.x - (24 + R * Math.cos(head - i * step)), d.y - (24 + R * Math.sin(head - i * step))) < 0.3 && d.r < biggest.r)!);
    for (let i = 1; i < behind.length; i++) {
      expect(behind[i]!.a).toBeLessThan(behind[i - 1]!.a);
      expect(behind[i]!.r).toBeLessThanOrEqual(behind[i - 1]!.r);
    }
  });

  it("turns one full circle in its period, clockwise, and sits at the top when held still", () => {
    expect(ringHead(0, true)).toBeCloseTo(-Math.PI / 2, 6);
    expect(ringHead(RING_PERIOD / 4, true)).toBeCloseTo(0, 6);
    expect(ringHead(RING_PERIOD / 2, true)).toBeCloseTo(Math.PI / 2, 6);
    expect(ringHead(1.234, false)).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("stays inside the canvas at every moment and clear of the N, at every size the N is worn at", () => {
    for (const size of [24, 32, 48, 56, 64, 96, 192]) {
      for (let i = 0; i < 40; i++) {
        const r = recorder();
        drawNavN(r.ctx, size, (i / 40) * RING_PERIOD, { ink: INK, work: 1, ring: 1, born: null });
        for (const d of ringArcs(r, size)) {
          expect(d.x - d.r, `${size}`).toBeGreaterThanOrEqual(0);
          expect(d.x + d.r).toBeLessThanOrEqual(size);
          expect(d.y - d.r).toBeGreaterThanOrEqual(0);
          expect(d.y + d.r).toBeLessThanOrEqual(size);
        }
      }
      // the N's farthest point is inside the ring's inner edge
      const reach = (size * N_REACH_FILL) / 2;
      expect(reach + 1).toBeLessThan(size * RING_R - Math.max(size * RING_DOT * 0.46, 0.55));
    }
  });

  it("draws no ring while idle, done or in error, and the same N whether or not the ring is up", () => {
    const idle = recorder();
    drawNavN(idle.ctx, 48, 1, { ink: INK, born: null });
    expect(ringArcs(idle, 48)).toHaveLength(0);
    const up = recorder();
    drawNavN(up.ctx, 48, 1, { ink: INK, ring: 1, born: null });
    expect(up.log.find((l) => l.startsWith("scale"))).toBe(idle.log.find((l) => l.startsWith("scale")));
  });

  it("eases in and out: fainter and smaller part-way, never popping", () => {
    const at = (ring: number) => {
      const r = recorder();
      drawNavN(r.ctx, 48, 0.7, { ink: INK, work: ring, ring, born: null });
      const dots = ringArcs(r, 48);
      return dots.reduce((m, d) => (d.a > m ? d.a : m), 0);
    };
    expect(at(0)).toBe(0);
    expect(at(0.2)).toBeGreaterThan(0);
    expect(at(0.2)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(1));
  });

  it("holds a still ring with the head at the top under reduced motion", () => {
    const r = recorder();
    drawNavN(r.ctx, 48, STILL_T, { ink: INK, moving: false, work: 1, ring: 1 });
    const biggest = ringArcs(r, 48).filter((d) => d.a > 0.5).reduce((m, d) => (d.r > m.r ? d : m));
    expect(biggest.x).toBeCloseTo(24, 3);
    expect(biggest.y).toBeLessThan(24 - 48 * RING_R + 0.5);
  });
});

describe("how the N blends between states", () => {
  it("brings the orbit in for working and waiting only, eased over the blend time, and holds the end value when still", async () => {
    const { blendAt, targetsFor, BLEND_SECONDS, HOLD_AFTER_SECONDS } = await import("../avatars/NavN");
    expect(targetsFor("work").ring).toBe(1);
    expect(targetsFor("wait").ring).toBe(1);
    for (const s of ["idle", "done", "error"] as const) expect(targetsFor(s).ring).toBe(0);
    const b = { from: targetsFor("idle"), to: targetsFor("work"), since: 1000 };
    expect(blendAt(b, 1000).ring).toBe(0);
    const mid = blendAt(b, 1000 + (BLEND_SECONDS * 1000) / 2).ring;
    expect(mid).toBeCloseTo(0.5, 5);
    expect(blendAt(b, 1000 + BLEND_SECONDS * 1000).ring).toBe(1);
    expect(blendAt(b, 1100, false).ring).toBe(1);
    // going back out eases down the same way
    const out = { from: targetsFor("work"), to: targetsFor("done"), since: 2000 };
    expect(blendAt(out, 2000 + BLEND_SECONDS * 500).ring).toBeCloseTo(0.5, 5);
    // a held state keeps playing long enough for the orbit to finish going out
    expect(HOLD_AFTER_SECONDS).toBeGreaterThan(BLEND_SECONDS);
  });
});

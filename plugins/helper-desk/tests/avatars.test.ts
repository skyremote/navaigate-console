import { describe, expect, it } from "vitest";
import { ANIMATIONS, ANIMATION_IDS, animationById, easeInOutCubic, type Ctx2D } from "../avatars/animations";
import { animationFor, hashId, lookFor, startOffset } from "../avatars/assign";
import { AvatarLoop, CROWD, MAX_FPS, fpsFor, rateFor, inkChangeGate, lightness, liveBlue, type LoopEnv } from "../avatars/engine";

/** A 2D context that records what is drawn instead of drawing it. */
function recorder() {
  const log: string[] = [];
  const dots: { x: number; y: number; r: number; a: number }[] = [];
  const ends: number[][] = [];
  let alpha = 1;
  let depth = 0;
  let saves = 0;
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(v: number) {
      alpha = v;
    },
    clearRect: (...a: number[]) => log.push(`clear ${a.join(",")}`),
    save: () => {
      depth++;
      saves++;
    },
    restore: () => void depth--,
    scale: (x: number, y: number) => log.push(`scale ${x.toFixed(4)},${y.toFixed(4)}`),
    beginPath: () => undefined,
    arc: (x: number, y: number, r: number) => {
      dots.push({ x, y, r, a: alpha });
      log.push(`arc ${x.toFixed(2)},${y.toFixed(2)},${r.toFixed(2)},${alpha.toFixed(3)}`);
    },
    fill: () => undefined,
    moveTo: (x: number, y: number) => ends.push([x, y]),
    lineTo: (x: number, y: number) => {
      ends.push([x, y]);
      log.push(`line ${x.toFixed(2)},${y.toFixed(2)},${alpha.toFixed(3)}`);
    },
    stroke: () => undefined,
  };
  return { ctx: ctx as unknown as Ctx2D, raw: ctx, log, dots, ends, balanced: () => depth === 0 && saves > 0 };
}

const draw = (id: string, size: number, t: number, alpha?: number) => {
  const r = recorder();
  animationById(id)!.draw(r.ctx, size, t, { ink: "rgb(10, 20, 30)", alpha });
  return r;
};

describe("the nine animations", () => {
  it("are the nine from the 21st.dev set, each with a name, a description and a still frame", () => {
    expect(ANIMATION_IDS).toEqual(["sphere-scan", "crystalline-refraction", "sonar-sweep", "helix-scanner", "interconnecting-waves", "cylindrical-analysis", "voxel-matrix-morph", "phased-array-emitter", "crystalline-cube-refraction"]);
    expect(new Set(ANIMATIONS.map((a) => a.name)).size).toBe(9);
    for (const a of ANIMATIONS) {
      expect(a.about.length).toBeGreaterThan(20);
      expect(draw(a.id, 180, a.still).dots.length, a.id).toBeGreaterThan(10);
    }
  });

  it("draw the same frame for the same time, a different one later, and leave the context as they found it", () => {
    for (const a of ANIMATIONS) {
      const one = draw(a.id, 180, 3.3);
      expect(draw(a.id, 180, 3.3).log, a.id).toEqual(one.log);
      expect(draw(a.id, 180, 4.1).log, a.id).not.toEqual(one.log);
      expect(one.balanced(), a.id).toBe(true);
      expect(one.raw.fillStyle).toBe("rgb(10, 20, 30)");
      expect(one.log[0]).toBe("clear 0,0,180,180");
    }
  });

  it("scale from a 24 px list row to the 180 px panel: same drawing in 180-unit space, scaled to the canvas", () => {
    for (const a of ANIMATIONS) {
      for (const size of [24, 48, 96, 180]) {
        const r = draw(a.id, size, 2.2);
        expect(r.log[0], a.id).toBe(`clear 0,0,${size},${size}`);
        expect(r.log[1], a.id).toBe(`scale ${(size / 180).toFixed(4)},${(size / 180).toFixed(4)}`);
        expect(r.dots.length, `${a.id} at ${size}`).toBeGreaterThan(10);
      }
    }
  });

  it("keep every dot and line end inside the canvas at every moment", () => {
    for (const a of ANIMATIONS) {
      for (let t = 0; t < 40; t += 0.37) {
        const r = draw(a.id, 180, t);
        for (const d of r.dots) {
          expect(d.x - d.r, `${a.id} t=${t}`).toBeGreaterThanOrEqual(-1);
          expect(d.x + d.r, `${a.id} t=${t}`).toBeLessThanOrEqual(181);
          expect(d.y - d.r, `${a.id} t=${t}`).toBeGreaterThanOrEqual(-1);
          expect(d.y + d.r, `${a.id} t=${t}`).toBeLessThanOrEqual(181);
        }
        for (const [x, y] of r.ends) expect(x >= 0 && x <= 180 && y >= 0 && y <= 180, a.id).toBe(true);
      }
    }
  }, 30_000);

  it("thicken dots at small sizes so they stay at least about half a pixel, without growing at 180 px", () => {
    for (const a of ANIMATIONS) {
      const small = draw(a.id, 24, a.still);
      const smallPx = Math.max(...small.dots.map((d) => d.r)) * (24 / 180);
      expect(smallPx, a.id).toBeGreaterThan(0.45);
      for (const d of small.dots) expect(d.r * (24 / 180), a.id).toBeGreaterThanOrEqual(0.39);
      const large = draw(a.id, 180, a.still);
      expect(Math.max(...large.dots.map((d) => d.r)), a.id).toBeLessThan(7.5);
    }
  });

  it("keep alpha within 0 to 1 and follow the overall alpha they are given", () => {
    for (const a of ANIMATIONS) {
      const full = draw(a.id, 180, a.still, 1);
      const faint = draw(a.id, 180, a.still, 0.4);
      expect(Math.max(...full.dots.map((d) => d.a)), a.id).toBeLessThanOrEqual(1);
      expect(Math.min(...full.dots.map((d) => d.a)), a.id).toBeGreaterThan(0);
      expect(Math.max(...faint.dots.map((d) => d.a)), a.id).toBeLessThanOrEqual(0.4 + 1e-9);
    }
  });

  it("use one ink colour and no gold or fixed white", () => {
    for (const a of ANIMATIONS) {
      const r = recorder();
      a.draw(r.ctx, 180, 1, { ink: "#2f6fe0" });
      expect(r.raw.fillStyle).toBe("#2f6fe0");
      expect(r.raw.strokeStyle).toBe("#2f6fe0");
    }
  });

  it("ease in and out", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
  });
});

describe("which animation an agent wears", () => {
  const IDS = Array.from({ length: 60 }, (_, i) => `toolu_01${(i * 7919).toString(36)}x${i}`);

  it("is stable for an id and spread across the nine", () => {
    for (const id of IDS) expect(animationFor(id)).toBe(animationFor(id));
    expect(hashId("toolu_a")).toBe(hashId("toolu_a"));
    expect(hashId("toolu_a")).not.toBe(hashId("toolu_b"));
    expect(new Set(IDS.map((id) => animationFor(id))).size).toBeGreaterThanOrEqual(8);
  });

  it("lets a pick win, ignores an unknown pick, and rotates only through the default set", () => {
    const hashed = animationFor(IDS[0]!);
    const other = ANIMATION_IDS.find((a) => a !== hashed)!;
    expect(animationFor(IDS[0]!, { pick: other })).toBe(other);
    expect(animationFor(IDS[0]!, { pick: "pip" })).toBe(hashed);
    expect(animationFor(IDS[0]!, { pick: null })).toBe(hashed);
    expect([...new Set(IDS.map((id) => animationFor(id, { set: ["sonar-sweep", "helix-scanner"] })))].sort()).toEqual(["helix-scanner", "sonar-sweep"]);
    expect(animationFor(IDS[1]!, { set: ["sonar-sweep"], pick: "sphere-scan" })).toBe("sphere-scan");
    for (const id of IDS) {
      expect(animationFor(id, { set: [] })).toBe(animationFor(id));
      expect(animationFor(id, { set: ["zzz"] })).toBe(animationFor(id));
      expect(animationFor(id, { set: ANIMATION_IDS })).toBe(animationFor(id));
    }
  });

  it("starts neighbours out of step", () => {
    const offsets = IDS.map(startOffset);
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...offsets)).toBeLessThan(20);
    expect(new Set(offsets.map((o) => o.toFixed(2))).size).toBeGreaterThan(50);
  });

  it("shows a running agent in the soft blue and everything else in the ink colour", () => {
    expect(lookFor("work").tone).toBe("live");
    for (const s of ["idle", "wait", "done", "error"] as const) expect(lookFor(s).tone, s).toBe("ink");
    expect(lookFor("work", true).tone).toBe("ink");
    expect(lookFor("done").speed).toBe(0);
    expect(lookFor("error").speed).toBe(0);
    expect(lookFor("work").speed).toBeGreaterThan(lookFor("idle").speed);
  });

  it("picks a lighter blue on a dark page and a deeper one on a light page", () => {
    expect(liveBlue("rgb(236, 236, 240)")).toBe("#7eb0ff");
    expect(liveBlue("rgb(29, 29, 31)")).toBe("#2f6fe0");
    expect(lightness("rgb(255, 255, 255)")).toBeCloseTo(1, 5);
    expect(lightness("rgb(0, 0, 0)")).toBe(0);
  });
});

/** A manual clock, requestAnimationFrame and setTimeout, so the loop can be run for seconds in microseconds. */
function world(over: Partial<{ hidden: boolean; reduced: boolean; dpr: number }> = {}) {
  const state = { hidden: false, reduced: false, dpr: 1, ...over };
  let next = 1;
  let pending: { id: number; cb: (n: number) => void } | null = null;
  let maxPending = 0;
  let queued = 0;
  let now = 1000;
  let timers: { id: number; at: number; cb: () => void }[] = [];
  const env: LoopEnv = {
    raf: (cb) => {
      queued++;
      if (pending) throw new Error("two animation frames requested at once");
      pending = { id: next++, cb };
      maxPending = Math.max(maxPending, 1);
      return pending.id;
    },
    caf: (id) => {
      if (pending?.id === id) pending = null;
    },
    hidden: () => state.hidden,
    reducedMotion: () => state.reduced,
    dpr: () => state.dpr,
    now: () => now,
    after: (ms, cb) => {
      const id = next++;
      timers.push({ id, at: now + ms, cb });
      return id;
    },
    cancelAfter: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  const loop = new AvatarLoop(env);
  return {
    state,
    loop,
    get queued() {
      return queued;
    },
    get waiting() {
      return pending !== null;
    },
    get timersWaiting() {
      return timers.length;
    },
    /** Runs a 60 Hz display for `ms`. */
    run(ms: number) {
      const end = now + ms;
      while (now < end) {
        now += 1000 / 60;
        const due = timers.filter((t) => t.at <= now);
        timers = timers.filter((t) => t.at > now);
        for (const t of due) t.cb();
        const p = pending;
        pending = null;
        p?.cb(now);
      }
    },
  };
}

function client(sizePx: number, over: Record<string, unknown> = {}) {
  const draws: { t: number; ink: string; alpha: number | undefined }[] = [];
  const transforms: number[][] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ setTransform: (...a: number[]) => transforms.push(a) }),
  } as unknown as HTMLCanvasElement;
  let inkReads = 0;
  const spec = {
    canvas,
    size: sizePx,
    speed: 1,
    still: 2,
    offset: 0,
    draw: (_ctx: unknown, _size: number, t: number, style: { ink: string; alpha?: number }) => void draws.push({ t, ink: style.ink, alpha: style.alpha }),
    ink: () => `ink${++inkReads}`,
    ...over,
  };
  return { spec, canvas, draws, transforms, inkReads: () => inkReads };
}

describe("the shared loop", () => {
  it("serves thirty avatars with one animation frame at a time, capped at 30 frames a second", () => {
    const w = world();
    const cs = Array.from({ length: 30 }, () => client(96));
    for (const c of cs) w.loop.register(c.spec);
    w.run(2000);
    for (const c of cs) expect(c.draws.length).toBeGreaterThanOrEqual(58);
    for (const c of cs) expect(c.draws.length).toBeLessThanOrEqual(62);
    expect(w.loop.stats().frames).toBe(cs.reduce((n, c) => n + c.draws.length, 0));
    expect(MAX_FPS).toBe(30);
  });

  it("draws small avatars less often, and slower again in a crowd", () => {
    expect(fpsFor(180, 1)).toBe(30);
    expect(fpsFor(48, 1)).toBeLessThan(30);
    expect(fpsFor(24, 1)).toBeLessThan(fpsFor(48, 1));
    expect(fpsFor(24, CROWD + 1)).toBeLessThan(fpsFor(24, 1));
    const w = world();
    const one = client(24);
    w.loop.register(one.spec);
    w.run(2000);
    expect(one.draws.length).toBeGreaterThanOrEqual(22);
    expect(one.draws.length).toBeLessThanOrEqual(26);
    const crowd = world();
    const rows = Array.from({ length: CROWD + 4 }, () => client(24));
    for (const r of rows) crowd.loop.register(r.spec);
    crowd.run(2000);
    expect(rows[0]!.draws.length).toBeLessThanOrEqual(18);
    expect(rows[0]!.draws.length).toBeGreaterThanOrEqual(14);
  });

  it("advances time at the avatar's own speed, from its own offset", () => {
    const w = world();
    const c = client(180, { speed: 2, offset: 5 });
    w.loop.register(c.spec);
    w.run(1000);
    expect(c.draws[0]!.t).toBe(5);
    expect(c.draws.at(-1)!.t).toBeGreaterThan(6.8);
    expect(c.draws.at(-1)!.t).toBeLessThan(7.2);
  });

  it("asks for no frames at all while the tab is hidden, and resumes when it shows", () => {
    const w = world({ hidden: true });
    const c = client(180);
    w.loop.register(c.spec);
    expect(w.waiting).toBe(false);
    expect(w.queued).toBe(0);
    w.run(500);
    expect(c.draws).toHaveLength(0);
    w.state.hidden = false;
    w.loop.wake();
    w.run(500);
    expect(c.draws.length).toBeGreaterThan(10);
  });

  it("stops asking for frames when the tab hides mid-run and does not replay the gap on return", () => {
    const w = world();
    const c = client(180);
    w.loop.register(c.spec);
    w.run(500);
    w.state.hidden = true;
    w.run(100);
    expect(w.waiting).toBe(false);
    const before = c.draws.length;
    const t = c.draws.at(-1)!.t;
    w.state.hidden = false;
    w.loop.wake();
    w.run(100);
    expect(c.draws.length).toBeGreaterThan(before);
    expect(c.draws.at(-1)!.t - t).toBeLessThan(0.6);
  });

  it("skips an off-screen avatar, goes to sleep when all are off screen, and redraws at once on return", () => {
    const w = world();
    const a = client(96);
    const b = client(96);
    w.loop.register(a.spec);
    w.loop.register(b.spec);
    w.run(300);
    w.loop.setVisible(a.canvas, false);
    const before = a.draws.length;
    w.run(300);
    expect(a.draws.length).toBe(before);
    expect(b.draws.length).toBeGreaterThan(before);
    w.loop.setVisible(b.canvas, false);
    w.run(100);
    expect(w.waiting).toBe(false);
    w.loop.setVisible(a.canvas, true);
    w.run(50);
    expect(a.draws.length).toBeGreaterThan(before);
  });

  it("honours reduced motion with one still frame and no loop", () => {
    const w = world({ reduced: true });
    const c = client(96);
    w.loop.register(c.spec);
    w.run(1000);
    expect(c.draws).toHaveLength(1);
    expect(c.draws[0]!.t).toBe(2);
    expect(w.waiting).toBe(false);
  });

  it("draws a held avatar (done or failed) once at its still moment, and not again until something changes", () => {
    const w = world();
    const c = client(96, { speed: 0, still: 3.5 });
    const handle = w.loop.register(c.spec)!;
    w.run(1000);
    expect(c.draws).toHaveLength(1);
    expect(c.draws[0]!.t).toBe(3.5);
    expect(w.waiting).toBe(false);
    handle.update({ speed: 1 });
    w.run(300);
    expect(c.draws.length).toBeGreaterThan(3);
    handle.update({ speed: 0, alpha: 0.4 });
    w.run(200);
    expect(c.draws.at(-1)!.alpha).toBe(0.4);
  });

  it("re-reads the ink and repaints every avatar when the theme changes", () => {
    const w = world();
    const still = client(96, { speed: 0 });
    const moving = client(96);
    w.loop.register(still.spec);
    w.loop.register(moving.spec);
    w.run(200);
    expect(still.draws).toHaveLength(1);
    expect(still.draws[0]!.ink).toBe("ink1");
    expect(still.inkReads()).toBe(1);
    w.loop.invalidate();
    w.run(100);
    expect(still.draws).toHaveLength(2);
    expect(still.draws[1]!.ink).toBe("ink2");
    expect(moving.inkReads()).toBe(2);
  });

  it("repaints only the avatar whose own state changed, and every avatar when the theme changes", () => {
    const w = world();
    const a = client(96, { speed: 0 });
    const b = client(96, { speed: 0 });
    const ha = w.loop.register(a.spec)!;
    w.loop.register(b.spec);
    w.run(200);
    expect([a.inkReads(), b.inkReads()]).toEqual([1, 1]);
    ha.update({ alpha: 0.5 });
    ha.refreshInk();
    w.run(200);
    expect(a.draws).toHaveLength(2);
    expect(a.draws[1]!.ink).toBe("ink2");
    expect(b.draws).toHaveLength(1);
    expect(b.inkReads()).toBe(1);
    w.loop.invalidate();
    w.run(200);
    expect([a.inkReads(), b.inkReads()]).toEqual([3, 2]);
  });

  it("does not request a frame at the display rate while nothing is due: a timer waits for the next draw", () => {
    const w = world();
    const c = client(24);
    w.loop.register(c.spec);
    w.run(2000);
    expect(c.draws.length).toBeGreaterThanOrEqual(22);
    expect(c.draws.length).toBeLessThanOrEqual(26);
    // 120 display frames in two seconds; a 12 fps avatar needs about two requests per draw, not one per display frame.
    expect(w.queued).toBeLessThanOrEqual(c.draws.length * 2 + 2);
    w.run(10);
    expect(w.loop.stats().running).toBe(true);
    const slow = world();
    const rows = Array.from({ length: CROWD + 4 }, () => client(24));
    for (const r of rows) slow.loop.register(r.spec);
    slow.run(2000);
    expect(slow.queued).toBeLessThan(60);
  });

  it("wakes at once for a change even while a timer is waiting for the next scheduled draw", () => {
    const w = world();
    const c = client(24);
    const h = w.loop.register(c.spec)!;
    w.run(100);
    expect(w.timersWaiting).toBe(1);
    const before = c.draws.length;
    h.update({ alpha: 0.3 });
    w.run(50);
    expect(c.draws.length).toBeGreaterThan(before);
    expect(c.draws.at(-1)!.alpha).toBe(0.3);
  });

  it("cancels the waiting timer when the last avatar goes", () => {
    const w = world();
    const h = w.loop.register(client(24).spec)!;
    w.run(100);
    expect(w.timersWaiting).toBe(1);
    h.dispose();
    expect(w.timersWaiting).toBe(0);
    expect(w.loop.stats().running).toBe(false);
  });

  it("backs the canvas at the device pixel ratio and draws in CSS pixels", () => {
    const w = world({ dpr: 2 });
    const c = client(24, { speed: 0 });
    w.loop.register(c.spec);
    w.run(100);
    expect(c.canvas.width).toBe(48);
    expect(c.canvas.height).toBe(48);
    expect(c.transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
    w.state.dpr = 1.5;
    w.loop.invalidate();
    w.run(100);
    expect(c.canvas.width).toBe(36);
    expect(c.transforms.at(-1)![0]).toBeCloseTo(1.5, 9);
  });

  it("cancels its animation frame when the last avatar goes, and lets a null context pass quietly", () => {
    const w = world();
    const c = client(96);
    const handle = w.loop.register(c.spec)!;
    expect(w.waiting).toBe(true);
    handle.dispose();
    expect(w.waiting).toBe(false);
    expect(w.loop.stats().clients).toBe(0);
    const none = { ...client(96).spec, canvas: { getContext: () => null } as unknown as HTMLCanvasElement };
    expect(w.loop.register(none)).toBeNull();
  });
});

describe("an avatar that asks for its own rate (the NavAIgate N)", () => {
  it("never draws faster than the 30 fps cap, and a small one still gets the full rate it asked for", () => {
    expect(rateFor({ size: 24, fps: MAX_FPS }, 40)).toBe(30);
    expect(rateFor({ size: 48, fps: 90 }, 1)).toBe(30);
    expect(rateFor({ size: 48 }, 1)).toBe(fpsFor(48, 1));
    const w = world();
    const n = client(48, { fps: MAX_FPS });
    w.loop.register(n.spec);
    w.run(2000);
    expect(n.draws.length).toBeGreaterThanOrEqual(58);
    expect(n.draws.length).toBeLessThanOrEqual(62);
  });

  it("tells the drawing whether it is playing or holding a still frame", () => {
    const seen: (boolean | undefined)[] = [];
    const w = world();
    const n = client(48, { fps: MAX_FPS, draw: (_c: unknown, _s: number, _t: number, st: { moving?: boolean }) => void seen.push(st.moving) });
    w.loop.register(n.spec);
    w.run(200);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((m) => m === true)).toBe(true);
    const still: (boolean | undefined)[] = [];
    const r = world({ reduced: true });
    const m = client(48, { fps: MAX_FPS, draw: (_c: unknown, _s: number, _t: number, st: { moving?: boolean }) => void still.push(st.moving) });
    r.loop.register(m.spec);
    r.run(500);
    expect(still).toEqual([false]);
  });
});

describe("the theme watcher's gate", () => {
  it("lets a repaint through only when the resolved colour changed", () => {
    let colour = "rgb(0, 0, 0)|a|b";
    const changed = inkChangeGate(() => colour);
    expect(changed()).toBe(false);
    expect(changed()).toBe(false);
    colour = "rgb(255, 255, 255)|a|b";
    expect(changed()).toBe(true);
    expect(changed()).toBe(false);
  });
});

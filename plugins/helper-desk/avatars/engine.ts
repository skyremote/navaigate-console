// The one animation loop behind every Helper Desk avatar. All visible avatars share a single
// requestAnimationFrame, capped at 30 frames a second. The loop sleeps (no frame requested at all) when the tab
// is hidden, when every avatar is off screen or still, and under prefers-reduced-motion, where each avatar
// draws one still frame. Small avatars in long lists draw less often. There are no per-avatar timers: when the
// next draw is more than a display frame away, one shared timer waits for it instead of requesting a frame at the
// screen's refresh rate to find that nothing is due.
import type { DrawFn } from "./animations";

export const MAX_FPS = 30;
/** Past this many visible avatars, the small ones in the list slow down further. */
export const CROWD = 8;
/** The share of the frame interval a frame may arrive early and still count, so a 60 Hz display really gets 30 fps. */
const SLACK_MS = 2;
/** A long gap (a tab that was hidden) is not played back as one giant step. */
const MAX_STEP_S = 0.25;
/** When the next draw is further off than this, a timer waits for it; nearer, a frame is requested. */
const FRAME_AHEAD_MS = 20;
/** The timer fires this long before the draw is due, so a late timer still lands on the right display frame. */
const TIMER_LEAD_MS = 16;

/** How often an avatar redraws: big ones at the cap, small list rows slower, slower again in a crowd. An avatar can ask for its own rate. */
export function rateFor(spec: { size: number; fps?: number }, visibleAnimated: number): number {
  return spec.fps ? Math.min(MAX_FPS, spec.fps) : fpsFor(spec.size, visibleAnimated);
}

/** The default rate by size. */
export function fpsFor(size: number, visibleAnimated: number): number {
  if (size <= 32) return visibleAnimated > CROWD ? 8 : 12;
  if (size <= 64) return visibleAnimated > CROWD * 2 ? 15 : 20;
  return MAX_FPS;
}

export interface LoopEnv {
  raf(cb: (now: number) => void): number;
  caf(id: number): void;
  hidden(): boolean;
  reducedMotion(): boolean;
  dpr(): number;
  /** The clock `raf` timestamps come from (performance.now). */
  now(): number;
  after(ms: number, cb: () => void): number;
  cancelAfter(id: number): void;
}

export interface AvatarSpec {
  canvas: HTMLCanvasElement;
  draw: DrawFn;
  /** CSS pixels, square. */
  size: number;
  /** Reads the colour to draw in; called again when the theme changes. */
  ink(): string;
  /** Seconds of animation per second of wall time. 0 holds a still frame. */
  speed: number;
  /** The moment drawn while still. */
  still: number;
  /** Redraw rate to ask for, capped at MAX_FPS. Left out, the rate follows the size (small avatars draw less often). */
  fps?: number;
  /** Where in its cycle this avatar starts, so neighbours do not move in step. */
  offset: number;
  /** 0 to 1. */
  alpha?: number;
}

export interface AvatarHandle {
  update(patch: Partial<Pick<AvatarSpec, "speed" | "alpha" | "draw" | "still" | "fps">>): void;
  /** Re-reads this avatar's ink and repaints it, leaving every other avatar alone. */
  refreshInk(): void;
  dispose(): void;
}

interface Client extends AvatarSpec {
  ctx: CanvasRenderingContext2D;
  t: number;
  lastDraw: number;
  visible: boolean;
  dirty: boolean;
  inkVersion: number;
  ink_: string;
  backing: number;
  frames: number;
}

export interface LoopStats {
  clients: number;
  visible: number;
  animating: number;
  frames: number;
  rafRequests: number;
  running: boolean;
}

export class AvatarLoop {
  private readonly clients = new Set<Client>();
  private raf = 0;
  private timer = 0;
  private lastTick = -1e9;
  private inkVersion = 0;
  private frames = 0;
  private rafRequests = 0;

  constructor(private readonly env: LoopEnv) {}

  register(spec: AvatarSpec): AvatarHandle | null {
    const ctx = spec.canvas.getContext("2d");
    if (!ctx) return null;
    const c: Client = { ...spec, ctx, t: spec.offset, lastDraw: -1, visible: true, dirty: true, inkVersion: -1, ink_: "", backing: 0, frames: 0 };
    this.clients.add(c);
    this.wake();
    return {
      update: (patch) => {
        Object.assign(c, patch);
        c.dirty = true;
        this.wake();
      },
      refreshInk: () => {
        c.inkVersion = -1;
        c.dirty = true;
        this.wake();
      },
      dispose: () => {
        this.clients.delete(c);
        if (!this.clients.size) this.sleep();
      },
    };
  }

  /** An off-screen avatar is skipped; coming back on screen redraws it at once. */
  setVisible(canvas: HTMLCanvasElement, visible: boolean) {
    for (const c of this.clients) {
      if (c.canvas !== canvas) continue;
      if (visible && !c.visible) c.dirty = true;
      c.visible = visible;
    }
    this.wake();
  }

  /** The theme or the reduced-motion setting changed: every avatar repaints. */
  invalidate() {
    this.inkVersion++;
    for (const c of this.clients) c.dirty = true;
    this.wake();
  }

  stats(): LoopStats {
    let visible = 0;
    let animating = 0;
    for (const c of this.clients) {
      if (c.visible) visible++;
      if (this.moves(c)) animating++;
    }
    return { clients: this.clients.size, visible, animating, frames: this.frames, rafRequests: this.rafRequests, running: this.raf !== 0 || this.timer !== 0 };
  }

  /** Starts the loop if anything needs frames. Safe to call as often as you like. */
  wake() {
    if (this.raf || this.env.hidden()) return;
    if (this.timer) {
      this.env.cancelAfter(this.timer);
      this.timer = 0;
    }
    const wait = this.untilNext(this.env.now());
    if (wait === null) return;
    if (wait > FRAME_AHEAD_MS) {
      this.timer = this.env.after(wait - TIMER_LEAD_MS, () => {
        this.timer = 0;
        this.wake();
      });
      return;
    }
    this.rafRequests++;
    this.raf = this.env.raf((now) => this.tick(now));
  }

  /** Milliseconds until a visible avatar next needs a draw (0 if one is due now), or null when none does. */
  private untilNext(now: number): number | null {
    let animated = 0;
    for (const c of this.clients) if (c.visible && this.moves(c)) animated++;
    let wait: number | null = null;
    for (const c of this.clients) {
      if (!c.visible) continue;
      let at: number;
      if (c.dirty || (this.moves(c) && c.lastDraw < 0)) at = now;
      else if (this.moves(c)) at = c.lastDraw + 1000 / rateFor(c, animated) - SLACK_MS;
      else continue;
      const left = at - now;
      wait = wait === null ? left : Math.min(wait, left);
    }
    if (wait === null) return null;
    return Math.max(wait, this.lastTick + 1000 / MAX_FPS - SLACK_MS - now, 0);
  }

  private sleep() {
    if (this.raf) this.env.caf(this.raf);
    this.raf = 0;
    if (this.timer) this.env.cancelAfter(this.timer);
    this.timer = 0;
  }

  private moves(c: Client): boolean {
    return c.speed > 0 && !this.env.reducedMotion();
  }

  /** Exposed for tests; the real loop calls it from requestAnimationFrame. */
  tick(now: number) {
    this.raf = 0;
    if (this.env.hidden()) return;
    if (now - this.lastTick < 1000 / MAX_FPS - SLACK_MS) {
      this.wake();
      return;
    }
    let animated = 0;
    for (const c of this.clients) if (c.visible && this.moves(c)) animated++;
    let drew = false;
    for (const c of this.clients) {
      if (!c.visible) continue;
      const due = this.moves(c) && (c.lastDraw < 0 || now - c.lastDraw >= 1000 / rateFor(c, animated) - SLACK_MS);
      if (c.dirty || due) {
        this.paint(c, now);
        drew = true;
      }
    }
    if (drew) this.lastTick = now;
    this.wake();
  }

  private paint(c: Client, now: number) {
    const moving = this.moves(c);
    if (moving && c.lastDraw >= 0) c.t += Math.min(MAX_STEP_S, (now - c.lastDraw) / 1000) * c.speed;
    const dpr = this.env.dpr();
    const backing = Math.round(c.size * dpr);
    if (c.canvas.width !== backing || c.backing !== dpr) {
      c.canvas.width = backing;
      c.canvas.height = backing;
      c.backing = dpr;
    }
    if (c.inkVersion !== this.inkVersion || !c.ink_) {
      c.ink_ = c.ink();
      c.inkVersion = this.inkVersion;
    }
    c.ctx.setTransform(backing / c.size, 0, 0, backing / c.size, 0, 0);
    c.draw(c.ctx, c.size, moving ? c.t : c.still, { ink: c.ink_, alpha: c.alpha, moving });
    c.lastDraw = now;
    c.dirty = false;
    c.frames++;
    this.frames++;
  }
}

/** Reads the colour an element is drawn in, as the browser resolves it. */
export function resolveInk(el: Element): string {
  return getComputedStyle(el).color || "currentColor";
}

/** The colours the avatars' ink comes from, as the page resolves them now: the page's own colour and the two ink variables. */
export function pageInkKey(): string {
  const style = getComputedStyle(document.body ?? document.documentElement);
  return `${style.color}|${style.getPropertyValue("--hd-avatar-ink").trim()}|${style.getPropertyValue("--foreground").trim()}`;
}

/** Returns a function that says whether `read()` gave a different value from the last time it was asked. */
export function inkChangeGate(read: () => string): () => boolean {
  let last = read();
  return () => {
    const now = read();
    if (now === last) return false;
    last = now;
    return true;
  };
}

const lumaCache = new Map<string, number>();
let lumaCtx: CanvasRenderingContext2D | null | undefined;

/** How light a CSS colour is, 0 (black) to 1 (white). Reads one pixel; cached per colour string. */
export function lightness(colour: string): number {
  const hit = lumaCache.get(colour);
  if (hit !== undefined) return hit;
  let value = 0;
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);
  if (rgb) value = (0.299 * Number(rgb[1]) + 0.587 * Number(rgb[2]) + 0.114 * Number(rgb[3])) / 255;
  else if (typeof document !== "undefined") {
    lumaCtx ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (lumaCtx) {
      lumaCtx.clearRect(0, 0, 1, 1);
      lumaCtx.fillStyle = "#000";
      lumaCtx.fillStyle = colour;
      lumaCtx.fillRect(0, 0, 1, 1);
      const d = lumaCtx.getImageData(0, 0, 1, 1).data;
      value = (0.299 * d[0]! + 0.587 * d[1]! + 0.114 * d[2]!) / 255;
    }
  }
  lumaCache.set(colour, value);
  return value;
}

/** The soft blue for a live or running agent: lighter on a dark page, deeper on a light one. */
export function liveBlue(ink: string): string {
  return lightness(ink) > 0.5 ? "#7eb0ff" : "#2f6fe0";
}

let shared: AvatarLoop | null = null;
let observer: IntersectionObserver | null = null;
let hooked = false;

/** The loop every avatar on the page shares. Created on first use. */
export function sharedLoop(): AvatarLoop {
  if (shared) return shared;
  const media = (q: string) => (typeof window.matchMedia === "function" ? window.matchMedia(q) : null);
  const loop = new AvatarLoop({
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
    hidden: () => document.visibilityState === "hidden",
    reducedMotion: () => media("(prefers-reduced-motion: reduce)")?.matches ?? false,
    dpr: () => Math.min(3, window.devicePixelRatio || 1),
    now: () => performance.now(),
    after: (ms, cb) => window.setTimeout(cb, ms),
    cancelAfter: (id) => window.clearTimeout(id),
  });
  shared = loop;
  if (!hooked) {
    hooked = true;
    document.addEventListener("visibilitychange", () => loop.wake());
    media("(prefers-reduced-motion: reduce)")?.addEventListener?.("change", () => loop.invalidate());
    media("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => loop.invalidate());
    if (typeof MutationObserver !== "undefined") {
      // Inline style changes on html and body fire this all the time (a drag, a resize); repaint only if the ink moved.
      const changed = inkChangeGate(pageInkKey);
      const watchTheme = new MutationObserver(() => {
        if (changed()) loop.invalidate();
      });
      const opts = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode", "data-color-scheme"] };
      watchTheme.observe(document.documentElement, opts);
      if (document.body) watchTheme.observe(document.body, opts);
    }
  }
  return loop;
}

/** Tells the shared loop when `canvas` enters or leaves the screen. One observer serves every avatar. */
export function observeVisibility(canvas: HTMLCanvasElement): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) sharedLoop().setVisible(e.target as HTMLCanvasElement, e.isIntersecting);
  });
  observer.observe(canvas);
  return () => observer?.unobserve(canvas);
}

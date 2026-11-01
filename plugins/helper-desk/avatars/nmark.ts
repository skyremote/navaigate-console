// The NavAIgate N as the lead card's avatar, drawn the way the NavMotion films draw it: the brand mark's own path
// (the icon from navaigate-icon-light in the NavMotion logo set, verbatim, never redrawn), filled flat in the ink,
// so it is crisp at any devicePixelRatio. Motion is a pure function of time like every other avatar:
//   idle      a slow light sweep along the ribbon with long rests between, and a very slight breathe
//   working   the same sweep in the brand blue, quicker and unbroken, so it reads as live at 48 px
//   waiting   the whole N breathes into the brand blue and back
//   done      the N at rest; error: the N at rest, dimmed by the loop's alpha
// While it works or waits an orbit of brand-blue dots turns round the N, a soft comet at its head, eased in and out.
// A mount draws the film's open: a dot, then the mark grows out of it.

import { lightness } from "./engine";

/** navaigate-icon-light, viewBox 0 0 622.45 534.41. */
export const N_ICON_PATH =
  "M121.64 0.5C75.04 5.8 35.24 33.8 14.04 76C-1.26 106.7 -4.26 143.2 6.04 175.9C9.34 186.7 17.34 203 21.64 208C23.54 210.3 34.44 225.1 45.84 241C60.54 261.5 66.34 270.5 66.04 272C65.64 274 24.04 336.2 18.44 343.2C11.44 351.9 3.64 373.2 1.24 389.7C-0.46 401.7 -0.26 421.4 1.74 431.5C16.64 510.2 100.24 555.8 171.94 524.4C191.34 515.9 207.24 503 218.84 486.5C222.14 481.8 230.24 470.6 236.84 461.5C243.54 452.4 252.04 440.7 255.84 435.5C266.74 420.4 269.64 416.5 275.64 408.4C278.74 404.3 281.34 400.3 281.34 399.7C281.34 398.2 285.74 398.2 209.34 398.5C155.34 398.7 143.54 398.5 142.64 397.3C140.94 395.3 140.54 161.8 142.14 158.8C143.84 155.7 146.44 154.5 151.44 154.5C155.34 154.5 156.24 155 160.74 159.8C163.54 162.7 171.44 172.2 178.34 181C185.14 189.8 199.54 208.2 210.24 222C230.44 247.8 297.94 337.6 370.34 435.1C393.14 465.8 414.74 494 418.34 497.8C438.04 518.7 464.54 530.9 492.84 532.2C528.54 533.9 559.94 521.9 584.34 497.5C611.74 469.9 625.74 430.8 621.44 393.6C618.64 369.7 612.14 353.6 598.14 335.5C576.44 307.4 551.34 274.1 551.34 273.4C551.34 272.9 556.84 264.8 563.64 255.3C606.24 195.5 609.94 189.4 616.24 170.5C631.54 123.9 617.94 70 582.24 36C555.14 10.3 521.14 -1.4 481.94 1.6C444.14 4.4 412.74 21.3 388.34 52C374.44 69.6 363.04 96.1 360.74 116.6L360.04 122.5L418.44 122.7L476.84 123L476.84 232L476.84 341L475.14 341.3C474.14 341.5 472.14 340.4 470.74 338.8C468.24 336.2 415.54 270.3 348.24 185.9C318.94 149.2 309.74 137.7 279.94 101C243.04 55.4 227.34 36.8 222.24 32.4C203.04 16.1 183.54 6.5 160.54 2.1C150.44 0.2 131.14 -0.6 121.64 0.5Z";

export const N_W = 622.45;
export const N_H = 534.41;
/** The one NavAIgate brand blue, on a light page and on a dark one. */
export const BRAND_BLUE = "#2A5BFF";
const BLUE_RGB = "42,91,255";
/** The farthest the mark reaches from its centre, in path units, so the ring can sit just outside it. */
export const N_REACH = 359.3;
/** Share of the canvas half-width the mark's farthest point reaches. The rest is the orbit's. */
export const N_REACH_FILL = 0.77;
/** The orbit's radius and the biggest a dot gets, as shares of the canvas width; together they stay inside it. */
export const RING_R = 0.45;
export const RING_DOT = 0.032;
/** Seconds the orbit takes for one turn. */
export const RING_PERIOD = 2.6;
/** Seconds the mount's dot-to-mark open takes. */
export const OPEN_SECONDS = 0.8;
/** Seconds the idle sweep takes to come round again; the sweep itself uses the first part of it. */
export const IDLE_PERIOD = 7.2;
export const WORK_PERIOD = 1.9;
export const WAIT_PERIOD = 3.6;

const clamp = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const prog = (x: number, a: number, b: number): number => clamp((x - a) / (b - a));
const soft = (k: number): number => k * k * (3 - 2 * k);
const outExpo = (k: number): number => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k));

/** The slice of the 2D API the N uses, so tests can pass a recording stand-in. */
export type NCtx = {
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(path?: Path2D): void;
  clip(path: Path2D): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(at: number, colour: string): void };
  fillStyle: unknown;
  globalAlpha: number;
};

export interface NStyle {
  /** The page ink. The mark is filled in this. */
  ink: string;
  /** Overall opacity, 0 to 1. */
  alpha?: number;
  /** 0 to 1: how far the working look has been blended in (the blue sweep replaces the idle one). */
  work?: number;
  /** 0 to 1: how far the waiting look has been blended in (the whole mark breathes into the blue). */
  wait?: number;
  /** 0 to 1: how far the orbit has been eased in. It is up while working and waiting. */
  ring?: number;
  /** Seconds since the mount, or null once the open is over (or in a still frame). */
  born?: number | null;
  /** False in a held still frame, which shows the resting mark (a mid-sweep blue mark while working). */
  moving?: boolean;
}

let path: Path2D | null = null;
function markPath(): Path2D | null {
  if (typeof Path2D === "undefined") return null;
  return (path ??= new Path2D(N_ICON_PATH));
}

/** Direction of the ribbon, in path units: up and to the right, the way the N reads. */
const AXIS = (() => {
  const a = (-32 * Math.PI) / 180;
  return { x: Math.cos(a), y: Math.sin(a) };
})();
/** The mark's extent along the axis, so a band can start fully off one end and finish fully off the other. */
const SPAN = (() => {
  const pts = [[0, 0], [N_W, 0], [0, N_H], [N_W, N_H]];
  const d = pts.map(([x, y]) => x * AXIS.x + y * AXIS.y);
  return { lo: Math.min(...d), hi: Math.max(...d) };
})();

/** A soft band across the mark: edges feathered so it reads as light, not as a stripe. */
function band(ctx: NCtx, at: number, half: number, rgb: string, peak: number, alpha: number) {
  if (alpha <= 0.004) return;
  const c = SPAN.lo - half + (SPAN.hi - SPAN.lo + 2 * half) * at;
  const mx = N_W / 2;
  const my = N_H / 2;
  const mid = mx * AXIS.x + my * AXIS.y;
  const g = ctx.createLinearGradient(mx + (c - half - mid) * AXIS.x, my + (c - half - mid) * AXIS.y, mx + (c + half - mid) * AXIS.x, my + (c + half - mid) * AXIS.y);
  // Both ends are the same colour at no opacity, so the edges fade without passing through grey.
  g.addColorStop(0, `rgba(${rgb},0)`);
  g.addColorStop(0.5, `rgba(${rgb},${peak})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = g;
  ctx.fillRect(-20, -20, N_W + 40, N_H + 40);
  ctx.restore();
}

/** Where the idle sweep is at `t` (0 to 1 across the mark), or -1 while it rests. */
export function idleSweep(t: number): number {
  const ph = (((t / IDLE_PERIOD) % 1) + 1) % 1;
  const k = prog(ph, 0, 0.3);
  return ph > 0.3 ? -1 : soft(k);
}

/** Where the working sweep is at `t`: quick, with a short breath between passes. */
export function workSweep(t: number): number {
  const ph = (((t / WORK_PERIOD) % 1) + 1) % 1;
  return soft(prog(ph, 0, 0.82));
}

/** How many dots the orbit has at a size: fewer on a small canvas so each stays a clean dot. */
export function ringDots(size: number): number {
  return size >= 40 ? 24 : size >= 28 ? 18 : 14;
}

/** Where the comet's head is, in radians from three o'clock, turning clockwise; at the top while held still. */
export function ringHead(t: number, moving: boolean): number {
  return -Math.PI / 2 + (moving ? ((t % RING_PERIOD) / RING_PERIOD) * Math.PI * 2 : 0);
}

/** The orbit: evenly spaced brand-blue dots turning as one, a brighter and larger head and a tail that fades behind it. */
function drawRing(ctx: NCtx, size: number, t: number, k: number, alpha: number, moving: boolean) {
  const n = ringDots(size);
  const e = soft(clamp(k));
  const head = ringHead(t, moving);
  const step = (Math.PI * 2) / n;
  const tail = Math.round(n * 0.34);
  const R = size * RING_R * (0.9 + 0.1 * e);
  const dot = Math.max(size * RING_DOT, 0.9);
  const base = Math.max(dot * 0.46, 0.55);
  ctx.save();
  ctx.fillStyle = BRAND_BLUE;
  // The resting dots, one faint ring.
  ctx.globalAlpha = alpha * e * 0.26;
  for (let i = tail + 1; i < n; i++) {
    const a = head - i * step;
    ctx.beginPath();
    ctx.arc(size / 2 + R * Math.cos(a), size / 2 + R * Math.sin(a), base * (0.7 + 0.3 * e), 0, Math.PI * 2);
    ctx.fill();
  }
  // The comet: the head first, then the dots behind it, each fainter and smaller.
  for (let i = tail; i >= 0; i--) {
    const f = 1 - i / (tail + 1);
    const a = head - i * step;
    ctx.globalAlpha = alpha * e * (i === 0 ? 1 : 0.18 + 0.7 * f * f);
    ctx.beginPath();
    ctx.arc(size / 2 + R * Math.cos(a), size / 2 + R * Math.sin(a), (base + (dot - base) * (i === 0 ? 1 : 0.15 + 0.7 * f)) * (0.6 + 0.4 * e), 0, Math.PI * 2);
    ctx.fill();
  }
  // A soft bloom under the head so it reads as light, not a bigger dot.
  ctx.globalAlpha = alpha * e * 0.16;
  ctx.beginPath();
  ctx.arc(size / 2 + R * Math.cos(head), size / 2 + R * Math.sin(head), Math.max(0, Math.min(dot * 1.5, size / 2 - R - 0.05)), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The still moment for each look, chosen so the frame is complete without a band caught mid-pass. */
export const STILL_T = IDLE_PERIOD * 0.6;

/** Draws one frame into the `size` x `size` square at the origin. Pure in `t`. */
export function drawNavN(ctx: NCtx, size: number, t: number, style: NStyle): void {
  ctx.clearRect(0, 0, size, size);
  const P = markPath();
  if (!P) return;
  const alpha = style.alpha ?? 1;
  const moving = style.moving !== false;
  const work = clamp(style.work ?? 0);
  const wait = clamp(style.wait ?? 0);
  const ring = clamp(style.ring ?? 0);
  const dark = lightness(style.ink) > 0.5;
  const born = moving && style.born != null ? style.born : null;
  const open = born === null ? 1 : clamp(born / OPEN_SECONDS);

  const s = (size * N_REACH_FILL * 0.5) / N_REACH;
  const breathe = moving ? 1 + 0.014 * (0.5 - 0.5 * Math.cos((t * Math.PI * 2) / 9)) : 1;

  // The film's open: a dot, then the mark grows out of it.
  const dotK = prog(open, 0, 0.3);
  const dotOut = 1 - prog(open, 0.34, 0.6);
  if (open < 1 && dotK > 0 && dotOut > 0) {
    ctx.save();
    ctx.globalAlpha = alpha * dotOut;
    ctx.fillStyle = style.ink;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.034 * outExpo(dotK), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const grow = prog(open, 0.3, 1);
  const k = outExpo(grow);
  if (k <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha * clamp(grow * 2.4);
  ctx.translate(size / 2, size / 2);
  const sc = s * breathe * (0.2 + 0.8 * k);
  ctx.scale(sc, sc);
  ctx.translate(-N_W / 2, -N_H / 2);

  ctx.fillStyle = style.ink;
  ctx.fill(P);

  // Everything light lives inside the mark.
  ctx.clip(P);
  if (moving) {
    // The sheen is lighter than the ink on a light page and darker on a dark one, so it reads either way.
    const sheen = dark ? "120,128,150" : "255,255,255";
    const at = idleSweep(t);
    if (at >= 0) band(ctx, at, 190, sheen, dark ? 0.55 : 0.5, 1 - work);
    if (work > 0) band(ctx, workSweep(t), 150, BLUE_RGB, 1, work);
  } else if (work > 0) {
    band(ctx, 0.5, 220, BLUE_RGB, 1, work);
  }
  if (wait > 0) {
    const breath = moving ? 0.5 - 0.5 * Math.cos((t * Math.PI * 2) / WAIT_PERIOD) : 0.7;
    ctx.save();
    ctx.globalAlpha *= wait * (0.18 + 0.62 * breath);
    ctx.fillStyle = BRAND_BLUE;
    ctx.fillRect(-20, -20, N_W + 40, N_H + 40);
    ctx.restore();
  }
  ctx.restore();
  if (ring > 0) drawRing(ctx, size, t, ring, alpha, moving);
}


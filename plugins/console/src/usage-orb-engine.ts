// The usage sphere: a glass ball of liquid drawn on a 2D canvas, with no
// framework and no dependency, so Home and a standalone preview share it.
//
//   level    how much liquid the ball holds, by volume of a sphere
//   touch    nudge() tilts the surface as the pointer crosses it; tap() sloshes
//            it, throws droplets and sends a glare across the glass
//   heat     flames round the ball, embers above it and a boil inside, scaled
//            from 0 to 1 by the caller (Home derives it from the burn rate)
//
// Only live things loop: a ball that is not burning, not bubbling and has
// settled stops asking for frames. Every ball shares one animation loop, which
// pauses while the tab is hidden or the ball is off screen. With reduced motion
// each ball draws one still frame.

export type Rgb = [number, number, number];

export type OrbLook = {
  /** Share of the sphere that holds liquid, 0 to 1. */
  level: number;
  /** The liquid's colour. */
  liquid: Rgb;
  /** The theme's ink, for the rim and the glass. */
  ink: Rgb;
  /** True on a dark surface: flames add light there, and paint over a light one. */
  dark: boolean;
  /** Flame strength, 0 for none up to 1. */
  heat: number;
  /** Slow bubbles while the harness is working. */
  bubbles: boolean;
};

export type OrbHandle = {
  set(next: Partial<OrbLook>): void;
  /** The pointer moved `dx` CSS pixels across the ball. */
  nudge(dx: number): void;
  /** A press at `nx`, from -1 (left edge) to 1 (right edge). */
  tap(nx: number): void;
  /** One pass of the glare across the glass. */
  sweep(): void;
  /** Re-read the canvas size after a layout change. */
  resize(): void;
  /** Reduced motion was switched on or off: draw one still frame, or animate again. */
  setStill(still: boolean): void;
  destroy(): void;
};

type Flame = { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; seed: number; front: boolean };
type Ember = { x: number; y: number; vy: number; age: number; life: number; size: number; seed: number };
type Bubble = { x: number; y: number; vy: number; r: number; seed: number };
type Drop = { x: number; y: number; vx: number; vy: number; r: number };

type Orb = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  look: OrbLook;
  still: boolean;
  visible: boolean;
  /** False once the ball has settled: the shared loop skips it until something wakes it. */
  awake: boolean;
  size: number;
  dpr: number;
  lvl: number;
  lvlV: number;
  /** The level `height` was worked out for, so the bisection runs once per change, not once per point of the surface. */
  heightFor: number;
  height: number;
  tilt: number;
  tiltV: number;
  wave: number;
  phase: number;
  sweep: number;
  time: number;
  flames: Flame[];
  embers: Ember[];
  bubbles: Bubble[];
  drops: Drop[];
  flameDue: number;
  emberDue: number;
  bubbleDue: number;
  observer: IntersectionObserver | null;
};

/** Where the ball sits in its square canvas: the space above it is for flames. */
export const ORB_CENTRE_Y = 0.57;
export const ORB_RADIUS = 0.36;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: Rgb, a: number) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Height of the liquid in a unit sphere (0 to 2) that fills `share` of its volume. */
export function heightForShare(share: number): number {
  const f = clamp(share, 0, 1);
  let lo = 0;
  let hi = 2;
  for (let i = 0; i < 28; i++) {
    const h = (lo + hi) / 2;
    if ((h * h * (3 - h)) / 4 < f) lo = h;
    else hi = h;
  }
  return (lo + hi) / 2;
}

// ---------- flame sprites, shared by every ball ----------
const RAMP_DARK: Rgb[] = [[255, 247, 214], [255, 221, 128], [255, 184, 64], [255, 138, 36], [245, 96, 28], [214, 58, 22], [150, 34, 20], [80, 24, 18]];
const RAMP_LIGHT: Rgb[] = [[255, 226, 120], [255, 196, 70], [255, 160, 44], [250, 124, 30], [238, 92, 26], [214, 60, 24], [170, 44, 26], [120, 40, 30]];
const sprites = new Map<string, HTMLCanvasElement>();
function sprite(dark: boolean, k: number): HTMLCanvasElement | null {
  const key = `${dark ? "d" : "l"}${k}`;
  const hit = sprites.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return null;
  const col = (dark ? RAMP_DARK : RAMP_LIGHT)[k];
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, rgba(col, 1));
  grad.addColorStop(0.35, rgba(col, 0.62));
  grad.addColorStop(1, rgba(col, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  sprites.set(key, c);
  return c;
}

// ---------- one loop for every ball ----------
const orbs = new Set<Orb>();
let raf = 0;
let last = 0;
let listening = false;

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function frame(t: number) {
  raf = 0;
  const dt = clamp((t - last) / 1000, 0.001, 0.05);
  last = t;
  let more = false;
  for (const o of orbs) {
    if (!o.visible || o.still || !o.awake) continue;
    o.awake = step(o, dt);
    draw(o);
    if (o.awake) more = true;
  }
  if (more && !hidden()) raf = requestAnimationFrame(frame);
}

function wake() {
  if (raf || hidden() || typeof requestAnimationFrame !== "function") return;
  last = performance.now() - 16;
  raf = requestAnimationFrame(frame);
}

function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (!hidden()) wake();
  });
}

// ---------- geometry ----------
function geo(o: Orb) {
  const S = o.size;
  return { S, cx: S / 2, cy: S * ORB_CENTRE_Y, R: S * ORB_RADIUS };
}

/** The surface height at `x`, and the flat level it moves about. */
function surface(o: Orb, x: number, layer: 0 | 1): number {
  const { cx, cy, R } = geo(o);
  const lvl = clamp(o.lvl, 0, 1);
  if (lvl !== o.heightFor) {
    o.heightFor = lvl;
    o.height = heightForShare(lvl);
  }
  const y0 = cy + R - o.height * R;
  const off = (y0 - cy) / R;
  const chord = Math.sqrt(Math.max(0, 1 - off * off));
  const room = 0.3 + 0.7 * chord;
  const u = (x - cx) / R;
  const amp = o.wave * R * 0.075 * room;
  const p = o.phase * (layer ? -0.8 : 1) + (layer ? 1.7 : 0);
  return y0 + Math.tan(o.tilt * (layer ? 0.7 : 1)) * (x - cx) * room + amp * Math.sin(u * 3.3 + p) + amp * 0.5 * Math.sin(u * 6.1 - p * 1.4);
}

// ---------- simulation ----------
function step(o: Orb, dt: number): boolean {
  const { look } = o;
  const { cx, cy, R } = geo(o);
  o.time += dt;
  const target = clamp(look.level, 0, 1);

  o.lvlV += ((target - o.lvl) * 60 - o.lvlV * 9) * dt;
  o.lvl += o.lvlV * dt;
  o.tiltV += (-o.tilt * 42 - o.tiltV * 2.6) * dt;
  o.tilt = clamp(o.tilt + o.tiltV * dt, -0.55, 0.55);
  o.wave *= Math.exp(-1.5 * dt);
  const simmer = look.heat > 0 ? 0.16 + 0.3 * look.heat : look.bubbles ? 0.08 : 0;
  if (o.wave < simmer) o.wave = simmer;
  o.phase += dt * (4.5 + 7 * Math.min(1, o.wave));
  if (o.sweep >= 0) {
    o.sweep += dt / 0.95;
    if (o.sweep > 1) o.sweep = -1;
  }

  // Flames rise from the lower arc of the ball and close over its top.
  if (look.heat > 0) {
    const heat = clamp(look.heat, 0, 1);
    o.flameDue += dt * (26 + 110 * heat);
    while (o.flameDue >= 1) {
      o.flameDue -= 1;
      const front = Math.random() < 0.2;
      const spread = front ? 0.55 : 0.75 + 0.95 * heat;
      const a = spread * (Math.random() - Math.random());
      o.flames.push({
        x: cx + Math.sin(a) * R,
        y: cy + Math.cos(a) * R * (front ? 1.02 : 1),
        vx: Math.sin(a) * R * 0.5,
        vy: -R * (1.5 + Math.random() * 1.3) * (0.6 + 0.6 * heat) * (front ? 0.55 : 1),
        age: 0,
        life: (0.5 + Math.random() * 0.5) * (0.75 + 0.5 * heat) * (front ? 0.6 : 1),
        size: R * (0.2 + Math.random() * 0.16) * (0.75 + 0.45 * heat) * (front ? 0.7 : 1),
        seed: Math.random() * 6.28,
        front,
      });
    }
    o.emberDue += dt * (4 + 16 * heat);
    while (o.emberDue >= 1) {
      o.emberDue -= 1;
      const a = (Math.random() - 0.5) * 2.4;
      o.embers.push({ x: cx + Math.sin(a) * R * 0.95, y: cy - Math.cos(a) * R * 0.6, vy: -R * (1.1 + Math.random() * 1.2), age: 0, life: 1 + Math.random() * 0.9, size: 0.8 + Math.random() * 1.1, seed: Math.random() * 6.28 });
    }
  }
  for (const f of o.flames) {
    f.age += dt / f.life;
    f.vx += (-(f.x - cx) * 6 + Math.sin(o.time * 7 + f.seed) * R * 1.3) * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
  }
  o.flames = o.flames.filter((f) => f.age < 1);
  for (const e of o.embers) {
    e.age += dt / e.life;
    e.x += Math.sin(o.time * 5 + e.seed) * R * 0.5 * dt;
    e.y += e.vy * dt;
  }
  o.embers = o.embers.filter((e) => e.age < 1 && e.y > -4);

  // Bubbles: a boil when burning, a slow stream while the harness works.
  const rate = look.heat > 0 ? 3 + 16 * look.heat : look.bubbles ? 2.5 : 0;
  if (rate > 0 && o.lvl > 0.04) {
    o.bubbleDue += dt * rate;
    while (o.bubbleDue >= 1) {
      o.bubbleDue -= 1;
      const u = (Math.random() * 2 - 1) * 0.8;
      const yb = cy + Math.sqrt(1 - u * u) * R * 0.94;
      if (yb > surface(o, cx + u * R, 0) + 6) o.bubbles.push({ x: cx + u * R, y: yb, vy: -R * (0.5 + Math.random() * 0.6), r: 1 + Math.random() * 1.7, seed: Math.random() * 6.28 });
    }
  }
  for (const b of o.bubbles) {
    b.y += b.vy * dt;
    b.x += Math.sin(o.time * 6 + b.seed) * R * 0.12 * dt;
  }
  o.bubbles = o.bubbles.filter((b) => b.y > surface(o, b.x, 0) + b.r);

  for (const d of o.drops) {
    d.vy += R * 7 * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
  }
  o.drops = o.drops.filter((d) => d.vy < 0 || d.y < surface(o, d.x, 0));

  const moving = Math.abs(o.tilt) > 0.002 || Math.abs(o.tiltV) > 0.01 || o.wave > 0.012 || Math.abs(target - o.lvl) > 0.0005 || Math.abs(o.lvlV) > 0.001;
  if (!moving) {
    o.tilt = 0;
    o.tiltV = 0;
    o.wave = simmer;
    o.lvl = target;
    o.lvlV = 0;
  }
  return moving || simmer > 0 || o.sweep >= 0 || o.flames.length + o.embers.length + o.bubbles.length + o.drops.length > 0;
}

// ---------- drawing ----------
function drawFlames(o: Orb, front: boolean) {
  const { ctx, look } = o;
  ctx.save();
  ctx.globalCompositeOperation = look.dark ? "lighter" : "source-over";
  for (const f of o.flames) {
    if (f.front !== front) continue;
    const img = sprite(look.dark, Math.min(7, Math.floor(f.age * 8)));
    if (!img) continue;
    const fade = f.age < 0.1 ? f.age / 0.1 : Math.pow(1 - (f.age - 0.1) / 0.9, 1.2);
    const s = f.size * (1 - 0.65 * f.age);
    // Flames thin out towards the top of the canvas, so none is cut off by its edge.
    const room = clamp((f.y - s) / (o.size * 0.12), 0, 1);
    ctx.globalAlpha = clamp(fade * room * (look.dark ? 0.5 : 0.6), 0, 1);
    ctx.drawImage(img, f.x - s, f.y - s * 1.25, s * 2, s * 2.5);
  }
  ctx.restore();
}

function draw(o: Orb) {
  const { ctx, look } = o;
  const { S, cx, cy, R } = geo(o);
  const heat = clamp(look.heat, 0, 1);
  const flicker = 0.86 + 0.14 * Math.sin(o.time * 13) * Math.sin(o.time * 7.3 + 1);
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  // The shadow the ball stands on; a glow instead while it burns.
  ctx.save();
  ctx.translate(cx, cy + R * 1.09);
  ctx.scale(1, 0.13);
  const ground = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.9);
  ground.addColorStop(0, heat > 0 ? `rgba(255,120,30,${0.42 * heat * flicker + 0.1})` : rgba(BLACK, look.dark ? 0.5 : 0.16));
  ground.addColorStop(1, heat > 0 ? "rgba(255,120,30,0)" : rgba(BLACK, 0));
  ctx.fillStyle = ground;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (heat > 0) {
    const halo = ctx.createRadialGradient(cx, cy + R * 0.55, R * 0.4, cx, cy + R * 0.3, R * 1.5);
    halo.addColorStop(0, `rgba(255,128,32,${(look.dark ? 0.3 : 0.2) * heat * flicker})`);
    halo.addColorStop(1, "rgba(255,128,32,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, S, S);
    drawFlames(o, false);
  }

  // The glass, before anything is inside it.
  const disc = () => {
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
  };
  const glass = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
  glass.addColorStop(0, rgba(look.ink, look.dark ? 0.05 : 0.015));
  glass.addColorStop(1, rgba(look.ink, look.dark ? 0.16 : 0.09));
  disc();
  ctx.fillStyle = glass;
  ctx.fill();

  // The liquid.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.965, 0, Math.PI * 2);
  ctx.clip();
  if (o.lvl > 0.004) {
    const path = (layer: 0 | 1) => {
      ctx.beginPath();
      ctx.moveTo(cx - R - 2, surface(o, cx - R - 2, layer));
      for (let x = cx - R; x <= cx + R + 2; x += 3) ctx.lineTo(x, surface(o, x, layer));
      ctx.lineTo(cx + R + 2, cy + R + 2);
      ctx.lineTo(cx - R - 2, cy + R + 2);
      ctx.closePath();
    };
    const top = surface(o, cx, 0);
    path(1);
    ctx.fillStyle = rgba(mix(look.liquid, look.dark ? BLACK : WHITE, 0.3), 0.5);
    ctx.fill();
    path(0);
    const body = ctx.createLinearGradient(0, top - R * 0.1, 0, cy + R);
    body.addColorStop(0, rgba(mix(look.liquid, WHITE, 0.28), 0.9));
    body.addColorStop(0.45, rgba(look.liquid, 0.94));
    body.addColorStop(1, rgba(mix(look.liquid, BLACK, 0.34), 0.97));
    ctx.fillStyle = body;
    ctx.fill();
    if (heat > 0) {
      const hot = ctx.createLinearGradient(0, cy + R, 0, top);
      hot.addColorStop(0, `rgba(255,112,24,${0.55 * heat * flicker})`);
      hot.addColorStop(1, "rgba(255,170,60,0)");
      ctx.fillStyle = hot;
      ctx.fill();
    }
    // Light gathered at the bottom of the ball.
    const caustic = ctx.createRadialGradient(cx + R * 0.18, cy + R * 0.62, 0, cx + R * 0.18, cy + R * 0.62, R * 0.55);
    caustic.addColorStop(0, rgba(WHITE, 0.26));
    caustic.addColorStop(1, rgba(WHITE, 0));
    ctx.fillStyle = caustic;
    ctx.fill();
    // The surface line.
    ctx.beginPath();
    ctx.moveTo(cx - R, surface(o, cx - R, 0));
    for (let x = cx - R + 3; x <= cx + R; x += 3) ctx.lineTo(x, surface(o, x, 0));
    ctx.strokeStyle = rgba(WHITE, 0.55);
    ctx.lineWidth = 1.25;
    ctx.stroke();
    for (const b of o.bubbles) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(WHITE, 0.14);
      ctx.fill();
      ctx.strokeStyle = rgba(WHITE, 0.6);
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
  ctx.fillStyle = rgba(mix(look.liquid, WHITE, 0.2), 0.95);
  for (const d of o.drops) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Shade towards the edge, so the disc reads as a ball.
  const shade = ctx.createRadialGradient(cx - R * 0.12, cy - R * 0.16, R * 0.55, cx, cy, R);
  shade.addColorStop(0, rgba(BLACK, 0));
  shade.addColorStop(1, rgba(BLACK, look.dark ? 0.42 : 0.2));
  ctx.fillStyle = shade;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  // One pass of glare across the glass.
  if (o.sweep >= 0) {
    const e = 1 - Math.pow(1 - o.sweep, 3);
    const p = (e * 2 - 1) * R * 1.7;
    const band = ctx.createLinearGradient(cx + p - R * 0.45, cy - R * 0.16, cx + p + R * 0.45, cy + R * 0.16);
    band.addColorStop(0, rgba(WHITE, 0));
    band.addColorStop(0.5, rgba(WHITE, look.dark ? 0.42 : 0.7));
    band.addColorStop(1, rgba(WHITE, 0));
    ctx.fillStyle = band;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  }
  ctx.restore();

  // The rim, warm underneath while it burns.
  disc();
  ctx.strokeStyle = rgba(look.ink, look.dark ? 0.34 : 0.24);
  ctx.lineWidth = 1.25;
  ctx.stroke();
  if (heat > 0) {
    const warm = ctx.createLinearGradient(0, cy + R, 0, cy - R * 0.4);
    warm.addColorStop(0, `rgba(255,150,50,${0.9 * heat * flicker})`);
    warm.addColorStop(1, "rgba(255,150,50,0)");
    disc();
    ctx.strokeStyle = warm;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Bounce light low on the right.
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.9, Math.PI * 0.1, Math.PI * 0.42);
  ctx.strokeStyle = rgba(WHITE, look.dark ? 0.16 : 0.34);
  ctx.lineWidth = R * 0.05;
  ctx.lineCap = "round";
  ctx.stroke();
  // The glare: a soft window high on the left and one sharp point.
  ctx.save();
  ctx.translate(cx - R * 0.36, cy - R * 0.44);
  ctx.rotate(-0.62);
  ctx.scale(1, 0.56);
  const glare = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.52);
  glare.addColorStop(0, rgba(WHITE, look.dark ? 0.66 : 0.92));
  glare.addColorStop(0.5, rgba(WHITE, look.dark ? 0.24 : 0.4));
  glare.addColorStop(1, rgba(WHITE, 0));
  ctx.fillStyle = glare;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.52, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // A crescent of light just inside the upper rim.
  const crescent = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.2, cy);
  crescent.addColorStop(0, rgba(WHITE, look.dark ? 0.55 : 0.85));
  crescent.addColorStop(1, rgba(WHITE, 0));
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.88, Math.PI * 1.06, Math.PI * 1.56);
  ctx.strokeStyle = crescent;
  ctx.lineWidth = R * 0.06;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - R * 0.52, cy - R * 0.5, R * 0.055, 0, Math.PI * 2);
  ctx.fillStyle = rgba(WHITE, look.dark ? 0.85 : 1);
  ctx.fill();

  if (heat > 0) {
    drawFlames(o, true);
    ctx.save();
    ctx.globalCompositeOperation = look.dark ? "lighter" : "source-over";
    for (const e of o.embers) {
      ctx.globalAlpha = clamp(1 - e.age, 0, 1) * 0.9;
      ctx.fillStyle = e.age < 0.5 ? "rgb(255,214,120)" : "rgb(255,132,48)";
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** With reduced motion: settle everything, run the flames forward unseen, then draw one frame. */
function drawStill(o: Orb) {
  o.lvl = clamp(o.look.level, 0, 1);
  o.lvlV = o.tilt = o.tiltV = o.wave = 0;
  o.sweep = -1;
  o.flames = [];
  o.embers = [];
  o.bubbles = [];
  o.drops = [];
  if (o.look.heat > 0) for (let i = 0; i < 50; i++) step(o, 1 / 30);
  o.wave = 0;
  o.tilt = 0;
  draw(o);
}

function measure(o: Orb) {
  const size = o.canvas.clientWidth || o.canvas.width || 160;
  const dpr = clamp(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 1, 2);
  if (size === o.size && dpr === o.dpr) return;
  o.size = size;
  o.dpr = dpr;
  o.canvas.width = Math.round(size * dpr);
  o.canvas.height = Math.round(size * dpr);
}

/** Draw a usage sphere on `canvas`. Returns null where the canvas cannot be drawn on. */
export function mountOrb(canvas: HTMLCanvasElement, look: OrbLook, opts: { still?: boolean } = {}): OrbHandle | null {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const o: Orb = {
    canvas, ctx, look: { ...look }, still: !!opts.still, visible: true, awake: true, size: 0, dpr: 0,
    lvl: 0, lvlV: 0, heightFor: -1, height: 0, tilt: 0, tiltV: 0, wave: 0.5, phase: Math.random() * 6.28, sweep: 0, time: Math.random() * 10,
    flames: [], embers: [], bubbles: [], drops: [], flameDue: 0, emberDue: 0, bubbleDue: 0, observer: null,
  };
  measure(o);
  orbs.add(o);
  listen();
  const refresh = () => {
    if (o.still) return drawStill(o);
    o.awake = true;
    wake();
  };
  const stir = () => {
    o.awake = true;
    wake();
  };
  if (typeof IntersectionObserver === "function") {
    o.observer = new IntersectionObserver((entries) => {
      const seen = entries.some((e) => e.isIntersecting);
      if (seen === o.visible) return;
      o.visible = seen;
      if (seen) refresh();
    });
    o.observer.observe(canvas);
  }
  refresh();
  return {
    set(next) {
      const before = o.look.level;
      o.look = { ...o.look, ...next };
      if (!o.still && Math.abs(o.look.level - before) > 0.002) o.wave = Math.min(1, o.wave + 0.45);
      refresh();
    },
    nudge(dx) {
      if (o.still) return;
      const k = clamp(dx / Math.max(1, o.size), -0.25, 0.25);
      o.tiltV += k * 13;
      o.wave = Math.min(1, o.wave + Math.abs(k) * 1.6);
      stir();
    },
    tap(nx) {
      if (o.still) return;
      const { cx, R } = geo(o);
      const side = clamp(nx, -1, 1);
      o.tiltV += (side >= 0 ? -1 : 1) * (4.2 + Math.abs(side) * 2.2);
      o.wave = Math.min(1.2, o.wave + 0.8);
      o.sweep = 0;
      if (o.lvl > 0.03) {
        const x0 = cx + side * R * 0.6;
        const y0 = surface(o, x0, 0);
        for (let i = 0; i < 7; i++) o.drops.push({ x: x0 + (Math.random() - 0.5) * R * 0.3, y: y0, vx: (Math.random() - 0.5) * R * 1.3, vy: -R * (1.3 + Math.random() * 1.3), r: 1.2 + Math.random() * 1.6 });
      }
      stir();
    },
    sweep() {
      if (o.still) return;
      if (o.sweep < 0) o.sweep = 0;
      stir();
    },
    resize() {
      measure(o);
      refresh();
    },
    setStill(still) {
      if (o.still === still) return;
      o.still = still;
      refresh();
    },
    destroy() {
      o.observer?.disconnect();
      orbs.delete(o);
    },
  };
}

// ---------- colour ----------
let probe: CanvasRenderingContext2D | null | undefined;
/** Any CSS colour the browser understands (a resolved value, not a var()) as [r, g, b]; `fallback` where there is no canvas. */
export function toRgb(css: string, fallback: Rgb): Rgb {
  if (typeof document === "undefined" || !css) return fallback;
  if (probe === undefined) {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      probe = c.getContext("2d", { willReadFrequently: true });
    } catch {
      probe = null;
    }
  }
  if (!probe) return fallback;
  try {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return d[3] === 0 ? fallback : [d[0], d[1], d[2]];
  } catch {
    return fallback;
  }
}

/** Perceived lightness of a colour, 0 (black) to 1 (white). */
export const lightness = (c: Rgb) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

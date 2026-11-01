// The nine Helper Desk avatar animations. Each one is a pure function of time: it draws one frame into a 2D
// context at a given size and moment, so the same code serves a 24 px list row and a 180 px preview, and a
// still frame is just a draw at a chosen time.
//
// Ported and de-minified from "Set of animations" by larsen66 on 21st.dev
// (https://21st.dev/community/components/larsen66/set-of-animations-4/default, MIT licence). The original
// accumulated time per frame; these take absolute seconds, draw with one ink colour at varying alpha instead of
// fixed white, and enlarge the dots at small sizes so they stay readable. See THIRD_PARTY_NOTICES.md.

/** The slice of the 2D API the animations use, so tests can pass a recording stand-in. */
export type Ctx2D = Pick<CanvasRenderingContext2D, "clearRect" | "save" | "restore" | "scale" | "beginPath" | "arc" | "fill" | "moveTo" | "lineTo" | "stroke"> & {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  globalAlpha: number;
  lineWidth: number;
  lineCap: CanvasLineCap;
};

export interface DrawStyle {
  /** Any CSS colour. Every dot and line is this colour at a varying alpha. */
  ink: string;
  /** Overall opacity, 0 to 1. Default 1. */
  alpha?: number;
  /** False when the loop is holding a still frame (reduced motion, or a held state); true while it plays. */
  moving?: boolean;
}

/** Draws one frame: clears the `size` x `size` square at the origin, then draws at `t` seconds. */
export type DrawFn = (ctx: Ctx2D, size: number, t: number, style: DrawStyle) => void;

/** The animations are authored on a 180 x 180 canvas. */
const VIEW = 180;
const CX = VIEW / 2;
const CY = VIEW / 2;
const TAU = Math.PI * 2;

export const easeInOutCubic = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** A pen that draws in the 180-unit space, with dots and lines thickened as the canvas gets smaller. */
class Pen {
  readonly boost: number;
  private readonly floor: number;
  constructor(private readonly ctx: Ctx2D, size: number, private readonly alpha: number) {
    const u = size / VIEW;
    this.boost = Math.max(1, Math.pow(1 / u, 0.48));
    this.floor = 0.4 / u;
  }
  dot(x: number, y: number, r: number, a: number) {
    const al = (a > 1 ? 1 : a) * this.alpha;
    if (al < 0.01 || r <= 0) return;
    this.ctx.globalAlpha = al;
    this.ctx.beginPath();
    this.ctx.arc(x, y, Math.max(r * this.boost, this.floor), 0, TAU);
    this.ctx.fill();
  }
  line(x1: number, y1: number, x2: number, y2: number, a: number, width: number) {
    const al = (a > 1 ? 1 : a) * this.alpha;
    if (al < 0.01) return;
    this.ctx.globalAlpha = al;
    this.ctx.lineWidth = width * this.boost;
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
  }
}

function frame(ctx: Ctx2D, size: number, style: DrawStyle, body: (pen: Pen) => void) {
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  const u = size / VIEW;
  ctx.scale(u, u);
  ctx.fillStyle = style.ink;
  ctx.strokeStyle = style.ink;
  ctx.lineCap = "round";
  body(new Pen(ctx, size, style.alpha ?? 1));
  ctx.restore();
}

interface P3 {
  x: number;
  y: number;
  z: number;
}

/** Rotates a point about the vertical axis, then the horizontal one. */
function rotate(p: P3, aroundY: number, aroundX: number): P3 {
  const cy = Math.cos(aroundY);
  const sy = Math.sin(aroundY);
  const x1 = p.x * cy - p.z * sy;
  const z1 = p.x * sy + p.z * cy;
  const cx = Math.cos(aroundX);
  const sx = Math.sin(aroundX);
  return { x: x1, y: p.y * cx - z1 * sx, z: p.y * sx + z1 * cx };
}

// 1. Sphere scan: 250 points on a turning sphere, with a band of light sweeping up and down it.
const SPHERE_R = VIEW * 0.4;
const SPHERE = Array.from({ length: 250 }, (_, i): P3 => {
  const polar = Math.acos(1 - 2 * (i / 250));
  const azimuth = Math.sqrt(250 * Math.PI) * polar;
  return { x: SPHERE_R * Math.sin(polar) * Math.cos(azimuth), y: SPHERE_R * Math.sin(polar) * Math.sin(azimuth), z: SPHERE_R * Math.cos(polar) };
});

export const sphereScan: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const r = t * 0.25;
    const tilt = Math.sin(r * 0.3) * 0.5;
    const spin = r * 0.5;
    const scanY = (easeInOutCubic((Math.sin(r * 2.5) + 1) / 2) * 2 - 1) * SPHERE_R;
    const band = 25;
    for (const point of SPHERE) {
      const p = rotate(point, spin, tilt);
      const depth = (p.z + SPHERE_R * 1.5) / (SPHERE_R * 2.5);
      const d = Math.abs(p.y - scanY);
      const lit = d < band ? Math.cos((d / band) * (Math.PI / 2)) : 0;
      pen.dot(CX + p.x, CY + p.y, Math.max(0, depth * 2 + lit * 2.5), Math.max(0, depth * 0.6 + lit * 0.4));
    }
  });

// 2. Crystalline refraction: a 15 x 15 grid that bulges outward where a ring passes.
const GRID_N = 15;
const GRID_INSET = 16;
const GRID_STEP = (VIEW - GRID_INSET * 2) / (GRID_N - 1);
const GRID = Array.from({ length: GRID_N * GRID_N }, (_, i) => ({ x: GRID_INSET + (i % GRID_N) * GRID_STEP, y: GRID_INSET + Math.floor(i / GRID_N) * GRID_STEP }));

export const crystallineRefraction: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const ring = (t * 80) % 150;
    const width = 60;
    for (const g of GRID) {
      const d = Math.abs(Math.hypot(g.x - CX, g.y - CY) - ring);
      const push = d < width / 2 ? easeInOutCubic(Math.sin((d / (width / 2)) * Math.PI)) * 10 : 0;
      const angle = Math.atan2(g.y - CY, g.x - CX);
      pen.dot(g.x + Math.cos(angle) * push, g.y + Math.sin(angle) * push, 1.2 + (push / 10) * 2, 0.2 + (push / 10) * 0.8);
    }
  });

// 3. Sonar sweep: a radar arm turns and leaves dots that fade over 2.5 s.
const SONAR_RATE = Math.PI / 4;
const SONAR_FADE = 2.5;
const SONAR = (() => {
  const dots: { r: number; angle: number }[] = [];
  for (let r = 20; r <= 80; r += 15) for (let i = 0; i < r / 2; i++) dots.push({ r, angle: (i / (r / 2)) * TAU });
  return dots;
})();

export const sonarSweep: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const arm = mod(t * SONAR_RATE, TAU);
    pen.line(CX, CY, CX + 85 * Math.cos(arm), CY + 85 * Math.sin(arm), 0.5, 1);
    for (const d of SONAR) {
      const age = mod(arm - d.angle, TAU) / SONAR_RATE;
      if (age >= SONAR_FADE) continue;
      const k = 1 - easeInOutCubic(age / SONAR_FADE);
      pen.dot(CX + d.r * Math.cos(d.angle), CY + d.r * Math.sin(d.angle), 1 + k * 1.5, k);
    }
  });

// 4. Helix scanner: a hundred points winding up a column, lit where a scan plane passes.
const HELIX_COUNT = 100;
const HELIX_R = 35;
const HELIX_H = 120;
const HELIX = Array.from({ length: HELIX_COUNT }, (_, i) => ({ angle: i * 0.3, y: (i / HELIX_COUNT) * HELIX_H - HELIX_H / 2 }));

export const helixScanner: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const r = t * 0.5;
    const phase = (r / 8) * TAU;
    const scanY = Math.sin(phase) * (HELIX_H / 2);
    const rising = Math.cos(phase) > 0;
    const trail = HELIX_H * 0.3;
    for (const h of HELIX) {
      const x = HELIX_R * Math.cos(h.angle + r);
      const depth = (HELIX_R * Math.sin(h.angle + r) + HELIX_R) / (HELIX_R * 2);
      const d = Math.abs(h.y - scanY);
      const lit = d < 25 ? Math.cos((d / 25) * (Math.PI / 2)) : 0;
      const off = h.y - scanY;
      const behind = (rising && off < 0 && -off < trail) || (!rising && off > 0 && off < trail) ? Math.pow(1 - Math.abs(off) / trail, 2) * 0.4 : 0;
      const k = Math.max(lit, behind);
      pen.dot(CX + x, CY + h.y, Math.max(0, depth * 1.8 + k * 2.8), Math.max(0, depth * 0.4 + k * 0.6));
    }
  });

// 5. Interconnecting waves: three rings of dots, joined by lines, breathing in and out.
const RINGS = [
  { radius: 20, count: 12 },
  { radius: 45, count: 24 },
  { radius: 70, count: 36 },
];

export const interconnectingWaves: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const r = t * 0.5;
    const at = (ring: number, i: number) => {
      const ringDef = RINGS[ring]!;
      const radius = ringDef.radius + Math.sin(r * 2 - ring * 0.4) * 3;
      const a = (i / ringDef.count) * TAU;
      return { x: CX + Math.cos(a) * radius, y: CY + Math.sin(a) * radius };
    };
    for (let ring = 0; ring < RINGS.length - 1; ring++) {
      const inner = RINGS[ring]!;
      const outer = RINGS[ring + 1]!;
      const fan = outer.count / inner.count;
      for (let i = 0; i < inner.count; i++) {
        const from = at(ring, i);
        const a = 0.1 + ((Math.sin(r * 3 - ring * 0.5 + i * 0.3) + 1) / 2) * 0.4;
        for (let k = 0; k < fan; k++) {
          const to = at(ring + 1, i * fan + k);
          pen.line(from.x, from.y, to.x, to.y, a, 0.75);
        }
      }
    }
    RINGS.forEach((ringDef, ring) => {
      for (let i = 0; i < ringDef.count; i++) {
        const p = at(ring, i);
        pen.dot(p.x, p.y, 1.5, 0.4 + Math.sin(r * 2 - ring * 0.4 + i * 0.2) * 0.6);
      }
    });
  });

// 6. Cylindrical analysis: fifteen turning rings stacked into a cylinder, with a scan plane moving through.
const CYL_R = 60;
const CYL_H = 100;
const CYL_SLICES = 15;
const CYL_PER_SLICE = 25;

export const cylindricalAnalysis: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const r = t * 0.5;
    const scanY = CY + (easeInOutCubic((Math.sin(r * 2) + 1) / 2) * 2 - 1) * (CYL_H / 2);
    const band = 15;
    for (let s = 0; s < CYL_SLICES; s++) {
      const y = CY + (s / (CYL_SLICES - 1) - 0.5) * CYL_H;
      const turn = r * (0.2 + (s % 2) * 0.1);
      const d = Math.abs(y - scanY);
      const lit = d < band ? Math.cos((d / band) * (Math.PI / 2)) : 0;
      for (let i = 0; i < CYL_PER_SLICE; i++) {
        const a = (i / CYL_PER_SLICE) * TAU + turn;
        const depth = (Math.sin(a) * CYL_R + CYL_R) / (CYL_R * 2);
        pen.dot(CX + Math.cos(a) * CYL_R * depth, y, Math.max(0, depth * 1.5 + lit * 2), Math.max(0, depth * 0.5 + lit * 0.5));
      }
    }
  });

// 7. Voxel matrix morph: a 5 x 5 x 5 lattice that turns and swells where a plane crosses it.
const VOXEL_N = 5;
const VOXEL_STEP = 20;
const VOXEL_SPAN = (VOXEL_N - 1) * VOXEL_STEP;
const VOXELS = Array.from({ length: VOXEL_N ** 3 }, (_, i): P3 => ({
  x: ((i % VOXEL_N) - (VOXEL_N - 1) / 2) * VOXEL_STEP,
  y: ((Math.floor(i / VOXEL_N) % VOXEL_N) - (VOXEL_N - 1) / 2) * VOXEL_STEP,
  z: (Math.floor(i / VOXEL_N ** 2) - (VOXEL_N - 1) / 2) * VOXEL_STEP,
}));

export const voxelMatrixMorph: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const r = t * 0.25;
    const plane = (easeInOutCubic((Math.sin(r * 2) + 1) / 2) * 2 - 1) * (VOXEL_SPAN / 2 + 10);
    const band = 30;
    for (const v of VOXELS) {
      const p = rotate(v, r * 0.6, r * 0.4);
      const d = Math.abs(p.y - plane);
      const lit = d < band ? Math.cos((d / band) * (Math.PI / 2)) : 0;
      const swell = 1 + lit * 0.4;
      const depth = (p.z + 80) / 160;
      pen.dot(CX + p.x * swell, CY + p.y * swell, Math.max(0, depth * 2 + lit * 2), Math.max(0.1, depth * 0.7 + lit * 0.3));
    }
  });

// 8. Phased-array emitter: four rings of points, tilted, with a wave of lift travelling out from the centre.
const ARRAY = (() => {
  const radii = [20, 40, 60, 80];
  const counts = [12, 18, 24, 30];
  const out: P3[] = [];
  radii.forEach((radius, ring) => {
    for (let i = 0; i < counts[ring]!; i++) {
      const a = (i / counts[ring]!) * TAU;
      out.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius, z: 0 });
    }
  });
  return out;
})();

interface Splat {
  x: number;
  y: number;
  z: number;
  r: number;
  a: number;
}

export const phasedArrayEmitter: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const r = t * 0.5;
    const spin = r * 0.2;
    const wave = (r * 120) % (80 * 1.8);
    const reach = 50;
    const lift = 18;
    const out: Splat[] = [];
    for (const point of ARRAY) {
      const d = Math.abs(Math.hypot(point.x, point.y) - wave);
      let z = 0;
      let k = 0;
      if (d < reach / 2) {
        z = easeInOutCubic(Math.sin((1 - d / (reach / 2)) * Math.PI)) * lift;
        k = z / lift;
      }
      const x1 = point.x * Math.cos(spin) - z * Math.sin(spin);
      const z1 = point.x * Math.sin(spin) + z * Math.cos(spin);
      const y2 = point.y * Math.cos(1) - z1 * Math.sin(1);
      const z2 = point.y * Math.sin(1) + z1 * Math.cos(1);
      const persp = 300 / (300 + z2 + 100);
      out.push({ x: CX + x1 * persp, y: CY + y2 * persp, z: z2, r: (1.5 + k * 2.5) * persp, a: 0.4 + k * 0.6 });
    }
    out.sort((a, b) => a.z - b.z);
    for (const s of out) if (s.r >= 0.1) pen.dot(s.x, s.y, s.r, s.a);
  });

// 9. Crystalline cube refraction: a 7 x 7 x 7 lattice, tumbling, with a shell of lift expanding from its centre.
const CUBE_N = 7;
const CUBE_STEP = 15;
const CUBE_HALF = ((CUBE_N - 1) * CUBE_STEP) / 2;
/** Pulls the tumbling corners in so the cube stays inside the canvas. */
const CUBE_FIT = 0.88;
const CUBE_REACH = Math.hypot(CUBE_HALF, CUBE_HALF, CUBE_HALF);
const CUBE: P3[] = [];
for (let a = 0; a < CUBE_N; a++) for (let b = 0; b < CUBE_N; b++) for (let c = 0; c < CUBE_N; c++) CUBE.push({ x: a * CUBE_STEP - CUBE_HALF, y: b * CUBE_STEP - CUBE_HALF, z: c * CUBE_STEP - CUBE_HALF });

export const crystallineCubeRefraction: DrawFn = (ctx, size, t, style) =>
  frame(ctx, size, style, (pen) => {
    const r = t * 0.15;
    const shell = (t * 20) % (CUBE_REACH * 1.5);
    const reach = 40;
    const lift = 10;
    const out: Splat[] = [];
    for (const v of CUBE) {
      let { x, y, z } = v;
      const dist = Math.hypot(x, y, z);
      let k = 0;
      if (dist > 0 && Math.abs(dist - shell) < reach / 2) {
        const push = easeInOutCubic(Math.cos((Math.abs(dist - shell) / (reach / 2)) * (Math.PI / 2))) * lift;
        const scale = (dist + push) / dist;
        x *= scale;
        y *= scale;
        z *= scale;
        k = push / lift;
      }
      const p = rotate({ x, y, z }, r * 3, r * 2);
      const persp = 250 / (250 + p.z);
      const radius = (1.5 + k * 2.5) * persp;
      if (radius > 0.1) out.push({ x: CX + p.x * persp * CUBE_FIT, y: CY + p.y * persp * CUBE_FIT, z: p.z, r: radius, a: Math.max(0.1, persp * 0.7 + k * 0.4) });
    }
    out.sort((a, b) => a.z - b.z);
    for (const s of out) pen.dot(s.x, s.y, s.r, s.a);
  });

export type AnimationId =
  | "sphere-scan"
  | "crystalline-refraction"
  | "sonar-sweep"
  | "helix-scanner"
  | "interconnecting-waves"
  | "cylindrical-analysis"
  | "voxel-matrix-morph"
  | "phased-array-emitter"
  | "crystalline-cube-refraction";

export interface AnimationDef {
  id: AnimationId;
  name: string;
  about: string;
  draw: DrawFn;
  /** The moment, in seconds, drawn when the avatar is still: reduced motion, a finished or failed agent. */
  still: number;
}

export const ANIMATIONS: readonly AnimationDef[] = [
  { id: "sphere-scan", name: "Sphere Scan", about: "A turning sphere of points with a band of light sweeping up and down it.", draw: sphereScan, still: 2.6 },
  { id: "crystalline-refraction", name: "Crystalline Refraction", about: "A grid of points that bulges outward where a ring of light passes.", draw: crystallineRefraction, still: 0.9 },
  { id: "sonar-sweep", name: "Sonar Sweep", about: "A radar arm turning, leaving dots that fade behind it.", draw: sonarSweep, still: 3.2 },
  { id: "helix-scanner", name: "Helix Scanner", about: "A winding column of points with a scan plane moving through it.", draw: helixScanner, still: 4 },
  { id: "interconnecting-waves", name: "Interconnecting Waves", about: "Three rings of points joined by lines, breathing in and out.", draw: interconnectingWaves, still: 1.2 },
  { id: "cylindrical-analysis", name: "Cylindrical Analysis", about: "Stacked turning rings forming a cylinder, scanned by a moving plane.", draw: cylindricalAnalysis, still: 1.5 },
  { id: "voxel-matrix-morph", name: "Voxel Matrix Morph", about: "A lattice of points that turns and swells where a plane crosses it.", draw: voxelMatrixMorph, still: 3 },
  { id: "phased-array-emitter", name: "Phased Array Emitter", about: "Concentric rings with a wave of lift travelling outward.", draw: phasedArrayEmitter, still: 1.6 },
  { id: "crystalline-cube-refraction", name: "Crystalline Cube Refraction", about: "A tumbling cube of points with a shell of lift expanding from its centre.", draw: crystallineCubeRefraction, still: 1.4 },
];

export const ANIMATION_IDS: readonly AnimationId[] = ANIMATIONS.map((a) => a.id);

export function animationById(id: string | null | undefined): AnimationDef | undefined {
  return id ? ANIMATIONS.find((a) => a.id === id) : undefined;
}

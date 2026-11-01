// The NavAIgate ribbon-N, exactly as navaigate.dev's favicon draws it (viewBox 0 0 700 700, the same path the
// Console's orb uses). The 3D mascot does not redraw it: the path is flattened to a polyline and baked once into a
// small distance field that the shader extrudes.

export const N_PATH = "M121.64 0.5C75.04 5.8 35.24 33.8 14.04 76C-1.26 106.7 -4.26 143.2 6.04 175.9C9.34 186.7 17.34 203 21.64 208C23.54 210.3 34.44 225.1 45.84 241C60.54 261.5 66.34 270.5 66.04 272C65.64 274 24.04 336.2 18.44 343.2C11.44 351.9 3.64 373.2 1.24 389.7C-0.46 401.7 -0.26 421.4 1.74 431.5C16.64 510.2 100.24 555.8 171.94 524.4C191.34 515.9 207.24 503 218.84 486.5C222.14 481.8 230.24 470.6 236.84 461.5C243.54 452.4 252.04 440.7 255.84 435.5C266.74 420.4 269.64 416.5 275.64 408.4C278.74 404.3 281.34 400.3 281.34 399.7C281.34 398.2 285.74 398.2 209.34 398.5C155.34 398.7 143.54 398.5 142.64 397.3C140.94 395.3 140.54 161.8 142.14 158.8C143.84 155.7 146.44 154.5 151.44 154.5C155.34 154.5 156.24 155 160.74 159.8C163.54 162.7 171.44 172.2 178.34 181C185.14 189.8 199.54 208.2 210.24 222C230.44 247.8 297.94 337.6 370.34 435.1C393.14 465.8 414.74 494 418.34 497.8C438.04 518.7 464.54 530.9 492.84 532.2C528.54 533.9 559.94 521.9 584.34 497.5C611.74 469.9 625.74 430.8 621.44 393.6C618.64 369.7 612.14 353.6 598.14 335.5C576.44 307.4 551.34 274.1 551.34 273.4C551.34 272.9 556.84 264.8 563.64 255.3C606.24 195.5 609.94 189.4 616.24 170.5C631.54 123.9 617.94 70 582.24 36C555.14 10.3 521.14 -1.4 481.94 1.6C444.14 4.4 412.74 21.3 388.34 52C374.44 69.6 363.04 96.1 360.74 116.6L360.04 122.5L418.44 122.7L476.84 123L476.84 232L476.84 341L475.14 341.3C474.14 341.5 472.14 340.4 470.74 338.8C468.24 336.2 415.54 270.3 348.24 185.9C318.94 149.2 309.74 137.7 279.94 101C243.04 55.4 227.34 36.8 222.24 32.4C203.04 16.1 183.54 6.5 160.54 2.1C150.44 0.2 131.14 -0.6 121.64 0.5Z";

/** Width of the N in world units, so the mark fills about three quarters of the frame. */
export const N_WIDTH = 1.9;
/** The distance field covers a square of this half-side around the N's centre. */
export const FIELD_HALF = 1.2;
export const FIELD_RES = 128;
/** Distances are exact within this band of the outline and clamped to it beyond, which is all the ray march needs. */
const BAND = 0.4;

type Pt = readonly [number, number];

/** Flattens the path's moves, lines and cubic curves into one closed polyline, in the path's own units. */
export function flattenPath(d: string, steps = 10): Pt[] {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g) ?? [];
  const pts: Pt[] = [];
  let i = 0;
  let cmd = "";
  let cur: Pt = [0, 0];
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[MLCZ]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === "Z") break;
    if (cmd === "M" || cmd === "L") {
      cur = [num(), num()];
      pts.push(cur);
    } else if (cmd === "C") {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      const [x0, y0] = cur;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        pts.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
      }
      cur = [x3, y3];
    }
  }
  return pts;
}

export interface NOutline {
  /** Closed polyline in world units: N centred on the origin, y up. */
  points: Pt[];
  /** World position of the bottom-left lobe's centre, where the ribbon coordinate starts. */
  start: Pt;
}

export function nOutline(): NOutline {
  const raw = flattenPath(N_PATH);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y] of raw) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const s = N_WIDTH / (x1 - x0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const to = (x: number, y: number): Pt => [(x - cx) * s, -(y - cy) * s];
  return { points: raw.map(([x, y]) => to(x, y)), start: to(120, 440) };
}

/** Signed distance from (x, y) to the outline, negative inside (even-odd fill, like the favicon). */
export function signedDistance(points: readonly Pt[], x: number, y: number): number {
  const n = points.length;
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [ax, ay] = points[j];
    const [bx, by] = points[i];
    const ex = bx - ax;
    const ey = by - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
    const dx = x - (ax + ex * t);
    const dy = y - (ay + ey * t);
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
    if (ay > y !== by > y && x < ax + ((y - ay) * ex) / ey) inside = !inside;
  }
  const d = Math.sqrt(best);
  return inside ? -d : d;
}

export interface NField {
  size: number;
  /** RGBA floats, row 0 at the bottom: signed distance, its unit gradient (x, y), and the ribbon coordinate 0 to 1. */
  data: Float32Array;
}

let cached: NField | null = null;

/** The distance field the shader extrudes. Built once, on first use, in a few tens of milliseconds. */
export function nField(): NField {
  if (cached) return cached;
  const { points, start } = nOutline();
  const R = FIELD_RES;
  const data = new Float32Array(R * R * 4);
  const at = (i: number) => ((i + 0.5) / R * 2 - 1) * FIELD_HALF;
  const n = points.length;
  const cell = (2 * FIELD_HALF) / R;
  const reach = Math.ceil(BAND / cell);
  const best = new Float32Array(R * R).fill(Infinity);
  const qx = new Float32Array(R * R);
  const qy = new Float32Array(R * R);
  const crossings: number[][] = Array.from({ length: R }, () => []);
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const [ax, ay] = points[b];
    const [bx, by] = points[a];
    const ex = bx - ax;
    const ey = by - ay;
    const inv = 1 / Math.max(1e-12, ex * ex + ey * ey);
    const toCell = (v: number) => ((v / FIELD_HALF) * 0.5 + 0.5) * R - 0.5;
    const i0 = Math.max(0, Math.floor(toCell(Math.min(ax, bx))) - reach);
    const i1 = Math.min(R - 1, Math.ceil(toCell(Math.max(ax, bx))) + reach);
    const j0 = Math.max(0, Math.floor(toCell(Math.min(ay, by))) - reach);
    const j1 = Math.min(R - 1, Math.ceil(toCell(Math.max(ay, by))) + reach);
    for (let j = j0; j <= j1; j++) {
      const y = at(j);
      for (let i = i0; i <= i1; i++) {
        const x = at(i);
        const rx = x - ax;
        const ry = y - ay;
        let t = (rx * ex + ry * ey) * inv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + ex * t;
        const py = ay + ey * t;
        const d2 = (x - px) * (x - px) + (y - py) * (y - py);
        const k = j * R + i;
        if (d2 < best[k]) {
          best[k] = d2;
          qx[k] = px;
          qy[k] = py;
        }
      }
    }
    if (ey !== 0) {
      const lo = Math.max(0, Math.ceil(toCell(Math.min(ay, by))));
      const hi = Math.min(R - 1, Math.floor(toCell(Math.max(ay, by))));
      for (let j = lo; j <= hi; j++) {
        const y = at(j);
        if (ay > y !== by > y) crossings[j].push(ax + ((y - ay) * ex) / ey);
      }
    }
  }
  for (let j = 0; j < R; j++) {
    const xs = crossings[j];
    for (let i = 0; i < R; i++) {
      const x = at(i);
      let inside = false;
      for (const c of xs) if (x < c) inside = !inside;
      const k = (j * R + i) * 4;
      const d = Math.min(BAND, Math.sqrt(best[j * R + i]));
      const sgn = inside ? -1 : 1;
      data[k] = sgn * d;
      if (d > 1e-6 && d < BAND) {
        data[k + 1] = (sgn * (x - qx[j * R + i])) / d;
        data[k + 2] = (sgn * (at(j) - qy[j * R + i])) / d;
      }
    }
  }
  ribbonCoordinate(data, R, start);
  cached = { size: R, data };
  return cached;
}

/** Fills the fourth channel: how far along the ribbon each texel is, measured through the metal from the start lobe. */
function ribbonCoordinate(data: Float32Array, R: number, start: Pt) {
  const INF = 1e9;
  const g = new Float32Array(R * R).fill(INF);
  const metal = new Uint8Array(R * R);
  for (let k = 0; k < R * R; k++) metal[k] = data[k * 4] < 0 ? 1 : 0;
  const cell = (2 * FIELD_HALF) / R;
  const sx = Math.round(((start[0] / FIELD_HALF) * 0.5 + 0.5) * R - 0.5);
  const sy = Math.round(((start[1] / FIELD_HALF) * 0.5 + 0.5) * R - 0.5);
  const reach = Math.ceil(0.12 / cell);
  for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) {
    const x = sx + i;
    const y = sy + j;
    if (x >= 0 && y >= 0 && x < R && y < R && metal[y * R + x] && i * i + j * j <= reach * reach) g[y * R + x] = 0;
  }
  const heap: number[] = [];
  const push = (k: number) => {
    let i = heap.push(k) - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (g[heap[up]] <= g[heap[i]]) break;
      [heap[up], heap[i]] = [heap[i], heap[up]];
      i = up;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && g[heap[l]] < g[heap[m]]) m = l;
        if (r < heap.length && g[heap[r]] < g[heap[m]]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (let k = 0; k < R * R; k++) if (g[k] === 0) push(k);
  const done = new Uint8Array(R * R);
  while (heap.length) {
    const k = pop();
    if (done[k]) continue;
    done[k] = 1;
    const x = k % R;
    const y = (k - x) / R;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= R || ny >= R || !metal[ny * R + nx]) continue;
      const via = g[k] + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
      if (via < g[ny * R + nx]) {
        g[ny * R + nx] = via;
        push(ny * R + nx);
      }
    }
  }
  let max = 0;
  for (let k = 0; k < g.length; k++) if (g[k] < INF) max = Math.max(max, g[k]);
  const known = new Uint8Array(R * R);
  for (let k = 0; k < g.length; k++) {
    if (g[k] < INF) {
      known[k] = 1;
      data[k * 4 + 3] = g[k] / max;
    }
  }
  for (let round = 0; round < 6; round++) {
    const next = known.slice();
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      if (known[y * R + x]) continue;
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < R && ny < R && known[ny * R + nx]) {
          sum += data[(ny * R + nx) * 4 + 3];
          count++;
        }
      }
      if (count) {
        data[(y * R + x) * 4 + 3] = sum / count;
        next[y * R + x] = 1;
      }
    }
    known.set(next);
  }
}

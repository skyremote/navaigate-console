// The NavAIgate N, the one 3D mascot Helper Desk keeps (the lead card wears it), its states and the loops each state
// plays. The same table drives the live renderer and the build-time strip capture, so a strip frame and a live frame
// are the same picture. Every other avatar is one of the nine canvas animations in ./avatars.

export type MascotState = "work" | "idle" | "wait" | "done" | "error";
/** The states every character draws. "wait" (waiting for you) is drawn by the NavAIgate N alone; the rest play idle. */
export const STATES_3D: readonly MascotState[] = ["work", "idle", "done", "error"];
const STATES_N: readonly MascotState[] = ["work", "idle", "wait", "done", "error"];

export const N_ID = "navn";

export interface Character3D {
  id: string;
  name: string;
  about: string;
  /** Left out of the automatic rotation: worn by the lead card, or chosen by hand. */
  apart?: boolean;
  /** Drawn in its own ink and graphite, whatever the card colour, so one strip per state serves every card. */
  fixedColour?: boolean;
}

export const CHARACTERS_3D: readonly Character3D[] = [
  { id: N_ID, name: "NavAIgate N", about: "The NavAIgate ribbon-N as a glossy ink and graphite solid (no longer shown: the lead card now wears the flat N from avatars/nmark).", apart: true, fixedColour: true },
];

/** The states a character has its own look for. */
export function statesFor(id: string): readonly MascotState[] {
  return id === N_ID ? STATES_N : STATES_3D;
}

/** The state a character actually draws: waiting for you is the N's own look, idle for everyone else. */
export function stateFor(id: string, state: MascotState): MascotState {
  return state === "wait" && id !== N_ID ? "idle" : state;
}

export function character3dById(id: string | null | undefined): Character3D | undefined {
  return id ? CHARACTERS_3D.find((c) => c.id === id) : undefined;
}

/** What the shader is told each frame. `phase` is 0 to 1 round one loop. */
export interface Look {
  /** 0 working, 1 idle, 2 waiting for you, 3 done, 4 error. Only the NavAIgate N reads it. */
  mode: number;
  phase: number;
  energy: number;
  glow: number;
  sat: number;
  settle: number;
}

export interface Loop {
  frames: number;
  seconds: number;
}

const DEFAULT_LOOPS: Record<MascotState, Loop> = {
  work: { frames: 12, seconds: 1 },
  idle: { frames: 14, seconds: 3.2 },
  wait: { frames: 14, seconds: 3.2 },
  done: { frames: 8, seconds: 1.1 },
  error: { frames: 1, seconds: 1 },
};

const LOOP_OVERRIDES: Record<string, Partial<Record<MascotState, Loop>>> = {
  [N_ID]: {
    work: { frames: 24, seconds: 4.8 },
    idle: { frames: 24, seconds: 9.6 },
    wait: { frames: 18, seconds: 3.6 },
    done: { frames: 10, seconds: 1.1 },
  },
};

export function loopFor(id: string, state: MascotState): Loop {
  const s = stateFor(id, state);
  return LOOP_OVERRIDES[id]?.[s] ?? DEFAULT_LOOPS[s];
}

const ENERGY: Record<MascotState, number> = { work: 1, idle: 0.28, wait: 0.28, done: 0, error: 0 };
const MODE: Record<MascotState, number> = { work: 0, idle: 1, wait: 2, done: 3, error: 4 };
export const DONE_SECONDS = 1.1;

function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** The look at `seconds` into a state. Work and idle loop; done settles once and holds; error holds one still pose. */
export function lookAt(id: string, asked: MascotState, seconds: number): Look {
  const state = stateFor(id, asked);
  const mode = MODE[state];
  if (state === "error") return { mode, phase: 0, energy: 0, glow: 0, sat: 0.1, settle: 1 };
  if (state === "done") {
    const s = Math.min(1, Math.max(0, seconds / DONE_SECONDS));
    return { mode, phase: 0, energy: 0.12, glow: ease(s) * 0.85, sat: 1, settle: s };
  }
  const loop = loopFor(id, state);
  const phase = (((seconds / loop.seconds) % 1) + 1) % 1;
  return { mode, phase, energy: ENERGY[state], glow: 0, sat: 1, settle: 1 };
}

/** The look for frame `i` of a strip. */
export function lookForFrame(id: string, state: MascotState, i: number): Look {
  const loop = loopFor(id, state);
  if (stateFor(id, state) === "done") return lookAt(id, state, (i / Math.max(1, loop.frames - 1)) * DONE_SECONDS);
  return lookAt(id, state, (i / loop.frames) * loop.seconds);
}

/** True while the live renderer has to keep drawing frames for a state. */
export function animates(state: MascotState): boolean {
  return state === "work" || state === "idle" || state === "wait";
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  if (Number.isNaN(n)) return [0.5, 0.5, 0.5];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Agent colours, in launch order: orange, blue, green, pink, red, purple, teal, amber. */
export const PALETTE = ["#f26b21", "#2f6fe4", "#1f9d55", "#e2457a", "#d93636", "#7c4ddb", "#0e9aa7", "#d99a00"];

/** Index of the palette colour nearest to `hex`; strips are captured once per palette colour. */
export function paletteIndex(hex: string): number {
  const exact = PALETTE.indexOf(hex.toLowerCase());
  if (exact >= 0) return exact;
  const [r, g, b] = hexToRgb(hex);
  let best = 0;
  let bestD = Infinity;
  PALETTE.forEach((p, i) => {
    const [pr, pg, pb] = hexToRgb(p);
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// Which animation an agent wears. Stable: it comes from the agent's id (or the thread id for a lead), so a card
// keeps its animation across renders, polls and restarts. A pick the user made wins, then the default set, then all nine.
import { ANIMATION_IDS, animationById, type AnimationId } from "./animations";
import type { MascotState } from "../mascots3d/catalog";

/** FNV-1a, then a final mix so ids that differ in one character still spread. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

export interface AnimationPick {
  /** An animation this one agent was given by hand. */
  pick?: string | null;
  /** The animations the unpicked agents rotate through. Empty or unknown means all nine. */
  set?: readonly string[];
}

export function animationFor(id: string, choice: AnimationPick = {}): AnimationId {
  const picked = animationById(choice.pick);
  if (picked) return picked.id;
  const pool = choice.set?.length ? ANIMATION_IDS.filter((a) => choice.set!.includes(a)) : [];
  const cast = pool.length ? pool : ANIMATION_IDS;
  return cast[hashId(id) % cast.length]!;
}

/** Where in its cycle an agent's animation starts, so a column of the same animation is not in step. */
export function startOffset(id: string): number {
  return ((hashId(`offset:${id}`) % 4000) / 4000) * 20;
}

/** How an agent's state looks. "live" is the soft blue; the rest stay in the ink colour. */
export interface Look {
  tone: "ink" | "live";
  /** Seconds of animation per second; 0 is a held still frame. */
  speed: number;
  alpha: number;
}

const LOOKS: Record<MascotState, Look> = {
  work: { tone: "live", speed: 1.6, alpha: 1 },
  wait: { tone: "ink", speed: 0.8, alpha: 1 },
  idle: { tone: "ink", speed: 0.5, alpha: 0.9 },
  done: { tone: "ink", speed: 0, alpha: 0.85 },
  error: { tone: "ink", speed: 0, alpha: 0.4 },
};

export function lookFor(state: MascotState, preview = false): Look {
  if (preview) return { tone: "ink", speed: 1.2, alpha: 1 };
  return LOOKS[state];
}

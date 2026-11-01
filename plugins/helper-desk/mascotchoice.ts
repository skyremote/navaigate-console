// Which animation each card wears, which animations the rest rotate through, and the shape and colour of the
// right-hand coach. Kept in this window's localStorage (the sanctioned place for state a plugin keeps outside
// bb's own storage) and shared with every mounted card through useSyncExternalStore.
import { useSyncExternalStore, type CSSProperties } from "react";
import { COLOR_BY_ID, SHAPE_BY_ID, type ColorId, type ShapeId } from "./coach/bloub/skins";
import { animationById } from "./avatars/animations";
import { N_ID } from "./mascots3d/catalog";

export const STORAGE_KEY = "bb-plugin-helper-desk:mascots:v1";
/** Agent ids are short-lived, so only the newest picks are kept. */
export const MAX_PICKS = 300;

export interface MascotChoice {
  /** Agent id (thread id for a lead) to animation id. */
  picks: Record<string, string>;
  /** The animations the unpicked cards rotate through. Empty means all nine. */
  set: string[];
  /** An animation, or the NavAIgate N (`navn`), for the right-hand mascot. Null keeps the coach drawn with `shape`. */
  coach: string | null;
  /** The right-hand coach's shape. Null means the cloud. */
  shape: ShapeId | null;
  /** The right-hand coach's colour. Null follows the theme. */
  colour: ColorId | null;
}

const EMPTY: MascotChoice = { picks: {}, set: [], coach: null, shape: null, colour: null };

export function sanitiseChoice(raw: unknown): MascotChoice {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Record<string, unknown>;
  const picks: Record<string, string> = {};
  if (r.picks && typeof r.picks === "object") {
    for (const [id, animation] of Object.entries(r.picks as Record<string, unknown>)) if (typeof animation === "string" && animationById(animation)) picks[id] = animation;
  }
  const set = Array.isArray(r.set) ? [...new Set(r.set.filter((x): x is string => typeof x === "string" && animationById(x) !== undefined))] : [];
  const shape = typeof r.shape === "string" && SHAPE_BY_ID.has(r.shape) ? (r.shape as ShapeId) : null;
  const colour = typeof r.colour === "string" && COLOR_BY_ID.has(r.colour) ? (r.colour as ColorId) : null;
  // The NavAIgate N is still drawn on the right (companion.tsx hands Mascot the id), so a saved N pick stays the N.
  const coach = typeof r.coach === "string" && (r.coach === N_ID || animationById(r.coach)) ? r.coach : null;
  return { picks: newest(picks), set, coach, shape, colour };
}

function newest(picks: Record<string, string>): Record<string, string> {
  const keys = Object.keys(picks);
  if (keys.length <= MAX_PICKS) return picks;
  return Object.fromEntries(keys.slice(keys.length - MAX_PICKS).map((k) => [k, picks[k]]));
}

function read(): MascotChoice {
  try {
    const text = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    return text ? sanitiseChoice(JSON.parse(text)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

let current: MascotChoice | null = null;
const listeners = new Set<() => void>();

export function getChoice(): MascotChoice {
  current ??= read();
  return current;
}

function commit(next: MascotChoice) {
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the choice still holds for this window.
  }
  for (const l of listeners) l();
}

/** Re-reads storage, for another window's change and for tests. */
export function reloadChoice() {
  current = read();
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) reloadChoice();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useMascotChoice(): MascotChoice {
  return useSyncExternalStore(subscribe, getChoice, getChoice);
}

/** Gives one card an animation, or hands it back to the automatic one with null. */
export function chooseFor(seed: string, animation: string | null) {
  const { [seed]: _gone, ...rest } = getChoice().picks;
  commit({ ...getChoice(), picks: animation ? newest({ ...rest, [seed]: animation }) : rest });
}

export function setDefaultSet(set: readonly string[]) {
  commit({ ...getChoice(), set: [...new Set(set)] });
}

/** Puts an animation on the right-hand mascot, or hands it back to the coach with null. */
export function setCoachCharacter(coach: string | null) {
  commit({ ...getChoice(), coach });
}

export function setCoachShape(shape: ShapeId | null) {
  commit({ ...getChoice(), shape });
}

export function setCoachColour(colour: ColorId | null) {
  commit({ ...getChoice(), colour });
}

export function clearPicks() {
  commit({ ...getChoice(), picks: {} });
}

export function resetChoices() {
  commit(EMPTY);
}

/** The chosen coach colour as an inline style, or nothing so the theme colour shows. */
export function coachColourStyle(colour: string | null): CSSProperties | undefined {
  const hex = colour ? COLOR_BY_ID.get(colour)?.hex : undefined;
  return hex ? { color: hex } : undefined;
}

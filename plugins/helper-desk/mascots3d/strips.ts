// The pre-rendered loops. `strips.generated.ts` holds one WebP strip per character, state and palette colour as a
// data URI (nothing is fetched). The module is imported on first use, so a window that never shows a 3D mascot
// never evaluates it. Each strip becomes one CSS class the first time it is needed, and every card that shares it
// reuses the same decoded image.
import { useSyncExternalStore } from "react";
import { character3dById, loopFor, paletteIndex, stateFor, type MascotState } from "./catalog";

let table: Record<string, string> | null = null;
let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const made = new Set<string>();
let sheet: CSSStyleSheet | null = null;

export function loadStrips(): Promise<void> {
  loading ??= import("./strips.generated").then((m) => {
    table = m.STRIPS;
    version++;
    for (const l of listeners) l();
  });
  return loading;
}

export function stripsLoaded(): boolean {
  return table !== null;
}

function subscribe(l: () => void) {
  listeners.add(l);
  void loadStrips();
  return () => {
    listeners.delete(l);
  };
}

/** Re-renders the caller once the strips have loaded. */
export function useStripsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

export interface StripRef {
  /** CSS class that paints the strip. */
  className: string;
  frames: number;
  seconds: number;
}

function sheetFor(): CSSStyleSheet | null {
  if (sheet) return sheet;
  if (typeof document === "undefined") return null;
  const el = document.createElement("style");
  el.setAttribute("data-hd-strips", "");
  document.head.appendChild(el);
  sheet = el.sheet;
  return sheet;
}

/** The key a strip is stored under. Error strips are grey whatever the colour, and a fixed-colour character is the same on every card, so those have one strip per state. */
export function stripKey(id: string, asked: MascotState, colourIndex: number): string {
  const state = stateFor(id, asked);
  const flat = state === "error" || character3dById(id)?.fixedColour;
  return `${id}:${state}:${flat ? 0 : colourIndex}`;
}

/** The strip for a character, state and card colour, or null until the strips have loaded. */
export function stripFor(id: string, state: MascotState, colour: string): StripRef | null {
  if (!table) return null;
  const key = stripKey(id, state, paletteIndex(colour));
  const uri = table[key];
  if (!uri) return null;
  const className = `hd-s-${key.replace(/:/g, "-")}`;
  if (!made.has(className)) {
    const s = sheetFor();
    try {
      s?.insertRule(`.${className}{background-image:url("${uri}")}`, s.cssRules.length);
    } catch {
      // A sheet that refuses the rule leaves the strip blank for this card only.
    }
    made.add(className);
  }
  const loop = loopFor(id, state);
  return { className, frames: loop.frames, seconds: loop.seconds };
}

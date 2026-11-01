// The companion's brain, kept pure so it can be tested without a DOM: given what the person is doing
// right now (pointer, focus, typing, the chat's state), where should the coach go and what mood is he in.
// The DOM wiring lives in companion.tsx.

export interface Point {
  x: number;
  y: number;
}
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Intent = "startled" | "password" | "typing" | "needs" | "sleep" | "curious" | "home";
/** A mood the brain imposes on top of the chat's own state. `ponder` = he thinks while you pause typing. */
export type BrainMood = "sleep" | "ponder" | "watch" | null;

export interface BrainInput {
  now: number;
  vw: number;
  vh: number;
  size: number;
  /** The coach's centre now. */
  pos: Point;
  /** Where the pointer is, or null when it is off the page (or unknown). */
  pointer: Point | null;
  pointerMovedAt: number;
  /** A focused text field: its visual box, the caret (if readable) and whether it is a password. */
  field: { box: Box; caret: Point | null; password: boolean; focusedAt: number } | null;
  lastKeyAt: number;
  lastInputAt: number;
  /** The chat in view: working, waiting, or needs you. */
  mode: "working" | "waiting" | "needs" | "still";
  /** The chat's composer box, for going to it when the chat needs you. */
  composer: Box | null;
  /** The current home spot (his resting place on the right edge), as a centre. */
  home: Point;
  /** An active startle hop: where he is jumping to, until when. */
  startle: { to: Point; until: number } | null;
  /** What he was doing on the previous tick. */
  prevIntent: Intent;
}

export interface Decision {
  intent: Intent;
  target: Point;
  mood: BrainMood;
  /** Where his eyes should point, or null to let them wander. */
  gaze: Point | null;
}

/** He watches typing for this long after the last key (or after focus lands), then lets you be. */
export const TYPING_HOLD_MS = 9000;
export const FOCUS_HOLD_MS = 5000;
/** A pause in typing longer than this and he starts to ponder what you wrote. */
export const PONDER_AFTER_MS = 1600;
/** No input for this long (and the chat is not working) and he falls asleep. */
export const SLEEP_AFTER_MS = 90_000;
/** The pointer has to rest this long before he wanders over, and he loses interest after the second. */
export const REST_BEFORE_VISIT_MS = 1200;
export const VISIT_FOR_MS = 25_000;
/** He keeps his eyes on the pointer for this long after it last moved. */
export const GAZE_HOLD_MS = 6000;
const MARGIN = 8;
const GAP = 6;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep a centre point inside the viewport, with the coach fully visible. */
export function clampToView(p: Point, size: number, vw: number, vh: number): Point {
  const h = size / 2;
  return { x: clamp(p.x, MARGIN + h, Math.max(MARGIN + h, vw - MARGIN - h)), y: clamp(p.y, MARGIN + h, Math.max(MARGIN + h, vh - MARGIN - h)) };
}

/**
 * Where he perches over a text field: sitting on its top edge, above the caret (or the field's right end
 * when the caret is unknown). With no room above (a field at the very top), he sits just below it.
 */
export function perch(box: Box, caret: Point | null, size: number, vw: number, vh: number): Point {
  const x = caret ? caret.x : box.left + box.width - size;
  const above = box.top - GAP - size / 2;
  const y = above - size / 2 >= MARGIN ? above : box.top + box.height + GAP + size / 2;
  return clampToView({ x: clamp(x, box.left + size / 2, box.left + Math.max(size / 2, box.width - size / 2)), y }, size, vw, vh);
}

/** Where he stands to look at a resting pointer: up and to the right of it, or mirrored when that is off screen. */
export function visitSpot(pointer: Point, size: number, vw: number, vh: number): Point {
  const off = size * 0.9 + 26;
  const x = pointer.x + off + size / 2 <= vw - MARGIN ? pointer.x + off : pointer.x - off;
  const y = pointer.y - off - size / 2 >= MARGIN ? pointer.y - off : pointer.y + off;
  return clampToView({ x, y }, size, vw, vh);
}

/** A fast pointer coming right at him: hop away from it. Returns the landing spot, or null for no startle. */
export function startleFrom(pos: Point, pointer: Point, speed: number, size: number, vw: number, vh: number): Point | null {
  const dx = pos.x - pointer.x;
  const dy = pos.y - pointer.y;
  const d = Math.hypot(dx, dy);
  if (d > size * 0.95 || speed < 700) return null;
  const ux = d > 0.5 ? dx / d : 1;
  const uy = d > 0.5 ? dy / d : 0;
  return clampToView({ x: pos.x + ux * size * 1.6, y: pos.y + uy * size * 1.6 }, size, vw, vh);
}

/** Send detection: Enter without Shift, the field had text, and it is empty a moment later. */
export function isSend(enterWithoutShift: boolean, hadText: boolean, emptyAfter: boolean): boolean {
  return enterWithoutShift && hadText && emptyAfter;
}

/** The brain. Priorities, highest first: startle, password, typing, needs you, sleep, curious, home. */
export function decide(i: BrainInput): Decision {
  const pointerFresh = i.pointer && i.now - i.pointerMovedAt < GAZE_HOLD_MS ? i.pointer : null;

  if (i.startle && i.now < i.startle.until) {
    return { intent: "startled", target: i.startle.to, mood: null, gaze: i.pointer };
  }

  if (i.field) {
    const active = i.now - i.lastKeyAt < TYPING_HOLD_MS || i.now - i.field.focusedAt < FOCUS_HOLD_MS;
    if (active) {
      const target = perch(i.field.box, i.field.caret, i.size, i.vw, i.vh);
      if (i.field.password) return { intent: "password", target, mood: "sleep", gaze: null };
      const pause = i.now - i.lastKeyAt;
      const typedRecently = i.lastKeyAt > i.field.focusedAt;
      const mood: BrainMood = typedRecently && pause > PONDER_AFTER_MS && pause < PONDER_AFTER_MS + 2600 ? "ponder" : "watch";
      return { intent: "typing", target, mood, gaze: i.field.caret ?? { x: i.field.box.left + i.field.box.width / 2, y: i.field.box.top } };
    }
  }

  if (i.mode === "needs") {
    const target = i.composer ? perch(i.composer, { x: i.composer.left + i.size, y: i.composer.top }, i.size, i.vw, i.vh) : i.home;
    return { intent: "needs", target, mood: null, gaze: pointerFresh };
  }

  if (i.mode !== "working" && i.now - i.lastInputAt > SLEEP_AFTER_MS) {
    const corner = clampToView({ x: i.vw - i.size / 2 - 16, y: i.vh - i.size / 2 - 90 }, i.size, i.vw, i.vh);
    return { intent: "sleep", target: corner, mood: "sleep", gaze: null };
  }

  if (i.pointer) {
    const rested = i.now - i.pointerMovedAt;
    if (rested > REST_BEFORE_VISIT_MS && rested < VISIT_FOR_MS) {
      return { intent: "curious", target: visitSpot(i.pointer, i.size, i.vw, i.vh), mood: null, gaze: i.pointer };
    }
    // Already out visiting and the pointer is on the move again: stay put and watch it, then go to it
    // once it rests. Without this he would fly home and back on every mouse movement.
    if (rested <= REST_BEFORE_VISIT_MS && (i.prevIntent === "curious" || i.prevIntent === "startled")) {
      return { intent: "curious", target: clampToView(i.pos, i.size, i.vw, i.vh), mood: null, gaze: i.pointer };
    }
  }

  return { intent: "home", target: clampToView(i.home, i.size, i.vw, i.vh), mood: null, gaze: pointerFresh };
}

// The coach companion: the coach living on top of bb, interested in what you are doing.
//
// - His eyes follow the pointer wherever it goes.
// - Rest the pointer somewhere and he wanders over to have a look; rush the pointer at him and he hops away.
// - Focus a text field and he flies over and perches on its top edge above your caret, sliding along as
//   you type, with a little bob on every key. Pause and he ponders. Send, and his eyes roll round his head,
//   he winks and hops.
// - Password fields: he closes his eyes.
// - The chat needs you: he goes to the composer with his badge.
// - Nothing for 90 seconds (and no agent working): he falls asleep in the corner, and wakes up startled.
//
// He only ever reads geometry (pointer position, the caret's rectangle), never what you type, and he
// never takes a click (pointer-events: none). Position, tilt and gaze are written straight to the DOM and
// the engine; React only re-renders when his mood changes. Everything stops while the tab is hidden.
import { useEffect, useRef, useState } from "react";
import { CoachBot, type CoachControl, type Look, type StateId } from "./coach/CoachBot";
import { coachColourStyle, useMascotChoice } from "./mascotchoice";
import { COLOR_BY_ID } from "./coach/bloub/skins";
import { Mascot, PALETTE, type MascotState } from "./mascots";
import { useMascotsOff } from "./mascotgate";
import { useCoachState, type LeadMode } from "./coachstate";
import {
  clamp,
  decide,
  isSend,
  startleFrom,
  type Box,
  type BrainMood,
  type Intent,
  type Point,
} from "./companionmodel";

const SIZE = 58;
/** Home spots along the right edge, as offsets from the bottom-right corner to his centre. */
const HOME_SPOTS: { right: number; bottom: number }[] = [
  { right: 50, bottom: 180 },
  { right: 58, bottom: 270 },
  { right: 46, bottom: 360 },
  { right: 68, bottom: 220 },
];
const TICK_MS = 120;
/** Spring: stiffness and damping (per second). Slightly under-damped so he settles with a little sway. */
const K = 34;
const C = 10.5;
const MAX_SPEED = 1700;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
function editableOf(el: Element | null): HTMLElement | null {
  if (!el || !(el instanceof HTMLElement)) return null;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase()) ? el : null;
  if (el.isContentEditable) return el;
  return null;
}
const textOf = (el: HTMLElement) => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent ?? "");
const isPassword = (el: HTMLElement) => el instanceof HTMLInputElement && el.type === "password";
const toBox = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** The field's visual box: the nearest framed ancestor (a composer card), else the element itself. */
function fieldBox(el: HTMLElement): Box {
  const own = el.getBoundingClientRect();
  let node: HTMLElement | null = el.parentElement;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.height > own.height + 160 || r.width > own.width + 240) break;
    const cs = getComputedStyle(node);
    if (parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== "none" || parseFloat(cs.borderTopLeftRadius) > 0) return toBox(r);
  }
  return toBox(own);
}

const MIRROR_PROPS = [
  "boxSizing", "width", "height", "overflowX", "overflowY", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
  "lineHeight", "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize", "wordBreak", "overflowWrap",
] as const;

/** The caret's screen position. Text inputs use a hidden mirror; rich editors use the selection (read only, never touched). */
function caretOf(el: HTMLElement, mirror: { current: HTMLDivElement | null }): Point | null {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    let div = mirror.current;
    if (!div) {
      div = document.createElement("div");
      div.setAttribute("aria-hidden", "true");
      div.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none";
      document.body.appendChild(div);
      mirror.current = div;
    }
    const cs = getComputedStyle(el);
    for (const p of MIRROR_PROPS) div.style[p] = cs[p];
    div.style.whiteSpace = el instanceof HTMLInputElement ? "pre" : "pre-wrap";
    const pos = el.selectionEnd ?? el.value.length;
    div.textContent = el.value.slice(0, pos);
    const mark = document.createElement("span");
    mark.textContent = el.value.slice(pos) || ".";
    div.appendChild(mark);
    const r = el.getBoundingClientRect();
    return {
      x: r.left + parseFloat(cs.borderLeftWidth) + mark.offsetLeft - el.scrollLeft,
      y: r.top + parseFloat(cs.borderTopWidth) + mark.offsetTop - el.scrollTop,
    };
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getClientRects()[0];
  if (rect && rect.height > 0) return { x: rect.left, y: rect.top };
  // A collapsed caret in an empty line has no rects: use the line's own box.
  const node = range.startContainer;
  const host = node instanceof Element ? node : node.parentElement;
  if (!host) return null;
  const r = host.getBoundingClientRect();
  return Number.isFinite(r.left) ? { x: r.left + 2, y: r.top } : null;
}

/** The composer in view (bb's is a ProseMirror editor), for going to it when the chat needs you. */
function composerBox(): Box | null {
  const eds = Array.from(document.querySelectorAll<HTMLElement>(".ProseMirror[contenteditable=true]"));
  for (let k = eds.length - 1; k >= 0; k--) {
    const r = eds[k]!.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top < window.innerHeight) return fieldBox(eds[k]!);
  }
  return null;
}

function homeCentre(index: number): Point {
  const s = HOME_SPOTS[index % HOME_SPOTS.length]!;
  return { x: window.innerWidth - s.right, y: window.innerHeight - s.bottom };
}

/** The final face: reactions first, then sleep, the chat's badge, pondering, watching, the chat's own mood. */
/** The avatar's state for the coach's face: thinking and needs-you are lively, a wink settles, everything else is calm. */
export function mascotStateForFace(face: StateId): MascotState {
  if (face === "thinking" || face === "notify") return "work";
  if (face === "wink") return "done";
  return "idle";
}

/** The colour handed to the right-hand mascot: the chosen swatch, or cobalt when the colour follows the theme. */
function coachTint(colour: string | null): string {
  return (colour ? COLOR_BY_ID.get(colour)?.hex : undefined) ?? PALETTE[1];
}

function faceFor(base: StateId, mood: BrainMood, reaction: StateId | null): StateId {
  if (reaction) return reaction;
  if (mood === "sleep") return "sleep";
  if (base === "notify") return "notify";
  if (mood === "ponder") return "thinking";
  if (mood === "watch" && base === "thinking") return "idle";
  return base;
}

export function CoachCompanion({ mode }: { mode: LeadMode }) {
  const base = useCoachState(mode, true);
  const [mood, setMood] = useState<BrainMood>(null);
  const [reaction, setReaction] = useState<StateId | null>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const squashRef = useRef<HTMLDivElement>(null);
  const control = useRef<CoachControl | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const still = reducedMotion();
    let alive = true;
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => {
      const t = window.setTimeout(() => {
        timers.delete(t);
        if (alive) fn();
      }, ms);
      timers.add(t);
    };

    // ---- body state ----
    let homeIndex = Math.floor(Math.random() * HOME_SPOTS.length);
    const start = homeCentre(homeIndex);
    const pos = { ...start };
    const vel = { x: 0, y: 0 };
    let target = { ...start };
    let raf = 0;
    let last = 0;
    const write = () => {
      const tilt = clamp(vel.x * 0.012, -12, 12);
      outer.style.transform = `translate3d(${(pos.x - SIZE / 2).toFixed(1)}px, ${(pos.y - SIZE / 2).toFixed(1)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
    };
    write();
    const step = (ms: number) => {
      raf = 0;
      const dt = last ? Math.min((ms - last) / 1000, 0.05) : 1 / 60;
      last = ms;
      const ax = K * (target.x - pos.x) - C * vel.x;
      const ay = K * (target.y - pos.y) - C * vel.y;
      vel.x += ax * dt;
      vel.y += ay * dt;
      const sp = Math.hypot(vel.x, vel.y);
      if (sp > MAX_SPEED) {
        vel.x *= MAX_SPEED / sp;
        vel.y *= MAX_SPEED / sp;
      }
      pos.x += vel.x * dt;
      pos.y += vel.y * dt;
      write();
      const settled = Math.hypot(target.x - pos.x, target.y - pos.y) < 0.6 && Math.hypot(vel.x, vel.y) < 6;
      if (settled) {
        pos.x = target.x;
        pos.y = target.y;
        vel.x = vel.y = 0;
        write();
        last = 0;
        return;
      }
      if (document.visibilityState === "visible") raf = requestAnimationFrame(step);
      else last = 0;
    };
    const moveTo = (p: Point) => {
      if (Math.abs(p.x - target.x) < 0.5 && Math.abs(p.y - target.y) < 0.5) return;
      // Reduced motion: he stays put at home as a still face, no flying, no jumps.
      if (still) return;
      target = p;
      if (!raf && document.visibilityState === "visible") raf = requestAnimationFrame(step);
    };

    // ---- little body animations (Web Animations, on the inner element) ----
    let lastBob = 0;
    const bob = () => {
      const el = squashRef.current;
      const t = performance.now();
      if (!el || still || t - lastBob < 110) return;
      lastBob = t;
      el.animate([{ transform: "none" }, { transform: "translateY(2px) scale(1.07, 0.91)" }, { transform: "none" }], { duration: 200, easing: "ease-out" });
    };
    const hop = (height = 18) => {
      const el = squashRef.current;
      if (!el || still) return;
      el.animate(
        [
          { transform: "none" },
          { transform: "translateY(3px) scale(1.08, 0.9)", offset: 0.15 },
          { transform: `translateY(-${height}px) scale(0.94, 1.07)`, offset: 0.5 },
          { transform: "translateY(2px) scale(1.06, 0.93)", offset: 0.85 },
          { transform: "none" },
        ],
        { duration: 560, easing: "ease-in-out" },
      );
    };
    let reactionUntil = 0;
    const react = (s: StateId, ms: number) => {
      reactionUntil = performance.now() + ms;
      setReaction(s);
      later(() => {
        if (performance.now() >= reactionUntil - 5) setReaction(null);
      }, ms);
    };

    // ---- gaze ----
    let spinBase = 0;
    let lastLook: Look | null = null;
    let scrollLook: { dir: number; until: number } | null = null;
    const lookAt = (p: Point | null, morph?: number) => {
      const c = control.current;
      if (!c) return;
      let next: Look | null = null;
      if (scrollLook && performance.now() < scrollLook.until) {
        next = { yaw: 0, pitch: scrollLook.dir > 0 ? -18 : 24, mix: 0.9, spin: spinBase, wander: 0 };
      } else if (p) {
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        next = { yaw: clamp(dx / 300, -1, 1) * 34, pitch: clamp(6 - (dy / 300) * 24, -20, 30), mix: 0.9, spin: spinBase, wander: 0 };
      } else if (spinBase !== 0) {
        next = { yaw: 0, pitch: 0, mix: 0, spin: spinBase, wander: 1 };
      }
      if (morph === undefined && next && lastLook && Math.abs(next.yaw - lastLook.yaw) < 0.8 && Math.abs(next.pitch - lastLook.pitch) < 0.8 && next.spin === lastLook.spin && next.mix === lastLook.mix) return;
      if (morph === undefined && !next && !lastLook) return;
      lastLook = next;
      c.look(next, morph);
    };
    const celebrate = () => {
      spinBase += 360;
      lookAt(lastGaze, 1.1);
      react("wink", 1700);
      hop(22);
    };

    // ---- what the person is doing ----
    let pointer: Point | null = null;
    /** "Never": performance.now() starts near zero on a fresh page, so 0 would read as "just now". */
    const NEVER = -1e9;
    let pointerMovedAt = NEVER;
    let pointerSpeed = 0;
    let lastInputAt = performance.now();
    let lastKeyAt = NEVER;
    let lastAnyKeyAt = NEVER;
    let field: HTMLElement | null = null;
    let focusedAt = NEVER;
    let caret: Point | null = null;
    let startle: { to: Point; until: number } | null = null;
    let lastStartleAt = 0;
    let prevIntent: Intent = "home";
    let lastGaze: Point | null = null;
    const mirror = { current: null as HTMLDivElement | null };

    const wake = () => {
      if (prevIntent === "sleep") {
        react("wide", 1300);
        hop(14);
        prevIntent = "home";
      }
    };
    const readCaret = () => {
      if (field) caret = caretOf(field, mirror);
    };

    let gazeQueued = false;
    const onPointerMove = (e: PointerEvent) => {
      const now = performance.now();
      if (pointer) {
        const dt = Math.max(now - pointerMovedAt, 8) / 1000;
        const inst = Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) / dt;
        pointerSpeed = pointerSpeed * 0.6 + inst * 0.4;
      }
      pointer = { x: e.clientX, y: e.clientY };
      pointerMovedAt = now;
      lastInputAt = now;
      wake();
      if (now - lastStartleAt > 1500 && prevIntent !== "typing" && prevIntent !== "password") {
        const to = startleFrom(pos, pointer, pointerSpeed, SIZE, window.innerWidth, window.innerHeight);
        if (to) {
          lastStartleAt = now;
          startle = { to, until: now + 1300 };
          react("wide", 1100);
          hop(16);
          moveTo(to);
        }
      }
      if (!gazeQueued && prevIntent !== "typing" && prevIntent !== "password" && prevIntent !== "sleep") {
        gazeQueued = true;
        requestAnimationFrame(() => {
          gazeQueued = false;
          if (alive && pointer) lookAt(pointer);
        });
      }
    };
    const onPointerLeave = () => {
      pointer = null;
    };
    const onPointerDown = (e: PointerEvent) => {
      lastInputAt = performance.now();
      wake();
      if (Math.hypot(e.clientX - pos.x, e.clientY - pos.y) < SIZE) react("wide", 900);
      // Clicking into a field that already has focus fires no focusin, but it still means "I'm about to type".
      const el = editableOf(e.target instanceof Element ? (e.target.closest("[contenteditable=true],textarea,input") ?? e.target) : null);
      if (el) {
        field = el;
        focusedAt = performance.now();
        requestAnimationFrame(() => alive && readCaret());
      }
    };
    const onWheel = (e: WheelEvent) => {
      lastInputAt = performance.now();
      wake();
      if (Math.abs(e.deltaY) > 2) {
        scrollLook = { dir: Math.sign(e.deltaY), until: performance.now() + 700 };
        lookAt(lastGaze);
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = editableOf(e.target as Element);
      if (!el) return;
      field = el;
      // Only a focus the person caused calls him over: a click inside the field (handled on pointerdown)
      // or a key just before (Tab). bb autofocusing the composer after a thread switch should not.
      const now = performance.now();
      if (now - lastAnyKeyAt < 400) focusedAt = now;
      readCaret();
    };
    const onFocusOut = () => {
      later(() => {
        const el = editableOf(document.activeElement);
        if (!el) field = null;
        else if (el !== field) {
          field = el;
          focusedAt = performance.now();
        }
      }, 0);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const el = editableOf(e.target as Element);
      lastInputAt = performance.now();
      lastAnyKeyAt = lastInputAt;
      wake();
      if (!el) return;
      if (el !== field) {
        field = el;
        focusedAt = performance.now();
      }
      if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
      lastKeyAt = performance.now();
      bob();
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !isPassword(el)) {
        const hadText = textOf(el).trim().length > 0;
        let done = false;
        const check = () => {
          if (done || !isSend(true, hadText, textOf(el).trim().length === 0)) return;
          done = true;
          celebrate();
          lastKeyAt = NEVER;
          focusedAt = NEVER;
        };
        // bb may clear the box after an await, so look twice.
        later(check, 60);
        later(check, 400);
      }
      requestAnimationFrame(() => alive && readCaret());
    };
    // Typing as the field sees it (covers dictation, paste, IME and synthetic keys that skip keydown).
    const onInput = (e: Event) => {
      const el = editableOf(e.target as Element);
      if (!el) return;
      const now = performance.now();
      if (el !== field) {
        field = el;
        focusedAt = now;
      }
      lastInputAt = now;
      if (now - lastKeyAt > 40) bob();
      lastKeyAt = now;
      wake();
      requestAnimationFrame(() => alive && readCaret());
    };
    let selQueued = false;
    const onSelection = () => {
      if (!field || selQueued) return;
      selQueued = true;
      requestAnimationFrame(() => {
        selQueued = false;
        if (alive) readCaret();
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        lastInputAt = performance.now();
        if (!raf) raf = requestAnimationFrame(step);
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      }
    };

    // ---- the brain, a few times a second ----
    let currentMood: BrainMood = null;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const now = performance.now();
      if (startle && now >= startle.until) startle = null;
      if (field && !document.contains(field)) field = null;
      const d = decide({
        now,
        vw: window.innerWidth,
        vh: window.innerHeight,
        size: SIZE,
        pos,
        pointer,
        pointerMovedAt,
        field: field ? { box: fieldBox(field), caret, password: isPassword(field), focusedAt } : null,
        lastKeyAt,
        lastInputAt,
        mode: modeRef.current,
        composer: modeRef.current === "needs" ? composerBox() : null,
        home: homeCentre(homeIndex),
        startle,
        prevIntent,
      });
      if (d.intent === "sleep" && prevIntent !== "sleep") lookAt(null, 0.6);
      if (d.intent === "needs" && prevIntent !== "needs") hop(20);
      if (d.intent !== prevIntent) outer.dataset.intent = d.intent;
      prevIntent = d.intent;
      moveTo(d.target);
      if (d.mood !== currentMood) {
        currentMood = d.mood;
        setMood(d.mood);
      }
      lastGaze = d.gaze;
      if (d.intent !== "sleep" && d.intent !== "password") lookAt(d.gaze);
      else if (d.intent === "password") lookAt(null);
    };
    const brain = window.setInterval(tick, TICK_MS);

    // He wanders between home spots every 20-40 s, and bounces for attention while the chat needs you.
    const drift = () => {
      let n = homeIndex;
      while (n === homeIndex) n = Math.floor(Math.random() * HOME_SPOTS.length);
      homeIndex = n;
      later(drift, 20_000 + Math.random() * 20_000);
    };
    later(drift, 20_000 + Math.random() * 20_000);
    const nudge = () => {
      if (prevIntent === "needs") hop(14);
      later(nudge, 3200);
    };
    later(nudge, 3200);

    const opts = { capture: true, passive: true } as const;
    document.addEventListener("pointermove", onPointerMove, opts);
    document.addEventListener("pointerdown", onPointerDown, opts);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("blur", onPointerLeave);
    document.addEventListener("wheel", onWheel, opts);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("selectionchange", onSelection);
    document.addEventListener("visibilitychange", onVisibility);
    // Focus may already be in a field when he arrives.
    const already = editableOf(document.activeElement);
    if (already) {
      field = already;
    }

    return () => {
      alive = false;
      window.clearInterval(brain);
      timers.forEach((t) => window.clearTimeout(t));
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("pointermove", onPointerMove, opts);
      document.removeEventListener("pointerdown", onPointerDown, opts);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("blur", onPointerLeave);
      document.removeEventListener("wheel", onWheel, opts);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("visibilitychange", onVisibility);
      mirror.current?.remove();
    };
  }, []);

  const face = faceFor(base, mood, reaction);
  const choice = useMascotChoice();
  const mascotsOff = useMascotsOff();
  return (
    <div ref={outerRef} className={`hd-companion hd-companion-${mode}${mood === "watch" ? " hd-companion-watch" : ""}`} style={coachColourStyle(choice.colour)} data-coach-face={face} aria-hidden="true">
      <div className="hd-companion-bob">
        <div ref={squashRef} className="hd-companion-squash">
          {choice.coach && !mascotsOff ? (
            <Mascot seed="coach" character={choice.coach} colour={coachTint(choice.colour)} state={mascotStateForFace(face)} size={SIZE} />
          ) : (
            <CoachBot size={SIZE} state={face} control={control} shape={choice.shape ?? undefined} />
          )}
        </div>
      </div>
    </div>
  );
}

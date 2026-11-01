// The NavAIgate N avatar. Like Avatar it owns no timer and no animation frame: it registers with the shared loop
// (30 fps at most, asleep when hidden, off screen or under reduced motion, where it draws one still frame) and hands
// over on unmount. The look blends between states over a third of a second so a card going from idle to working
// does not jump.
import { useEffect, useRef, type CSSProperties } from "react";
import { INK_VAR } from "./Avatar";
import { startOffset } from "./assign";
import { OPEN_SECONDS, STILL_T, drawNavN, type NCtx } from "./nmark";
import { MAX_FPS, observeVisibility, resolveInk, sharedLoop, type AvatarHandle } from "./engine";
import type { MascotState } from "../mascots3d/catalog";

export interface NavNProps {
  seed: string;
  state: MascotState;
  size?: number;
  /** Plays the film's open (a dot, then the mark grows out of it) when it first appears. Default true. */
  open?: boolean;
  label?: string;
}

/** How long a change of state takes to blend, in seconds. */
export const BLEND_SECONDS = 0.45;

export interface Blend {
  work: number;
  wait: number;
  ring: number;
}

/** Where each look is headed for a state. The orbit turns while it works and while it waits for you. */
export function targetsFor(state: MascotState): Blend {
  return { work: state === "work" ? 1 : 0, wait: state === "wait" ? 1 : 0, ring: state === "work" || state === "wait" ? 1 : 0 };
}

/** How long a held state (done, error) keeps the loop playing so the orbit can ease out before the frame freezes. */
export const HOLD_AFTER_SECONDS = BLEND_SECONDS + 0.1;

interface BlendState {
  from: Blend;
  to: Blend;
  since: number;
}

/** Where the blend is `now`: eased from the look it was in when the state changed to the look it is heading for. */
export function blendAt(b: BlendState, now: number, moving = true): Blend {
  const k = moving ? Math.min(1, Math.max(0, (now - b.since) / (BLEND_SECONDS * 1000))) : 1;
  const e = k * k * (3 - 2 * k);
  return { work: b.from.work + (b.to.work - b.from.work) * e, wait: b.from.wait + (b.to.wait - b.from.wait) * e, ring: b.from.ring + (b.to.ring - b.from.ring) * e };
}

export function NavN({ seed, state, size = 48, open = true, label }: NavNProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<AvatarHandle | null>(null);
  const held = state === "done" || state === "error";
  // The film's N is full ink at rest; only a failed one is dimmed. It plays in every state except the two it holds still in.
  const alpha = state === "error" ? 0.4 : 1;
  const goal = targetsFor(state);
  // The blend runs on the wall clock. On mount the orbit eases in from nothing, so a card that opens working does not pop.
  const blend = useRef<BlendState>({ from: { ...goal, ring: 0 }, to: goal, since: typeof performance === "undefined" ? 0 : performance.now() });
  const born = useRef(typeof performance === "undefined" ? 0 : performance.now());

  useEffect(() => {
    const b = blend.current;
    const now = performance.now();
    b.from = blendAt(b, now);
    b.to = goal;
    b.since = now;
    // A held state keeps the loop playing for a moment, so the orbit eases out instead of vanishing with the freeze.
    handle.current?.update({ speed: 1, alpha });
    if (!held) return;
    const timer = window.setTimeout(() => handle.current?.update({ speed: 0 }), HOLD_AFTER_SECONDS * 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.work, goal.wait, goal.ring, held, alpha]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const h = sharedLoop().register({
      canvas,
      draw: (ctx, px, t, style) => {
        const moving = style.moving !== false;
        const now = performance.now();
        const age = (now - born.current) / 1000;
        const b = blendAt(blend.current, now, moving);
        drawNavN(ctx as unknown as NCtx, px, t, { ink: style.ink, alpha: style.alpha, moving, work: b.work, wait: b.wait, ring: b.ring, born: open && age < OPEN_SECONDS ? age : null });
      },
      size,
      ink: () => resolveInk(canvas),
      speed: held ? 0 : 1,
      alpha,
      still: STILL_T,
      fps: MAX_FPS,
      offset: startOffset(seed),
    });
    handle.current = h;
    const stop = observeVisibility(canvas);
    return () => {
      stop();
      h?.dispose();
      handle.current = null;
    };
    // The look is applied by the effect above, so a state change does not re-register.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, seed, open]);

  const style: CSSProperties = { display: "block", width: "100%", height: "100%", color: INK_VAR };
  return <canvas ref={ref} className="hd-av hd-navn" data-avatar="navn" data-state={state} style={style} width={size} height={size} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

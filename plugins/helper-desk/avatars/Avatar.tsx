// One avatar: a canvas that the shared loop draws into. It owns no timer and no animation frame; it registers
// with the loop on mount and hands over on unmount, so a hundred rows cost one requestAnimationFrame.
import { useEffect, useRef, type CSSProperties } from "react";
import { animationById, type AnimationId } from "./animations";
import { lookFor, startOffset } from "./assign";
import { liveBlue, observeVisibility, resolveInk, sharedLoop, type AvatarHandle } from "./engine";
import type { MascotState } from "../mascots3d/catalog";

/** Where the avatar's ink comes from: a theme variable of its own, then the page foreground. */
export const INK_VAR = "var(--hd-avatar-ink, var(--foreground, CanvasText))";

export interface AvatarProps {
  animation: AnimationId;
  /** Seeds the start offset so neighbouring avatars are out of step. */
  seed: string;
  state: MascotState;
  size?: number;
  /** A tile preview: always moving, never blue, whatever the agent state. */
  preview?: boolean;
  label?: string;
}

export function Avatar({ animation, seed, state, size = 32, preview = false, label }: AvatarProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<AvatarHandle | null>(null);
  const look = lookFor(state, preview);
  const def = animationById(animation)!;
  const tone = useRef(look.tone);
  tone.current = look.tone;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const h = sharedLoop().register({
      canvas,
      draw: def.draw,
      size,
      ink: () => {
        const ink = resolveInk(canvas);
        return tone.current === "live" ? liveBlue(ink) : ink;
      },
      speed: look.speed,
      alpha: look.alpha,
      still: def.still,
      offset: startOffset(seed),
    });
    handle.current = h;
    const stop = observeVisibility(canvas);
    return () => {
      stop();
      h?.dispose();
      handle.current = null;
    };
    // The look is applied by the effect below, so a state change does not re-register.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, size, seed]);

  useEffect(() => {
    // Only this avatar's state changed, so only this avatar re-reads its colour; the page-wide repaint is for theme changes.
    handle.current?.update({ speed: look.speed, alpha: look.alpha });
    handle.current?.refreshInk();
  }, [look.speed, look.alpha, look.tone]);

  const style: CSSProperties = { display: "block", width: "100%", height: "100%", color: INK_VAR };
  return <canvas ref={ref} className="hd-av" data-avatar={animation} data-tone={look.tone} style={style} width={size} height={size} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

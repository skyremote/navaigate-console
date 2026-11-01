// The coach's mood, shared by the lead card and the companion.
import { useEffect, useRef, useState } from "react";
import type { StateId } from "./coach/CoachBot";

export type LeadMode = "working" | "waiting" | "needs" | "still";
export const WINK_MS = 1600;

/**
 * Maps the lead's mode to a coach state. Thinking turns the body into three dots, so a long run would
 * hide the face: while working, a live coach alternates a thinking burst (about 3 s) with looking round
 * as himself (about 4.5 s). A short wink marks the edge from working to waiting. Still faces (headers,
 * history) are always the plain face, or the badge when the chat needs you.
 */
export function useCoachState(mode: LeadMode, live = true): StateId {
  const prev = useRef(mode);
  const [winking, setWinking] = useState(false);
  const [thinkPhase, setThinkPhase] = useState(true);
  useEffect(() => {
    const was = prev.current;
    prev.current = mode;
    if (was === "working" && mode === "waiting") {
      setWinking(true);
      const t = window.setTimeout(() => setWinking(false), WINK_MS);
      return () => window.clearTimeout(t);
    }
    setWinking(false);
    return undefined;
  }, [mode]);
  useEffect(() => {
    if (!live || mode !== "working") return;
    let alive = true;
    let t = 0;
    const flip = (thinking: boolean) => {
      if (!alive) return;
      setThinkPhase(thinking);
      t = window.setTimeout(() => flip(!thinking), thinking ? 3000 : 4500);
    };
    flip(true);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [mode, live]);
  if (mode === "needs") return "notify";
  if (!live) return "idle";
  if (winking) return "wink";
  if (mode === "working") return thinkPhase ? "thinking" : "idle";
  return "idle";
}


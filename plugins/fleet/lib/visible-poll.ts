import { useEffect, useRef } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";

export const documentVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/** Runs on an interval, only while the document is shown, and once when it comes back. */
export function useVisiblePoll(run: () => void, ms: number | null): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (ms === null) return;
    const tick = () => {
      if (documentVisible()) latest.current();
    };
    const id = window.setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
}

/** A realtime refresh that waits while the document is hidden and runs once on return. */
export function useVisibleRealtime(channel: string, refresh: () => void): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  const missed = useRef(false);
  useRealtime(channel, () => {
    if (documentVisible()) latest.current();
    else missed.current = true;
  });
  useEffect(() => {
    const onVisible = () => {
      if (!missed.current || !documentVisible()) return;
      missed.current = false;
      latest.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}

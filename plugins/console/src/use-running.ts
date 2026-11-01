// The running view as React sees it: this bb's chats with grouped conversations
// folded into their roots, Fleet's board, and the clock, built once per surface
// by the one rule in running.ts.
import { useEffect, useMemo, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useFleetBoard } from "./fleet-board";
import { foldNativeMembers, useNativeConversationIndex } from "./native-session-rail";
import { STUCK_AFTER_MS, ownIdsOf, runningView, type RunningView } from "./running";
import type { FleetBoard } from "./machines";
import { useProfile } from "./use-profile";
import { homeMachineId } from "../lib/profile-text";

/**
 * The time the running view is judged at. It moves only when another Mac's running row is
 * about to turn "stuck?" (two hours after its last activity), so a quiet screen
 * is never re-rendered by a timer and a chat still turns over on its own.
 */
export function useStuckClock(oldestRunningAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (oldestRunningAt === null) return;
    const wait = oldestRunningAt + STUCK_AFTER_MS - Date.now() + 1_000;
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(wait, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [oldestRunningAt]);
  return now;
}

/** The running view for a list of this bb's chats and a board, with the clock above. */
export function useRunningView(threads: readonly PluginSidebarThread[], ownIds: ReadonlySet<string>, board: FleetBoard | null): { view: RunningView; now: number } {
  const [oldest, setOldest] = useState<number | null>(null);
  const now = useStuckClock(oldest);
  const profile = useProfile();
  const serverKey = board?.serverKey ?? homeMachineId(profile);
  const view = useMemo(() => runningView({ threads, ownIds, serverKey, board, now }), [threads, ownIds, serverKey, board, now]);
  // Only another Mac's rows can turn stuck, so only they need the clock to move.
  const fleetRunning = view.running.filter((i) => i.source === "fleet");
  const oldestNow = fleetRunning.length > 0 ? Math.min(...fleetRunning.map((i) => i.updatedAt)) : null;
  useEffect(() => setOldest(oldestNow), [oldestNow]);
  return { view, now };
}

export type RunningState = { threads: readonly PluginSidebarThread[]; view: RunningView; board: FleetBoard | null; now: number };

export function useRunning(physical: readonly PluginSidebarThread[]): RunningState {
  const conversations = useNativeConversationIndex(physical);
  const threads = useMemo(() => foldNativeMembers(physical, conversations), [physical, conversations]);
  const fleet = useFleetBoard();
  const board = fleet?.available ? fleet.board : null;
  const ownIds = useMemo(() => ownIdsOf(physical, conversations), [physical, conversations]);
  const { view, now } = useRunningView(threads, ownIds, board);
  return { threads, view, board, now };
}

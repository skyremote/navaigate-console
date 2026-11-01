// What is running: one definition for every surface that says so. The Home
// header and Running tile, the rail's NOW card and "N working" line, the rail's
// machine tiles and Home's Machines card all read the view built here, so they
// cannot disagree. Pure, no React or SDK.
//
// A chat is running when it has an active turn. A grouped native conversation
// is one chat however many of its members run (the rail folds its hidden
// members into the root row first). A chat on another Mac comes from Fleet's
// board; a row for a chat this bb already knows is that chat, not a second one.
// A row from another Mac's snapshot that reports running but has shown no
// activity for over two hours is "stuck?": it keeps its age and is listed, but it
// is not counted as running. A chat in this bb's own list is never second-guessed:
// its status is live, and updatedAt may not move during a long streaming turn.

import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { machineKeyOf, remoteFor, sinceLabel, type FleetBoard } from "./machines";
import { getProfile } from "./use-profile";
import { stateOf } from "./shared";
import { machineLabel } from "../profile/schema";

export const STUCK_AFTER_MS = 2 * 3_600_000;

export type RunningItem = {
  id: string;
  machine: string;
  title: string;
  providerId: string | null;
  /** The chat's latest activity; for a grouped conversation, its newest member's. */
  updatedAt: number;
  /** "here" is a chat in this bb's own list; "fleet" is one only Fleet's board knows. */
  source: "here" | "fleet";
};

export type MachineRunning = { running: number; stuck: number; stuckAt: number | null };

export type RunningView = {
  /** Counted as running, newest first. */
  running: RunningItem[];
  /** Another Mac's rows reported running with no activity for over two hours, newest first. */
  stuck: RunningItem[];
  byMachine: Record<string, MachineRunning>;
};

/** How long a chat has been quiet: "3h", and hours up to three days ("33h") so the age is not rounded to "1d". */
export function quietFor(since: number, now: number): string {
  const hours = Math.floor((now - since) / 3_600_000);
  return hours >= 24 && hours < 72 ? `${hours}h` : sinceLabel(since, now);
}

export function isStuck(updatedAt: number, now: number): boolean {
  return Number.isFinite(updatedAt) && now - updatedAt > STUCK_AFTER_MS;
}

export type RunningInput = {
  /** This bb's chats after the rail's fold, so a running hidden member shows on its root. */
  threads: readonly PluginSidebarThread[];
  /** Every id this bb knows (its chats and each grouped conversation's members), so Fleet's copy of one is not counted again. */
  ownIds?: ReadonlySet<string>;
  serverKey: string;
  board: FleetBoard | null;
  now: number;
};

export function runningView({ threads, ownIds, serverKey, board, now }: RunningInput): RunningView {
  const items: RunningItem[] = [];
  const seen = new Set<string>();
  for (const t of threads) {
    if (t.isHidden || t.isArchived || stateOf(t) !== "running") continue;
    seen.add(t.id);
    items.push({
      id: t.id,
      machine: machineKeyOf(t.host?.name ?? null, serverKey, getProfile()),
      title: t.displayTitle || t.title || t.titleFallback || t.id,
      providerId: t.providerId,
      updatedAt: t.updatedAt,
      source: "here",
    });
  }
  if (board) {
    for (const column of board.columns) {
      for (const t of remoteFor(board, column.key)) {
        if (t.state !== "running" || seen.has(t.id) || ownIds?.has(t.id)) continue;
        seen.add(t.id);
        items.push({ id: t.id, machine: t.machine || column.key, title: t.title, providerId: t.providerId, updatedAt: t.updatedAt, source: "fleet" });
      }
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  const quiet = (i: RunningItem) => i.source === "fleet" && isStuck(i.updatedAt, now);
  const running = items.filter((i) => !quiet(i));
  const stuck = items.filter(quiet);
  const byMachine: Record<string, MachineRunning> = {};
  const slot = (key: string) => (byMachine[key] ??= { running: 0, stuck: 0, stuckAt: null });
  for (const i of running) slot(i.machine).running += 1;
  for (const i of stuck) {
    const m = slot(i.machine);
    m.stuck += 1;
    m.stuckAt = Math.max(m.stuckAt ?? 0, i.updatedAt);
  }
  return { running, stuck, byMachine };
}

/**
 * The ids this bb already counts itself, so Fleet's copy of one is not counted
 * again: its visible chats, and a grouped conversation's members when the
 * conversation's root is one of those visible chats (the fold counts them
 * through it). Anything else, such as a hidden chat with no visible root, is
 * not here, so a Fleet row for it still counts.
 */
export function ownIdsOf(
  threads: readonly PluginSidebarThread[],
  conversations: ReadonlyArray<{ rootThreadId: string; memberIds: readonly string[] }>,
): Set<string> {
  const visible = new Set(threads.filter((t) => !t.isHidden && !t.isArchived).map((t) => t.id));
  const ids = new Set(visible);
  for (const c of conversations) {
    if (!visible.has(c.rootThreadId)) continue;
    for (const id of c.memberIds) ids.add(id);
  }
  return ids;
}

/** "M5 1 · M1 0" for the Running tile; every Mac on the board, in the order given. */
export function splitLabel(view: RunningView, machines: readonly string[]): string {
  const keys = machines.length > 0 ? machines : Object.keys(view.byMachine);
  return keys.map((k) => `${machineLabel(getProfile(), k)} ${view.byMachine[k]?.running ?? 0}`).join(" · ");
}

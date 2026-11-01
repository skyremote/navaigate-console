import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { NativeSessionIndex } from "../server-native-sessions";
import type { rpcContract } from "../server";
import { rpcFlight } from "./rpc-flight";
import { stateOf } from "./shared";
import { keepIfSame } from "./stable";
import { startVisiblePoll, useVisibleRealtime } from "./visible-poll";

type Conversation = NativeSessionIndex["conversations"][number];
type MemberLive = Conversation["members"][number];
type Exec = { model: string; reasoningLevel: string };
const NO_ACTIVITY = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 };

const BUSY = new Set(["active", "starting", "stopping"]);
const ASKING = new Set(["waiting-for-input"]);
// Not "unread-error": a hidden member is read inside the overlay, so it could stick.
const FAILED = new Set(["queued-failed"]);
const quiet = (t: PluginSidebarThread) => !BUSY.has(t.status);
const OUTRANKS = new Set(["unread-error", "waiting-for-input", "queued-failed"]);

/**
 * A member bb's list does not carry (it leaves hidden threads out), seen
 * through the index's live snapshot. Only the fields the fold reads differ
 * from the root's; the copy never reaches a row of its own.
 */
function fromLive(root: PluginSidebarThread, live: MemberLive): PluginSidebarThread {
  const asking = live.hasPendingInteraction;
  return {
    ...root,
    id: live.id,
    projectId: live.projectId,
    providerId: live.providerId,
    status: live.status as PluginSidebarThread["status"],
    runtimeStatus: live.status as PluginSidebarThread["runtimeStatus"],
    hasPendingInteraction: asking,
    activity: NO_ACTIVITY,
    indicator: asking ? "waiting-for-input" : BUSY.has(live.status) ? "runtime" : "none",
    indicatorLabel: asking ? "Thread needs user input" : BUSY.has(live.status) ? "Thread working" : null,
    isHidden: live.isHidden,
    isArchived: live.isArchived,
    isUnread: false,
    updatedAt: live.updatedAt ?? root.updatedAt,
  };
}

/** The active hidden member, when the conversation has moved off its root. */
function activeHidden(conversation: Conversation, root: PluginSidebarThread): MemberLive | undefined {
  if (conversation.activeThreadId === root.id) return undefined;
  const live = conversation.members?.find((m) => m.id === conversation.activeThreadId);
  return live && live.isHidden && !live.isArchived && live.projectId === root.projectId ? live : undefined;
}

/**
 * A grouped native conversation shows only its root in the rail; its
 * continuations and parallel models are hidden threads. Give the root row the
 * live state of its hidden members: any member running makes it run, any member
 * asking for input makes it need the owner, and the active member's failure shows
 * as well. The row also takes the active member's provider, so its harness is
 * the one the conversation now runs on (the physical root is never changed).
 * Rows that change are copied; every other row keeps its identity.
 */
export function foldNativeMembers(
  threads: readonly PluginSidebarThread[],
  conversations: readonly Conversation[],
): readonly PluginSidebarThread[] {
  if (conversations.length === 0) return threads;
  const byId = new Map(threads.map((t) => [t.id, t]));
  const folded = new Map<string, PluginSidebarThread>();
  for (const conversation of conversations) {
    const root = byId.get(conversation.rootThreadId);
    if (!root || root.isHidden) continue;
    const liveById = new Map((conversation.members ?? []).map((m) => [m.id, m]));
    // bb's own row wins when it has one; otherwise the index's live snapshot.
    // A visible member already shows its own state on its own row.
    const members = conversation.memberIds
      .filter((id) => id !== root.id)
      .map((id) => byId.get(id) ?? (liveById.has(id) ? fromLive(root, liveById.get(id)!) : undefined))
      .filter((t): t is PluginSidebarThread => !!t && t.isHidden && !t.isArchived && t.projectId === root.projectId);
    if (members.length === 0) continue;
    // The active member leads, so its status is the one the row borrows.
    members.sort((a, b) => Number(b.id === conversation.activeThreadId) - Number(a.id === conversation.activeThreadId));
    const logical = activeHidden(conversation, root);
    let next = logical && logical.providerId !== root.providerId ? { ...root, providerId: logical.providerId } : root;
    // The row's time is the conversation's latest activity: its newest member's, not the root session's.
    const latest = Math.max(root.updatedAt, ...members.map((t) => t.updatedAt));
    if (latest > next.updatedAt) next = { ...next, updatedAt: latest };
    const running = members.filter((t) => stateOf(t) === "running");
    if (running.length > 0) {
      const lead = running.find((t) => !quiet(t));
      const activity = { ...next.activity };
      for (const t of running) {
        activity.workflows += t.activity.workflows;
        activity.backgroundAgents += t.activity.backgroundAgents;
        activity.backgroundCommands += t.activity.backgroundCommands;
      }
      // The lead's "working" indicator replaces a quiet one (an unread success), never one that needs the owner.
      const indicator = lead && lead.indicator !== "none" && !OUTRANKS.has(next.indicator) ? { indicator: lead.indicator, indicatorLabel: lead.indicatorLabel } : {};
      next = { ...next, activity, ...(lead && quiet(next) ? { status: lead.status, runtimeStatus: lead.runtimeStatus, ...indicator } : {}) };
    }
    if (stateOf(next) !== "running") {
      const active = members.find((t) => t.id === conversation.activeThreadId);
      const asking = members.find((t) => t.hasPendingInteraction || ASKING.has(t.indicator));
      const failed = active && (active.status === "error" || FAILED.has(active.indicator)) ? active : undefined;
      const lead = asking ?? failed;
      if (lead && stateOf(next) !== "needs") {
        next = {
          ...next,
          hasPendingInteraction: next.hasPendingInteraction || lead.hasPendingInteraction,
          indicator: lead.indicator,
          indicatorLabel: lead.indicatorLabel,
          ...(lead.status === "error" ? { status: lead.status } : {}),
        };
      }
    }
    if (next !== root) folded.set(root.id, next);
  }
  return folded.size === 0 ? threads : threads.map((t) => folded.get(t.id) ?? t);
}

/**
 * The chat to open in this window for a thread id: the visible row itself, or,
 * when the id is a hidden member of a grouped conversation, that conversation's
 * visible root (its overlay shows the active member). Undefined when this
 * window has no such chat, which leaves the id to be opened some other way.
 */
export function openableHere(
  id: string,
  threads: readonly PluginSidebarThread[],
  conversations: readonly Conversation[],
): string | undefined {
  const visible = (threadId: string) => threads.some((t) => t.id === threadId && !t.isHidden && !t.isArchived);
  if (visible(id)) return id;
  const conversation = conversations.find((c) => c.memberIds.includes(id) || c.rootThreadId === id);
  return conversation && visible(conversation.rootThreadId) ? conversation.rootThreadId : undefined;
}

/**
 * The model and effort a grouped root row shows: its active hidden member's,
 * not the root session's own. Rows not in a moved-on conversation are absent.
 */
export function nativeLogicalExec(
  threads: readonly PluginSidebarThread[],
  conversations: readonly Conversation[],
): ReadonlyMap<string, Exec> {
  const out = new Map<string, Exec>();
  if (conversations.length === 0) return out;
  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const conversation of conversations) {
    const root = byId.get(conversation.rootThreadId);
    if (!root || root.isHidden) continue;
    const live = activeHidden(conversation, root);
    if (live?.model) out.set(root.id, { model: live.model, reasoningLevel: live.reasoningLevel ?? "" });
  }
  return out;
}

/** How often the index is re-read when no event arrives: while a member runs, until the first read lands, and otherwise as a safety net. */
export const INDEX_POLL_BUSY_MS = 30_000;
export const INDEX_POLL_UNKNOWN_MS = 10_000;
export const INDEX_POLL_IDLE_MS = 60_000;

/*
 * One store, one poller. The index is the heaviest read the plugin makes, and the
 * rail, Home, the Machines card and the control room all need it, so a single
 * timer owns the request while any of them is mounted and each hook only
 * subscribes (the same shape as fleet-board.ts).
 *
 * Events can be missed (the plugin server restarts, the link drops), and the
 * first read can fail. Neither may leave a running hidden member invisible until
 * something else happens, so the index is also re-read on a timer: quickly until
 * the first read has landed, every 30 s while a member runs, and every minute
 * otherwise. An answer that equals what is held keeps the held value, so a
 * quiet poll does not re-render anything.
 */
type IndexRpc = { call: (method: "native_session_index", input: null) => Promise<NativeSessionIndex> };
const NONE: readonly Conversation[] = [];
let holders = 0;
let source: IndexRpc | null = null;
let held: readonly Conversation[] = NONE;
let known = false;
let sequence = 0;
let inflight: { fresh: boolean } | null = null;
let stopPoll: (() => void) | null = null;
let pollMs = 0;
const listeners = new Set<() => void>();

const wantedMs = () => (held.some((c) => c.members?.some((m) => BUSY.has(m.status))) ? INDEX_POLL_BUSY_MS : known ? INDEX_POLL_IDLE_MS : INDEX_POLL_UNKNOWN_MS);

function schedule() {
  if (holders === 0) return;
  const ms = wantedMs();
  if (stopPoll && ms === pollMs) return;
  stopPoll?.();
  pollMs = ms;
  stopPoll = startVisiblePoll(() => load(false), ms);
}

function load(fresh: boolean) {
  const rpc = source;
  if (!rpc) return;
  // Several hooks ask at once on mount or on one event: a read already under way answers them all.
  if (inflight && (!fresh || inflight.fresh)) return;
  const current = ++sequence;
  const mine = { fresh };
  inflight = mine;
  void rpcFlight().call("native_session_index", () => rpc.call("native_session_index", null), { fresh }).then(
    (value) => {
      if (inflight === mine) inflight = null;
      if (current !== sequence || source !== rpc) return;
      const next = keepIfSame(held, value.conversations);
      const wasKnown = known;
      known = true;
      if (next !== held || !wasKnown) {
        held = next;
        for (const listener of listeners) listener();
      }
      schedule();
    },
    () => {
      if (inflight === mine) inflight = null;
    },
  );
}

function attach(rpc: IndexRpc): () => void {
  holders++;
  source = rpc;
  if (holders === 1) schedule();
  return () => {
    holders--;
    if (holders > 0) return;
    stopPoll?.();
    stopPoll = null;
    pollMs = 0;
    source = null;
    sequence++;
    inflight = null;
    held = NONE;
    known = false;
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => held;

/**
 * The grouped conversations, refreshed when a conversation changes and when a
 * new hidden thread appears (a fresh continuation). Empty until known, or when
 * the index cannot be read, which leaves the rail exactly as before. Every caller
 * shares one read and one timer.
 */
export function useNativeConversationIndex(threads: readonly PluginSidebarThread[]): readonly Conversation[] {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => attach(rpc as unknown as IndexRpc), [rpc]);
  const refresh = useCallback(() => load(true), []);
  const hiddenKey = useMemo(() => threads.filter((t) => t.isHidden).map((t) => t.id).sort().join(","), [threads]);
  const mounted = useRef(false);
  useEffect(() => { load(mounted.current); mounted.current = true; }, [hiddenKey]);
  useVisibleRealtime("native-sessions", refresh);
  const [value, setValue] = useState(read);
  useEffect(() => {
    setValue(read());
    return subscribe(() => setValue(read()));
  }, []);
  return value;
}

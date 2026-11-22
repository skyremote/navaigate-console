// The session-profile flag on chat rows: "Lean", "Local" or "Local, unlocked"
// (an Online chat has none), and the filter for it in the rail and the
// Control room. The marks are this plugin's thread metadata, read from the
// server in batches (session_profiles) and kept for the page: a mark is set
// when a chat is created and never changes, so each chat is asked once.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRpc, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { PROFILE_FILTERS, PROFILE_LABEL, isLocalModel, isRemoteModel, type ProfileFilterValue, type SessionProfileKind, type SessionProfileMark } from "./session-profile";

/** null = asked, and it has no mark (Online). Absent = not asked yet. */
const known = new Map<string, SessionProfileKind | null>();
const asking = new Set<string>();
/** Chats whose last read failed, with when they may be asked again: a failing server is not asked in a loop. */
const retryAt = new Map<string, number>();
const RETRY_MS = 60_000;
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version += 1;
  for (const l of listeners) l();
};
const BATCH = 200;

/** Forget every mark (tests). */
export function forgetSessionProfiles() {
  known.clear();
  asking.clear();
  retryAt.clear();
  bump();
}

/** Record a mark the page already knows, such as a chat it has just created. */
export function rememberSessionProfile(threadId: string, kind: SessionProfileKind | null) {
  known.set(threadId, kind);
  bump();
}

/**
 * The flag of every chat in the list, asked in batches for chats not seen yet,
 * never per row and never during render. Returns a lookup by thread id:
 * undefined while unknown, null for an Online chat.
 */
export function useSessionProfiles(threads: readonly Pick<PluginSidebarThread, "id">[], enabled: boolean): (id: string) => SessionProfileKind | null | undefined {
  const rpc = useRpc<typeof rpcContract>();
  const seen = useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version,
  );
  const want = useMemo(() => (enabled ? threads.filter((t) => !known.has(t.id) && !asking.has(t.id) && !((retryAt.get(t.id) ?? 0) > Date.now())).map((t) => t.id).join(",") : ""), [threads, enabled, seen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!want) return;
    const timer = window.setTimeout(() => {
      const ids = want.split(",").filter((id) => !known.has(id) && !asking.has(id));
      if (ids.length === 0) return;
      for (const id of ids) asking.add(id);
      void (async () => {
        for (let i = 0; i < ids.length; i += BATCH) {
          const batch = ids.slice(i, i + BATCH);
          try {
            const marks = await rpc.call("session_profiles", { threadIds: batch });
            for (const id of batch) {
              known.set(id, marks[id]?.profile ?? null);
              retryAt.delete(id);
            }
          } catch {
            /* left unknown: asked again on a change to the list, once a minute has passed */
            for (const id of batch) retryAt.set(id, Date.now() + RETRY_MS);
          } finally {
            for (const id of batch) asking.delete(id);
          }
        }
        bump();
      })();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [want, rpc]);
  // A new lookup only when an answer arrives, so lists can memoise on it.
  return useMemo(() => (id: string) => known.get(id), [seen]);
}

/** The colour of each flag: theme tokens, the same as the home screen's orbs. */
export const PROFILE_COLOR: Record<SessionProfileKind, string> = { lean: "var(--attention)", local: "var(--success)", "local-unlocked": "var(--warning)" };

/** A small flag on a chat row; nothing for an Online chat. */
export function ProfileBadge({ kind, className }: { kind: SessionProfileKind | null | undefined; className?: string }) {
  if (!kind) return null;
  const color = PROFILE_COLOR[kind];
  return (
    <span
      data-nav-part="profile-badge"
      data-profile={kind}
      title={PROFILE_LABEL[kind]}
      aria-label={PROFILE_LABEL[kind]}
      className={cn("inline-flex h-4 shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-none text-foreground", className)}
      style={{ background: `color-mix(in oklab, ${color} 18%, transparent)` }}
    >
      <span aria-hidden className="size-[5px] rounded-full" style={{ background: color }} />
      {PROFILE_LABEL[kind]}
    </span>
  );
}

/**
 * All · Online · Lean · Local · Local, unlocked, as one row of small pills. Lean and "Local, unlocked"
 * show only when some chat carries that flag (or it is the filter in use): most people never start
 * either, and a pill for a flag nobody has is noise.
 */
export function ProfileFilter({ value, onChange, counts, className }: { value: ProfileFilterValue | null; onChange: (v: ProfileFilterValue | null) => void; counts?: Partial<Record<ProfileFilterValue, number>>; className?: string }) {
  const pill = (key: ProfileFilterValue | null, label: string) => {
    const on = value === key;
    const n = key ? counts?.[key] : undefined;
    return (
      <button
        key={key ?? "all"}
        type="button"
        aria-pressed={on}
        data-nav-part="profile-filter-item"
        data-value={key ?? "all"}
        onClick={() => onChange(on && key !== null ? null : key)}
        className={cn(
          "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] transition-colors",
          on ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {key && key !== "online" ? <span aria-hidden className="size-[5px] rounded-full" style={{ background: PROFILE_COLOR[key] }} /> : null}
        {label}
        {n !== undefined ? <span className={on ? "text-background" : "text-muted-foreground"}>{n}</span> : null}
      </button>
    );
  };
  return (
    <div role="group" aria-label="Filter by setup" data-nav-part="profile-filter" className={cn("flex min-w-0 flex-wrap items-center gap-0.5", className)}>
      {pill(null, "All")}
      {PROFILE_FILTERS.filter((f) => !OCCASIONAL.has(f.value) || !counts || (counts[f.value] ?? 0) > 0 || value === f.value).map((f) => pill(f.value, f.label))}
    </div>
  );
}

/** Flags shown in the filter only while some chat carries them. */
const OCCASIONAL: ReadonlySet<ProfileFilterValue> = new Set(["lean", "local-unlocked"]);

/** How many chats carry each flag, for the filter's counts. Unknown chats are left out. */
export function profileCounts(ids: readonly string[], of: (id: string) => SessionProfileKind | null | undefined): Partial<Record<ProfileFilterValue, number>> {
  const out: Partial<Record<ProfileFilterValue, number>> = {};
  for (const id of ids) {
    const k = of(id);
    if (k === undefined) continue;
    const key: ProfileFilterValue = k ?? "online";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/* ------------------ bb's own row metadata line (an extra) ------------------ */

/**
 * For bb's thread-row metadata slot, which bb draws only while its row-details
 * experiment and Organize > Rows > Metadata are on. Inside the skin's own rail
 * the row already shows the flag, so this one stays empty there.
 */
export function useRowProfileData(input: { threads: readonly PluginSidebarThread[] }) {
  return useSessionProfiles(input.threads, true);
}
export function RowProfileItem({ thread, data }: { thread: PluginSidebarThread; data: (id: string) => SessionProfileKind | null | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [inRail, setInRail] = useState(false);
  const kind = data(thread.id);
  useLayoutEffect(() => {
    if (ref.current) setInRail(!!ref.current.closest('[data-nav-part="row"]'));
  }, [kind]);
  if (!kind) return null;
  return <span ref={ref}>{inRail ? null : <ProfileBadge kind={kind} />}</span>;
}

/** The full mark of one chat (with its model), asked once per chat and kept for the page. */
const fullMarks = new Map<string, SessionProfileMark | null>();
export function forgetThreadMarks() {
  fullMarks.clear();
}
/** How long a chat's own question may take before the chat counts as having no mark (fail open). */
export const THREAD_MARK_WAIT_MS = 1500;
const LEAN_MARK: SessionProfileMark = { profile: "lean", v: 1 };
/**
 * One chat's mark, for what shows under its box. The rail's batch answer (`known`) comes first: a chat
 * it already knows is not Local is answered at once, with no question of its own. Only a chat the
 * rail has not answered yet, or a Local chat (whose model the rail does not keep), is asked once.
 * Returns undefined while waiting; after THREAD_MARK_WAIT_MS, or when the question fails, a chat
 * still unknown counts as Online (null), so nothing that depends on it stays missing. A chat the
 * rail knows is Local stays Local, without its model name if that never arrives.
 */
export function useThreadMark(threadId: string | null | undefined): SessionProfileMark | null | undefined {
  const rpc = useRpc<typeof rpcContract>();
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version,
  );
  const [, setTick] = useState(0);
  const [waitedFor, setWaitedFor] = useState<string | null>(null);
  const kind = threadId ? known.get(threadId) : undefined;
  const localKind = kind === "local" || kind === "local-unlocked";
  const ask = !!threadId && !fullMarks.has(threadId) && (kind === undefined || localKind);
  useEffect(() => {
    if (!ask || !threadId) return;
    let alive = true;
    const timer = window.setTimeout(() => alive && setWaitedFor(threadId), THREAD_MARK_WAIT_MS);
    rpc
      .call("session_profiles", { threadIds: [threadId] })
      .then((marks) => {
        window.clearTimeout(timer);
        fullMarks.set(threadId, marks[threadId] ?? null);
        if (alive) setTick((n) => n + 1);
      })
      .catch(() => alive && setWaitedFor(threadId)); // counted as no mark, asked again on the next visit
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [rpc, threadId, ask]);
  if (!threadId) return undefined;
  if (fullMarks.has(threadId)) return fullMarks.get(threadId);
  if (kind === null) return null;
  if (kind === "lean") return LEAN_MARK;
  const waited = waitedFor === threadId;
  if (localKind) return waited ? { profile: kind, v: 1 } : undefined;
  return waited ? null : undefined;
}

/** A model id as people read it: without the "ollama/" or "lmstudio/" prefix. */
export const localModelLabel = (model: string | undefined) => (model ?? "a local model").replace(/^(ollama|lmstudio)\//, "");

/** Whether a model id is one on this Mac: an Ollama or LM Studio model, not one Ollama serves from its cloud. */
export const runsHere = (model: string): boolean => isLocalModel(model) && !isRemoteModel({ name: model });

/**
 * What a Local chat in opencode runs on now. opencode can be switched to another model inside the chat
 * (bb's picker), so its mark says only what it started on:
 *   - "here": the model it ran its last turn on, and the one picked for its next reply, are on this Mac;
 *   - "moved": its last turn ran on a model that is not on this Mac;
 *   - "next": its next reply is picked to run on a model that is not on this Mac;
 *   - "unknown": the current model could not be read, so nothing is claimed.
 * A Local chat on Claude Code is not asked: the launcher holds it to the model it was marked with.
 */
export type LocalNow = { state: "here"; model: string } | { state: "moved" | "next"; model: string } | { state: "unknown" };
export function localNow(current: { model: string | null } | undefined, picked: string | null | undefined): LocalNow | undefined {
  if (picked && !runsHere(picked) && (!current?.model || runsHere(current.model))) return { state: "next", model: picked };
  if (current === undefined) return undefined;
  if (!current.model) return { state: "unknown" };
  if (!runsHere(current.model)) return { state: "moved", model: current.model };
  return { state: "here", model: current.model };
}

/** The model each chat last ran on (bb's own execution options, through thread_exec), keyed by the chat's updatedAt. */
const modelNow = new Map<string, { at: number; model: string | null }>();
const modelAsking = new Set<string>();
export function forgetModelsNow() {
  modelNow.clear();
  modelAsking.clear();
}
/** How long after a chat changes the question is asked, so a burst of changes during a turn costs one question. */
export const MODEL_NOW_SETTLE_MS = 250;
/**
 * The model a chat ran its last turn on, asked once, and again only after the chat has changed (a new turn
 * changes it, running or not). Until a newer answer arrives the last one stays, so nothing flickers; a
 * render never asks. Undefined only for the very first question, until THREAD_MARK_WAIT_MS has passed.
 */
export function useModelNow(threadId: string | null, updatedAt: number | undefined): { model: string | null } | undefined {
  const rpc = useRpc<typeof rpcContract>();
  const [, setTick] = useState(0);
  const [waitedFor, setWaitedFor] = useState<string | null>(null);
  const have = threadId ? modelNow.get(threadId) : undefined;
  const at = updatedAt ?? 0;
  const stale = !!threadId && (!have || at > have.at);
  useEffect(() => {
    if (!threadId || !stale) return;
    let alive = true;
    const wait = window.setTimeout(() => alive && setWaitedFor(threadId), THREAD_MARK_WAIT_MS);
    const ask = window.setTimeout(() => {
      if (modelAsking.has(threadId)) return;
      modelAsking.add(threadId);
      rpc
        .call("thread_exec", { ids: [threadId] })
        .then((r) => {
          if (threadId in r) {
            const prev = modelNow.get(threadId);
            if (!prev || prev.at <= at) modelNow.set(threadId, { at, model: r[threadId]?.model ?? null });
          } else if (!modelNow.has(threadId)) modelNow.set(threadId, { at, model: null });
        })
        .catch(() => {
          if (!modelNow.has(threadId)) modelNow.set(threadId, { at, model: null });
        })
        .finally(() => {
          modelAsking.delete(threadId);
          window.clearTimeout(wait);
          if (alive) setTick((n) => n + 1);
        });
    }, have ? MODEL_NOW_SETTLE_MS : 0);
    return () => {
      alive = false;
      window.clearTimeout(wait);
      window.clearTimeout(ask);
    };
  }, [rpc, threadId, at, stale, have]);
  if (!threadId) return undefined;
  if (have) return { model: have.model };
  return waitedFor === threadId ? { model: null } : undefined;
}

/**
 * The Console's own marker under a Local chat's box: "Local · <model> · runs on this Mac". bb's own
 * picker and status bar still name a Claude model and account; this says what the chat really uses.
 * For a Local chat in opencode, `now` says what it runs on at this moment (see LocalNow): the claim
 * is made only while that model is on this Mac.
 */
export function LocalChip({ mark, now }: { mark: SessionProfileMark; now?: LocalNow }) {
  const color = PROFILE_COLOR[mark.profile];
  const started = localModelLabel(mark.model);
  const name = mark.profile === "local-unlocked" ? "Local, unlocked" : "Local";
  // The orb no longer offers cloud models; an older chat on one must not claim to stay on this Mac.
  const cloud = !!mark.model && isRemoteModel({ name: mark.model });
  let text: string;
  let title: string;
  if (cloud) {
    text = `${name} · ${started} · runs on Ollama's cloud, not this Mac`;
    title = `This chat runs on ${started}, which Ollama serves from its cloud, not from this Mac. It does not use a Claude or Codex account.`;
  } else if (now?.state === "moved") {
    text = `Started Local · now on ${localModelLabel(now.model)}`;
    title = `This chat started on ${started}, a model on this Mac, and now runs on ${localModelLabel(now.model)}, which is not on this Mac.`;
  } else if (now?.state === "next") {
    text = `Started Local · next reply on ${localModelLabel(now.model)}`;
    title = `This chat ran on ${started}, a model on this Mac. Its next reply is set to ${localModelLabel(now.model)}, which is not on this Mac.`;
  } else if (now?.state === "unknown") {
    text = `${name} · ${started} · started on this Mac`;
    title = `This chat started on ${started}, a model on this Mac. Which model it uses now could not be read.`;
  } else {
    const model = now?.state === "here" ? localModelLabel(now.model) : started;
    text = `${name} · ${model} · runs on this Mac`;
    title = `This chat runs on ${model}, a model on this Mac. It does not use a Claude or Codex account.`;
  }
  return (
    <span
      data-nav-part="local-chip"
      data-profile={mark.profile}
      data-cloud={cloud ? "1" : undefined}
      data-now={now?.state}
      title={title}
      className="inline-flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-xs leading-tight text-muted-foreground"
    >
      <span aria-hidden className="size-[6px] shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{text}</span>
    </span>
  );
}

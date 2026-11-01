// Fleet mirror, server side: both halves of the data path through the brain.
//
// Watching (this Mac opens another machine's chat):
//   mirror_open writes a watch row naming the chat, the machine that owns it
//   and this Fleet's public key, then waits for the first sealed row. The
//   reader opens each row, appends its records to the copy's feed and drives
//   the hidden copy: spawn with the first remote user message, then one
//   threads.send (mode auto) per later remote user message, steers included.
//
// Publishing (this Mac owns a watched chat):
//   for each active watch row naming this server, read the chat's new events
//   (bb.sdk.threads.events.list afterSeq), map them to records, seal them to
//   the watcher's key and write at most one row every 3 seconds per chat.
//
// The brain only ever holds ciphertext for chat content. No machine connects
// to another; a watch lasts while its chat runs and for 7 days after it was
// last opened, and rows are deleted after 7 days or when the watch ends.
import { randomUUID } from "node:crypto";
import { claimControl, interactionRequestId, releaseUnavailableClaim, listControls, mirrorReplayInput, readControl, readControlState, writeControlState, type MirrorControlRequest, type MirrorControlResult } from "./control";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Row, TursoClient } from "../turso";
import type { MirrorMetricBrokerRead, MirrorMetricRead, MirrorMetricStream } from "./metrics";
import { loadOrCreateMirrorKey, open as openSealed, rowAad, seal, type MirrorKeyPair } from "./crypto";
import { appendFeed, cursorPath, ensureFeedDir, feedPath, FeedReader, promoteFeed, readCursor, stagingPath } from "./feed";
import {
  EVENT_TTL_MS,
  WATCH_TTL_MS,
  mapEvents,
  missingRequestIds,
  newMapperState,
  rememberRequest,
  replayStart,
  watchLive,
  type MapperState,
  type StoredEvent,
} from "./mapping";
import {
  MIRROR_FEATURE,
  MIRROR_MODEL_ID,
  MIRROR_PROVIDER_ID,
  REPLAY_TURNS,
  earlierHistoryLine,
  type FeedHeader,
  type FeedRecord,
  type MirrorBatch,
  type MirrorRecord,
} from "./protocol";

export const MIRROR_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fleet_mirror_watch (
     id TEXT PRIMARY KEY,
     watcher_server TEXT,
     target_server TEXT,
     thread_id TEXT,
     watcher_key TEXT,
     generation TEXT,
     opened_at INTEGER,
     published_generation TEXT,
     published_seq INTEGER,
     next_seq INTEGER,
     state TEXT,
     error TEXT,
     created_at INTEGER,
     updated_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_mirror_watch_target ON fleet_mirror_watch(target_server, state)`,
  `CREATE TABLE IF NOT EXISTS fleet_mirror_events (
     server_id TEXT,
     thread_id TEXT,
     recipient TEXT,
     generation TEXT,
     seq INTEGER,
     payload TEXT,
     created_at INTEGER,
     PRIMARY KEY (server_id, thread_id, recipient, generation, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_mirror_events_age ON fleet_mirror_events(server_id, created_at)`,
];

/** At most one row every this often per watched chat. */
const ROW_EVERY_MS = 3000;
/** Record JSON per row before sealing (deflate makes it several times smaller). */
const ROW_MAX_BYTES = 1_500_000;
/** bb lists at most 100 events per call; one row reads up to EVENTS_PER_ROW in pages. */
const EVENTS_PAGE = 100;
const DIRECT_EVENTS_PAGE = 25;
const DETAIL_RETRY_MS = 2_000;
const DETAIL_RETRY_LIMIT = 20;
const DETAIL_PENDING_LIMIT = 20;
const EVENTS_PER_ROW = 2000;
/** Reader cadence: fast while a copy was opened recently or a mirrored turn is open. */
const READ_FAST_MS = 3000;
const READ_SLOW_MS = 30_000;
const RECENT_OPEN_MS = 30 * 60_000;
/** Publisher cadence when nothing it watches is running. */
const WATCH_POLL_MS = 10_000;
const PRUNE_EVERY_MS = 10 * 60_000;
/** How long mirror_open waits for the first row before it gives up. */
const OPEN_WAIT_MS = 45_000;
/** A copy still waiting for its first row this long after the open is dropped. */
const PENDING_TTL_MS = 15 * 60_000;

export interface CopyState {
  key: string;
  machine: string;
  serverId: string;
  remoteThreadId: string;
  title: string;
  generation: string;
  localThreadId: string | null;
  /** Last fleet_mirror_events.seq applied to the feed. */
  readSeq: number;
  /** Records in the feed, header included. */
  appended: number;
  /** Feed records before this index have had their user messages sent. */
  sentThrough: number;
  openedAt: number;
  createdAt: number;
  error: string | null;
  replayToken?: string;
  transport?: "direct";
  directSeq?: number;
  directEarlier?: boolean;
  /** Owner interactions still pending whose detail read failed, kept across restarts; retried read-only and bounded. */
  pendingDetails?: { id: string; turn: string | null; kind: "approval" | "user_question"; attempts: number; nextAt: number }[];
  /** Explicit local filing project; owner identity and workspace remain independent. */
  localProjectId?: string;
}

interface PublishState {
  generation: string;
  cursor: number;
  nextSeq: number;
  mapper: MapperState;
  earlier: boolean;
  lastWriteAt: number;
  firstRowDone: boolean;
}

interface WatchRow {
  id: string;
  watcherServer: string;
  threadId: string;
  watcherKey: string;
  generation: string;
  openedAt: number;
  publishedGeneration: string | null;
  publishedSeq: number;
  nextSeq: number;
}

class MirrorError extends Error {}

export interface MirrorDeps {
  bb: BbPluginApi;
  turso: TursoClient | null;
  joined: () => boolean;
  me: () => Promise<{ serverId: string; url: string | null }>;
  machineKey: string;
  /** The profile's machine id for a name a person typed (case-insensitive); the trimmed name when it is not a profile machine. */
  canonicalMachine?: (raw: string) => string;
  /** Fleet's own plugin data folder (the key and the feeds live here). */
  dataDir: string;
  /** Other machines' snapshots, as the sync loop last read them. */
  remote: () => ReadonlyArray<{ serverId: string; machineKey: string; publishedAt: number; features?: string[]; threads: ReadonlyArray<{ id: string; title: string }> }>;
  /** The host the bb server runs on (copies live there). */
  serverHostId: () => Promise<string | null>;
  /** Cut the mirror loop's sleep short (a chat was just opened). */
  wake?: () => void;
  /** Fleet's mirrorEnvironment setting: the environment copies reuse ("" = pick one). */
  environmentSetting?: () => string;
  /** Authenticated, owner-addressed transport. A missing callback keeps copies read-only. */
  forwardControl?: (request: MirrorControlRequest) => Promise<MirrorControlResult>;
  /** Read-only owner/relay receipt lookup. Null or an unavailable route retains admission without resending. */
  controlReceipt?: (request: MirrorControlRequest) => Promise<MirrorControlResult | null>;
  /** The owner's full pending question or approval and its fingerprint; null when the owner cannot answer natively. */
  interactionDetail?: (input: { serverId: string; machine: string; threadId: string; interactionId: string }) => Promise<{ payload: Record<string, unknown>; fingerprint: string } | null>;
  /** Optional authenticated direct read, independent of the transcript broker. */
  direct?: {
    events(input: { serverId: string; machine: string; threadId: string; afterSeq?: string; beforeSeq?: string; types?: string[]; order?: "asc" | "desc"; limit?: string }): Promise<StoredEvent[]>;
  };
  /** F77 measurement hooks; a failing hook never affects the mirror. */
  metrics?: {
    beginOpen(input: { openId: string; stream: MirrorMetricStream }): string;
    finishOpen(openId: string, outcome: "ready" | "failed" | "cancelled"): unknown;
    recordRead(input: MirrorMetricRead): boolean;
    recordBrokerRead?(input: MirrorMetricBrokerRead): boolean;
  };
}

/**
 * Where copies run. A copy calls no model and touches no files, but bb needs
 * an environment: a new one (personal workspace or folder) never finishes
 * provisioning for this provider (seen in testing), while reusing a
 * ready one starts at once. So copies reuse one fixed, ready project checkout
 * on this Mac: the one named in Fleet's mirrorEnvironment setting, else the
 * most recently used local checkout (not on the NAS share, not in /tmp). The
 * choice is kept so copies stay together.
 */
async function copyEnvironment(bb: BbPluginApi, hostId: string, wanted: string, localProjectId?: string): Promise<{ environmentId: string; projectId: string }> {
  const usable = (e: { projectId?: unknown; status?: unknown; hostId?: unknown; path?: unknown }) =>
    e.status === "ready" && e.hostId === hostId && (!localProjectId || e.projectId === localProjectId) && typeof e.path === "string" && existsSync(e.path);
  if (wanted !== "") {
    try {
      const env = (await bb.sdk.environments.get({ environmentId: wanted })) as unknown as { id: string; projectId: string; status: string; hostId: string; path: string | null };
      if (usable(env)) return { environmentId: env.id, projectId: env.projectId };
      if (!localProjectId) throw new MirrorError(`The mirror environment ${wanted} is not ready on this Mac`);
    } catch (cause) {
      if (!localProjectId) throw cause;
      // An explicit local project picks its own existing environment below.
    }
  }
  const environmentKey = localProjectId ? `mirror:environment:${localProjectId}` : "mirror:environment";
  const kept = await bb.storage.kv.get<{ environmentId: string; projectId: string }>(environmentKey);
  if (kept) {
    try {
      const env = (await bb.sdk.environments.get({ environmentId: kept.environmentId })) as unknown as { projectId: string; status: string; hostId: string; path: string | null };
      if (usable(env)) return { environmentId: kept.environmentId, projectId: env.projectId };
    } catch {
      // gone: pick another
    }
  }
  const ready = ((await bb.sdk.environments.list({ hostId, status: "ready", environmentProviderId: "project-checkout", ...(localProjectId ? { projectId: localProjectId } : {}) })) as unknown as {
    id: string;
    projectId: string;
    status: string;
    hostId: string;
    path: string | null;
    updatedAt?: number;
  }[]).filter((e) => usable(e) && !/^\/(Volumes|tmp|private\/tmp)\//.test(e.path ?? ""));
  ready.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const pick = ready[0];
  if (pick === undefined) throw new MirrorError(localProjectId ? `No existing ready checkout on this Mac in local project ${localProjectId} for the mirror copy` : "No ready project checkout on this Mac for mirror copies (set Fleet's mirrorEnvironment)");
  const chosen = { environmentId: pick.id, projectId: pick.projectId };
  await bb.storage.kv.set(environmentKey, chosen);
  return chosen;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function threadOf(result: unknown): Record<string, unknown> | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as { thread?: unknown; id?: unknown };
  if (r.thread && typeof r.thread === "object") return r.thread as Record<string, unknown>;
  return typeof r.id === "string" ? (r as Record<string, unknown>) : null;
}

function isRunning(thread: Record<string, unknown>): boolean {
  const display = (thread.runtime as { displayStatus?: unknown } | undefined)?.displayStatus ?? thread.status;
  return ["active", "starting", "stopping", "provisioning", "pending", "waiting-for-host"].includes(String(display));
}

function isIdle(thread: Record<string, unknown>): boolean {
  const display = (thread.runtime as { displayStatus?: unknown } | undefined)?.displayStatus ?? thread.status;
  return display === "idle" || display === "error";
}

export function createMirror(deps: MirrorDeps) {
  const canonical = (raw: string): string => deps.canonicalMachine?.(raw) ?? raw.trim();
  const { bb, turso } = deps;
  const feedDir = join(deps.dataDir, "mirror-feed");
  ensureFeedDir(feedDir);
  const key: MirrorKeyPair = loadOrCreateMirrorKey(join(deps.dataDir, "mirror-key.json"));
  const copies = new Map<string, CopyState>();
  const publishing = new Map<string, PublishState>();
  const directMappers = new Map<string, MapperState>();
  const metricOpens = new Map<string, { openId: string; initialRead: boolean }>();

  function metric(run: () => void): void {
    try { run(); } catch { return; }
  }

  /** One owner events read through the direct route, measured as the exact array it returned. */
  async function directRead(state: CopyState, mode: "initial" | "delta" | "history" | "lookup", query: { afterSeq?: string; beforeSeq?: string; types?: string[]; order: "asc" | "desc"; limit: string }): Promise<StoredEvent[]> {
    const open = metricOpens.get(state.key);
    const stream = { serverId: state.serverId, threadId: state.remoteThreadId, generation: state.generation };
    const cursorBefore = mode === "initial" || mode === "delta" ? Number(query.afterSeq ?? 0) : null;
    const startedAt = performance.now();
    let events: StoredEvent[];
    try {
      events = await deps.direct!.events({ serverId: state.serverId, machine: state.machine, threadId: state.remoteThreadId, ...query });
    } catch (cause) {
      const endedAt = performance.now();
      metric(() => deps.metrics?.recordRead({ readId: randomUUID(), ...(open ? { openId: open.openId } : {}), stream, mode, startedAt, endedAt, events: null, cursorBefore, cursorAfter: null, failed: true }));
      throw cause;
    }
    const endedAt = performance.now();
    const newest = events.reduce((max, event) => Math.max(max, event.seq), cursorBefore ?? 0);
    metric(() => deps.metrics?.recordRead({ readId: randomUUID(), ...(open ? { openId: open.openId } : {}), stream, mode, startedAt, endedAt, events: events.length > 2000 ? null : events as unknown as MirrorMetricRead["events"], cursorBefore, cursorAfter: cursorBefore === null ? null : newest, failed: events.length > 2000 }));
    return events;
  }
  const directUpdates = new Map<string, { state: CopyState; done: Promise<void> }>();
  const directBacklogs = new WeakSet<CopyState>();
  const refreshingCopies = new Map<string, { state: CopyState; done: Promise<void> }>();
  const drivingCopies = new Map<string, { state: CopyState; done: Promise<void> }>();
  const openingCopies = new Map<string, Promise<{ localThreadId: string }>>();
  const waiters = new Map<string, Array<(r: { localThreadId: string } | { error: string }) => void>>();
  /** Feed records that carry a user message, per copy (rebuilt from the feed after a reload). */
  const userRecords = new Map<string, Array<{ index: number; kind: "turn" | "steer"; text: string; requestId: string; controlId?: string }>>();
  let loaded = false;
  let loading: Promise<void> | null = null;
  let schemaReady: Promise<void> | null = null;
  let nextRead = 0;
  let nextWatchPoll = 0;
  let nextPrune = 0;
  let publishActive = false;
  const warned = new Map<string, string>();
  let lastError: string | null = null;

  const kvKey = (copyKey: string) => `mirror:copy:${copyKey}`;

  /** One shared load of the saved copies; every caller awaits it, and a failed load is retried by the next caller. */
  async function load(): Promise<void> {
    if (loaded) return;
    loading ??= (async () => {
      const found: CopyState[] = [];
      for (const name of await bb.storage.kv.list("mirror:copy:")) {
        const state = await bb.storage.kv.get<CopyState>(name);
        if (state && typeof state.key === "string") found.push(state);
      }
      for (const state of found) if (!copies.has(state.key)) copies.set(state.key, state);
      loaded = true;
    })().finally(() => { loading = null; });
    try {
      await loading;
    } catch (cause) {
      bb.log.warn(`fleet mirror: could not load copies: ${message(cause)}`);
    }
  }

  async function save(state: CopyState): Promise<void> {
    copies.set(state.key, state);
    await bb.storage.kv.set(kvKey(state.key), state);
  }

  function ensureSchema(): Promise<void> {
    const db = turso;
    if (db === null) return Promise.reject(new MirrorError("This machine has no brain connection"));
    schemaReady ??= db
      .batch(MIRROR_SCHEMA.map((sql) => ({ sql })))
      .then(() => undefined)
      .catch((cause: unknown) => {
        schemaReady = null;
        throw cause;
      });
    return schemaReady;
  }

  function feedFileOf(state: CopyState): string {
    return state.localThreadId === null ? stagingPath(feedDir, state.key) : feedPath(feedDir, state.localThreadId);
  }

  function usersOf(state: CopyState): Array<{ index: number; kind: "turn" | "steer"; text: string; requestId: string; controlId?: string }> {
    let list = userRecords.get(state.key);
    if (list === undefined) {
      list = [];
      const reader = new FeedReader(feedFileOf(state));
      reader.poll();
      reader.records.forEach((r, index) => {
        if (r.t === "turn" && r.user !== null) list!.push({ index, kind: "turn", ...r.user });
        if (r.t === "steer") list!.push({ index, kind: "steer", ...r.user });
      });
      userRecords.set(state.key, list);
    }
    return list;
  }

  function append(state: CopyState, records: FeedRecord[]): void {
    const list = usersOf(state);
    records.forEach((r, i) => {
      const index = state.appended + i;
      if (r.t === "turn" && r.user !== null) list.push({ index, kind: "turn", ...r.user });
      if (r.t === "steer") list.push({ index, kind: "steer", ...r.user });
    });
    appendFeed(feedFileOf(state), records);
    state.appended += records.length;
  }

  function settle(copyKey: string, result: { localThreadId: string } | { error: string }): void {
    const list = waiters.get(copyKey) ?? [];
    waiters.delete(copyKey);
    for (const resolve of list) resolve(result);
  }

  // ---------- watching ----------

  /** Which server owns the chat: the machine's own bb, or this bb (loopback). */
  async function ownerOf(machine: string, threadId: string): Promise<{ serverId: string; title: string | null }> {
    const { serverId: own } = await deps.me();
    const snaps = deps.remote().filter((s) => s.serverId !== own);
    const listed =
      snaps.find((s) => s.machineKey === machine && s.threads.some((t) => t.id === threadId)) ??
      snaps.find((s) => s.threads.some((t) => t.id === threadId));
    if (listed) {
      if (!(listed.features ?? []).includes(MIRROR_FEATURE) && !deps.direct) {
        throw new MirrorError(`${listed.machineKey} runs a Fleet without the mirror yet, so its chats open on its own bb page`);
      }
      return { serverId: listed.serverId, title: listed.threads.find((t) => t.id === threadId)?.title ?? null };
    }
    const local = threadOf(await bb.sdk.threads.get({ threadId }).catch(() => null));
    if (local !== null && local.deletedAt == null) {
      const title = typeof local.title === "string" && local.title !== "" ? local.title : typeof local.titleFallback === "string" ? local.titleFallback : null;
      return { serverId: own, title };
    }
    const owner = snaps.find((s) => s.machineKey === machine);
    if (owner && ((owner.features ?? []).includes(MIRROR_FEATURE) || deps.direct)) return { serverId: owner.serverId, title: null };
    throw new MirrorError(`No chat ${threadId} on the ${machine}`);
  }

  async function upsertWatch(state: CopyState): Promise<void> {
    const db = turso!;
    const { serverId: own } = await deps.me();
    const now = Date.now();
    await db.query(
      `INSERT INTO fleet_mirror_watch (id, watcher_server, target_server, thread_id, watcher_key, generation, opened_at,
         published_generation, published_seq, next_seq, state, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, 'active', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET watcher_key = excluded.watcher_key, generation = excluded.generation,
         opened_at = excluded.opened_at, state = 'active', error = NULL, updated_at = excluded.updated_at`,
      [`${own}:${state.key}`, own, state.serverId, state.remoteThreadId, key.publicKey, state.generation, state.openedAt, now, now],
    );
  }

  function waitForCopy(copyKey: string, timeoutMs: number): Promise<{ localThreadId: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = waiters.get(copyKey) ?? [];
        waiters.set(copyKey, list.filter((w) => w !== done));
        reject(new MirrorError("The other Mac has not sent this chat yet (is it awake?)"));
      }, timeoutMs);
      const done = (r: { localThreadId: string } | { error: string }) => {
        clearTimeout(timer);
        if ("localThreadId" in r) resolve(r);
        else reject(new MirrorError(r.error));
      };
      waiters.set(copyKey, [...(waiters.get(copyKey) ?? []), done]);
    });
  }

  async function copyExists(threadId: string): Promise<boolean> {
    try {
      const t = threadOf(await bb.sdk.threads.get({ threadId }));
      return t !== null && t.deletedAt == null && t.archivedAt == null;
    } catch {
      return false;
    }
  }

  function dropFeed(state: CopyState): void {
    for (const path of [stagingPath(feedDir, state.key), ...(state.localThreadId ? [feedPath(feedDir, state.localThreadId), cursorPath(feedDir, state.localThreadId)] : [])]) {
      try {
        if (existsSync(path)) rmSync(path);
      } catch {
        // a leftover file is harmless
      }
    }
    userRecords.delete(state.key);
  }

  async function enableWrites(state: CopyState): Promise<void> {
    if (!deps.forwardControl || state.replayToken || !state.localThreadId) return;
    const copy = threadOf(await bb.sdk.threads.get({ threadId: state.localThreadId }).catch(() => null));
    if (copies.get(state.key) !== state || state.replayToken || !copy || !isIdle(copy) || readCursor(cursorPath(feedDir, state.localThreadId)) < state.appended) return;
    state.replayToken = randomUUID();
    append(state, [{ t: "control", v: 1, replayToken: state.replayToken }]);
    await save(state);
  }

  /** Drop a copy here and end its watch, so the other machine stops publishing it. */
  async function forget(state: CopyState): Promise<void> {
    if (copies.get(state.key) !== state) return;
    metricOpens.delete(state.key);
    dropFeed(state);
    copies.delete(state.key);
    await bb.storage.kv.delete(kvKey(state.key));
    if (turso === null) return;
    const { serverId: own } = await deps.me();
    try {
      await turso.batch([
        {
          sql: `UPDATE fleet_mirror_watch SET state = 'ended', updated_at = ? WHERE id = ? AND generation = ?`,
          args: [Date.now(), `${own}:${state.key}`, state.generation],
        },
        {
          sql: `DELETE FROM fleet_mirror_events WHERE server_id = ? AND thread_id = ? AND recipient = ? AND generation = ?`,
          args: [state.serverId, state.remoteThreadId, own, state.generation],
        },
      ]);
    } catch (cause) {
      bb.log.warn(`fleet mirror: could not end the watch for ${state.key}: ${message(cause)}`);
    }
  }

  /** mirror_open: the local copy of a remote chat, made on first open and reused after. */
  async function openCopy(input: { machine: string; threadId: string; title?: string; localProjectId?: string }): Promise<{ localThreadId: string }> {
    const requestKey = JSON.stringify([canonical(input.machine), input.threadId, input.localProjectId ?? null]);
    const existing = openingCopies.get(requestKey);
    if (existing) return existing;
    const opening = openCopyMeasured(input);
    openingCopies.set(requestKey, opening);
    try { return await opening; }
    finally { if (openingCopies.get(requestKey) === opening) openingCopies.delete(requestKey); }
  }

  async function openCopyMeasured(input: { machine: string; threadId: string; title?: string; localProjectId?: string }): Promise<{ localThreadId: string }> {
    const openId = randomUUID();
    let tracked = false;
    const track = (state: CopyState) => metric(() => {
      deps.metrics?.beginOpen({ openId, stream: { serverId: state.serverId, threadId: state.remoteThreadId, generation: state.generation } });
      metricOpens.set(state.key, { openId, initialRead: false });
      tracked = true;
    });
    try {
      const opened = await openCopyTracked(input, track);
      if (tracked) metric(() => deps.metrics?.finishOpen(openId, "ready"));
      return opened;
    } catch (cause) {
      if (tracked) metric(() => deps.metrics?.finishOpen(openId, "failed"));
      throw cause;
    }
  }

  /** A saved owner remains usable offline, but a known replacement server must never inherit its copy. */
  function cachedCopy(machine: string, threadId: string, localProjectId?: string): CopyState | undefined {
    const snapshots = deps.remote();
    const owner = snapshots.find((s) => s.machineKey === machine && s.threads.some((t) => t.id === threadId)) ??
      snapshots.find((s) => s.threads.some((t) => t.id === threadId)) ?? snapshots.find((s) => s.machineKey === machine);
    const matching = [...copies.values()].filter((state) => state.machine === machine && state.remoteThreadId === threadId &&
      state.localProjectId === localProjectId && (!owner || owner.serverId === state.serverId));
    return matching.length === 1 ? matching[0] : undefined;
  }

  /** Refresh a usable local copy without putting an owner or broker read on the navigation path. */
  function refreshExisting(state: CopyState): void {
    if (refreshingCopies.get(state.key)?.state === state) return;
    const done = Promise.resolve().then(async () => {
      if (copies.get(state.key) !== state) return;
      const previousError = state.error;
      await enableWrites(state);
      if (copies.get(state.key) !== state) return;
      if (state.transport !== "direct" && deps.direct) {
        try { await resumeDirect(state); }
        catch (cause) {
          if (copies.get(state.key) !== state) return;
          if (turso === null) throw cause;
          bb.log.warn(`fleet mirror: direct resume deferred for ${state.key}: ${message(cause)}`);
        }
      }
      if (copies.get(state.key) !== state) return;
      if (state.transport === "direct") {
        await save(state); // Keep a matched owner cursor even if the next read fails.
        await updateDirect(state);
      } else {
        await ensureSchema();
        if (copies.get(state.key) !== state) return;
        await upsertWatch(state);
      }
      if (copies.get(state.key) !== state) return;
      await settleEndedFromFeed(state);
      state.error = null;
      if (lastError === previousError) lastError = null;
      await save(state);
    }).catch(async (cause: unknown) => {
      if (copies.get(state.key) !== state) return;
      state.error = `Connection to ${state.machine}: ${message(cause)}`;
      lastError = state.error;
      bb.log.warn(`fleet mirror: ${state.key}: ${state.error}`);
      try { await save(state); }
      catch (saveCause) { bb.log.warn(`fleet mirror: could not save connection error for ${state.key}: ${message(saveCause)}`); }
    }).finally(() => {
      if (refreshingCopies.get(state.key)?.done === done) refreshingCopies.delete(state.key);
      nextRead = 0;
      try { deps.wake?.(); }
      catch (cause) { bb.log.warn(`fleet mirror: could not wake catch-up for ${state.key}: ${message(cause)}`); }
    });
    refreshingCopies.set(state.key, { state, done });
  }

  async function openExisting(state: CopyState, track: (state: CopyState) => void): Promise<{ localThreadId: string }> {
    const localThreadId = state.localThreadId!;
    track(state);
    state.openedAt = Date.now();
    await save(state);
    refreshExisting(state);
    nextRead = 0;
    deps.wake?.();
    return { localThreadId };
  }

  async function openCopyTracked(input: { machine: string; threadId: string; title?: string; localProjectId?: string }, track: (state: CopyState) => void): Promise<{ localThreadId: string }> {
    if (!deps.joined()) throw new MirrorError('Switch on "Join the fleet" in Fleet settings first');
    if (input.localProjectId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/.test(input.localProjectId)) throw new MirrorError("Invalid local project identity for the mirror copy");
    await load();
    if (!loaded) throw new MirrorError("The saved mirror copies could not be read yet");
    const machine = canonical(input.machine);
    const cached = cachedCopy(machine, input.threadId, input.localProjectId);
    if (cached?.localThreadId && await copyExists(cached.localThreadId)) return openExisting(cached, track);
    if (turso === null && !deps.direct) throw new MirrorError("This machine has no transcript connection");
    const owner = await ownerOf(machine, input.threadId);
    const copyKey = `${owner.serverId}:${input.threadId}${input.localProjectId ? `:project:${input.localProjectId}` : ""}`;
    const existing = copies.get(copyKey);
    const now = Date.now();
    if (existing?.localThreadId && (await copyExists(existing.localThreadId))) {
      return openExisting(existing, track);
    }
    if (existing && existing.localThreadId === null && waiters.has(copyKey)) {
      return waitForCopy(copyKey, OPEN_WAIT_MS);
    }
    if (existing) await forget(existing);
    const state: CopyState = {
      key: copyKey,
      machine,
      serverId: owner.serverId,
      remoteThreadId: input.threadId,
      title: (input.title ?? owner.title ?? `Chat on the ${machine}`).slice(0, 200),
      generation: randomUUID(),
      localThreadId: null,
      readSeq: 0,
      appended: 0,
      sentThrough: 0,
      openedAt: now,
      createdAt: now,
      error: null,
      ...(input.localProjectId ? { localProjectId: input.localProjectId } : {}),
      ...(deps.forwardControl ? { replayToken: randomUUID() } : {}),
    };
    track(state);
    dropFeed(state);
    const header: FeedHeader = { t: "header", machine, serverId: owner.serverId, remoteThreadId: input.threadId, ...(state.replayToken ? { control: { v: 1, replayToken: state.replayToken } } : {}) };
    append(state, [header]);
    await save(state);
    if (deps.direct) {
      try {
        await prepareDirect(state);
        state.transport = "direct";
        await save(state);
      } catch (cause) {
        if (turso === null) {
          await forget(state);
          throw new MirrorError(`No direct route for the ${machine}: ${message(cause)}`);
        }
      }
    }
    const waiting = waitForCopy(copyKey, OPEN_WAIT_MS);
    if (state.transport === "direct") {
      try {
        await updateDirect(state);
        if (state.localThreadId && directBacklogs.delete(state)) refreshExisting(state);
      }
      catch (cause) { if (copies.get(state.key) === state) settle(state.key, { error: `Could not read the ${machine}: ${message(cause)}` }); }
    } else {
      try { await ensureSchema(); await upsertWatch(state); }
      catch (cause) { settle(state.key, { error: message(cause) }); }
    }
    nextRead = 0;
    nextWatchPoll = 0;
    deps.wake?.();
    return waiting;
  }

  /** Copies the reader polls: opened within the watch lifetime. */
  function liveCopies(now: number): CopyState[] {
    return [...copies.values()].filter((c) => now - c.openedAt <= WATCH_TTL_MS);
  }

  async function read(): Promise<void> {
    const db = turso!;
    const { serverId: own } = await deps.me();
    const now = Date.now();
    const live = liveCopies(now).filter((c) => c.transport !== "direct" && refreshingCopies.get(c.key)?.state !== c);
    if (live.length === 0) return;
    const startedAt = performance.now();
    const brokerRead = (c: CopyState, rows: { seq: number; payload: string }[] | null, endedAt: number) => metric(() => {
      const open = metricOpens.get(c.key);
      const mode = open && !open.initialRead ? "initial" : "delta";
      if (open) open.initialRead = true;
      const failed = rows === null || rows.length > 2000;
      deps.metrics?.recordBrokerRead?.({ readId: randomUUID(), ...(open ? { openId: open.openId } : {}), stream: { serverId: c.serverId, threadId: c.remoteThreadId, generation: c.generation }, mode, startedAt, endedAt, rows: failed ? null : rows, cursorBefore: c.readSeq, cursorAfter: failed ? null : rows.reduce((max, row) => Math.max(max, row.seq), c.readSeq), failed });
    });
    let results: Row[][];
    try {
      results = await db.batch(
        live.map((c) => ({
          sql: `SELECT seq, payload FROM fleet_mirror_events
                WHERE server_id = ? AND thread_id = ? AND recipient = ? AND generation = ? AND seq > ?
                ORDER BY seq LIMIT 4`,
          args: [c.serverId, c.remoteThreadId, own, c.generation, c.readSeq],
        })),
        30_000,
      );
    } catch (cause) {
      const endedAt = performance.now();
      for (const c of live) brokerRead(c, null, endedAt);
      throw cause;
    }
    const endedAt = performance.now();
    for (let i = 0; i < live.length; i += 1) brokerRead(live[i]!, (results[i] ?? []).map((row) => ({ seq: Number(row.seq), payload: String(row.payload) })), endedAt);
    for (let i = 0; i < live.length; i += 1) {
      const state = live[i]!;
      if (copies.get(state.key) !== state || state.transport === "direct" || refreshingCopies.get(state.key)?.state === state) continue;
      const rows = results[i] ?? [];
      if (rows.length === 0 && state.localThreadId === null && !waiters.has(state.key) && now - state.createdAt > PENDING_TTL_MS) {
        await forget(state); // an open that never got its first row (the other Mac stayed asleep)
        continue;
      }
      let changed = false;
      for (const row of rows) {
        const seq = Number(row.seq);
        if (seq !== state.readSeq + 1) break; // rows apply strictly in order
        let batch: MirrorBatch | null = null;
        try {
          const plain = openSealed(String(row.payload), key, rowAad({ serverId: state.serverId, threadId: state.remoteThreadId, recipient: own, generation: state.generation, seq }));
          batch = JSON.parse(plain) as MirrorBatch;
        } catch (cause) {
          bb.log.warn(`fleet mirror: row ${seq} of ${state.key} could not be opened: ${message(cause)}`);
        }
        const records: FeedRecord[] = [];
        if (batch === null || batch.v !== 1 || batch.generation !== state.generation || !Array.isArray(batch.records)) {
          records.push({ t: "note", text: `One update from the ${state.machine} could not be read here, so a part of this chat is missing.` });
        } else {
          for (const record of batch.records) {
            records.push(record);
            if (seq === 1 && (batch as MirrorBatch & { earlier?: boolean }).earlier && record.t === "turn" && !records.some((r) => r.t === "note")) {
              records.push({ t: "note", text: earlierHistoryLine(state.machine) });
            }
          }
        }
        append(state, records);
        state.readSeq = seq;
        changed = true;
      }
      if (changed) await save(state);
      try {
        await drive(state);
        await enableWrites(state);
        warned.delete(state.key);
      } catch (cause) {
        const text = `fleet mirror: ${state.key}: ${message(cause)}`;
        if (warned.get(state.key) !== text) bb.log.warn(text);
        warned.set(state.key, text);
      }
    }
  }

  /** Send the copy's next remote user message when the copy is ready for it. */
  async function drive(state: CopyState): Promise<void> {
    const pending = drivingCopies.get(state.key);
    if (pending?.state === state) return pending.done;
    const done = driveCopy(state);
    drivingCopies.set(state.key, { state, done });
    try { await done; }
    finally { if (drivingCopies.get(state.key)?.done === done) drivingCopies.delete(state.key); }
  }

  async function driveCopy(state: CopyState): Promise<void> {
    if (copies.get(state.key) !== state) return;
    const users = usersOf(state);
    if (state.localThreadId === null) {
      const first = users.find((u) => u.kind === "turn");
      if (first === undefined) return;
      let id: string;
      try {
        const hostId = await deps.serverHostId();
        if (copies.get(state.key) !== state) return;
        if (hostId === null) throw new MirrorError("This bb has no server host for the copy");
        const where = await copyEnvironment(bb, hostId, deps.environmentSetting?.() ?? "", state.localProjectId);
        if (copies.get(state.key) !== state) return;
        const spawned = threadOf(
          await bb.sdk.threads.spawn({
            projectId: where.projectId,
            environment: { type: "reuse", environmentId: where.environmentId },
            providerId: MIRROR_PROVIDER_ID,
            model: MIRROR_MODEL_ID,
            reasoningLevel: "medium",
            executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit" },
            input: state.replayToken ? mirrorReplayInput(first.text, { requestId: first.requestId, token: state.replayToken }) : [{ type: "text", text: first.text, mentions: [] }],
            title: state.title,
            visibility: "hidden",
            pluginMetadata: { machine: state.machine, serverId: state.serverId, remoteThreadId: state.remoteThreadId },
          }),
        );
        if (copies.get(state.key) !== state) return;
        if (typeof spawned?.id !== "string") throw new MirrorError("bb did not return the copy's id");
        id = spawned.id;
      } catch (cause) {
        if (copies.get(state.key) === state) settle(state.key, { error: `Could not make the local copy: ${message(cause)}` });
        throw cause;
      }
      promoteFeed(stagingPath(feedDir, state.key), feedPath(feedDir, id));
      state.localThreadId = id;
      state.sentThrough = first.index + 1;
      await save(state);
      bb.log.info(`fleet mirror: copy ${id} of ${state.key} (${state.machine})`);
      settle(state.key, { localThreadId: id });
      return;
    }
    const next = users.find((u) => u.index >= state.sentThrough);
    if (next === undefined) return;
    const control = next.controlId ? readControl(feedDir, next.controlId) : null;
    if (control && control.localThreadId === state.localThreadId && control.targetServer === state.serverId && control.remoteThreadId === state.remoteThreadId) {
      // Its user bubble already exists: the bridge attaches the owner turn by control ID.
      state.sentThrough = next.index + 1;
      await save(state);
      return;
    }
    const bridgeAt = readCursor(cursorPath(feedDir, state.localThreadId));
    if (bridgeAt < next.index) return; // the bridge has not reached it yet
    const copy = threadOf(await bb.sdk.threads.get({ threadId: state.localThreadId }).catch(() => null));
    if (copies.get(state.key) !== state) return;
    if (copy === null || copy.deletedAt != null) {
      await forget(state); // the copy was deleted here: the next open makes a new one
      return;
    }
    if (next.kind === "turn" && !isIdle(copy)) return;
    await bb.sdk.threads.send({ threadId: state.localThreadId, mode: "auto", input: state.replayToken ? mirrorReplayInput(next.text, { requestId: next.requestId, token: state.replayToken }) : [{ type: "text", text: next.text, mentions: [] }] });
    if (copies.get(state.key) !== state) return;
    state.sentThrough = next.index + 1;
    await save(state);
  }

  /** Switch an existing copy only after finding its last exact owner event. */
  async function resumeDirect(state: CopyState): Promise<void> {
    if (!deps.direct) throw new MirrorError("No direct read transport configured");
    const feed = new FeedReader(feedFileOf(state));
    feed.poll();
    const anchor = [...feed.records].reverse().find((r) => r.t === "turn" || r.t === "steer" || r.t === "item" || r.t === "end");
    if (!anchor || !("turn" in anchor)) {
      await prepareDirect(state);
      state.transport = "direct";
      return;
    }
    let before: number | null = null;
    for (let page = 0; page < 20; page += 1) {
      const rows = await directRead(state, "history", { order: "desc", limit: String(DIRECT_EVENTS_PAGE), ...(before === null ? {} : { beforeSeq: String(before) }) });
      if (copies.get(state.key) !== state) return;
      const match = rows.find((event) => {
        const turnId = event.scope?.turnId;
        if (anchor.t === "end") return event.type === "turn/completed" && turnId === anchor.turn;
        if (anchor.t === "item") return event.type.startsWith("item/") && (event.data?.item as { id?: unknown } | undefined)?.id === anchor.id;
        if (anchor.t === "turn" && anchor.user === null) return event.type === "turn/started" && turnId === anchor.turn;
        if (anchor.t === "turn" || anchor.t === "steer") return event.type === "turn/input/accepted" && turnId === anchor.turn && event.data?.clientRequestId === anchor.user?.requestId;
        return false;
      });
      if (match) {
        const mapper = newMapperState();
        mapper.currentTurn = anchor.t === "end" ? null : anchor.turn;
        directMappers.set(state.key, mapper);
        state.directSeq = match.seq;
        state.transport = "direct";
        return;
      }
      const last = rows.at(-1);
      if (rows.length < DIRECT_EVENTS_PAGE || !last) break;
      before = last.seq;
    }
    throw new MirrorError("The direct owner history could not be matched to this copy; it has not been replayed or overwritten.");
  }

  async function prepareDirect(state: CopyState): Promise<void> {
    if (!deps.direct) throw new MirrorError("No direct read transport configured");
    const requests: StoredEvent[] = [];
    let before: number | null = null;
    for (let page = 0; page < 10; page += 1) {
      const list = await directRead(state, "history", { types: ["client/turn/requested"], order: "desc", limit: String(DIRECT_EVENTS_PAGE), ...(before === null ? {} : { beforeSeq: String(before) }) });
      if (copies.get(state.key) !== state) return;
      requests.push(...list.filter((e) => e.type === "client/turn/requested"));
      const last = list.at(-1);
      if (list.length < DIRECT_EVENTS_PAGE || !last || requests.filter((e) => (e.data?.target as { kind?: unknown } | undefined)?.kind !== "steer").length > REPLAY_TURNS) break;
      before = last.seq;
    }
    const start = replayStart(requests);
    state.directSeq = start.afterSeq;
    const mapper = newMapperState();
    for (const event of requests) rememberRequest(mapper, event.data);
    directMappers.set(state.key, mapper);
    state.directEarlier = start.earlier;
  }

  /**
   * Settle this copy's native prompts for owner interactions that ended on the owner.
   * A provider prompt cannot be cancelled through the SDK (core only cancels plugin
   * prompts), so it is resolved with the owner's own answer; the bridge drops that
   * answer because the owner already ended it. An interrupted approval is closed as
   * denied; a question the owner ended without an answer has nothing valid to show.
   */
  async function settleEndedPrompts(localThreadId: string, ends: ReadonlyMap<string, Extract<FeedRecord, { t: "interaction-end" }>>): Promise<void> {
    if (ends.size === 0) return;
    let local: { id: string; status: string; providerRequestId?: string; payload?: { kind?: unknown } }[];
    try { local = await deps.bb.sdk.threads.interactions.list({ threadId: localThreadId }) as unknown as typeof local; }
    catch { return; }
    for (const entry of local) {
      if (entry.status !== "pending") continue;
      const end = [...ends.values()].find((item) => (entry.providerRequestId ?? "").endsWith(`:${interactionRequestId(item.id)}`));
      if (!end) continue;
      const kind = entry.payload?.kind;
      const owner = end.resolution;
      const resolution = kind === "user_question" ? (owner?.kind === "user_answer" ? owner : null)
        : kind === "approval" ? (typeof owner?.decision === "string" ? owner : { decision: "deny" }) : null;
      if (resolution === null) continue;
      try { await deps.bb.sdk.threads.interactions.resolve({ threadId: localThreadId, interactionId: entry.id, resolution: resolution as never }); }
      catch { /* answered or changed here meanwhile: nothing left to settle */ }
    }
  }

  /** On reopen: settle any prompt still pending on this copy for an owner interaction the feed shows as ended (raised after the end was read). */
  async function settleEndedFromFeed(state: CopyState): Promise<void> {
    if (state.localThreadId === null) return;
    const reader = new FeedReader(feedFileOf(state));
    reader.poll();
    const ends = new Map<string, Extract<FeedRecord, { t: "interaction-end" }>>();
    for (const record of reader.records) if (record.t === "interaction-end") ends.set(record.id, record);
    await settleEndedPrompts(state.localThreadId, ends);
  }

  async function readDirect(state: CopyState, maxEvents = EVENTS_PER_ROW): Promise<boolean> {
    if (!deps.direct) throw new MirrorError("The direct owner route is unavailable");
    let mapper = directMappers.get(state.key);
    if (!mapper) { mapper = newMapperState(); directMappers.set(state.key, mapper); }
    const events: StoredEvent[] = [];
    let cursor = state.directSeq ?? 0;
    while (events.length < maxEvents) {
      const open = metricOpens.get(state.key);
      const mode = open && !open.initialRead ? "initial" : "delta";
      if (open) open.initialRead = true;
      const page = await directRead(state, mode, { afterSeq: String(cursor), order: "asc", limit: String(DIRECT_EVENTS_PAGE) });
      if (copies.get(state.key) !== state) return false;
      const next = page.filter((e) => e.seq > cursor);
      if (next.length === 0) break;
      events.push(...next);
      cursor = next.at(-1)!.seq;
      if (page.length < DIRECT_EVENTS_PAGE) break;
    }
    if (missingRequestIds(events, mapper).length > 0) {
      const found = await directRead(state, "lookup", { types: ["client/turn/requested"], beforeSeq: String(events[0]?.seq ?? 0), order: "desc", limit: "60" });
      if (copies.get(state.key) !== state) return false;
      for (const event of found) rememberRequest(mapper, event.data);
    }
    const mapped = mapEvents(events, mapper, { now: Date.now(), maxBytes: ROW_MAX_BYTES });
    if (mapped.lastSeq !== null) {
      const records: FeedRecord[] = [...mapped.records];
      const ends = new Map<string, Extract<FeedRecord, { t: "interaction-end" }>>();
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        if (record.t === "interaction" && record.detail === null && deps.interactionDetail && deps.forwardControl && state.replayToken) {
          let detail: { payload: Record<string, unknown>; fingerprint: string } | null = null;
          try { detail = await deps.interactionDetail({ serverId: state.serverId, machine: state.machine, threadId: state.remoteThreadId, interactionId: record.id }); } catch { detail = null; }
          if (copies.get(state.key) !== state) return false;
          records[index] = { ...record, detail };
          if (detail === null) {
            state.pendingDetails = [...(state.pendingDetails ?? []).filter((entry) => entry.id !== record.id), { id: record.id, turn: record.turn, kind: record.kind, attempts: 1, nextAt: Date.now() + DETAIL_RETRY_MS }].slice(-DETAIL_PENDING_LIMIT);
          }
        }
        if (record.t === "interaction-end") {
          if (state.pendingDetails) state.pendingDetails = state.pendingDetails.filter((entry) => entry.id !== record.id);
          ends.set(record.id, record);
        }
      }
      if (copies.get(state.key) !== state) return false;
      if (state.directEarlier) {
        const firstTurn = records.findIndex((record) => record.t === "turn");
        if (firstTurn >= 0) {
          records.splice(firstTurn + 1, 0, { t: "note", text: earlierHistoryLine(state.machine) });
          state.directEarlier = false;
        }
      }
      append(state, records);
      state.directSeq = mapped.lastSeq;
      state.error = null;
      await save(state);
      // Only once the end is in the feed, so the bridge drops the settling answer.
      if (state.localThreadId) await settleEndedPrompts(state.localThreadId, ends);
    }
    await retryInteractionDetails(state);
    return events.length >= maxEvents || (mapped.lastSeq !== null && mapped.lastSeq < cursor);
  }

  /** Re-read the detail of owner interactions that are still pending here; an owner end always wins. */
  async function retryInteractionDetails(state: CopyState): Promise<void> {
    if (!state.pendingDetails || state.pendingDetails.length === 0 || !deps.interactionDetail || !deps.forwardControl || !state.replayToken) return;
    const found: FeedRecord[] = [];
    let changed = false;
    for (const entry of [...state.pendingDetails]) {
      if (Date.now() < entry.nextAt) continue;
      let detail: { payload: Record<string, unknown>; fingerprint: string } | null = null;
      try { detail = await deps.interactionDetail({ serverId: state.serverId, machine: state.machine, threadId: state.remoteThreadId, interactionId: entry.id }); } catch { detail = null; }
      if (copies.get(state.key) !== state) return;
      const current = state.pendingDetails?.find((item) => item.id === entry.id);
      if (!current) continue;
      changed = true;
      if (detail !== null) {
        state.pendingDetails = state.pendingDetails!.filter((item) => item.id !== entry.id);
        found.push({ t: "interaction", turn: entry.turn, id: entry.id, kind: entry.kind, detail });
      } else if (current.attempts >= DETAIL_RETRY_LIMIT) {
        state.pendingDetails = state.pendingDetails!.filter((item) => item.id !== entry.id);
      } else {
        current.attempts += 1;
        current.nextAt = Date.now() + Math.min(30_000, DETAIL_RETRY_MS * current.attempts);
      }
    }
    if (found.length > 0) append(state, found);
    if (changed) await save(state);
  }


  async function updateDirect(state: CopyState): Promise<void> {
    const pending = directUpdates.get(state.key);
    if (pending?.state === state) return pending.done;
    const update = Promise.resolve().then(async () => {
      if (copies.get(state.key) !== state || state.transport !== "direct") return;
      // A first open only needs the page that supplies its first user turn.
      // Persist every processed page; catch-up continues from that cursor after navigation.
      for (let page = 0; page < EVENTS_PER_ROW / DIRECT_EVENTS_PAGE; page += 1) {
        const before = state.directSeq ?? 0;
        const backlog = await readDirect(state, state.localThreadId === null ? DIRECT_EVENTS_PAGE : EVENTS_PER_ROW);
        if (backlog) directBacklogs.add(state);
        else directBacklogs.delete(state);
        if (copies.get(state.key) !== state) return;
        await drive(state);
        if (copies.get(state.key) !== state) return;
        if (state.localThreadId !== null || (state.directSeq ?? 0) === before) break;
      }
      await enableWrites(state);
    });
    directUpdates.set(state.key, { state, done: update });
    try {
      await update;
    } finally {
      if (directUpdates.get(state.key)?.done === update) directUpdates.delete(state.key);
    }
  }

  async function readDirectCopies(): Promise<void> {
    if (!deps.direct) return;
    for (const state of liveCopies(Date.now()).filter((c) => c.transport === "direct")) {
      try {
        const refreshing = refreshingCopies.get(state.key);
        if (refreshing?.state === state) await refreshing.done;
        else await updateDirect(state);
      }
      catch (cause) {
        if (copies.get(state.key) !== state) continue;
        state.error = `Direct connection to ${state.machine}: ${message(cause)}`;
        await save(state);
        settle(state.key, { error: state.error });
      }
    }
  }

  // ---------- publishing ----------

  /** Events after `afterSeq`, oldest first, in pages of 100 (bb's cap). */
  async function readEvents(threadId: string, afterSeq: number): Promise<StoredEvent[]> {
    const out: StoredEvent[] = [];
    let cursor = afterSeq;
    while (out.length < EVENTS_PER_ROW) {
      const page = (await bb.sdk.threads.events.list({ threadId, afterSeq: String(cursor), order: "asc", limit: String(EVENTS_PAGE) })) as unknown as StoredEvent[];
      out.push(...page);
      const last = page[page.length - 1];
      if (page.length < EVENTS_PAGE || last === undefined) break;
      cursor = last.seq;
    }
    return out;
  }

  /** The chat's client/turn/requested events, newest first, enough to find the replay start. */
  async function recentRequests(threadId: string): Promise<StoredEvent[]> {
    const out: StoredEvent[] = [];
    let before: number | null = null;
    for (let page = 0; page < 10; page += 1) {
      const list = (await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: String(EVENTS_PAGE),
        ...(before === null ? {} : { beforeSeq: String(before) }),
      })) as unknown as StoredEvent[];
      // Filter here too: a bb that ignores `types` still pages correctly.
      out.push(...list.filter((e) => e.type === "client/turn/requested"));
      const openings = out.filter((e) => (e.data?.target as { kind?: unknown } | undefined)?.kind !== "steer").length;
      const last = list[list.length - 1];
      if (list.length < EVENTS_PAGE || last === undefined || openings > REPLAY_TURNS) break;
      before = last.seq;
    }
    return out;
  }

  async function lookupRequests(threadId: string, events: readonly StoredEvent[], mapper: MapperState): Promise<void> {
    if (missingRequestIds(events, mapper).length === 0) return;
    const before = events[0]?.seq ?? 0;
    const found = (await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      beforeSeq: String(before),
      order: "desc",
      limit: "60",
    })) as unknown as StoredEvent[];
    for (const e of found) rememberRequest(mapper, e.data);
  }

  async function endWatch(db: TursoClient, own: string, watch: WatchRow, state: "ended" | "error", error: string | null): Promise<void> {
    await db.batch([
      { sql: `UPDATE fleet_mirror_watch SET state = ?, error = ?, updated_at = ? WHERE id = ?`, args: [state, error, Date.now(), watch.id] },
      { sql: `DELETE FROM fleet_mirror_events WHERE server_id = ? AND thread_id = ? AND recipient = ? AND generation = ?`, args: [own, watch.threadId, watch.watcherServer, watch.generation] },
    ]);
    publishing.delete(watch.id);
  }

  async function publishOne(db: TursoClient, own: string, watch: WatchRow, now: number): Promise<boolean> {
    const source = threadOf(await bb.sdk.threads.get({ threadId: watch.threadId }).catch(() => null));
    if (source === null || source.deletedAt != null) {
      await endWatch(db, own, watch, "error", "No such chat on this machine");
      return false;
    }
    const running = isRunning(source);
    if (!watchLive({ openedAt: watch.openedAt, running, now })) {
      await endWatch(db, own, watch, "ended", null);
      return false;
    }
    let pub = publishing.get(watch.id);
    if (pub === undefined || pub.generation !== watch.generation) {
      if (watch.publishedGeneration === watch.generation) {
        // After a reload: carry on where the last row left off.
        pub = { generation: watch.generation, cursor: watch.publishedSeq, nextSeq: watch.nextSeq, mapper: newMapperState(), earlier: false, lastWriteAt: 0, firstRowDone: true };
      } else {
        await db.query(`DELETE FROM fleet_mirror_events WHERE server_id = ? AND thread_id = ? AND recipient = ? AND generation != ?
          AND generation NOT IN (SELECT generation FROM fleet_mirror_watch WHERE target_server = ? AND thread_id = ? AND watcher_server = ? AND state = 'active')`, [
          own,
          watch.threadId,
          watch.watcherServer,
          watch.generation,
          own,
          watch.threadId,
          watch.watcherServer,
        ]);
        const start = replayStart(await recentRequests(watch.threadId));
        pub = { generation: watch.generation, cursor: start.afterSeq, nextSeq: 1, mapper: newMapperState(), earlier: start.earlier, lastWriteAt: 0, firstRowDone: false };
      }
      publishing.set(watch.id, pub);
    }
    if (now - pub.lastWriteAt < ROW_EVERY_MS) return true;
    const events = await readEvents(watch.threadId, pub.cursor);
    await lookupRequests(watch.threadId, events, pub.mapper);
    const mapped = mapEvents(events, pub.mapper, { now, maxBytes: ROW_MAX_BYTES });
    if (mapped.lastSeq === null) return running;
    const backlog = events.length >= EVENTS_PER_ROW || mapped.lastSeq !== events[events.length - 1]?.seq;
    if (mapped.records.length === 0) {
      pub.cursor = mapped.lastSeq; // nothing a copy shows: no row
      return running || backlog;
    }
    const batch: MirrorBatch & { earlier?: boolean } = { v: 1, generation: pub.generation, records: mapped.records as MirrorRecord[] };
    if (!pub.firstRowDone && pub.earlier) batch.earlier = true;
    const seq = pub.nextSeq;
    const payload = seal(JSON.stringify(batch), watch.watcherKey, rowAad({ serverId: own, threadId: watch.threadId, recipient: watch.watcherServer, generation: pub.generation, seq }));
    const stamp = Date.now();
    await db.batch([
      {
        sql: `INSERT INTO fleet_mirror_events (server_id, thread_id, recipient, generation, seq, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(server_id, thread_id, recipient, generation, seq) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
        args: [own, watch.threadId, watch.watcherServer, pub.generation, seq, payload, stamp],
      },
      {
        sql: `UPDATE fleet_mirror_watch SET published_generation = ?, published_seq = ?, next_seq = ?, updated_at = ? WHERE id = ? AND generation = ?`,
        args: [pub.generation, mapped.lastSeq, seq + 1, stamp, watch.id, pub.generation],
      },
    ], 30_000);
    pub.cursor = mapped.lastSeq;
    pub.nextSeq = seq + 1;
    pub.lastWriteAt = stamp;
    pub.firstRowDone = true;
    return true;
  }

  async function publish(force: boolean): Promise<void> {
    const db = turso!;
    const now = Date.now();
    if (!force && !publishActive && now < nextWatchPoll) return;
    nextWatchPoll = now + WATCH_POLL_MS;
    const { serverId: own } = await deps.me();
    const rows = await db.query(
      `SELECT id, watcher_server, thread_id, watcher_key, generation, opened_at, published_generation, published_seq, next_seq
       FROM fleet_mirror_watch WHERE target_server = ? AND state = 'active'`,
      [own],
    );
    let active = false;
    const seen = new Set<string>();
    for (const r of rows) {
      const watch: WatchRow = {
        id: String(r.id),
        watcherServer: String(r.watcher_server),
        threadId: String(r.thread_id),
        watcherKey: String(r.watcher_key),
        generation: String(r.generation),
        openedAt: Number(r.opened_at ?? 0),
        publishedGeneration: r.published_generation === null ? null : String(r.published_generation),
        publishedSeq: Number(r.published_seq ?? 0),
        nextSeq: Number(r.next_seq ?? 1),
      };
      seen.add(watch.id);
      try {
        if (await publishOne(db, own, watch, now)) active = true;
        warned.delete(watch.id);
      } catch (cause) {
        const text = `fleet mirror: publishing ${watch.threadId} for ${watch.watcherServer}: ${message(cause)}`;
        if (warned.get(watch.id) !== text) bb.log.warn(text);
        warned.set(watch.id, text);
      }
    }
    for (const id of [...publishing.keys()]) if (!seen.has(id)) publishing.delete(id);
    publishActive = active;
    if (now >= nextPrune) {
      nextPrune = now + PRUNE_EVERY_MS;
      await db.batch([
        { sql: `DELETE FROM fleet_mirror_events WHERE server_id = ? AND created_at < ?`, args: [own, now - EVENT_TTL_MS] },
        { sql: `DELETE FROM fleet_mirror_watch WHERE target_server = ? AND state != 'active' AND updated_at < ?`, args: [own, now - WATCH_TTL_MS] },
      ]);
    }
  }

  // ---------- the loop ----------

  let drainingControls = false;
  const RECEIPT_EVERY_MS = 3000;
  /** The durable control outbox is independent of the transcript broker. */
  async function processControls(): Promise<void> {
    if (!deps.forwardControl || drainingControls || !deps.joined()) return;
    drainingControls = true;
    try {
      await load();
      for (const request of listControls(feedDir)) {
        const copy = [...copies.values()].find((c) => c.localThreadId === request.localThreadId && c.serverId === request.targetServer && c.remoteThreadId === request.remoteThreadId);
        const old = readControlState(feedDir, request.id);
        if (old && (old.state === "accepted" || old.state === "queued")) {
          // Relay admission and an owner's queue receipt can both precede rejection.
          // Reconcile by identity, never by calling the mutating transport again.
          if (copy?.replayToken && usersOf(copy).some((user) => user.controlId === request.id)) {
            // An exact source echo proves the owner accepted this input, even if
            // its original queue receipt has not been refreshed by the transport.
            writeControlState(feedDir, request.id, { ...old, state: "sent", at: Date.now() });
          } else if (copy?.replayToken && deps.controlReceipt && Date.now() >= (old.receiptCheckedAt ?? 0) + RECEIPT_EVERY_MS) {
            const checked = { ...old, receiptCheckedAt: Date.now() };
            writeControlState(feedDir, request.id, checked);
            try {
              const receipt = await deps.controlReceipt(request);
              const current = readControlState(feedDir, request.id);
              // An inaccessible/missing receipt cannot revoke known admission or make it retryable.
              // An owner queue must also never regress to the relay's older pending admission.
              // A slower lookup must not replace a final receipt saved by another process.
              if (current && (current.state === "accepted" || current.state === "queued") && receipt && receipt.state !== "unavailable" && !(current.state === "queued" && receipt.state === "accepted")) {
                writeControlState(feedDir, request.id, { ...receipt, at: Date.now(), attempts: current.attempts, receiptCheckedAt: checked.receiptCheckedAt });
              }
            } catch (cause) {
              bb.log.warn(`fleet mirror: receipt check deferred for ${request.id}: ${message(cause)}`);
            }
          }
          continue;
        }
        if (old && ["sent", "unknown", "failed", "cancelled"].includes(old.state)) continue;
        if (old?.state === "sending") {
          // The prior process may have dispatched before it died. Never send it twice.
          writeControlState(feedDir, request.id, { state: "unknown", at: Date.now(), attempts: old.attempts, message: "Delivery was interrupted after dispatch began; check the owning chat before retrying." });
          continue;
        }
        if (old?.retryAt && old.retryAt > Date.now()) continue;
        const attempts = (old?.attempts ?? 0) + 1;
        if (!copy?.replayToken) {
          writeControlState(feedDir, request.id, { state: "failed", at: Date.now(), attempts, message: "This request does not belong to a writable Fleet copy." });
          continue;
        }
        if (!claimControl(feedDir, request.id)) {
          const claimed = readControlState(feedDir, request.id);
          if (!claimed || !["accepted", "sent", "queued", "unknown", "failed", "cancelled"].includes(claimed.state)) {
            writeControlState(feedDir, request.id, { state: "unknown", at: Date.now(), attempts, message: "Another process claimed this message; delivery must be reconciled before retrying." });
          }
          continue;
        }
        writeControlState(feedDir, request.id, { state: "sending", at: Date.now(), attempts });
        try {
          const result = await deps.forwardControl(request);
          writeControlState(feedDir, request.id, { ...result, at: Date.now(), attempts, ...(result.state === "unavailable" ? { retryAt: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)) } : {}) });
          if (result.state === "unavailable") releaseUnavailableClaim(feedDir, request.id);
        } catch (cause) {
          writeControlState(feedDir, request.id, { state: "unknown", at: Date.now(), attempts, message: `Delivery could not be confirmed: ${message(cause)}` });
        }
      }
    } finally {
      drainingControls = false;
    }
  }

  /** One cycle: deliver controls, then publish/read transcript records. */
  async function tick(): Promise<void> {
    if (!deps.joined()) return;
    await processControls();
    await readDirectCopies();
    if (turso === null) return;
    await load();
    await ensureSchema();
    const pending = [...copies.values()].some((c) => c.localThreadId === null && waiters.has(c.key));
    try {
      await publish(pending);
      const now = Date.now();
      if (pending || now >= nextRead) {
        const fast = pending || liveCopies(now).some((c) => now - c.openedAt < RECENT_OPEN_MS || copyBusy(c));
        nextRead = now + (fast ? READ_FAST_MS : READ_SLOW_MS);
        await read();
      }
      lastError = null;
    } catch (cause) {
      lastError = message(cause);
      throw cause;
    }
  }

  /** A copy whose bridge has not caught up with its feed (a mirrored turn is open). */
  function copyBusy(state: CopyState): boolean {
    if (state.localThreadId === null) return true;
    return readCursor(cursorPath(feedDir, state.localThreadId)) < state.appended;
  }

  /** Milliseconds until the next cycle. */
  function nextDelay(): number {
    const pending = [...copies.values()].some((c) => c.localThreadId === null && waiters.has(c.key));
    if (pending) return 1000;
    if (publishActive) return ROW_EVERY_MS;
    return Math.max(1000, Math.min(WATCH_POLL_MS, nextRead - Date.now()));
  }

  /** The owner a local copy thread mirrors, from this mirror's saved copy state only. */
  async function copyOwner(localThreadId: string): Promise<{ machine: string; serverId: string; remoteThreadId: string } | null> {
    await load();
    if (!loaded) throw new MirrorError("The saved mirror copies could not be read yet");
    for (const state of copies.values()) {
      if (state.localThreadId === localThreadId && state.machine) return { machine: state.machine, serverId: state.serverId, remoteThreadId: state.remoteThreadId };
    }
    return null;
  }

  return {
    publicKey: key.publicKey,
    feedDir,
    copyOwner,
    feature: MIRROR_FEATURE,
    open: openCopy,
    processControls,
    tick,
    nextDelay,
    lastError: () => lastError,
  };
}

export type Mirror = ReturnType<typeof createMirror>;
export { MirrorError };

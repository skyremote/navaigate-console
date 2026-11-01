// The fleet-mirror provider bridge: calls no model. It replays another
// machine's chat into a hidden local copy. Fleet's server writes the copy's
// records to a feed file (mirror/feed.ts) and drives the copy with
// threads.spawn / threads.send, one call per remote user message; for each
// turn bb starts, the bridge answers with that remote turn's items as bare
// item.close deltas keyed by the remote item ids, streaming as the feed
// grows, and settles the turn when the remote turn is over. Writable feeds
// forward real user input through a durable owner-addressed control outbox.
import { randomUUID } from "node:crypto";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadDeltaSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type PromptInput,
  type ProviderHealthResult,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { cursorPath, feedPath, FeedReader, readCursor, writeCursor } from "./feed";
import {
  cancelPendingControl, controlId, interactionRequestId, interactionResponseFrom, listControls, readControl, readControlState, replayReference, visibleMirrorInput,
  writeControl, MAX_MIRROR_ATTACHMENTS, type MirrorAttachment, type MirrorControlRequest, type MirrorReplayReference,
} from "./control";
import {
  MIRROR_MODEL,
  MIRROR_MODEL_ID,
  isThreadScopedItem,
  promptText,
  sameText,
  watchOnlyLine,
  type FeedRecord,
  type MirrorRecord,
} from "./protocol";

/** A copy's first turn can arrive a moment before Fleet names its feed file. */
const FEED_WAIT_MS = 30_000;
/** How long the bridge holds its place at a remote steer for Fleet to send it. */
const STEER_WAIT_MS = 120_000;
const PUMP_EVERY_MS = 400;


/**
 * provider/health. "not_installed" keeps the provider out of every picker
 * (it is declared experimental_visibility "installed"); copies still run on it.
 */
export const MIRROR_HEALTH: ProviderHealthResult = {
  supported: true,
  health: {
    status: "not_installed",
    statusMessage: "Fleet makes these chats itself when you open another Mac's chat; there is nothing to pick.",
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  },
};

/** A prompt bb handed over. A thread/start prompt carries no request id. */
type Waiting = { clientRequestId: string | null; text: string; at: number; input: readonly PromptInput[]; replay: MirrorReplayReference | null };

interface Session {
  threadId: string;
  providerThreadId: string;
  feedDir: string | null;
  reader: FeedReader | null;
  cursor: number;
  savedCursor: number;
  machine: string | null;
  owner: { serverId: string; remoteThreadId: string } | null;
  /** Source identity observed through the consumed feed; independent of bb's local active turn. */
  ownerTurn: string | null;
  replayToken: string | null;
  hydrated: boolean;
  forwarded: Map<string, { reported: string | null; remoteTurn: string | null }>;
  open: null | { kind: "mirror" | "self" | "forward"; remoteTurn: string | null };
  starts: Waiting[];
  steers: Waiting[];
  waitSince: number | null;
  emitted: Set<string>;
  /** Owner interactions raised natively here, and the ones the owner already ended. */
  raised: Set<string>;
  endedInteractions: Set<string>;
  answers: Map<string, { reported: string | null }>;
}

/** Native prompts in flight: provider request id to the owner interaction it stands for. */
const raisedRequests = new Map<string, { threadId: string; interactionId: string; fingerprint: string; kind: "approval" | "user_question" }>();

type JsonRpcId = string | number;
type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const sessions = new Map<string, Session>();
const io = createBridgeIo<OutboundMessage>();
let counter = 0;
let pumpTimer: ReturnType<typeof setInterval> | null = null;

function uniqueKey(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${process.pid.toString(36)}-${counter}`;
}

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emit(threadId: string, deltas: ThreadDelta[]): void {
  if (deltas.length > 0) notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

function message(text: string): ThreadDelta {
  return { kind: "item.close", key: { providerItemId: uniqueKey("mirror-line") }, status: "completed", item: { type: "agentMessage", text } };
}

function feedDirOf(options: unknown): string | null {
  const providerOptions = (options as { providerOptions?: { feedDir?: unknown } } | undefined)?.providerOptions;
  return typeof providerOptions?.feedDir === "string" && providerOptions.feedDir !== "" ? providerOptions.feedDir : null;
}

/** The item.close for a feed item, or a plain line when bb would refuse its shape. */
function itemDelta(session: Session, record: Extract<MirrorRecord, { t: "item" }>): ThreadDelta {
  const parentRef = record.parent !== undefined && session.emitted.has(record.parent) ? record.parent : undefined;
  const candidate = {
    kind: "item.close",
    key: { providerItemId: record.id, ...(parentRef ? { parentRef } : {}) },
    ...record.close,
  };
  const parsed = threadDeltaSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return message(`One step from the ${session.machine ?? "other Mac"} (${record.close.item.type}) cannot be shown here.`);
}

/** Answer a hand-typed prompt with the watch-only line, as one whole turn. */
function accepted(waiting: Waiting): ThreadDelta[] {
  return waiting.clientRequestId === null ? [] : [{ kind: "input.accepted", clientRequestId: waiting.clientRequestId }];
}

function watchOnlyTurn(session: Session, start: Waiting): ThreadDelta[] {
  return [
    ...accepted(start),
    { kind: "turn.open" },
    message(watchOnlyLine(session.machine)),
    { kind: "turn.boundary", status: "completed" },
  ];
}

function closeOpen(session: Session, out: ThreadDelta[], status: "completed" | "failed" | "interrupted", error?: string): void {
  if (session.open === null) return;
  out.push({ kind: "turn.boundary", status, ...(error ? { error: { message: error } } : {}) });
  session.open = null;
}

function takeMatch(session: Session, list: Waiting[], user: { text: string; requestId: string }): Waiting | null {
  const index = list.findIndex((w) => session.replayToken !== null
    ? w.replay?.token === session.replayToken && w.replay.requestId === user.requestId
    : sameText(w.text, user.text));
  if (index === -1) return null;
  return list.splice(index, 1)[0] ?? null;
}

function ensureReader(session: Session): FeedReader | null {
  if (session.reader !== null) return session.reader;
  if (session.feedDir === null) return null;
  const reader = new FeedReader(feedPath(session.feedDir, session.threadId));
  if (!reader.exists()) return null;
  session.reader = reader;
  return reader;
}

/** Restore consumed identity without replaying content or inventing a local active turn. */
function hydrateSession(session: Session, reader: FeedReader): void {
  if (session.hydrated) return;
  reader.poll();
  if (reader.records.length < session.cursor) return; // a temporarily incomplete feed is not proof of an active owner turn
  const controlTurns = new Map<string, string>();
  const endedTurns = new Set<string>();
  for (const record of reader.records.slice(0, session.cursor)) {
    if (record.t === "header") {
      session.machine = record.machine;
      session.owner = { serverId: record.serverId, remoteThreadId: record.remoteThreadId };
      session.replayToken = record.control?.v === 1 ? record.control.replayToken : null;
      session.ownerTurn = null;
      controlTurns.clear();
      endedTurns.clear();
    } else if (record.t === "control") {
      if (record.v === 1) session.replayToken = record.replayToken;
    } else if (record.t === "turn") {
      session.ownerTurn = record.turn;
      if (record.user?.controlId) controlTurns.set(record.user.controlId, record.turn);
    } else if (record.t === "steer") {
      if (record.user.controlId) controlTurns.set(record.user.controlId, record.turn);
    } else if (record.t === "item" && record.turn && !isThreadScopedItem(record.close.item) && !endedTurns.has(record.turn)) {
      session.ownerTurn = record.turn;
    } else if (record.t === "end") {
      endedTurns.add(record.turn);
      if (session.ownerTurn === record.turn) session.ownerTurn = null;
    } else if (record.t === "interaction-end") {
      session.endedInteractions.add(record.id);
    }
  }
  // Pending cancellation identities survive bridge process/session replacement.
  // No command is written or dispatched here, and old status notices stay suppressed.
  if (session.feedDir !== null && session.replayToken !== null) {
    for (const request of listControls(session.feedDir)) {
      if (request.action === "stop" || !ownedControl(session, request.id)) continue;
      const state = readControlState(session.feedDir, request.id);
      if (state && ["failed", "unknown", "cancelled"].includes(state.state)) continue;
      const turn = controlTurns.get(request.id) ?? null;
      if (turn && endedTurns.has(turn)) continue;
      session.forwarded.set(request.id, { reported: state?.state ?? null, remoteTurn: turn });
    }
  }
  session.hydrated = true;
}

/** Move the copy forward as far as the feed and the waiting prompts allow. */
export function pump(session: Session, now = Date.now()): void {
  const out: ThreadDelta[] = [];
  const reader = ensureReader(session);
  if (reader !== null) { reader.poll(); hydrateSession(session, reader); }
  const records: FeedRecord[] = reader?.records ?? [];

  for (;;) {
    const record = records[session.cursor];
    if (record === undefined) break;
    if (record.t === "header") {
      session.machine = record.machine;
      session.owner = { serverId: record.serverId, remoteThreadId: record.remoteThreadId };
      session.replayToken = record.control?.v === 1 ? record.control.replayToken : null;
      session.cursor += 1;
      continue;
    }
    if (record.t === "control") {
      if (record.v === 1) session.replayToken = record.replayToken;
      session.cursor += 1;
      continue;
    }
    if (record.t === "turn") {
      const forwarded = record.user?.controlId ? ownedControl(session, record.user.controlId) : null;
      if (forwarded !== null) {
        session.ownerTurn = record.turn;
        if (session.open?.kind === "forward" && session.open.remoteTurn === null) {
          session.open.remoteTurn = record.turn;
        } else {
          if (session.open !== null) closeOpen(session, out, "completed");
          out.push({ kind: "turn.open" });
          session.open = { kind: "forward", remoteTurn: record.turn };
        }
        const pending = session.forwarded.get(forwarded.id);
        if (pending) pending.remoteTurn = record.turn;
        session.cursor += 1;
        session.waitSince = null;
        continue;
      }
      if (session.open?.kind === "forward" && session.open.remoteTurn === null) {
        // This local turn only waits for our command's owner echo. Holding it open
        // prevents Fleet from sending the earlier owner's replay and deadlocks both.
        // Settle the placeholder while retaining its outbox and forwarded identity;
        // do not consume the earlier turn until its explicit replay arrives.
        out.push(message("Your message is waiting for its owner turn to appear. An earlier owner turn will be shown first."));
        closeOpen(session, out, "completed");
      } else if (session.open !== null && session.open.kind !== "forward") closeOpen(session, out, "completed");
      if (record.user === null) {
        session.ownerTurn = record.turn;
        out.push({ kind: "turn.open" });
        session.open = { kind: "self", remoteTurn: record.turn };
        session.cursor += 1;
        session.waitSince = null;
        continue;
      }
      const start = takeMatch(session, session.starts, record.user) ?? takeMatch(session, session.steers, record.user);
      if (start !== null) {
        session.ownerTurn = record.turn;
        if (session.open !== null) closeOpen(session, out, "completed");
        out.push(...accepted(start), { kind: "turn.open" });
        session.open = { kind: "mirror", remoteTurn: record.turn };
        session.cursor += 1;
        session.waitSince = null;
        continue;
      }
      break; // Fleet sends it once the copy is idle
    }
    if (record.t === "steer") {
      const forwarded = record.user.controlId ? ownedControl(session, record.user.controlId) : null;
      if (forwarded !== null) {
        session.ownerTurn = record.turn;
        const pending = session.forwarded.get(forwarded.id);
        if (pending) pending.remoteTurn = record.turn;
        session.cursor += 1;
        session.waitSince = null;
        continue;
      }
      const pool = session.open === null ? session.starts : session.steers;
      const match = takeMatch(session, pool, record.user);
      if (match !== null) {
        session.ownerTurn = record.turn;
        out.push(...accepted(match));
        if (session.open === null) {
          out.push({ kind: "turn.open" });
          session.open = { kind: "mirror", remoteTurn: record.turn };
        }
        session.cursor += 1;
        session.waitSince = null;
        continue;
      }
      session.waitSince ??= now;
      if (now - session.waitSince < STEER_WAIT_MS) break;
      session.cursor += 1; // never sent: carry on without its bubble
      session.waitSince = null;
      continue;
    }
    if (record.t === "item") {
      if (session.open === null && !isThreadScopedItem(record.close.item)) {
        if (record.turn) session.ownerTurn = record.turn;
        out.push({ kind: "turn.open" });
        session.open = { kind: "self", remoteTurn: record.turn };
      }
      out.push(itemDelta(session, record));
      session.emitted.add(record.id);
      session.cursor += 1;
      continue;
    }
    if (record.t === "end") {
      if (session.ownerTurn === record.turn) session.ownerTurn = null;
      closeOpen(session, out, record.status, record.error);
      for (const [id, pending] of session.forwarded) if (pending.remoteTurn === record.turn) session.forwarded.delete(id);
      session.cursor += 1;
      continue;
    }
    if (record.t === "note") {
      if (session.open === null) out.push({ kind: "turn.open" }, message(record.text), { kind: "turn.boundary", status: "completed" });
      else out.push(message(record.text));
      session.cursor += 1;
      continue;
    }
    if (record.t === "interaction-end") {
      session.endedInteractions.add(record.id);
      session.cursor += 1;
      continue;
    }
    if (record.t === "interaction") {
      // An owner end already further down the feed (a copy that starts after the owner
      // answered) means there is nothing left to ask: never raise a prompt only to strand it.
      if (records.some((later, index) => index > session.cursor && later.t === "interaction-end" && later.id === record.id)) session.endedInteractions.add(record.id);
      if (record.detail !== null && session.owner !== null && session.feedDir !== null && session.replayToken !== null && !session.raised.has(record.id) && !session.endedInteractions.has(record.id)) {
        if (session.open === null) {
          if (record.turn) session.ownerTurn = record.turn;
          out.push({ kind: "turn.open" });
          session.open = { kind: "self", remoteTurn: record.turn };
        }
        emit(session.threadId, out.splice(0));
        raiseInteraction(session, record.id, record.kind, record.detail);
      }
      session.cursor += 1;
      continue;
    }
    session.cursor += 1; // a record kind from a newer Fleet
  }

  pollControlResults(session, out);
  pollAnswerResults(session, out);

  // Explicit replay references are separate from user input; never reflect a replay back to its owner.
  const next = records[session.cursor];
  const feedReady = session.feedDir === null || (reader !== null && session.hydrated);
  if (session.open === null) {
    const waitingForFeed = session.feedDir !== null && (reader === null || !session.hydrated);
    for (const start of [...session.starts]) {
      if (waitingForFeed && now - start.at < FEED_WAIT_MS) continue;
      if (feedReady && next?.t === "turn" && next.user !== null && (session.replayToken === null ? sameText(next.user.text, start.text) : start.replay?.token === session.replayToken && start.replay.requestId === next.user.requestId)) continue;
      if (start.replay !== null && start.replay.token === session.replayToken) continue;
      session.starts.splice(session.starts.indexOf(start), 1);
      out.push(...forwardOrWatch(session, start, "send"));
    }
  } else {
    for (const steer of [...session.steers]) {
      if (next?.t === "steer" && (session.replayToken === null ? sameText(next.user.text, steer.text) : steer.replay?.token === session.replayToken && steer.replay.requestId === next.user.requestId)) continue;
      if (steer.replay !== null && steer.replay.token === session.replayToken) continue;
      session.steers.splice(session.steers.indexOf(steer), 1);
      out.push(...forwardOrWatch(session, steer, "steer"));
    }
  }

  emit(session.threadId, out);
  if (session.feedDir !== null && session.cursor !== session.savedCursor) {
    try {
      writeCursor(cursorPath(session.feedDir, session.threadId), session.cursor);
      session.savedCursor = session.cursor;
    } catch {
      // the next pump writes it again
    }
  }
}


function ownedControl(session: Session, id: string): MirrorControlRequest | null {
  if (session.feedDir === null || session.owner === null) return null;
  const request = readControl(session.feedDir, id);
  return request?.localThreadId === session.threadId && request.targetServer === session.owner.serverId && request.remoteThreadId === session.owner.remoteThreadId ? request : null;
}

function forwardOrWatch(session: Session, waiting: Waiting, action: "send" | "steer"): ThreadDelta[] {
  if (session.replayToken === null || session.owner === null || session.feedDir === null) {
    return action === "send" ? watchOnlyTurn(session, waiting) : [...accepted(waiting), message(watchOnlyLine(session.machine))];
  }
  const fail = (text: string) => {
    const out = [...accepted(waiting)];
    if (session.open === null) out.push({ kind: "turn.open" });
    out.push(message(text));
    if (session.open === null) out.push({ kind: "turn.boundary", status: "failed", error: { message: text } });
    return out;
  };
  if (waiting.replay !== null) return fail("This replay reference does not belong to this Fleet copy; it was not sent to the owner.");
  const attachments: MirrorAttachment[] = [];
  for (const part of visibleMirrorInput(waiting.input)) {
    if (part.type === "text") continue;
    if ((part.type === "localImage" || part.type === "localFile") && typeof part.sourceProjectId === "string" && part.sourceProjectId.length > 0) {
      attachments.push({ type: part.type, path: part.path, sourceProjectId: part.sourceProjectId, name: part.type === "localFile" && part.name ? part.name : part.path.split("/").at(-1) ?? "attachment", sizeBytes: part.type === "localFile" ? part.sizeBytes ?? null : null, mimeType: part.type === "localFile" ? part.mimeType ?? null : null });
      continue;
    }
    return fail("Only attachments stored in this project can be sent to the owning Mac. This input was not sent.");
  }
  if (attachments.length > MAX_MIRROR_ATTACHMENTS) return fail(`At most ${MAX_MIRROR_ATTACHMENTS} attachments can be sent to the owning Mac at once. This input was not sent.`);
  if (attachments.length > 0 && action !== "send") return fail("Attachments can be sent with a new message, not with a steer. This input was not sent.");
  if (waiting.clientRequestId === null) return fail("A writable mirror requires a request identity; this input was not sent.");
  const id = controlId(session.threadId, waiting.clientRequestId, action);
  const expectedRemoteTurnId = session.open?.remoteTurn ?? session.ownerTurn;
  try {
    writeControl(session.feedDir, {
      v: 1, id, localThreadId: session.threadId, targetServer: session.owner.serverId,
      remoteThreadId: session.owner.remoteThreadId, action, text: waiting.text, createdAt: waiting.at,
      ...(expectedRemoteTurnId ? { expectedRemoteTurnId } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
  } catch (cause) {
    return fail(`Could not save this message for the owner: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  session.forwarded.set(id, { reported: null, remoteTurn: null });
  const out = accepted(waiting);
  if (session.open === null) {
    out.push({ kind: "turn.open" });
    session.open = { kind: "forward", remoteTurn: null };
  }
  return out;
}

/** Show the owner's question or approval as this copy's own native prompt (core interaction/request). */
function raiseInteraction(session: Session, interactionId: string, kind: "approval" | "user_question", detail: { payload: Record<string, unknown>; fingerprint: string }): void {
  const requestId = interactionRequestId(interactionId);
  session.raised.add(interactionId);
  raisedRequests.set(requestId, { threadId: session.threadId, interactionId, fingerprint: detail.fingerprint, kind });
  io.send({ jsonrpc: "2.0", id: requestId, method: BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, params: { providerThreadId: session.providerThreadId, threadId: session.threadId, turnId: null, payload: detail.payload } });
}

/** The owner already ended this interaction: seen by pump, or already further down the feed (the copy settling its own prompt). */
function ownerEnded(session: Session, interactionId: string): boolean {
  if (session.endedInteractions.has(interactionId)) return true;
  const reader = ensureReader(session);
  if (reader === null) return false;
  reader.poll();
  return reader.records.some((record) => record.t === "interaction-end" && record.id === interactionId);
}

/** core answered a native prompt: save the answer as a durable owner control; a cancelled or failed prompt sends nothing. */
export function handleInteractionResponse(requestId: string, response: { result?: unknown; error?: unknown }): void {
  const raised = raisedRequests.get(requestId);
  if (!raised) return;
  raisedRequests.delete(requestId);
  const session = sessions.get(raised.threadId);
  if (!session || session.feedDir === null || session.owner === null || session.replayToken === null || response.error !== undefined) return;
  const answer = interactionResponseFrom(raised.kind, response.result);
  if (answer === null || ownerEnded(session, raised.interactionId)) return;
  const id = controlId(session.threadId, `ix:${raised.interactionId}`, "respond");
  try {
    writeControl(session.feedDir, {
      v: 1, id, localThreadId: session.threadId, targetServer: session.owner.serverId, remoteThreadId: session.owner.remoteThreadId,
      action: "respond", text: "", createdAt: Date.now(),
      interaction: { interactionId: raised.interactionId, fingerprint: raised.fingerprint, response: answer },
    });
  } catch {
    return;
  }
  session.answers.set(id, { reported: null });
}

function pollAnswerResults(session: Session, out: ThreadDelta[]): void {
  if (session.feedDir === null) return;
  for (const [id, pending] of session.answers) {
    const result = readControlState(session.feedDir, id);
    if (!result || pending.reported === result.state) continue;
    pending.reported = result.state;
    if (result.state === "sent" || result.state === "accepted" || result.state === "queued") { session.answers.delete(id); continue; }
    const text = result.state === "unavailable"
      ? `The ${session.machine ?? "owner"} connection is unavailable. Your answer is saved here and will be sent when the route recovers.`
      : result.state === "unknown"
        ? `The ${session.machine ?? "owner"} may have received your answer. Check that chat; it will not be sent again automatically.`
        : result.message ?? `Your answer was not applied on ${session.machine ?? "the owner"}; it may have been answered there already.`;
    if (session.open === null) out.push({ kind: "turn.open" }, message(text), { kind: "turn.boundary", status: "completed" });
    else out.push(message(text));
    if (result.state !== "unavailable") session.answers.delete(id);
  }
}

function pollControlResults(session: Session, out: ThreadDelta[]): void {
  if (session.feedDir === null) return;
  for (const [id, pending] of session.forwarded) {
    const result = readControlState(session.feedDir, id);
    if (!result || pending.reported === result.state) continue;
    pending.reported = result.state;
    if (result.state === "unavailable") {
      out.push(message(`The ${session.machine ?? "owner"} connection is unavailable. Your message is saved here and will retry when the route recovers.`));
    } else if (["unknown", "failed", "cancelled"].includes(result.state)) {
      const text = result.message ?? (result.state === "unknown" ? "The owner may have received this message. Check that chat before retrying; it will not be sent again automatically." : "This message was not delivered to the owner.");
      if (session.open === null) out.push({ kind: "turn.open" });
      out.push(message(text));
      if (session.open?.kind === "forward" && session.open.remoteTurn === null) closeOpen(session, out, result.state === "cancelled" ? "interrupted" : "failed", text);
      else if (session.open === null) out.push({ kind: "turn.boundary", status: "failed", error: { message: text } });
      session.forwarded.delete(id);
    }
  }
}

function enqueueStop(session: Session): void {
  if (session.feedDir === null || session.owner === null || session.replayToken === null) return;
  const cancelRequestIds: string[] = [];
  for (const [id] of session.forwarded) {
    const state = readControlState(session.feedDir, id);
    if (!state || state.state === "pending" || state.state === "unavailable") {
      if (!cancelPendingControl(session.feedDir, id)) cancelRequestIds.push(id);
    } else cancelRequestIds.push(id);
  }
  const turn = session.open?.remoteTurn ?? session.ownerTurn;
  if (!turn && cancelRequestIds.length === 0) return;
  // Mint once for this explicit native interrupt. The persisted outbox keeps
  // that identity for retries; another user press must be able to try again.
  const id = controlId(session.threadId, `stop:${randomUUID()}`, "stop");
  writeControl(session.feedDir, {
    v: 1, id, localThreadId: session.threadId, targetServer: session.owner.serverId, remoteThreadId: session.owner.remoteThreadId,
    action: "stop", text: "", createdAt: Date.now(), ...(turn ? { expectedRemoteTurnId: turn } : {}),
    ...(cancelRequestIds.length ? { cancelRequestIds } : {}),
  });
}

function pumpAll(): void {
  for (const session of sessions.values()) {
    try {
      pump(session);
    } catch {
      // one copy's bad feed must not stall the others
    }
  }
}

function openSession(args: { threadId: string; providerThreadId: string; options: unknown }): Session {
  const feedDir = feedDirOf(args.options);
  const cursor = feedDir === null ? 0 : readCursor(cursorPath(feedDir, args.threadId));
  const session: Session = {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    feedDir,
    reader: null,
    cursor,
    savedCursor: cursor,
    machine: null,
    owner: null,
    ownerTurn: null,
    replayToken: null,
    hydrated: feedDir === null,
    forwarded: new Map(),
    raised: new Set(),
    endedInteractions: new Set(),
    answers: new Map(),
    open: null,
    starts: [],
    steers: [],
    waitSince: null,
    emitted: new Set(),
  };
  const reader = ensureReader(session);
  if (reader !== null) hydrateSession(session, reader);
  sessions.set(args.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId: args.threadId, providerThreadId: args.providerThreadId });
  emit(args.threadId, [{ kind: "session.reset" }]);
  return session;
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({ jsonrpc: "2.0", id, error: { code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, message: `Invalid params for ${method}`, data: issues } });
}

function textOf(input: readonly PromptInput[]): string {
  return promptText(visibleMirrorInput(input) as ReadonlyArray<{ type: string; text?: unknown; path?: unknown; name?: unknown }>);
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "provider",
        steerMode: "inject",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
    io.sendResult(id, { models: [{ ...MIRROR_MODEL, model: MIRROR_MODEL_ID }], selectedOnlyModels: [] });
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.providerHealth, parsed.error.issues);
    io.sendResult(id, MIRROR_HEALTH);
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
    // Durable and unique per bb thread, never a per-process counter.
    const providerThreadId = `mirror_${parsed.data.threadId}`;
    const session = openSession({ threadId: parsed.data.threadId, providerThreadId, options: parsed.data.options });
    io.sendResult(id, { providerThreadId, sessionRestorable: true });
    const input = parsed.data.input;
    if (input !== undefined && input.length > 0) {
      session.starts.push({ clientRequestId: null, text: textOf(input), at: Date.now(), input, replay: replayReference(input) });
      pump(session);
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
    openSession({ threadId: parsed.data.threadId, providerThreadId: parsed.data.providerThreadId, options: parsed.data.options });
    io.sendResult(id, { providerThreadId: parsed.data.providerThreadId, sessionRestorable: true });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`);
      return;
    }
    const feedDir = feedDirOf(parsed.data.options);
    if (feedDir !== null && session.feedDir === null) session.feedDir = feedDir;
    io.sendResult(id, {});
    session.starts.push({ clientRequestId: parsed.data.clientRequestId, text: textOf(parsed.data.input), at: Date.now(), input: parsed.data.input, replay: replayReference(parsed.data.input) });
    pump(session);
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined || session.open === null) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, `No active turn to steer (expected ${parsed.data.expectedTurnId})`);
      return;
    }
    io.sendResult(id, {});
    session.steers.push({ clientRequestId: parsed.data.clientRequestId, text: textOf(parsed.data.input), at: Date.now(), input: parsed.data.input, replay: replayReference(parsed.data.input) });
    pump(session);
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
    const session = sessions.get(parsed.data.threadId);
    if (session !== undefined) {
      const out: ThreadDelta[] = [];
      if (parsed.data.intent === "interrupt") {
        enqueueStop(session);
        closeOpen(session, out, "interrupted");
      }
      for (const start of session.starts) if (start.replay === null) out.push(...accepted(start), { kind: "turn.open" }, { kind: "turn.boundary", status: "interrupted" });
      session.starts = [];
      emit(session.threadId, out);
      if (session.feedDir !== null && session.cursor !== session.savedCursor) {
        try {
          writeCursor(cursorPath(session.feedDir, session.threadId), session.cursor);
        } catch {
          // best effort
        }
      }
    }
    // After thread/stop the bridge holds nothing for the thread.
    sessions.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },
};

export function handleLine(line: string): void {
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsedLine !== "object" || parsedLine === null || Array.isArray(parsedLine)) return;
  const { id, method, params } = parsedLine as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== "string") {
    if (typeof id === "string" && id.startsWith("fleet-ix:")) handleInteractionResponse(id, parsedLine as { result?: unknown; error?: unknown });
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") return; // a notification
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start() {
    pumpTimer = setInterval(pumpAll, PUMP_EVERY_MS);
    pumpTimer.unref();
  },
  onClose() {
    if (pumpTimer !== null) clearInterval(pumpTimer);
  },
  // A SIGTERM listener replaces Node's default exit, so exit explicitly.
  onSigterm() {
    for (const session of sessions.values()) {
      if (session.feedDir === null || session.cursor === session.savedCursor) continue;
      try {
        writeCursor(cursorPath(session.feedDir, session.threadId), session.cursor);
      } catch {
        // best effort
      }
    }
    process.exit(0);
  },
});

/** Test seam: drop every session (vitest runs the bridge in-process). */
export function resetBridgeForTests(): void {
  sessions.clear();
  counter = 0;
}

export function sessionForTests(threadId: string): Session | undefined {
  return sessions.get(threadId);
}

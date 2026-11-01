import { controlReference, visibleMirrorInput } from "./control";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
// Fleet mirror, publisher side and pure: a thread's stored events (as
// bb.sdk.threads.events.list returns them) become mirror records, each item
// already in the provider-delta shape the copy's bridge sends back to bb.
import {
  ITEM_OUTPUT_MAX_BYTES,
  REPLAY_TURNS,
  promptText,
  type ItemStatus,
  type MirrorClose,
  type MirrorRecord,
  type MirrorUser,
  type TurnStatus,
} from "./protocol";

/** The slice of a stored event the mapper reads. */
export interface StoredEvent {
  seq: number;
  type: string;
  createdAt: number;
  scope?: { kind: string; turnId?: string } | null;
  data?: Record<string, unknown> | null;
}

export interface MapperState {
  /** client/turn/requested by request id: the text a turn or steer was opened with. */
  requests: Map<string, MirrorUser>;
  /** A turn/started whose first event has not been seen yet. */
  pendingTurn: string | null;
  /** The remote turn that is open, for thread-scoped items. */
  currentTurn: string | null;
}

export function newMapperState(): MapperState {
  return { requests: new Map(), pendingTurn: null, currentTurn: null };
}

const CUT_NOTE = "\n\n[cut to 32 KB by the Fleet mirror]";

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Cut text to at most `max` UTF-8 bytes (marker included) without splitting a character. */
export function capText(text: string, max = ITEM_OUTPUT_MAX_BYTES): string {
  if (utf8Bytes(text) <= max) return text;
  const budget = Math.max(0, max - utf8Bytes(CUT_NOTE));
  const bytes = Buffer.from(text, "utf8");
  let cut = budget;
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString("utf8") + CUT_NOTE;
}

/** A JSON value cut to `max` bytes: kept as is when small, else its JSON text, cut. */
export function capJson(value: unknown, max = ITEM_OUTPUT_MAX_BYTES): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return capText(value, max);
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return "[not serialisable]";
  }
  if (json === undefined) return undefined;
  return utf8Bytes(json) <= max ? value : capText(json, max);
}

const STATUSES: ItemStatus[] = ["completed", "failed", "interrupted", "pending"];

function itemStatus(value: unknown): ItemStatus {
  const status = typeof value === "string" && (STATUSES as string[]).includes(value) ? (value as ItemStatus) : "completed";
  // A finished item that still says pending would leave a spinner in the copy.
  return status === "pending" ? "completed" : status;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown, max = ITEM_OUTPUT_MAX_BYTES): string[] {
  if (!Array.isArray(value)) return [];
  let left = max;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const cut = capText(v, Math.max(256, left));
    out.push(cut);
    left -= utf8Bytes(cut);
    if (left <= 0) break;
  }
  return out;
}

/**
 * Presentation as the remote stored it. A glyph another plugin declared
 * ("<pluginId>/<name>") would be refused here, so it falls back to a host glyph.
 */
function presentationOf(value: unknown, fallbackGlyph: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const label = p.label as { pending?: unknown; completed?: unknown } | undefined;
  if (!label || typeof label.pending !== "string" || typeof label.completed !== "string") return undefined;
  const glyph = (p.icon as { glyph?: unknown } | undefined)?.glyph;
  const out: Record<string, unknown> = {
    label: { pending: label.pending, completed: label.completed },
    icon: { glyph: typeof glyph === "string" && !glyph.includes("/") ? glyph : fallbackGlyph },
  };
  if (typeof p.title === "string") out.title = capText(p.title, 2000);
  if (typeof p.detail === "string") out.detail = p.detail.slice(0, 280);
  if (typeof p.suppress === "boolean") out.suppress = p.suppress;
  const tint = p.tint as { light?: unknown; dark?: unknown } | undefined;
  if (tint && typeof tint.light === "string" && typeof tint.dark === "string") out.tint = { light: tint.light, dark: tint.dark };
  return out;
}

/** One stored item as the item.close the copy's bridge sends, or null for kinds a copy does not show. */
export function mapItem(raw: Record<string, unknown>): MirrorClose | null {
  const type = str(raw.type);
  const status = itemStatus(raw.status);
  switch (type) {
    case "commandExecution": {
      const output = str(raw.aggregatedOutput);
      const capped = output === undefined ? undefined : capText(output);
      const exitCode = num(raw.exitCode);
      const item: Record<string, unknown> & { type: string } = { type: "command", command: capText(str(raw.command) ?? "", 8 * 1024), cwd: str(raw.cwd) ?? "" };
      if (capped !== undefined) item.aggregatedOutput = capped;
      if (exitCode !== undefined) item.exitCode = exitCode;
      const durationMs = num(raw.durationMs);
      if (durationMs !== undefined) item.durationMs = durationMs;
      return {
        status,
        item,
        presentation: presentationOf(raw.presentation, "Terminal"),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(capped !== undefined ? { aggregatedOutput: capped } : {}),
      };
    }
    case "fileChange": {
      const changes = Array.isArray(raw.changes) ? (raw.changes as Record<string, unknown>[]) : [];
      let left = ITEM_OUTPUT_MAX_BYTES;
      const mapped = changes
        .filter((c) => typeof c?.path === "string")
        .map((c) => {
          const kind = c.kind === "add" || c.kind === "delete" || c.kind === "update" ? c.kind : "update";
          const out: Record<string, unknown> = { path: c.path, kind };
          if (typeof c.movePath === "string") out.movePath = c.movePath;
          if (typeof c.diff === "string" && left > 0) {
            const diff = capText(c.diff, Math.max(512, left));
            left -= utf8Bytes(diff);
            out.diff = diff;
          }
          return out;
        });
      const error = str(raw.error);
      return {
        status,
        item: { type: "fileChange", changes: mapped },
        presentation: presentationOf(raw.presentation, "EditFile"),
        ...(error ? { resultText: capText(error, 4096) } : {}),
      };
    }
    case "toolCall": {
      const item: Record<string, unknown> & { type: string } = { type: "tool", tool: str(raw.tool) ?? "tool" };
      if (typeof raw.server === "string") item.server = raw.server;
      if (raw.arguments !== undefined) item.args = capJson(raw.arguments, 8 * 1024);
      if (raw.result !== undefined) item.result = capJson(raw.result);
      const error = str(raw.error);
      if (error !== undefined) item.error = capText(error, 4096);
      const durationMs = num(raw.durationMs);
      if (durationMs !== undefined) item.durationMs = durationMs;
      return { status, item, presentation: presentationOf(raw.presentation, "Toolbox") };
    }
    case "agentMessage":
      return { status: "completed", item: { type: "agentMessage", text: capText(str(raw.text) ?? "", 128 * 1024) } };
    case "reasoning":
      return { status: "completed", item: { type: "reasoning", content: strings(raw.content), summary: strings(raw.summary, 8 * 1024) } };
    case "plan":
      return { status, item: { type: "plan", text: capText(str(raw.text) ?? "") } };
    case "webSearch":
      return { status, item: { type: "webSearch", queries: strings(raw.queries, 4096) }, presentation: presentationOf(raw.presentation, "Globe") };
    case "webFetch": {
      const url = str(raw.url);
      if (url === undefined) return null;
      return {
        status,
        item: { type: "webFetch", url, pattern: str(raw.pattern) ?? null, prompt: str(raw.prompt) ?? null },
        presentation: presentationOf(raw.presentation, "Globe"),
      };
    }
    case "imageView": {
      const path = str(raw.path);
      if (path === undefined) return null;
      return { status, item: { type: "imageView", path }, presentation: presentationOf(raw.presentation, "Image") };
    }
    case "imageGeneration":
      return {
        status,
        item: {
          type: "imageGeneration",
          prompt: str(raw.prompt) ?? null,
          path: str(raw.path) ?? null,
          error: str(raw.error) ?? null,
          transparentBackground: raw.transparentBackground === true,
        },
        presentation: presentationOf(raw.presentation, "Image"),
      };
    case "fileRead": {
      const path = str(raw.path);
      if (path === undefined) return null;
      const item: Record<string, unknown> & { type: string } = { type: "fileRead", path };
      if (typeof raw.cmd === "string") item.cmd = capText(raw.cmd, 4096);
      return { status, item, presentation: presentationOf(raw.presentation, "FileText") };
    }
    case "search": {
      const mode = raw.mode === "content" || raw.mode === "list" || raw.mode === "path" ? raw.mode : "content";
      const item: Record<string, unknown> & { type: string } = { type: "search", mode, query: capText(str(raw.query) ?? "", 4096) };
      if (typeof raw.path === "string") item.path = raw.path;
      if (typeof raw.cmd === "string") item.cmd = capText(raw.cmd, 4096);
      return { status, item, presentation: presentationOf(raw.presentation, "Search") };
    }
    case "delegation": {
      const childRef = str(raw.childRef);
      if (childRef === undefined) return null;
      const item: Record<string, unknown> & { type: string } = {
        type: "delegation",
        childRef,
        label: capText(str(raw.label) ?? "Sub-agent", 1024),
        background: raw.background === true,
      };
      if (typeof raw.summary === "string") item.summary = capText(raw.summary, 8 * 1024);
      return { status, item, presentation: presentationOf(raw.presentation, "UserRound") };
    }
    case "planSteps": {
      const steps = Array.isArray(raw.steps)
        ? (raw.steps as Record<string, unknown>[])
            .filter((s) => typeof s?.step === "string")
            .map((s) => {
              const out: Record<string, unknown> = { step: capText(String(s.step), 2048) };
              if (s.status === "active" || s.status === "completed" || s.status === "failed" || s.status === "pending") out.status = s.status;
              return out;
            })
        : [];
      const item: Record<string, unknown> & { type: string } = { type: "planSteps", steps };
      if (typeof raw.explanation === "string") item.explanation = capText(raw.explanation, 8 * 1024);
      return { status, item, presentation: presentationOf(raw.presentation, "ListChecks") };
    }
    case "backgroundTask": {
      const taskStatuses = ["completed", "failed", "killed", "paused", "pending", "running", "stopped"];
      const item: Record<string, unknown> & { type: string } = {
        type: "backgroundTask",
        description: capText(str(raw.description) ?? "Background task", 2048),
        familyId: str(raw.familyId) ?? str(raw.id) ?? "task",
        skipTranscript: raw.skipTranscript === true,
        status,
        taskStatus: typeof raw.taskStatus === "string" && taskStatuses.includes(raw.taskStatus) ? raw.taskStatus : "completed",
        taskType: str(raw.taskType) ?? "task",
      };
      if (typeof raw.foreground === "boolean") item.foreground = raw.foreground;
      if (typeof raw.summary === "string") item.summary = capText(raw.summary, 8 * 1024);
      if (typeof raw.error === "string") item.error = capText(raw.error, 4096);
      if (typeof raw.workflowName === "string") item.workflowName = raw.workflowName;
      return { status, item, presentation: presentationOf(raw.presentation, "Terminal") };
    }
    case "contextCompaction":
      return { status: "completed", item: { type: "compaction" } };
    default:
      // userMessage, extension kinds and anything newer stay on the remote machine.
      return null;
  }
}

function turnOf(event: StoredEvent): string | null {
  return event.scope?.kind === "turn" && typeof event.scope.turnId === "string" ? event.scope.turnId : null;
}

/** Request ids accepted in `events` whose text the mapper does not know yet. */
export function missingRequestIds(events: readonly StoredEvent[], state: MapperState): string[] {
  const known = new Set(state.requests.keys());
  for (const e of events) {
    if (e.type === "client/turn/requested" && typeof e.data?.requestId === "string") known.add(e.data.requestId);
  }
  const missing = new Set<string>();
  for (const e of events) {
    const id = e.type === "turn/input/accepted" ? e.data?.clientRequestId : undefined;
    if (typeof id === "string" && !known.has(id)) missing.add(id);
  }
  return [...missing];
}

/** Remember a request's text (from client/turn/requested data), keeping the map small. */
export function rememberRequest(state: MapperState, data: Record<string, unknown> | null | undefined): void {
  const id = data?.requestId;
  if (typeof id !== "string") return;
  const input = Array.isArray(data?.input) ? (data.input as { type: string }[]) : [];
  const controlId = controlReference(input as PromptInput[]);
  state.requests.set(id, { requestId: id, text: promptText(visibleMirrorInput(input as PromptInput[])) || "(no text)", ...(controlId ? { controlId } : {}) });
  if (state.requests.size > 400) {
    const oldest = state.requests.keys().next().value;
    if (oldest !== undefined) state.requests.delete(oldest);
  }
}

/** A trailing turn/started this recent waits for its first event before it is published. */
const PENDING_TURN_GRACE_MS = 60_000;

export interface MapResult {
  records: MirrorRecord[];
  /** The last event processed (the publisher's next afterSeq), or null when none was. */
  lastSeq: number | null;
}

/**
 * Map events (ascending seq) to records, stopping once the records reach
 * `maxBytes` of JSON (a single event never splits). A turn/started at the
 * very end, with nothing of its turn after it yet, is held back so the next
 * cycle can tell a user's turn from one the agent opened itself.
 */
export function mapEvents(events: readonly StoredEvent[], state: MapperState, options: { now?: number; maxBytes?: number } = {}): MapResult {
  const now = options.now ?? Date.now();
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  let usable = events.length;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type !== "turn/started") continue;
    const turn = turnOf(e);
    const followed = events.slice(i + 1).some((x) => turnOf(x) === turn);
    if (!followed && now - e.createdAt < PENDING_TURN_GRACE_MS) usable = i;
    break;
  }
  const records: MirrorRecord[] = [];
  let size = 0;
  let lastSeq: number | null = null;
  const openPending = (into: MirrorRecord[]) => {
    if (state.pendingTurn === null) return;
    into.push({ t: "turn", turn: state.pendingTurn, user: null });
    state.currentTurn = state.pendingTurn;
    state.pendingTurn = null;
  };
  for (const e of events.slice(0, usable)) {
    if (lastSeq !== null && size >= maxBytes) break;
    const out: MirrorRecord[] = [];
    const turn = turnOf(e);
    switch (e.type) {
      case "client/turn/requested":
        rememberRequest(state, e.data);
        break;
      case "turn/started":
        // A turn the agent opened that produced nothing is dropped, not mirrored empty.
        state.pendingTurn = turn;
        break;
      case "turn/input/accepted": {
        const id = e.data?.clientRequestId;
        if (typeof id !== "string" || turn === null) break;
        const user = state.requests.get(id) ?? { requestId: id, text: "(message not available)" };
        if (state.pendingTurn === turn) {
          out.push({ t: "turn", turn, user });
          state.currentTurn = turn;
          state.pendingTurn = null;
        } else {
          out.push({ t: "steer", turn, user });
        }
        break;
      }
      case "item/completed":
      case "item/backgroundTask/completed":
      case "item/delegation/completed": {
        const raw = e.data?.item;
        if (raw === null || typeof raw !== "object") break;
        const item = raw as Record<string, unknown>;
        const close = mapItem(item);
        if (close === null || typeof item.id !== "string") break;
        if (turn !== null && state.pendingTurn === turn) openPending(out);
        const parent = typeof item.parentToolCallId === "string" ? item.parentToolCallId : undefined;
        out.push({ t: "item", turn: turn ?? state.currentTurn, id: item.id, ...(parent ? { parent } : {}), close });
        break;
      }
      case "system/interaction/lifecycle": {
        const interaction = e.data?.interaction as { id?: unknown; status?: unknown; origin?: { kind?: unknown }; payload?: { kind?: unknown }; resolution?: unknown } | undefined;
        if (typeof interaction?.id !== "string" || interaction.origin?.kind !== "provider") break;
        const kind = interaction.payload?.kind;
        if (kind !== "approval" && kind !== "user_question") break;
        if (interaction.status === "pending") {
          if (turn !== null && state.pendingTurn === turn) openPending(out);
          out.push({ t: "interaction", turn: turn ?? state.currentTurn, id: interaction.id, kind, detail: null });
        } else if (interaction.status === "resolved" || interaction.status === "interrupted") {
          const resolution = interaction.resolution;
          const carried = interaction.status === "resolved" && resolution !== null && typeof resolution === "object" && !Array.isArray(resolution) && Buffer.byteLength(JSON.stringify(resolution)) <= 64_000;
          out.push({ t: "interaction-end", id: interaction.id, status: interaction.status, ...(carried ? { resolution: resolution as Record<string, unknown> } : {}) });
        }
        break;
      }
      case "turn/completed": {
        if (turn === null) break;
        if (state.pendingTurn === turn) {
          state.pendingTurn = null; // an empty agent-opened turn: nothing to show
          break;
        }
        const status: TurnStatus = e.data?.status === "failed" || e.data?.status === "interrupted" ? e.data.status : "completed";
        const error = (e.data?.error as { message?: unknown } | undefined)?.message;
        out.push({ t: "end", turn, status, ...(typeof error === "string" ? { error: capText(error, 2048) } : {}) });
        if (state.currentTurn === turn) state.currentTurn = null;
        break;
      }
      default:
        break;
    }
    for (const r of out) {
      records.push(r);
      size += utf8Bytes(JSON.stringify(r));
    }
    lastSeq = e.seq;
  }
  return { records, lastSeq };
}

/**
 * Where the replay of a newly watched chat starts: just before the request
 * that opened the REPLAY_TURNS-th last turn (steers do not count). `requests`
 * is the chat's client/turn/requested events, newest first.
 */
export function replayStart(requests: readonly StoredEvent[], turns = REPLAY_TURNS): { afterSeq: number; earlier: boolean } {
  const opening = requests.filter((e) => {
    const kind = (e.data?.target as { kind?: unknown } | undefined)?.kind;
    return kind !== "steer";
  });
  if (opening.length <= turns) return { afterSeq: 0, earlier: false };
  const first = opening[turns - 1]!;
  return { afterSeq: Math.max(0, first.seq - 1), earlier: true };
}

/** Retention: a watch stays live while its chat runs, and for 7 days after it was last opened. */
export const WATCH_TTL_MS = 7 * 24 * 3600_000;
export const EVENT_TTL_MS = 7 * 24 * 3600_000;

export function watchLive(input: { openedAt: number; running: boolean; now: number }): boolean {
  return input.running || input.now - input.openedAt <= WATCH_TTL_MS;
}

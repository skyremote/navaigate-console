// Fleet mirror: what crosses the brain (sealed) and what Fleet's server hands
// to the fleet-mirror provider bridge on this Mac (the feed file). Shared by
// the publisher, the reader and the bridge; no I/O here.
//
// A mirrored chat is replayed into a hidden local copy, turn by turn:
// - "turn"  a remote turn starts; `user` is the message that opened it, or
//           null when the agent opened it itself (a background task finished).
// - "steer" a user message the remote turn took in while it ran.
// - "item"  one finished remote item, already in bb's provider-delta shape
//           (the bridge sends it as a bare item.close keyed by the remote id).
// - "end"   the remote turn is over.
// - "note"  one plain line from the mirror itself (earlier history, errors).

export const MIRROR_PROVIDER_ID = "fleet-mirror";
export const MIRROR_MODEL_ID = "mirror";
/** The one model the provider lists; the bridge calls no model at all. */
export const MIRROR_MODEL = {
  id: MIRROR_MODEL_ID,
  displayName: "Mirror",
  description: "Shows a chat from another Mac. Calls no model.",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
  defaultReasoningEffort: "medium",
  isDefault: true,
} as const;
/** Advertised in every snapshot by a Fleet that can publish and read mirrors. */
export const MIRROR_FEATURE = "mirror";
/** Tool output, diffs and arguments are cut to this many UTF-8 bytes per item. */
export const ITEM_OUTPUT_MAX_BYTES = 32 * 1024;
/** A remote chat opened for the first time replays at most this many turns. */
export const REPLAY_TURNS = 30;

export type TurnStatus = "completed" | "failed" | "interrupted";
export type ItemStatus = "completed" | "failed" | "interrupted" | "pending";

export interface MirrorUser {
  text: string;
  requestId: string;
  /** A native reply's durable identity, retained through the owner echo. */
  controlId?: string;
}

/** The item.close fields the bridge sends as they are (grammar v3). */
export interface MirrorClose {
  status: ItemStatus;
  item: Record<string, unknown> & { type: string };
  presentation?: Record<string, unknown>;
  exitCode?: number;
  aggregatedOutput?: string;
  resultText?: string;
}

export type MirrorRecord =
  | { t: "turn"; turn: string; user: MirrorUser | null }
  | { t: "steer"; turn: string; user: MirrorUser }
  | { t: "item"; turn: string | null; id: string; parent?: string; close: MirrorClose }
  | { t: "end"; turn: string; status: TurnStatus; error?: string }
  | { t: "note"; text: string }
  /** An owner question or approval waiting for an answer; detail is the owner's full payload and fingerprint when it could be read. */
  | { t: "interaction"; turn: string | null; id: string; kind: "approval" | "user_question"; detail: { payload: Record<string, unknown>; fingerprint: string } | null }
  /** The owner ended it; resolution is the owner's own answer when it carried one (so the copy can show it answered). */
  | { t: "interaction-end"; id: string; status: "resolved" | "interrupted"; resolution?: Record<string, unknown> };

/** One sealed row of fleet_mirror_events, once opened. */
export interface MirrorBatch {
  v: 1;
  generation: string;
  records: MirrorRecord[];
}

/** First line of every feed file: which chat the copy mirrors. */
export interface FeedHeader {
  t: "header";
  machine: string;
  serverId: string;
  remoteThreadId: string;
  /** Present only when this copy has a real, configured owner-control transport. */
  control?: { v: 1; replayToken: string };
}

export type FeedControl = { t: "control"; v: 1; replayToken: string };
export type FeedRecord = FeedHeader | FeedControl | MirrorRecord;

/** What deriveProviderOptions hands the bridge on every command. */
export type MirrorProviderOptions = {
  feedDir?: string;
};

export function watchOnlyLine(machine: string | null): string {
  const where = machine && machine.trim() !== "" ? `the ${machine.trim()}` : "another Mac";
  return `This chat runs on ${where}. Replying from here is coming later.`;
}

export function earlierHistoryLine(machine: string): string {
  return `Earlier messages in this chat are on the ${machine}; this copy starts ${REPLAY_TURNS} turns back.`;
}

/** Item types that settle outside a turn (bb attaches them to the thread). */
export function isThreadScopedItem(item: { type: string; background?: unknown }): boolean {
  return item.type === "backgroundTask" || (item.type === "delegation" && item.background === true);
}

/** The text of a prompt as the copy sends it: text parts joined, attachments named. */
export function promptText(input: ReadonlyArray<{ type: string; text?: unknown; path?: unknown; name?: unknown; url?: unknown }>): string {
  const parts: string[] = [];
  for (const part of input) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "localImage" || part.type === "image") parts.push(`[image${typeof part.path === "string" ? `: ${part.path.split("/").pop()}` : ""}]`);
    else if (part.type === "localFile") parts.push(`[file: ${typeof part.name === "string" ? part.name : typeof part.path === "string" ? part.path.split("/").pop() : "attachment"}]`);
  }
  return parts.join("\n").trim();
}

/** Two texts name the same message (the runtime may trim or normalise line ends). */
export function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();
}

// Logical conversations across native model continuations. Pure: no I/O.
//
// The NavAIgate Workspace plugin ("navaigate-skin") groups a native model
// continuation (for example Sol to Opus) as a separate, hidden bb thread. The
// only public, read-only record of that grouping is the skin's thread plugin
// metadata on each member (never on the root):
//
//   threads.getPluginMetadata({ threadId: member, pluginId: "navaigate-skin" })
//     -> { nativeConversation: { rootThreadId, sourceThreadId, kind } }
//
// with kind "continuation" (the next reply moved to another model) or
// "parallel" (a model started alongside). Helper Desk reads that and nothing
// else from the skin. Which member the skin currently shows is kept in the
// skin's own storage, so Helper Desk follows the working member, else the
// newest continuation (the skin activates each new continuation).
import { z } from "zod";

export const SKIN_PLUGIN_ID = "navaigate-skin";

export type MemberKind = "root" | "continuation" | "parallel";

export interface NativeClaim {
  rootThreadId: string;
  sourceThreadId: string | null;
  kind: "continuation" | "parallel";
}

/** Read the skin's `nativeConversation` claim from a thread's metadata, or null. */
export function parseNativeClaim(metadata: unknown): NativeClaim | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).nativeConversation;
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.rootThreadId !== "string" || !c.rootThreadId) return null;
  const kind = c.kind === "parallel" ? "parallel" : c.kind === "continuation" || c.kind === undefined ? "continuation" : null;
  if (!kind) return null;
  return { rootThreadId: c.rootThreadId, sourceThreadId: typeof c.sourceThreadId === "string" ? c.sourceThreadId : null, kind };
}

export interface ConversationMember {
  threadId: string;
  kind: MemberKind;
  sourceThreadId: string | null;
  createdAt: number;
  status: string;
}

export interface Conversation {
  rootThreadId: string;
  /** Root first, then the members in the order they were started. */
  members: ConversationMember[];
}

/** Build the conversation from the root and the claims that point at it. Null when there is nothing to group. */
export function assembleConversation(
  root: { id: string; createdAt: number; status: string },
  candidates: { id: string; createdAt: number; status: string; claim: NativeClaim | null }[],
): Conversation | null {
  const members = candidates
    .filter((c) => c.id !== root.id && c.claim?.rootThreadId === root.id)
    .map((c) => ({ threadId: c.id, kind: c.claim!.kind as MemberKind, sourceThreadId: c.claim!.sourceThreadId, createdAt: c.createdAt, status: c.status }))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!members.length) return null;
  return { rootThreadId: root.id, members: [{ threadId: root.id, kind: "root", sourceThreadId: null, createdAt: root.createdAt, status: root.status }, ...members] };
}

const WORKING = new Set(["active", "running", "pending"]);

/**
 * The thread whose live work Helper Desk should show. A route on a member is
 * that member (the skin moves the route there when it cannot share the
 * root's workspace). On the root: the member that is working now, else the
 * newest continuation.
 */
export function followedThread(requested: string, conversation: Conversation | null): string {
  if (!conversation || requested !== conversation.rootThreadId) return requested;
  const chain = conversation.members.filter((m) => m.kind !== "parallel");
  const working = [...chain].reverse().find((m) => WORKING.has(m.status));
  return (working ?? chain[chain.length - 1]).threadId;
}

/** One turn's requested model, from `client/turn/requested` `execution.model`. */
export interface TurnModel {
  seq: number;
  at: number;
  model: string;
}

/** The model the thread was using at a given event seq (the newest turn at or before it). */
export function modelAt(turns: readonly TurnModel[], seq: number): string {
  let found = "";
  for (const t of turns) {
    if (t.seq > seq) break;
    found = t.model;
  }
  return found || turns[0]?.model || "";
}

export const switchSchema = z.object({
  at: z.number(),
  fromModel: z.string(),
  toModel: z.string(),
  fromThreadId: z.string(),
  toThreadId: z.string(),
  /** "continuation": the conversation moved to a new native session; "same-session": the model changed inside one. */
  kind: z.enum(["continuation", "same-session"]),
});
export type ModelSwitch = z.infer<typeof switchSchema>;

/**
 * Walk every turn of the conversation's main line (root and continuations,
 * not parallel sessions) in time order and mark each change of model.
 */
export function modelSwitches(members: readonly { threadId: string; kind: MemberKind; turns: readonly TurnModel[] }[], label: (model: string) => string = (m) => m): ModelSwitch[] {
  const timeline = members
    .filter((m) => m.kind !== "parallel")
    .flatMap((m) => m.turns.filter((t) => t.model).map((t) => ({ ...t, threadId: m.threadId })))
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const out: ModelSwitch[] = [];
  let prev: (typeof timeline)[number] | null = null;
  for (const t of timeline) {
    if (prev && label(prev.model) !== label(t.model)) {
      out.push({ at: t.at, fromModel: label(prev.model), toModel: label(t.model), fromThreadId: prev.threadId, toThreadId: t.threadId, kind: prev.threadId === t.threadId ? "same-session" : "continuation" });
    }
    prev = t;
  }
  return out;
}

/** Interleave history batches and model switches, newest first. */
export function historyTimeline<B extends { startedAt: number }>(batches: readonly B[], switches: readonly ModelSwitch[]): ({ type: "batch"; batch: B } | { type: "switch"; change: ModelSwitch })[] {
  const items = [
    ...batches.map((batch) => ({ type: "batch" as const, batch, at: batch.startedAt })),
    ...switches.map((change) => ({ type: "switch" as const, change, at: change.at })),
  ];
  // On a tie the switch sits below the batch it led to (newest first).
  items.sort((a, b) => b.at - a.at || (a.type === b.type ? 0 : a.type === "batch" ? -1 : 1));
  return items.map((i) => (i.type === "batch" ? { type: "batch", batch: i.batch } : { type: "switch", change: i.change }));
}

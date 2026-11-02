export const NATIVE_SESSION_LIMIT = 128;
export const NATIVE_ARM_TTL_MS = 30 * 60_000;

export type NativeSelection = {
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier?: string;
};

export type NativeSessionMember = {
  id: string;
  sourceThreadId: string | null;
  kind: "root" | "continuation" | "parallel";
  providerId: string;
  environmentId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
  title: string;
  status: string;
  createdAt: number;
  /** Set on a state read when the thread is archived; an archived member never drives a composer. */
  archived?: boolean;
};

export type NativeSessionArm = NativeSelection & {
  proofRequired?: boolean;
  continuationComposerKey?: string;
  sourceThreadId: string;
  generation: string;
  selectionVersion: number;
  createdAt: number;
  expiresAt: number;
};

export type NativeSessionRecord = {
  rootThreadId: string;
  title: string;
  projectId: string;
  activeThreadId: string;
  /** Last chosen member in the root's own workspace; survives a visit to a mirror. */
  lastLocalThreadId?: string;
  version: number;
  selectionVersion: number;
  members: NativeSessionMember[];
  arms: Record<string, NativeSessionArm>;
  warning: string | null;
};

type MentionedText = {
  type: "text";
  text: string;
  mentions?: readonly {
    start: number;
    end: number;
    resource: { kind: string; threadId?: string; projectId?: string };
  }[];
};

/** Match the native handoff's leading chip, never a thread name in ordinary prose. */
export function nativeHandoffSource(blocks: readonly unknown[]): string | null {
  const first = blocks[0] as Partial<MentionedText> | undefined;
  if (first?.type !== "text" || typeof first.text !== "string" || !Array.isArray(first.mentions)) return null;
  for (const mention of first.mentions) {
    if (!mention?.resource || mention.resource.kind !== "thread" || !mention.resource.threadId) continue;
    const prefix = `Continue from @thread:${mention.resource.threadId}`;
    if (mention.start !== 14 || mention.end !== prefix.length || !first.text.startsWith(prefix)) continue;
    if (first.text.length !== prefix.length && first.text[prefix.length] !== "\n") continue;
    return mention.resource.threadId;
  }
  return null;
}

export function armMatches(
  arm: NativeSessionArm,
  candidate: {
    sourceThreadId: string;
    providerId: string;
    createdAt: number;
  },
  now: number,
): boolean {
  return arm.sourceThreadId === candidate.sourceThreadId &&
    arm.expiresAt > now &&
    candidate.createdAt >= arm.createdAt &&
    arm.providerId === candidate.providerId;
}

export function appendNativeMember(
  record: NativeSessionRecord,
  member: NativeSessionMember,
  arm: NativeSessionArm | null,
): NativeSessionRecord {
  if (record.members.some((m) => m.id === member.id)) return record;
  if (record.members.length >= NATIVE_SESSION_LIMIT) throw new Error("This conversation has reached its native session limit. The new session remains available separately.");
  // The composer arms from the thread it shows. After a visit to a mirror that is the remembered local
  // member, not the saved selection, so either one counts as the source of this switch.
  const fromShown = arm !== null && (record.activeThreadId === arm.sourceThreadId || record.lastLocalThreadId === arm.sourceThreadId);
  const activate = member.kind === "continuation" && arm !== null && fromShown &&
    record.selectionVersion === arm.selectionVersion &&
    record.arms[arm.sourceThreadId]?.generation === arm.generation;
  return {
    ...record,
    members: [...record.members, member],
    activeThreadId: activate ? member.id : record.activeThreadId,
    version: record.version + 1,
    selectionVersion: activate ? record.selectionVersion + 1 : record.selectionVersion,
    warning: null,
  };
}

type RouteMember = { id: string; environmentId: string | null; providerId: string | null; status?: string; archived?: boolean };
type RouteSession = { rootThreadId: string; activeThreadId: string; lastLocalThreadId?: string; members: ReadonlyArray<RouteMember> };

/** The route a chosen member opens on: the root when it shares the root's environment and is not a mirror, otherwise its own. One rule, used by the chat header and the usage dock. */
export function selectionRoute(session: Pick<RouteSession, "rootThreadId" | "members">, memberId: string): string {
  const root = session.members.find((member) => member.id === session.rootThreadId);
  const member = session.members.find((entry) => entry.id === memberId);
  return root?.environmentId && member?.environmentId === root.environmentId && member.providerId !== "fleet-mirror" ? session.rootThreadId : memberId;
}

/** The member that drives the root's own composer. The saved selection when it is usable here; otherwise the last
 * local member that was chosen (kept per conversation on the server, so a visit to a mirror on another machine cannot reset it);
 * the physical root only if no local member was ever chosen. A mirror, a different worktree, an unprovisioned
 * environment, an archived or deleted member is never returned. The chat header and the usage dock both read this,
 * so they cannot disagree. */
export function localActiveThread(session: RouteSession): string {
  const usable = (id: string | undefined): id is string => !!id && selectionRoute(session, id) === session.rootThreadId
    && session.members.some((member) => member.id === id && member.status !== "deleted" && !member.archived);
  if (usable(session.activeThreadId)) return session.activeThreadId;
  if (usable(session.lastLocalThreadId)) return session.lastLocalThreadId;
  return session.rootThreadId;
}

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
  const activate = member.kind === "continuation" && arm !== null &&
    record.activeThreadId === arm.sourceThreadId && record.selectionVersion === arm.selectionVersion &&
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

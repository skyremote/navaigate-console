import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { createNativeContext } from "./server-native-context";
import {
  appendNativeMember,
  armMatches,
  nativeHandoffSource,
  NATIVE_ARM_TTL_MS,
  NATIVE_SESSION_LIMIT,
  type NativeSessionArm,
  type NativeSessionMember,
  type NativeSessionRecord,
} from "./src/native-session-model";

const id = z.string().min(1).max(128);
const selectionSchema = z.object({
  providerId: z.string().min(1).max(200),
  model: z.string().min(1).max(250),
  reasoningLevel: z.string().min(1).max(80),
  serviceTier: z.string().min(1).max(80).optional(),
}).strict();
const memberSchema = z.object({
  id,
  sourceThreadId: id.nullable(),
  kind: z.enum(["root", "continuation", "parallel"]),
  providerId: z.string(),
  environmentId: id.nullable().default(null),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  serviceTier: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  createdAt: z.number(),
  archived: z.boolean().optional(),
});
const armSchema = selectionSchema.extend({
  sourceThreadId: id,
  generation: z.string(),
  selectionVersion: z.number(),
  createdAt: z.number(),
  expiresAt: z.number(),
  proofRequired: z.boolean().optional(),
  continuationComposerKey: z.string().min(1).max(500).optional(),
});
const recordSchema = z.object({
  rootThreadId: id,
  title: z.string().max(500),
  projectId: id,
  activeThreadId: id,
  /** The last member the user chose that runs in the root's own workspace (never a mirror). It outlives a visit to a mirror. */
  lastLocalThreadId: id.optional(),
  version: z.number().int().positive(),
  selectionVersion: z.number().int().positive(),
  members: z.array(memberSchema).min(1).max(NATIVE_SESSION_LIMIT),
  arms: z.record(z.string(), armSchema),
  warning: z.string().nullable(),
});
export const nativeSessionStateSchema = z.object({
  rootThreadId: id,
  title: z.string(),
  projectId: id,
  activeThreadId: id,
  /** Where the composer falls back when the saved selection is a mirror or another workspace. Absent until a local member was chosen. */
  lastLocalThreadId: id.optional(),
  version: z.number(),
  members: z.array(memberSchema).max(NATIVE_SESSION_LIMIT),
  pending: armSchema.nullable(),
  warning: z.string().nullable(),
});
export type NativeSessionState = z.infer<typeof nativeSessionStateSchema>;
/**
 * One member's live state. bb's sidebar list leaves hidden threads out, so the
 * rail cannot see a hidden continuation running; the index carries it instead.
 * Model and effort come only for the active member (the row's logical label).
 */
const memberLiveSchema = z.object({
  id,
  projectId: id,
  providerId: z.string(),
  status: z.string(),
  isHidden: z.boolean(),
  isArchived: z.boolean(),
  hasPendingInteraction: z.boolean(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  /** When the member last changed; the rail sorts a conversation by its newest member. */
  updatedAt: z.number().optional(),
});
export type NativeSessionMemberLive = z.infer<typeof memberLiveSchema>;
/** Every grouped conversation's membership, so the rail can show a hidden member's live state on its root row. */
export const nativeSessionIndexSchema = z.object({
  conversations: z.array(z.object({ rootThreadId: id, activeThreadId: id, memberIds: z.array(id).max(NATIVE_SESSION_LIMIT), members: z.array(memberLiveSchema).max(NATIVE_SESSION_LIMIT) })),
});
export type NativeSessionIndex = z.infer<typeof nativeSessionIndexSchema>;
export const nativeSessionThreadInput = z.object({ threadId: id }).strict();
export const nativeSessionArmInput = nativeSessionThreadInput.extend({ selection: selectionSchema, proofRequired: z.boolean().optional(), expectedVersion: z.number().int().positive().optional(), continuationComposerKey: z.string().min(1).max(500).optional() }).strict().refine((value) => !value.proofRequired || !!value.continuationComposerKey, "A proof-required continuation needs its exact composer key");
export const nativeContinuationPreparationContract = defineRpcContract({ native_session_prepare_cancel: { input: nativeSessionThreadInput.extend({ generation: z.string().uuid() }).strict(), output: nativeSessionStateSchema } });
export const nativeSessionSelectInput = z.object({ rootThreadId: id, threadId: id }).strict();
export const nativeSessionAdoptInput = nativeSessionSelectInput.extend({ kind: z.enum(["parallel", "continuation"]) }).strict();

const RECORD = "native-conversation:";
const LOOKUP = "native-conversation-root:";
const ARM_LOOKUP = "native-conversation-arm:";
const RETIRED = "native-conversation-retired:";
const PROOF = "native-conversation-proof:";
const continuationProofSchema = z.object({ kind: z.literal("logical-continuation-v1"), rootThreadId: id, sourceThreadId: id, generation: z.string().uuid(), composerKey: z.string().min(1).max(500) }).strict();
const CHANNEL = "native-sessions";
const MAX_RECORD_BYTES = 230_000;

export function createNativeSessions(bb: BbPluginApi) {
  const context = createNativeContext(bb);
  const kv = bb.storage.kv;
  const locks = new Map<string, Promise<unknown>>();

  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    locks.set(key, result);
    void result.finally(() => { if (locks.get(key) === result) locks.delete(key); }).catch(() => undefined);
    return result;
  }
  const INDEX_LOCK = "@native-session-index";
  const mutateRoot = <T>(root: string, work: () => Promise<T>) => serial(INDEX_LOCK, () => serial(root, async () => {
    readEpoch++;
    try { return await work(); } finally { readEpoch++; }
  }));
  const provisional = (record: NativeSessionRecord) => record.version === 1 && record.selectionVersion === 1 && record.members.length === 1 && record.members[0].id === record.rootThreadId && !Object.keys(record.arms).length && record.warning === null;

  async function getRecord(root: string): Promise<NativeSessionRecord | undefined> {
    const stored = await kv.get<unknown>(RECORD + root);
    if (stored === undefined) return undefined;
    const parsed = recordSchema.safeParse(stored);
    if (!parsed.success) throw new Error("The native conversation index could not be read. Its original provider sessions remain available.");
    return parsed.data;
  }
  let readEpoch = 0;
  const sharedReads = new Map<string, { epoch: number; promise: Promise<unknown> }>();
  function coalesced<T>(key: string, read: () => Promise<T>): Promise<T> {
    const prior = sharedReads.get(key);
    if (prior && prior.epoch === readEpoch) return prior.promise as Promise<T>;
    const entry = { epoch: readEpoch, promise: Promise.resolve() as Promise<unknown> };
    entry.promise = read().finally(() => { if (sharedReads.get(key) === entry) sharedReads.delete(key); });
    sharedReads.set(key, entry);
    return entry.promise as Promise<T>;
  }
  const publish = (rootThreadId: string) => {
    readEpoch++;
    return bb.realtime.publish(CHANNEL, { rootThreadId });
  };

  async function save(record: NativeSessionRecord) {
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_RECORD_BYTES) throw new Error("The conversation's session index is full. Its provider sessions remain available.");
    readEpoch++;
    await kv.set(RECORD + record.rootThreadId, record);
    readEpoch++;
  }

  async function rootExists(root: string): Promise<boolean> {
    try { return (await bb.sdk.threads.get({ threadId: root })).deletedAt === null; }
    catch (cause) {
      if (/404|not.found/i.test(String(cause))) return false;
      throw cause;
    }
  }

  async function retireRoot(root: string) {
    await serial(root, async () => {
      // Recheck after waiting for a concurrent association. Never infer a
      // deletion from an unavailable host or from the lifecycle event alone.
      if (await rootExists(root)) return;
      const record = await getRecord(root);
      if (!record) return;
      await kv.set(RETIRED + root, true);
      for (const member of record.members) {
        if (member.id !== root) {
          let thread;
          try { thread = await bb.sdk.threads.get({ threadId: member.id }); }
          catch (cause) { if (!/404|not.found/i.test(String(cause))) throw cause; }
          if (thread?.deletedAt === null) {
            const currentRoot = await kv.get<string>(LOOKUP + member.id);
            if (!currentRoot || currentRoot === root) {
              await bb.sdk.threads.update({ threadId: member.id, visibility: "visible", ...(thread.parentThreadId === root ? { parentThreadId: null } : {}) });
            }
          }
        }
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: member.id, pluginId: bb.pluginId }).catch((cause: unknown) => {
          if (/404|not.found/i.test(String(cause))) return null;
          throw cause;
        });
        if ((metadata?.nativeConversation as { rootThreadId?: string } | undefined)?.rootThreadId === root) await bb.sdk.threads.updatePluginMetadata({ threadId: member.id, pluginId: bb.pluginId, remove: ["nativeConversation"] });
        if ((await kv.get<{ rootThreadId?: string }>(PROOF + member.id))?.rootThreadId === root) await kv.delete(PROOF + member.id);
        if (await kv.get<string>(LOOKUP + member.id) === root) await kv.delete(LOOKUP + member.id);
        if (await kv.get<string>(ARM_LOOKUP + member.id) === root) await kv.delete(ARM_LOOKUP + member.id);
      }
      await kv.delete(RECORD + root);
      await kv.delete(RETIRED + root);
      publish(root);
    });
  }

  async function usableRoot(root: string): Promise<boolean> {
    if (await rootExists(root)) return !(await kv.get<boolean>(RETIRED + root));
    await retireRoot(root);
    return false;
  }

  async function rootFor(threadId: string): Promise<string | null> {
    const indexed = await kv.get<string>(LOOKUP + threadId);
    if (indexed && indexed !== threadId && (await getRecord(indexed))?.members.some((m) => m.id === threadId) && await usableRoot(indexed)) return indexed;
    const own = await getRecord(threadId);
    if (own && !provisional(own) && await usableRoot(threadId)) return threadId;
    // The record is authoritative when a process stopped between record and index writes.
    for (const key of await kv.list(RECORD)) {
      const record = await getRecord(key.slice(RECORD.length));
      if (record && record.rootThreadId !== threadId && record.members.some((m) => m.id === threadId) && await usableRoot(record.rootThreadId)) {
        await kv.set(LOOKUP + threadId, record.rootThreadId);
        if (own && provisional(own)) await kv.delete(RECORD + threadId);
        return record.rootThreadId;
      }
    }
    if (own && await getRecord(threadId) && await usableRoot(threadId)) return threadId;
    return null;
  }

  async function memberFor(threadId: string, sourceThreadId: string | null, kind: NativeSessionMember["kind"]): Promise<NativeSessionMember> {
    const thread = await bb.sdk.threads.get({ threadId });
    const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId });
    return {
      id: thread.id,
      sourceThreadId,
      kind,
      providerId: thread.providerId,
      environmentId: thread.environmentId,
      model: execution?.model ?? null,
      reasoningLevel: execution?.reasoningLevel ?? null,
      serviceTier: execution?.serviceTier ?? null,
      title: (thread.title ?? thread.titleFallback ?? "Conversation").slice(0, 500),
      status: thread.status,
      createdAt: thread.createdAt,
    };
  }

  async function ensure(threadId: string): Promise<string> {
    return serial(INDEX_LOCK, async () => {
      const existing = await rootFor(threadId);
      if (existing) return existing;
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt !== null) throw new Error("This conversation was deleted.");
      const member = await memberFor(threadId, null, "root");
      await save({ rootThreadId: threadId, title: member.title, projectId: thread.projectId, activeThreadId: threadId, version: 1, selectionVersion: 1, members: [member], arms: {}, warning: null });
      await kv.set(LOOKUP + threadId, threadId);
      return threadId;
    });
  }

  async function readState(rootThreadId: string): Promise<NativeSessionState> {
    if (!await usableRoot(rootThreadId)) throw new Error("This conversation root was deleted. Its surviving sessions are available separately.");
    const record = await getRecord(rootThreadId);
    if (!record) throw new Error("The native conversation index is unavailable.");
    const members = await Promise.all(record.members.map(async (member) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId: member.id });
        const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId: member.id });
        return { ...member, providerId: thread.providerId, environmentId: thread.environmentId, title: (thread.title ?? thread.titleFallback ?? member.title).slice(0, 500), status: thread.deletedAt === null ? thread.status : "deleted", model: execution?.model ?? member.model, reasoningLevel: execution?.reasoningLevel ?? member.reasoningLevel, serviceTier: execution?.serviceTier ?? member.serviceTier, ...(thread.archivedAt !== null ? { archived: true } : {}) };
      } catch (error) {
        return { ...member, status: /not found|404/i.test(String(error)) ? "deleted" : "unavailable" };
      }
    }));
    const active = members.find((member) => member.id === record.activeThreadId && member.status !== "deleted");
    const activeThreadId = active?.id ?? [...members].reverse().find((member) => member.status !== "deleted")?.id ?? record.rootThreadId;
    const arm = record.arms[activeThreadId];
    const lastLocalThreadId = members.find((member) => member.id === record.lastLocalThreadId && member.status !== "deleted" && !member.archived)?.id;
    return { rootThreadId, title: record.title, projectId: record.projectId, activeThreadId, ...(lastLocalThreadId ? { lastLocalThreadId } : {}), version: record.version, members, pending: arm && arm.expiresAt > Date.now() ? arm : null, warning: record.warning };
  }

  const quietly = async <T,>(read: () => Promise<T>, fallback: T): Promise<T> => { try { return await read(); } catch { return fallback; } };
  // A member that cannot be read is left out, so the rail simply does not fold it.
  async function memberLive(threadId: string, active: boolean): Promise<NativeSessionMemberLive | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt !== null) return null;
      const isHidden = thread.visibility === "hidden";
      const busy = thread.status === "active" || thread.status === "starting" || thread.status === "stopping";
      // Only a quiet hidden member is asked for a pending question: a running one already holds the row.
      const hasPendingInteraction = isHidden && !busy && await quietly(async () => (await bb.sdk.threads.interactions.list({ threadId })).length > 0, false);
      const execution = active ? await quietly(() => bb.sdk.threads.defaultExecutionOptions({ threadId }), null) : null;
      return {
        id: thread.id, projectId: thread.projectId, providerId: thread.providerId, status: thread.status,
        isHidden, isArchived: thread.archivedAt !== null, hasPendingInteraction, updatedAt: thread.updatedAt,
        model: execution?.model ?? null, reasoningLevel: execution?.reasoningLevel ?? null,
      };
    } catch {
      return null;
    }
  }

  // Read-only: never initialises, repairs or retires a record. A deleted root
  // is simply absent from the sidebar, so its stale entry is harmless.
  function index(): Promise<NativeSessionIndex> {
    return coalesced("index", readIndex);
  }

  async function readIndex(): Promise<NativeSessionIndex> {
    const conversations: NativeSessionIndex["conversations"] = [];
    for (const key of await kv.list(RECORD)) {
      const record = await getRecord(key.slice(RECORD.length)).catch(() => undefined);
      if (!record || record.members.length < 2 || await kv.get<boolean>(RETIRED + record.rootThreadId)) continue;
      const members = (await Promise.all(record.members.map((member) => memberLive(member.id, member.id === record.activeThreadId))))
        .filter((member): member is NativeSessionMemberLive => member !== null);
      conversations.push({ rootThreadId: record.rootThreadId, activeThreadId: record.activeThreadId, memberIds: record.members.map((member) => member.id), members });
    }
    return { conversations };
  }

  function state(input: z.infer<typeof nativeSessionThreadInput>) {
    return coalesced(`state:${input.threadId}`, async () => {
      const initial = await ensure(input.threadId);
      return serial(INDEX_LOCK, async () => readState(await rootFor(input.threadId) ?? initial));
    });
  }

  async function arm(input: z.infer<typeof nativeSessionArmInput>) {
    const rootThreadId = await ensure(input.threadId);
    const preparedArm = await mutateRoot(rootThreadId, async (): Promise<NativeSessionArm | null> => {
      const record = (await getRecord(rootThreadId))!;
      if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) throw new Error("The logical conversation changed while preparing. Your draft is kept.");
      const source = await bb.sdk.threads.get({ threadId: input.threadId });
      if (!record.members.some((m) => m.id === source.id) || source.projectId !== record.projectId || source.deletedAt !== null) throw new Error("The selected provider session is not in this conversation.");
      if (source.providerId === input.selection.providerId) {
        delete record.arms[source.id];
        record.version++;
        await save(record);
        await kv.delete(ARM_LOOKUP + source.id);
        return null;
      }
      const now = Date.now();
      record.arms[source.id] = { ...input.selection, sourceThreadId: source.id, generation: randomUUID(), selectionVersion: record.selectionVersion, createdAt: now, expiresAt: now + NATIVE_ARM_TTL_MS, proofRequired: input.proofRequired ?? false, ...(input.continuationComposerKey ? { continuationComposerKey: input.continuationComposerKey } : {}) };
      record.version++;
      record.warning = null;
      await save(record);
      await kv.set(ARM_LOOKUP + source.id, rootThreadId);
      return { ...record.arms[source.id] };
    });
    publish(rootThreadId);
    return { ...await readState(rootThreadId), pending: preparedArm };
  }

  async function cancelArm(input: z.infer<typeof nativeSessionThreadInput> & { generation?: string }) {
    const rootThreadId = await ensure(input.threadId);
    await mutateRoot(rootThreadId, async () => {
      const record = (await getRecord(rootThreadId))!;
      if (input.generation !== undefined && record.arms[input.threadId]?.generation !== input.generation) return;
      delete record.arms[input.threadId];
      record.version++;
      await save(record);
      await kv.delete(ARM_LOOKUP + input.threadId);
    });
    publish(rootThreadId);
    return readState(rootThreadId);
  }

  async function select(input: z.infer<typeof nativeSessionSelectInput>) {
    const root = await ensure(input.rootThreadId);
    if (root !== input.rootThreadId) throw new Error("Choose the logical conversation's root.");
    await mutateRoot(root, async () => {
      const record = (await getRecord(root))!;
      if (!record.members.some((m) => m.id === input.threadId)) throw new Error("This provider session does not belong to the conversation.");
      const target = await bb.sdk.threads.get({ threadId: input.threadId });
      if (target.deletedAt !== null) throw new Error("This provider session was deleted.");
      // Same rule as the composer: only the root's own workspace, never a mirror, never an archived thread.
      // Looking at a mirror therefore leaves the remembered local choice alone. A failed read of the root
      // only skips the bookkeeping; the selection itself still succeeds.
      try {
        const rootThread = await bb.sdk.threads.get({ threadId: root });
        const isLocal = (thread: { environmentId: string | null; providerId: string; archivedAt: number | null }) => !!rootThread.environmentId && thread.environmentId === rootThread.environmentId && thread.providerId !== "fleet-mirror" && thread.archivedAt === null;
        if (isLocal(target)) record.lastLocalThreadId = target.id;
        else if (!record.lastLocalThreadId && record.activeThreadId !== root && record.activeThreadId !== target.id) {
          // First mirror visit on a record saved before this was tracked: keep the model that was in use.
          const previous = await bb.sdk.threads.get({ threadId: record.activeThreadId }).catch(() => null);
          if (previous && previous.deletedAt === null && isLocal(previous)) record.lastLocalThreadId = previous.id;
        }
      } catch { /* keep the previous remembered choice */ }
      record.activeThreadId = input.threadId;
      record.selectionVersion++;
      record.version++;
      await save(record);
    });
    publish(root);
    return readState(root);
  }

  async function indexAssociation(record: NativeSessionRecord, threadId: string) {
    await kv.set(LOOKUP + record.rootThreadId, record.rootThreadId);
    await kv.set(LOOKUP + threadId, record.rootThreadId);
    const member = record.members.find((entry) => entry.id === threadId)!;
    await bb.sdk.threads.updatePluginMetadata({ threadId, pluginId: bb.pluginId, set: { nativeConversation: { rootThreadId: record.rootThreadId, sourceThreadId: member.sourceThreadId, kind: member.kind } } });
    // A state read can have provisionally initialised this native successor
    // before its first dispatch hook began. Remove only that unused singleton.
    const own = threadId === record.rootThreadId ? undefined : await getRecord(threadId);
    if (own && provisional(own)) await kv.delete(RECORD + threadId);
  }

  async function validateAssociation(root: string, threadId: string) {
    const own = threadId === root ? undefined : await getRecord(threadId);
    if (own && !provisional(own)) throw new Error("This native session is already used as an independent conversation.");
    const indexed = await kv.get<string>(LOOKUP + threadId);
    if (indexed && indexed !== root && indexed !== threadId && (await getRecord(indexed))?.members.some((member) => member.id === threadId)) throw new Error("This native session already belongs to another conversation.");
  }

  async function adoptVerified(input: z.infer<typeof nativeSessionAdoptInput>, startedSourceId?: string) {
    const root = await ensure(input.rootThreadId);
    if (root !== input.rootThreadId || input.threadId === root) throw new Error("A separate provider session is required.");
    await mutateRoot(root, async () => {
      const record = (await getRecord(root))!;
      const child = await bb.sdk.threads.get({ threadId: input.threadId });
      const trustedFleet = startedSourceId !== undefined;
      if (trustedFleet) {
        if (child.projectId !== record.projectId || child.originPluginId !== "fleet" || child.deletedAt !== null || (child.parentThreadId !== null && child.parentThreadId !== root) || !record.members.some((m) => m.id === startedSourceId)) throw new Error("Only a confirmed Fleet start in this conversation's project can be attached.");
        // This path is internal to a confirmed start receipt. Preserve Fleet's
        // ownership and metadata; the public adopt RPC cannot grant it.
        await bb.sdk.threads.updatePluginMetadata({ threadId: child.id, pluginId: bb.pluginId, set: { nativeConversation: { rootThreadId: root, sourceThreadId: startedSourceId, kind: input.kind } } });
      }
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: child.id, pluginId: bb.pluginId });
      const claim = metadata.nativeConversation as { rootThreadId?: string; sourceThreadId?: string; kind?: string } | undefined;
      if (child.projectId !== record.projectId || (child.parentThreadId !== null && child.parentThreadId !== root) || (!trustedFleet && child.originPluginId !== bb.pluginId) || child.deletedAt !== null || claim?.rootThreadId !== root) throw new Error("Only a model started alongside this conversation can be attached.");
      if (claim.kind !== undefined && claim.kind !== input.kind) throw new Error("The session's recorded purpose does not match this request.");
      const sourceId = claim.sourceThreadId ?? root;
      if (!record.members.some((m) => m.id === sourceId)) throw new Error("The session's source is not in this conversation.");
      await validateAssociation(root, child.id);
      const next = appendNativeMember(record, await memberFor(child.id, sourceId, input.kind), null);
      if (next !== record) await save(next);
      await indexAssociation(next, child.id);
      await bb.sdk.threads.update({ threadId: child.id, parentThreadId: null, visibility: "hidden" });
    });
    publish(root);
    return readState(root);
  }

  const adopt = (input: z.infer<typeof nativeSessionAdoptInput>) => adoptVerified(input);
  /** Internal only: caller must have an actual Fleet start/mirror receipt. */
  const adoptStarted = (input: { rootThreadId: string; threadId: string; sourceThreadId?: string }) => adoptVerified({ rootThreadId: input.rootThreadId, threadId: input.threadId, kind: "parallel" }, input.sourceThreadId ?? input.rootThreadId);

  async function capture(ctx: MessageDispatchHookContext) {
    const submission = ctx.experimental_submission;
    const ownsLogicalProof = submission?.pluginId === bb.pluginId && submission.data !== null && typeof submission.data === "object" && !Array.isArray(submission.data) && submission.data.kind === "logical-continuation-v1";
    if (submission?.pluginId === bb.pluginId && submission.data !== null && typeof submission.data === "object" && !Array.isArray(submission.data) && submission.data.kind === "standalone-handoff-v1") return;
    if (ctx.thread.status !== "pending" || ctx.thread.providerId === "fleet-mirror" || ctx.attempt !== "start-turn" || ctx.initiator !== "user" || ctx.origin !== "app" || ctx.originPluginId !== null || ctx.queuedMessages.length > 0) return;
    const sourceThreadId = nativeHandoffSource(ctx.input.blocks);
    if (!sourceThreadId || sourceThreadId === ctx.thread.id) return;
    return serial(INDEX_LOCK, async () => {
      const root = await kv.get<string>(ARM_LOOKUP + sourceThreadId);
      if (!root) return;
      if (!await usableRoot(root)) return;
      await serial(root, async () => {
        const record = await getRecord(root);
        if (!record || ctx.thread.id === root || ctx.thread.projectId !== record.projectId || ctx.project.id !== record.projectId) return;
        if (ctx.thread.parentThreadId !== null && ctx.thread.parentThreadId !== root) return;
        const pending = record.arms[sourceThreadId];
        if (!pending) return;
        if (pending.proofRequired || ownsLogicalProof) {
          if (!pending.proofRequired) return;
          const submission = ctx.experimental_submission;
          const proof = continuationProofSchema.safeParse(submission?.data);
          if (submission?.pluginId !== bb.pluginId || !proof.success || proof.data.rootThreadId !== root || proof.data.sourceThreadId !== sourceThreadId || proof.data.generation !== pending.generation || proof.data.composerKey !== pending.continuationComposerKey || pending.model !== ctx.requestedExecution.model || pending.reasoningLevel !== ctx.requestedExecution.reasoningLevel || (pending.serviceTier !== undefined && pending.serviceTier !== ctx.requestedExecution.serviceTier)) return;
        }
        const already = record.members.find((member) => member.id === ctx.thread.id);
        if (!already && !armMatches(pending, { sourceThreadId, providerId: ctx.requestedExecution.providerId, createdAt: ctx.thread.createdAt }, Date.now())) return;
        if (ctx.thread.providerId !== pending.providerId) return;
        const source = record.members.find((member) => member.id === sourceThreadId);
        if (!source || source.providerId === pending.providerId) return;
        await validateAssociation(root, ctx.thread.id);
        await context.prepare({ threadId: ctx.thread.id, projectId: record.projectId, sourceThreadId, rootThreadId: root });
        if (pending.proofRequired) {
          const proof = continuationProofSchema.parse(ctx.experimental_submission!.data);
          const claim = { ...proof, projectId: record.projectId, providerId: ctx.requestedExecution.providerId, model: ctx.requestedExecution.model, reasoningLevel: ctx.requestedExecution.reasoningLevel, serviceTier: ctx.requestedExecution.serviceTier };
          const existingClaim = await kv.get<unknown>(PROOF + ctx.thread.id);
          if (existingClaim && JSON.stringify(existingClaim) !== JSON.stringify(claim)) throw new Error("This native successor already belongs to a different continuation preparation.");
          await kv.set(PROOF + ctx.thread.id, claim);
        }
        const member: NativeSessionMember = { id: ctx.thread.id, sourceThreadId, kind: "continuation", providerId: ctx.thread.providerId, environmentId: ctx.thread.environmentId, model: ctx.requestedExecution.model, reasoningLevel: ctx.requestedExecution.reasoningLevel, serviceTier: ctx.requestedExecution.serviceTier, title: (ctx.thread.title ?? ctx.thread.titleFallback ?? record.title).slice(0, 500), status: ctx.thread.status, createdAt: ctx.thread.createdAt };
        const next = appendNativeMember(record, member, pending);
        delete next.arms[sourceThreadId];
        next.warning = null;
        // A model the user just started in the root's own workspace is their local choice. If the root cannot
        // be read right now, grouping still goes ahead and the choice is left as it was.
        if (next.activeThreadId === member.id) {
          try {
            const rootThread = await bb.sdk.threads.get({ threadId: root });
            if (rootThread.environmentId && member.environmentId === rootThread.environmentId) next.lastLocalThreadId = member.id;
          } catch { /* previous behaviour */ }
        }
        await save(next);
        // Complete all durable writes before hiding the native successor.
        await indexAssociation(next, member.id);
        await kv.delete(ARM_LOOKUP + sourceThreadId);
        // Core delete recursively follows parentThreadId, including hidden rows.
        // Logical members therefore stay top-level; the durable index groups them.
        await bb.sdk.threads.update({ threadId: member.id, parentThreadId: null, visibility: "hidden" });
        publish(root);
      });
    });
  }

  async function parallelContext(ctx: MessageDispatchHookContext) {
    if (ctx.thread.status !== "pending" || ctx.thread.providerId === "fleet-mirror" || ctx.attempt !== "start-turn" || ctx.originPluginId !== bb.pluginId || ctx.thread.originPluginId !== bb.pluginId || ctx.queuedMessages.length) return;
    await serial(INDEX_LOCK, async () => {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: ctx.thread.id, pluginId: bb.pluginId });
      const claim = metadata.nativeConversation as { rootThreadId?: string; sourceThreadId?: string; kind?: string } | undefined;
      if (claim?.kind !== "parallel" || !claim.rootThreadId || !claim.sourceThreadId || ctx.thread.projectId !== ctx.project.id) return;
      const root = await rootFor(claim.sourceThreadId);
      if (root !== claim.rootThreadId) return;
      const record = await getRecord(root);
      if (!record || record.projectId !== ctx.thread.projectId || !record.members.some((member) => member.id === claim.sourceThreadId) || (ctx.thread.parentThreadId !== null && ctx.thread.parentThreadId !== root)) return;
      const source = await bb.sdk.threads.get({ threadId: claim.sourceThreadId });
      if (source.projectId !== record.projectId || source.deletedAt !== null) return;
      try { await context.prepare({ threadId: ctx.thread.id, projectId: record.projectId, sourceThreadId: claim.sourceThreadId, rootThreadId: root }); }
      catch (cause) {
        record.warning = `Automatic recent context could not be supplied to the parallel model: ${cause instanceof Error ? cause.message : String(cause)}`;
        await save(record); publish(root);
      }
    });
  }

  bb.rpc.register(nativeContinuationPreparationContract, { native_session_prepare_cancel: cancelArm });

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const submission = ctx.experimental_submission;
    const ownContinuation = submission?.pluginId === bb.pluginId && submission.data !== null && typeof submission.data === "object" && !Array.isArray(submission.data) && submission.data.kind === "logical-continuation-v1";
    try {
      await parallelContext(ctx);
      await capture(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.error(`Native conversation association failed; provider session remains accessible: ${message}`);
      const source = nativeHandoffSource(ctx.input.blocks);
      const root = source ? await rootFor(source).catch(() => undefined) : undefined;
      if (root) {
        await mutateRoot(root, async () => {
          const record = await getRecord(root);
          if (record) { record.warning = `A model continuation could not be grouped: ${message}`; await save(record); }
        }).catch(() => undefined);
        publish(root);
      }
    }
    if (ownContinuation) {
      const proof = continuationProofSchema.safeParse(submission?.data);
      const claim = await kv.get<{ rootThreadId?: string; sourceThreadId?: string; generation?: string; composerKey?: string; projectId?: string; providerId?: string; model?: string | null; reasoningLevel?: string | null; serviceTier?: string | null }>(PROOF + ctx.thread.id);
      const record = proof.success ? await getRecord(proof.data.rootThreadId) : undefined;
      const member = record?.members.find((entry) => entry.id === ctx.thread.id);
      if (!proof.success || !claim || !member || record?.projectId !== ctx.project.id || claim.projectId !== ctx.project.id || claim.rootThreadId !== proof.data.rootThreadId || claim.sourceThreadId !== proof.data.sourceThreadId || claim.generation !== proof.data.generation || claim.composerKey !== proof.data.composerKey || claim.providerId !== ctx.requestedExecution.providerId || claim.model !== ctx.requestedExecution.model || claim.reasoningLevel !== ctx.requestedExecution.reasoningLevel || claim.serviceTier !== ctx.requestedExecution.serviceTier || member.sourceThreadId !== proof.data.sourceThreadId) return { action: "reject", message: "Conversation preparation became stale or could not be verified. Your draft is kept; choose the model again." };
    }
    return { action: "proceed" };
  });

  const notifyMember = async (threadId: string) => {
    const root = await kv.get<string>(LOOKUP + threadId);
    if (root && await usableRoot(root)) publish(root);
  };
  bb.events.on("thread.active", ({ thread }) => notifyMember(thread.id));
  bb.events.on("thread.idle", ({ thread }) => notifyMember(thread.id));
  bb.events.on("thread.failed", ({ thread }) => notifyMember(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => { context.forget(thread.id); return notifyMember(thread.id); });
  bb.events.on("interaction.pending", ({ thread }) => notifyMember(thread.id));

  return { state, index, arm, cancelArm, select, adopt, adoptStarted };
}

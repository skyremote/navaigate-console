import { useEffect } from "react";
import type { ComposerAttachment, ComposerDraftSnapshot, ComposerSelection, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { nativeContextAttachmentContract } from "../server-native-context";
import type { nativeContinuationPreparationContract } from "../server-native-sessions";
import type { rpcContract } from "../server";
import { useRpc } from "@get-bb/plugin-sdk/app";

export type NativeContinuationIntent = { prepare(context: { sourceThreadId: string; selection: ComposerSelection; draft: ComposerDraftSnapshot; signal: AbortSignal }): Promise<{ data: JsonValue; attachments?: readonly ComposerAttachment[] }>; standalone?(context: { sourceThreadId: string; selection: ComposerSelection; draft: ComposerDraftSnapshot; signal: AbortSignal }): Promise<{ data: JsonValue }> | { data: JsonValue } };
type ContinuationComposer = PluginComposerApi & { experimental_setContinuationIntent?: (intent: NativeContinuationIntent | null) => boolean };
const managed = new Map<string, number>();
export const hasNativeContinuationIntent = (composer: PluginComposerApi) => (managed.get(composer.key) ?? 0) > 0;
const aborted = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Conversation preparation was cancelled. Your draft is kept."); };
export function appendNativeContextAttachment(composer: PluginComposerApi, attachment: ComposerAttachment) {
  composer.replace((current) => current.attachments.some((item) => item.path === attachment.path && item.sourceProjectId === attachment.sourceProjectId && item.hostId === attachment.hostId) ? current : { text: current.text, mentions: current.mentions, attachments: [...current.attachments, attachment] });
}
export function useNativeContinuationIntent(composer: PluginComposerApi) {
  const sessions = useRpc<typeof rpcContract>();
  const context = useRpc<typeof nativeContextAttachmentContract>();
  const cancellations = useRpc<typeof nativeContinuationPreparationContract>();
  const sourceThreadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  useEffect(() => {
    const setter = (composer as ContinuationComposer).experimental_setContinuationIntent;
    if (!sourceThreadId || typeof setter !== "function") return;
    const intent: NativeContinuationIntent = { standalone: ({ sourceThreadId: actualSource, signal }) => { aborted(signal); if (actualSource !== sourceThreadId) throw new Error("The standalone handoff source changed. Your draft is kept."); return { data: { kind: "standalone-handoff-v1", sourceThreadId, composerKey: composer.key } }; }, prepare: async ({ sourceThreadId: actualSource, selection, signal }) => {
      if (actualSource !== sourceThreadId || !selection.providerId || !selection.model || !selection.reasoningLevel) throw new Error("The native continuation selection is incomplete. Your draft is kept.");
      aborted(signal);
      const state = await sessions.call("native_session_state", { threadId: sourceThreadId });
      const source = state.members.find((member) => member.id === sourceThreadId);
      if (!source || source.providerId === selection.providerId || source.providerId === "fleet-mirror") throw new Error("This is not a native cross-provider continuation.");
      aborted(signal);
      const capabilities = await context.call("native_context_capabilities", null);
      const attachments: ComposerAttachment[] = [];
      if (!capabilities.agentContext) {
        const result = await context.call("native_context_attachment", { sourceThreadId, rootThreadId: state.rootThreadId, projectId: state.projectId });
        attachments.push(result.attachment);
      }
      aborted(signal);
      const armed = await sessions.call("native_session_arm", { threadId: sourceThreadId, selection: { providerId: selection.providerId, model: selection.model, reasoningLevel: selection.reasoningLevel, ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}) }, proofRequired: true, expectedVersion: state.version, continuationComposerKey: composer.key });
      const pending = armed.pending;
      if (!pending) throw new Error("The conversation could not prepare its selected model. Your draft is kept.");
      const cancel = () => { void cancellations.call("native_session_prepare_cancel", { threadId: sourceThreadId, generation: pending.generation }).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      if (armed.rootThreadId !== state.rootThreadId || armed.projectId !== state.projectId || pending.sourceThreadId !== sourceThreadId || pending.providerId !== selection.providerId || pending.continuationComposerKey !== composer.key || !pending.proofRequired) { cancel(); throw new Error("The logical conversation changed while preparing. Your draft is kept."); }
      if (signal.aborted) { cancel(); aborted(signal); }
      return { data: { kind: "logical-continuation-v1", rootThreadId: state.rootThreadId, sourceThreadId, generation: pending.generation, composerKey: composer.key }, attachments };
    } };
    if (!setter.call(composer, intent)) return;
    managed.set(composer.key, (managed.get(composer.key) ?? 0) + 1);
    return () => {
      setter.call(composer, null);
      const count = (managed.get(composer.key) ?? 1) - 1;
      if (count > 0) managed.set(composer.key, count); else managed.delete(composer.key);
    };
  }, [composer, sourceThreadId, sessions, context, cancellations]);
}

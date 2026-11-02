import { useFeature } from "./use-feature";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ThreadChat,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useAppPanel as useAppPanel,
  useBbContext, useBbNavigate, useComposer, useComposers, useRpc, useSdk, useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { z } from "zod";
import type { nativeContextAttachmentContract } from "../server-native-context";
import type { nativeContinuationPreparationContract } from "../server-native-sessions";
import { appendNativeContextAttachment, hasNativeContinuationIntent, useNativeContinuationIntent } from "./native-continuation";
import type { nativeSessionStateSchema } from "../server-native-sessions";
import { localActiveThread, selectionRoute } from "./native-session-model";
import { findSessionWindow, mountSessionWindow } from "./native-session-dom";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { Boundary } from "./boundary";
import { isTransientRpcFailure, rpcFlight } from "./rpc-flight";
import { useVisibleRealtime } from "./visible-poll";
import { NativeWorkComposer } from "./native-work-composer";
import { conversationContextActions, useConversationContextActions } from "./context-workspace";
import { ghostButton } from "./controls";

type PluginThreadHeaderActionProps = { threadId: string; projectId?: string; isCompactViewport?: boolean };

type Session = z.infer<typeof nativeSessionStateSchema>;
const explain = (error: unknown) => error instanceof Error ? error.message : String(error);
const button = ghostButton;

export { selectionRoute, localActiveThread };

/** A saved selection may come from another window. It cannot move this route
 * into a mirror or a different workspace merely because its state refreshed. */
export function sessionForRoute(session: Session | null, threadId: string | null): Session | null {
  if (!session || !threadId || session.activeThreadId === threadId) return session;
  const member = session.members.find((entry) => entry.id === threadId);
  if (!member) return session;
  const active = threadId === session.rootThreadId ? localActiveThread(session) : threadId;
  if (active === session.activeThreadId) return session;
  return { ...session, activeThreadId: active, pending: session.pending?.sourceThreadId === active ? session.pending : null };
}

function useSession(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [session, setSession] = useState<Session | null>(null);
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentThread = useRef(threadId);
  const settledThread = useRef<string | null>(null);
  const request = useRef(0);
  currentThread.current = threadId;
  const load = useCallback((fresh: boolean) => {
    if (!threadId) return;
    const sequence = ++request.current;
    const current = () => currentThread.current === threadId && request.current === sequence;
    void rpcFlight().call(`native_session_state:${threadId}`, () => rpc.call("native_session_state", { threadId }), { fresh }).then((value) => { if (current()) { settledThread.current = threadId; setLoadedThreadId(threadId); setSession(value); setError(null); } }, (cause: unknown) => { if (current()) { setLoadedThreadId(threadId); if (settledThread.current !== threadId || !isTransientRpcFailure(cause)) { settledThread.current = null; setSession(null); } setError(explain(cause)); } });
  }, [rpc, threadId]);
  const refresh = useCallback(() => load(true), [load]);
  const entered = useRef(false);
  useEffect(() => { settledThread.current = null; setSession(null); setError(null); load(entered.current); entered.current = true; }, [load]);
  useVisibleRealtime("native-sessions", refresh);
  const visible = loadedThreadId === threadId ? sessionForRoute(session, threadId) : null;
  return { session: visible, routeScoped: visible !== null && visible !== session, error: loadedThreadId === threadId ? error : null, refresh };
}

function ModelName({ member }: { member: Session["members"][number] }) {
  return <><span>{member.providerId === "claude-code" ? "Claude" : member.providerId === "codex" ? "Codex" : member.providerId}</span><span className="truncate text-muted-foreground">{member.model ?? "Default model"}</span></>;
}

/** Uses the exact active native composer; the host owns handoff and uploads. */
export function NativeModelsHeader(props: PluginThreadHeaderActionProps) {
  const { session } = useSession(props.threadId);
  const composers = useComposers();
  const activeId = session?.activeThreadId ?? props.threadId;
  const matches = composers.filter((item) => item.scope.kind === "thread" && item.scope.threadId === activeId);
  return <NativeModelsControl {...props} boundComposer={matches.length === 1 ? matches[0] : undefined} />;
}

/** Selection is bound to the exact native composer whose action was clicked. */
export function NativeModelsComposer() {
  const composer = useComposer();
  return composer.scope.kind === "thread" ? <NativeModelsControl threadId={composer.scope.threadId} boundComposer={composer} /> : null;
}

export function NativeConversationComposerScope() {
  const composer = useComposer();
  useNativeContinuationIntent(composer);
  const id = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const { session } = useSession(id);
  const member = session?.members.find((entry) => entry.id === id);
  if (!session || !member || (session.members.length < 2 && member.providerId !== "fleet-mirror")) return null;
  return <div className="flex flex-wrap items-center gap-2 px-1 py-1 text-xs text-muted-foreground"><span>{session.title}</span><span>·</span><ModelName member={member} />{member.providerId === "fleet-mirror" ? <span>· Remote owner; this panel shows the local mirror workspace.</span> : null}</div>;
}

const NativeModelsControl = memo(function NativeModelsControl({ threadId, boundComposer }: PluginThreadHeaderActionProps & { boundComposer?: PluginComposerApi }) {
  const { session, error, refresh } = useSession(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const panel = useAppPanel();
  const navigate = useBbNavigate();
  const scope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const [alongside, setAlongside] = useState(false);
  const nextReplyOn = useFeature("F09");
  const [busy, setBusy] = useState(false);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<{ hostId: string; isGitRepo: boolean; branchName: string | null } | null>(null);
  const activeId = session?.activeThreadId ?? threadId;
  const composer = boundComposer?.scope.kind === "thread" && boundComposer.scope.threadId === activeId ? boundComposer : undefined;
  const member = session?.members.find((item) => item.id === activeId);
  const selected = composer?.selection;
  const value: ExperimentalProviderModelPickerValue = {
    providerId: selected?.providerId ?? member?.providerId ?? "codex",
    model: selected?.model ?? member?.model ?? "",
    reasoningLevel: (selected?.reasoningLevel ?? member?.reasoningLevel ?? "medium") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(selected?.serviceTier ? { serviceTier: selected.serviceTier } : {}),
  };
  useEffect(() => {
    let live = true;
    setEnvironmentId(null);
    setWorkspace(null);
    void sdk.threads.get({ threadId: activeId, include: "environment" }).then(async (thread) => {
      if (!live) return;
      setEnvironmentId(thread.environmentId ?? null);
      if (thread.environmentId) {
        const environment = await sdk.environments.get({ environmentId: thread.environmentId });
        if (live) setWorkspace({ hostId: environment.hostId, isGitRepo: environment.isGitRepo, branchName: environment.branchName ?? null });
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [sdk, activeId]);

  const attachmentRpc = useRpc<typeof nativeContextAttachmentContract>();
  const preparationRpc = useRpc<typeof nativeContinuationPreparationContract>();
  const change = async (next: ExperimentalProviderModelPickerValue) => {
    if (!composer || busy) return;
    setBusy(true);
    let armedGeneration: string | null = null;
    try {
      const physical = session?.members.find((item) => item.id === activeId)?.providerId;
      if (!hasNativeContinuationIntent(composer)) {
        if (next.providerId !== physical) {
          if (!session) throw new Error("The logical conversation is still loading. Your draft is preserved.");
          const before = JSON.stringify(composer.selection);
          const result = await attachmentRpc.call("native_context_attachment", { sourceThreadId: activeId, rootThreadId: session.rootThreadId, projectId: session.projectId });
          if (JSON.stringify(composer.selection) !== before) throw new Error("The native selection changed while preparing context. Your later choice and draft are preserved.");
          const armed = await rpc.call("native_session_arm", { threadId: activeId, selection: next });
          armedGeneration = armed.pending?.generation ?? null;
          if (JSON.stringify(composer.selection) !== before) throw new Error("The native selection changed while preparing context. Your later choice and draft are preserved.");
          appendNativeContextAttachment(composer, result.attachment);
        } else await rpc.call("native_session_cancel", { threadId: activeId });
      }
      const actual = await composer.setSelection(next);
      if (actual.providerId !== next.providerId || actual.model !== next.model || actual.reasoningLevel !== next.reasoningLevel || (next.serviceTier !== undefined && actual.serviceTier !== next.serviceTier)) {
        throw new Error("That provider/model is not available in this session's environment. Your draft is preserved.");
      }
      refresh();
      toast.success("Next reply selected", { description: hasNativeContinuationIntent(composer) ? `${next.providerId} · ${next.model}. Send normally to continue this conversation.` : `${next.providerId} · ${next.model}. Context file attached; this BB version still uses native handoff controls.` });
    } catch (cause) { if (armedGeneration) await preparationRpc.call("native_session_prepare_cancel", { threadId: activeId, generation: armedGeneration }).catch(() => {}); toast.error("Model was not changed", { description: explain(cause) }); }
    finally { setBusy(false); }
  };

  return <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setAlongside(false); }}>
    <Dialog.Trigger asChild><button type="button" data-nav-part="header-action" className={button} title="Switch models or work with another model in this conversation" aria-label="Conversation models">Models{session && session.members.length > 1 ? <span className="rounded bg-muted px-1 text-[11px]">{session.members.length}</span> : null}</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" /><Dialog.Content {...scope} className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-xl">
      <div className="flex items-start justify-between gap-3 border-b border-border p-4"><div><Dialog.Title className="text-sm font-medium">Models in this conversation</Dialog.Title><Dialog.Description className="mt-1 text-xs text-muted-foreground">Choose the next reply, or add another model alongside the current work.</Dialog.Description></div><Dialog.Close className={button} aria-label="Close conversation models">Close</Dialog.Close></div>
      <div className="min-h-0 overflow-y-auto p-4">
        {error ? <p role="alert" className="mb-3 text-xs text-destructive-text">{error}</p> : null}
        {session?.warning ? <p role="status" className="mb-3 text-xs text-muted-foreground">{session.warning}</p> : null}
        {member?.providerId === "fleet-mirror" ? <p className="text-sm">Replies and stops run on the owning Mac. Files, diff and terminal here show the local mirror workspace; open the owner for remote files. Add a model alongside to use another provider.</p> : <>
          {nextReplyOn ? <>
          <p className="mb-2 text-xs font-medium">Next reply</p>
          <ProviderModelPicker value={value} routing={environmentId ? { kind: "environment", environmentId } : undefined} onChange={(next) => void change(next)} disabled={busy || !composer || !member} />
          <p className="mt-2 text-xs text-muted-foreground">{session?.pending ? "A provider change is ready. Send your next message normally; the native continuation remains part of this conversation." : "Model and effort changes apply to the next native turn. Running work continues until you stop it."}</p>
          {!composer ? <p role="status" className="mt-2 text-xs text-muted-foreground">Use Models beside the active composer to choose its next reply. Each open view has its own execution selection.</p> : null}
          </> : null}
        </>}
        {session && session.members.length > 1 ? <div className="mt-4 space-y-1"><p className="mb-2 text-xs font-medium">Models and continuations</p>{session.members.map((item) => <button key={item.id} type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent disabled:opacity-60" disabled={busy} aria-pressed={activeId === item.id} onClick={async () => {
          setBusy(true);
          try { await rpc.call("native_session_select", { rootThreadId: session.rootThreadId, threadId: item.id }); const target = selectionRoute(session, item.id); if (target !== threadId) navigate.toThread(target); refresh(); setOpen(false); }
          catch (cause) { toast.error(explain(cause)); } finally { setBusy(false); }
        }}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.status === "active" ? "bg-[var(--attention)]" : "bg-muted-foreground"}`} /><span className="flex min-w-0 flex-1 gap-2"><ModelName member={item} /></span><span className="text-muted-foreground">{item.status}</span>{activeId === item.id ? <span>Selected</span> : null}</button>)}</div> : null}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
          <button type="button" className={button} onClick={() => setAlongside((current) => !current)} disabled={!session}>Add a model alongside</button>
          <button type="button" className={button} onClick={() => { setOpen(false); panel.openTab({ tab: { id: "native-conversation", context: { kind: "thread" }, availability: "action" }, params: {}, title: "Conversation" }); }}>Open conversation view</button>
        </div>
        {alongside && session ? <div className="mt-3 min-h-[260px] rounded-lg border border-border p-2"><NativeWorkComposer
          rootThreadId={session.rootThreadId} sourceThreadId={activeId} projectId={session.projectId}
          defaultSelection={member?.providerId === "fleet-mirror" ? undefined : value}
          defaultEnvironment={workspace?.isGitRepo ? { type: "host", hostId: workspace.hostId, workspace: { type: "managed-worktree", baseBranch: workspace.branchName ? { kind: "named", name: workspace.branchName } : { kind: "default" } } } : environmentId ? { type: "reuse", environmentId } : undefined}
          onStarted={(started) => { refresh(); if (started.kind === "local") setAlongside(false); }}
        /></div> : null}
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
});

function ConversationView({ session }: { session: Session }) {
  const composers = useComposers();
  const matches = composers.filter((item) => item.scope.kind === "thread" && item.scope.threadId === session.activeThreadId);
  return <BoundConversationView session={session} contextComposer={matches.length === 1 ? matches[0] : undefined} />;
}

const BoundConversationView = memo(function BoundConversationView({ session, contextComposer }: { session: Session; contextComposer?: PluginComposerApi }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const select = (threadId: string) => void rpc.call("native_session_select", { rootThreadId: session.rootThreadId, threadId }).then(() => { const target = selectionRoute(session, threadId); if (target !== session.rootThreadId) navigate.toThread(target); }, (cause: unknown) => toast.error(explain(cause)));
  const contextActions = useMemo(() => conversationContextActions(session.activeThreadId, contextComposer ? [contextComposer] : []), [session.activeThreadId, contextComposer]);
  const selectedIndex = session.members.findIndex((member) => member.id === session.activeThreadId);
  const other = session.members.filter((member) => member.id !== session.activeThreadId);
  return <div className="flex h-full min-h-0 flex-col" data-native-conversation-root={session.rootThreadId} data-native-active-thread={session.activeThreadId}>
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2" role="tablist" aria-label="Conversation models">
      {session.members.map((member) => <button key={member.id} type="button" role="tab" aria-selected={member.id === session.activeThreadId} className={`${button} ${member.id === session.activeThreadId ? "bg-accent text-foreground" : ""}`} onClick={() => select(member.id)}><ModelName member={member} />{member.status === "active" ? <span aria-label="Working" className="h-1.5 w-1.5 rounded-full bg-[var(--attention)]" /> : null}</button>)}
    </div>
    <div className="min-h-0 flex-1"><ThreadChat key={session.activeThreadId} threadId={session.activeThreadId} messageActions={contextActions} variant="full" permissionPolicy="inherit" className="h-full" leadingContent={other.length ? <div>{other.map((member) => <section key={member.id} className="border-b border-border pb-3"><div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><ModelName member={member} /><span>{member.kind === "parallel" ? "Parallel session" : session.members.indexOf(member) < selectedIndex ? "Earlier session" : "Later session"}</span>{["active", "needs-input", "awaiting-input", "error"].includes(member.status) ? <button type="button" className={button} onClick={() => select(member.id)}>View and respond</button> : null}</div><ThreadChat threadId={member.id} messageActions={contextActions} variant="timeline" layout="document" /></section>)}</div> : undefined} /></div>
  </div>;
});

export function NativeConversationPanel({ threadId }: { threadId: string }) {
  const { session, error } = useSession(threadId);
  const contextActions = useConversationContextActions(session?.activeThreadId ?? threadId);
  if (error) return <p role="alert" className="p-4 text-sm text-destructive-text">{error}</p>;
  return session ? <div className="h-full overflow-y-auto p-4"><p className="mb-3 text-xs text-muted-foreground">Conversation history. Use the main conversation composer to reply; each model session retains its own context.</p>{session.members.map((member) => <section key={member.id} className="mb-4 border-b border-border pb-3"><div className="mb-2 flex gap-2 text-xs"><ModelName member={member} /><span>{member.kind}</span></div><ThreadChat threadId={member.id} messageActions={contextActions} variant="timeline" layout="document" /></section>)}</div> : <p className="p-4 text-sm text-muted-foreground">Loading conversation…</p>;
}

export function NativeConversationOverlay() {
  const { threadId } = useBbContext();
  const { session, routeScoped } = useSession(threadId);
  const layout = useSidebarSplitLayout();
  const navigate = useBbNavigate();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [suspended, setSuspended] = useState<string | null>(null);
  const panes = useMemo(() => layout?.panes.map((pane) => ({ paneId: pane.paneId, threadId: pane.threadId })) ?? null, [layout]);
  const rootId = session?.rootThreadId ?? null;
  const rootAlive = session?.members.some((member) => member.id === rootId && member.status !== "deleted") ?? false;
  const active = !!session && rootAlive && session.members.length > 1 && suspended !== rootId;
  const rootMember = session?.members.find((member) => member.id === rootId);
  const activeMember = session?.members.find((member) => member.id === session.activeThreadId);
  // BB's global files/diff/terminal panel follows the route. A native embedded
  // chat can share it only when its environment is the same as the root's.
  const sharedEnvironment = !!rootMember?.environmentId && rootMember.environmentId === activeMember?.environmentId && activeMember?.providerId !== "fleet-mirror";
  const routeTarget = sharedEnvironment ? rootId : session?.activeThreadId;
  // The root keeps its original native composer. Never mount a second execution
  // controller over the same physical thread, even when its draft is shared.
  const needsOverlay = active && sharedEnvironment && session.activeThreadId !== rootId && !panes?.some((pane) => pane.threadId === session.activeThreadId);
  useEffect(() => {
    if (active && !routeScoped && sharedEnvironment && threadId !== rootId && routeTarget && threadId !== routeTarget && !panes?.some((pane) => pane.threadId === routeTarget) && session?.members.some((member) => member.id === threadId)) navigate.toThread(routeTarget);
  }, [active, routeScoped, sharedEnvironment, rootId, routeTarget, threadId, navigate, session, panes]);
  useEffect(() => {
    if (!needsOverlay || !rootId || threadId !== rootId) { setSlot(null); return; }
    let mounted: ReturnType<typeof mountSessionWindow> = null;
    let scheduled = false;
    let alive = true;
    const sync = () => {
      scheduled = false;
      if (!alive) return;
      const target = findSessionWindow(document, rootId, panes);
      if (mounted?.slot.isConnected && mounted.original.isConnected && target === mounted.original) return;
      mounted?.dispose(); mounted = null;
      const original = target;
      if (!original) { setSlot(null); return; }
      mounted = mountSessionWindow(original);
      setSlot(mounted?.slot ?? null);
    };
    const schedule = () => { if (alive && !scheduled) { scheduled = true; queueMicrotask(sync); } };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true });
    sync();
    return () => { alive = false; observer.disconnect(); mounted?.dispose(); setSlot(null); };
  }, [needsOverlay, rootId, threadId, panes]);
  if (!slot || !session) return null;
  return createPortal(<Boundary label="Conversation" onFailure={() => setSuspended(rootId)}><ConversationView session={session} /></Boundary>, slot);
}

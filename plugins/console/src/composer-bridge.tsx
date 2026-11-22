// The composer API (draft text, pickers) exists only inside a composer surface,
// but the chips live in an app overlay in the footer row. This invisible
// composer action publishes each mounted composer's API and view, keyed by its
// scope, so the chips can read the draft or switch the machine picker.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { isMcpDraft, openMcpPage } from "./mcp-command";
import { featureNow } from "./use-feature";

/** The feature-map id of "/mcp opens the connector manager". */
export const MCP_FEATURE = "EXTRA-AJ";

export type ComposerHandle = {
  api: PluginComposerApi;
  view: {
    draft: PluginComposerApi["draft"] & { isEmpty: boolean };
    selection: PluginComposerApi["selection"];
  };
};

type NewChatSelection = Parameters<PluginComposerApi["setSelection"]>[0];
let pendingSelection: { choice: NewChatSelection; until: number } | null = null;

/** A model chosen on a page without a composer, applied once the next new-chat composer has mounted. */
export function queueNewChatSelection(choice: NewChatSelection, now: number = Date.now()) {
  pendingSelection = { choice, until: now + 30_000 };
}

const live = new Map<string, ComposerHandle>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const l of listeners) l();
};

export function publishComposerHandle(key: string, handle: ComposerHandle): void {
  live.set(key, handle);
  emit();
}
export function unpublishComposerHandle(key: string): void {
  if (live.delete(key)) emit();
}
/** The composer for a chat (threadId) or the new-thread screen (null), without subscribing to changes. */
export function getComposerHandle(threadId: string | null): ComposerHandle | null {
  return live.get(threadId ? `thread:${threadId}` : "new") ?? null;
}

function keyOf(scope: PluginComposerApi["scope"]): string {
  if (scope.kind === "thread") return `thread:${scope.threadId}`;
  if (scope.kind === "new-thread") return "new";
  return `queued:${scope.queuedMessageId}`;
}

export function ComposerBridge() {
  const api = useComposer();
  const view = useMemo(() => ({ draft: { ...api.draft, isEmpty: api.isEmpty }, selection: api.selection }), [api.draft, api.isEmpty, api.selection]);
  const key = keyOf(api.scope);
  useEffect(() => {
    publishComposerHandle(key, { api, view });
  }, [key, api, view]);
  // The host may clear the draft before onSubmitted fires, so remember the
  // last non-empty draft: a submit always carries a non-empty draft.
  const lastDraft = useRef<PluginComposerApi["draft"] | null>(null);
  if (!api.isEmpty) lastDraft.current = api.draft;
  useEffect(() => {
    if (api.scope.kind !== "thread") return;
    return api.onSubmitted(() => {
      // The MCP Manager page belongs to a separate plugin, so this is a feature of its own (off by default for the community).
      if (lastDraft.current && isMcpDraft(lastDraft.current) && featureNow(MCP_FEATURE)) openMcpPage();
      lastDraft.current = null;
    });
  }, [api]);
  useEffect(() => {
    if (api.scope.kind !== "new-thread" || !pendingSelection) return;
    const { choice, until } = pendingSelection;
    pendingSelection = null;
    if (Date.now() <= until) void api.setSelection(choice).catch(() => undefined);
  }, [api]);
  useEffect(
    () => () => {
      if (live.get(key)?.api === api) {
        live.delete(key);
        emit();
      }
    },
    [key, api],
  );
  return null;
}

/** The composer for a chat (threadId) or the new-thread screen (null), once it has mounted. */
export function useComposerHandle(threadId: string | null): ComposerHandle | null {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  return live.get(threadId ? `thread:${threadId}` : "new") ?? null;
}

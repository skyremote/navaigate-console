// The composer API (draft text, pickers) exists only inside a composer surface,
// but the chips live in an app overlay in the footer row. This invisible
// composer action publishes each mounted composer's API and view, keyed by its
// scope, so the chips can read the draft or switch the machine picker.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";

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

import type { BbNavigate, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export const SNOOZE_MS = 3_600_000;

export const snoozeWake = (now: number = Date.now()) => now + SNOOZE_MS;

export function composeIn(nav: Pick<BbNavigate, "toCompose">, projectId: string | null | undefined) {
  nav.toCompose({ projectId: projectId ?? undefined, focusPrompt: true });
}

export function setPinned(sdk: Pick<PluginBrowserBbSdk, "threads">, threadId: string, pinned: boolean) {
  return pinned ? sdk.threads.unpin({ threadId }) : sdk.threads.pin({ threadId });
}

import { useEffect, useState } from "react";
import {
  experimental_useAppPanel as useAppPanel,
  experimental_useRpcKeyedQuery as useKeyed,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { nativePrContract } from "../delivery-contract";
import { readiness } from "./delivery-model";

export const deliveryTabOpen = {
  tab: { id: "delivery", context: { kind: "thread" }, availability: "action" },
  title: "Delivery",
} as const;

function useThreadEnvironment(threadId: string): string | null {
  const sdk = useSdk();
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void sdk.threads
      .get({ threadId })
      .then((thread) => {
        if (live) setEnvironmentId(thread.environmentId ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sdk, threadId]);
  return environmentId;
}

export function DeliveryHeaderButton({ threadId }: { threadId: string }) {
  const panel = useAppPanel();
  const environmentId = useThreadEnvironment(threadId);
  const watched = useKeyed({
    pluginId: "bb--github-pr-status",
    contract: nativePrContract,
    method: "pullRequests",
    keys: environmentId ? [environmentId] : [],
  });
  const result = environmentId ? watched.data?.[environmentId] : undefined;
  const state = result?.outcome === "available" ? readiness(result) : null;
  return (
    <button
      type="button"
      title="Delivery: pull requests, worktrees, review, research and diagnosis (⌘⇧Y)"
      data-nav-part="header-action"
      onClick={() => panel.openTab(deliveryTabOpen as never)}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <circle cx="4" cy="3.5" r="1.7" />
        <circle cx="4" cy="12.5" r="1.7" />
        <circle cx="12" cy="12.5" r="1.7" />
        <path d="M4 5.2v5.6M12 10.8V6.5a2 2 0 0 0-2-2H8.5" />
      </svg>
      Delivery
      {state ? (
        <span data-nav-part="count" className="rounded-full bg-foreground px-1.5 text-[11px] font-medium text-background">
          {state.label.split(";")[0]}
        </span>
      ) : null}
    </button>
  );
}

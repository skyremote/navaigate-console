import type { WebhookFormState } from "../server-webhook-admin";

export type Delivery = WebhookFormState["deliveries"][number];
export type HookView = WebhookFormState["hooks"][number];

export const DEFAULT_PROVIDER = "claude-code";
export const PREFERRED_MODEL = "claude-sonnet-5-5";

export type HookDraft = {
  name: string;
  projectId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  prompt: string;
  enabled: boolean;
  holdOffline: boolean;
  coalesceSeconds: number;
};

export const emptyDraft = (): HookDraft => ({
  name: "",
  projectId: "",
  providerId: DEFAULT_PROVIDER,
  model: "",
  reasoningLevel: "medium",
  prompt: "",
  enabled: true,
  holdOffline: true,
  coalesceSeconds: 0,
});

export const draftFromHook = (hook: HookView): HookDraft => ({
  name: hook.id,
  projectId: hook.projectId,
  providerId: hook.agent?.providerId || DEFAULT_PROVIDER,
  model: hook.agent?.model ?? "",
  reasoningLevel: hook.agent?.reasoningLevel ?? "medium",
  prompt: hook.agent?.prompt ?? "",
  enabled: hook.enabled,
  holdOffline: hook.holdOffline,
  coalesceSeconds: hook.coalesceSeconds,
});

/** A hook name is its id on the wire, so what the person types is folded into the allowed alphabet as they type. */
export const slugifyHookName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[\s.]+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 48);

/** The model the form starts on for a provider: Sonnet 5.5 for Claude when the provider lists it, else the provider's own default. */
export function defaultModelFor(
  providerId: string,
  models: readonly { model: string; isDefault?: boolean }[],
): string | null {
  if (providerId === DEFAULT_PROVIDER) {
    const preferred = models.find((m) => m.model === PREFERRED_MODEL);
    if (preferred) return preferred.model;
  }
  return models.find((m) => m.isDefault)?.model ?? models[0]?.model ?? null;
}

export function draftProblem(draft: HookDraft, taken: readonly string[], editing: boolean): string | null {
  if (!draft.name) return "Give the hook a name.";
  if (!editing && taken.includes(draft.name)) return "A hook with this name already exists.";
  if (!draft.projectId) return "Choose the project the task runs in.";
  if (!draft.model) return "Choose a model.";
  if (!draft.prompt.trim()) return "Write what the agent should do.";
  if (!Number.isInteger(draft.coalesceSeconds) || draft.coalesceSeconds < 0 || draft.coalesceSeconds > 3600)
    return "Merge window must be between 0 and 3600 seconds.";
  return null;
}

/** A shell command a sender can adapt. The secret is never interpolated: it is read from the environment. */
export function curlExample(endpoint: string, hookId: string): string {
  return [
    `BODY='{"event":"example"}'`,
    `DELIVERY=$(uuidgen)`,
    `TS=$(python3 -c 'import time;print(int(time.time()*1000))')`,
    `SIG="sha256=$(printf '%s' "v1.${hookId}.$TS.$DELIVERY.$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"`,
    `curl -X POST '${endpoint}' -H 'content-type: application/json' \\`,
    `  -H 'x-nav-hook: ${hookId}' -H "x-nav-delivery: $DELIVERY" -H "x-nav-timestamp: $TS" -H "x-nav-signature: $SIG" \\`,
    `  -d "$BODY"`,
  ].join("\n");
}

const STATE_LABEL: Record<Delivery["state"], string> = {
  accepted: "Received, waiting for the next pass",
  held: "Held: the owning machine is offline",
  dispatching: "Starting",
  "owner-accepted": "Started",
  unknown: "Outcome unknown, will not be retried",
  refused: "Refused",
  expired: "Expired before it could start",
  coalesced: "Merged into an earlier event",
};
export const deliveryLabel = (state: Delivery["state"]): string => STATE_LABEL[state];

export const deliveryTone = (state: Delivery["state"]): "good" | "wait" | "bad" =>
  state === "owner-accepted" ? "good" : state === "refused" || state === "expired" || state === "unknown" ? "bad" : "wait";

export function deliveriesFor(deliveries: readonly Delivery[], hookId: string | null): Delivery[] {
  return deliveries.filter((d) => hookId === null || d.hookId === hookId);
}

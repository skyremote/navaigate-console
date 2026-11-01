import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { rpcContract } from "../server";
import { rpcFlight } from "./rpc-flight";
import { harnessOf } from "./shared";
import { planName, resetLabel, shortLabel } from "./usage-dock";
import { useVisiblePoll } from "./visible-poll";

/**
 * The plan allowance for a provider, read the same way the usage dock reads
 * it (the pooled account first, then the provider's own login), so it can be
 * shown before a chat or a job exists.
 */
const POOL_PROVIDER: Record<string, "claude" | "codex"> = { "claude-code": "claude", codex: "codex" };
const poolUsage = z.object({
  usage: z.object({
    status: z.string(), accountEmail: z.string().nullable().optional(), planLabel: z.string().nullable().optional(),
    windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable(), kind: z.string().optional(), model: z.string().nullable().optional() }).passthrough()).optional(),
  }).passthrough(),
}).passthrough();

export type AllowanceWindow = { label: string; pct: number; resetsAt: string | null };
export type Allowance = { windows: AllowanceWindow[]; plan: string | null; source: "pool" | "local" };
export type AllowanceLine = { label: string; left: number; reset: string; tone: "ok" | "warn" | "danger" };

const clamp = (value: number) => Math.max(0, Math.min(100, value));

/** Session first, then the fullest other window, each as what is left and its reset time. */
export function allowanceSummary(windows: readonly AllowanceWindow[]): AllowanceLine[] {
  const session = windows.find((window) => window.label === "Session");
  const others = windows.filter((window) => window !== session).sort((a, b) => b.pct - a.pct);
  return [session, others[0]].filter((window): window is AllowanceWindow => !!window).map((window) => {
    const used = clamp(window.pct);
    return { label: window.label, left: Math.round(100 - used), reset: resetLabel(window.resetsAt), tone: used >= 90 ? "danger" : used >= 70 ? "warn" : "ok" };
  });
}

type Sdk = ReturnType<typeof useSdk>;
type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export async function loadAllowance(sdk: Sdk, rpc: Rpc, providerId: string): Promise<Allowance | null> {
  const pool = POOL_PROVIDER[providerId];
  if (pool) {
    try {
      const { accountId, activeAccountId } = await rpc.call("pool_account", { provider: pool, sessionId: null });
      const id = accountId ?? activeAccountId;
      if (id) {
        const result = await sdk.plugins.callRpc({ pluginId: "account-pool", method: "provider-usage.v1.getResource", input: { resourceId: id, refresh: false }, outputSchema: poolUsage });
        if (result.usage.status === "ok" && result.usage.windows) {
          return { windows: result.usage.windows.map((window) => ({ label: shortLabel({ label: window.label, kind: window.kind, model: window.model ?? undefined }), pct: window.usedPercent, resetsAt: window.resetsAt })), plan: result.usage.planLabel ?? null, source: "pool" };
        }
      }
    } catch { /* The pool is off or changed: use the provider's own login. */ }
  }
  const all = (await sdk.system.usageLimits({ providerId })) as unknown as Record<string, { status: string; planLabel?: string | null; windows?: Array<{ label: string; usedPercent: number; resetsAt: string | null; kind?: string; model?: string }> }>;
  const entry = all[providerId];
  if (!entry || entry.status !== "ok" || !entry.windows) return null;
  return { windows: entry.windows.map((window) => ({ label: shortLabel(window), pct: window.usedPercent, resetsAt: window.resetsAt })), plan: entry.planLabel ?? null, source: "local" };
}

const ALLOWANCE_POLL_MS = 60_000;
const ALLOWANCE_TTL_MS = 30_000;

export function useAllowance(providerId: string | null): { allowance: Allowance | null; loading: boolean } {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ providerId: string; allowance: Allowance | null } | null>(null);
  const shown = useRef(providerId);
  shown.current = providerId;
  const read = useCallback(() => {
    if (!providerId) return;
    const settle = (allowance: Allowance | null) => {
      if (shown.current === providerId) setState({ providerId, allowance });
    };
    void rpcFlight().call(`allowance:${providerId}`, () => loadAllowance(sdk, rpc, providerId), { ttlMs: ALLOWANCE_TTL_MS }).then(
      settle,
      () => settle(null),
    );
  }, [sdk, rpc, providerId]);
  useEffect(read, [read]);
  useVisiblePoll(read, providerId ? ALLOWANCE_POLL_MS : null);
  const current = state?.providerId === providerId ? state : null;
  return { allowance: current?.allowance ?? null, loading: !!providerId && !current };
}

const TONE = { ok: "text-foreground", warn: "text-warning-text", danger: "text-destructive-text" } as const;

/** A quiet line: who the allowance belongs to, and what is left in each window with its reset time. */
export function AllowanceChip({ providerId, className, compact = false }: { providerId: string | null; className?: string; compact?: boolean }) {
  const { allowance, loading } = useAllowance(providerId);
  if (!providerId) return null;
  const harness = harnessOf(providerId).label;
  const all = allowance ? allowanceSummary(allowance.windows) : [];
  const lines = compact ? all.slice(0, 1) : all;
  const title = all.length ? `${planName(harness, allowance?.plan ?? null)}: ${all.map((line) => `${line.label} ${line.left}% left${line.reset ? `, ${line.reset}` : ""}`).join("; ")}` : "Plan allowance left on the account this provider runs on";
  return <span data-testid="allowance-chip" data-nav-part="allowance-chip" className={`inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground ${className ?? ""}`} style={{ fontVariantNumeric: "tabular-nums" }} title={title}>
    {compact ? null : <span className="font-medium">{allowance ? planName(harness, allowance.plan) : harness}</span>}
    {loading ? <span>Reading allowance…</span> : !allowance || lines.length === 0 ? <span>Allowance not reported</span> : lines.map((line) => <span key={line.label}>
      {line.label} <span className={TONE[line.tone]}>{line.left}% left</span>{line.reset ? <span> · {line.reset}</span> : null}
    </span>)}
  </span>;
}

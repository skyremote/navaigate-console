import { createHash } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { knownMachine, machineKeys, machineName } from "./server-words";

export const USAGE_FRESH_MS = 5 * 60_000;
export type UsageHarness = "claude" | "codex" | "cursor" | "other";
export const usageSourceSchema = z.object({
  kind: z.enum(["pool", "owner", "cursor"]), provider: z.string(), label: z.string(),
  machines: z.array(z.string()), ownerServerId: z.string().nullable(), hostId: z.string().nullable(),
  identity: z.enum(["token-verified", "confirmed", "unknown"]), freshness: z.enum(["fresh", "stale", "unavailable", "unknown"]),
});
export type UsageSource = z.infer<typeof usageSourceSchema>;
export const fleetUsageCoverageSchema = z.object({ machine: z.string(), ownerServerId: z.string().nullable(), hostId: z.string().nullable(), state: z.enum(["fresh", "stale", "unavailable", "self"]), providers: z.record(z.string(), z.enum(["fresh", "unavailable"])).optional() });
export type FleetUsageCoverage = z.infer<typeof fleetUsageCoverageSchema>;
export type UsageReadingWindow = { id: string; label: string; kind: string; model: string | null; pct: number; resetsAt: number | null; observedAt?: number; source?: UsageSource };
export type UsageReading = { linkKey?: string; id: string; provider: string; harness: UsageHarness; email: string | null; plan: string | null; status: "ok" | "error"; observedAt: number; subscriptionId: string | null; source: UsageSource; windows: UsageReadingWindow[] };
export type FleetUsageRead = { readings: UsageReading[]; coverage: FleetUsageCoverage[] };
export const nativeResult = z.object({ state: z.enum(["ok", "unavailable"]), reason: z.string().nullable(), snapshot: z.object({
  ownerServerId: z.string().min(1), hostId: z.string().nullable(), observedAt: z.number(),
  providers: z.array(z.object({ providerId: z.string(), status: z.enum(["ok", "unavailable", "error"]), subscriptionId: z.string().nullable(), identity: z.enum(["unknown", "verified"]), planLabel: z.string().nullable(), observationId: z.string(), method: z.literal("bb.system.usageLimits"), windows: z.array(z.object({ label: z.string(), usedPercent: z.number().nullable(), resetsAt: z.string().nullable() })).max(50) })).max(30),
}).nullable() });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const canonicalUsageProvider = (provider: string) => provider === "claude-code" || provider === "provider-claude-code" ? "claude" : provider === "provider-codex" ? "codex" : provider;
export const usageHarness = (provider: string): UsageHarness => provider === "claude" || provider === "codex" || provider === "cursor" ? provider : "other";
export const usageProviderLabel = (provider: string) => provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider === "cursor" ? "Cursor" : provider;
export function tokenBoundPoolSubscriptionId(provider: string, accountKey: unknown): string | null {
  if (provider !== "codex" || typeof accountKey !== "string" || !/^openai:chatgpt:[A-Za-z0-9_-]{6,128}$/.test(accountKey)) return null;
  return `bbsub1:${digest(`bb-usage-subscription-v1\0codex\0${accountKey}`).slice(0, 40)}`;
}
export function usageWindowKind(label: string, kind = "") {
  if (kind === "five-hour" || /five|5[ -]?hour|5h|session/i.test(label)) return "five-hour";
  if (kind === "daily" || /\bday|daily/i.test(label)) return "daily";
  if (kind === "monthly" || /month/i.test(label)) return "monthly";
  if (kind === "weekly" || /week/i.test(label)) return "weekly";
  return kind && kind !== "custom" ? kind : label.trim().toLowerCase();
}
export function usageWindowIdentity(window: Pick<UsageReadingWindow, "label" | "kind" | "model">) {
  const family = window.model?.toLowerCase() ?? (window.label.includes(" · ") ? window.label.split(" · ").slice(1).join(" · ").toLowerCase() : "");
  return `${usageWindowKind(window.label, window.kind)}:${family}`;
}
export const ownerLinkKey = (provider: string, hostId: string) => `${provider}:${hostId}:native-default`;
export const poolLinkKey = (provider: string, hostId: string, resourceId: string) => `${provider}:${hostId}:${resourceId}`;
export function allowanceIdFor(local: UsageReading[], reading: UsageReading): string {
  const pooled = reading.subscriptionId === null ? undefined : local.find((item) => item.provider === reading.provider && item.subscriptionId === reading.subscriptionId);
  return pooled?.id ?? reading.id;
}
export function createFleetUsageBridge(bb: BbPluginApi, options: { localOwner(): Promise<string | null>; now?: () => number; identityFor?(linkKey: string): Promise<string | null> }) {
  return async (): Promise<FleetUsageRead> => {
    const now = (options.now ?? Date.now)();
    const [localOwner, config, replies] = await Promise.all([
      options.localOwner().catch(() => null), bb.sdk.system.config().catch(() => null),
      Promise.all(machineKeys().map(async (machine) => {
        try { return { machine, result: nativeResult.parse(await bb.sdk.plugins.callRpc({ pluginId: "fleet", method: "usage_snapshot_fetch", input: { machine }, outputSchema: nativeResult, signal: AbortSignal.timeout(10_000) })) }; }
        catch { return { machine, result: null }; }
      })),
    ]);
    const readings: UsageReading[] = [];
    const coverage: FleetUsageCoverage[] = [];
    const seen = new Set<string>();
    for (const { machine, result } of replies.sort((a, b) => (b.result?.snapshot?.observedAt ?? 0) - (a.result?.snapshot?.observedAt ?? 0))) {
      const snapshot = result?.snapshot;
      if (result?.state !== "ok" || !snapshot?.hostId) { coverage.push({ machine, ownerServerId: null, hostId: null, state: "unavailable" }); continue; }
      if ((localOwner !== null && snapshot.ownerServerId === localOwner) || snapshot.hostId === config?.primaryHostId) { coverage.push({ machine, ownerServerId: snapshot.ownerServerId, hostId: snapshot.hostId, state: "self" }); continue; }
      const fresh = snapshot.observedAt <= now + 5000 && now - snapshot.observedAt <= USAGE_FRESH_MS;
      coverage.push({ machine, ownerServerId: snapshot.ownerServerId, hostId: snapshot.hostId, state: fresh ? "fresh" : "stale", providers: Object.fromEntries(snapshot.providers.map((item) => [canonicalUsageProvider(item.providerId), fresh && item.status === "ok" && item.windows.some((window) => window.usedPercent !== null && window.usedPercent >= 0) ? "fresh" as const : "unavailable" as const])) });
      const ownerKey = `${snapshot.ownerServerId}\0${snapshot.hostId}`;
      if (seen.has(ownerKey)) continue;
      seen.add(ownerKey);
      for (const native of snapshot.providers) {
        const provider = canonicalUsageProvider(native.providerId);
        const verifiedId = provider === "codex" && native.identity === "verified" && /^bbsub1:[a-f0-9]{40}$/.test(native.subscriptionId ?? "") ? native.subscriptionId : null;
        const linkKey = ownerLinkKey(provider, snapshot.hostId);
        const confirmedId = verifiedId ? null : await options.identityFor?.(linkKey).catch(() => null) ?? null;
        const subscriptionId = verifiedId ?? confirmedId;
        const source: UsageSource = { kind: "owner", provider, label: `${usageProviderLabel(provider)} · ${machineName(machine)}`, machines: [machine], ownerServerId: snapshot.ownerServerId, hostId: snapshot.hostId, identity: verifiedId ? "token-verified" : confirmedId ? "confirmed" : "unknown", freshness: !fresh ? "stale" : native.status === "ok" ? "fresh" : "unavailable" };
        const windows = native.windows.filter((window) => fresh && native.status === "ok" && window.usedPercent !== null && window.usedPercent >= 0 && (!window.resetsAt || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > now)).map((window) => ({ id: `owner:${usageWindowIdentity({ ...window, kind: "", model: null })}`, label: window.label, kind: usageWindowKind(window.label), model: window.label.includes(" · ") ? window.label.split(" · ").slice(1).join(" · ") : null, pct: window.usedPercent!, resetsAt: window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? Date.parse(window.resetsAt) : null, observedAt: snapshot.observedAt, source }));
        readings.push({ linkKey, id: `fleet-usage:${provider}:${subscriptionId ? `subscription:${subscriptionId}` : `owner:${digest(`${ownerKey}\0native-default`).slice(0, 32)}`}`, provider, harness: usageHarness(provider), email: null, plan: native.planLabel, status: source.freshness === "fresh" && windows.length > 0 ? "ok" : "error", observedAt: snapshot.observedAt, subscriptionId, source, windows });
      }
    }
    return { readings, coverage };
  };
}
export function mergeUsageReadings(local: UsageReading[], remote: UsageReading[]): UsageReading[] {
  const output = new Map<string, UsageReading>(local.map((reading) => [reading.id, { ...reading, windows: reading.windows.map((window) => ({ ...window, observedAt: reading.observedAt, source: reading.source })) }]));
  for (const reading of [...remote].sort((a, b) => a.observedAt - b.observedAt)) {
    const pooled = reading.subscriptionId === null ? undefined : local.find((item) => item.provider === reading.provider && item.subscriptionId === reading.subscriptionId);
    const id = allowanceIdFor(local, reading);
    const existing = output.get(id);
    if (!existing) { output.set(id, { ...reading, id }); continue; }
    if (reading.status !== "ok" || reading.source.freshness !== "fresh") continue;
    const windows = new Map(existing.windows.map((window) => [usageWindowIdentity(window), window]));
    for (const window of reading.windows) {
      const identity = usageWindowIdentity(window);
      const previous = windows.get(identity);
      if (previous && (previous.observedAt ?? existing.observedAt) >= reading.observedAt) continue;
      windows.set(identity, { ...window, id: previous?.id ?? window.id, observedAt: reading.observedAt, source: reading.source });
    }
    output.set(id, { ...existing, status: "ok", observedAt: Math.max(existing.observedAt, reading.observedAt), windows: [...windows.values()], source: pooled ? { ...existing.source, machines: [...new Set([...existing.source.machines, ...reading.source.machines])] } : reading.source });
  }
  return [...output.values()];
}

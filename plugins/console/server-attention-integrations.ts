import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HomeAccount } from "./server-home";
import { usageWindowIdentity } from "./server-usage-fleet";
import type { EventTransport, HookConfig } from "./server-event-inbox";
import { knownMachine, machineKeys, machineName } from "./server-words";

export const subscriptionObservation = z.object({
  provider: z.string(),
  accountId: z.string(),
  label: z.string().max(200).optional(),
  hostId: z.string(),
  subscriptionId: z.string().nullable(),
  observedAt: z.number().nullable(),
  collectedAt: z.number(),
  usedPercent: z.number().nullable(),
  resetsAt: z.string().nullable(),
  window: z.string().min(1).max(128),
});
export const subscriptionUsage = z.object({
  key: z.string(),
  label: z.string(),
  provider: z.string(),
  identityVerified: z.boolean(),
  hosts: z.array(z.string()),
  collectedAt: z.number(),
  observedAt: z.number().nullable(),
  window: z.string(),
  remainingPercent: z.number().nullable(),
  resetsAt: z.string().nullable(),
});
/** Only exact configured subscription IDs deduplicate hosts; labels/emails never imply shared quota. */
export function deduplicateSubscriptions(input: z.infer<typeof subscriptionObservation>[]) {
  const groups = new Map<string, z.infer<typeof subscriptionObservation>[]>();
  for (const raw of input) {
    const r = subscriptionObservation.parse(raw);
    const window = usageWindowIdentity({ label: r.window, kind: "", model: null });
    const key = r.subscriptionId
      ? `${r.provider}:subscription:${r.subscriptionId}:${window}`
      : `${r.provider}:host:${r.hostId}:account:${r.accountId}:${r.window}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([key, rows]) => {
    rows.sort(
      (a, b) =>
        Number(b.observedAt !== null) - Number(a.observedAt !== null) ||
        (b.observedAt ?? b.collectedAt) - (a.observedAt ?? a.collectedAt),
    );
    const r = rows[0]!;
    return {
      key,
      label: r.label ?? `${r.provider} account`,
      provider: r.provider,
      identityVerified: r.subscriptionId !== null,
      hosts: [...new Set(rows.map((r) => r.hostId))],
      collectedAt: r.collectedAt,
      observedAt: r.observedAt,
      window: r.window,
      remainingPercent:
        r.usedPercent === null ? null : Math.max(0, Math.min(100, 100 - r.usedPercent)),
      resetsAt: r.resetsAt,
    };
  });
}
export const retryRow = z.object({
  id: z.string(),
  threadId: z.string(),
  sendAt: z.number().nullable(),
});
export const automationOverview = z.object({
  automations: z.array(
    z.object({
      automation: z
        .object({
          id: z.string(),
          name: z.string(),
          enabled: z.boolean(),
          trigger: z.unknown(),
          execution: z.unknown(),
          nextRunAt: z.number().nullable(),
          lastRunStatus: z.string().nullable(),
          lastRunThreadId: z.string().nullable(),
        })
        .passthrough(),
      project: z.object({ id: z.string(), name: z.string() }),
    }),
  ),
});
export const fleetAutomationReceipt = z
  .object({
    state: z.enum(["started", "deduped", "refused", "unknown", "unavailable"]),
    ownerServerId: z.string().nullable(),
    hostId: z.string().nullable(),
    runId: z.string().nullable(),
    threadId: z.string().nullable(),
    runStatus: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
const fleetUsageSnapshot = z.object({
  ownerServerId: z.string().min(1),
  hostId: z.string().nullable(),
  observedAt: z.number(),
  providers: z
    .array(
      z.object({
        providerId: z.string().min(1),
        status: z.enum(["ok", "unavailable", "error"]),
        subscriptionId: z.string().nullable(),
        identity: z.enum(["unknown", "verified"]),
        planLabel: z.string().nullable(),
        windows: z
          .array(
            z.object({
              label: z.string().min(1).max(128),
              usedPercent: z.number().nullable(),
              resetsAt: z.string().nullable(),
            }),
          )
          .max(50),
        method: z.literal("bb.system.usageLimits"),
        observationId: z.string(),
      }),
    )
    .max(30),
});
export const fleetUsageResult = z
  .object({
    state: z.enum(["ok", "unavailable"]),
    reason: z.string().nullable(),
    snapshot: fleetUsageSnapshot.nullable(),
  })
  .strict();
const providerKey = (id: string) =>
  id === "claude-code" || id === "provider-claude-code"
    ? "claude"
    : id === "provider-codex"
      ? "codex"
      : id;
export function createAttentionIntegrations(
  bb: BbPluginApi,
  deps: {
    accounts(): Promise<HomeAccount[]>;
    localOwner(): Promise<string | null>;
    links?: { idFor(key: string): Promise<string | null> };
    remoteAvailable?(hook: HookConfig): Promise<boolean>;
  },
) {
  const settings = bb.settings.define({
    subscriptionIdentities: {
      type: "string",
      experimental_multiline: true,
      label: "Verified subscription identities (JSON)",
      description:
        "Map provider:hostId:accountId to an exact shared subscription ID. Email is not an identity. Unmapped observations stay separate.",
      default: "{}",
      experimental_schema: z.string().refine((s) => {
        try {
          return z.record(z.string(), z.string().min(1).max(200)).safeParse(JSON.parse(s)).success;
        } catch {
          return false;
        }
      }),
    },
  });
  type UsageResult = { subscriptions: z.infer<typeof subscriptionUsage>[]; scope: string };
  let usageCache: { until: number; value: UsageResult } | null = null;
  let usagePending: Promise<UsageResult> | null = null;
  settings.onChange(() => {
    usageCache = null;
  });
  async function mappingNow() {
    return z
      .record(z.string(), z.string())
      .parse(JSON.parse((await settings.get()).subscriptionIdentities));
  }
  async function identityFor(key: string): Promise<string | null> {
    return (await mappingNow().catch(() => ({}) as Record<string, string>))[key] ?? (await deps.links?.idFor(key)) ?? null;
  }
  async function collectUsage(): Promise<UsageResult> {
    const mapping = await mappingNow();
    const [accounts, hostConfig, localOwner, remote] = await Promise.all([
      deps.accounts().catch(() => []),
      bb.sdk.system.config(),
      deps.localOwner(),
      Promise.all(
        machineKeys().map(async (machine) => {
          try {
            return {
              machine,
              result: await bb.sdk.plugins.callRpc({
                pluginId: "fleet",
                method: "usage_snapshot_fetch",
                input: { machine },
                outputSchema: fleetUsageResult,
                signal: AbortSignal.timeout(10_000),
              }),
            };
          } catch {
            return {
              machine,
              result: {
                state: "unavailable" as const,
                reason: "Owner usage read unavailable",
                snapshot: null,
              },
            };
          }
        }),
      ),
    ]);
    const now = Date.now(),
      hostId = hostConfig.primaryHostId ?? "unknown-owner-host";
    const linked = new Map(
      await Promise.all(
        accounts.map(async (a) => {
          const k = `${a.harness}:${hostId}:${a.id}`;
          return [k, (await deps.links?.idFor(k)) ?? null] as const;
        }),
      ),
    );
    const observations: z.infer<typeof subscriptionObservation>[] = accounts.flatMap((a) =>
      (["session", "week"] as const).map((window) => ({
        provider: a.harness,
        accountId: a.id,
        label: a.label,
        hostId,
        subscriptionId: mapping[`${a.harness}:${hostId}:${a.id}`] ?? linked.get(`${a.harness}:${hostId}:${a.id}`) ?? null,
        observedAt: null,
        collectedAt: now,
        usedPercent: a.status === "ok" ? a[window] : null,
        resetsAt: window === "session" ? a.sessionResetsAt : a.weekResetsAt,
        window,
      })),
    );
    const coverage: string[] = [];
    const seenOwners = new Set<string>();
    for (const { machine, result } of remote) {
      const snapshot = result.snapshot;
      if (result.state !== "ok" || !snapshot || !snapshot.hostId) {
        coverage.push(`${machineName(machine)}: ${result.reason ?? "owner unavailable"}`);
        continue;
      }
      if (snapshot.ownerServerId === localOwner) {
        coverage.push(`${machineName(machine)}: local Account Pooler windows`);
        continue;
      }
      if (seenOwners.has(snapshot.ownerServerId)) {
        coverage.push(`${machineName(machine)}: same owner already represented`);
        continue;
      }
      seenOwners.add(snapshot.ownerServerId);
      const fresh = snapshot.observedAt <= now + 5000 && now - snapshot.observedAt <= 300_000;
      coverage.push(
        `${machineName(machine)}: owner read ${fresh ? "current" : "stale"}, subscription identity ${snapshot.providers.some((p) => p.identity === "verified") ? "partly verified" : "unknown"}`,
      );
      for (const provider of snapshot.providers) {
        const canonical = providerKey(provider.providerId);
        const subscriptionId =
          mapping[`${canonical}:${snapshot.hostId}:native-default`] ??
          (await deps.links?.idFor(`${canonical}:${snapshot.hostId}:native-default`)) ??
          (provider.identity === "verified" ? provider.subscriptionId : null);
        for (const window of provider.windows)
          observations.push({
            provider: canonical,
            accountId: "native-default",
            label: `${machineName(machine)} ${provider.providerId}${provider.planLabel ? ` ${provider.planLabel}` : ""}`,
            hostId: snapshot.hostId,
            subscriptionId,
            observedAt: snapshot.observedAt,
            collectedAt: now,
            usedPercent: fresh && provider.status === "ok" ? window.usedPercent : null,
            resetsAt: fresh ? window.resetsAt : null,
            window: window.label,
          });
      }
    }
    return {
      subscriptions: deduplicateSubscriptions(observations),
      scope: `${coverage.join("; ")}. Provider sample freshness is unknown; host capacity is separate. Unverified identities are never combined across owners.`,
    };
  }
  async function usage(): Promise<UsageResult> {
    if (usageCache && usageCache.until > Date.now()) return usageCache.value;
    if (usagePending) return usagePending;
    usagePending = collectUsage()
      .then((value) => {
        usageCache = { until: Date.now() + 30_000, value };
        return value;
      })
      .finally(() => {
        usagePending = null;
      });
    return usagePending;
  }
  const retries = async (threadId?: string) => ({
    retries: (await bb.sdk.threads.queue.list(threadId ? { threadId } : {}))
      .filter((r) => r.payload.kind === "retry")
      .map((r) => ({ id: r.id, threadId: r.threadId, sendAt: r.sendAt })),
  });
  const retryCancel = async ({ threadId, id }: { threadId: string; id: string }) => {
    const row = (await retries(threadId)).retries.find((r) => r.id === id);
    if (!row) throw new Error("Pending provider retry was not found.");
    await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: id });
    return { ok: true };
  };
  const automations = () =>
    bb.sdk.plugins.callRpc({
      pluginId: "automations",
      method: "automations_overview",
      input: null,
      outputSchema: automationOverview,
    });
  const automationRun = (input: {
    projectId: string;
    automationId: string;
    idempotencyKey: string;
    experimental_expectedUpdatedAt?: number;
    experimental_expectedExecutionFingerprint?: string;
    experimental_expectedHostId?: string;
  }) =>
    bb.sdk.plugins.callRpc({
      pluginId: "automations",
      method: "automations_run",
      input,
      outputSchema: z.object({ run: z.object({ id: z.string() }).passthrough() }),
      signal: AbortSignal.timeout(15_000),
    });
  const transport: EventTransport = {
    async available(hook) {
      if ((await deps.localOwner()) !== hook.ownerServerId)
        return !!hook.machine && !!deps.remoteAvailable && (await deps.remoteAvailable(hook));
      return (await bb.sdk.hosts.list()).some(
        (h) => h.id === hook.hostId && h.status === "connected",
      );
    },
    async run(hook, idempotencyKey) {
      if (!(await transport.available(hook))) return { kind: "offline" };
      if ((await deps.localOwner()) !== hook.ownerServerId) {
        if (!hook.machine) return { kind: "offline" };
        const result = await bb.sdk.plugins.callRpc({
          pluginId: "fleet",
          method: "automation_dispatch",
          input: {
            v: 1,
            ownerServerId: hook.ownerServerId,
            hostId: hook.hostId,
            projectId: hook.projectId,
            automationId: hook.automationId,
            idempotencyKey,
            machine: hook.machine,
          },
          outputSchema: fleetAutomationReceipt,
          signal: AbortSignal.timeout(30_000),
        });
        if (result.state === "unavailable") return { kind: "offline" };
        if (result.state === "refused")
          return { kind: "refused", reason: result.reason ?? "The owner refused this task." };
        if (
          (result.state === "started" || result.state === "deduped") &&
          result.runId &&
          result.ownerServerId === hook.ownerServerId &&
          result.hostId === hook.hostId
        )
          return { kind: "admitted", runId: result.runId };
        return { kind: "unknown" };
      }
      // Core resolves defaults, reused targets and scripts, then enforces the
      // exact reviewed host again in the same path that admits the execution.
      const guard = await bb.sdk.plugins.callRpc({
        pluginId: "automations",
        method: "experimental_automations_execution_guard",
        input: { projectId: hook.projectId, automationId: hook.automationId },
        outputSchema: z
          .object({
            updatedAt: z.number(),
            executionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            execution: z.unknown(),
            resolvedHostId: z.string().min(1).max(256).nullable(),
            experimental_hostGuard: z.literal(true),
          })
          .strict(),
      });
      if (guard.resolvedHostId !== hook.hostId)
        throw new Error("Automation execution host does not match the configured event owner.");
      const result = await automationRun({
        projectId: hook.projectId,
        automationId: hook.automationId,
        idempotencyKey,
        experimental_expectedUpdatedAt: guard.updatedAt,
        experimental_expectedExecutionFingerprint: guard.executionFingerprint,
        experimental_expectedHostId: guard.resolvedHostId,
      });
      return { kind: "admitted", runId: result.run.id };
    },
  };
  const forgetUsage = () => {
    usageCache = null;
  };
  return { usage, forgetUsage, identityFor, retries, retryCancel, automations, automationRun, transport };
}

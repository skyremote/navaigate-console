import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttentionIntegrations } from "../server-attention-integrations";
import type { HomeAccount } from "../server-home";
import type { HookConfig } from "../server-event-inbox";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
});
const hook: HookConfig = {
  id: "ci",
  enabled: true,
  ownerServerId: "local-owner",
  hostId: "host-m1",
  projectId: "project",
  automationId: "task",
  holdOffline: true,
  coalesceSeconds: 0,
  filters: [],
};
function fixture() {
  const calls: { pluginId: string; method: string; input: unknown }[] = [];
  const deleted: unknown[] = [];
  let accounts: HomeAccount[] = [];
  const snapshots = new Map<string, unknown>();
  let remote = false;
  let remoteReceipt = {
    state: "started",
    ownerServerId: "remote-owner",
    hostId: "host-m1",
    runId: "remote-run",
    threadId: null,
    runStatus: "running",
    reason: null,
  };
  let connected = true,
    targetHost = "host-m1";
  let guardFields: Record<string, unknown> = {};
  let runError: Error | null = null;
  const host = createFakePluginHost({
    pluginId: "integration-test",
    sdk: {
      system: { config: async () => ({ primaryHostId: "source-host" }) },
      hosts: {
        list: async () =>
          [{ id: "host-m1", status: connected ? "connected" : "disconnected" }] as never,
      },
      plugins: {
        callRpc: async (args) => {
          calls.push(args);
          if (args.method === "usage_snapshot_fetch")
            return (snapshots.get((args.input as { machine: string }).machine) ?? {
              state: "unavailable",
              reason: "no-authenticated-owner-route",
              snapshot: null,
            }) as never;
          if (args.method === "automation_dispatch") return remoteReceipt as never;
          if (args.method === "experimental_automations_execution_guard") {
            const guard = {
              updatedAt: 123,
              executionFingerprint: "a".repeat(64),
              execution: { mode: "agent", environment: { type: "host", hostId: targetHost } },
              resolvedHostId: targetHost,
              experimental_hostGuard: true,
              ...guardFields,
            };
            // Exercise the actual SDK boundary contract rather than a fake
            // which silently ignores outputSchema and accepts older replies.
            return (args.outputSchema ? args.outputSchema.parse(guard) : guard) as never;
          }
          if (args.method === "automations_run" && runError) throw runError;
          if (args.method === "automations_overview")
            return {
              automations: [
                {
                  project: { id: "project", name: "Test" },
                  automation: {
                    id: "task",
                    name: "CI review",
                    enabled: false,
                    trigger: {
                      triggerType: "schedule",
                      timezone: "Europe/Berlin",
                      cron: "0 8 * * *",
                    },
                    execution: { mode: "agent", environment: { type: "host", hostId: targetHost } },
                    nextRunAt: null,
                    lastRunStatus: null,
                    lastRunThreadId: null,
                  },
                },
              ],
            } as never;
          return { run: { id: "native-run" } } as never;
        },
      },
      threads: {
        queue: {
          list: async () =>
            [
              { id: "retry", threadId: "t", sendAt: 100, payload: { kind: "retry" } },
              { id: "prompt", threadId: "t", sendAt: null, payload: { kind: "message" } },
            ] as never,
        },
        queuedMessages: {
          delete: async (input) => {
            deleted.push(input);
            return { ok: true };
          },
        },
      },
    },
  });
  hosts.push(host);
  const integrations = createAttentionIntegrations(host.bb, {
    accounts: async () => accounts,
    localOwner: async () => "local-owner",
    remoteAvailable: async () => remote,
  });
  return {
    ...host,
    integrations,
    calls,
    deleted,
    setAccounts(value: HomeAccount[]) {
      accounts = value;
    },
    setSnapshot(machine: string, value: unknown) {
      snapshots.set(machine, value);
    },
    setRemote(value: boolean) {
      remote = value;
    },
    setRemoteState(value: string) {
      remoteReceipt = { ...remoteReceipt, state: value };
    },
    setConnected(value: boolean) {
      connected = value;
    },
    setTarget(value: string) {
      targetHost = value;
    },
    setGuard(value: Record<string, unknown>) {
      guardFields = value;
    },
    failRun(error: Error) {
      runError = error;
    },
  };
}
describe("genuine BB integrations", () => {
  it("reuses native Automations idempotency and verifies actual execution host", async () => {
    const f = fixture();
    expect(await f.integrations.transport.run(hook, "stable-event-key")).toEqual({
      kind: "admitted",
      runId: "native-run",
    });
    expect(f.calls[1]).toMatchObject({
      pluginId: "automations",
      method: "automations_run",
      input: {
        projectId: "project", automationId: "task", idempotencyKey: "stable-event-key",
        experimental_expectedUpdatedAt: 123,
        experimental_expectedExecutionFingerprint: "a".repeat(64),
        experimental_expectedHostId: "host-m1",
      },
    });
    f.setTarget("different-host");
    await expect(f.integrations.transport.run(hook, "another-key")).rejects.toThrow(
      "does not match",
    );
    expect(f.calls.filter((c) => c.method === "automations_run")).toHaveLength(1);
  });
  it.each([
    { execution: { mode: "agent", environment: { type: "project-default" } } },
    { execution: { mode: "agent", environment: { type: "host" } } },
    { execution: { mode: "script", workingDirectory: { type: "automation-storage" } } },
    { execution: { mode: "agent", environment: { type: "reuse", environmentId: "foreign-looking-client-id" }, targetThreadId: "native-target" } },
  ])("uses core's resolved host for canonical execution %j", async (fields) => {
    const f = fixture();
    f.setGuard(fields);
    expect(await f.integrations.transport.run(hook, "resolved-host-key")).toEqual({ kind: "admitted", runId: "native-run" });
    expect(f.calls.find((c) => c.method === "automations_run")?.input).toMatchObject({ experimental_expectedHostId: "host-m1" });
  });
  it.each([
    { experimental_hostGuard: undefined },
    { experimental_hostGuard: false },
    { resolvedHostId: undefined },
    { resolvedHostId: null },
    { resolvedHostId: "different-host" },
    { resolvedHostId: 123 },
    { experimental_hostGuard: "true" },
  ])("refuses unavailable, unknown or mismatched host guard %j before run", async (fields) => {
    const f = fixture();
    f.setGuard(fields);
    await expect(f.integrations.transport.run(hook, "must-not-run")).rejects.toThrow();
    expect(f.calls.filter((c) => c.method === "automations_run")).toEqual([]);
  });
  it("propagates a changed-host refusal from core admission without a fallback run", async () => {
    const f = fixture();
    f.failRun(new Error("execution_host_mismatch: actual host changed before admission"));
    await expect(f.integrations.transport.run(hook, "host-changed-after-guard")).rejects.toThrow("execution_host_mismatch");
    expect(f.calls.filter((c) => c.method === "automations_run")).toHaveLength(1);
    expect(f.calls.at(-1)?.input).toMatchObject({ experimental_expectedHostId: "host-m1", idempotencyKey: "host-changed-after-guard" });
  });
  it("never mistakes an enrolled host for a remote owner or dispatches to a disconnected host", async () => {
    const f = fixture();
    expect(
      await f.integrations.transport.available({ ...hook, ownerServerId: "remote-owner" }),
    ).toBe(false);
    expect(
      await f.integrations.transport.run({ ...hook, ownerServerId: "remote-owner" }, "key"),
    ).toEqual({ kind: "offline" });
    f.setConnected(false);
    expect(await f.integrations.transport.run(hook, "key")).toEqual({ kind: "offline" });
    expect(f.calls).toEqual([]);
  });
  it("routes finite remote Automations through exact Fleet owner intent and distinguishes unavailable from unknown", async () => {
    const f = fixture();
    f.setRemote(true);
    const remote = { ...hook, ownerServerId: "remote-owner", machine: "studio" as const };
    expect(await f.integrations.transport.run(remote, "durable-key-123")).toEqual({
      kind: "admitted",
      runId: "remote-run",
    });
    expect(f.calls[0]).toMatchObject({
      pluginId: "fleet",
      method: "automation_dispatch",
      input: {
        v: 1,
        ownerServerId: "remote-owner",
        machine: "studio",
        hostId: "host-m1",
        projectId: "project",
        automationId: "task",
        idempotencyKey: "durable-key-123",
      },
    });
    f.setRemoteState("unavailable");
    expect(await f.integrations.transport.run(remote, "durable-key-456")).toEqual({
      kind: "offline",
    });
    f.setRemoteState("unknown");
    expect(await f.integrations.transport.run(remote, "durable-key-789")).toEqual({
      kind: "unknown",
    });
    f.setRemoteState("refused");
    expect(await f.integrations.transport.run(remote, "durable-key-790")).toEqual({
      kind: "refused",
      reason: "The owner refused this task.",
    });
  });
  it("reads exact authenticated Fleet usage snapshots, retains unknown identities and reports unavailable owners", async () => {
    const f = fixture();
    const now = Date.now();
    const snapshot = (ownerServerId: string, hostId: string) => ({
      ownerServerId,
      hostId,
      observedAt: now,
      providers: [
        {
          providerId: "codex",
          status: "ok",
          subscriptionId: null,
          identity: "unknown",
          planLabel: "Same plan",
          windows: [{ label: "week", usedPercent: 70, resetsAt: "2026-11-01T00:00:00Z" }],
          method: "bb.system.usageLimits",
          observationId: `${ownerServerId}-snapshot`,
        },
      ],
    });
    f.setSnapshot("studio", { state: "ok", reason: null, snapshot: snapshot("owner-m1", "host-m1") });
    f.setSnapshot("laptop", { state: "ok", reason: null, snapshot: snapshot("owner-m5", "host-m5") });
    const usage = await f.integrations.usage();
    expect(usage.subscriptions).toHaveLength(2);
    expect(usage.subscriptions.every((s) => !s.identityVerified && s.remainingPercent === 30)).toBe(
      true,
    );
    expect(usage.scope).toContain("Work: no-authenticated-owner-route");
    expect(usage.scope).toContain("identity unknown");
    expect(f.calls.filter((c) => c.method === "usage_snapshot_fetch").map((c) => c.input)).toEqual([
      { machine: "laptop" },
      { machine: "studio" },
      { machine: "work" },
    ]);
    await f.integrations.usage();
    expect(f.calls.filter((c) => c.method === "usage_snapshot_fetch")).toHaveLength(3);
  });
  it("deduplicates configured exact subscription identity across owners and suppresses stale allowance", async () => {
    const f = fixture();
    const hostId = (await f.bb.sdk.system.config()).primaryHostId ?? "unknown-owner-host";
    f.setAccounts([
      {
        id: "local-account",
        harness: "codex",
        label: "Codex",
        email: null,
        plan: null,
        session: null,
        sessionResetsAt: null,
        week: 60,
        weekResetsAt: null,
        cycleLabel: "week",
        history: [],
        advice: null,
        status: "ok",
      },
    ]);
    const remote = {
      ownerServerId: "owner-m1",
      hostId: "host-m1",
      observedAt: Date.now(),
      providers: [
        {
          providerId: "codex",
          status: "ok",
          subscriptionId: null,
          identity: "unknown",
          planLabel: null,
          windows: [{ label: "week", usedPercent: 80, resetsAt: null }],
          method: "bb.system.usageLimits",
          observationId: "snapshot",
        },
      ],
    };
    f.setSnapshot("studio", { state: "ok", reason: null, snapshot: remote });
    await f.harness.behavior.setSettings({
      subscriptionIdentities: JSON.stringify({
        [`codex:${hostId}:local-account`]: "verified-subscription",
        "codex:host-m1:native-default": "verified-subscription",
      }),
    });
    const usage = await f.integrations.usage();
    const weekly = usage.subscriptions.filter((s) => s.window === "week");
    expect(weekly).toHaveLength(1);
    expect(weekly[0]?.remainingPercent).toBe(20);
    expect(weekly[0]?.hosts).toContain("host-m1");
    f.setSnapshot("studio", {
      state: "ok",
      reason: null,
      snapshot: { ...remote, observedAt: Date.now() - 360_000 },
    });
    await f.harness.behavior.setSettings({ subscriptionIdentities: "{}" });
    const stale = await f.integrations.usage();
    expect(
      stale.subscriptions.find((s) => s.hosts.includes("host-m1"))?.remainingPercent,
    ).toBeNull();
    expect(stale.scope).toContain("owner read stale");
  });
  it("reads Provider Retry's ordinary queue and cancels only the exact retry row", async () => {
    const f = fixture();
    expect(await f.integrations.retries("t")).toEqual({
      retries: [{ id: "retry", threadId: "t", sendAt: 100 }],
    });
    await expect(f.integrations.retryCancel({ threadId: "t", id: "prompt" })).rejects.toThrow(
      "not found",
    );
    await f.integrations.retryCancel({ threadId: "t", id: "retry" });
    expect(f.deleted).toEqual([{ threadId: "t", queuedMessageId: "retry" }]);
  });
});

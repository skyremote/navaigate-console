import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Snapshot } from "../model";
import {
  createOwnerOperations,
  operationsRpcContract,
  type OwnerTransport,
} from "./operations";
import type { OwnerCallOutcome } from "./transport";
const NOW = 1_800_000_000_000;
const base = {
  v: 1 as const,
  ownerServerId: "owner-laptop",
  hostId: "host-laptop",
  projectId: "project",
  automationId: "task",
  idempotencyKey: "event-1",
};
const dirs: string[] = [],
  databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "owner-operations-"));
  dirs.push(dir);
  let db = new Database(join(dir, "receipts.sqlite"));
  databases.push(db);
  const own = { serverId: "owner-laptop", hostId: "host-laptop" as string | null };
  let clock = NOW,
    snapshot: Snapshot | null = {
      serverId: "owner-studio",
      machineKey: "studio",
      ownerHostId: "host-studio",
      publishedAt: NOW,
    } as Snapshot;
  let execution: unknown = {
    mode: "agent",
    environment: { type: "host", hostId: "host-laptop" },
  };
  let resolvedHostId: string | null = "host-laptop",
    hostGuard = true;
  let coreFails = false,
    guardFails = false,
    runCalls = 0,
    blocked: Promise<void> | null = null;
  const localCalls: { pluginId: string; method: string; input: any }[] = [],
    remoteCalls: {
      plugin: string;
      method: string;
      input: any;
      mutation: boolean;
    }[] = [];
  let limits: any = {
    codex: {
      status: "ok",
      accountEmail: "same@example.test",
      planLabel: "Pro",
      windows: [{ label: "week", usedPercent: 24, resetsAt: null }],
    },
  };
  let remote: (
    call: (typeof remoteCalls)[number],
  ) => Promise<OwnerCallOutcome> = async () => ({
    ok: false,
    kind: "unavailable",
    message: "No route",
  });
  const hosts = vi.fn(async () => [{ id: "host-laptop", status: "connected" }]),
    env = vi.fn(async (_input: unknown) => ({ hostId: "host-laptop" })),
    thread = vi.fn(async (_input: unknown) => ({
      projectId: "project",
      environmentId: "env",
      deletedAt: null,
      archivedAt: null,
    }));
  const warn = vi.fn();
  const bb = {
    log: { warn },
    storage: { database: () => db },
    sdk: {
      hosts: { list: hosts },
      environments: { get: env },
      threads: { get: thread },
      system: { usageLimits: vi.fn(async () => limits) },
      plugins: {
        callRpc: async (call: any) => {
          localCalls.push(call);
          let result: unknown;
          if (call.method === "experimental_automations_execution_guard") {
            if (guardFails) throw new Error("Unknown RPC method");
            result = {
              updatedAt: 123,
              executionFingerprint: "a".repeat(64),
              resolvedHostId,
              experimental_hostGuard: hostGuard,
              execution,
            };
          } else if (call.method === "automations_run") {
            runCalls++;
            if (blocked) await blocked;
            if (coreFails) throw new Error("Connection lost after admission");
            result = {
              run: {
                id: "run-1",
                automationId: "task",
                threadId: "thread-1",
                status: "running",
              },
            };
          } else if (call.method === "automations_runs")
            result = {
              runs: [
                {
                  id: "run-1",
                  automationId: "task",
                  threadId: "thread-1",
                  status: "succeeded",
                },
              ],
              nextCursor: null,
            };
          else if (call.method === "attention_owner_inbox")
            result = {
              v: 1,
              ownerServerId: own.serverId,
              hostId: own.hostId,
              observedAt: clock,
              rows: [],
              truncated: false,
            };
          else if (
            call.method === "attention_owner_action" ||
            call.method === "attention_owner_receipt"
          )
            result = actionReceipt(call.input);
          else throw new Error("Unexpected method " + call.method);
          return call.outputSchema.parse(result);
        },
      },
    },
  } as unknown as BbPluginApi;
  const transport: OwnerTransport = {
    call: async (plugin, method, input, mutation) => {
      const call = { plugin, method, input, mutation };
      remoteCalls.push(call);
      return remote(call);
    },
  };
  const deps = {
    bb,
    localOwner: async () => own,
    localMachine: "laptop" as const,
    snapshot: async () => snapshot,
    transport: () => transport,
    now: () => clock,
  };
  const load = () => createOwnerOperations(deps).handlers;
  return {
    bb,
    warn,
    db,
    own,
    hosts,
    env,
    thread,
    localCalls,
    remoteCalls,
    load,
    handlers: load(),
    reopen: () => {
      db.close();
      db = new Database(join(dir, "receipts.sqlite"));
      databases.push(db);
      return load();
    },
    runCalls: () => runCalls,
    resolvedHost: (value: string | null) => {
      resolvedHostId = value;
    },
    hostGuard: (value: boolean) => {
      hostGuard = value;
    },
    execution: (value: unknown) => {
      execution = value;
    },
    coreFails: () => {
      coreFails = true;
    },
    guardFails: () => {
      guardFails = true;
    },
    snapshot: (value: Snapshot | null) => {
      snapshot = value;
    },
    remote: (fn: typeof remote) => {
      remote = fn;
    },
    limits: (value: unknown) => {
      limits = value;
    },
    block: (value: Promise<void>) => {
      blocked = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
const remoteInput = () => ({
  ...base,
  machine: "studio" as const,
  ownerServerId: "owner-studio",
  hostId: "host-studio",
});
const autoReceipt = () => ({
  state: "started",
  ownerServerId: "owner-studio",
  hostId: "host-studio",
  runId: "remote-run",
  threadId: "remote-thread",
  runStatus: "running",
  reason: null,
});
const actionInput = () => ({
  machine: "studio" as const,
  v: 1 as const,
  ownerServerId: "owner-studio",
  hostId: "host-studio",
  requestId: randomUUID(),
  command: {
    kind: "apply" as const,
    input: { threadIds: ["one"], action: "settle" as const },
  },
});
const actionReceipt = (input: {
  ownerServerId: string;
  requestId: string;
  hostId?: string;
}) => ({
  v: 1,
  state: "completed",
  ownerServerId: input.ownerServerId,
  hostId: input.hostId ?? "host-laptop",
  requestId: input.requestId,
  receiptId: randomUUID(),
  results: [{ threadId: "one", ok: true, error: null }],
  reason: null,
});

describe("saved automation owner execution", () => {
  it("uses opaque core guard and persists exact deduplication across reload", async () => {
    const f = fixture();
    expect((await f.handlers.automation_run(base)).state).toBe("started");
    expect(f.localCalls.at(-1)).toMatchObject({
      pluginId: "automations",
      method: "automations_run",
      input: {
        idempotencyKey: base.idempotencyKey,
        experimental_expectedUpdatedAt: 123,
        experimental_expectedHostId: "host-laptop",
        experimental_expectedExecutionFingerprint: "a".repeat(64),
      },
    });
    expect((await f.load().automation_run(base)).state).toBe("deduped");
    expect(await f.load().automation_run_status(base)).toMatchObject({
      runId: "run-1",
      runStatus: "succeeded",
    });
    expect(f.runCalls()).toBe(1);
    expect(
      (await f.handlers.automation_run({ ...base, automationId: "other" }))
        .state,
    ).toBe("refused");
  });
  it("admits at most once when guards overlap", async () => {
    const f = fixture();
    let release!: () => void;
    f.block(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const first = f.handlers.automation_run(base),
      second = f.handlers.automation_run(base);
    await vi.waitFor(() => expect(f.runCalls()).toBe(1));
    release();
    await Promise.all([first, second]);
    expect(f.runCalls()).toBe(1);
  });
  it("keeps uncertain core effects durable and never resends", async () => {
    const f = fixture();
    f.coreFails();
    expect((await f.handlers.automation_run(base)).state).toBe("unknown");
    expect((await f.reopen().automation_run(base)).state).toBe("unknown");
    expect(f.runCalls()).toBe(1);
  });
  it.each([
    "owner",
    "host",
    "disconnected",
    "guard missing",
    "unsupported host guard",
    "unknown host",
  ])("refuses %s before core run", async (kind) => {
    const f = fixture(),
      input = { ...base };
    if (kind === "owner") input.ownerServerId = "another";
    if (kind === "host") f.resolvedHost("another");
    if (kind === "disconnected") f.hosts.mockResolvedValue([]);
    if (kind === "guard missing") f.guardFails();
    if (kind === "unsupported host guard") f.hostGuard(false);
    if (kind === "unknown host") f.resolvedHost(null);
    expect((await f.handlers.automation_run(input)).state).toBe("refused");
    expect(f.runCalls()).toBe(0);
  });
  it.each([
    { mode: "agent", environment: { type: "project-default" } },
    {
      mode: "agent",
      environment: { type: "host", workspace: { type: "personal" } },
    },
    { mode: "agent", environment: { type: "reuse", environmentId: "env" } },
    {
      mode: "agent",
      environment: { type: "project-default" },
      targetThreadId: "existing",
    },
    { mode: "script", workingDirectory: { type: "automation-storage" } },
  ])(
    "uses authoritative core resolution for $mode without local host guesses",
    async (execution) => {
      const f = fixture();
      f.execution(execution);
      expect((await f.handlers.automation_run(base)).state).toBe("started");
      expect(f.runCalls()).toBe(1);
      expect(f.localCalls.at(-1)?.input.experimental_expectedHostId).toBe(
        "host-laptop",
      );
      expect(f.env).not.toHaveBeenCalled();
      expect(f.thread).not.toHaveBeenCalled();
    },
  );
  it("refuses a foreign target or changed reuse host reported by core", async () => {
    const f = fixture();
    f.resolvedHost(null);
    expect((await f.handlers.automation_run(base)).state).toBe("refused");
    f.resolvedHost("host-studio");
    expect((await f.handlers.automation_run(base)).state).toBe("refused");
    expect(f.runCalls()).toBe(0);
  });

  it("does not present cached run state as a current owner status when reads fail", async () => {
    const f = fixture();
    await f.handlers.automation_run(base);
    vi.spyOn(f.bb.sdk.plugins, "callRpc").mockRejectedValueOnce(
      new Error("owner read offline"),
    );
    const status = await f.handlers.automation_run_status(base);
    expect(status).toMatchObject({
      state: "started",
      runId: "run-1",
      runStatus: null,
    });
    expect(status.reason).toContain("current owner status is unavailable");
    expect(f.runCalls()).toBe(1);
  });
  it("executes self-local without SSH", async () => {
    const f = fixture();
    expect(
      (await f.handlers.automation_dispatch({ ...base, machine: "laptop" })).state,
    ).toBe("started");
    expect(f.remoteCalls).toEqual([]);
  });
});

describe("finite source forwarding", () => {
  it("binds fresh studio identity and passes only the fixed run pair", async () => {
    const f = fixture();
    f.remote(async () => ({ ok: true, result: autoReceipt() }));
    expect((await f.handlers.automation_dispatch(remoteInput())).state).toBe(
      "started",
    );
    expect(f.remoteCalls[0]).toEqual({
      plugin: "fleet",
      method: "automation_run",
      mutation: true,
      input: { ...base, ownerServerId: "owner-studio", hostId: "host-studio" },
    });
    expect((await f.load().automation_dispatch(remoteInput())).state).toBe(
      "deduped",
    );
    expect(f.remoteCalls).toHaveLength(1);
  });
  it.each(["stale", "wrong server", "wrong host", "work"])(
    "refuses %s without mutation",
    async (kind) => {
      const f = fixture(),
        input = remoteInput();
      if (kind === "stale") f.advance(10_001);
      if (kind === "wrong server") input.ownerServerId = "other";
      if (kind === "wrong host") input.hostId = "other";
      expect(
        (
          await f.handlers.automation_dispatch(
            kind === "work" ? { ...input, machine: "work" } : input,
          )
        ).state,
      ).toBe("unavailable");
      expect(f.remoteCalls).toHaveLength(0);
    },
  );
  it("reconciles lost response through status without a second run", async () => {
    const f = fixture();
    f.remote(async (call) =>
      call.mutation
        ? { ok: false, kind: "unknown", message: "Lost response" }
        : { ok: true, result: autoReceipt() },
    );
    expect((await f.handlers.automation_dispatch(remoteInput())).state).toBe(
      "unknown",
    );
    expect((await f.load().automation_dispatch(remoteInput())).runId).toBe(
      "remote-run",
    );
    expect(f.remoteCalls.map((c) => c.method)).toEqual([
      "automation_run",
      "automation_run_status",
    ]);
  });
  it("does not resend when receipt is missing after unknown effect", async () => {
    const f = fixture();
    f.remote(async (call) =>
      call.mutation
        ? { ok: false, kind: "unknown", message: "Lost response" }
        : {
            ok: true,
            result: {
              ...autoReceipt(),
              state: "unavailable",
              runId: null,
              reason: "no-receipt",
            },
          },
    );
    await f.handlers.automation_dispatch(remoteInput());
    expect((await f.load().automation_dispatch(remoteInput())).state).toBe(
      "unknown",
    );
    expect(f.remoteCalls.filter((c) => c.mutation)).toHaveLength(1);
  });
  it("allows proven pre-delivery unavailable to retry", async () => {
    const f = fixture();
    await f.handlers.automation_dispatch(remoteInput());
    f.remote(async () => ({ ok: true, result: autoReceipt() }));
    expect((await f.handlers.automation_dispatch(remoteInput())).state).toBe(
      "started",
    );
  });
  it("treats wrong-owner receipts as unknown and changed intent as refused", async () => {
    const f = fixture();
    f.remote(async () => ({
      ok: true,
      result: { ...autoReceipt(), ownerServerId: "wrong" },
    }));
    expect((await f.handlers.automation_dispatch(remoteInput())).state).toBe(
      "unknown",
    );
    expect(
      (
        await f.handlers.automation_dispatch({
          ...remoteInput(),
          automationId: "other",
        })
      ).state,
    ).toBe("refused");
  });
});

describe("owner usage observations", () => {
  it("never derives identity from email or plan, feature-detects explicit stable ID", async () => {
    const f = fixture(),
      first = await f.handlers.usage_snapshot_get(null);
    expect(first.providers[0]).toMatchObject({
      identity: "unknown",
      subscriptionId: null,
      method: "bb.system.usageLimits",
      windows: [{ label: "week", usedPercent: 24 }],
    });
    expect(JSON.stringify(first)).not.toContain("same@example.test");
    const opaque = `bbsub1:${"a1".repeat(20)}`;
    f.limits({
      codex: {
        status: "ok",
        subscriptionId: "sub_untrusted_plain_field",
        experimental_subscriptionId: opaque,
        planLabel: "Pro",
        windows: [],
      },
      claude: { status: "unauthenticated" },
    });
    const next = await f.handlers.usage_snapshot_get(null);
    expect(next.providers[0]).toMatchObject({
      identity: "verified",
      subscriptionId: opaque,
    });
    f.limits({
      codex: {
        status: "ok",
        subscriptionId: "sub_untrusted_plain_field",
        planLabel: "Pro",
        windows: [],
      },
    });
    expect(
      (await f.handlers.usage_snapshot_get(null)).providers[0],
    ).toMatchObject({ identity: "unknown", subscriptionId: null });
    expect(next.providers[1]).toMatchObject({
      status: "unavailable",
      identity: "unknown",
    });
    expect(next.providers[0]?.observationId).not.toBe(
      first.providers[0]?.observationId,
    );
  });
  it("fetches with exact null contract and rejects stale or wrong owner observations", async () => {
    const f = fixture(),
      snapshot = {
        ...(await f.handlers.usage_snapshot_get(null)),
        ownerServerId: "owner-studio",
        hostId: "host-studio",
      };
    f.remote(async () => ({ ok: true, result: snapshot }));
    expect(
      (await f.handlers.usage_snapshot_fetch({ machine: "studio" })).state,
    ).toBe("ok");
    expect(f.remoteCalls[0]).toMatchObject({
      plugin: "fleet",
      method: "usage_snapshot_get",
      input: null,
      mutation: false,
    });
    f.remote(async () => ({
      ok: true,
      result: { ...snapshot, ownerServerId: "other" },
    }));
    expect(
      (await f.handlers.usage_snapshot_fetch({ machine: "studio" })).state,
    ).toBe("unavailable");
    f.remote(async () => ({
      ok: true,
      result: { ...snapshot, observedAt: NOW - 30_001 },
    }));
    expect(
      (await f.handlers.usage_snapshot_fetch({ machine: "studio" })).state,
    ).toBe("unavailable");
  });
});

describe("exact C attention finite forwarders", () => {
  it("uses local C inbox directly and exact remote inbox contract", async () => {
    const f = fixture();
    expect(
      (await f.handlers.attention_inbox_fetch({ machine: "laptop" })).state,
    ).toBe("ok");
    expect(f.remoteCalls).toEqual([]);
    f.remote(async () => ({
      ok: true,
      result: {
        v: 1,
        ownerServerId: "owner-studio",
        hostId: "host-studio",
        observedAt: NOW,
        rows: [],
        truncated: false,
      },
    }));
    expect(
      (await f.handlers.attention_inbox_fetch({ machine: "studio" })).state,
    ).toBe("ok");
    expect(f.remoteCalls[0]).toEqual({
      plugin: "navaigate-skin",
      method: "attention_owner_inbox",
      input: { v: 1, ownerServerId: "owner-studio" },
      mutation: false,
    });
  });
  it("reads an owner inbox that holds stashed chats and shows an unknown, missing or null status as needs-you", async () => {
    // Captured live on 1 Nov 2026: the Console on each Mac sent 'stashed' rows and
    // Fleet's row list stopped at 'snoozed', so every row of that Mac was refused.
    const f = fixture(),
      row = (threadId: string, status?: unknown) => ({
        threadId,
        title: threadId,
        hostId: "host-studio",
        environmentId: null,
        ...(status === undefined ? {} : { status }),
        question: null,
        updatedAt: NOW,
        pinned: false,
        wakeAt: null,
      });
    f.remote(async () => ({
      ok: true,
      result: {
        v: 1,
        ownerServerId: "owner-studio",
        hostId: "host-studio",
        observedAt: NOW,
        rows: [
          row("a", "stashed"),
          row("b", "reviewable"),
          row("c", "paused-by-a-future-console"),
          row("d", "paused-by-a-future-console"),
          row("e", null),
          row("f"),
        ],
        truncated: false,
      },
    }));
    const read = await f.handlers.attention_inbox_fetch({ machine: "studio" });
    expect(read.state).toBe("ok");
    expect(read.snapshot?.rows.map((r) => r.status)).toEqual([
      "stashed",
      "reviewable",
      "needs-you",
      "needs-you",
      "needs-you",
      "needs-you",
    ]);
    // One line per Mac per status, not per row, and none on a second read.
    expect(f.warn).toHaveBeenCalledTimes(2);
    expect(f.warn.mock.calls.map((c) => String(c[0])).sort()).toEqual([
      'studio sent 2 attention row(s) with status "(missing)"; shown as needs-you',
      'studio sent 2 attention row(s) with status "paused-by-a-future-console"; shown as needs-you',
    ].sort());
    await f.handlers.attention_inbox_fetch({ machine: "studio" });
    expect(f.warn).toHaveBeenCalledTimes(2);
  });
  it("persists unknown attention actions, only reconciles via exact status", async () => {
    const f = fixture(),
      input = actionInput();
    f.remote(async (call) =>
      call.mutation
        ? { ok: false, kind: "unknown", message: "Lost response" }
        : { ok: true, result: { ...actionReceipt(input), hostId: "host-studio" } },
    );
    expect((await f.handlers.attention_action_dispatch(input)).state).toBe(
      "unknown",
    );
    expect((await f.load().attention_action_dispatch(input)).state).toBe(
      "completed",
    );
    expect(f.remoteCalls.map((c) => [c.plugin, c.method, c.mutation])).toEqual([
      ["navaigate-skin", "attention_owner_action", true],
      ["navaigate-skin", "attention_owner_receipt", false],
    ]);
    expect(f.remoteCalls[1]?.input).toEqual({
      v: 1,
      ownerServerId: "owner-studio",
      requestId: input.requestId,
    });
    expect(
      (
        await f.handlers.attention_action_dispatch({
          ...input,
          command: { kind: "undo", receiptId: randomUUID() },
        })
      ).state,
    ).toBe("refused");
  });
  it("rejects wrong-host, mismatched request and unrecognised fields", async () => {
    const f = fixture(),
      input = actionInput();
    f.remote(async () => ({
      ok: true,
      result: { ...actionReceipt(input), hostId: "other" },
    }));
    expect((await f.handlers.attention_action_dispatch(input)).state).toBe(
      "unknown",
    );
    f.remote(async () => ({
      ok: true,
      result: {
        ...actionReceipt(input),
        hostId: "host-studio",
        requestId: randomUUID(),
      },
    }));
    expect(
      (
        await f.handlers.attention_action_status({
          machine: "studio",
          v: 1,
          ownerServerId: input.ownerServerId,
          requestId: input.requestId,
        })
      ).state,
    ).toBe("unavailable");
    expect(() =>
      operationsRpcContract.attention_action_dispatch.input.parse({
        ...input,
        plugin: "arbitrary",
      }),
    ).toThrow();
  });
});

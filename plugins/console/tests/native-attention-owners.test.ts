import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createAttention } from "../server-attention";
import {
  createAttentionOwners,
  ownerAttentionAction,
  type ownerAttentionReceipt,
} from "../server-attention-owners";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
function owner(
  serverId: string,
  hostId: string,
  rpc?: (method: string, input: unknown) => Promise<unknown>,
) {
  const row = makeThreadResponse({
    id: "shared-id",
    title: `${serverId} output`,
    status: "idle",
    runtime: { displayStatus: "idle" },
    pinnedAt: 17,
    sectionId: "original-section",
    environmentId: null,
  });
  let applyCalls = 0,
    pending = false;
  const host = createFakePluginHost({
    pluginId: "navaigate-skin",
    sdk: {
      system: { config: async () => ({ primaryHostId: hostId }) },
      plugins: {
        callRpc: async (args) => {
          if (!rpc) throw new Error("unavailable");
          return (await rpc(args.method, args.input)) as never;
        },
      },
      threads: {
        get: async ({ threadId }) => {
          if (threadId !== row.id) throw new Error("404");
          return row;
        },
        list: async (args) =>
          args?.parentThreadId
            ? []
            : ([
                {
                  ...row,
                  activity: {
                    activeBackgroundAgentCount: 0,
                    activeBackgroundCommandCount: 0,
                    activeGoalCount: 0,
                    activePlanModeCount: 0,
                    activeWorkflowCount: 0,
                  },
                  environmentHostId: hostId,
                  hasPendingInteraction: pending,
                  queuedWork: "none",
                },
              ] as never),
        interactions: {
          list: async () =>
            pending
              ? ([
                  {
                    payload: {
                      kind: "user_question",
                      questions: [{ prompt: "Approve this deployment?" }],
                    },
                  },
                ] as never)
              : [],
        },
        queue: { list: async () => [] },
        update: async (input) => {
          Object.assign(row, input);
          return row;
        },
      },
    },
  });
  hosts.push(host);
  let engine = createAttention(host.bb),
    manager = createAttentionOwners(
      host.bb,
      {
        ...engine,
        apply: async (input) => {
          applyCalls++;
          return engine.apply(input);
        },
      },
      async () => serverId,
    );
  return {
    ...host,
    row,
    get engine() {
      return engine;
    },
    get manager() {
      return manager;
    },
    get calls() {
      return applyCalls;
    },
    pending(value: boolean) {
      pending = value;
    },
    async reload() {
      await host.harness.lifecycle.reload((bb) => {
        engine = createAttention(bb);
        manager = createAttentionOwners(
          bb,
          {
            ...engine,
            apply: async (input) => {
              applyCalls++;
              return engine.apply(input);
            },
          },
          async () => serverId,
        );
      });
    },
  };
}
const intent = () => ({
  v: 1 as const,
  ownerServerId: "remote-owner",
  hostId: "remote-host",
  requestId: randomUUID(),
  command: {
    kind: "apply" as const,
    input: { threadIds: ["shared-id"], action: "settle" as const },
  },
});
describe("durable owner attention actions", () => {
  it("persists exact-intent receipts across reload, refuses fingerprint conflicts and restores the original native list state", async () => {
    const remote = owner("remote-owner", "remote-host"),
      input = intent(),
      original = structuredClone(remote.row);
    const first = await remote.manager.ownerAction(input);
    expect(first.state).toBe("completed");
    expect(remote.calls).toBe(1);
    expect(remote.row).toEqual(original);
    await remote.reload();
    expect(await remote.manager.ownerAction(input)).toEqual(first);
    expect(remote.calls).toBe(1);
    expect(
      (
        await remote.manager.ownerAction({
          ...input,
          command: { kind: "apply", input: { action: "restore", threadIds: ["shared-id"] } },
        })
      ).state,
    ).toBe("refused");
    const undo = await remote.manager.ownerAction({
      ...input,
      requestId: randomUUID(),
      command: { kind: "undo", receiptId: first.receiptId! },
    });
    expect(undo.results[0]?.ok).toBe(true);
    expect(remote.row).toEqual(original);
    expect((await remote.engine.state()).records[0]?.mode).toBe("open");
  });
  it("never replays a durable claimed action after a crash or accepts the wrong owner/host", async () => {
    const remote = owner("remote-owner", "remote-host"),
      input = ownerAttentionAction.parse(intent());
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          ownerServerId: input.ownerServerId,
          hostId: input.hostId,
          command: input.command,
        }),
      )
      .digest("hex");
    remote.bb.storage
      .database()
      .prepare("INSERT INTO nav_attention_owner_requests VALUES(?,?,?)")
      .run(
        input.requestId,
        fingerprint,
        JSON.stringify({
          v: 1,
          state: "unknown",
          ownerServerId: "remote-owner",
          hostId: "remote-host",
          requestId: input.requestId,
          receiptId: null,
          results: [],
          reason: "Claimed before process stopped",
        }),
      );
    await remote.reload();
    expect((await remote.manager.ownerAction(input)).state).toBe("unknown");
    expect(remote.calls).toBe(0);
    expect((await remote.manager.ownerAction({ ...intent(), hostId: "wrong-host" })).state).toBe(
      "refused",
    );
    expect(remote.calls).toBe(0);
  });
});
describe("finite source-to-owner attention routing", () => {
  function fleetFixture() {
    const remote = owner("remote-owner", "remote-host");
    let dispatches = 0,
      statuses = 0,
      loseResponse = false,
      dropBefore = false;
    let source!: ReturnType<typeof owner>;
    source = owner("source-owner", "source-host", async (method, raw) => {
      const input = raw as { machine: string; ownerServerId?: string; requestId?: string };
      if (method === "attention_inbox_fetch") {
        if (input.machine === "work")
          return { state: "unavailable", reason: "no-authenticated-owner-route", snapshot: null };
        const target = input.machine === "studio" ? remote : source;
        return {
          state: "ok",
          reason: null,
          snapshot: await target.manager.ownerInbox({
            v: 1,
            ownerServerId: input.machine === "studio" ? "remote-owner" : "source-owner",
          }),
        };
      }
      if (input.machine === "work")
        return {
          v: 1,
          state: "unavailable",
          ownerServerId: input.ownerServerId,
          hostId: null,
          requestId: input.requestId,
          receiptId: null,
          results: [],
          reason: "no-authenticated-owner-route",
        };
      const { machine: _, ...payload } = raw as { machine: string } & Parameters<
        typeof remote.manager.ownerAction
      >[0];
      if (method === "attention_action_status") {
        statuses++;
        return remote.manager.ownerStatus(payload);
      }
      dispatches++;
      if (dropBefore) throw new Error("Connection lost before owner delivery");
      const result = await remote.manager.ownerAction(payload);
      if (loseResponse) throw new Error("Owner reply lost");
      return result;
    });
    return {
      source,
      remote,
      get dispatches() {
        return dispatches;
      },
      get statuses() {
        return statuses;
      },
      lose(value: boolean) {
        loseResponse = value;
      },
      drop(value: boolean) {
        dropBefore = value;
      },
    };
  }
  const target = {
    machine: "studio" as const,
    ownerServerId: "remote-owner",
    hostId: "remote-host",
    threadId: "shared-id",
  };
  it("aggregates actual remote questions and addresses duplicate physical thread IDs by owner", async () => {
    const f = fleetFixture();
    f.remote.pending(true);
    const inbox = await f.source.manager.fleetInbox();
    expect(inbox.rows).toHaveLength(2);
    expect(inbox.rows.find((r) => r.remote)?.question).toBe("Approve this deployment?");
    expect(inbox.notices.join()).toContain("Work: no-authenticated-owner-route");
    f.remote.pending(false);
    const result = await f.source.manager.fleetApply({
      requestId: randomUUID(),
      targets: [target],
      action: "retitle",
      title: "Remote reviewed",
    });
    expect(result.results[0]?.ok).toBe(true);
    expect(f.remote.row.title).toBe("Remote reviewed");
    expect(f.source.row.title).toBe("source-owner output");
  });
  it("keeps each remote row's owner machine when the local owner is matched later in the sweep", async () => {
    const f = fleetFixture();
    const inbox = await f.source.manager.fleetInbox();
    const remoteRow = inbox.rows.find((r) => r.remote);
    const localRow = inbox.rows.find((r) => !r.remote);
    expect(remoteRow?.ownerServerId).toBe("remote-owner");
    expect(remoteRow?.machine).toBe("studio");
    expect(localRow?.machine).toBe("laptop");
    const result = await f.source.manager.fleetApply({
      requestId: randomUUID(),
      targets: [
        {
          machine: remoteRow!.machine,
          ownerServerId: remoteRow!.ownerServerId!,
          hostId: remoteRow!.ownerHostId!,
          threadId: remoteRow!.threadId,
        },
      ],
      action: "settle",
    });
    expect(result.results[0]?.ok).toBe(true);
    expect((await f.remote.engine.state()).records[0]?.mode).toBe("settled");
  });
  it("saves a settlement policy on the remote owner using the labelled row's target", async () => {
    const f = fleetFixture();
    const remoteRow = (await f.source.manager.fleetInbox()).rows.find((r) => r.remote)!;
    const policy = {
      autoMerge: false,
      requiredPrUrls: [],
      requiredPrEnvironments: {},
      acceptancePending: false,
      inactiveAfterMs: 3600_000,
    };
    const result = await f.source.manager.fleetPolicy({
      requestId: randomUUID(),
      target: {
        machine: remoteRow.machine,
        ownerServerId: remoteRow.ownerServerId!,
        hostId: remoteRow.ownerHostId!,
        threadId: remoteRow.threadId,
      },
      policy,
    });
    expect(result.results[0]?.ok).toBe(true);
    expect((await f.remote.engine.state()).records[0]?.policy).toMatchObject(policy);
    expect((await f.source.engine.state()).records[0]?.policy?.acceptancePending ?? true).toBe(true);
  });
  it("applies bulk independently per owner, reports partial failure and routes Undo to original owners", async () => {
    const f = fleetFixture();
    const result = await f.source.manager.fleetApply({
      requestId: randomUUID(),
      targets: [
        target,
        {
          machine: "laptop",
          ownerServerId: "source-owner",
          hostId: "source-host",
          threadId: "shared-id",
        },
        { machine: "work", ownerServerId: "m4-owner", hostId: "m4-host", threadId: "m4-thread" },
      ],
      action: "settle",
    });
    expect(result.results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(result.results[2]?.error).toContain("no-authenticated-owner-route");
    const undo = await f.source.manager.fleetUndo({
      requestId: randomUUID(),
      receiptId: result.receiptId,
    });
    expect(undo.results.every((r) => r.ok)).toBe(true);
    expect((await f.remote.engine.state()).records[0]?.mode).toBe("open");
    expect((await f.source.engine.state()).records[0]?.mode).toBe("open");
  });
  it("reconciles a lost reply by status only and never repeats an unknown provider/owner effect", async () => {
    const f = fleetFixture();
    f.lose(true);
    const input = { requestId: randomUUID(), targets: [target], action: "settle" as const };
    expect((await f.source.manager.fleetApply(input)).results[0]?.ok).toBe(false);
    expect(f.remote.calls).toBe(1);
    f.lose(false);
    expect((await f.source.manager.fleetApply(input)).results[0]?.ok).toBe(true);
    expect(f.dispatches).toBe(1);
    expect(f.statuses).toBe(1);
    expect(f.remote.calls).toBe(1);
    const dropped = fleetFixture();
    dropped.drop(true);
    const unknown = { ...input, requestId: randomUUID() };
    await dropped.source.manager.fleetApply(unknown);
    await dropped.source.manager.fleetApply(unknown);
    expect(dropped.dispatches).toBe(1);
    expect(dropped.remote.calls).toBe(0);
  });
  it("uses an exact read-only local receipt shape for an interrupted local action", async () => {
    const f = fleetFixture();
    const input = {
      requestId: randomUUID(),
      target: {
        machine: "laptop" as const,
        ownerServerId: "source-owner",
        hostId: "source-host",
        threadId: "shared-id",
      },
      policy: {
        autoMerge: true,
        requiredPrUrls: [],
        requiredPrEnvironments: {},
        acceptancePending: true,
        inactiveAfterMs: null,
      },
    };
    expect((await f.source.manager.fleetPolicy(input)).results[0]?.ok).toBe(false);
    await expect(f.source.manager.fleetPolicy(input)).resolves.toMatchObject({
      receiptId: input.requestId,
      results: [{ threadId: "shared-id", ok: false }],
    });
  });
  it("routes per-thread automatic overrides to the verified owner", async () => {
    const f = fleetFixture();
    const policy = {
      autoMerge: false,
      requiredPrUrls: [],
      requiredPrEnvironments: {},
      acceptancePending: true,
      inactiveAfterMs: 86400_000,
    };
    const r = await f.source.manager.fleetPolicy({ requestId: randomUUID(), target, policy });
    expect(r.results[0]?.ok).toBe(true);
    expect((await f.remote.engine.state()).records[0]?.policy).toEqual(policy);
    expect((await f.source.engine.state()).records).toEqual([]);
  });
});

describe("odd attention replies from another Mac", () => {
  async function sourceWith(snapshotFor: (row: Record<string, unknown>) => unknown, reason: string | null = null) {
    const remote = owner("remote-owner", "remote-host");
    const snap = await remote.manager.ownerInbox({ v: 1, ownerServerId: "remote-owner" });
    const source = owner("source-owner", "source-host", async (method, raw) => {
      if (method !== "attention_inbox_fetch") throw new Error("unexpected");
      const machine = (raw as { machine: string }).machine;
      if (machine !== "studio") return { state: "unavailable", reason: "no route", snapshot: null };
      if (reason) return { state: "unavailable", reason, snapshot: null };
      return { state: "ok", reason: null, snapshot: { ...snap, rows: snap.rows.map((r) => snapshotFor({ ...r })) } };
    });
    const warn = vi.spyOn(source.bb.log, "warn");
    return { source, warn };
  }

  it("shows an unknown, missing or null status as needs-you, with one notice and one log line per status", async () => {
    for (const make of [
      (r: Record<string, unknown>) => ({ ...r, status: "paused-by-a-future-console" }),
      (r: Record<string, unknown>) => { delete r.status; return r; },
      (r: Record<string, unknown>) => ({ ...r, status: null }),
    ]) {
      const { source, warn } = await sourceWith(make);
      const first = await source.manager.fleetInbox();
      const remoteRow = first.rows.find((r) => r.remote);
      expect(remoteRow?.status).toBe("needs-you");
      expect(first.notices.filter((n) => n.startsWith("Studio:"))).toHaveLength(1);
      expect(first.notices.join()).not.toMatch(/invalid_value|\[\{/);
      await source.manager.fleetInbox();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^studio sent 1 attention row\(s\) with status/);
    }
  });

  it("keeps a known status as it is and logs nothing", async () => {
    const { source, warn } = await sourceWith((r) => ({ ...r, status: "stashed" }));
    const inbox = await source.manager.fleetInbox();
    expect(inbox.rows.find((r) => r.remote)?.status).toBe("stashed");
    expect(warn).not.toHaveBeenCalled();
  });

  it("shows a plain notice for a pasted validation dump and logs the raw reason, trimmed to 2000 characters", async () => {
    const dump = `[{"code":"invalid_value","path":["rows",3,"status"]}${" x".repeat(2000)}]`;
    const { source, warn } = await sourceWith((r) => r, dump);
    const inbox = await source.manager.fleetInbox();
    expect(inbox.notices).toContain("Studio: owner attention could not be read (unexpected reply)");
    expect(inbox.notices.join()).not.toContain("invalid_value");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("invalid_value");
    expect(line.length).toBeLessThanOrEqual(2000 + "Studio attention read refused: ".length);
  });
});

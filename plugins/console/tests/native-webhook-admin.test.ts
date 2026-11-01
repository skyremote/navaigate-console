import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createEventInbox, type EventTransport } from "../server-event-inbox";
import { createWebhookAdmin, HOST_GUARD_MISSING } from "../server-webhook-admin";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
});

const OWNER = { serverId: "sky", machine: "laptop" };
const input = {
  name: "ci-failed",
  projectId: "proj_test",
  providerId: "claude-code",
  model: "claude-sonnet-5-5",
  reasoningLevel: "low",
  prompt: "Reply with the single word ACK.",
};

function fixture(options: { guard?: boolean; resolvedHostId?: string | null; fetch?: typeof fetch; failDelete?: boolean } = {}) {
  const opts = options;
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  let taskCounter = 0;
  const stored = new Map<string, Record<string, unknown>>();
  const transport: EventTransport = {
    available: async () => true,
    run: async () => ({ kind: "admitted", runId: "run-1" }),
  };
  const host = createFakePluginHost({
    pluginId: "webhook-admin-test",
    settings: { webhookEnabled: true, webhookSecret: "", webhookHooks: "[]", webhookPublicBaseUrl: "" },
    sdk: {
      projects: {
        list: async () => [
          { id: "proj_test", name: "Native BB acceptance" },
          { id: "proj_other", name: "Other" },
        ],
      },
      plugins: {
        callRpc: async (args) => {
          const body = args.input as Record<string, unknown>;
          calls.push({ method: args.method, input: body });
          const detail = (id: string, execution: Record<string, unknown>) => ({
            id,
            projectId: body.projectId,
            execution,
            ...(options.guard === false
              ? {}
              : {
                  resolvedHostId: options.resolvedHostId === undefined ? "host-m5" : options.resolvedHostId,
                  experimental_hostGuard: true,
                }),
          });
          if (args.method === "automations_create") {
            const id = `auto_${++taskCounter}`;
            const execution = body.execution as Record<string, unknown>;
            stored.set(id, execution);
            return detail(id, execution) as never;
          }
          if (args.method === "automations_update") {
            const id = body.automationId as string;
            const next = { ...stored.get(id), ...(body.agent as Record<string, unknown>) };
            stored.set(id, next);
            return detail(id, next) as never;
          }
          if (args.method === "automations_get") {
            const id = body.automationId as string;
            return detail(id, stored.get(id) ?? { mode: "agent" }) as never;
          }
          if (args.method === "automations_delete") {
            if (opts.failDelete) throw new Error("delete refused");
            stored.delete(body.automationId as string);
            return { ok: true } as never;
          }
          throw new Error(`unexpected ${args.method}`);
        },
      },
    },
  });
  hosts.push(host);
  const inbox = createEventInbox(host.bb, transport);
  const admin = createWebhookAdmin(host.bb, {
    inbox,
    owner: async () => OWNER,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { ...host, admin, inbox, calls, stored, opts };
}

describe("webhook form server", () => {
  it("creates a paused, far-future Claude task and binds the hook to the host core resolved", async () => {
    const f = fixture();
    const state = await f.admin.save(input);
    const create = f.calls.find((c) => c.method === "automations_create")!.input as Record<string, any>;
    expect(create).toMatchObject({
      projectId: "proj_test",
      name: "Webhook: ci-failed",
      enabled: false,
      origin: "app",
      trigger: { triggerType: "once" },
      execution: {
        mode: "agent",
        providerId: "claude-code",
        model: "claude-sonnet-5-5",
        reasoningLevel: "low",
        prompt: input.prompt,
        environment: { type: "project-default" },
      },
    });
    expect(create.trigger.runAt).toBeGreaterThan(Date.now() + 365 * 86_400_000);
    expect(state.hooks).toEqual([
      expect.objectContaining({
        id: "ci-failed",
        enabled: true,
        ownerServerId: "sky",
        hostId: "host-m5",
        projectId: "proj_test",
        projectName: "Native BB acceptance",
        automationId: "auto_1",
        holdOffline: true,
        agent: expect.objectContaining({ model: "claude-sonnet-5-5", prompt: input.prompt }),
      }),
    ]);
    const stored = JSON.parse((await f.inbox.settings.get()).webhookHooks);
    expect(stored[0]).toMatchObject({ machine: "laptop", ownerServerId: "sky", hostId: "host-m5" });
  });

  it("refuses to bind when this core cannot name the execution host, and removes the task it just made", async () => {
    for (const options of [{ guard: false }, { resolvedHostId: null }]) {
      const f = fixture(options);
      await expect(f.admin.save(input)).rejects.toThrow(HOST_GUARD_MISSING);
      expect(f.calls.map((c) => c.method)).toEqual(["automations_create", "automations_delete"]);
      expect(f.stored.size).toBe(0);
      expect((await f.admin.state()).hooks).toEqual([]);
    }
  });

  it("edits the saved prompt and model in place, keeping the same task and filters", async () => {
    const f = fixture();
    await f.admin.save(input);
    const hooks = JSON.parse((await f.inbox.settings.get()).webhookHooks);
    hooks[0].filters = [{ path: "event", equals: "ci_failed" }];
    await f.inbox.settings.experimental_set({ webhookHooks: JSON.stringify(hooks) });
    const state = await f.admin.save({ ...input, prompt: "Reply with OK.", model: "claude-opus-5-5", coalesceSeconds: 30, holdOffline: false });
    expect(f.calls.filter((c) => c.method === "automations_create")).toHaveLength(1);
    expect(f.calls.find((c) => c.method === "automations_update")!.input).toMatchObject({
      automationId: "auto_1",
      agent: { prompt: "Reply with OK.", model: "claude-opus-5-5", providerId: "claude-code" },
    });
    expect(state.hooks[0]).toMatchObject({ automationId: "auto_1", coalesceSeconds: 30, holdOffline: false });
    expect(JSON.parse((await f.inbox.settings.get()).webhookHooks)[0].filters).toEqual([{ path: "event", equals: "ci_failed" }]);
  });

  it("makes a new task when an existing hook is moved to another project", async () => {
    const f = fixture();
    await f.admin.save(input);
    const state = await f.admin.save({ ...input, projectId: "proj_other" });
    expect(state.hooks).toHaveLength(1);
    expect(state.hooks[0]).toMatchObject({ projectId: "proj_other", automationId: "auto_2" });
  });

  it("deletes the old task once a moved hook is saved, and not before", async () => {
    const f = fixture();
    await f.admin.save(input);
    await f.admin.save({ ...input, projectId: "proj_other" });
    expect(f.calls.filter((c) => c.method === "automations_delete")).toEqual([
      expect.objectContaining({ input: { projectId: "proj_test", automationId: "auto_1" } }),
    ]);
    expect([...f.stored.keys()]).toEqual(["auto_2"]);
  });

  it("saves a moved hook and logs it when the old task cannot be deleted", async () => {
    const f = fixture({ failDelete: true });
    const warn = vi.spyOn(f.bb.log, "warn");
    await f.admin.save(input);
    await f.admin.save({ ...input, projectId: "proj_other" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/ci-failed.*auto_1.*proj_test.*delete refused/);
  });

  it("keeps the old task and removes the new one when a moved hook cannot be written", async () => {
    const f = fixture();
    await f.admin.save(input);
    const set = f.inbox.settings.experimental_set.bind(f.inbox.settings);
    f.inbox.settings.experimental_set = (async () => {
      throw new Error("settings write failed");
    }) as typeof f.inbox.settings.experimental_set;
    await expect(f.admin.save({ ...input, projectId: "proj_other" })).rejects.toThrow("settings write failed");
    f.inbox.settings.experimental_set = set;
    expect([...f.stored.keys()]).toEqual(["auto_1"]);
    const hooks = (await f.admin.state()).hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ projectId: "proj_test", automationId: "auto_1" });
  });

  it("puts the task back as it was when an in-place edit cannot be bound", async () => {
    const f = fixture();
    await f.admin.save(input);
    f.opts.guard = false;
    await expect(f.admin.save({ ...input, prompt: "Changed prompt.", model: "claude-opus-5-5" })).rejects.toThrow(HOST_GUARD_MISSING);
    f.opts.guard = undefined;
    expect(f.stored.get("auto_1")).toMatchObject({
      prompt: input.prompt,
      model: "claude-sonnet-5-5",
      providerId: "claude-code",
      reasoningLevel: "low",
    });
    expect((await f.admin.state()).hooks[0].agent).toMatchObject({ prompt: input.prompt, model: "claude-sonnet-5-5" });
  });

  it("puts the task back as it was when the hook write fails after an in-place edit", async () => {
    const f = fixture();
    await f.admin.save(input);
    const set = f.inbox.settings.experimental_set.bind(f.inbox.settings);
    f.inbox.settings.experimental_set = (async () => {
      throw new Error("settings write failed");
    }) as typeof f.inbox.settings.experimental_set;
    await expect(f.admin.save({ ...input, prompt: "Changed prompt." })).rejects.toThrow("settings write failed");
    f.inbox.settings.experimental_set = set;
    expect(f.stored.get("auto_1")).toMatchObject({ prompt: input.prompt });
    expect(f.calls.filter((c) => c.method === "automations_create")).toHaveLength(1);
  });

  it("does not touch the task when the saved one cannot be read", async () => {
    const f = fixture();
    await f.admin.save(input);
    f.stored.delete("auto_1");
    await expect(f.admin.save({ ...input, prompt: "Changed prompt." })).rejects.toThrow();
    expect(f.calls.filter((c) => c.method === "automations_update")).toHaveLength(0);
  });

  it("rejects names the wire cannot carry and prompts that are empty", async () => {
    const f = fixture();
    await expect(f.admin.save({ ...input, name: "Has Space" })).rejects.toThrow();
    await expect(f.admin.save({ ...input, prompt: "   " })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it("removes a hook and leaves its task alone", async () => {
    const f = fixture();
    await f.admin.save(input);
    const state = await f.admin.remove("ci-failed");
    expect(state.hooks).toEqual([]);
    expect(f.calls.some((c) => c.method === "automations_delete")).toBe(false);
    await expect(f.admin.remove("ci-failed")).rejects.toThrow("No such webhook task.");
  });

  it("returns a new secret once and never in the state", async () => {
    const f = fixture();
    expect((await f.admin.state()).secretSet).toBe(false);
    const { secret } = await f.admin.regenerateSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const state = await f.admin.state();
    expect(state.secretSet).toBe(true);
    expect(JSON.stringify(state)).not.toContain(secret);
    const second = await f.admin.regenerateSecret();
    expect(second.secret).not.toBe(secret);
  });

  it("sends a signed test event through the same admission path a sender uses", async () => {
    const f = fixture();
    await f.admin.configure({ publicBaseUrl: "https://laptop.example.test/" });
    await f.admin.regenerateSecret();
    await f.admin.save(input);
    const result = await f.admin.sendTest("ci-failed");
    expect(result.status).toBe(202);
    expect(result.outcome).toBe("accepted (accepted)");
    expect(result.deliveryId).toMatch(/^test-\d+-[0-9a-f]{6}$/);
    const state = await f.admin.state();
    expect(state.deliveries[0]).toMatchObject({ hookId: "ci-failed", deliveryId: result.deliveryId });
    expect((await f.admin.sendTest("ci-failed")).deliveryId).not.toBe(result.deliveryId);
  });

  it("explains why a test event was not admitted", async () => {
    const f = fixture();
    await f.admin.save(input);
    expect((await f.admin.sendTest("ci-failed")).outcome).toBe("Invalid webhook signature or timestamp.");
    await f.admin.regenerateSecret();
    expect((await f.admin.sendTest("nope")).outcome).toBe("Hook is disabled or unknown.");
    await f.admin.save({ ...input, enabled: false });
    expect((await f.admin.sendTest("ci-failed")).status).toBe(404);
  });

  it("normalises and validates the public address", async () => {
    const f = fixture();
    const state = await f.admin.configure({ publicBaseUrl: "https://laptop.example.test///" });
    expect(state.publicBaseUrl).toBe("https://laptop.example.test");
    expect(state.endpoint).toBe("https://laptop.example.test/api/v1/plugins/webhook-admin-test/http/automation-hook");
    await expect(f.admin.configure({ publicBaseUrl: "http://laptop.example.test" })).rejects.toThrow();
    expect((await f.admin.configure({ enabled: false })).masterEnabled).toBe(false);
  });
});

describe("webhook reachability check", () => {
  const reply = (body: string, type: string, status: number) =>
    (async () => new Response(body, { status, headers: { "content-type": type } })) as unknown as typeof fetch;

  it("reports a sender can reach the bb when its own JSON refusal comes back", async () => {
    const f = fixture({ fetch: reply('{"error":"Hook is disabled or unknown."}', "application/json", 404) });
    await f.admin.configure({ publicBaseUrl: "https://laptop.example.test" });
    expect(await f.admin.probe()).toMatchObject({ verdict: "reachable", status: 404 });
  });

  it("names BB Connect's sign-in page as the blocker", async () => {
    const f = fixture({ fetch: reply("<html>bb connect</html>", "text/html; charset=utf-8", 401) });
    await f.admin.configure({ publicBaseUrl: "https://laptop.example.test" });
    const result = await f.admin.probe();
    expect(result.verdict).toBe("sign-in-wall");
    expect(result.status).toBe(401);
    expect(result.detail).toContain("BB Connect");
  });

  it("reports an unreachable address and an unset one", async () => {
    const down = fixture({ fetch: (async () => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch });
    expect((await down.admin.probe()).verdict).toBe("not-configured");
    await down.admin.configure({ publicBaseUrl: "https://nowhere.example" });
    expect(await down.admin.probe()).toMatchObject({ verdict: "unreachable", detail: "getaddrinfo ENOTFOUND" });
  });
});

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  eventReceipt,
  hookConfig,
  webhookSignature,
  type HookConfig,
  type createEventInbox,
} from "./server-event-inbox";
import { knownMachine, machineKeys } from "./server-words";

type EventInbox = ReturnType<typeof createEventInbox>;

const MAX_HOOKS = 50;
const TASK_HORIZON_MS = 3 * 365 * 86_400_000;
const PROBE_TIMEOUT_MS = 8_000;

export const hookName = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9_-]+$/, "Use lowercase letters, digits, hyphens and underscores");

const reasoning = z.string().trim().min(1).max(40);
export const webhookSaveInput = z
  .object({
    name: hookName,
    projectId: z.string().trim().min(1).max(128),
    providerId: z.string().trim().min(1).max(128).default("claude-code"),
    model: z.string().trim().min(1).max(128),
    reasoningLevel: reasoning.default("medium"),
    prompt: z.string().trim().min(1).max(8_000),
    enabled: z.boolean().default(true),
    holdOffline: z.boolean().default(true),
    coalesceSeconds: z.number().int().min(0).max(3600).default(0),
  })
  .strict();
export type WebhookSaveInput = z.input<typeof webhookSaveInput>;

export const webhookSettingsInput = z
  .object({
    enabled: z.boolean().optional(),
    publicBaseUrl: z.string().trim().max(300).optional(),
  })
  .strict();

const agentView = z
  .object({
    providerId: z.string(),
    model: z.string(),
    reasoningLevel: z.string(),
    prompt: z.string(),
  })
  .strict();
export const webhookHookView = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    holdOffline: z.boolean(),
    coalesceSeconds: z.number(),
    ownerServerId: z.string(),
    hostId: z.string(),
    projectId: z.string(),
    projectName: z.string().nullable(),
    automationId: z.string(),
    agent: agentView.nullable(),
    agentError: z.string().nullable(),
  })
  .strict();
export const webhookFormState = z
  .object({
    masterEnabled: z.boolean(),
    publicBaseUrl: z.string(),
    endpoint: z.string().nullable(),
    secretSet: z.boolean(),
    owner: z.object({ serverId: z.string(), machine: z.string().nullable() }).nullable(),
    hooks: z.array(webhookHookView),
    deliveries: z.array(eventReceipt),
  })
  .strict();
export type WebhookFormState = z.infer<typeof webhookFormState>;

export const webhookProject = z.object({ id: z.string(), name: z.string() }).strict();
export const webhookTestResult = z
  .object({
    status: z.number(),
    deliveryId: z.string(),
    outcome: z.string(),
    receipt: eventReceipt.nullable(),
  })
  .strict();
export const webhookProbeResult = z
  .object({
    verdict: z.enum(["reachable", "sign-in-wall", "unreachable", "not-configured"]),
    status: z.number().nullable(),
    detail: z.string(),
  })
  .strict();

const automationDetail = z
  .object({
    id: z.string(),
    projectId: z.string(),
    execution: z.object({ mode: z.string() }).passthrough(),
    resolvedHostId: z.string().nullable().optional(),
    experimental_hostGuard: z.boolean().optional(),
  })
  .passthrough();
const automationRead = automationDetail.extend({ problem: z.string().optional() });

export const HOST_GUARD_MISSING =
  "This bb cannot confirm which machine will run the task, so a webhook cannot be bound safely. Update bb core to a build with the execution host guard first.";

export function createWebhookAdmin(
  bb: BbPluginApi,
  deps: {
    inbox: EventInbox;
    owner(): Promise<{ serverId: string; machine: string | null } | null>;
    now?: () => number;
    fetch?: typeof fetch;
  },
) {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const settings = deps.inbox.settings;
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  type RpcInput = Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]["input"];
  const callAutomations = <T extends z.ZodTypeAny>(method: string, input: RpcInput, outputSchema: T) =>
    bb.sdk.plugins.callRpc({ pluginId: "automations", method, input, outputSchema, signal: AbortSignal.timeout(15_000) }) as Promise<z.infer<T>>;

  async function currentHooks(): Promise<HookConfig[]> {
    const raw = (await settings.get()).webhookHooks;
    return z.array(hookConfig).max(MAX_HOOKS).parse(JSON.parse(raw));
  }
  const writeHooks = (hooks: HookConfig[]) =>
    settings.experimental_set({ webhookHooks: JSON.stringify(hooks) });

  async function projectNames(): Promise<Map<string, string>> {
    const list = (await bb.sdk.projects.list()) as unknown;
    const rows = Array.isArray(list) ? list : ((list as { projects?: unknown[] } | null)?.projects ?? []);
    return new Map(
      (rows as { id?: unknown; name?: unknown }[])
        .filter((p) => typeof p.id === "string" && typeof p.name === "string")
        .map((p) => [p.id as string, p.name as string]),
    );
  }

  async function agentFor(hook: HookConfig, owner: string | null) {
    if (hook.ownerServerId !== owner)
      return { agent: null, agentError: "The task lives on another machine's bb." };
    try {
      const task = await callAutomations(
        "automations_get",
        { projectId: hook.projectId, automationId: hook.automationId },
        automationRead,
      );
      if (task.problem || task.execution.mode !== "agent")
        return { agent: null, agentError: "The saved task is not a readable agent task." };
      const e = task.execution as Record<string, unknown>;
      return {
        agent: {
          providerId: String(e.providerId ?? ""),
          model: String(e.model ?? ""),
          reasoningLevel: String(e.reasoningLevel ?? "medium"),
          prompt: String(e.prompt ?? ""),
        },
        agentError: null,
      };
    } catch (error) {
      return { agent: null, agentError: error instanceof Error ? error.message : String(error) };
    }
  }

  async function state(): Promise<WebhookFormState> {
    const [s, hooks, owner, inbox] = await Promise.all([
      settings.get(),
      currentHooks(),
      deps.owner().catch(() => null),
      deps.inbox.state(),
    ]);
    const names = await projectNames().catch(() => new Map<string, string>());
    const views = await Promise.all(
      hooks.map(async (h) => ({
        id: h.id,
        enabled: h.enabled,
        holdOffline: h.holdOffline,
        coalesceSeconds: h.coalesceSeconds,
        ownerServerId: h.ownerServerId,
        hostId: h.hostId,
        projectId: h.projectId,
        projectName: names.get(h.projectId) ?? null,
        automationId: h.automationId,
        ...(await agentFor(h, owner?.serverId ?? null)),
      })),
    );
    return {
      masterEnabled: s.webhookEnabled,
      publicBaseUrl: s.webhookPublicBaseUrl,
      endpoint: inbox.endpoint,
      secretSet: s.webhookSecret.length >= 32,
      owner,
      hooks: views,
      deliveries: inbox.receipts.slice(0, 50),
    };
  }

  async function projects() {
    return [...(await projectNames()).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates or updates the task the hook runs, then writes the hook that points at it. */
  function save(raw: WebhookSaveInput): Promise<WebhookFormState> {
    return exclusive(async () => {
      const input = webhookSaveInput.parse(raw);
      const owner = await deps.owner();
      if (!owner) throw new Error("This bb's fleet identity is unavailable, so the owning machine cannot be named.");
      const hooks = await currentHooks();
      const existing = hooks.find((h) => h.id === input.name);
      if (!existing && hooks.length >= MAX_HOOKS) throw new Error(`At most ${MAX_HOOKS} webhook tasks are allowed.`);
      if (existing && existing.ownerServerId !== owner.serverId)
        throw new Error("This hook belongs to another machine's bb; edit it there.");

      const execution = {
        mode: "agent" as const,
        prompt: input.prompt,
        providerId: input.providerId,
        model: input.model,
        reasoningLevel: input.reasoningLevel,
        permissionMode: "accept-edits" as const,
        environment: { type: "project-default" as const },
      };
      const deleteOk = z.object({ ok: z.literal(true) }).passthrough();
      const deleteTask = (projectId: string, automationId: string) =>
        callAutomations("automations_delete", { projectId, automationId }, deleteOk);
      const sameProject = existing !== undefined && existing.projectId === input.projectId;

      // Editing in place: remember what the task said so a failed save can put it back.
      let before: { prompt: string; providerId: string; model: string; reasoningLevel: string } | null = null;
      if (existing && sameProject) {
        const was = await agentFor(existing, owner.serverId);
        if (!was.agent || !was.agent.prompt || !was.agent.providerId || !was.agent.model)
          throw new Error(was.agentError ?? "The saved task cannot be read, so it cannot be edited safely.");
        before = was.agent;
      }

      let automationId: string;
      let hostId: string | null | undefined;
      let guard: boolean | undefined;
      let touched = false;
      const undo = async () => {
        if (!touched) return;
        if (before && existing)
          await callAutomations(
            "automations_update",
            { projectId: existing.projectId, automationId: existing.automationId, agent: before },
            automationDetail,
          ).catch(() => {});
        else await deleteTask(input.projectId, automationId).catch(() => {});
      };
      try {
        if (existing && sameProject) {
          touched = true;
          const task = await callAutomations(
            "automations_update",
            {
              projectId: input.projectId,
              automationId: existing.automationId,
              agent: {
                prompt: input.prompt,
                providerId: input.providerId,
                model: input.model,
                reasoningLevel: input.reasoningLevel,
              },
            },
            automationDetail,
          );
          automationId = task.id;
          hostId = task.resolvedHostId;
          guard = task.experimental_hostGuard;
        } else {
          const task = await callAutomations(
            "automations_create",
            {
              projectId: input.projectId,
              name: `Webhook: ${input.name}`,
              enabled: false,
              trigger: { triggerType: "once", runAt: now() + TASK_HORIZON_MS },
              execution,
              origin: "app",
            },
            automationDetail,
          );
          automationId = task.id;
          hostId = task.resolvedHostId;
          guard = task.experimental_hostGuard;
          touched = true;
        }
        if (guard !== true || !hostId) throw new Error(HOST_GUARD_MISSING);
        const hook: HookConfig = hookConfig.parse({
          id: input.name,
          enabled: input.enabled,
          ownerServerId: owner.serverId,
          ...(knownMachine(owner.machine)
            ? { machine: owner.machine }
            : {}),
          hostId,
          projectId: input.projectId,
          automationId,
          holdOffline: input.holdOffline,
          coalesceSeconds: input.coalesceSeconds,
          filters: existing?.filters ?? [],
        });
        await writeHooks(existing ? hooks.map((h) => (h.id === hook.id ? hook : h)) : [...hooks, hook]);
      } catch (error) {
        // The hook was not written, so the task must look as it did before this save.
        await undo();
        throw error;
      }
      // Moved to another project: the hook now points at a new task, so the old one is orphaned.
      if (existing && !sameProject) await deleteTask(existing.projectId, existing.automationId).catch((error: unknown) =>
        bb.log.warn(`webhook ${existing.id}: could not delete the old task ${existing.automationId} in project ${existing.projectId} after the move: ${error instanceof Error ? error.message : String(error)}`),
      );
      return state();
    });
  }

  function remove(id: string): Promise<WebhookFormState> {
    return exclusive(async () => {
      const hooks = await currentHooks();
      if (!hooks.some((h) => h.id === id)) throw new Error("No such webhook task.");
      await writeHooks(hooks.filter((h) => h.id !== id));
      return state();
    });
  }

  function configure(raw: z.infer<typeof webhookSettingsInput>): Promise<WebhookFormState> {
    return exclusive(async () => {
      const input = webhookSettingsInput.parse(raw);
      await settings.experimental_set({
        ...(input.enabled === undefined ? {} : { webhookEnabled: input.enabled }),
        ...(input.publicBaseUrl === undefined ? {} : { webhookPublicBaseUrl: input.publicBaseUrl.replace(/\/+$/, "") }),
      });
      return state();
    });
  }

  /** The new secret is returned once, here; reads never include it. */
  function regenerateSecret(): Promise<{ secret: string }> {
    return exclusive(async () => {
      const secret = randomBytes(32).toString("hex");
      await settings.experimental_set({ webhookSecret: secret });
      return { secret };
    });
  }

  /** Signs with the stored secret on the server and admits the event through the same path a sender uses. */
  async function sendTest(id: string) {
    const config = await settings.get();
    const secret = config.webhookSecret;
    // The owner is signed in here, so the form can say what a sender is never told: the public route answers an unknown or disabled hook like a bad signature.
    const target = (await currentHooks()).find((h) => h.id === id);
    if (!config.webhookEnabled || !target || !target.enabled)
      return { status: 404, deliveryId: "", outcome: "Hook is disabled or unknown.", receipt: null };
    const deliveryId = `test-${now()}-${randomBytes(3).toString("hex")}`;
    const raw = JSON.stringify({ event: "test", source: "settings", sentAt: new Date(now()).toISOString() });
    const timestamp = String(now());
    const headers = new Headers({
      "content-type": "application/json",
      "x-nav-hook": id,
      "x-nav-delivery": deliveryId,
      "x-nav-timestamp": timestamp,
      "x-nav-signature": webhookSignature(secret, id, timestamp, deliveryId, raw),
    });
    const result = await deps.inbox.receive(headers, raw);
    const parsed = eventReceipt.safeParse((result.body as { receipt?: unknown }).receipt);
    const error = (result.body as { error?: unknown }).error;
    return {
      status: result.status,
      deliveryId,
      outcome: parsed.success
        ? `accepted (${parsed.data.state})`
        : typeof error === "string"
          ? error
          : `status ${result.status}`,
      receipt: parsed.success ? parsed.data : null,
    };
  }

  /**
   * Posts an unsigned, empty request to the public address. Only this plugin's
   * own JSON refusal proves a sender can reach it; BB Connect's sign-in page does not.
   */
  async function probe() {
    const { endpoint } = await deps.inbox.state();
    if (!endpoint) return { verdict: "not-configured" as const, status: null, detail: "Set the public address first." };
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-nav-hook": "reachability-check" },
        body: "{}",
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const type = response.headers.get("content-type") ?? "";
      const text = (await response.text()).slice(0, 4_000);
      if (type.includes("application/json") && /"error"/.test(text))
        return { verdict: "reachable" as const, status: response.status, detail: "A sender can reach this bb: it answered with its own refusal." };
      return {
        verdict: "sign-in-wall" as const,
        status: response.status,
        detail:
          "The address answered with a sign-in page, not this bb. BB Connect only lets a signed-in owner through, so an outside sender will be refused before it reaches the hook.",
      };
    } catch (error) {
      return { verdict: "unreachable" as const, status: null, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  return { state, projects, save, remove, configure, regenerateSecret, sendTest, probe };
}

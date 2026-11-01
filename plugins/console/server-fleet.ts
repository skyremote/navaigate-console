// The rail's link to the Fleet plugin (navaigate-bb-mods/fleet): its board of
// every Mac's machines and live chats, which Fleet publishes through the
// brain, its "start work on that Mac" route, and its mirror, which opens a
// chat from another Mac here as a hidden, owner-routed local copy. All go
// through bb.sdk.plugins.callRpc, so the skin never talks to the brain
// itself. With Fleet missing, stopped or failing, the board is simply
// unavailable and the rail draws exactly as it did before the machine row.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { FleetBoard } from "./src/machines";

const FLEET = "fleet";
const resourceSchema = z.object({ observedAt: z.number(), cpuCount: z.number(), cpuUtilization: z.number().nullable(), totalMemoryBytes: z.number(), availableMemoryBytes: z.number() });
const num = z.number().nullable().catch(null);
const systemSchema = z.object({
  cpuPercent: num, cores: num, loadAvg: z.tuple([z.number(), z.number(), z.number()]).nullable().catch(null),
  memUsedBytes: num, memTotalBytes: num, memPressure: z.enum(["normal", "warn", "critical"]).nullable().catch(null),
  swapUsedBytes: num, diskFreeBytes: num, diskTotalBytes: num, keepAwake: z.array(z.string()).catch([]),
});
const ownerFields = { ownerStatus: z.enum(["live", "stale", "unknown"]).optional(), ownerOnline: z.boolean().optional(), enrolledOnline: z.boolean().optional(), resources: resourceSchema.nullable().optional(), system: systemSchema.nullable().optional().catch(undefined) };
export const fleetWorkspaceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("managed-worktree"), baseBranch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("default") }).strict(), z.object({ kind: z.literal("named"), name: z.string().min(1).max(240) }).strict()]) }).strict(),
  z.object({ type: z.literal("unmanaged"), path: z.null(), branch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("existing"), name: z.string().min(1).max(240) }).strict(), z.object({ kind: z.literal("new"), baseBranch: z.string().min(1).max(240) }).strict()]).optional() }).strict(),
]);
const projectFields = { projectId: z.string().min(1).max(120).optional(), projectName: z.string().min(1).max(200).optional(), workspace: fleetWorkspaceSchema.optional() };
export const fleetAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]), sourceProjectId: z.string().min(1).max(250), path: z.string().min(1).max(2000),
  name: z.string().min(1).max(240), mimeType: z.string().max(200).nullable(),
}).strict();
export const fleetVerifiedAttachmentSchema = z.object({
  name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative().max(8 * 1024 * 1024), verified: z.literal(true),
}).strict();
export const fleetNotStartedSchema = z.object({ reason: z.enum(["rejected", "unavailable"]), message: z.string() }).strict();
const attachmentFields = { attachments: z.array(fleetAttachmentSchema).min(1).max(10).optional() };

const remoteThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(["running", "needs-you", "queued", "error", "idle"]).catch("idle"),
  machine: z.string(),
  projectName: z.string().nullable().catch(null),
  providerId: z.string().nullable().catch(null),
  updatedAt: z.number(),
  url: z.string().nullable().catch(null),
  via: z.string(),
});

// Tolerant on purpose: Fleet's board carries more than the rail needs, and
// newer Fleets may add fields.
export const fleetBoardSchema = z.object({
  me: z.object({ serverId: z.string(), machineKey: z.string().optional() }).passthrough(),
  columns: z.array(
    z
      .object({
        key: z.string(),
        label: z.string(),
        serverId: z.string().nullable(),
        online: z.boolean(),
        lastSeenAt: z.number().nullable(),
        threads: z.array(remoteThreadSchema),
        mirror: z.boolean().optional().catch(undefined),
        ...ownerFields,
      })
      .passthrough(),
  ),
  error: z.string().nullable().optional(),
}).passthrough();

const startResultSchema = z.object({
  outcome: z.enum(["started", "sent"]),
  threadId: z.string().nullable(),
  requestId: z.string().optional(),
  commandId: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
}).passthrough();

export const fleetRouteSchema = z.object({
  machine: z.string().nullable(), serverId: z.string().nullable(), hostId: z.string().nullable(),
  mode: z.enum(["auto", "manual"]), reason: z.string(), warnings: z.array(z.string()),
  candidates: z.array(z.object({ machine: z.string(), serverId: z.string(), hostId: z.string().nullable(), eligible: z.boolean(), reasons: z.array(z.string()), score: z.number().nullable() })),
});
const executionFields = {
  providerId: z.string().min(1).max(120).optional(), model: z.string().min(1).max(200).optional(),
  reasoningLevel: z.string().min(1).max(80).optional(), serviceTier: z.string().min(1).max(80).optional(),
  routing: z.object({ workload: z.string().min(1).max(60).optional(), needsNas: z.boolean().optional(), unattended: z.boolean().optional(), requiredCapabilities: z.array(z.string()).max(20).optional() }).strict().optional(),
};

/** What Fleet's owner detail says about one Mac's providers and verified tools; tolerant of fields the preview does not use. */
export const fleetOwnerDetailSchema = z.object({
  providers: z.array(z.object({
    id: z.string(), available: z.boolean(), observedAt: z.number(),
    displayName: z.string().optional(), auth: z.string().optional(), planLabel: z.string().nullable().optional(),
  }).passthrough()).nullable().catch(null),
  capabilities: z.object({ xcode: z.object({ verified: z.boolean(), version: z.string().nullable() }).passthrough() }).passthrough().nullable().catch(null),
}).passthrough();

export const fleetBoardResultSchema = z.object({
  available: z.boolean(),
  board: z
    .object({
      serverId: z.string(),
      serverKey: z.string(),
      columns: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          serverId: z.string().nullable(),
          online: z.boolean(),
          lastSeenAt: z.number().nullable(),
          threads: z.array(remoteThreadSchema),
          mirror: z.boolean().optional(),
          ...ownerFields,
        }),
      ),
    })
    .nullable(),
  error: z.string().nullable(),
});
export type FleetBoardResult = z.infer<typeof fleetBoardResultSchema>;

export const fleetStartInput = z.object({
  machine: z.string().trim().min(1).max(40),
  prompt: z.string().trim().min(1).max(256 * 1024).refine((value) => Buffer.byteLength(value, "utf8") <= 256 * 1024, "Prompt must fit within 256 KiB of UTF-8"),
  title: z.string().trim().min(1).max(120).optional(),
  requestId: z.string().uuid().optional(),
  ...projectFields,
  ...executionFields,
  ...attachmentFields,
}).strict();
export const fleetRouteInput = z.object({ machine: z.string().trim().min(1).max(40), ...projectFields, ...executionFields, ...attachmentFields }).strict();
export const fleetStartOutput = z.object({ outcome: z.enum(["started", "sent"]), threadId: z.string().nullable(), requestId: z.string().optional(), commandId: z.string().nullable().optional(), url: z.string().nullable().optional(), route: fleetRouteSchema.optional(), attachments: z.array(fleetVerifiedAttachmentSchema).max(10).optional() });
const currentStartResultSchema = startResultSchema.extend({ route: fleetRouteSchema.optional(), attachments: z.array(fleetVerifiedAttachmentSchema).max(10).optional() });

export const fleetMirrorOpenInput = z.object({
  machine: z.string().trim().min(1).max(40),
  threadId: z.string().trim().min(1).max(100),
  localProjectId: z.string().min(1).max(120).optional(),
}).strict();
export const fleetMirrorOpenOutput = z.object({ localThreadId: z.string() });
const mirrorOpenResultSchema = z.object({ localThreadId: z.string().min(1) }).passthrough();

const MESSAGE_MAX_BYTES = 256 * 1024;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const REMOTE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/;

/** Tell, read the answer and read an ask back are Fleet methods newer than the released Fleet; "offered: false" means this Fleet has not got them yet. */
export const fleetTellInput = z.object({
  machine: z.string().trim().min(1).max(40),
  threadId: z.string().regex(REMOTE_THREAD_ID),
  message: z.string().trim().min(1).max(MESSAGE_MAX_BYTES).refine((value) => Buffer.byteLength(value, "utf8") <= MESSAGE_MAX_BYTES, "Message must fit within 256 KiB of UTF-8"),
  requestId: z.string().regex(RECEIPT_ID),
}).strict();
export const fleetTellOutput = z.discriminatedUnion("offered", [
  z.object({ offered: z.literal(true), requestId: z.string(), delivered: z.boolean(), delivery: z.string(), url: z.string().nullable(), note: z.string().optional() }),
  z.object({ offered: z.literal(false) }),
]);
export const fleetOutputInput = z.object({ machine: z.string().trim().min(1).max(40), threadId: z.string().regex(REMOTE_THREAD_ID) }).strict();
export const fleetOutputOutput = z.discriminatedUnion("offered", [
  z.object({ offered: z.literal(true), state: z.string(), output: z.string(), truncated: z.boolean() }),
  z.object({ offered: z.literal(false) }),
]);
export const fleetReceiptInput = z.object({ id: z.string().regex(RECEIPT_ID) }).strict();
export const fleetReceiptOutput = z.discriminatedUnion("offered", [
  z.object({ offered: z.literal(true), state: z.enum(["ready", "pending", "failed"]), message: z.string().nullable(), output: z.string().nullable(), truncated: z.boolean(), url: z.string().nullable() }),
  z.object({ offered: z.literal(false) }),
]);

const answerFields = z.object({ state: z.string(), output: z.string(), truncated: z.boolean(), url: z.string().nullable().catch(null) }).passthrough();
const tellReply = z.object({ requestId: z.string(), delivered: z.boolean(), delivery: z.string(), url: z.string().nullable().catch(null), note: z.string().optional() }).passthrough();
const receiptReply = z.object({ state: z.enum(["ready", "pending", "failed"]), url: z.string().nullable().catch(null), message: z.string().nullable().catch(null), answer: answerFields.nullable().catch(null) }).passthrough();

/** True when Fleet answered that it has no such method, rather than failing to run one it has. */
export function methodMissing(cause: unknown): boolean {
  if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "unknown_method") return true;
  return /\bhas no rpc method\b/.test(cause instanceof Error ? cause.message : String(cause));
}

const BOARD_TTL_MS = 2000;
const BOARD_FAILURE_TTL_MS = 3000;

/**
 * `homeKey` names this bb's own machine when Fleet does not say (the profile's "this machine");
 * server.ts passes it in so this file needs nothing but node:test to run.
 */
export function createFleetLink(bb: BbPluginApi, homeKey: () => string = () => "") {
  let boardCache: { until: number; value: FleetBoardResult } | null = null;
  let boardPending: Promise<FleetBoardResult> | null = null;
  function board(): Promise<FleetBoardResult> {
    if (boardCache && boardCache.until > Date.now()) return Promise.resolve(boardCache.value);
    if (boardPending) return boardPending;
    const pending: Promise<FleetBoardResult> = readBoard()
      .then((value) => {
        boardCache = { until: Date.now() + (value.available ? BOARD_TTL_MS : BOARD_FAILURE_TTL_MS), value };
        return value;
      })
      .finally(() => {
        if (boardPending === pending) boardPending = null;
      });
    boardPending = pending;
    return pending;
  }
  async function readBoard(): Promise<FleetBoardResult> {
    try {
      const raw = await bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "board_get", input: null, outputSchema: fleetBoardSchema });
      const own = raw.columns.find((c) => c.serverId === raw.me.serverId);
      const serverKey = raw.me.machineKey ?? own?.key ?? homeKey();
      const result: FleetBoard = {
        serverId: raw.me.serverId,
        serverKey,
        columns: raw.columns.map((c) => ({
          key: c.key,
          label: c.label,
          serverId: c.serverId,
          online: c.online,
          lastSeenAt: c.lastSeenAt,
          threads: c.threads,
          mirror: c.mirror === true,
          ...(c.ownerStatus ? { ownerStatus: c.ownerStatus } : {}),
          ...(c.ownerOnline !== undefined ? { ownerOnline: c.ownerOnline } : {}),
          ...(c.enrolledOnline !== undefined ? { enrolledOnline: c.enrolledOnline } : {}),
          ...(c.resources !== undefined ? { resources: c.resources } : {}),
          ...(c.system !== undefined ? { system: c.system } : {}),
        })),
      };
      return { available: true, board: result, error: raw.error ?? null };
    } catch (cause) {
      return { available: false, board: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function start(input: z.infer<typeof fleetStartInput>): Promise<z.infer<typeof fleetStartOutput>> {
    const r = await bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "work_start", input, outputSchema: currentStartResultSchema });
    boardCache = null;
    return { outcome: r.outcome, threadId: r.threadId, ...(r.requestId ? { requestId: r.requestId } : {}), ...(r.commandId !== undefined ? { commandId: r.commandId } : {}), ...(r.url !== undefined ? { url: r.url } : {}), ...(r.route ? { route: r.route } : {}), ...(r.attachments ? { attachments: r.attachments } : {}) };
  }
  const route = (input: z.infer<typeof fleetRouteInput>) => bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "route_preview", input, outputSchema: fleetRouteSchema });

  /**
   * The local copy of a chat that runs on another Mac (Fleet mirror_open):
   * made on the first open, reused after. Throws when Fleet cannot mirror it,
   * so the rail can fall back to that Mac's own bb page.
   */
  async function mirrorOpen(input: z.infer<typeof fleetMirrorOpenInput>): Promise<z.infer<typeof fleetMirrorOpenOutput>> {
    const r = await bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "mirror_open", input, outputSchema: mirrorOpenResultSchema });
    boardCache = null;
    return { localThreadId: r.localThreadId };
  }

  const ownerDetail = (machine: string) => bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "owner_detail_get", input: { machine }, outputSchema: fleetOwnerDetailSchema });
  const commandGet = (input: { commandId: string }) => bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "command_get", input, outputSchema: z.object({ status: z.enum(["pending", "starting", "started", "failed", "unknown"]), machine: z.string().nullable(), threadId: z.string().nullable(), url: z.string().nullable(), error: z.string().nullable() }) });
  const workReceipt = (input: { requestId: string }) => bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "work_receipt", input, outputSchema: z.object({ state: z.enum(["completed", "unknown", "missing"]), result: currentStartResultSchema.nullable(), notStarted: fleetNotStartedSchema.optional() }) });

  async function tell(input: z.infer<typeof fleetTellInput>): Promise<z.infer<typeof fleetTellOutput>> {
    try {
      const r = await bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "thread_tell", input, outputSchema: tellReply });
      boardCache = null;
      return { offered: true, requestId: r.requestId, delivered: r.delivered, delivery: r.delivery, url: r.url, ...(r.note ? { note: r.note } : {}) };
    } catch (cause) {
      if (methodMissing(cause)) return { offered: false };
      throw cause;
    }
  }

  async function output(input: z.infer<typeof fleetOutputInput>): Promise<z.infer<typeof fleetOutputOutput>> {
    try {
      const r = await bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "thread_output_get", input, outputSchema: answerFields });
      return { offered: true, state: r.state, output: r.output, truncated: r.truncated };
    } catch (cause) {
      if (methodMissing(cause)) return { offered: false };
      throw cause;
    }
  }

  async function receipt(input: z.infer<typeof fleetReceiptInput>): Promise<z.infer<typeof fleetReceiptOutput>> {
    try {
      const r = await bb.sdk.plugins.callRpc({ pluginId: FLEET, method: "receipt_result", input, outputSchema: receiptReply });
      return { offered: true, state: r.state, message: r.message, output: r.answer?.output ?? null, truncated: r.answer?.truncated ?? false, url: r.answer?.url ?? r.url };
    } catch (cause) {
      if (methodMissing(cause)) return { offered: false };
      throw cause;
    }
  }

  return { board, start, route, ownerDetail, mirrorOpen, commandGet, workReceipt, tell, output, receipt };
}

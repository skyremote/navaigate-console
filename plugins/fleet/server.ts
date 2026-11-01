// bb-plugin-fleet — backend entry.
//
// One board for every machine its owner runs bb on (the machines come from the
// profile). Each bb publishes a snapshot of itself (machines, live and recent
// threads) to the brain's Turso database every 30s and polls it for work
// another machine asked it to start. Pull-only: no machine needs an inbound
// route to another, so a machine behind a VPN works as long as it can reach
// turso.io over HTTPS. Publishing is OFF until "Join the fleet" is switched on
// in this plugin's settings, per machine. With one machine and no brain the
// board shows just this Mac and every remote feature stays inert.
//
// Two-way (fleet_messages / fleet_outputs): `bb fleet tell` queues a message
// for a thread on another machine, whose Fleet delivers it with the local
// `bb thread tell`; each Fleet publishes the latest answer of every thread
// started or messaged through Fleet once it settles, so `bb fleet ask`,
// `tell --wait`, `output` and `result` can read it back. The older
// Existing plaintext fleet_commands remain readable. New command/control writes
// require sealed-relay-v1 and use the destination's existing mirror key; no
// plaintext downgrade is allowed. Broker write-access trust is unchanged: this
// seals recipient content, but does not independently authenticate the sender.
//
// Mirror (mirror/): a chat on another machine opens here as a hidden,
// local copy on the model-free fleet-mirror provider, with native owner controls, fed through
// the brain with end-to-end sealed rows (fleet_mirror_watch / fleet_mirror_events).
import { execFile } from "node:child_process";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { cpus, freemem, homedir, hostname, totalmem } from "node:os";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { defineRpcContract, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  MESSAGE_MAX_BYTES,
  OUTPUT_MAX_BYTES,
  RELAY_COMMANDS,
  RELAY_FEATURES,
  RELAY_USAGE,
  EXECUTION_FEATURE,
  SEALED_RELAY_FEATURE,
  SEALED_COMMAND_PLACEHOLDER,
  SEALED_CONTROL_PLACEHOLDER,
  commandAad,
  controlAad,
  buildColumns,
  columnSchema,
  composeMessage,
  chooseRoute,
  commandOptions,
  decidePublish,
  isSettled,
  machineKeyForHost,
  macAvailableMemoryBytes,
  buildSystem,
  executionSelection,
  executionSelectionSchema,
  readCommandOptions,
  routeDecisionSchema,
  routingPreferencesSchema,
  workProjectSchema,
  parseRelayArgs,
  selectThreads,
  snapshotSchema,
  threadStateSchema,
  threadState,
  threadUrl,
  truncateUtf8,
  utf8Length,
  type FleetThread,
  type ExecutionSelection,
  type MachineInfo,
  type PublishedOutput,
  type RelayCommand,
  type RelayCommandName,
  type System,
  type Snapshot,
  type RoutingPreferences,
  type WorkProject,
  type ThreadState,
} from "./model";
import { TursoClient, loadBrainCredentials, type Row } from "./turso";
import { loadProfile } from "./profile/load";
import { offMessage, pickedOff, picksOff, type FleetGatedId } from "./lib/picks";
import { alwaysOnMachine, COMMUNITY_DEFAULTS, isRestricted, setupDone, machineLabel as profileMachineLabel, machineOrder, thisMachine } from "./profile/schema";
import { directRouteMachine, fleetSection, isFleetMachine, isWorkloadId, resolveMachineId, workloadLabel, workloadIds, DEFAULT_INSTALL_URL, GENERAL_WORKLOAD, workloadRefusal } from "./lib/profile-fleet";
import { MIRROR_FEATURE, MIRROR_MODEL, MIRROR_PROVIDER_ID, type MirrorProviderOptions } from "./mirror/protocol";
import { createMirror, type Mirror } from "./mirror/service";
import { policyFromSettings, policyToSettings } from "./owner/update-policy";
import { createMirrorMetrics, mirrorMetricsContract } from "./mirror/metrics";
import { controlReference, mirrorControlInput, type MirrorControlRequest, type MirrorControlResult } from "./mirror/control";
import { seal, open as openSealed, type MirrorKeyPair } from "./mirror/crypto";
import { createSshOwnerTransport, type OwnerMethod } from "./owner/transport";
import { createOwnerOperations, operationsRpcContract } from "./owner/operations";
import { createOwnerUpdates, updatesRpcContract } from "./owner/updates";
import { createOwnerUpdateDrain, updateDrainRpcContract } from "./owner/update-drain";
import { coreDrainGate, type CoreDrainSdk } from "./owner/core-drain-adapter";
import { createOwnerWorkspace, ownerWorkspaceContract } from "./owner/workspace";
import { remoteEditorUrl } from "./owner/editor-link";
import { createMirrorWorkspace, mirrorWorkspaceContract } from "./owner/mirror-workspace";
import { probeCapabilities, verifiedCapabilityNames, type HostCapabilities } from "./owner/capabilities";
import { bindingVerdict, hostIdentityContract } from "./owner/host-identity";
import { ownerDetailRpcContract, type OwnerDetail } from "./owner/detail-contract";
import { createCoalescer } from "./lib/coalesce";
import { createThreadAccounts } from "./lib/thread-accounts";
import { runCycle, waitOrStop, withStop } from "./stop";
import { createOwnerProject } from "./owner/project";
import { ownerProjectContract } from "./owner/project-contract";
import { buildTransferManifest, listTransferCandidates, transferRpcContract } from "./owner/transfer-manifest";
import { createSimulators, simulatorForwardContract, simulatorRpcContract } from "./owner/simulators";
import { browserForwardContract, browserRpcContract, createOwnerBrowser } from "./owner/browser";

export type { Column, FleetThread, ThreadState } from "./model";

export const FLEET_CHANGED = "fleet-changed";
const PUBLISH_EVERY_MS = 30_000;
const POLL_EVERY_MS = 10_000;
const CONTROLS_FEATURE = "controls-v1";
const sealedCommandEnvelope = z.object({ v: z.literal(1), kind: z.literal("fleet-command"), sealed: z.string().min(1).max(1024 * 1024) }).strict();
const sealedControlEnvelope = z.object({ v: z.literal(1), kind: z.literal("fleet-control"), action: z.enum(["send", "steer", "stop"]), sealed: z.string().min(1).max(1024 * 1024) }).strict();
const sealedCommandContent = z.object({ v: z.literal(1), prompt: z.string().min(1).max(MESSAGE_MAX_BYTES).refine((value) => utf8Length(value) <= MESSAGE_MAX_BYTES), title: z.string().max(120).nullable(), options: z.string().max(32 * 1024) }).strict();

const WORK_ATTACHMENTS_FEATURE = "work-attachments-v1";
const MIRROR_INTERACTIONS_FEATURE = "mirror-interactions-v1";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const sourceAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]), sourceProjectId: z.string().min(1).max(250), path: z.string().min(1).max(2000),
  name: z.string().min(1).max(240), mimeType: z.string().max(200).nullable(),
}).strict();
const ownerAttachmentSchema = z.object({
  type: z.enum(["localImage", "localFile"]), path: z.string().min(1).max(2000), sourceProjectId: z.string().min(1).max(250),
  name: z.string().min(1).max(240), sizeBytes: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES), mimeType: z.string().max(200).nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type OwnerAttachmentRef = z.infer<typeof ownerAttachmentSchema>;
const attachmentFileSchema = z.object({ type: z.enum(["localImage", "localFile"]), name: z.string().min(1).max(240).refine((value) => !/[\\/\0]/.test(value)), mimeType: z.string().min(1).max(200), contentBase64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const workRouteInput = z.object({
  machine: z.string().trim().min(1).max(40),
  ...executionSelectionSchema.shape,
  routing: routingPreferencesSchema.optional(),
  ...workProjectSchema.shape,
  attachments: z.array(sourceAttachmentSchema).min(1).max(10).optional(),
}).strict();
const workStartInput = workRouteInput.extend({
  prompt: z.string().trim().min(1).max(MESSAGE_MAX_BYTES).refine((text) => utf8Length(text) <= MESSAGE_MAX_BYTES, "Prompt must fit within 256 KiB of UTF-8"),
  title: z.string().trim().max(120).optional(),
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/).optional(),
  ...workProjectSchema.shape,
  ownerAttachments: z.array(ownerAttachmentSchema).min(1).max(10).optional(),
});
const workResultSchema = z.object({
  outcome: z.enum(["started", "sent"]),
  threadId: z.string().nullable(),
  url: z.string().nullable(),
  commandId: z.string().nullable(),
  requestId: z.string(),
  route: routeDecisionSchema,
  attachments: z.array(z.object({ name: z.string(), sha256: z.string(), sizeBytes: z.number(), verified: z.literal(true) })).optional(),
});
const controlInputSchema = z.object({
  v: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), localThreadId: z.string().min(1),
  targetServer: z.string().min(1), remoteThreadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/),
  action: z.enum(["send", "steer", "stop"]), text: z.string().max(256 * 1024), createdAt: z.number(),
  expectedRemoteTurnId: z.string().optional(), cancelRequestIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100).optional(),
  ownerAttachments: z.array(z.object({
    type: z.enum(["localImage", "localFile"]), path: z.string().min(1).max(2000), sourceProjectId: z.string().min(1).max(250),
    name: z.string().min(1).max(240), sizeBytes: z.number().int().nonnegative().max(8 * 1024 * 1024), mimeType: z.string().max(200).nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(10).optional(),
}).strict();
const controlResultSchema = z.object({
  state: z.enum(["accepted", "sent", "queued", "unknown", "unavailable", "failed"]),
  remoteRequestId: z.string().optional(), message: z.string().optional(),
});
const threadEventsInputSchema = z.object({
  threadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/),
  afterSeq: z.string().regex(/^\d+$/).optional(), beforeSeq: z.string().regex(/^\d+$/).optional(),
  order: z.enum(["asc", "desc"]).optional(), limit: z.string().regex(/^(?:[1-9]\d?|100)$/).optional(),
  types: z.array(z.string().min(1).max(120)).min(1).max(20).optional(),
}).strict();
const answerSchema = z.object({ machine: z.string(), threadId: z.string(), url: z.string().nullable(), state: threadStateSchema, output: z.string(), truncated: z.boolean(), publishedAt: z.number().nullable() });

const tellInputSchema = z.object({
  machine: z.string().trim().min(1).max(40),
  threadId: controlInputSchema.shape.remoteThreadId,
  message: z.string().trim().min(1).max(MESSAGE_MAX_BYTES).refine((text) => utf8Length(text) <= MESSAGE_MAX_BYTES, "Message must fit within 256 KiB of UTF-8"),
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/).optional(),
}).strict();
const tellResultSchema = z.object({ requestId: z.string(), machine: z.string(), threadId: z.string(), delivered: z.boolean(), delivery: z.string(), messageId: z.string().nullable(), url: z.string().nullable(), note: z.string().optional() });
const receiptResultSchema = z.object({ state: z.enum(["ready", "pending", "failed"]), commandId: z.string().nullable(), threadId: z.string().nullable(), url: z.string().nullable(), answer: answerSchema.nullable(), message: z.string().nullable() });
const sentReceiptSchema = z.object({
  id: z.string(), kind: z.enum(["ask", "tell"]), status: z.string(), machine: z.string().nullable(), threadId: z.string().nullable(), url: z.string().nullable(),
  commandId: z.string().nullable(), delivery: z.string().nullable(), updatedAt: z.number(),
});
export type SentReceipt = z.infer<typeof sentReceiptSchema>;

const commandSchema = z.object({
  id: z.string(),
  targetServer: z.string(),
  targetMachine: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  threadUrl: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type Command = z.infer<typeof commandSchema>;

/** What the browser needs of the profile: machine labels and order, and whether setup is done. Nothing else leaves the server. */
const profileForBrowserSchema = z.object({
  machines: z.array(z.object({ id: z.string(), label: z.string(), role: z.string(), restricted: z.boolean() })),
  setupDone: z.boolean(),
  /** The Fleet feature ids switched off in the setup picker (see lib/picks.ts). */
  picksOff: z.array(z.string()),
});

const boardSchema = z.object({
      me: z.object({
        serverId: z.string(),
        machineKey: z.string(),
        label: z.string(),
        joined: z.boolean(),
        brain: z.boolean(),
        backendHealthy: z.boolean().optional(),
        lastSuccessfulSyncAt: z.number().nullable().optional(),
      }),
      columns: z.array(columnSchema),
      commands: z.array(commandSchema),
      error: z.string().nullable(),
      transport: z.object({ broker: z.enum(["healthy", "unavailable", "disabled"]), lastSuccessfulSyncAt: z.number().nullable(), directOwner: z.enum(["ready", "unavailable", "unconfigured"]), directOwnerError: z.string().nullable(), directMachine: z.string().nullable().optional() }).optional(),
      at: z.number(),
    });
export type BoardResult = z.infer<typeof boardSchema>;

export const rpcContract = defineRpcContract({
  board_get: {
    input: z.null(),
    output: boardSchema,
  },
  work_start: {
    input: workStartInput,
    output: workResultSchema,
  },
  route_preview: { input: workRouteInput, output: routeDecisionSchema },
  work_attachments_put: {
    input: z.object({ v: z.literal(1), requestId: z.string().uuid(), projectId: z.string().min(1).max(120).optional(), projectName: z.string().min(1).max(200).optional(), files: z.array(attachmentFileSchema).min(1).max(10) }).strict(),
    output: z.object({ projectId: z.string(), attachments: z.array(ownerAttachmentSchema) }),
  },
  snapshot_get: { input: z.null(), output: snapshotSchema },
  work_receipt: { input: z.object({ requestId: workStartInput.shape.requestId.unwrap() }), output: z.object({ state: z.enum(["completed", "unknown", "missing"]), result: workResultSchema.nullable(), notStarted: z.object({ reason: z.enum(["rejected", "unavailable"]), message: z.string() }).optional() }) },
  control_deliver: { input: controlInputSchema, output: controlResultSchema },
  control_receipt: { input: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), remoteThreadId: controlInputSchema.shape.remoteThreadId.optional() }), output: controlResultSchema },
  thread_events_get: { input: threadEventsInputSchema, output: z.array(z.unknown()) },
  thread_answer_get: { input: z.object({ threadId: controlInputSchema.shape.remoteThreadId }), output: answerSchema },
  profile_get: { input: z.null(), output: profileForBrowserSchema },
  thread_target_get: { input: z.object({ threadId: controlInputSchema.shape.remoteThreadId }).strict(), output: z.object({ serverId: z.string(), machineKey: z.string().min(1).max(40), hostId: z.string(), environmentId: z.string(), projectId: z.string(), threadId: z.string() }) },
  thread_tell: { input: tellInputSchema, output: tellResultSchema },
  thread_output_get: { input: z.object({ machine: z.string().trim().min(1).max(40), threadId: controlInputSchema.shape.remoteThreadId }).strict(), output: answerSchema },
  receipt_result: { input: z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/) }).strict(), output: receiptResultSchema },
  receipts_list: { input: z.null(), output: z.array(sentReceiptSchema) },
  command_get: { input: z.object({ commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/) }), output: z.object({ status: z.enum(["pending", "starting", "started", "failed", "unknown"]), machine: z.string().nullable(), threadId: z.string().nullable(), url: z.string().nullable(), error: z.string().nullable() }) },
  // Open a chat that runs on another machine (or, for a loopback test, on this
  // one) as a hidden local copy fed through the brain; reuses the copy after.
  mirror_open: {
    input: z
      .object({
        machine: z.string().trim().min(1).max(40),
        threadId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/),
        title: z.string().trim().min(1).max(200).optional(),
        localProjectId: z.string().trim().min(1).max(120).optional(),
      })
      .strict(),
    output: z.object({ localThreadId: z.string() }),
  },
});

type Bb = BbPluginApi;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A known pre-dispatch refusal: nothing was started, so the same request id may be retried. */
class PreDispatchRejection extends Error {
  override name = "PreDispatchRejection";
}

/** An owner route failure with a known delivery state. */
class OwnerRouteError extends Error {
  override name = "OwnerRouteError";
  constructor(readonly kind: "unavailable" | "unknown" | "refused", text: string) { super(text); }
}

export const REJECTED_PREFIX = "fleet-rejected: ";

class OwnerStartOutcomeUnknown extends Error {
  override name = "OwnerStartOutcomeUnknown";
}

/**
 * The core's environment-provider check refuses a spawn with one of these 409s
 * before any thread or worktree exists (git checkout inspection failed). They are
 * definite refusals, so they must not be recorded as an unknown start outcome.
 */
const NATIVE_CHECKOUT_REFUSAL = /\bHTTP 409: This project checkout (could not be inspected|has no usable git branch)\.?$/;
export function isNativeCheckoutRefusal(text: string): boolean {
  return NATIVE_CHECKOUT_REFUSAL.test(text.trim());
}

function envelopeKind(raw: string | null): string | null {
  try { const value = JSON.parse(raw ?? "null") as { kind?: unknown } | null; return typeof value?.kind === "string" ? value.kind : null; }
  catch { return null; }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return waitOrStop(ms, signal);
}

/** Check mount metadata and the NAS's LAN endpoint without touching NAS files over an away link. Off (nothing mounted, nothing reachable) when the profile names no NAS. */
function nasAvailability(nas: { path: string | null; host: string | null }): Promise<{ mounted: boolean; reachable: boolean }> {
  const nasPath = nas.path;
  if (nasPath === null || nasPath.trim() === "") return Promise.resolve({ mounted: false, reachable: false });
  const mountLine = new RegExp(` on ${nasPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\((?:smbfs|nfs)[,)]`, "m");
  return new Promise((resolve) => {
    execFile("/sbin/mount", [], { timeout: 2_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      const mounted = error === null && mountLine.test(String(stdout));
      if (!mounted) return resolve({ mounted: false, reachable: false });
      if (nas.host === null) return resolve({ mounted: true, reachable: false });
      let finished = false;
      const socket = createConnection({ host: nas.host, port: 445 });
      const done = (reachable: boolean) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolve({ mounted: true, reachable });
      };
      socket.setTimeout(750);
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });
  });
}

/** This bb's getbb.app handle and URL, from `bb connect status --json`. */
function connectStatus(): Promise<{ handle: string; url: string } | null> {
  const candidates = [
    process.env.BB_CLI,
    "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb",
    "bb",
  ].filter((c): c is string => typeof c === "string" && c !== "");
  return new Promise((resolve) => {
    const attempt = (i: number) => {
      const bin = candidates[i];
      if (bin === undefined) return resolve(null);
      execFile(bin, ["connect", "status", "--json"], { timeout: 15_000 }, (error, stdout) => {
        if (error) return attempt(i + 1);
        try {
          const parsed = JSON.parse(stdout) as { handle?: string; url?: string };
          if (parsed.handle && parsed.url) return resolve({ handle: parsed.handle, url: parsed.url });
        } catch {
          /* fall through */
        }
        attempt(i + 1);
      });
    };
    attempt(0);
  });
}

// ---------- the local bb CLI (per-thread work on this machine) ----------

const BB_BINARIES = [
  process.env.BB_CLI,
  "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb",
  "bb",
].filter((c): c is string => typeof c === "string" && c !== "");

/** A failed `bb ... --json` call, with bb's error code (thread_not_found, unknown_option...). */
class BbCliError extends Error {
  constructor(
    readonly code: string,
    text: string,
  ) {
    super(text);
  }
}

/** Run this machine's bb CLI without a shell; `input` goes to its stdin. */
function runBb(
  args: string[],
  options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const what = `bb ${args.slice(0, 2).join(" ")}`;
  const signal = withStop(options.signal);
  return new Promise((resolve, reject) => {
    const attempt = (i: number) => {
      const bin = BB_BINARIES[i];
      if (bin === undefined) return reject(new BbCliError("bb_not_found", "The bb CLI was not found on this machine"));
      const child = execFile(
        bin,
        args,
        {
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: 16 * 1024 * 1024,
          ...(signal ? { signal } : {}),
        },
        (error, stdout, stderr) => {
          if (error === null) return resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
          const code: unknown = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return attempt(i + 1);
          if (typeof code === "number") return resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
          if (error.name === "AbortError") return reject(new BbCliError("cancelled", `${what}: cancelled`));
          if ((error as { killed?: boolean }).killed) return reject(new BbCliError("cli_timeout", `${what} did not finish in time`));
          reject(new BbCliError("cli_failed", `${what}: ${error.message}`));
        },
      );
      // bb may exit before reading stdin (bad thread id); its exit status says why.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input ?? "");
    };
    attempt(0);
  });
}

/** `bb <args> --json`, parsed; bb's {ok:false,error} envelope becomes a BbCliError. */
async function bbJson<T>(args: string[], options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const split = args.indexOf("--");
  const full = split === -1 ? [...args, "--json"] : [...args.slice(0, split), "--json", ...args.slice(split)];
  const run = await runBb(full, options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    parsed = undefined;
  }
  const envelope = parsed as { ok?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
  if (run.exitCode !== 0 || envelope?.ok === false) {
    const code = typeof envelope?.error?.code === "string" ? envelope.error.code : "error";
    const text =
      typeof envelope?.error?.message === "string"
        ? envelope.error.message
        : run.stderr.trim().split("\n")[0] || `exit code ${run.exitCode}`;
    throw new BbCliError(code, `bb ${args.slice(0, 2).join(" ")}: ${text}`);
  }
  if (parsed === undefined) throw new BbCliError("bad_output", `bb ${args.slice(0, 2).join(" ")} printed no JSON`);
  return parsed as T;
}

interface ShownThread {
  thread: {
    id: string;
    status: string;
    projectId: string;
    updatedAt: number;
    queuedMessageCount?: number;
    runtime?: { displayStatus?: string } | null;
  };
  environment: { id?: string; hostId?: string } | null;
}

/** The thread as this bb sees it, or null when this bb has no such thread. */
async function showThread(threadId: string): Promise<ShownThread | null> {
  try {
    const shown = await bbJson<ShownThread>(["thread", "show", threadId], { timeoutMs: 30_000 });
    return shown?.thread?.id === threadId ? shown : null;
  } catch (cause) {
    if (cause instanceof BbCliError && cause.code === "thread_not_found") return null;
    throw cause;
  }
}

function shownState(t: ShownThread["thread"]): ThreadState {
  return threadState({
    status: t.status,
    runtime: t.runtime ?? null,
    queuedWork: (t.queuedMessageCount ?? 0) > 0 ? "queued" : "none",
  });
}

/** The thread's final assistant message ("" when it has none yet). */
async function threadOutput(threadId: string): Promise<string> {
  const r = await bbJson<{ output?: unknown }>(["thread", "output", threadId], { timeoutMs: 60_000 });
  return typeof r.output === "string" ? r.output : "";
}

/** `bb thread tell` with the body on stdin (default steer mode: starts a turn, or joins the live one). */
async function tellThread(threadId: string, body: string): Promise<string> {
  const delivery = (r: { delivery?: unknown }) => (typeof r.delivery === "string" ? r.delivery : "sent");
  try {
    return delivery(await bbJson(["thread", "tell", threadId, "--message-file", "-"], { input: body, timeoutMs: 120_000 }));
  } catch (cause) {
    // An older bb CLI without --message-file: pass the text as the message argument.
    if (!(cause instanceof BbCliError) || cause.code !== "unknown_option") throw cause;
    return delivery(await bbJson(["thread", "tell", threadId, "--", body], { timeoutMs: 120_000 }));
  }
}

/** Wait for a thread in this bb to finish its turn: idle, error, or the deadline. */
async function waitLocalSettled(threadId: string, deadline: number, signal: AbortSignal): Promise<"idle" | "error" | "timeout"> {
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return "timeout";
    const chunk = Math.min(left, 30_000);
    try {
      await bbJson(["thread", "wait", threadId, "--status", "idle", "--timeout", `${Math.max(1, Math.ceil(chunk / 1000))}s`], {
        timeoutMs: chunk + 30_000,
        signal,
      });
      return "idle";
    } catch (cause) {
      if (!(cause instanceof BbCliError) || !/timed out/i.test(cause.message)) throw cause;
    }
    const shown = await showThread(threadId);
    if (shown === null) throw new BbCliError("thread_not_found", `Thread ${threadId} no longer exists`);
    if (shown.thread.status === "error") return "error";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------- fleet tables (created at start, IF NOT EXISTS) ----------
// The snapshot and command tables match the brain's Fleet migration exactly, so a
// brain that already has them is untouched and a fresh self-hosted brain gets them.

const RELAY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fleet_servers (
     server_id TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     url TEXT,
     hostname TEXT,
     published_at INTEGER NOT NULL,
     payload TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS fleet_commands (
     id TEXT PRIMARY KEY,
     target_server TEXT NOT NULL,
     target_host_id TEXT,
     title TEXT,
     prompt TEXT NOT NULL,
     provider_id TEXT,
     from_server TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     thread_id TEXT,
     thread_url TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_commands_target ON fleet_commands(target_server, status)`,
  `CREATE TABLE IF NOT EXISTS fleet_command_options (command_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fleet_message_controls (message_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fleet_messages (
     id TEXT PRIMARY KEY,
     target_server TEXT,
     thread_id TEXT,
     body TEXT,
     from_server TEXT,
     status TEXT,
     error TEXT,
     created_at INTEGER,
     updated_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_messages_target ON fleet_messages(target_server, status)`,
  `CREATE TABLE IF NOT EXISTS fleet_outputs (
     server_id TEXT,
     thread_id TEXT,
     state TEXT,
     output TEXT,
     output_hash TEXT,
     truncated INTEGER,
     updated_at INTEGER,
     PRIMARY KEY (server_id, thread_id)
   )`,
];

/** Threads started or messaged through Fleet this recently keep their answers published. */
const WATCH_MS = 7 * 24 * 3600_000;
/** A message stuck in 'delivering' this long was interrupted (bb restarted mid-delivery). */
const STUCK_MS = 15 * 60_000;
/** A settled watched thread is re-read this often (a delivered message makes it every cycle). */
const SETTLED_RECHECK_MS = 60_000;
const MAX_CHECKS_PER_CYCLE = 10;
const MAX_FETCHES_PER_CYCLE = 4;

/** A CLI failure with its exit code: 1 error, 2 timed out, 130 cancelled. */
class RelayError extends Error {
  constructor(
    text: string,
    readonly exitCode = 1,
    readonly code = "error",
    readonly extra: Record<string, string | null> = {},
  ) {
    super(text);
  }
}

interface Answer {
  machine: string;
  threadId: string;
  url: string | null;
  state: string;
  output: string;
  truncated: boolean;
  publishedAt: number | null;
}

function formatAnswer(a: Answer): string {
  const meta = [a.machine, `thread ${a.threadId}`, a.state === "idle" ? null : a.state, a.url].filter((p) => p !== null && p !== "");
  return [
    a.output.trimEnd() === "" ? "(no answer text)" : a.output.trimEnd(),
    "",
    `-- ${meta.join(" · ")}`,
    ...(a.truncated ? ["-- answer cut to 64 KB; open the thread for all of it"] : []),
  ].join("\n");
}

function minutes(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`;
}

export default async function plugin(bb: Bb) {
  const loadedProfile = loadProfile();
  const profile = loadedProfile.profile;
  for (const problem of loadedProfile.errors) bb.log.warn(`profile: ${problem}`);
  const alwaysOn = alwaysOnMachine(profile);
  const nasConfig = { path: profile.paths.nas, host: fleetSection(profile).nasHost };
  const enrolmentOff = pickedOff(profile, "F82");
  const settings = bb.settings.define({
    joinFleet: {
      type: "boolean",
      label: "Join the fleet: publish this bb's machines and threads to the brain, and accept work started from other machines",
      default: false,
    },
    machineKey: {
      type: "string",
      label: `Machine key (${machineOrder(profile).join(", ")}). Blank = taken from this Mac's hostname in the profile`,
      default: "",
    },
    machineLabel: {
      type: "string",
      label: "Display name for this machine (blank = its name in the profile)",
      default: "",
    },
    capabilities: {
      type: "string",
      label: "What this machine can reach, comma separated (e.g. VPN, Snowflake). NAS is detected automatically",
      default: "",
    },
    defaultProject: {
      type: "string",
      label: "Project new work starts in (blank = the profile's default project, else the personal workspace)",
      default: "",
    },
    // Machines enrolment (F82): the setting is not offered, and a saved value is ignored, while the feature is switched off.
    ...(enrolmentOff ? {} : {
      hostAliases: {
        type: "string" as const,
        label: `Enrolled machine names to machine keys, JSON (e.g. {"Studio": "${alwaysOn?.id ?? machineOrder(profile)[0]}"})`,
        experimental_multiline: true,
        default: "{}",
      },
    }),
    mirrorEnvironment: {
      type: "string",
      label: "Environment id that copies of other machines' chats reuse (blank = a ready project checkout on this Mac)",
      default: "",
    },
    projectWorkloads: {
      type: "string",
      label: `Project workload tags, JSON: project id or name to a workload (${workloadIds(profile).join(", ")}). A tagged project runs only on the machine its workload belongs to`,
      experimental_multiline: true,
      default: "{}",
    },
    updateTestMachine: {
      type: "string",
      label: "Fleet updates: machine that must run a bb version before any other machine may update to it (blank = no staging)",
      default: alwaysOn?.id ?? "",
    },
    updatePinnedVersion: {
      type: "string",
      label: "Fleet updates: the only bb version Fleet may install (exact x.y.z, blank = any tested version)",
      default: "",
    },
  });
  const config = await settings.get();
  let updatePolicy = policyFromSettings(config);
  settings.onChange((next) => { updatePolicy = policyFromSettings(next); });

  let aliases: Record<string, string> = {};
  try {
    const parsed: unknown = enrolmentOff ? {} : JSON.parse((config as { hostAliases?: string }).hostAliases || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      aliases = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
  } catch {
    bb.log.warn("hostAliases is not valid JSON; ignoring it");
  }

  const creds = loadBrainCredentials();
  const turso = creds ? new TursoClient(creds) : null;
  // The machine key is the plugin setting (canonicalised to the profile's id), else the profile's match for
  // this hostname, else the raw hostname. Never another machine's key.
  const keySetting = config.machineKey.trim();
  const keyFromProfile = thisMachine(profile, hostname())?.id ?? null;
  const machineKey = (keySetting ? (resolveMachineId(profile, keySetting) ?? keySetting) : (keyFromProfile ?? hostname())).trim();
  if (!keySetting && keyFromProfile === null) bb.log.warn(`This Mac (${hostname()}) matches no machine in the profile, so it uses its hostname as its machine key. Add the hostname to the profile or set the machine key.`);
  /** Why this Fleet must not start work or move files, or null. Fails closed: a wrong identity could drop a machine's restrictions. */
  const configProblem: string | null = (() => {
    if (loadedProfile.errors.length > 0) return `The profile has errors (${loadedProfile.errors.join("; ")}), so Fleet starts no work and moves no files until it is fixed`;
    if (keySetting && resolveMachineId(profile, keySetting) === null && (profile.machines.length > 1 || keySetting !== COMMUNITY_DEFAULTS.machines[0]!.id)) return `The machine key "${keySetting}" is not a machine in the profile (${machineOrder(profile).join(", ")}), so Fleet starts no work and moves no files until it is fixed`;
    return null;
  })();
  if (configProblem !== null) bb.log.error(configProblem);
  const refuseIfMisconfigured = (): void => { if (configProblem !== null) throw new Error(`${REJECTED_PREFIX}${configProblem}`); };
  /** The same handlers, except that the named mutating methods refuse while the configuration is wrong. */
  const guardMutations = <H extends Record<string, (...args: never[]) => unknown>>(handlers: H, methods: (keyof H)[]): H => {
    const out: Record<string, unknown> = { ...handlers };
    for (const method of methods) {
      const inner = handlers[method] as unknown as (...args: unknown[]) => unknown;
      out[method as string] = (...args: unknown[]) => { refuseIfMisconfigured(); return inner(...args); };
    }
    return out as H;
  };
  /** The profile is read afresh (it is mtime-cached), so a tick saved in the Console's Setup applies without reloading Fleet. */
  const refuseIfOff = (id: FleetGatedId): void => { if (pickedOff(loadProfile().profile, id)) throw new Error(offMessage(id)); };
  /** The same handlers, except that the named methods refuse with a plain message while the feature is switched off. */
  const guardPicked = <H extends Record<string, (...args: never[]) => unknown>>(handlers: H, id: FleetGatedId, methods: (keyof H)[]): H => {
    const out: Record<string, unknown> = { ...handlers };
    for (const method of methods) {
      const inner = handlers[method] as unknown as (...args: unknown[]) => unknown;
      out[method as string] = (...args: unknown[]) => { refuseIfOff(id); return inner(...args); };
    }
    return out as H;
  };
  const machineLabel = (config.machineLabel || profileMachineLabel(profile, machineKey)).trim();
  const alwaysOnId = alwaysOn?.id ?? null;
  const canonicalMachine = (raw: string): string => resolveMachineId(profile, raw) ?? raw.trim();
  const direct = directRouteMachine(profile, machineKey);
  const directId = direct?.machine.id ?? null;
  const directLabel = direct?.machine.label ?? "the always-on Mac";
  const directAlias = direct?.alias ?? "";
  const declaredCaps = config.capabilities
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "");

  let identity: { handle: string; url: string } | null = null;
  async function me() {
    if (identity === null) identity = await connectStatus();
    return { serverId: identity?.handle ?? `local-${machineKey.toLowerCase()}`, url: identity?.url ?? null };
  }

  // Publish, poll and relay fail independently; the badge must not go green while any is failing.
  let publishError: string | null = null;
  let pollError: string | null = null;
  let relayError: string | null = null;
  let remote: Snapshot[] = [];
  let lastSuccessfulSyncAt: number | null = null;
  let directOwner: Snapshot | null = null;
  let directOwnerError: string | null = null;
  const directConfigured = (() => {
    if (direct === null) return false;
    try { return new RegExp(`^\\s*Host\\s+(?:[^\\n]*\\s)?${directAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "im").test(readFileSync(join(homedir(), ".ssh", "config"), "utf8")); }
    catch { return false; }
  })();

  const requestDb = bb.storage.database();
  requestDb.exec(`CREATE TABLE IF NOT EXISTS fleet_request_receipts (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL
  )`);
  requestDb.exec(`CREATE TABLE IF NOT EXISTS fleet_private_threads (
    thread_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  function markPrivateThread(threadId: string, reason: "sealed-command" | "native-control"): void {
    requestDb.prepare("INSERT INTO fleet_private_threads (thread_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO NOTHING").run(threadId, reason, Date.now());
  }
  function isPrivateThread(threadId: string): boolean {
    return Boolean(requestDb.prepare("SELECT 1 FROM fleet_private_threads WHERE thread_id = ?").get(threadId));
  }

  /** Claim synchronously before any side effect. Interrupted claims stay unknown, never replayed. */
  function claimRequest(id: string, kind: string, payload: unknown): { existing: boolean; result: string | null } {
    const fingerprint = sha256(JSON.stringify(payload));
    return requestDb.transaction(() => {
      const old = requestDb.prepare("SELECT fingerprint, result FROM fleet_request_receipts WHERE id = ?").get(id) as { fingerprint: string; result: string | null } | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error("Request identity was reused with different input");
        const status = (requestDb.prepare("SELECT status FROM fleet_request_receipts WHERE id = ?").get(id) as { status: string }).status;
        if (status !== "rejected" && status !== "unavailable") return { existing: true, result: old.result };
        requestDb.prepare("UPDATE fleet_request_receipts SET status = 'dispatching', result = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
        return { existing: false, result: null };
      }
      requestDb.prepare("INSERT INTO fleet_request_receipts (id, fingerprint, kind, status, updated_at) VALUES (?, ?, ?, 'dispatching', ?)").run(id, fingerprint, kind, Date.now());
      return { existing: false, result: null };
    })();
  }

  function recordRequest(id: string, result: unknown, status = "completed"): void {
    requestDb.prepare("UPDATE fleet_request_receipts SET status = ?, result = ?, updated_at = ? WHERE id = ?").run(status, JSON.stringify(result), Date.now(), id);
  }

  function settleQueuedControl(entry: { threadId: string; content: unknown }, state: "sent" | "failed"): void {
    const id = controlReference(entry.content as Parameters<typeof controlReference>[0]);
    if (!id) return;
    const row = requestDb.prepare("SELECT id FROM fleet_request_receipts WHERE id = ? AND kind = ? AND status = 'queued'").get(id, `control:${entry.threadId}`);
    if (row) recordRequest(id, { state, remoteRequestId: id, ...(state === "failed" ? { message: "Queued input was cancelled before dispatch" } : {}) }, state);
  }
  bb.events.on("message.dispatched", ({ entry }) => settleQueuedControl(entry, "sent"));
  bb.events.on("message.cancelled", ({ entry }) => settleQueuedControl(entry, "failed"));

  const sshDirect = directConfigured ? createSshOwnerTransport({ alias: directAlias }) : null;
  /** Uses only the already configured SSH alias and the finite owner method list; input travels on stdin. */
  async function directRpc(method: OwnerMethod<"fleet">, input: unknown, mutation = false): Promise<unknown> {
    if (sshDirect === null) throw new OwnerRouteError("unavailable", `The ${directAlias} SSH alias is not configured on this host`);
    const outcome = await sshDirect.call("fleet", method, input, mutation);
    if (outcome.ok) return outcome.result;
    const refused = outcome.message.includes(REJECTED_PREFIX.trim());
    throw new OwnerRouteError(refused ? "refused" : outcome.kind, `${outcome.kind === "unknown" && !refused ? `${directLabel} request outcome is unknown; do not automatically resend` : `${directLabel} direct route`}: ${outcome.message}`);
  }

  const reads = createCoalescer();
  const BOARD_TTL_MS = 1500;
  const OWNER_DETAIL_TTL_MS = 1500;
  const announceChange = () => {
    reads.invalidate();
    bb.realtime.publish(FLEET_CHANGED, { at: Date.now() });
  };

  let directRefresh: Promise<void> | null = null;
  let directFailedAt = Number.NEGATIVE_INFINITY;
  const DIRECT_RETRY_AFTER_MS = 15_000;
  /** The retry window spares the background board poll; every explicit user action passes no option and always tries. */
  async function refreshDirectOwner(options: { background?: boolean } = {}): Promise<void> {
    if (!directConfigured || (directOwner && Date.now() - directOwner.publishedAt < 10_000)) return;
    if (options.background && !directRefresh && Date.now() - directFailedAt < DIRECT_RETRY_AFTER_MS) return;
    directRefresh ??= (async () => {
      try {
        const snapshot = snapshotSchema.parse(await directRpc("snapshot_get", null));
        if (snapshot.machineKey !== directId) throw new Error(`The ${directAlias} SSH alias answered with another owner identity`);
        directOwner = snapshot;
        directOwnerError = null;
        directFailedAt = Number.NEGATIVE_INFINITY;
        sshLastOkAt = Date.now();
      } catch (cause) { directOwnerError = message(cause); directFailedAt = Date.now(); }
    })().finally(() => { directRefresh = null; });
    await directRefresh;
  }

  async function deliverControl(request: MirrorControlRequest): Promise<MirrorControlResult> {
    const { serverId } = await me();
    if (request.targetServer !== serverId) return { state: "failed", message: "This is not the thread's owning server" };
    // Native controls can carry the conversation's private context even when
    // they arrive over SSH. Persist policy before any native effect.
    markPrivateThread(request.remoteThreadId, "native-control");
    const previous = requestDb.prepare("SELECT kind, status, result FROM fleet_request_receipts WHERE id = ?").get(request.id) as { kind: string; status: string; result: string | null } | undefined;
    if (previous?.kind === `control:${request.remoteThreadId}` && previous.status === "cancelled" && previous.result) return controlResultSchema.parse(JSON.parse(previous.result));
    const claim = claimRequest(request.id, `control:${request.remoteThreadId}`, request);
    if (claim.existing) return claim.result ? controlResultSchema.parse(JSON.parse(claim.result)) : { state: "unknown", remoteRequestId: request.id, message: "The original dispatch is in progress or its outcome is unknown; it was not repeated" };
    let result: MirrorControlResult;
    try {
      if (request.action === "stop") {
        const cancelIds = new Set(request.cancelRequestIds ?? []);
        let cancelled = 0;
        if (cancelIds.size) {
          for (const id of cancelIds) {
            const result = { state: "failed", remoteRequestId: id, message: "Cancelled before owner dispatch" };
            cancelled += requestDb.prepare("INSERT INTO fleet_request_receipts (id, fingerprint, kind, status, result, updated_at) VALUES (?, '', ?, 'cancelled', ?, ?) ON CONFLICT(id) DO NOTHING").run(id, `control:${request.remoteThreadId}`, JSON.stringify(result), Date.now()).changes;
          }
          const queued = await bb.sdk.threads.queuedMessages.list({ threadId: request.remoteThreadId });
          for (const entry of queued) {
            const id = controlReference(entry.content as Parameters<typeof controlReference>[0]);
            if (id && cancelIds.has(id)) {
              await bb.sdk.threads.queuedMessages.delete({ threadId: request.remoteThreadId, queuedMessageId: entry.id });
              recordRequest(id, { state: "failed", remoteRequestId: id, message: "Queued input was cancelled" }, "cancelled");
              cancelled += 1;
            }
          }
          if (turso && config.joinFleet) {
            try {
              await ensureSchema();
              const ids = [...cancelIds];
              await turso.query(`UPDATE fleet_messages SET status = 'cancelled', body = '', error = NULL, updated_at = ? WHERE target_server = ? AND thread_id = ? AND status = 'pending' AND id IN (${ids.map(() => "?").join(",")})`, [Date.now(), serverId, request.remoteThreadId, ...ids]);
            } catch (cause) { bb.log.warn(`Broker cancellation deferred; owner cancellation receipts remain durable: ${message(cause)}`); }
          }
        }
        const events = await bb.sdk.threads.events.list({ threadId: request.remoteThreadId, order: "desc", limit: "100", types: ["client/turn/requested", "turn/input/accepted", "turn/started", "turn/completed"] });
        type ControlEvent = { type: string; scope?: { turnId?: string }; data?: Record<string, unknown> };
        const recent = events as unknown as ControlEvent[];
        const last = recent.find((event) => event.type === "turn/started" || event.type === "turn/completed");
        const requestIds = new Set(recent.filter((event) => event.type === "client/turn/requested" && Array.isArray(event.data?.input) && cancelIds.has(controlReference(event.data.input as Parameters<typeof controlReference>[0]) ?? "")).map((event) => event.data?.requestId));
        const ownsActiveTurn = last?.type === "turn/started" && Boolean(last.scope?.turnId) && recent.some((event) => event.type === "turn/input/accepted" && event.scope?.turnId === last.scope?.turnId && requestIds.has(event.data?.clientRequestId));
        const matchesExpectedTurn = Boolean(request.expectedRemoteTurnId && last?.scope?.turnId === request.expectedRemoteTurnId);
        if (last?.type === "turn/started" && (matchesExpectedTurn || ownsActiveTurn)) {
          await bb.sdk.threads.stop({ threadId: request.remoteThreadId }); result = { state: "sent", remoteRequestId: request.id };
        } else if (cancelled > 0 || (cancelIds.size > 0 && last?.type !== "turn/started")) result = { state: "sent", remoteRequestId: request.id, message: "The identified queued controls were cancelled; no unrelated turn was stopped" };
        else result = { state: "failed", message: "The displayed remote turn no longer matches, or its ownership cannot be proven; a newer turn was not stopped" };
      } else {
        if (!request.text.trim() || utf8Length(request.text) > MESSAGE_MAX_BYTES) result = { state: "failed", message: "Message must contain text and fit within 256 KB" };
        else {
          if (request.action === "steer") {
            const events = await bb.sdk.threads.events.list({ threadId: request.remoteThreadId, order: "desc", limit: "1", types: ["turn/started", "turn/completed"] });
            const latest = events[0] as unknown as { type?: string; scope?: { turnId?: string } } | undefined;
            if (!request.expectedRemoteTurnId || latest?.type !== "turn/started" || latest.scope?.turnId !== request.expectedRemoteTurnId) {
              result = { state: "failed", remoteRequestId: request.id, message: "The displayed remote turn no longer matches; a newer or finished turn was not steered" };
              recordRequest(request.id, result, result.state);
              return result;
            }
          }
          const input: unknown[] = mirrorControlInput(request).map((part) => {
            if (part.type !== "text") throw new Error("Unexpected non-text control input");
            return { ...part, mentions: [] };
          });
          if (request.ownerAttachments?.length) {
            if (request.action !== "send") throw new PreDispatchRejection("Attachments travel only with a new message");
            const shown = await showThread(request.remoteThreadId);
            if (shown === null) throw new PreDispatchRejection("The owner thread does not exist");
            for (const attachment of request.ownerAttachments) {
              if (attachment.sourceProjectId !== shown.thread.projectId) throw new PreDispatchRejection("An attachment was stored in another project than the owner thread's");
              const stored = await bb.sdk.projects.attachments.read({ projectId: attachment.sourceProjectId, path: attachment.path }) as unknown as { bytes: Uint8Array; sizeBytes: number };
              if (stored.sizeBytes !== attachment.sizeBytes || createHash("sha256").update(stored.bytes).digest("hex") !== attachment.sha256) throw new PreDispatchRejection(`Attachment ${attachment.name} does not match its verified bytes on the owner`);
              input.push(attachment.type === "localImage"
                ? { type: "localImage", path: attachment.path, sourceProjectId: attachment.sourceProjectId }
                : { type: "localFile", path: attachment.path, sourceProjectId: attachment.sourceProjectId, name: attachment.name, sizeBytes: attachment.sizeBytes, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) });
            }
          }
          const sent = await bb.sdk.threads.send({ threadId: request.remoteThreadId, input: input as Parameters<typeof bb.sdk.threads.send>[0]["input"], mode: request.action === "steer" ? "steer" : "auto" });
          result = { state: sent.delivery === "queued" ? "queued" : "sent", remoteRequestId: sent.delivery === "queued" ? sent.queuedMessage.id : request.id };
        }
      }
    } catch (cause) {
      result = cause instanceof PreDispatchRejection
        ? { state: "failed", remoteRequestId: request.id, message: `${REJECTED_PREFIX}${cause.message}` }
        : { state: "unknown", remoteRequestId: request.id, message: `Owner dispatch outcome is unknown: ${message(cause)}` };
    }
    recordRequest(request.id, result, result.state);
    return result;
  }

  /** The owner's own description of one of its threads, for attachment and file targets. */
  async function ownerThreadTarget(threadId: string) {
    const shown = await showThread(threadId);
    if (shown === null) throw new Error(`${REJECTED_PREFIX}This owner has no thread ${threadId}`);
    if (!shown.environment?.id || !shown.environment.hostId) throw new Error(`${REJECTED_PREFIX}Thread ${threadId} has no environment to receive files`);
    if (!isFleetMachine(profile, machineKey)) throw new Error(`${REJECTED_PREFIX}This owner's machine key is not one of ${machineOrder(profile).join(", ")}`);
    return { serverId: (await me()).serverId, machineKey, hostId: shown.environment.hostId, environmentId: shown.environment.id, projectId: shown.thread.projectId, threadId };
  }

  /**
   * Move a control's project attachments to the owner: read each one's bytes
   * here, import them into the owning thread's project through the owner
   * workspace (verified by SHA-256 on the owner), and forward only the
   * owner-side references. The import request id derives from the control id,
   * so a retried forward reads the same receipt instead of uploading twice.
   */
  async function transferControlAttachments(request: MirrorControlRequest, owner: { machine: FleetMachine; serverId: string }): Promise<{ ok: true; request: MirrorControlRequest } | { ok: false; result: MirrorControlResult }> {
    const attachments = request.attachments ?? [];
    let total = 0;
    const files: { name: string; mimeType: string; contentBase64: string; sha256: string; type: "localImage" | "localFile" }[] = [];
    for (const attachment of attachments) {
      let stored: { bytes: Uint8Array; sizeBytes: number; mimeType?: string | null };
      try { stored = await bb.sdk.projects.attachments.read({ projectId: attachment.sourceProjectId, path: attachment.path }) as unknown as typeof stored; }
      catch (cause) { return { ok: false, result: { state: "failed", remoteRequestId: request.id, message: `Attachment ${attachment.name} could not be read here: ${message(cause)}` } }; }
      total += stored.sizeBytes;
      if (total > 8 * 1024 * 1024) return { ok: false, result: { state: "failed", remoteRequestId: request.id, message: "Attachments to another Mac are limited to 8 MiB per message" } };
      const bytes = Buffer.from(stored.bytes);
      files.push({ name: attachment.name, mimeType: attachment.mimeType ?? stored.mimeType ?? (attachment.type === "localImage" ? "image/png" : "application/octet-stream"), contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), type: attachment.type });
    }
    let target: Awaited<ReturnType<typeof ownerThreadTarget>>;
    try {
      target = owner.serverId === (await me()).serverId ? await ownerThreadTarget(request.remoteThreadId) : z.object({ serverId: z.string(), machineKey: z.string().min(1).max(40), hostId: z.string(), environmentId: z.string(), projectId: z.string(), threadId: z.string() }).parse(await directRpc("thread_target_get", { threadId: request.remoteThreadId }));
    } catch (cause) {
      return { ok: false, result: cause instanceof OwnerRouteError && cause.kind === "unavailable" ? { state: "unavailable", message: message(cause) } : { state: "failed", remoteRequestId: request.id, message: `The owner thread cannot receive attachments: ${message(cause)}` } };
    }
    if (target.serverId !== owner.serverId) return { ok: false, result: { state: "failed", remoteRequestId: request.id, message: "The owner answered with another identity; nothing was sent" } };
    const requestId = uuidFrom(`fleet-attachments:${request.id}`);
    const receipt = await workspace.handlers.context_bundle_import({ target, requestId, files: files.map(({ type: _type, ...file }) => file), context: null } as never) as unknown as { outcome: string; result: { attachments?: { name: string; path: string; sizeBytes: number; mimeType?: string; sourceProjectId: string; sha256: string; verified: boolean }[] } | null; message: string | null };
    if (receipt.outcome === "unavailable") return { ok: false, result: { state: "unavailable", message: receipt.message ?? "The owner could not be reached for the attachments" } };
    if (receipt.outcome === "unknown") return { ok: false, result: { state: "unknown", remoteRequestId: request.id, message: `The attachment upload outcome is unknown; it was not repeated: ${receipt.message ?? ""}`.trim() } };
    if (receipt.outcome !== "applied") return { ok: false, result: { state: "failed", remoteRequestId: request.id, message: `The owner refused the attachments: ${receipt.message ?? ""}`.trim() } };
    const stored = receipt.result?.attachments ?? [];
    if (stored.length !== files.length || stored.some((entry, index) => !entry.verified || entry.sha256 !== files[index]!.sha256 || entry.sourceProjectId !== target.projectId)) return { ok: false, result: { state: "failed", remoteRequestId: request.id, message: "The owner did not verify every attachment; nothing was sent" } };
    const ownerAttachments = stored.map((entry, index) => ({ type: files[index]!.type, path: entry.path, sourceProjectId: entry.sourceProjectId, name: entry.name, sizeBytes: entry.sizeBytes, mimeType: entry.mimeType ?? files[index]!.mimeType, sha256: entry.sha256 }));
    const { attachments: _local, ...rest } = request;
    return { ok: true, request: { ...rest, ownerAttachments } };
  }

  /** The owner thread's exact workspace target, read on the owner itself (this server or the always-on Mac over SSH). */
  async function directThreadTarget(request: { targetServer: string; remoteThreadId: string }) {
    const { serverId } = await me();
    if (request.targetServer === serverId) return ownerThreadTarget(request.remoteThreadId);
    await refreshDirectOwner();
    if (directOwner?.serverId !== request.targetServer) throw new OwnerRouteError("unavailable", "no-authenticated-owner-route");
    return z.object({ serverId: z.string(), machineKey: z.string().min(1).max(40), hostId: z.string(), environmentId: z.string(), projectId: z.string(), threadId: z.string() }).parse(await directRpc("thread_target_get", { threadId: request.remoteThreadId }));
  }

  function ownerSupportsInteractions(targetServer: string, serverId: string): boolean {
    return targetServer === serverId || (directOwner?.serverId === targetServer && (directOwner.features ?? []).includes(MIRROR_INTERACTIONS_FEATURE));
  }

  /** Full pending payload and fingerprint of one owner interaction, for the mirror's native prompt. */
  async function mirrorInteractionDetail(input: { serverId: string; threadId: string; interactionId: string }) {
    await refreshDirectOwner();
    if (!ownerSupportsInteractions(input.serverId, (await me()).serverId)) return null;
    const target = await directThreadTarget({ targetServer: input.serverId, remoteThreadId: input.threadId });
    const listed = await workspace.handlers.interaction_list({ target } as never) as unknown as { interactions: { id: string; kind: string; fingerprint: string; payload: unknown }[] };
    const found = listed.interactions.find((entry) => entry.id === input.interactionId);
    if (!found || (found.kind !== "approval" && found.kind !== "user_question") || typeof found.payload !== "object" || found.payload === null) return null;
    return { payload: found.payload as Record<string, unknown>, fingerprint: found.fingerprint };
  }

  /** A native answer from a mirror copy, applied on the owner only if the interaction is unchanged. */
  async function respondToOwnerInteraction(request: MirrorControlRequest): Promise<MirrorControlResult> {
    const answer = request.interaction;
    if (!answer) return { state: "failed", remoteRequestId: request.id, message: "The answer is missing" };
    const { serverId } = await me();
    await refreshDirectOwner();
    if (!ownerSupportsInteractions(request.targetServer, serverId)) return { state: "failed", remoteRequestId: request.id, message: "This owner cannot take answers from another Mac yet; answer in its own chat" };
    let target: Awaited<ReturnType<typeof directThreadTarget>>;
    try { target = await directThreadTarget(request); }
    catch (cause) { return cause instanceof OwnerRouteError && cause.kind === "unavailable" ? { state: "unavailable", message: message(cause) } : { state: "failed", remoteRequestId: request.id, message: message(cause) }; }
    const receipt = await workspace.handlers.interaction_respond({ target, requestId: uuidFrom(`fleet-ix:${request.id}`), interactionId: answer.interactionId, expectedFingerprint: answer.fingerprint, response: answer.response } as never) as unknown as { outcome: string; message: string | null };
    if (receipt.outcome === "applied") return { state: "sent", remoteRequestId: request.id };
    if (receipt.outcome === "unavailable") return { state: "unavailable", message: receipt.message ?? "The owner could not be reached" };
    if (receipt.outcome === "unknown") return { state: "unknown", remoteRequestId: request.id, message: receipt.message ?? "The answer outcome is unknown" };
    return { state: "failed", remoteRequestId: request.id, message: `The owner did not apply this answer (it may have been answered or changed there): ${receipt.message ?? ""}`.trim() };
  }

  async function forwardMirrorControl(request: MirrorControlRequest): Promise<MirrorControlResult> {
    const { serverId } = await me();
    if (request.action === "respond") return respondToOwnerInteraction(request);
    if (request.attachments?.length) {
      await refreshDirectOwner();
      const machine: FleetMachine | null = request.targetServer === serverId && isFleetMachine(profile, machineKey) ? machineKey : directOwner?.serverId === request.targetServer ? directId : null;
      if (machine === null) return { state: "failed", remoteRequestId: request.id, message: `Attachments need an authenticated direct route to the owner (this Mac or ${directLabel} over SSH); nothing was sent` };
      const moved = await transferControlAttachments(request, { machine, serverId: request.targetServer });
      if (!moved.ok) return moved.result;
      request = moved.request;
    }
    if (request.targetServer === serverId) return deliverControl(request);
    await refreshDirectOwner();
    if (directOwner?.serverId === request.targetServer && (!lastSuccessfulSyncAt || publishError !== null || turso === null)) {
      try { return controlResultSchema.parse(await directRpc("control_deliver", request, true)); }
      catch (cause) {
        if (cause instanceof OwnerRouteError && cause.kind === "unavailable") return { state: "unavailable", message: message(cause) };
        if (cause instanceof OwnerRouteError && cause.kind === "refused") return { state: "failed", remoteRequestId: request.id, message: message(cause) };
        return { state: "unknown", remoteRequestId: request.id, message: message(cause) };
      }
    }
    if (turso === null || !config.joinFleet) return { state: "unavailable", message: "No configured route reaches this independent owner" };
    const owner = remote.find((snapshot) => snapshot.serverId === request.targetServer);
    if (!(owner?.features ?? []).includes(CONTROLS_FEATURE)) return { state: "unavailable", message: "The owner must be upgraded for native controls" };
    if (!(owner?.features ?? []).includes(SEALED_RELAY_FEATURE) || !/^[A-Za-z0-9_-]{43}$/.test(owner?.mirrorKey ?? "") || Date.now() - owner!.publishedAt > 3 * 60_000 || owner!.publishedAt > Date.now() + 5_000) return { state: "unavailable", message: "A fresh sealed-relay-v1 owner and its existing mirror key are required; plaintext control downgrade is disabled" };
    let existing: Row | undefined;
    try { await ensureSchema(); existing = (await turso.query("SELECT status, error FROM fleet_messages WHERE id = ?", [request.id]))[0]; }
    catch (cause) { return { state: "unavailable", message: `The relay could not be reached before dispatch: ${message(cause)}` }; }
    try {
      if (existing) return { state: existing.status === "delivered" ? "sent" : existing.status === "pending" ? "accepted" : "unknown", remoteRequestId: request.id, ...(existing.error ? { message: String(existing.error) } : {}) };
      const now = Date.now();
      const envelope = { v: 1, kind: "fleet-control", action: request.action, sealed: seal(JSON.stringify(request), owner!.mirrorKey!, controlAad({ id: request.id, fromServer: serverId, targetServer: request.targetServer, threadId: request.remoteThreadId, action: request.action })) };
      const stored = await turso.batch([
        { sql: "INSERT INTO fleet_message_controls (message_id, payload) VALUES (?, ?)", args: [request.id, JSON.stringify(envelope)] },
        { sql: `INSERT INTO fleet_messages (id, target_server, thread_id, body, from_server, status, error, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'pending', NULL, ?, ? FROM fleet_message_controls WHERE message_id = ? RETURNING id`, args: [request.id, request.targetServer, request.remoteThreadId, SEALED_CONTROL_PLACEHOLDER, serverId, now, now, request.id] },
      ]);
      if (stored[1]?.length !== 1) return { state: "unavailable", message: "The relay did not accept this control" };
      return { state: "accepted", remoteRequestId: request.id, message: "Durably accepted by Fleet; owner delivery is pending" };
    } catch (cause) { return { state: "unknown", remoteRequestId: request.id, message: `Relay outcome is unknown: ${message(cause)}` }; }
  }

  async function lookupMirrorControlReceipt(request: MirrorControlRequest): Promise<MirrorControlResult | null> {
    const { serverId } = await me();
    if (request.action === "respond") {
      try {
        const target = await directThreadTarget(request);
        const receipt = await workspace.handlers.owner_workspace_receipt({ target, requestId: uuidFrom(`fleet-ix:${request.id}`) } as never) as unknown as { outcome: string; method: string | null; message: string | null };
        if (receipt.outcome === "applied" && receipt.method === "interaction_respond") return { state: "sent", remoteRequestId: request.id };
        if (receipt.outcome === "refused") return { state: "failed", remoteRequestId: request.id, message: receipt.message ?? "The owner did not apply this answer" };
        return null;
      } catch { return null; }
    }
    if (request.targetServer === serverId) {
      const row = requestDb.prepare("SELECT result FROM fleet_request_receipts WHERE id = ? AND kind = ?").get(request.id, `control:${request.remoteThreadId}`) as { result: string | null } | undefined;
      return row?.result ? controlResultSchema.parse(JSON.parse(row.result)) : null;
    }
    if (directOwner?.serverId === request.targetServer && (!lastSuccessfulSyncAt || publishError !== null || turso === null)) {
      const result = controlResultSchema.parse(await directRpc("control_receipt", { id: request.id, remoteThreadId: request.remoteThreadId }));
      return result.state === "unavailable" ? null : result;
    }
    if (!turso || !config.joinFleet) return null;
    const row = (await turso.query("SELECT status, error FROM fleet_messages WHERE id = ? AND target_server = ? AND thread_id = ?", [request.id, request.targetServer, request.remoteThreadId]))[0];
    if (!row) return null;
    const state = row.status === "delivered" ? "sent" : row.status === "failed" || row.status === "cancelled" ? "failed" : row.status === "unknown" ? "unknown" : "accepted";
    return { state, remoteRequestId: request.id, ...(row.error ? { message: String(row.error) } : {}) };
  }

  // ---------- mirror (another machine's chat as a hidden local copy) ----------

  // Fleet's own plugin data folder: the mirror key and the copies' feeds live here.
  const dataDir = join(process.env.BB_DATA_DIR || join(homedir(), ".bb"), "plugins", bb.pluginId);
  let wakeMirror: (() => void) | null = null;
  let mirror: Mirror | null = null;
  const mirrorMetrics = createMirrorMetrics(bb);
  bb.rpc.register(mirrorMetricsContract, mirrorMetrics.handlers);
  try {
    mirror = createMirror({
      bb,
      metrics: mirrorMetrics,
      turso,
      joined: () => config.joinFleet,
      me,
      machineKey,
      canonicalMachine,
      dataDir,
      remote: () => [...remote.filter((snapshot) => snapshot.serverId !== directOwner?.serverId), ...(directOwner ? [directOwner] : [])],
      serverHostId: async () => (await localHosts()).serverHost?.id ?? null,
      wake: () => wakeMirror?.(),
      environmentSetting: () => config.mirrorEnvironment.trim(),
      forwardControl: forwardMirrorControl,
      controlReceipt: lookupMirrorControlReceipt,
      interactionDetail: async ({ serverId, threadId, interactionId }) => mirrorInteractionDetail({ serverId, threadId, interactionId }),
      direct: { events: async ({ serverId, machine, ...query }) => {
        // A saved local copy opens without a network dependency. Identity
        // refresh belongs to its background read, before owner data is fetched.
        if (machine === directId) await refreshDirectOwner();
        if (machine !== directId || directOwner?.serverId !== serverId || Date.now() - directOwner.publishedAt >= 10_000 || directOwnerError !== null) throw new Error(`Unsupported or unavailable direct owner: only the verified ${directLabel} SSH route is available`);
        return await directRpc("thread_events_get", query) as import("./mirror/mapping").StoredEvent[];
      } },
    });
  } catch (cause) {
    bb.log.warn(`fleet mirror is off on this machine: ${message(cause)}`);
  }
  // Reuse the existing mirror key. Never create a second key or advertise seal support
  // when the mirror's private key cannot be read and matched to its public identity.
  let relayKey: MirrorKeyPair | null = null;
  if (mirror) {
    try {
      const stored = z.object({ kty: z.literal("OKP"), crv: z.literal("X25519"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(JSON.parse(readFileSync(join(dataDir, "mirror-key.json"), "utf8")));
      if (stored.x !== mirror.publicKey) throw new Error("Mirror key identity mismatch");
      relayKey = { publicKey: stored.x, privateKey: createPrivateKey({ key: stored, format: "jwk" }) };
    } catch { bb.log.warn("Encrypted Fleet relay is unavailable: existing mirror key could not be read or matched"); }
  }
  // The provider copies run on. Declared "installed"-only and reported not
  // installed by its bridge, so it never shows in the New chat picker. A bb too
  // old for that declaration gets no provider: this Fleet still publishes.
  let mirrorProvider = false;
  if (mirror !== null) {
    const feedDir = mirror.feedDir;
    try {
      bb.providers.register({
        id: MIRROR_PROVIDER_ID,
        displayName: "Fleet mirror",
        icon: "Server",
        strings: {
          signInHint: "Nothing to sign in to: Fleet mirror copies call no model.",
          expiredHint: "Fleet mirror copies never expire.",
          installUrl: fleetSection(profile).installUrl ?? DEFAULT_INSTALL_URL,
        },
        experimental_visibility: "installed",
        maintenance: { health: true, usage: false, installation: false },
        capabilities: {
          supportsServiceTier: false,
          supportsNativeUserQuestion: false,
          fork: "none",
          supportsManualCompaction: false,
          supportsThreadArchive: false,
          supportsThreadRename: false,
          permissionModes: ["accept-edits", "auto", "full"],
          reasoningLevels: ["medium"],
        },
        reasoningLevels: [{ id: "medium", label: "Medium" }],
        composerActions: [],
        completedTurnDisplay: "flat",
        models: { fallback: [MIRROR_MODEL], scope: "host" },
        deriveProviderOptions: (): MirrorProviderOptions => ({ feedDir }),
      });
      mirrorProvider = true;
    } catch (cause) {
      bb.log.warn(`fleet mirror provider not registered (copies cannot open here): ${message(cause)}`);
    }
  }
  let mirrorError: string | null = null;

  // ---------- local snapshot ----------

  async function localHosts() {
    const hosts = (await bb.sdk.hosts.list()) as unknown as {
      id: string;
      name: string;
      status: string;
      machineProviderId: string | null;
      type: string;
    }[];
    const persistent = hosts.filter((h) => h.type === "persistent");
    const serverHost = persistent.find((h) => h.machineProviderId === null) ?? persistent[0];
    const keyOf = (h: { id: string; name: string }) =>
      h.id === serverHost?.id ? machineKey : canonicalMachine(machineKeyForHost(h.name, aliases, profile));
    return { hosts: persistent, serverHost, keyOf };
  }

  let capabilitiesCache: { at: number; value: HostCapabilities } | null = null;
  async function hostCapabilities(): Promise<HostCapabilities | null> {
    if (capabilitiesCache && Date.now() - capabilitiesCache.at < 10 * 60_000) return capabilitiesCache.value;
    try { capabilitiesCache = { at: Date.now(), value: await probeCapabilities() }; }
    catch (cause) { bb.log.warn(`capability probe failed: ${message(cause)}`); }
    return capabilitiesCache?.value ?? null;
  }

  /**
   * A project's workload: only the plugin setting's explicit tag. The profile's match
   * words pick a workload for new work in the Console's start box, but never lock a
   * whole project to one machine here; that stays an explicit choice in projectWorkloads.
   */
  function projectWorkload(project: { id: string; name: string }): string | undefined {
    let tags: Record<string, unknown> = {};
    try { tags = JSON.parse(config.projectWorkloads || "{}") as Record<string, unknown>; } catch { tags = {}; }
    const tag = tags[project.id] ?? tags[project.name];
    return isWorkloadId(profile, tag) ? tag : undefined;
  }
  /** A tagged project (any workload but general) runs only where that workload belongs. */
  const isTaggedWorkload = (workload: string | undefined): workload is string => workload !== undefined && workload !== GENERAL_WORKLOAD;

  let appVersionCache: { at: number; value: string | null } | null = null;
  async function appVersion(): Promise<string | null> {
    if (appVersionCache && Date.now() - appVersionCache.at < 5 * 60_000) return appVersionCache.value;
    try { appVersionCache = { at: Date.now(), value: ((await bb.sdk.system.appUpdate()) as unknown as { current: { version: string } }).current.version }; }
    catch { appVersionCache = { at: Date.now(), value: null }; }
    return appVersionCache.value;
  }

  async function mcpState(url: string | null): Promise<Snapshot["mcp"]> {
    try {
      const list = await bb.sdk.plugins.list() as unknown as { id: string; enabled?: boolean }[] | { plugins: { id: string; enabled?: boolean }[] };
      const plugins = Array.isArray(list) ? list : list.plugins;
      const mcp = plugins.find((plugin) => plugin.id === "bb--mcp");
      return { installed: mcp !== undefined, enabled: mcp?.enabled === true, endpoint: mcp?.enabled === true && url ? `${url.replace(/\/+$/, "")}/api/v1/plugins/bb--mcp/http/mcp` : null };
    } catch { return undefined; }
  }

  async function buildSnapshot(options: { authenticated?: boolean } = {}): Promise<Snapshot> {
    const { serverId, url } = await me();
    const { hosts, serverHost, keyOf } = await localHosts();
    const projects = (await bb.sdk.projects.list({ includePersonal: true })) as unknown as {
      id: string;
      name: string;
      kind: string;
      sources?: { hostId: string; path: string }[];
    }[];
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const listed = (await bb.sdk.threads.list({ limit: 300 })) as unknown as {
      id: string;
      title: string | null;
      titleFallback: string | null;
      status: string;
      visibility: string;
      archivedAt: number | null;
      projectId: string;
      providerId: string | null;
      parentThreadId: string | null;
      createdAt: number;
      updatedAt: number;
      environmentHostId: string | null;
      pinnedAt?: number | null;
      sectionId?: string | null;
      hasPendingInteraction?: boolean;
      queuedWork?: string;
      runtime?: { displayStatus?: string } | null;
    }[];
    const hostById = new Map(hosts.map((h) => [h.id, h]));
    const sections = await sectionNames();
    const now = Date.now();
    const threads: FleetThread[] = listed
      .filter((t) => t.visibility === "visible" && t.archivedAt === null)
      .map((t) => {
        const host = t.environmentHostId ? hostById.get(t.environmentHostId) : serverHost;
        const project = projectById.get(t.projectId);
        return {
          id: t.id,
          title: (t.title || t.titleFallback || t.id).slice(0, 140),
          state: threadState(t),
          machine: host ? keyOf(host) : machineKey,
          projectId: t.projectId,
          projectName: project?.kind === "personal" ? null : (project?.name ?? null),
          providerId: t.providerId,
          parentThreadId: t.parentThreadId,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          url: threadUrl(url, t.projectId, t.id, project?.kind === "personal"),
          pinned: t.pinnedAt !== null && t.pinnedAt !== undefined,
          sectionName: t.sectionId ? (sections.get(t.sectionId) ?? null) : null,
        };
      });
    const caps = [...declaredCaps];
    const observed = await hostCapabilities();
    const nas = await nasAvailability(nasConfig);
    if (nas.mounted && !caps.includes("NAS")) caps.unshift("NAS");
    const machines: MachineInfo[] = hosts.map((h) => ({
      key: keyOf(h),
      label: h.id === serverHost?.id ? machineLabel : profileMachineLabel(profile, machineKeyForHost(h.name, aliases, profile)),
      online: h.status === "connected",
      capabilities: h.id === serverHost?.id ? caps : [],
      verifiedCapabilities: h.id === serverHost?.id ? [...(nas.reachable ? ["NAS"] : []), ...(observed ? verifiedCapabilityNames(observed) : [])] : [],
    }));
    let providers: NonNullable<Snapshot["providers"]> | undefined;
    try {
      const listed = (await bb.sdk.providers.list({ hostId: serverHost?.id })) as unknown as { id: string; available: boolean; displayName?: string; capabilities?: { fork?: string } }[];
      let states = new Map<string, { status: string; planLabel: string | null }>();
      try { states = new Map(((await bb.sdk.system.providerStates({ hostId: serverHost?.id } as never)) as unknown as { providers: { providerId: string; status: string; planLabel: string | null }[] }).providers.map((state) => [state.providerId, state])); } catch { states = new Map(); }
      const known = new Set(["ready", "not_installed", "unauthenticated", "expired", "unsupported_version", "unknown"]);
      providers = listed.map((p) => {
        const state = states.get(p.id);
        return { id: p.id, available: p.available, observedAt: Date.now(), ...(p.displayName ? { displayName: p.displayName } : {}), ...(state && known.has(state.status) ? { auth: state.status as "ready" } : {}), ...(state ? { planLabel: state.planLabel } : {}), ...(p.capabilities?.fork ? { fork: p.capabilities.fork } : {}) };
      });
    }
    catch (cause) { bb.log.warn(`provider availability could not be read: ${message(cause)}`); }
    return snapshotSchema.parse({
      serverId,
      label: machineLabel,
      url,
      machineKey,
      machines,
      threads: await threadAccounts.mark(await withExecution(selectThreads(threads, now))),
      publishedAt: now,
      features: [...RELAY_FEATURES, EXECUTION_FEATURE, CONTROLS_FEATURE, WORK_ATTACHMENTS_FEATURE, MIRROR_INTERACTIONS_FEATURE, ...(relayKey ? [SEALED_RELAY_FEATURE] : []), ...(mirror === null ? [] : [MIRROR_FEATURE])],
      ownerHostId: await provenLocalHostId().catch(() => null),
      resources: await sampleResources(),
      system: await sampleSystem(now).catch(() => null),
      ...(providers === undefined ? {} : { providers }),
      projects: projects.filter((project) => project.kind === "personal" || project.sources?.some((source) => source.hostId === serverHost?.id)).slice(0, 200).map(({ id, name, kind, sources }) => {
        const workload = projectWorkload({ id, name });
        const path = options.authenticated ? sources?.find((source) => source.hostId === serverHost?.id)?.path : undefined;
        return { id, name, kind, ...(workload ? { workload } : {}), ...(path ? { path } : {}) };
      }),
      ...(observed ? { capabilities: observed } : {}),
      appVersion: await appVersion(),
      ...(await mcpState(url).then((mcp) => (mcp ? { mcp } : {}))),
      ...(mirror === null ? {} : { mirrorKey: mirror.publicKey }),
    });
  }

  let previousCpu = cpus().map((cpu) => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }));
  async function sampleResources() {
    const current = cpus();
    let idle = 0; let total = 0;
    current.forEach((cpu, i) => {
      const old = previousCpu[i];
      if (old) { idle += cpu.times.idle - old.idle; total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0) - old.total; }
    });
    previousCpu = current.map((cpu) => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }));
    return { observedAt: Date.now(), cpuCount: Math.max(1, current.length), cpuUtilization: total > 0 && idle >= 0 && idle <= total ? 1 - idle / total : null, totalMemoryBytes: totalmem(), availableMemoryBytes: await availableMemoryBytes() };
  }

  const SYSTEM_SAMPLE_MS = 30_000;
  let systemRead: { attemptedAt: number; system: System | null; flight: Promise<void> | null } = { attemptedAt: Number.NEGATIVE_INFINITY, system: null, flight: null };

  const readCommand = (bin: string, args: string[], timeout = 3_000) => new Promise<string | null>((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)));
  });

  /**
   * CPU, memory, load, swap, disk and sleep holders from fixed system tools, refreshed at most once per window.
   * Stale-while-revalidate: `top -l 2 -s 1` takes 1-8 s, so only the very first read is awaited; after that the
   * last value is returned at once and the refresh runs in the background. A failed refresh keeps the last value.
   */
  async function sampleSystem(now: number): Promise<System | null> {
    if (process.platform !== "darwin") return null;
    if (systemRead.flight === null && now - systemRead.attemptedAt >= SYSTEM_SAMPLE_MS) {
      systemRead.attemptedAt = now;
      systemRead.flight = Promise.all([
        readCommand("/usr/bin/top", ["-l", "2", "-n", "0", "-s", "1"], 8_000),
        readCommand("/usr/sbin/sysctl", ["-n", "hw.ncpu", "hw.memsize"]),
        readCommand("/usr/sbin/sysctl", ["-n", "vm.loadavg"]),
        readCommand("/usr/bin/vm_stat", []),
        readCommand("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
        readCommand("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
        readCommand("/bin/df", ["-k", "/"]),
        readCommand("/usr/bin/pmset", ["-g", "assertions"]),
      ])
        .then(([top, hardware, loadavg, vmStat, pressure, swap, df, pmset]) => { const next = buildSystem({ top, hardware, loadavg, vmStat, pressure, swap, df, pmset }); if (next !== null) systemRead.system = next; })
        .catch(() => { /* a failed refresh keeps the last value; it must never reject a snapshot */ })
        .finally(() => { systemRead.flight = null; });
    }
    if (systemRead.system === null) await systemRead.flight;
    return systemRead.system;
  }

  /** macOS: the kernel's available-memory level, since freemem() excludes reclaimable pages there. */
  function availableMemoryBytes(): Promise<number> {
    if (process.platform !== "darwin") return Promise.resolve(freemem());
    return new Promise((resolve) => {
      execFile("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"], { timeout: 2_000 }, (error, stdout) => {
        resolve((error ? null : macAvailableMemoryBytes(String(stdout), totalmem())) ?? freemem());
      });
    });
  }

  /** Section names by id (an older bb without sections gives none). */
  async function sectionNames(): Promise<Map<string, string>> {
    try {
      const list = (await bb.sdk.threadSections.list()) as { id: string; name: string }[];
      return new Map(list.map((section) => [section.id, section.name]));
    } catch {
      return new Map();
    }
  }

  const threadAccounts = createThreadAccounts({
    read: () => bb.sdk.plugins.callRpc({ pluginId: "navaigate-skin", method: "thread_accounts", input: null as never, outputSchema: z.unknown(), signal: AbortSignal.timeout(5_000) }),
  });

  // Model and reasoning level per thread, re-read only after the thread changed.
  const executionCache = new Map<string, { updatedAt: number; model: string | null; reasoningLevel: string | null }>();
  async function withExecution(selected: FleetThread[]): Promise<FleetThread[]> {
    let reads = 0;
    for (const t of selected) {
      const cached = executionCache.get(t.id);
      if (cached !== undefined && cached.updatedAt === t.updatedAt) continue;
      if (reads >= 12) continue; // the rest next snapshot
      reads += 1;
      try {
        const options = (await bb.sdk.threads.defaultExecutionOptions({ threadId: t.id })) as { model?: unknown; reasoningLevel?: unknown } | null;
        executionCache.set(t.id, {
          updatedAt: t.updatedAt,
          model: typeof options?.model === "string" ? options.model : null,
          reasoningLevel: typeof options?.reasoningLevel === "string" ? options.reasoningLevel : null,
        });
      } catch {
        executionCache.set(t.id, { updatedAt: t.updatedAt, model: cached?.model ?? null, reasoningLevel: cached?.reasoningLevel ?? null });
      }
    }
    const keep = new Set(selected.map((t) => t.id));
    for (const id of [...executionCache.keys()]) if (!keep.has(id)) executionCache.delete(id);
    return selected.map((t) => {
      const cached = executionCache.get(t.id);
      return cached === undefined ? t : { ...t, model: cached.model, reasoningLevel: cached.reasoningLevel };
    });
  }

  // ---------- starting work ----------

  async function spawnLocal(target: string, prompt: string, title: string | undefined, from: string, selection: ExecutionSelection = {}, routing: RoutingPreferences = {}, project: WorkProject = {}, privateOutput = false, ownerAttachments: OwnerAttachmentRef[] = []) {
    let validated: Awaited<ReturnType<typeof validateLocalStart>>;
    let attachmentInput: unknown[] = [];
    try {
      validated = await validateLocalStart(target, selection, routing, project);
      attachmentInput = await verifiedAttachmentInput(validated.projectId, ownerAttachments);
    }
    catch (cause) { throw cause instanceof PreDispatchRejection ? cause : new PreDispatchRejection(message(cause)); }
    const { projectId, environment, isPersonal } = validated;
    selection = validated.selection;
    const explicit = Object.fromEntries(Object.keys(selection).map((key) => [key, "explicit" as const]));
    const { reasoningLevel, ...otherSelection } = selection;
    let spawned: { thread?: { id: string }; id?: string };
    try { spawned = (await bb.sdk.threads.spawn({
      projectId,
      environment: environment as never,
      ...(attachmentInput.length ? { input: [{ type: "text", text: prompt, mentions: [] }, ...attachmentInput] as never } : { prompt }),
      ...(title ? { title } : {}),
      ...otherSelection,
      // Older SDK declarations enumerate reasoning IDs; the destination catalog above
      // is authoritative and the native endpoint still validates the final request.
      ...(reasoningLevel ? { reasoningLevel: reasoningLevel as Parameters<typeof bb.sdk.threads.spawn>[0]["reasoningLevel"] } : {}),
      ...(Object.keys(explicit).length ? { executionInputSources: explicit } : {}),
      pluginMetadata: { startedFrom: from, machine: target, fleetExecution: selection },
    })) as unknown as { thread?: { id: string }; id?: string }; }
    catch (cause) {
      if (isNativeCheckoutRefusal(message(cause))) throw new PreDispatchRejection(`${target} could not use this project's checkout, so nothing was started: ${message(cause)}`);
      throw new OwnerStartOutcomeUnknown(`Native start outcome is unknown; inspect this owner's threads before creating another job: ${message(cause)}`);
    }
    const threadId = spawned.thread?.id ?? spawned.id ?? "";
    if (privateOutput && threadId) markPrivateThread(threadId, "sealed-command");
    const { url } = await me();
    return { threadId, url: threadUrl(url, projectId, threadId, isPersonal) };
  }

  /** Every check before a native spawn. Any failure here means nothing was started. */
  async function validateLocalStart(target: string, selection: ExecutionSelection, routing: RoutingPreferences, project: WorkProject) {
    refuseIfMisconfigured();
    selection = executionSelection(selection);
    const refusal = workloadRefusal(profile, target, routing.workload);
    if (refusal !== null) throw new Error(refusal);
    const { hosts, keyOf } = await localHosts();
    const host = hosts.find((h) => keyOf(h) === target && h.status === "connected");
    if (host === undefined) throw new Error(`${target} is not connected to this bb`);
    const requiredCapabilities = [...(routing.requiredCapabilities ?? []), ...(routing.needsNas ? ["NAS"] : [])];
    if (requiredCapabilities.length) {
      const nas = await nasAvailability(nasConfig);
      const observed = target === machineKey ? await hostCapabilities() : null;
      const verified = new Set([...(target === machineKey && nas.reachable ? ["nas"] : []), ...(observed ? verifiedCapabilityNames(observed) : [])]);
      for (const capability of requiredCapabilities) if (!verified.has(capability.toLowerCase())) throw new Error(`${capability} is not independently verified on ${target}; the job was not dispatched`);
    }
    const projects = (await bb.sdk.projects.list({ includePersonal: true })) as unknown as {
      id: string;
      name: string;
      kind: string;
      sources?: { hostId: string; path: string; isDefault?: boolean }[];
    }[];
    const explicitProject = project.projectId !== undefined || project.projectName !== undefined;
    const preferred = project.projectId ? projects.find((p) => p.id === project.projectId) : projects.find((p) => p.name === (project.projectName ?? (config.defaultProject || fleetSection(profile).defaultProject)));
    if (explicitProject && !preferred) throw new Error(`The requested project ${project.projectName ?? project.projectId} does not exist on ${target}; clone or map it there first`);
    const preferredWorkload = preferred ? projectWorkload(preferred) : undefined;
    if (preferred && isTaggedWorkload(preferredWorkload) && routing.workload !== preferredWorkload) throw new Error(`${preferred.name} is tagged as a ${workloadLabel(profile, preferredWorkload)} project; start it with the ${workloadLabel(profile, preferredWorkload)} workload so it runs on ${profileMachineLabel(profile, profile.workloads.find((w) => w.id === preferredWorkload)?.machine ?? null) || "its own machine"} only`);
    const source = preferred?.sources?.find((s) => s.hostId === host.id);
    const personal = projects.find((p) => p.kind === "personal");
    let projectId: string;
    let environment: unknown;
    let isPersonal = false;
    if (preferred && source) {
      projectId = preferred.id;
      environment = { type: "host", hostId: host.id, workspace: project.workspace ?? { type: "unmanaged", path: source.path } };
    } else if (personal && (!explicitProject || preferred?.kind === "personal")) {
      if (project.workspace) throw new Error("An explicit checkout/worktree needs a mapped destination project; it cannot fall back to personal workspace");
      projectId = preferred?.kind === "personal" ? preferred.id : personal.id;
      isPersonal = true;
      environment = { type: "host", hostId: host.id, workspace: { type: "personal" } };
    } else {
      throw new Error(`The requested project has no checkout on ${target}, or no default/personal workspace is available`);
    }
    if (selection.providerId) {
      const providers = await bb.sdk.providers.list({ hostId: host.id });
      const provider = providers.find((entry) => entry.id === selection.providerId);
      if (!provider?.available) throw new Error(`Provider ${selection.providerId} is not available on ${target}`);
      if (selection.model || selection.reasoningLevel || selection.serviceTier) {
        // Host-scoped lookup also works on SDK 0.6.37 owners; projectId was added later.
        const catalog = await bb.sdk.providers.models({ hostId: host.id, providerId: selection.providerId });
        if (catalog.modelLoadError) throw new Error(`Cannot verify ${selection.providerId} on ${target}: ${catalog.modelLoadError.detail ?? catalog.modelLoadError.code}`);
        const model = selection.model ? catalog.models.find((entry) => entry.model === selection.model || entry.id === selection.model) : undefined;
        if (selection.model && !model) throw new Error(`Model ${selection.model} is not available for ${selection.providerId} on ${target}`);
        const reasoning = model ? model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort) : (provider.reasoningLevels ?? []).map((entry) => entry.id);
        if (selection.reasoningLevel && !reasoning.includes(selection.reasoningLevel)) throw new Error(`Reasoning level ${selection.reasoningLevel} is not available on ${target}`);
        if (selection.serviceTier && selection.serviceTier !== "default" && !(model?.supportedServiceTiers ?? provider.serviceTiers ?? []).some((entry) => entry.id === selection.serviceTier)) throw new Error(`Service tier ${selection.serviceTier} is not available on ${target}`);
      }
    }
    return { projectId, environment, isPersonal, selection };
  }

  async function routePreview(machine: string, selection: ExecutionSelection = {}, routing: RoutingPreferences = {}, project: WorkProject = {}, withAttachments = false) {
    await ensureRemote();
    if (machine.toUpperCase() === "AUTO" || (directId !== null && canonicalMachine(machine) === directId)) await refreshDirectOwner();
    const local = await buildSnapshot();
    const attachmentOwners = directOwner && (directOwner.features ?? []).includes(WORK_ATTACHMENTS_FEATURE) ? [directOwner] : [];
    const snapshots = withAttachments ? [local, ...attachmentOwners] : [local, ...remote, ...(directOwner ? [directOwner] : [])];
    const direct = directOwner && (!lastSuccessfulSyncAt || publishError !== null || turso === null) ? directOwner.serverId : null;
    const brokerServerIds = snapshots.filter((snapshot) => snapshot.serverId !== local.serverId && snapshot.serverId !== direct).map((snapshot) => snapshot.serverId);
    const taggedWorkload = snapshots.flatMap((snapshot) => snapshot.projects ?? []).find((entry) => isTaggedWorkload(entry.workload) && (entry.id === project.projectId || entry.name === project.projectName))?.workload;
    const tagged = taggedWorkload !== undefined;
    const effective = tagged && routing.workload !== taggedWorkload ? { ...routing, workload: taggedWorkload } : routing;
    const decision = chooseRoute({ machine, snapshots, now: Date.now(), execution: selection, routing: effective, project, brokerServerIds: withAttachments ? [] : brokerServerIds, profile });
    const warnings = [
      ...decision.warnings,
      ...(tagged && routing.workload !== taggedWorkload ? [`This project is tagged ${workloadLabel(profile, taggedWorkload)}, so only ${profileMachineLabel(profile, profile.workloads.find((w) => w.id === taggedWorkload)?.machine ?? null) || "its own machine"} is eligible`] : []),
      ...(withAttachments ? ["attachments need a direct authenticated owner route"] : []),
    ];
    return { ...decision, warnings, ...(withAttachments && decision.machine === null ? { reason: `${decision.reason} (attachments need a direct authenticated owner route: this Mac or ${directLabel} over SSH)` } : {}) };
  }

  function uuidFrom(text: string): string {
    const hex = createHash("sha256").update(text).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  type AttachmentFile = { type: "localImage" | "localFile"; name: string; mimeType: string; sha256: string; bytes: Buffer };

  /** Read each source project attachment's bytes here, bounded, before any claim or route side effect. */
  async function readSourceAttachments(refs: z.infer<typeof sourceAttachmentSchema>[]): Promise<AttachmentFile[]> {
    let total = 0;
    const files: AttachmentFile[] = [];
    for (const ref of refs) {
      let stored: { bytes: Uint8Array; sizeBytes: number; mimeType?: string | null };
      try { stored = await bb.sdk.projects.attachments.read({ projectId: ref.sourceProjectId, path: ref.path }) as unknown as typeof stored; }
      catch (cause) { throw new Error(`${REJECTED_PREFIX}Attachment ${ref.name} could not be read on this Mac: ${message(cause)}`); }
      total += stored.sizeBytes;
      if (total > MAX_ATTACHMENT_BYTES) throw new Error(`${REJECTED_PREFIX}Attachments for another Mac are limited to 8 MiB per task`);
      const bytes = Buffer.from(stored.bytes);
      files.push({ type: ref.type, name: ref.name, mimeType: ref.mimeType ?? stored.mimeType ?? (ref.type === "localImage" ? "image/png" : "application/octet-stream"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
    }
    return files;
  }

  /** The destination project a start would use on this owner (explicit, default or personal). */
  async function resolveDestinationProject(project: WorkProject): Promise<string> {
    const projects = (await bb.sdk.projects.list({ includePersonal: true })) as unknown as { id: string; name: string; kind: string }[];
    const explicit = project.projectId !== undefined || project.projectName !== undefined;
    const preferred = project.projectId ? projects.find((p) => p.id === project.projectId) : projects.find((p) => p.name === (project.projectName ?? (config.defaultProject || fleetSection(profile).defaultProject)));
    if (explicit && !preferred) throw new Error(`The requested project ${project.projectName ?? project.projectId} does not exist on ${machineKey}`);
    const destination = preferred ?? projects.find((p) => p.kind === "personal");
    if (!destination) throw new Error(`No destination project exists on ${machineKey}`);
    return destination.id;
  }

  /** Upload verified attachments into a destination project on this owner; idempotent by request id and file hashes. */
  async function putAttachments(projectId: string, files: (Omit<AttachmentFile, "bytes"> & { bytes: Buffer })[], requestId: string): Promise<OwnerAttachmentRef[]> {
    let total = 0;
    for (const file of files) {
      total += file.bytes.length;
      if (createHash("sha256").update(file.bytes).digest("hex") !== file.sha256) throw new PreDispatchRejection(`Attachment ${file.name} does not match its SHA-256`);
    }
    if (total > MAX_ATTACHMENT_BYTES) throw new PreDispatchRejection("Attachments are limited to 8 MiB per task");
    const claim = claimRequest(requestId, "attachments", { projectId, files: files.map(({ name, type, mimeType, sha256: hash }) => ({ name, type, mimeType, sha256: hash })) });
    if (claim.existing) {
      const row = requestDb.prepare("SELECT status FROM fleet_request_receipts WHERE id = ?").get(requestId) as { status: string } | undefined;
      if (row?.status === "completed" && claim.result) return z.array(ownerAttachmentSchema).parse(JSON.parse(claim.result));
      throw new Error(`Attachment upload ${requestId} has an unknown outcome; it was not repeated`);
    }
    const refs: OwnerAttachmentRef[] = [];
    try {
      for (const file of files) {
        const uploaded = await bb.sdk.projects.attachments.upload({ projectId, filename: file.name, mimeType: file.mimeType, clientFile: new Uint8Array(file.bytes) } as never) as unknown as { type: "localImage" | "localFile"; name: string; path: string; sizeBytes: number; mimeType?: string };
        const stored = await bb.sdk.projects.attachments.read({ projectId, path: uploaded.path }) as unknown as { bytes: Uint8Array; sizeBytes: number };
        if (stored.sizeBytes !== file.bytes.length || createHash("sha256").update(stored.bytes).digest("hex") !== file.sha256) throw new Error(`Attachment ${file.name} failed verification after upload`);
        refs.push({ type: file.type, path: uploaded.path, sourceProjectId: projectId, name: uploaded.name || file.name, sizeBytes: uploaded.sizeBytes, mimeType: uploaded.mimeType ?? file.mimeType, sha256: file.sha256 });
      }
    } catch (cause) {
      recordRequest(requestId, { message: message(cause) }, "unknown");
      throw new Error(`Attachment upload outcome is unknown: ${message(cause)}`);
    }
    recordRequest(requestId, refs);
    return refs;
  }

  /** Native image/file blocks for attachments already stored and verified in this project. */
  async function verifiedAttachmentInput(projectId: string, refs: OwnerAttachmentRef[]): Promise<unknown[]> {
    const input: unknown[] = [];
    for (const ref of refs) {
      if (ref.sourceProjectId !== projectId) throw new PreDispatchRejection(`Attachment ${ref.name} is stored in another project than the task's`);
      const stored = await bb.sdk.projects.attachments.read({ projectId, path: ref.path }) as unknown as { bytes: Uint8Array; sizeBytes: number };
      if (stored.sizeBytes !== ref.sizeBytes || createHash("sha256").update(stored.bytes).digest("hex") !== ref.sha256) throw new PreDispatchRejection(`Attachment ${ref.name} does not match its verified bytes`);
      input.push(ref.type === "localImage" ? { type: "localImage", path: ref.path, sourceProjectId: projectId } : { type: "localFile", path: ref.path, sourceProjectId: projectId, name: ref.name, sizeBytes: ref.sizeBytes, ...(ref.mimeType ? { mimeType: ref.mimeType } : {}) });
    }
    return input;
  }

  async function startWork(machine: string, prompt: string, title: string | undefined, selection: ExecutionSelection = {}, routing: RoutingPreferences = {}, requestId: string = randomUUID(), project: WorkProject = {}, attachments: { source: z.infer<typeof sourceAttachmentSchema>[]; owner: OwnerAttachmentRef[] } = { source: [], owner: [] }) {
    refuseIfMisconfigured();
    selection = executionSelection(selection);
    const attachmentFingerprint = [
      ...attachments.source.map(({ type, sourceProjectId, path, name }) => ({ type, sourceProjectId, path, name })),
      ...attachments.owner.map(({ name, type, sha256: hash }) => ({ name, type, sha256: hash })),
    ];
    const fingerprintPayload = { machine, prompt, title: title ?? null, selection, routing, project, ...(attachmentFingerprint.length ? { attachments: attachmentFingerprint } : {}) };
    /** A refusal before any side effect still leaves a positive not-started receipt, so the same id may retry. */
    const refuseBeforeStart = (reason: string): z.infer<typeof workResultSchema> => {
      const claim = claimRequest(requestId, "work", fingerprintPayload);
      if (claim.existing) {
        const status = (requestDb.prepare("SELECT status FROM fleet_request_receipts WHERE id = ?").get(requestId) as { status: string } | undefined)?.status;
        if (status === "completed" && claim.result) return workResultSchema.parse(JSON.parse(claim.result));
        throw new Error(`Request ${requestId} has an unknown or in-progress outcome. Check its original destination before creating another job.`);
      }
      recordRequest(requestId, { reason: "rejected", message: reason.replace(REJECTED_PREFIX, "") }, "rejected");
      throw new Error(reason.startsWith(REJECTED_PREFIX) ? reason : `${REJECTED_PREFIX}${reason}`);
    };
    let sourceFiles: AttachmentFile[] = [];
    try { sourceFiles = attachments.source.length ? await readSourceAttachments(attachments.source) : []; }
    catch (cause) { return refuseBeforeStart(message(cause)); }
    const route = await routePreview(machine, selection, routing, project, sourceFiles.length > 0);
    if (!route.machine || !route.serverId) return refuseBeforeStart(route.reason);
    const { serverId } = await me();
    const claimed = claimRequest(requestId, "work", fingerprintPayload);
    if (claimed.existing) {
      if (claimed.result) return workResultSchema.parse(JSON.parse(claimed.result));
      throw new Error(`Request ${requestId} has an unknown or in-progress outcome. Check its original destination before creating another job.`);
    }
    const attachmentsUuid = uuidFrom(`fleet-work-attachments:${requestId}`);
    const attachmentSummary = (refs: OwnerAttachmentRef[]) => (refs.length ? { attachments: refs.map((ref) => ({ name: ref.name, sha256: ref.sha256, sizeBytes: ref.sizeBytes, verified: true as const })) } : {});
    if (route.serverId === serverId) {
      let r: { threadId: string; url: string | null };
      let ownerRefs = attachments.owner;
      let startProject = project;
      try {
        if (sourceFiles.length) {
          const destination = await resolveDestinationProject(project).catch((cause: unknown) => { throw new PreDispatchRejection(message(cause)); });
          ownerRefs = await putAttachments(destination, sourceFiles, attachmentsUuid);
          startProject = { ...project, projectId: destination };
        }
        r = await spawnLocal(route.machine, prompt, title, serverId, selection, routing, startProject, false, ownerRefs);
      }
      catch (cause) {
        if (cause instanceof PreDispatchRejection) {
          recordRequest(requestId, { reason: "rejected", message: cause.message }, "rejected");
          throw new Error(`${REJECTED_PREFIX}${cause.message}`);
        }
        throw cause;
      }
      const result = { outcome: "started" as const, threadId: r.threadId, url: r.url, commandId: null, requestId, route, ...attachmentSummary(ownerRefs) };
      recordRequest(requestId, result);
      return result;
    }
    if (directId !== null && route.machine === directId && directOwner?.serverId === route.serverId && (sourceFiles.length > 0 || attachments.owner.length > 0 || !lastSuccessfulSyncAt || publishError !== null || turso === null)) {
      let remote: unknown;
      let ownerRefs: OwnerAttachmentRef[] = [];
      let startProject = project;
      try {
        if (sourceFiles.length) {
          const put = z.object({ projectId: z.string(), attachments: z.array(ownerAttachmentSchema) }).parse(await directRpc("work_attachments_put", { v: 1, requestId: attachmentsUuid, ...(project.projectId ? { projectId: project.projectId } : {}), ...(project.projectName ? { projectName: project.projectName } : {}), files: sourceFiles.map(({ bytes, ...file }) => ({ ...file, contentBase64: bytes.toString("base64") })) }, true));
          ownerRefs = put.attachments;
          startProject = { ...project, projectId: put.projectId };
        }
        remote = await directRpc("work_start", { machine: directId!, prompt, ...(title ? { title } : {}), ...selection, routing, requestId, ...startProject, ...(ownerRefs.length ? { ownerAttachments: ownerRefs } : {}) }, true);
      }
      catch (cause) {
        if (cause instanceof OwnerRouteError && (cause.kind === "unavailable" || cause.kind === "refused")) {
          const reason = cause.kind === "refused" ? "rejected" : "unavailable";
          recordRequest(requestId, { reason, message: cause.message }, reason);
          throw new Error(`${reason === "rejected" ? REJECTED_PREFIX : `${directLabel} was not reached; nothing was started; retry with the same request id: `}${cause.message}`);
        }
        throw cause;
      }
      const remoteResult = { ...workResultSchema.parse(remote), route, ...attachmentSummary(ownerRefs) };
      recordRequest(requestId, remoteResult);
      return remoteResult;
    }
    if (sourceFiles.length || attachments.owner.length) {
      recordRequest(requestId, { reason: "rejected", message: "attachments need a direct authenticated owner route" }, "rejected");
      throw new Error(`${REJECTED_PREFIX}Attachments need a direct authenticated owner route (this Mac or ${directLabel} over SSH); nothing was started`);
    }
    if (turso === null || !config.joinFleet) throw new Error(`This independent owner has no currently usable Fleet route; ${directLabel} SSH is the only configured direct fallback`);
    const owner = [...remote, ...(directOwner ? [directOwner] : [])].filter((snapshot) => snapshot.serverId === route.serverId).sort((a, b) => b.publishedAt - a.publishedAt)[0];
    if (!(owner?.features ?? []).includes(SEALED_RELAY_FEATURE) || !/^[A-Za-z0-9_-]{43}$/.test(owner?.mirrorKey ?? "")) throw new Error("The selected owner cannot receive sealed-relay-v1 commands; plaintext downgrade is disabled");
    await ensureSchema();
    const id = randomUUID();
    const now = Date.now();
    const envelope = { v: 1, kind: "fleet-command", sealed: seal(JSON.stringify({ v: 1, prompt, title: title ?? null, options: commandOptions(selection, routing, project) }), owner!.mirrorKey!, commandAad({ id, fromServer: serverId, targetServer: route.serverId, machine: route.machine })) };
    const persisted = await turso.batch([
      { sql: "INSERT INTO fleet_command_options (command_id, payload) VALUES (?, ?)", args: [id, JSON.stringify(envelope)] },
      { sql: `INSERT INTO fleet_commands (id, target_server, target_host_id, title, prompt, provider_id, from_server, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? FROM fleet_command_options WHERE command_id = ? RETURNING id`, args: [id, route.serverId, route.machine, SEALED_COMMAND_PLACEHOLDER, SEALED_COMMAND_PLACEHOLDER, null, serverId, now, now, id] },
    ]);
    if (persisted[1]?.length !== 1) throw new Error(`Command ${id} was not durably accepted; do not assume the target started`);
    const result = { outcome: "sent" as const, threadId: null, url: null, commandId: id, requestId, route };
    recordRequest(requestId, result);
    return result;
  }

  async function runPendingCommands(): Promise<boolean> {
    if (turso === null || !config.joinFleet) return false;
    await ensureSchema();
    const { serverId } = await me();
    const pending = await turso.query(
      `SELECT c.id, c.target_host_id, c.title, c.prompt, c.from_server, c.provider_id, o.payload AS options_payload FROM fleet_commands c LEFT JOIN fleet_command_options o ON o.command_id = c.id
       WHERE c.target_server = ? AND c.status = 'pending' ORDER BY c.created_at LIMIT 5`,
      [serverId],
    );
    let changed = false;
    for (const row of pending) {
      const id = String(row.id);
      const claimed = await turso.query(
        `UPDATE fleet_commands SET status = 'starting', updated_at = ? WHERE id = ? AND status = 'pending' RETURNING id`,
        [Date.now(), id],
      );
      if (claimed.length === 0) continue;
      changed = true;
      let ownerThread: { threadId: string; url: string | null } | null = null;
      const rawOptions = row.options_payload == null ? null : String(row.options_payload);
      const encrypted = row.prompt === SEALED_COMMAND_PLACEHOLDER || envelopeKind(rawOptions) === "fleet-command";
      try {
        const target = row.target_host_id ? String(row.target_host_id) : machineKey;
        let prompt = String(row.prompt);
        let title = row.title ? String(row.title) : undefined;
        let optionsPayload = rawOptions;
        if (encrypted) {
          if (!relayKey || row.prompt !== SEALED_COMMAND_PLACEHOLDER || row.title !== SEALED_COMMAND_PLACEHOLDER || row.provider_id !== null) throw new Error("Invalid encrypted command header or missing owner key");
          const envelope = sealedCommandEnvelope.parse(JSON.parse(rawOptions ?? "null"));
          const content = sealedCommandContent.parse(JSON.parse(openSealed(envelope.sealed, relayKey, commandAad({ id, fromServer: String(row.from_server), targetServer: serverId, machine: target }))));
          prompt = content.prompt; title = content.title ?? undefined; optionsPayload = content.options;
        }
        const options = readCommandOptions(optionsPayload, encrypted || row.provider_id == null ? null : String(row.provider_id));
        const r = await spawnLocal(target, prompt, title, String(row.from_server), options.execution, options.routing, options.project, encrypted);
        ownerThread = r;
        await turso.query(
          `UPDATE fleet_commands SET status = 'started', thread_id = ?, thread_url = ?, updated_at = ? WHERE id = ?`,
          [r.threadId, r.url, Date.now(), id],
        );
        bb.log.info(`started fleet command ${id} from ${String(row.from_server)} as ${r.threadId}`);
      } catch (cause) {
        const uncertain = ownerThread !== null || cause instanceof OwnerStartOutcomeUnknown;
        const detail = encrypted ? "Encrypted command could not be opened or accepted by its owner; inspect the owner locally for details" : message(cause);
        await turso.query(`UPDATE fleet_commands SET status = ?, thread_id = ?, thread_url = ?, error = ?, updated_at = ? WHERE id = ?`, [
          uncertain ? "unknown" : "failed",
          ownerThread?.threadId ?? null,
          ownerThread?.url ?? null,
          `${uncertain ? "Owner start may already have been accepted; do not resend automatically. " : ""}${detail}`.slice(0, 500),
          Date.now(),
          id,
        ]);
        bb.log.warn(`fleet command ${id} ${uncertain ? "has an unknown outcome" : "failed"}: ${detail}`);
      }
    }
    return changed;
  }

  // ---------- publish + read ----------

  let lastLocal: Snapshot | null = null;

  async function timed<T>(step: string, work: Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work;
    } catch (cause) {
      throw new Error(`${step}: ${message(cause)} (after ${Date.now() - started}ms)`);
    }
  }

  async function sync(): Promise<void> {
    const local = await timed("snapshot", buildSnapshot());
    lastLocal = local;
    if (turso === null || !config.joinFleet) {
      remote = [];
      return;
    }
    const [, rows] = await timed("publish", turso.batch([
      {
        sql: `INSERT INTO fleet_servers (server_id, label, url, hostname, published_at, payload)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(server_id) DO UPDATE SET label = excluded.label, url = excluded.url,
                hostname = excluded.hostname, published_at = excluded.published_at, payload = excluded.payload`,
        args: [local.serverId, local.label, local.url, hostname(), local.publishedAt, JSON.stringify(local)],
      },
      { sql: `SELECT payload FROM fleet_servers WHERE published_at > ?`, args: [Date.now() - 7 * 24 * 3600_000] },
    ]));
    const parsed: Snapshot[] = [];
    for (const row of rows ?? []) {
      try {
        const snap = snapshotSchema.safeParse(JSON.parse(String(row.payload)));
        if (snap.success && snap.data.serverId !== local.serverId) parsed.push(snap.data);
      } catch {
        /* skip a malformed row */
      }
    }
    remote = parsed;
    lastSuccessfulSyncAt = Date.now();
  }

  async function recentCommands() {
    if (turso === null || !config.joinFleet) return [];
    const { serverId } = await me();
    const rows = await turso.query(
      `SELECT id, target_server, target_host_id, title, status, thread_url, error, created_at FROM fleet_commands
       WHERE from_server = ? AND created_at > ? ORDER BY created_at DESC LIMIT 10`,
      [serverId, Date.now() - 24 * 3600_000],
    );
    return rows.map((r) => ({
      id: String(r.id),
      targetServer: String(r.target_server),
      targetMachine: String(r.target_host_id ?? r.target_server),
      title: r.title === null ? null : String(r.title),
      status: String(r.status),
      threadUrl: r.thread_url === null ? null : String(r.thread_url),
      error: r.error === null ? null : String(r.error),
      createdAt: Number(r.created_at),
    }));
  }

  // ---------- two-way relay: this machine's side ----------

  let schemaReady: Promise<void> | null = null;
  function ensureSchema(): Promise<void> {
    const db = turso;
    if (db === null) return Promise.reject(new Error("This machine has no brain connection"));
    schemaReady ??= db
      .batch(RELAY_SCHEMA.map((sql) => ({ sql })))
      .then(() => undefined)
      .catch((cause: unknown) => {
        schemaReady = null;
        throw cause;
      });
    return schemaReady;
  }

  interface Fetched {
    updatedAt: number;
    state: ThreadState;
    hash: string; // sha256 of the full answer
    output: string; // cut to OUTPUT_MAX_BYTES
    truncated: boolean;
    empty: boolean;
  }
  // Per watched thread: when to read it next, and the answer last read from bb.
  const watches = new Map<string, { nextCheckAt: number; fetched: Fetched | null }>();
  let lastOutputWarning = "";

  /**
   * One relay cycle: deliver messages queued for this bb, then publish the
   * answers of watched threads (started or messaged through Fleet) that have
   * settled since. Delivery comes first so the thread states read afterwards
   * already show the turn each delivery started.
   */
  async function relay(): Promise<boolean> {
    const db = turso;
    if (db === null || !config.joinFleet) return false;
    await ensureSchema();
    const { serverId } = await me();
    const now = Date.now();
    const [pending, watchedRows, publishedRows] = await db.batch([
      {
        sql: `SELECT m.id, m.thread_id, m.body, m.from_server, c.payload AS control_payload FROM fleet_messages m LEFT JOIN fleet_message_controls c ON c.message_id = m.id
              WHERE m.target_server = ? AND m.status = 'pending' ORDER BY m.created_at LIMIT 5`,
        args: [serverId],
      },
      {
        sql: `SELECT thread_id, MAX(delivered_at) AS delivered_at FROM (
                SELECT thread_id, NULL AS delivered_at FROM fleet_commands
                 WHERE target_server = ? AND thread_id IS NOT NULL AND thread_id != '' AND created_at > ?
                UNION ALL
                SELECT thread_id, updated_at AS delivered_at FROM fleet_messages
                 WHERE target_server = ? AND status = 'delivered' AND updated_at > ?
              ) GROUP BY thread_id`,
        args: [serverId, now - WATCH_MS, serverId, now - WATCH_MS],
      },
      {
        sql: `SELECT thread_id, output_hash, state, updated_at FROM fleet_outputs WHERE server_id = ? AND updated_at > ?`,
        args: [serverId, now - 2 * WATCH_MS],
      },
      {
        sql: `UPDATE fleet_messages SET status = 'failed', error = ?, updated_at = ?
              WHERE target_server = ? AND status = 'delivering' AND updated_at < ?`,
        args: ["Delivery was interrupted (bb restarted?). Check the thread before sending it again.", now, serverId, now - STUCK_MS],
      },
    ]);
    let changed = false;

    const justDelivered = new Set<string>();
    for (const row of pending ?? []) {
      const id = String(row.id);
      const threadId = String(row.thread_id ?? "");
      const claimed = await db.query(
        `UPDATE fleet_messages SET status = 'delivering', updated_at = ? WHERE id = ? AND status = 'pending' RETURNING id`,
        [Date.now(), id],
      );
      if (claimed.length === 0) continue;
      changed = true;
      const body = String(row.body ?? "");
      const rawControl = typeof row.control_payload === "string" && row.control_payload !== "" ? row.control_payload : null;
      const encrypted = body === SEALED_CONTROL_PLACEHOLDER || envelopeKind(rawControl) === "fleet-control";
      // The delivery time anchors "the turn this message started": taken before
      // bb accepts the message, so the thread's next settle is always later.
      const deliveredAt = Date.now();
      let delivery: string;
      try {
        if (rawControl || encrypted) {
          let control = rawControl;
          if (encrypted) {
            if (!relayKey || body !== SEALED_CONTROL_PLACEHOLDER) throw new Error("Invalid encrypted control header or missing owner key");
            const envelope = sealedControlEnvelope.parse(JSON.parse(rawControl ?? "null"));
            control = openSealed(envelope.sealed, relayKey, controlAad({ id, fromServer: String(row.from_server), targetServer: serverId, threadId, action: envelope.action }));
          }
          const request = controlInputSchema.parse(JSON.parse(control ?? "null"));
          if (request.id !== id || request.targetServer !== serverId || request.remoteThreadId !== threadId || (encrypted && request.action !== sealedControlEnvelope.parse(JSON.parse(rawControl!)).action)) throw new Error("Control metadata does not match its broker envelope");
          const result = await deliverControl(request);
          if (result.state === "unknown") {
            await db.query("UPDATE fleet_messages SET status = 'unknown', error = ?, updated_at = ? WHERE id = ?", [encrypted ? "Encrypted owner dispatch outcome is unknown; do not resend automatically" : result.message ?? "Owner dispatch outcome is unknown; do not resend automatically", Date.now(), id]);
            continue;
          }
          if (result.state !== "sent" && result.state !== "queued") throw new Error(result.message ?? `Owner refused control (${result.state})`);
          delivery = result.state;
        } else {
          if (body.trim() === "") throw new Error("The message is empty");
          if (utf8Length(body) > MESSAGE_MAX_BYTES) throw new Error("The message is larger than 256 KB");
          delivery = await tellThread(threadId, body);
        }
      } catch (cause) {
        const detail = encrypted ? "Encrypted control could not be opened or accepted by its owner; inspect the owner locally for details" : message(cause);
        await db.query(`UPDATE fleet_messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [
          detail.slice(0, 500),
          Date.now(),
          id,
        ]);
        bb.log.warn(`fleet message ${id} to ${threadId} failed: ${detail}`);
        continue;
      }
      justDelivered.add(threadId);
      // The thread now holds the text (the brain keeps no copy). Recording that
      // must not fail the message: a sender told "failed" would send it twice.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await db.query(`UPDATE fleet_messages SET status = 'delivered', body = '', error = NULL, updated_at = ? WHERE id = ?`, [
            deliveredAt,
            id,
          ]);
          if (row.control_payload) await db.query("UPDATE fleet_message_controls SET payload = '' WHERE message_id = ?", [id]);
          bb.log.info(`delivered fleet message ${id} from ${String(row.from_server)} to ${threadId} (${delivery})`);
          break;
        } catch (cause) {
          if (attempt >= 4) {
            // Left in 'delivering'; the stuck sweep later marks it failed with "check the thread".
            bb.log.warn(`fleet message ${id} reached ${threadId} but could not be recorded: ${message(cause)}`);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
        }
      }
    }

    const lastDelivered = new Map<string, number | null>();
    for (const row of watchedRows ?? []) {
      lastDelivered.set(String(row.thread_id), row.delivered_at === null ? null : Number(row.delivered_at));
    }
    for (const id of [...watches.keys()]) if (!lastDelivered.has(id)) watches.delete(id);
    const published = new Map<string, PublishedOutput>();
    for (const row of publishedRows ?? []) {
      published.set(String(row.thread_id), {
        hash: String(row.output_hash ?? ""),
        state: String(row.state ?? ""),
        updatedAt: Number(row.updated_at ?? 0),
      });
    }

    let checks = 0;
    let fetches = 0;
    for (const [threadId, deliveredAt] of lastDelivered) {
      if (isPrivateThread(threadId)) {
        watches.delete(threadId);
        // No native output is fetched or hashed here. Replace any older legacy
        // answer with metadata only, so modern CLI readers can refuse explicitly.
        if (published.get(threadId)?.state !== "private" || published.get(threadId)?.hash !== "private") {
          await db.query(`INSERT INTO fleet_outputs (server_id, thread_id, state, output, output_hash, truncated, updated_at)
            VALUES (?, ?, 'private', '', 'private', 0, ?)
            ON CONFLICT(server_id, thread_id) DO UPDATE SET state = 'private', output = '', output_hash = 'private', truncated = 0, updated_at = excluded.updated_at`, [serverId, threadId, Date.now()]);
          changed = true;
        }
        continue;
      }
      if (justDelivered.has(threadId)) continue; // its turn has only just started
      let watch = watches.get(threadId);
      if (watch === undefined) {
        watch = { nextCheckAt: 0, fetched: null };
        watches.set(threadId, watch);
      }
      const pub = published.get(threadId);
      const awaitingTurn =
        deliveredAt !== null && Date.now() - deliveredAt < 2 * 3600_000 && (pub === undefined || deliveredAt > pub.updatedAt);
      if (Date.now() < watch.nextCheckAt && !awaitingTurn) continue;
      if (checks >= MAX_CHECKS_PER_CYCLE) continue;
      checks += 1;
      const shown = await showThread(threadId);
      if (shown === null) {
        watch.nextCheckAt = Date.now() + 10 * 60_000; // not a thread of this bb (or deleted)
        continue;
      }
      const state = shownState(shown.thread);
      const updatedAt = Number(shown.thread.updatedAt);
      if (!isSettled(state)) {
        watch.nextCheckAt = 0; // running: look again next cycle
        continue;
      }
      watch.nextCheckAt = Date.now() + SETTLED_RECHECK_MS;
      if (watch.fetched === null || watch.fetched.updatedAt !== updatedAt || watch.fetched.state !== state) {
        if (fetches >= MAX_FETCHES_PER_CYCLE) {
          watch.nextCheckAt = 0;
          continue;
        }
        fetches += 1;
        let full: string;
        try {
          full = await threadOutput(threadId);
        } catch (cause) {
          const text = `output of ${threadId}: ${message(cause)}`;
          if (text !== lastOutputWarning) bb.log.warn(text);
          lastOutputWarning = text;
          continue;
        }
        const cut = truncateUtf8(full, OUTPUT_MAX_BYTES);
        watch.fetched = { updatedAt, state, hash: sha256(full), output: cut.text, truncated: cut.truncated, empty: full.trim() === "" };
      }
      const f = watch.fetched;
      if (!decidePublish({ published: pub, state: f.state, hash: f.hash, empty: f.empty, threadUpdatedAt: updatedAt, lastDeliveredAt: deliveredAt })) {
        continue;
      }
      await db.query(
        `INSERT INTO fleet_outputs (server_id, thread_id, state, output, output_hash, truncated, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id, thread_id) DO UPDATE SET state = excluded.state, output = excluded.output,
           output_hash = excluded.output_hash, truncated = excluded.truncated, updated_at = excluded.updated_at`,
        [serverId, threadId, f.state, f.output, f.hash, f.truncated ? 1 : 0, Date.now()],
      );
      changed = true;
      bb.log.info(`published the ${f.state} answer of ${threadId} (${utf8Length(f.output)} bytes${f.truncated ? ", cut to 64 KB" : ""})`);
    }
    return changed;
  }

  bb.background.service("fleet-sync", {
    async start(signal) {
      let nextPublish = 0;
      while (!signal.aborted) {
        await runCycle(signal, async () => {
          let changed = false;
          if (Date.now() >= nextPublish) {
            nextPublish = Date.now() + PUBLISH_EVERY_MS;
            try {
              await sync();
              publishError = null;
              changed = true;
            } catch (cause) {
              if (signal.aborted) return;
              const text = message(cause);
              if (text !== publishError) bb.log.warn(`fleet publish: ${text}`);
              publishError = text;
              changed = true;
            }
          }
          try {
            if (await timed("commands", runPendingCommands())) changed = true;
            pollError = null;
          } catch (cause) {
            if (signal.aborted) return;
            const text = message(cause);
            if (text !== pollError) bb.log.warn(`fleet poll: ${text}`);
            pollError = text;
          }
          if (signal.aborted) return;
          try {
            if (await timed("relay", relay())) changed = true;
            relayError = null;
          } catch (cause) {
            if (signal.aborted) return;
            const text = message(cause);
            if (text !== relayError) bb.log.warn(`fleet relay: ${text}`);
            relayError = text;
          }
          if (changed) announceChange();
        });
        await sleep(POLL_EVERY_MS, signal);
      }
    },
  });

  bb.background.service("fleet-mirror", {
    async start(signal) {
      while (!signal.aborted) {
        await runCycle(signal, async () => {
          if (mirror === null) return;
          try {
            await mirror.tick();
            mirrorError = null;
          } catch (cause) {
            if (signal.aborted) return;
            const text = message(cause);
            if (text !== mirrorError) bb.log.warn(`fleet mirror: ${text}`);
            mirrorError = text;
          }
        });
        await waitOrStop(mirror?.nextDelay() ?? 30_000, signal, (wake) => { wakeMirror = wake; });
      }
    },
  });

  const board = (background = true) => reads.run(background ? "board" : "board:explicit", BOARD_TTL_MS, () => readBoard(background));
  async function readBoard(background: boolean) {
    if (publishError !== null || lastSuccessfulSyncAt === null) await refreshDirectOwner({ background });
    const { serverId } = await me();
    const local = lastLocal ?? (await buildSnapshot());
    const { hosts, keyOf } = await localHosts();
    const localKeys = [...new Set(hosts.filter((h) => h.status === "connected").map(keyOf))];
    let commands: Command[] = [];
    try {
      commands = await recentCommands();
    } catch {
      /* the poll loop reports brain errors */
    }
    const backendHealthy = lastSuccessfulSyncAt !== null && Date.now() - lastSuccessfulSyncAt <= 3 * 60_000 && publishError === null && pollError === null && relayError === null;
    return {
      me: { serverId, machineKey, label: machineLabel, joined: config.joinFleet, brain: turso !== null, backendHealthy, lastSuccessfulSyncAt },
      columns: buildColumns([local, ...remote.filter((snapshot) => snapshot.serverId !== directOwner?.serverId), ...(directOwner ? [directOwner] : [])], serverId, localKeys, Date.now(), profile).map((column) => ({ ...column, online: column.ownerOnline ?? false })),
      commands,
      error: configProblem ?? publishError ?? pollError ?? relayError ?? mirrorError,
      transport: { broker: turso === null || !config.joinFleet ? "disabled" as const : backendHealthy ? "healthy" as const : "unavailable" as const, lastSuccessfulSyncAt, directMachine: directId, directOwner: !directConfigured ? "unconfigured" as const : directOwner && Date.now() - directOwner.publishedAt < 3 * 60_000 && directOwnerError === null ? "ready" as const : "unavailable" as const, directOwnerError },
      at: Date.now(),
    };
  }

  bb.rpc.register(rpcContract, {
    board_get: () => board(true),
    profile_get: () => ({ machines: profile.machines.map((machine) => ({ id: machine.id, label: machine.label, role: machine.role, restricted: machine.restricted })), setupDone: setupDone(profile), picksOff: picksOff(loadProfile().profile) }),
    work_start: async ({ machine, prompt, title, providerId, model, reasoningLevel, serviceTier, routing, requestId, projectId, projectName, workspace, attachments, ownerAttachments }) => {
      const selection = executionSelectionSchema.parse({ providerId, model, reasoningLevel, serviceTier });
      for (const key of Object.keys(selection) as (keyof ExecutionSelection)[]) if (selection[key] === undefined) delete selection[key];
      if (attachments && ownerAttachments) throw new Error(`${REJECTED_PREFIX}Send either source attachments or owner attachments, not both`);
      const result = await startWork(machine, prompt, title, selection, routing, requestId, { ...(projectId ? { projectId } : {}), ...(projectName ? { projectName } : {}), ...(workspace ? { workspace } : {}) }, { source: attachments ?? [], owner: ownerAttachments ?? [] });
      announceChange();
      return result;
    },
    route_preview: async ({ machine, routing, projectId, projectName, workspace, attachments, ...selection }) => routePreview(machine, selection, routing, { ...(projectId ? { projectId } : {}), ...(projectName ? { projectName } : {}), ...(workspace ? { workspace } : {}) }, (attachments?.length ?? 0) > 0),
    work_attachments_put: async (input) => {
      refuseIfMisconfigured();
      let destination: string;
      try { destination = await resolveDestinationProject({ ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.projectName ? { projectName: input.projectName } : {}) }); }
      catch (cause) { throw new Error(`${REJECTED_PREFIX}${message(cause)}`); }
      try { return { projectId: destination, attachments: await putAttachments(destination, input.files.map(({ contentBase64, ...file }) => ({ ...file, bytes: Buffer.from(contentBase64, "base64") })), input.requestId) }; }
      catch (cause) { throw cause instanceof PreDispatchRejection ? new Error(`${REJECTED_PREFIX}${cause.message}`) : cause; }
    },
    snapshot_get: () => buildSnapshot({ authenticated: true }),
    work_receipt: ({ requestId }) => {
      const row = requestDb.prepare("SELECT kind, result FROM fleet_request_receipts WHERE id = ?").get(requestId) as { kind: string; result: string | null } | undefined;
      if (!row || row.kind !== "work") return { state: "missing" as const, result: null };
      const status = (requestDb.prepare("SELECT status FROM fleet_request_receipts WHERE id = ?").get(requestId) as { status: string }).status;
      if ((status === "rejected" || status === "unavailable") && row.result) {
        const detail = z.object({ message: z.string() }).safeParse(JSON.parse(row.result));
        return { state: "missing" as const, result: null, notStarted: { reason: status as "rejected" | "unavailable", message: detail.success ? detail.data.message : status } };
      }
      return row.result ? { state: "completed" as const, result: workResultSchema.parse(JSON.parse(row.result)) } : { state: "unknown" as const, result: null };
    },
    control_deliver: (request) => deliverControl(request),
    control_receipt: ({ id, remoteThreadId }) => {
      const row = requestDb.prepare("SELECT kind, result FROM fleet_request_receipts WHERE id = ?").get(id) as { kind: string; result: string | null } | undefined;
      if (!row?.kind.startsWith("control:") || (remoteThreadId && row.kind !== `control:${remoteThreadId}`)) return { state: "unavailable" as const, remoteRequestId: id, message: "No receipt for this owner thread" };
      return row?.result ? controlResultSchema.parse(JSON.parse(row.result)) : { state: row ? "unknown" as const : "unavailable" as const, remoteRequestId: id, message: row ? "The owner has no final receipt; do not resend automatically" : "No owner receipt exists" };
    },
    thread_events_get: async (input) => {
      const events = await bb.sdk.threads.events.list(input as Parameters<typeof bb.sdk.threads.events.list>[0]);
      if (utf8Length(JSON.stringify(events)) > 1_500_000) throw new Error("The event page exceeds the direct transport limit; inspect large output on the owner or request a smaller page");
      return events;
    },
    thread_target_get: ({ threadId }) => ownerThreadTarget(threadId),
    thread_answer_get: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const interactions = await bb.sdk.threads.interactions.list({ threadId });
      const state = threadState({ ...thread, hasPendingInteraction: interactions.length > 0 });
      const result = isSettled(state) ? await bb.sdk.threads.output({ threadId }) : null;
      const output = truncateUtf8(result?.output ?? "", OUTPUT_MAX_BYTES);
      return { machine: machineKey, threadId, url: await localThreadUrl(threadId, thread.projectId), state, output: output.text, truncated: output.truncated, publishedAt: Date.now() };
    },
    thread_tell: async ({ machine, threadId, message: text, requestId = randomUUID() }) => {
      refuseIfOff("F06");
      const claim = claimRequest(requestId, "tell", { machine, threadId, message: text });
      if (claim.existing) {
        const earlier = claim.result === null ? null : tellResultSchema.safeParse(JSON.parse(claim.result));
        if (earlier === null || !earlier.success) throw new Error("This message may already have been sent; read the thread before sending it again");
        return earlier.data;
      }
      try {
        const sent = await tell({ kind: "tell", machine, threadId, message: text, messageFile: null, wait: false, timeoutMs: 30_000, json: false }, {} as PluginCliContext, new AbortController().signal);
        const result = tellResultSchema.parse({ requestId, machine, threadId, delivered: sent.delivered, delivery: sent.delivery, messageId: sent.messageId ?? null, url: sent.url ?? null, ...("note" in sent && sent.note ? { note: sent.note } : {}) });
        recordRequest(requestId, result);
        announceChange();
        return result;
      } catch (cause) {
        const nothingSent = cause instanceof RelayError && (cause.code === "unavailable" || cause.code === "private_output" || cause.code === "not_found");
        recordRequest(requestId, { error: message(cause) }, nothingSent ? "unavailable" : "unknown");
        throw cause;
      }
    },
    thread_output_get: async ({ machine, threadId }) => { refuseIfOff("F06"); return answerSchema.parse(await output({ kind: "output", machine, threadId, json: false })); },
    receipt_result: async ({ id }) => {
      try {
        const found = await result({ kind: "result", commandId: id, wait: false, timeoutMs: 2_000, json: false }, new AbortController().signal) as Answer & { commandId?: string | null };
        return { state: isSettled(threadStateSchema.parse(found.state)) ? "ready" as const : "pending" as const, commandId: found.commandId ?? null, threadId: found.threadId, url: found.url, answer: answerSchema.parse(found), message: null };
      } catch (cause) {
        const err = cause instanceof RelayError ? cause : new RelayError(message(cause));
        return { state: err.code === "not_ready" || err.code === "timeout" || err.code === "needs_you" ? "pending" as const : "failed" as const, commandId: err.extra.commandId ?? null, threadId: err.extra.threadId ?? null, url: err.extra.url ?? null, answer: null, message: err.message };
      }
    },
    receipts_list: () => {
      const rows = requestDb.prepare("SELECT id, kind, status, result, updated_at FROM fleet_request_receipts WHERE kind IN ('work', 'tell') AND updated_at > ? ORDER BY updated_at DESC, rowid DESC LIMIT 30").all(Date.now() - 7 * 24 * 3_600_000) as { id: string; kind: string; status: string; result: string | null; updated_at: number }[];
      return rows.map((row): SentReceipt => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(row.result ?? "{}") as Record<string, unknown>; } catch { parsed = {}; }
        const route = (parsed.route ?? {}) as { machine?: unknown };
        const text = (value: unknown) => (typeof value === "string" ? value : null);
        return {
          id: row.id, kind: row.kind === "tell" ? "tell" : "ask", status: row.status,
          machine: row.kind === "tell" ? text(parsed.machine) : text(route.machine), threadId: text(parsed.threadId), url: text(parsed.url),
          commandId: text(parsed.commandId), delivery: text(parsed.delivery) ?? text(parsed.outcome), updatedAt: row.updated_at,
        };
      });
    },
    command_get: async ({ commandId }) => {
      const db = needBrain();
      const { serverId } = await me();
      const row = (await db.query("SELECT status, target_host_id, thread_id, thread_url, error FROM fleet_commands WHERE id = ? AND from_server = ?", [commandId, serverId]))[0];
      if (!row) return { status: "unknown" as const, machine: null, threadId: null, url: null, error: "No command receipt exists for this sender" };
      const status: "pending" | "starting" | "started" | "failed" | "unknown" = row.status === "pending" || row.status === "starting" || row.status === "started" || row.status === "failed" ? row.status : "unknown";
      return { status, machine: row.target_host_id ? String(row.target_host_id) : null, threadId: row.thread_id ? String(row.thread_id) : null, url: row.thread_url ? String(row.thread_url) : null, error: row.error ? String(row.error) : null };
    },
    mirror_open: async (input) => {
      if (mirror === null || !mirrorProvider) throw new Error("The Fleet mirror is not available on this machine");
      if (directId === null || canonicalMachine(input.machine) !== directId) return mirror.open(input);
      const firstOwnerLookup = directOwner === null && !remote.some((owner) => owner.machineKey === directId);
      const refreshing = refreshDirectOwner();
      try { return await mirror.open(input); }
      catch (cause) {
        // On a cold plugin start there may be no owner snapshot yet. A saved
        // copy can already open; only an unknown owner's first open waits.
        if (!firstOwnerLookup) throw cause;
        await refreshing;
        if (directOwner === null) throw cause;
        return mirror.open(input);
      }
    },
  });

  // ---------- finite owner operations (automation, usage, attention) ----------

  type FleetMachine = string;

  /** Only an authenticated fresh owner snapshot: this server's own, or the always-on Mac's over its SSH alias. */
  async function authenticatedSnapshot(machine: FleetMachine): Promise<Snapshot | null> {
    if (machine === machineKey) return buildSnapshot({ authenticated: true });
    if (machine !== directId || sshDirect === null) return null;
    await refreshDirectOwner();
    const fresh = directOwner !== null && directOwner.machineKey === directId && Math.abs(Date.now() - directOwner.publishedAt) <= 10_000;
    return fresh ? directOwner : null;
  }

  let readUpdateIntent: (intentId: string) => unknown = () => null;
  const drain = createOwnerUpdateDrain(bb, {
    identity: async () => ({ ownerServerId: (await me()).serverId, hostId: await provenLocalHostId() }),
    ...(() => { const gate = coreDrainGate(bb.sdk.system as unknown as CoreDrainSdk); return gate ? { coreGate: gate } : {}; })(),
    readHelperIntent: async (intentId) => readUpdateIntent(intentId),
  });
  bb.rpc.register(updateDrainRpcContract, drain.handlers);

  const updates = createOwnerUpdates({
    bb,
    machineKey,
    machines: () => machineOrder(profile),
    drain: {
      begin: (input) => drain.handlers.update_drain_begin(input),
      arm: (input) => drain.handlers.update_drain_arm_helper(input),
      cancel: (input) => drain.handlers.update_drain_cancel(input),
    },
    identity: async () => ({ serverId: (await me()).serverId, hostId: await provenLocalHostId() }),
    policy: () => updatePolicy,
    setPolicy: async (next) => { updatePolicy = policyFromSettings(await settings.experimental_set(policyToSettings(next))); return updatePolicy; },
    callOwner: (machine, method, input, mutation) => {
      const ssh = sshDirect;
      if (machine !== directId || ssh === null) return null;
      return (async () => ((await authenticatedDirectOwner(directId)) === null ? { ok: false as const, kind: "unavailable" as const, message: "no-authenticated-owner-route" } : ssh.call("fleet", method, input, mutation)))();
    },
  });
  readUpdateIntent = (intentId) => updates.readIntent(intentId);
  bb.rpc.register(updatesRpcContract, guardPicked(guardPicked(updates.handlers, "F26", ["update_dispatch", "provider_update_dispatch"]), "F78", ["updates_policy_set"]));

  // ---------- owner detail: routes, binding proof, editor links (F18, F23, F25, F27) ----------

  const hostIdentity = bb.hosts.experimental_client({ contract: hostIdentityContract });
  let sshLastOkAt: number | null = null;

  async function hostBinding(machine: FleetMachine) {
    const owner = await authenticatedSnapshot(machine);
    const { hosts } = await localHosts();
    const candidates = await Promise.all(hosts.filter((host) => host.status === "connected").map(async (host) => {
      try { return { hostId: host.id, hardwareId: (await hostIdentity.call("host_identity_get", null, { hostId: host.id, timeoutMs: 15_000 })).hardwareId, error: null }; }
      catch (cause) { return { hostId: host.id, hardwareId: null, error: message(cause).slice(0, 200) }; }
    }));
    return bindingVerdict({ machine, ownerServerId: owner?.serverId ?? null, ownerHardwareId: owner?.capabilities?.hardwareId ?? null, candidates });
  }

  async function ownerDetail(machine: FleetMachine): Promise<OwnerDetail> {
    const self = machine === machineKey;
    const owner = self ? await buildSnapshot({ authenticated: true }) : await authenticatedSnapshot(machine);
    const broker = remote.find((snapshot) => snapshot.machineKey === machine) ?? null;
    const brokerHealthy = turso !== null && config.joinFleet && publishError === null && lastSuccessfulSyncAt !== null;
    const routes: OwnerDetail["routes"] = self
      ? [{ kind: "self", state: "healthy", detail: null, lastOkAt: Date.now() }]
      : [
          { kind: "ssh", state: machine === directId && sshDirect !== null ? (owner ? "healthy" : "unavailable") : "unconfigured", detail: machine === directId ? (owner ? `${directAlias} alias, authenticated snapshot` : directOwnerError) : "No SSH alias for this machine", lastOkAt: machine === directId ? sshLastOkAt : null },
          { kind: "broker", state: turso === null || !config.joinFleet ? "unconfigured" : broker && brokerHealthy && Date.now() - broker.publishedAt < 3 * 60_000 ? "healthy" : "unavailable", detail: publishError ?? pollError, lastOkAt: broker?.publishedAt ?? null },
        ];
    const url = owner?.url ?? broker?.url ?? null;
    if (url) routes.push({ kind: "connect", state: "healthy", detail: url, lastOkAt: null });
    const activeRoute = self ? "self" : owner ? "ssh" : routes.some((route) => route.kind === "broker" && route.state === "healthy") ? "broker" : "none";
    const editorLinks = !self && machine === directId && directConfigured && owner ? (owner.projects ?? []).filter((project) => project.path).map((project) => ({ projectId: project.id, name: project.name, url: remoteEditorUrl({ alias: directAlias, absolutePath: project.path! }) })).filter((link): link is typeof link & { url: string } => link.url !== null) : [];
    return {
      machine,
      owner: owner ? { serverId: owner.serverId, hostId: owner.ownerHostId ?? null, url: owner.url, appVersion: owner.appVersion ?? null, publishedAt: owner.publishedAt } : null,
      routes,
      activeRoute,
      capabilities: owner?.capabilities ?? null,
      providers: owner?.providers ?? broker?.providers ?? null,
      mcp: owner?.mcp ?? broker?.mcp ?? null,
      editorLinks,
      binding: await hostBinding(machine),
      projects: (owner?.projects ?? []).slice(0, 200).map((project) => ({ id: project.id, name: project.name, path: project.path ?? null })),
      terminal: { sshAlias: !self && machine === directId && directConfigured ? directAlias : null, sshVerified: owner !== null, localHostId: await provenLocalHostId().catch(() => null) },
    };
  }

  async function ownerProjectTarget(machine: FleetMachine) {
    if (machine === machineKey) {
      const hostId = await provenLocalHostId().catch(() => null);
      if (hostId === null) throw new Error("This Mac's own host is not proven by its daemon, so a project cannot be created on it from here");
      return { serverId: (await me()).serverId, machineKey: machine, hostId, projectId: null, environmentId: null };
    }
    const owner = directId !== null && machine === directId ? await authenticatedDirectOwner(directId) : null;
    if (owner === null || !owner.ownerHostId) throw new Error(`no-authenticated-owner-route: ${machine}`);
    return { serverId: owner.serverId, machineKey: machine, hostId: owner.ownerHostId, projectId: null, environmentId: null };
  }

  bb.rpc.register(ownerDetailRpcContract, {
    owner_detail_get: async ({ machine }) => {
      const detail = await reads.run(`owner_detail:${machine}`, OWNER_DETAIL_TTL_MS, () => ownerDetail(machine));
      // The terminal opens only from a verified route, so with F18 off the detail carries none (no RPC opens it).
      return pickedOff(loadProfile().profile, "F18") ? { ...detail, terminal: { sshAlias: null, sshVerified: false, localHostId: null } } : detail;
    },
    host_binding_get: ({ machine }) => hostBinding(machine),
    owner_project_target_get: ({ machine }) => ownerProjectTarget(machine),
    mcp_enable: async ({ enabled }) => {
      refuseIfOff("F07");
      if (enabled) await bb.sdk.plugins.enable({ pluginId: "bb--mcp" } as never);
      else await bb.sdk.plugins.disable({ pluginId: "bb--mcp" } as never);
      return (await mcpState((await me()).url)) ?? { installed: false, enabled: false, endpoint: null };
    },
  });

  /** This server's own host, proven by its daemon reporting this machine's hardware id (no first-host fallback). */
  let provenHost: { at: number; hostId: string | null } | null = null;
  let provenRefresh: Promise<string | null> | null = null;
  async function proveLocalHost(): Promise<string | null> {
    const own = (await hostCapabilities())?.hardwareId ?? null;
    let hostId: string | null = null;
    if (own !== null) {
      const { hosts } = await localHosts();
      const answers = await Promise.all(hosts.filter((entry) => entry.status === "connected").map(async (host) => {
        try { return (await hostIdentity.call("host_identity_get", null, { hostId: host.id, timeoutMs: 5_000 })).hardwareId === own ? host.id : null; }
        catch { return null; }
      }));
      const matches = answers.filter((id): id is string => id !== null);
      hostId = matches.length === 1 ? matches[0]! : null;
    }
    provenHost = { at: Date.now(), hostId };
    return hostId;
  }
  /** Cached proof, refreshed in the background so snapshots never wait on slow daemons; null until proven. */
  async function provenLocalHostId(): Promise<string | null> {
    if (provenHost && Date.now() - provenHost.at < 5 * 60_000) return provenHost.hostId;
    provenRefresh ??= proveLocalHost().finally(() => { provenRefresh = null; });
    if (provenHost) return provenHost.hostId;
    return provenRefresh;
  }

  const ownerProject = createOwnerProject(bb, {
    restricted: (key) => isRestricted(profile, key),
    identity: async () => ({ serverId: (await me()).serverId, machineKey, hostId: await provenLocalHostId() }),
    callOwner: async (target, method, input, mutation) => {
      const ssh = sshDirect;
      if (target.machineKey !== directId || ssh === null) return { ok: false, kind: "unavailable", message: "no-authenticated-owner-route" };
      const owner = await authenticatedDirectOwner(directId);
      if (owner === null || owner.serverId !== target.serverId || owner.ownerHostId !== target.hostId) return { ok: false, kind: "unavailable", message: "no-authenticated-owner-route" };
      return ssh.call("fleet", method, input, mutation);
    },
  });
  bb.rpc.register(ownerProjectContract, guardMutations(guardPicked(ownerProject.handlers, "F65", ["project_prepare"]), ["project_prepare", "transfer_manifest_apply"]));

  async function localTransferCheckout(projectId: string): Promise<string> {
    const hostId = await provenLocalHostId();
    if (hostId === null) throw new Error("This server's own host is not proven by its daemon, so no checkout is read");
    const projects = (await bb.sdk.projects.list({ includePersonal: false })) as unknown as { id: string; sources?: { hostId: string; path: string }[] }[];
    const source = projects.find((project) => project.id === projectId)?.sources?.find((entry) => entry.hostId === hostId);
    if (!source) throw new Error("This project has no checkout on this Mac");
    return source.path;
  }
  bb.rpc.register(transferRpcContract, {
    transfer_candidates: async ({ projectId }) => { refuseIfOff("F29"); return listTransferCandidates(await localTransferCheckout(projectId)); },
    transfer_manifest_build: async ({ projectId, paths }) => { refuseIfOff("F29"); refuseIfMisconfigured(); return buildTransferManifest(await localTransferCheckout(projectId), paths); },
    owner_thread_target: async ({ machine, threadId }) => {
      if (machine === machineKey) return ownerThreadTarget(threadId);
      if (machine !== directId || (await authenticatedDirectOwner(directId)) === null) throw new Error("no-authenticated-owner-route");
      return directThreadTarget({ targetServer: directOwner!.serverId, remoteThreadId: threadId });
    },
  });

  const ownerBrowser = createOwnerBrowser({ bb, hostId: () => provenLocalHostId(), controllerLabel: "Fleet takeover" });
  bb.rpc.register(browserRpcContract, guardPicked(ownerBrowser.handlers, "F22", Object.keys(ownerBrowser.handlers) as (keyof typeof ownerBrowser.handlers)[]));
  bb.rpc.register(browserForwardContract, {
    browser_forward: async ({ machine, call }) => {
      refuseIfOff("F22");
      if (machine === machineKey) {
        const handler = ownerBrowser.handlers[call.method] as (input: unknown) => Promise<unknown> | unknown;
        return await handler(call.input) as never;
      }
      const ssh = sshDirect;
      if (machine !== directId || ssh === null || (await authenticatedDirectOwner(directId)) === null) throw new Error("no-authenticated-owner-route");
      const mutation = call.method === "owner_browser_open" || call.method === "owner_browser_input";
      const outcome = await ssh.call("fleet", call.method, call.input, mutation);
      if (outcome.ok) return outcome.result as never;
      if (mutation && "requestId" in call.input) return { requestId: call.input.requestId, method: call.method, state: outcome.kind === "unavailable" ? "unavailable" : outcome.kind === "refused" ? "refused" : "unknown", result: null, message: outcome.message } as never;
      throw new Error(`${outcome.kind}: ${outcome.message}`);
    },
  });

  const simulators = createSimulators();
  bb.rpc.register(simulatorRpcContract, guardPicked(simulators.handlers, "F21", Object.keys(simulators.handlers) as (keyof typeof simulators.handlers)[]));
  bb.rpc.register(simulatorForwardContract, {
    simulator_forward: async ({ machine, call }) => {
      refuseIfOff("F21");
      if (machine === machineKey) {
        if (call.method === "simulator_list") return simulators.handlers.simulator_list();
        if (call.method === "simulator_frame") return simulators.handlers.simulator_frame(call.input);
        return simulators.handlers.simulator_action(call.input);
      }
      const ssh = sshDirect;
      if (machine !== directId || ssh === null || (await authenticatedDirectOwner(directId)) === null) throw new Error("no-authenticated-owner-route");
      const outcome = await ssh.call("fleet", call.method, call.input, call.method === "simulator_action");
      if (!outcome.ok) throw new Error(`${outcome.kind}: ${outcome.message}`);
      return outcome.result as never;
    },
  });

  const workspace = createOwnerWorkspace(bb, {
    restricted: (key) => isRestricted(profile, key),
    identity: async () => ({ serverId: (await me()).serverId, machineKey }),
    callOwner: async (target, method, input, mutation) => {
      const ssh = sshDirect;
      if (target.machineKey !== directId || ssh === null) return { ok: false, kind: "unavailable", message: "no-authenticated-owner-route" };
      const owner = await authenticatedDirectOwner(directId);
      if (owner === null || owner.serverId !== target.serverId) return { ok: false, kind: "unavailable", message: "no-authenticated-owner-route" };
      return ssh.call("fleet", method, input, mutation);
    },
  });
  bb.rpc.register(ownerWorkspaceContract, guardMutations(workspace.handlers, ["owner_file_write", "context_bundle_import", "interaction_respond"]));

  const mirrorWorkspace = createMirrorWorkspace({
    copyOwner: async (localThreadId) => (mirror === null ? null : mirror.copyOwner(localThreadId)),
    local: async () => ({ serverId: (await me()).serverId, machineKey }),
    ownerTarget: async (copy) => {
      if (copy.serverId !== (await me()).serverId && (copy.machine !== directId || (await authenticatedDirectOwner(directId))?.serverId !== copy.serverId)) throw new Error("no-authenticated-owner-route");
      return directThreadTarget({ targetServer: copy.serverId, remoteThreadId: copy.remoteThreadId });
    },
    ownerEditor: async (copy, target) => {
      if (copy.machine !== directId || target.machineKey !== directId) return { reason: `only ${directLabel} threads open in a remote editor` };
      if (alwaysOnId !== null && machineKey === alwaysOnId) return { reason: `this Mac is ${profileMachineLabel(profile, machineKey)}, so the folder is already local` };
      if (!directConfigured) return { reason: `this Mac has no ${directAlias || "SSH"} alias for ${directLabel}` };
      const { rootPath } = await workspace.handlers.owner_file_stat({ target, path: ".", preview: false });
      const url = remoteEditorUrl({ alias: directAlias, absolutePath: rootPath });
      return url === null ? { reason: `the folder ${rootPath} cannot be opened as an editor link` } : { path: rootPath, url };
    },
    ownerLinks: async (_copy, target) => {
      const own = await me();
      if (target.serverId === own.serverId) return { ownerUrl: own.url, ownerThreadUrl: target.threadId ? await localThreadUrl(target.threadId, target.projectId) : null };
      const owner = directOwner?.serverId === target.serverId ? directOwner : null;
      return { ownerUrl: owner?.url ?? null, ownerThreadUrl: owner?.threads.find((thread) => thread.id === target.threadId)?.url ?? null };
    },
  });
  bb.rpc.register(mirrorWorkspaceContract, mirrorWorkspace.handlers);

  if (isFleetMachine(profile, machineKey)) {
    const operations = createOwnerOperations({
      bb,
      localMachine: machineKey,
      localOwner: async () => ({ serverId: (await me()).serverId, hostId: (await localHosts()).serverHost?.id ?? null }),
      snapshot: authenticatedSnapshot,
      transport: (machine) => (machine === directId ? sshDirect : null),
    });
    bb.rpc.register(operationsRpcContract, operations.handlers);
  } else {
    bb.log.warn(`Owner operations are off: machine key ${machineKey} is not one of ${machineOrder(profile).join(", ")}`);
  }

  // ---------- two-way relay: asking from this machine ----------

  /** Remote snapshots are filled by the sync loop; right after a reload, read them once. */
  async function ensureRemote(): Promise<void> {
    if (remote.length > 0 || turso === null || !config.joinFleet) return;
    try {
      await sync();
    } catch (cause) {
      publishError = message(cause);
    }
  }

  function needBrain(): TursoClient {
    if (turso === null) throw new RelayError("This machine has no brain connection, so it cannot reach another machine");
    if (!config.joinFleet) throw new RelayError('Switch on "Join the fleet" in Fleet settings first');
    return turso;
  }

  /** The machine's own bb, which must run the two-way Fleet for anything that reads answers back. */
  function relayOwner(machine: string, serverId: string): Snapshot {
    const owner = remote.find((s) => s.machineKey === machine && s.serverId !== serverId);
    if (owner === undefined) {
      const known = [...new Set([machineKey, ...remote.map((s) => s.machineKey)])].join(", ");
      throw new RelayError(`${machine} has not joined the fleet (known machines: ${known})`);
    }
    if (!(owner.features ?? []).includes("outputs")) {
      throw new RelayError(
        `${machine} runs a Fleet from before two-way messaging, so its answers cannot come back yet. ` +
          `Upgrade Fleet there, or use bb fleet start ${machine} ...`,
      );
    }
    return owner;
  }

  /** Same choice startWork makes: this bb runs it, or the machine's own bb does. */
  async function routeFor(machine: string): Promise<{ local: true } | { local: false; owner: Snapshot }> {
    await ensureRemote();
    const { serverId } = await me();
    const { hosts, keyOf } = await localHosts();
    const owner = remote.find((s) => s.machineKey === machine && s.serverId !== serverId);
    const ownerFresh = owner !== undefined && Date.now() - owner.publishedAt < 3 * 60_000;
    if (machine === machineKey || (!ownerFresh && hosts.some((h) => keyOf(h) === machine))) return { local: true };
    needBrain();
    return { local: false, owner: relayOwner(machine, serverId) };
  }

  /** For a thread id: this bb if it knows the thread, else the machine's own bb. */
  async function routeForThread(machine: string, threadId: string): Promise<{ local: ShownThread } | { local: null; owner: Snapshot; direct: boolean }> {
    const shown = await showThread(threadId);
    if (shown !== null) return { local: shown };
    if (machine === machineKey) throw new RelayError(`This bb (${machineKey}) has no thread ${threadId}`);
    const ssh = isFleetMachine(profile, machine) ? await authenticatedDirectOwner(machine) : null;
    if (ssh !== null) return { local: null, owner: ssh, direct: true };
    await ensureRemote();
    needBrain();
    const { serverId } = await me();
    return { local: null, owner: relayOwner(machine, serverId), direct: false };
  }

  /** The independent owner reached over its authenticated SSH alias, preferred over the broker for reads and controls. */
  async function authenticatedDirectOwner(machine: FleetMachine | null): Promise<Snapshot | null> {
    if (machine !== directId || sshDirect === null) return null;
    await refreshDirectOwner();
    return directOwner !== null && directOwner.machineKey === directId && Math.abs(Date.now() - directOwner.publishedAt) <= 60_000 ? directOwner : null;
  }

  async function directAnswer(machine: string, threadId: string): Promise<Answer> {
    const observed = answerSchema.parse(await directRpc("thread_answer_get", { threadId }));
    return { ...observed, machine };
  }

  /** Wait on the direct owner until a turn completes after `afterSeq`, then read its answer. */
  async function waitDirectAnswer(machine: string, threadId: string, afterSeq: number, deadline: number, signal: AbortSignal): Promise<Answer | "timeout"> {
    let cursor = afterSeq;
    let completed = false;
    return pollUntil<Answer>(deadline, signal, async () => {
      for (let page = 0; page < 20 && !completed; page += 1) {
        const events = z.array(z.object({ seq: z.number(), type: z.string() }).passthrough()).parse(await directRpc("thread_events_get", { threadId, afterSeq: String(cursor), order: "asc", limit: "100" }));
        if (events.length === 0) break;
        cursor = events.at(-1)!.seq;
        completed = events.some((event) => event.type === "turn/completed");
      }
      const answer = await directAnswer(machine, threadId);
      if (answer.state === "needs-you") throw new RelayError(`The ${machine} thread is waiting for an answer or an approval: ${answer.url ?? threadId}`, 1, "needs_you", { threadId, url: answer.url });
      return completed && isSettled(threadStateSchema.parse(answer.state)) ? answer : undefined;
    });
  }

  async function directLatestSeq(threadId: string): Promise<number> {
    const events = z.array(z.object({ seq: z.number() }).passthrough()).parse(await directRpc("thread_events_get", { threadId, order: "desc", limit: "1" }));
    return events[0]?.seq ?? 0;
  }

  async function localThreadUrl(threadId: string, projectId: string): Promise<string | null> {
    const { url } = await me();
    const projects = (await bb.sdk.projects.list({ includePersonal: true })) as unknown as { id: string; kind: string }[];
    return threadUrl(url, projectId, threadId, projects.find((p) => p.id === projectId)?.kind === "personal");
  }

  async function remoteThreadUrl(db: TursoClient, owner: Snapshot, threadId: string): Promise<string | null> {
    const listed = owner.threads.find((t) => t.id === threadId)?.url;
    if (listed) return listed;
    const rows = await db.query(
      `SELECT thread_url FROM fleet_commands WHERE target_server = ? AND thread_id = ? AND thread_url IS NOT NULL LIMIT 1`,
      [owner.serverId, threadId],
    );
    return rows[0]?.thread_url ? String(rows[0].thread_url) : null;
  }

  /** The thread's state in its machine's latest snapshot, when that snapshot is newer than `after` (target clock). */
  function snapshotState(serverIdOf: string, threadId: string, after: number): ThreadState | null {
    const snap = remote.find((s) => s.serverId === serverIdOf);
    if (snap === undefined || snap.publishedAt <= after) return null;
    return snap.threads.find((t) => t.id === threadId)?.state ?? null;
  }

  /** Poll `step` (3s, then 6s after two minutes) until it returns a value or the deadline passes. */
  async function pollUntil<T>(deadline: number, signal: AbortSignal, step: () => Promise<T | undefined>): Promise<T | "timeout"> {
    const started = Date.now();
    for (;;) {
      if (signal.aborted) throw new RelayError("Cancelled", 130, "cancelled");
      const value = await step();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) return "timeout";
      await sleep(Math.min(Date.now() - started < 120_000 ? 3000 : 6000, Math.max(0, deadline - Date.now())), signal);
    }
  }

  function answerFromRow(machine: string, threadId: string, url: string | null, row: Row): Answer {
    if (row.state === "private") throw new RelayError(`This thread uses private native Fleet delivery; its answer is available in the native mirror or on its owner, not legacy broker output: ${url ?? threadId}`, 1, "private_output", { threadId, url });
    return {
      machine,
      threadId,
      url,
      state: String(row.state ?? "idle"),
      output: String(row.output ?? ""),
      truncated: Number(row.truncated ?? 0) === 1,
      publishedAt: row.updated_at === null || row.updated_at === undefined ? null : Number(row.updated_at),
    };
  }

  async function localAnswer(machine: string, threadId: string, projectId: string, state: string): Promise<Answer> {
    const full = await threadOutput(threadId);
    const cut = truncateUtf8(full, OUTPUT_MAX_BYTES);
    return {
      machine,
      threadId,
      url: await localThreadUrl(threadId, projectId),
      state,
      output: cut.text,
      truncated: cut.truncated,
      publishedAt: null,
    };
  }

  /** Text for --message-file, read on the machine that ran the command (multi-machine safe). */
  async function readMessageFile(path: string, ctx: PluginCliContext): Promise<string> {
    if (path === "-") {
      throw new RelayError(
        "--message-file - (stdin) cannot work here: bb passes piped stdin to plugin commands only as one line under 16 KB. " +
          "Save the text to a file and pass --message-file <path>.",
      );
    }
    let hostId: string | null = null;
    if (ctx.threadId) {
      try {
        hostId = (await showThread(ctx.threadId))?.environment?.hostId ?? null;
      } catch {
        hostId = null;
      }
    }
    const { serverHost } = await localHosts();
    const base = ctx.cwd && isAbsolute(ctx.cwd) ? ctx.cwd : homedir();
    const full = isAbsolute(path) ? path : resolvePath(base, path);
    const tooBig = `${path} is larger than 256 KB; split it, or send a shorter extract`;
    if (hostId === null || hostId === serverHost?.id) {
      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        throw new RelayError(`Cannot read --message-file ${full}`);
      }
      if (size > MESSAGE_MAX_BYTES) throw new RelayError(tooBig);
      return readFileSync(full, "utf8");
    }
    // The command ran in a thread on another machine enrolled in this bb: read the file there.
    const read = await bbJson<{ content?: unknown; contentEncoding?: unknown; sizeBytes?: unknown }>(["file", "read", full, "--host", hostId], {
      timeoutMs: 60_000,
    });
    if (Number(read.sizeBytes ?? 0) > MESSAGE_MAX_BYTES) throw new RelayError(tooBig);
    if (read.contentEncoding !== "utf8" || typeof read.content !== "string") throw new RelayError(`${full} is not a text file`);
    return read.content;
  }

  async function messageText(words: string, file: string | null, ctx: PluginCliContext): Promise<string> {
    const text = composeMessage(words, file === null ? null : await readMessageFile(file, ctx));
    if (text.trim() === "") throw new RelayError("The message is empty");
    if (utf8Length(text) > MESSAGE_MAX_BYTES) throw new RelayError("The message is larger than 256 KB; split it, or send a shorter extract");
    return text;
  }

  /** Wait for the answer of the thread a fleet command started on another machine. */
  async function commandAnswer(commandId: string, wait: boolean, deadline: number, signal: AbortSignal): Promise<Answer> {
    const db = needBrain();
    await ensureSchema();
    await ensureRemote();
    let last: Row | undefined;
    const result = await pollUntil<Answer>(wait ? deadline : 0, signal, async () => {
      const [cmdRows, outRows] = await db.batch([
        {
          sql: `SELECT target_server, target_host_id, status, thread_id, thread_url, error, updated_at, prompt FROM fleet_commands WHERE id = ?`,
          args: [commandId],
        },
        {
          sql: `SELECT o.state, o.output, o.truncated, o.updated_at FROM fleet_outputs o
                JOIN fleet_commands c ON o.server_id = c.target_server AND o.thread_id = c.thread_id
                WHERE c.id = ?`,
          args: [commandId],
        },
      ]);
      const cmd = cmdRows?.[0];
      if (cmd === undefined) throw new RelayError(`No fleet command ${commandId}`);
      last = cmd;
      const machine = String(cmd.target_host_id ?? cmd.target_server);
      const threadId = cmd.thread_id ? String(cmd.thread_id) : null;
      const url = cmd.thread_url ? String(cmd.thread_url) : null;
      if (cmd.status === "failed") throw new RelayError(`${machine} could not start it: ${String(cmd.error ?? "unknown error")}`);
      if (cmd.status === "unknown") throw new RelayError(`The ${machine} start outcome is unknown; inspect its owner before any manual replacement. Do not resend automatically.`, 1, "unknown", { commandId, threadId, url });
      if (cmd.prompt === SEALED_COMMAND_PLACEHOLDER) throw new RelayError(`Command ${commandId} was accepted for private execution. Read its answer through the native Fleet mirror or on the owner; legacy broker output is disabled. Do not submit the job again.`, 1, "private_output", { commandId, threadId, url });
      const out = outRows?.[0];
      if (threadId !== null && out !== undefined) return answerFromRow(machine, threadId, url, out);
      if (threadId !== null && snapshotState(String(cmd.target_server), threadId, Number(cmd.updated_at ?? 0)) === "needs-you") {
        throw new RelayError(`The ${machine} thread is waiting for an answer or an approval: ${url ?? threadId}`, 1, "needs_you", {
          commandId,
          threadId,
          url,
        });
      }
      return undefined;
    });
    if (result !== "timeout") return result;
    const machine = String(last?.target_host_id ?? last?.target_server ?? "the machine");
    const threadId = last?.thread_id ? String(last.thread_id) : null;
    const url = last?.thread_url ? String(last.thread_url) : null;
    const where = threadId === null ? `it has not started yet (status ${String(last?.status ?? "unknown")})` : `thread ${url ?? threadId}`;
    if (!wait) {
      throw new RelayError(`No answer from ${machine} yet; ${where}. Add --wait to wait for it.`, 1, "not_ready", { commandId, threadId, url });
    }
    throw new RelayError(
      `Timed out waiting for ${machine}; ${where}. Command ${commandId}. Check again with: bb fleet result ${commandId} --wait`,
      2,
      "timeout",
      { commandId, threadId, url },
    );
  }

  async function ask(cmd: Extract<RelayCommand, { kind: "ask" }>, ctx: PluginCliContext, signal: AbortSignal) {
    const deadline = Date.now() + cmd.timeoutMs;
    const prompt = await messageText(cmd.prompt, cmd.messageFile, ctx);
    const started = await startWork(cmd.machine, prompt, undefined, cmd.execution, cmd.routing);
    if (started.outcome === "started") {
      const threadId = started.threadId ?? "";
      if (started.route.serverId !== (await me()).serverId) {
        const answer = await pollUntil<Answer>(deadline, signal, async () => {
          const observed = answerSchema.parse(await directRpc("thread_answer_get", { threadId }));
          if (observed.state === "needs-you") throw new RelayError(`${directLabel} needs an answer or approval: ${observed.url ?? threadId}`, 1, "needs_you", { threadId, url: observed.url });
          return isSettled(observed.state) ? observed : undefined;
        });
        if (answer === "timeout") throw new RelayError(`The independent ${directLabel} job is still working: ${started.url ?? threadId}. It was started; do not submit it again.`, 2, "timeout", { threadId, url: started.url });
        return { commandId: null, ...answer };
      }
      const settled = await waitLocalSettled(threadId, deadline, signal);
      if (settled === "timeout") {
        throw new RelayError(
          `Timed out after ${minutes(cmd.timeoutMs)}; thread ${started.url ?? threadId} is still working. Read it later with: bb fleet output ${cmd.machine} ${threadId}`,
          2,
          "timeout",
          { threadId, url: started.url },
        );
      }
      const shown = await showThread(threadId);
      return { commandId: null, ...(await localAnswer(cmd.machine, threadId, shown?.thread.projectId ?? "", settled)) };
    }
    const commandId = started.commandId ?? "";
    return { commandId, ...(await commandAnswer(commandId, true, deadline, signal)) };
  }

  async function tell(cmd: Extract<RelayCommand, { kind: "tell" }>, ctx: PluginCliContext, signal: AbortSignal) {
    const deadline = Date.now() + cmd.timeoutMs;
    const body = await messageText(cmd.message, cmd.messageFile, ctx);
    const route = await routeForThread(cmd.machine, cmd.threadId);
    if (route.local !== null) {
      const delivery = await tellThread(cmd.threadId, body);
      if (!cmd.wait) {
        const url = await localThreadUrl(cmd.threadId, route.local.thread.projectId);
        return { messageId: null, delivered: true, delivery, threadId: cmd.threadId, url, answer: null };
      }
      const settled = await waitLocalSettled(cmd.threadId, deadline, signal);
      if (settled === "timeout") {
        throw new RelayError(`Delivered, but timed out after ${minutes(cmd.timeoutMs)} waiting for the answer. Read it later with: bb fleet output ${cmd.machine} ${cmd.threadId}`, 2, "timeout", {
          threadId: cmd.threadId,
        });
      }
      const answer = await localAnswer(cmd.machine, cmd.threadId, route.local.thread.projectId, settled);
      return { messageId: null, delivered: true, delivery, ...answer, answer };
    }

    if (route.direct) {
      const before = await directLatestSeq(cmd.threadId);
      const request: MirrorControlRequest = { v: 1, id: sha256(`fleet-cli-tell:${randomUUID()}`), localThreadId: "fleet-cli", targetServer: route.owner.serverId, remoteThreadId: cmd.threadId, action: "send", text: body, createdAt: Date.now() };
      let delivered: MirrorControlResult;
      try { delivered = controlResultSchema.parse(await directRpc("control_deliver", request, true)); }
      catch (cause) {
        if (cause instanceof OwnerRouteError && cause.kind === "unavailable") throw new RelayError(`${cmd.machine} was not reached; nothing was sent: ${message(cause)}`, 1, "unavailable");
        throw new RelayError(`The ${cmd.machine} delivery outcome is unknown; check the thread before sending again: ${message(cause)}`, 1, "unknown", { messageId: request.id });
      }
      if (delivered.state !== "sent" && delivered.state !== "queued") throw new RelayError(`${cmd.machine} did not accept it (${delivered.state}): ${delivered.message ?? ""}`.trim(), 1, delivered.state === "unknown" ? "unknown" : "failed", { messageId: request.id });
      const url = route.owner.threads.find((t) => t.id === cmd.threadId)?.url ?? null;
      if (!cmd.wait) return { messageId: request.id, delivered: true, delivery: delivered.state, threadId: cmd.threadId, url, answer: null };
      const answer = await waitDirectAnswer(cmd.machine, cmd.threadId, before, deadline, signal);
      if (answer === "timeout") throw new RelayError(`Delivered, but timed out after ${minutes(cmd.timeoutMs)} waiting for the answer. Read it later with: bb fleet output ${cmd.machine} ${cmd.threadId}`, 2, "timeout", { messageId: request.id, url });
      return { messageId: request.id, delivered: true, delivery: delivered.state, ...answer, answer };
    }

    const db = needBrain();
    await ensureSchema();
    const owner = route.owner;
    const privacy = (await db.query("SELECT state FROM fleet_outputs WHERE server_id = ? AND thread_id = ?", [owner.serverId, cmd.threadId]))[0];
    if (privacy?.state === "private") throw new RelayError("This thread uses private native Fleet delivery; send the follow-up in its native mirror or on the owner", 1, "private_output", { threadId: cmd.threadId });
    const { serverId } = await me();
    const id = randomUUID();
    const now = Date.now();
    await db.query(
      `INSERT INTO fleet_messages (id, target_server, thread_id, body, from_server, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      [id, owner.serverId, cmd.threadId, body, serverId, now, now],
    );
    const url = await remoteThreadUrl(db, owner, cmd.threadId);
    const stale = Date.now() - owner.publishedAt > 3 * 60_000;
    // Without --wait, give the target one or two poll cycles to confirm delivery.
    const deliveredAt = await pollUntil<number>(cmd.wait ? deadline : Math.min(deadline, Date.now() + 30_000), signal, async () => {
      const row = (await db.query(`SELECT status, error, updated_at FROM fleet_messages WHERE id = ?`, [id]))[0];
      if (row === undefined) throw new RelayError(`Message ${id} disappeared from the brain`);
      if (row.status === "failed") throw new RelayError(`${cmd.machine} could not deliver it: ${String(row.error ?? "unknown error")}`, 1, "failed", { messageId: id });
      return row.status === "delivered" ? Number(row.updated_at) : undefined;
    });
    if (deliveredAt === "timeout") {
      if (!cmd.wait) {
        const note = stale ? ` ${cmd.machine} was last seen ${Math.round((Date.now() - owner.publishedAt) / 60_000)} min ago; it delivers when it wakes.` : "";
        return { messageId: id, delivered: false, delivery: "queued", threadId: cmd.threadId, url, answer: null, note };
      }
      throw new RelayError(`Timed out: ${cmd.machine} has not picked up message ${id} (is it awake?). It is still queued.`, 2, "timeout", { messageId: id });
    }
    if (!cmd.wait) return { messageId: id, delivered: true, delivery: "sent", threadId: cmd.threadId, url, answer: null };
    const answer = await pollUntil<Answer>(deadline, signal, async () => {
      const out = (
        await db.query(`SELECT state, output, truncated, updated_at FROM fleet_outputs WHERE server_id = ? AND thread_id = ? AND updated_at > ?`, [
          owner.serverId,
          cmd.threadId,
          deliveredAt,
        ])
      )[0];
      if (out !== undefined) return answerFromRow(cmd.machine, cmd.threadId, url, out);
      if (snapshotState(owner.serverId, cmd.threadId, deliveredAt) === "needs-you") {
        throw new RelayError(`The ${cmd.machine} thread is waiting for an answer or an approval: ${url ?? cmd.threadId}`, 1, "needs_you", {
          messageId: id,
          url,
        });
      }
      return undefined;
    });
    if (answer === "timeout") {
      throw new RelayError(
        `Delivered, but timed out after ${minutes(cmd.timeoutMs)} waiting for the answer. Read it later with: bb fleet output ${cmd.machine} ${cmd.threadId}`,
        2,
        "timeout",
        { messageId: id, url },
      );
    }
    return { messageId: id, delivered: true, delivery: "sent", ...answer, answer };
  }

  async function output(cmd: Extract<RelayCommand, { kind: "output" }>) {
    const route = await routeForThread(cmd.machine, cmd.threadId);
    if (route.local !== null) {
      return localAnswer(cmd.machine, cmd.threadId, route.local.thread.projectId, shownState(route.local.thread));
    }
    if (route.direct) return directAnswer(cmd.machine, cmd.threadId);
    const db = needBrain();
    await ensureSchema();
    const row = (
      await db.query(`SELECT state, output, truncated, updated_at FROM fleet_outputs WHERE server_id = ? AND thread_id = ?`, [
        route.owner.serverId,
        cmd.threadId,
      ])
    )[0];
    if (row === undefined) {
      throw new RelayError(
        `No published answer for ${cmd.threadId} on ${cmd.machine}. Fleet publishes only threads started or messaged through Fleet, once their turn is over.`,
        1,
        "not_found",
      );
    }
    return answerFromRow(cmd.machine, cmd.threadId, await remoteThreadUrl(db, route.owner, cmd.threadId), row);
  }

  async function result(cmd: Extract<RelayCommand, { kind: "result" }>, signal: AbortSignal) {
    const deadline = Date.now() + cmd.timeoutMs;
    const receipt = requestDb.prepare("SELECT kind, status, result FROM fleet_request_receipts WHERE id = ?").get(cmd.commandId) as { kind: string; status: string; result: string | null } | undefined;
    if (receipt?.kind === "work") {
      if (receipt.status !== "completed" || receipt.result === null) throw new RelayError(`Request ${cmd.commandId} was ${receipt.status === "dispatching" ? "not confirmed (outcome unknown; inspect its owner before starting another job)" : `not started (${receipt.status})`}`, 1, receipt.status === "dispatching" ? "unknown" : "not_started");
      const started = workResultSchema.parse(JSON.parse(receipt.result));
      if (started.outcome === "started" && started.threadId) {
        const { serverId } = await me();
        const threadId = started.threadId;
        if (started.route.serverId === serverId) {
          const state = cmd.wait ? await waitLocalSettled(threadId, deadline, signal) : null;
          if (state === "timeout") throw new RelayError(`Timed out after ${minutes(cmd.timeoutMs)}; thread ${threadId} is still working`, 2, "timeout", { threadId });
          const shown = await showThread(threadId);
          if (shown === null) throw new RelayError(`This bb no longer has thread ${threadId}`);
          return { commandId: null, requestId: cmd.commandId, ...(await localAnswer(started.route.machine ?? machineKey, threadId, shown.thread.projectId, state ?? shownState(shown.thread))) };
        }
        const machine = started.route.machine ?? directId ?? machineKey;
        if (isFleetMachine(profile, machine) && (await authenticatedDirectOwner(machine))?.serverId === started.route.serverId) {
          const answer = cmd.wait
            ? await pollUntil<Answer>(deadline, signal, async () => { const observed = await directAnswer(machine, threadId); if (observed.state === "needs-you") throw new RelayError(`The ${machine} thread is waiting for an answer or an approval: ${observed.url ?? threadId}`, 1, "needs_you", { threadId, url: observed.url }); return isSettled(threadStateSchema.parse(observed.state)) ? observed : undefined; })
            : await directAnswer(machine, threadId);
          if (answer === "timeout") throw new RelayError(`The ${machine} job is still working: ${started.url ?? threadId}. It was started; do not submit it again.`, 2, "timeout", { threadId, url: started.url });
          return { commandId: null, requestId: cmd.commandId, ...answer };
        }
        throw new RelayError(`Request ${cmd.commandId} started thread ${threadId} on ${machine}, which has no authenticated direct route from here; open ${started.url ?? "its owner"}.`, 1, "unavailable", { threadId, url: started.url });
      }
      if (started.commandId) return { commandId: started.commandId, requestId: cmd.commandId, ...(await commandAnswer(started.commandId, cmd.wait, deadline, signal)) };
    }
    const db = needBrain();
    const { serverId } = await me();
    const row = (await db.query(`SELECT target_server, target_host_id, thread_id FROM fleet_commands WHERE id = ?`, [cmd.commandId]))[0];
    if (row === undefined) throw new RelayError(`No fleet command ${cmd.commandId}`);
    if (String(row.target_server) === serverId && row.thread_id) {
      // Sent to this bb: read the thread directly.
      const threadId = String(row.thread_id);
      const machine = String(row.target_host_id ?? machineKey);
      let state: string = "idle";
      if (cmd.wait) {
        const settled = await waitLocalSettled(threadId, deadline, signal);
        if (settled === "timeout") throw new RelayError(`Timed out after ${minutes(cmd.timeoutMs)}; thread ${threadId} is still working`, 2, "timeout", { threadId });
        state = settled;
      }
      const shown = await showThread(threadId);
      if (shown === null) throw new RelayError(`This bb no longer has thread ${threadId}`);
      if (!cmd.wait) state = shownState(shown.thread);
      return { commandId: cmd.commandId, ...(await localAnswer(machine, threadId, shown.thread.projectId, state)) };
    }
    return { commandId: cmd.commandId, ...(await commandAnswer(cmd.commandId, cmd.wait, deadline, signal)) };
  }

  async function runRelay(argv: string[], ctx: PluginCliContext, leadingJson: boolean): Promise<PluginCliResult> {
    const parsed = parseRelayArgs(argv, profile);
    if (!parsed.ok) return { exitCode: 1, stderr: parsed.error };
    const cmd = parsed.command;
    if (cmd.kind === "help") return { exitCode: 0, stdout: relayHelp(cmd.command) };
    const json = leadingJson || cmd.json;
    const signal = ctx.signal ?? new AbortController().signal;
    try {
      if (cmd.kind === "ask") {
        const r = await ask(cmd, ctx, signal);
        return json ? { exitCode: 0, stdout: JSON.stringify({ ok: true, ...r }) } : { exitCode: 0, stdout: formatAnswer(r) };
      }
      if (cmd.kind === "tell") {
        const r = await tell(cmd, ctx, signal);
        if (json) return { exitCode: 0, stdout: JSON.stringify({ ok: true, ...r, answer: undefined }) };
        if (r.answer) return { exitCode: 0, stdout: formatAnswer(r.answer) };
        const where = r.url ?? r.threadId;
        const text = r.delivered
          ? `Delivered to ${cmd.machine} thread ${where}${r.messageId ? ` (message ${r.messageId})` : ""}.`
          : `Queued for ${cmd.machine} thread ${where} (message ${r.messageId}); not delivered yet.${"note" in r ? (r.note ?? "") : ""}`;
        return { exitCode: 0, stdout: text };
      }
      if (cmd.kind === "output") {
        const r = await output(cmd);
        return json ? { exitCode: 0, stdout: JSON.stringify({ ok: true, ...r }) } : { exitCode: 0, stdout: formatAnswer(r) };
      }
      const r = await result(cmd, signal);
      return json ? { exitCode: 0, stdout: JSON.stringify({ ok: true, ...r }) } : { exitCode: 0, stdout: formatAnswer(r) };
    } catch (cause) {
      const err = cause instanceof RelayError ? cause : new RelayError(message(cause));
      if (json) {
        return {
          exitCode: err.exitCode,
          stdout: JSON.stringify({ ok: false, error: { code: err.code, message: err.message, ...err.extra } }),
          stderr: err.message,
        };
      }
      return { exitCode: err.exitCode, stderr: err.message };
    }
  }

  function relayHelp(command: RelayCommandName): string {
    const about: Record<RelayCommandName, string> = {
      ask: "Start work on a machine, wait until its turn is over, and print the answer and the thread link. Times out (exit 2) with the command id; pick the answer up later with bb fleet result.",
      tell: "Send a follow-up or a long text (a call transcript, a conversation) into a thread on a machine. Without --wait it confirms delivery; with --wait it prints the new answer.",
      output: "Print the latest answer of a thread on a machine (published answers only for threads started or messaged through Fleet).",
      result: "Print the answer of the thread a bb fleet start created, by its command id. --wait waits for it.",
    };
    return [
      `Usage: ${RELAY_USAGE[command]}`,
      "",
      about[command],
      "--message-file <path>  Text from a file on the machine running the command (added after any typed words; max 256 KB). Stdin (-) is not supported by bb plugin commands.",
      "--timeout <duration>   e.g. 90s, 20m, 1h; default 20m, at most 60m.",
      "--json                 Machine-readable result.",
    ]
      .filter((line) => command !== "output" || !/^--(message-file|timeout)/.test(line))
      .filter((line) => command !== "result" || !/^--message-file/.test(line))
      .join("\n");
  }

  const usage = [
    "Usage:",
    "  bb fleet status [--json]                 Machines, what is running on each, and this bb's fleet settings",
    `  bb fleet start <machine> <prompt...>     Start work on ${machineOrder(profile).join(", ")} (local spawn or sent through the brain)`,
    "  bb fleet ask <machine> <prompt...>       Start work there, wait for the answer and print it [--message-file <path>] [--timeout 20m]",
    "  bb fleet tell <machine> <thread-id> <message...>  Send a follow-up or long text into a thread there [--message-file <path>] [--wait] [--timeout 20m]",
    "  bb fleet output <machine> <thread-id>    Print the latest answer of a thread there",
    "  bb fleet result <command-id|request-id>  Print the answer of the thread a fleet start created [--wait] [--timeout 20m]",
    "  bb fleet versions [--json]               bb and provider CLI versions everywhere, with available updates",
    "  bb fleet update <machine> --to <x.y.z>   Drained, staged, verified bb update on one machine",
    "  bb fleet provider-update <machine> <provider> --from <version>  Update one provider CLI from an exact version",
    "  bb fleet owner <machine> [--json]        Routes, capabilities, providers, MCP endpoint and host binding",
    "Add --json for data. Waits default to 20m and stop at 60m. Run bb fleet <command> --help for details.",
  ].join("\n");

  bb.cli.register({
    name: "fleet",
    summary: "See every machine's bb work, start work on any machine, and read its answers back",
    commands: [
      { name: "status", summary: "Show machines and their threads", usage: "bb fleet status [--json]" },
      { name: "start", summary: "Start work on a chosen machine or Auto", usage: RELAY_USAGE.ask.replace("fleet ask", "fleet start").replace(" [--timeout 20m]", "") },
      { name: "ask", summary: "Start work on a machine, wait for the answer and print it", usage: RELAY_USAGE.ask },
      {
        name: "tell",
        summary: "Send a follow-up or long text (transcript, conversation) into a thread on a machine",
        usage: RELAY_USAGE.tell,
      },
      { name: "output", summary: "Print the latest answer of a thread on a machine", usage: RELAY_USAGE.output },
      { name: "result", summary: "Print the answer of the thread a bb fleet start created", usage: RELAY_USAGE.result },
      { name: "versions", summary: "bb and provider CLI versions on every machine, with available updates", usage: "bb fleet versions [--json]" },
      { name: "update", summary: "Update bb on one machine to an exact version (drained, staged, verified)", usage: `bb fleet update <${machineOrder(profile).join("|")}> --to <x.y.z> [--json]` },
      { name: "provider-update", summary: "Update one provider CLI on one machine from an exact version", usage: `bb fleet provider-update <${machineOrder(profile).join("|")}> <provider> --from <version> [--json]` },
      { name: "owner", summary: "One machine's routes, capabilities, providers, MCP endpoint and host binding", usage: `bb fleet owner <${machineOrder(profile).join("|")}> [--json]` },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((a) => a !== "--json");
      if (command === undefined || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      if (command === "status") {
        const b = await board(false);
        if (json) return { exitCode: 0, stdout: JSON.stringify(b).slice(0, 60_000) };
        const lines = [
          `This bb: ${b.me.serverId} (${b.me.label}) · joined: ${b.me.joined ? "yes" : "no"} · broker: ${b.transport?.broker ?? "unknown"}`,
          ...(b.error ? [`Last sync error: ${b.error}`] : []),
        ];
        for (const col of b.columns) {
          lines.push(
            "",
            `${col.label} [${col.key}] owner ${col.ownerStatus ?? "unknown"}${col.local ? ` · enrolled route ${col.enrolledOnline ? "connected" : "offline"}` : ""}${col.capabilities.length ? " · declared/detected " + col.capabilities.join(", ") : ""}`,
          );
          for (const t of col.threads.slice(0, 8)) lines.push(`  ${t.state.padEnd(9)} ${t.title}`);
          if (col.threads.length === 0) lines.push("  (nothing recent)");
        }
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (command === "start") {
        const at = argv.findIndex((value) => value !== "--json");
        const parsed = parseRelayArgs(["ask", ...argv.slice(at + 1)], profile);
        if (!parsed.ok) return { exitCode: 1, stderr: parsed.error };
        if (parsed.command.kind === "help") return { exitCode: 0, stdout: RELAY_USAGE.ask.replace("fleet ask", "fleet start") };
        if (parsed.command.kind !== "ask") return { exitCode: 1, stderr: usage };
        const cmd = parsed.command;
        try {
          const prompt = await messageText(cmd.prompt, cmd.messageFile, ctx);
          const r = await startWork(cmd.machine, prompt, undefined, cmd.execution, cmd.routing);
          if (cmd.json || at > 0) return { exitCode: 0, stdout: JSON.stringify(r) };
          return {
            exitCode: 0,
            stdout: `${r.route.reason}\n` + (r.outcome === "started" ? `Started ${r.threadId}${r.url ? `\n${r.url}` : ""}\nRead the answer with: bb fleet result ${r.requestId}` : `Accepted for ${r.route.machine} (command ${r.commandId}); owner delivery is pending`),
          };
        } catch (cause) {
          return { exitCode: 1, stderr: message(cause) };
        }
      }
      if (command === "versions") {
        const matrix = await updates.matrix();
        if (json) return { exitCode: 0, stdout: JSON.stringify(matrix) };
        const lines = [`Staging: ${matrix.policy.testMachine ? `${matrix.policy.testMachine} first` : "off"} · pinned: ${matrix.policy.pinnedVersion ?? "none"}`];
        for (const row of matrix.rows) {
          const app = row.status?.app;
          lines.push(`${row.machine.padEnd(3)} ${app ? `bb ${app.current}${app.available ? ` → ${app.available} available` : " (current)"} · ${app.runningThreadCount} running${app.exactApply ? " · exact" : ""}` : `unavailable (${row.reason ?? row.status?.appError ?? "unknown"})`}`);
          for (const provider of row.status?.providers.filter((entry) => entry.installed) ?? []) lines.push(`    ${provider.displayName} ${provider.currentVersion ?? "?"}${provider.needsUpdate ? ` → ${provider.latestVersion ?? "newer"}` : ""}`);
          if (row.status?.helper.latestIntent) lines.push(`    last update ${row.status.helper.latestIntent.intentId}: ${row.status.helper.latestIntent.phase}`);
        }
        return { exitCode: 0, stdout: lines.join("\n") };
      }
      if (command === "update" || command === "provider-update" || command === "owner") {
        const machineArg = canonicalMachine(args[0] ?? "");
        if (!isFleetMachine(profile, machineArg)) return { exitCode: 1, stderr: `Name the machine: ${machineOrder(profile).join(", ")}` };
        const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
        try {
          if (command === "owner") {
            const detail = await ownerDetail(machineArg);
            if (json) return { exitCode: 0, stdout: JSON.stringify(detail) };
            return { exitCode: 0, stdout: [`${machineArg}: route ${detail.activeRoute}${detail.owner ? ` · bb ${detail.owner.appVersion ?? "?"}` : ""}`, ...detail.routes.map((route) => `  ${route.kind} ${route.state}${route.detail ? ` (${route.detail})` : ""}`), `  binding: ${detail.binding.verified ? `verified enrolled host ${detail.binding.enrolledHostId}` : `not proven (${detail.binding.reason})`}`, ...(detail.mcp ? [`  MCP: ${detail.mcp.enabled ? `on ${detail.mcp.endpoint ?? ""}` : "off"}`] : []), ...detail.editorLinks.map((link) => `  editor: ${link.url}`)].join("\n") };
          }
          if (command === "update") {
            const to = flag("--to");
            if (!to || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(to)) return { exitCode: 1, stderr: "Give the exact target: --to x.y.z" };
            const matrix = await updates.matrix();
            const app = matrix.rows.find((row) => row.machine === machineArg)?.status?.app;
            if (!app) return { exitCode: 1, stderr: `${machineArg} has no authenticated owner route` };
            const result = await updates.handlers.update_dispatch({ v: 1, machine: machineArg, intentId: `fleet-${machineArg.toLowerCase()}-${to.replace(/\./g, "")}-${randomUUID().slice(0, 8)}`, fromVersion: app.current, targetVersion: to, mode: app.exactApply && app.desktopUpdateSupported ? "native" : "bootstrap", quitMode: "signal" });
            if (json) return { exitCode: result.state === "started" || result.state === "existing" ? 0 : 1, stdout: JSON.stringify(result) };
            return result.state === "started" || result.state === "existing" ? { exitCode: 0, stdout: `${machineArg}: update ${result.intent?.intentId ?? ""} ${result.state}. Follow it with bb fleet versions.` } : { exitCode: 1, stderr: `${machineArg}: ${result.state}${result.reason ? `: ${result.reason}` : ""}` };
          }
          const provider = args[1];
          const from = flag("--from");
          if (!provider || from === undefined) return { exitCode: 1, stderr: "Usage: bb fleet provider-update <machine> <provider> --from <version>" };
          const receipt = await updates.handlers.provider_update_dispatch({ v: 1, machine: machineArg, requestId: `prov-${machineArg.toLowerCase()}-${randomUUID().slice(0, 12)}`, provider, expectedFromVersion: from === "none" ? null : from });
          if (json) return { exitCode: receipt.state === "completed" ? 0 : 1, stdout: JSON.stringify(receipt) };
          return receipt.state === "completed" ? { exitCode: 0, stdout: `${provider} on ${machineArg}: ${receipt.fromVersion ?? "-"} → ${receipt.toVersion ?? "?"}` } : { exitCode: 1, stderr: `${provider} on ${machineArg}: ${receipt.state}${receipt.message ? `: ${receipt.message}` : ""}` };
        } catch (cause) { return { exitCode: 1, stderr: message(cause) }; }
      }
      // ask / tell / output / result parse their own argv: text after a bare -- may contain --json.
      const at = argv.findIndex((a) => a !== "--json");
      if (RELAY_COMMANDS.includes(argv[at] as RelayCommandName)) return runRelay(argv.slice(at), ctx, at > 0);
      return { exitCode: 1, stderr: usage };
    },
  });
}

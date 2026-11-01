import { createHash } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fleetAttachmentSchema, fleetNotStartedSchema, fleetRouteSchema, fleetVerifiedAttachmentSchema } from "./server-fleet";
import type { NativeSessionState } from "./server-native-sessions";
import { transcript } from "./server-m1";
import {
  ContextIntegrityError, assertBundleCommit, assertBundleMatches, buildNarrative, contextManifestPath, portableBundleSchema, sourceAttachmentIds, sourceEntries,
  structuredContextInput, structuredContextPrompt, verifyImport, type ContextBundleLink, type PortableBundle,
} from "./server-context-bundle";
import { loadProfile } from "./profile/load";
import { workloadFor } from "./profile/schema";

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_CONTEXT_BYTES = 60_000;
const id = z.string().trim().min(1).max(128);
const branchName = z.string().trim().min(1).max(200);
export const nativeWorkWorkspaceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("managed-worktree"), baseBranch: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("default") }).strict(), z.object({ kind: z.literal("named"), name: branchName }).strict(),
  ]) }).strict(),
  z.object({ type: z.literal("unmanaged"), path: z.null(), branch: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), name: branchName }).strict(), z.object({ kind: z.literal("new"), baseBranch: branchName }).strict(),
  ]).optional() }).strict(),
]);
export const nativeWorkStartInput = z.object({
  requestId: z.string().uuid(),
  machine: z.string().min(1).max(40).default("Auto"),
  prompt: z.string().min(1).max(MAX_PROMPT_BYTES).refine((value) => value.trim().length > 0, "Enter a task.").refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES, "The task must fit within 256 KiB of UTF-8."),
  sourceThreadId: id.optional(), rootThreadId: id.optional(),
  destinationProjectName: z.string().trim().min(1).max(200).optional(),
  includeContext: z.boolean().default(true),
  providerId: z.string().trim().min(1).max(120), model: z.string().trim().min(1).max(200),
  reasoningLevel: z.string().trim().min(1).max(80), serviceTier: z.string().trim().min(1).max(80).optional(),
  routing: z.object({
    workload: z.string().trim().min(1).max(60).optional(), needsNas: z.boolean().optional(), unattended: z.boolean().optional(),
    requiredCapabilities: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  }).strict().optional(),
  workspace: nativeWorkWorkspaceSchema.optional(), title: z.string().trim().min(1).max(120).optional(),
  attachments: z.array(fleetAttachmentSchema).min(1).max(10).optional(),
  /** Opt-in: send a navaigate.portable-context v1 bundle instead of the text snapshot. */
  structuredContext: structuredContextInput.optional(),
  /** A bundle saved earlier: delivered to the new session instead of one built from a source conversation. */
  contextBundle: portableBundleSchema.optional(),
}).strict();
/** What a bundle holds, for showing before it is sent and after it arrives. */
export const nativeContextPreviewSchema = z.object({
  format: z.literal("portable-v1"), createdAt: z.number(), sourceMachine: z.string(), sourceThreadId: z.string().nullable(),
  commit: z.string().nullable(), repository: z.enum(["verified", "unknown"]),
  decisions: z.number().int().min(0), decisionTexts: z.array(z.string()).max(5), messages: z.number().int().min(0),
  omittedMessages: z.number().int().min(0), omittedAttachments: z.number().int().min(0),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().min(0) }).strict()).max(20),
}).strict();
export type NativeContextPreview = z.infer<typeof nativeContextPreviewSchema>;
export const nativeContextExportInput = z.object({
  sourceThreadId: id, note: z.string().trim().max(2000).optional(), structuredContext: structuredContextInput.optional(),
}).strict();
export const nativeContextExportOutput = z.object({ filename: z.string(), summary: nativeContextPreviewSchema, bundle: portableBundleSchema });
export const nativeContextInspectInput = z.object({ bundle: portableBundleSchema }).strict();
export const nativeWorkReceiptInput = z.object({ requestId: z.string().uuid() }).strict();
export const nativeWorkContextSchema = z.object({
  format: z.literal("portable-v1"), state: z.enum(["pending", "delivered", "failed"]),
  manifestPath: z.string(), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  commit: z.string().nullable(), commitClaimed: z.boolean().optional(), decisions: z.number().int().min(0), messages: z.number().int().min(0),
  omittedMessages: z.number().int().min(0), omittedAttachments: z.number().int().min(0),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(20),
}).strict();
export const nativeWorkStartOutput = z.object({
  outcome: z.enum(["started", "sent", "unknown"]), requestId: z.string().uuid(),
  threadId: id.nullable(), localThreadId: id.nullable(), commandId: z.string().nullable(), url: z.string().nullable(),
  route: fleetRouteSchema.nullable(), warning: z.string().nullable(),
  attachments: z.array(fleetVerifiedAttachmentSchema).max(10).optional(),
  notStarted: fleetNotStartedSchema.optional(),
  context: nativeWorkContextSchema.optional(),
}).refine((receipt) => !receipt.notStarted || (receipt.outcome === "unknown" && receipt.threadId === null && receipt.localThreadId === null && receipt.commandId === null && receipt.url === null && !receipt.attachments), "A not-started receipt cannot also describe accepted work.");
export const nativeWorkReceiptOutput = nativeWorkStartOutput;
export type NativeWorkInput = z.infer<typeof nativeWorkStartInput>;
export type NativeWorkReceipt = z.infer<typeof nativeWorkStartOutput>;
type Route = z.infer<typeof fleetRouteSchema>;
type FleetRouteInput = Pick<NativeWorkInput, "machine" | "providerId" | "model" | "reasoningLevel" | "serviceTier" | "routing" | "workspace" | "attachments"> & { projectName?: string };
type FleetStart = { outcome: "started" | "sent"; threadId: string | null; requestId?: string; commandId?: string | null; url?: string | null; route?: Route; attachments?: z.infer<typeof fleetVerifiedAttachmentSchema>[] };

export type NativeWorkDependencies = {
  sessions: {
    state(input: { threadId: string }): Promise<NativeSessionState>;
    adoptStarted(input: { rootThreadId: string; threadId: string; sourceThreadId?: string }): Promise<unknown>;
  };
  fleet: {
    route(input: FleetRouteInput): Promise<Route>;
    start(input: FleetRouteInput & { prompt: string; requestId: string; title?: string }): Promise<FleetStart>;
    mirrorOpen(input: { machine: string; threadId: string; localProjectId?: string }): Promise<{ localThreadId: string }>;
    board(): Promise<{ available: boolean; board: { serverId: string; serverKey: string } | null }>;
    commandGet?(input: { commandId: string }): Promise<{ status: string; machine?: string | null; threadId: string | null; url?: string | null; error?: string | null }>;
    workReceipt?(input: { requestId: string }): Promise<{ state: "completed" | "unknown" | "missing"; result: FleetStart | null; notStarted?: z.infer<typeof fleetNotStartedSchema> }>;
  };
  /** Injectable only for deterministic tests; production reads BB's transcript. */
  transcript?(threadId: string): Promise<string>;
  /** Fleet's portable context export/import; absent means structured context falls back to the text snapshot. */
  contextBundle?: ContextBundleLink;
};

type Structured = { bundle: PortableBundle; sourceMachine: string; summary: z.infer<typeof nativeWorkContextSchema> };
type Stored = {
  fingerprint: string;
  receipt: NativeWorkReceipt;
  rootThreadId?: string;
  sourceThreadId?: string;
  localProjectId?: string;
  warnings: string[];
  phase: "starting" | "accepted" | "unknown" | "not-started";
  association: "pending" | "attaching" | "complete" | "failed";
};
const PREFIX = "native-work:";
const opaqueReference = /@(thread|project|section):([A-Za-z0-9_-]+)(?:#msg=\d+)?/gi;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const fingerprint = (input: NativeWorkInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const warning = (...parts: (string | null | undefined)[]) => [...new Set(parts.filter((part): part is string => !!part))].join(" ") || null;

function trimContext(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  const marker = "\n[Source context truncated to fit the handoff.]\n";
  const usable = max - Buffer.byteLength(marker);
  if (usable < 4) throw new Error("The task leaves no room for source context. Shorten it or turn off context.");
  const first = Math.min(8_000, Math.floor(usable / 3));
  // Dropping boundary replacement characters avoids splitting UTF-8 code points.
  return bytes.subarray(0, first).toString("utf8").replace(/\uFFFD$/u, "") + marker + bytes.subarray(bytes.length - (usable - first)).toString("utf8").replace(/^\uFFFD+/u, "");
}

const objectOf = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A bundle's contents as the owner would see them; every file is checked against its own size and SHA-256. */
export function previewBundle(bundle: PortableBundle): NativeContextPreview {
  for (const file of bundle.files) {
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.length !== file.sizeBytes || createHash("sha256").update(content).digest("hex") !== file.sha256) throw new ContextIntegrityError(`File ${file.path} in the bundle failed byte verification.`);
  }
  const repository = bundle.source.repository;
  const decisions = bundle.narrative.decisions.map((item) => objectOf(item)?.text).filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  return nativeContextPreviewSchema.parse({
    format: "portable-v1", createdAt: bundle.createdAt, sourceMachine: bundle.source.owner.machineKey, sourceThreadId: bundle.source.owner.threadId ?? null,
    commit: repository.verification === "verified" ? repository.commit : null, repository: repository.verification,
    decisions: bundle.narrative.decisions.length, decisionTexts: decisions.slice(0, 5).map((text) => text.slice(0, 200)), messages: bundle.narrative.messages.length,
    omittedMessages: bundle.narrative.omitted.messageIds.length, omittedAttachments: bundle.narrative.omitted.attachmentIds.length,
    files: bundle.files.map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes })),
  });
}

export function createNativeWork(bb: BbPluginApi, dependencies: NativeWorkDependencies) {
  const { sessions, fleet } = dependencies;
  const locks = new Map<string, Promise<unknown>>();
  const cache = new Map<string, Stored>();
  // Bundles can reach 12 MiB, so they are held only in memory until the owner imports them.
  const bundles = new Map<string, PortableBundle>();
  function remember(requestId: string, record: Stored) {
    cache.set(requestId, record);
    if (cache.size > 128) { const oldest = cache.keys().next().value!; cache.delete(oldest); bundles.delete(oldest); }
  }
  function serial<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(requestId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    locks.set(requestId, result);
    void result.finally(() => { if (locks.get(requestId) === result) locks.delete(requestId); }).catch(() => undefined);
    return result;
  }
  async function save(requestId: string, record: Stored) {
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > 230_000) throw new Error("The native work receipt is too large to save.");
    await bb.storage.kv.set(PREFIX + requestId, record);
    remember(requestId, record);
  }
  async function read(requestId: string): Promise<Stored | undefined> {
    const record = cache.get(requestId) ?? await bb.storage.kv.get<Stored>(PREFIX + requestId);
    if (record) nativeWorkStartOutput.parse(record.receipt);
    return record;
  }
  async function saveAccepted(requestId: string, record: Stored) {
    try { await save(requestId, record); }
    catch (cause) {
      remember(requestId, record);
      const status = record.receipt.outcome === "unknown" ? "The start outcome is unconfirmed" : "Work was accepted";
      record.receipt.warning = warning(record.receipt.warning, `${status}, but its local receipt could not be saved: ${message(cause)}. Keep request ${requestId}; do not create a replacement job.`);
    }
  }

  async function prepare(input: NativeWorkInput) {
    let session: NativeSessionState | undefined;
    let sourceThreadId: string | undefined;
    let projectName: string | undefined;
    const warnings: string[] = [];
    const lookup = input.sourceThreadId ?? input.rootThreadId;
    if (lookup) {
      session = await sessions.state({ threadId: lookup });
      if (input.rootThreadId && session.rootThreadId !== input.rootThreadId) throw new Error("The source session is not part of the requested conversation.");
      sourceThreadId = input.sourceThreadId ?? session.activeThreadId;
      if (!session.members.some((member) => member.id === sourceThreadId && member.status !== "deleted")) throw new Error("The source session is not available in this conversation.");
      const source = await bb.sdk.threads.get({ threadId: sourceThreadId });
      if (source.projectId !== session.projectId || source.deletedAt !== null) throw new Error("The source session no longer belongs to this conversation's project.");
      const project = await bb.sdk.projects.get({ projectId: session.projectId });
      projectName = project.kind === "personal" ? undefined : project.name;
      if (workloadFor(loadProfile().profile, project.name)) projectName = project.name;
    }
    const wantsStructured = !!input.structuredContext;
    const imported = input.contextBundle;
    if (imported && wantsStructured) throw new Error("Send this conversation's structured context or an imported bundle, not both.");
    if (wantsStructured && (!input.includeContext || !sourceThreadId)) throw new Error("Structured context needs a source conversation with context turned on.");
    const destination = input.destinationProjectName ?? projectName;
    const matched = workloadFor(loadProfile().profile, `${projectName ?? ""} ${destination ?? ""}`);
    const routing = { ...input.routing, ...(matched ? { workload: matched.id } : {}) };
    const task = input.prompt.replace(opaqueReference, (_reference, kind: string, target: string) => {
      if (kind.toLowerCase() === "thread" && target === sourceThreadId && input.includeContext) return wantsStructured || imported ? "[structured source context below]" : "[source conversation snapshot below]";
      throw new Error("This task contains an unresolved local thread/project/section reference. Use only the selected source conversation with context enabled, or replace the reference with explicit text.");
    });
    let prompt = task;
    let structured: Structured | null = null;
    if (imported) structured = importedStructured(input.requestId, imported);
    else if (wantsStructured && sourceThreadId) {
      try { structured = await buildStructured(input, sourceThreadId, task); }
      catch (cause) {
        if (cause instanceof ContextIntegrityError) throw cause;
        warnings.push(`Structured context is not available here: ${message(cause)} A text snapshot was sent instead.`);
      }
    }
    if (structured) {
      const from = imported ? imported.source.owner.threadId ?? "an imported bundle" : sourceThreadId!;
      prompt = task + structuredContextPrompt({ requestId: input.requestId, sourceThreadId: from, sourceMachine: structured.sourceMachine, fileCount: structured.bundle.files.length });
      warnings.push(`Structured context (portable-v1) is imported to ${contextManifestPath(input.requestId)} on the destination once its session exists${structured.summary.commit ? `; source commit ${structured.summary.commit}${imported ? ", as stated by the bundle" : ""}` : "; the source repository commit is unknown"}.`);
    } else if (input.includeContext && sourceThreadId) {
      const raw = await (dependencies.transcript ?? transcript)(sourceThreadId);
      const context = raw.replace(opaqueReference, (_reference, kind: string, target: string) => `[source-local ${kind.toLowerCase()} ${target}; reference not transferred]`);
      const heading = `\n\n--- SOURCE CONVERSATION SNAPSHOT ---\nSource session: ${sourceThreadId}\nThis is a bounded text snapshot, not transferred provider state. Historic source files, uploads and attachments were not copied. Only files attached to this new task are transferred and verified; other local paths may be unavailable on this Mac.\n`;
      const end = "\n--- END SOURCE SNAPSHOT ---";
      const budget = Math.min(MAX_CONTEXT_BYTES, MAX_PROMPT_BYTES - Buffer.byteLength(task + heading + end, "utf8"));
      const snapshot = trimContext(context || "No source messages are available.", budget);
      prompt = task + heading + snapshot + end;
      warnings.push("Source context is a text snapshot. Historic source files and attachments were not copied; files attached to this task are transferred separately.");
      if (Buffer.byteLength(context, "utf8") > budget) warnings.push("Source context was truncated to fit the handoff.");
    }
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("The task plus context exceeds 256 KiB. Shorten the task or turn off context; your task text was not truncated.");
    const routeInput: FleetRouteInput = {
      machine: input.machine, providerId: input.providerId, model: input.model, reasoningLevel: input.reasoningLevel,
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      ...(destination ? { projectName: destination } : {}), routing,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
    };
    return { session, sourceThreadId, prompt, routeInput, warnings, structured };
  }

  function importedStructured(requestId: string, bundle: PortableBundle): Structured {
    const view = previewBundle(bundle);
    return {
      bundle, sourceMachine: view.sourceMachine,
      summary: {
        format: "portable-v1", state: "pending", manifestPath: contextManifestPath(requestId), manifestSha256: null, commit: view.commit, commitClaimed: true,
        decisions: view.decisions, messages: view.messages, omittedMessages: view.omittedMessages, omittedAttachments: view.omittedAttachments,
        files: view.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      },
    };
  }

  async function buildStructured(input: Pick<NativeWorkInput, "requestId" | "structuredContext">, sourceThreadId: string, task: string): Promise<Structured> {
    const link = dependencies.contextBundle;
    if (!link) throw new Error("this Skin has no Fleet context bundle link.");
    const target = await link.sourceTarget(sourceThreadId);
    if (target.threadId !== undefined && target.threadId !== sourceThreadId) throw new ContextIntegrityError("Fleet resolved a different source thread.");
    const { events, complete } = await link.events(sourceThreadId);
    const entries = sourceEntries(events, sourceThreadId);
    const narrative = buildNarrative({
      source: { serverId: target.serverId, threadId: sourceThreadId, machine: target.machineKey }, task, entries,
      attachmentIds: sourceAttachmentIds(events, sourceThreadId), historyComplete: complete,
      ...(input.structuredContext?.maxMessages ? { maxMessages: input.structuredContext.maxMessages } : {}),
    });
    const selectedFiles = input.structuredContext?.selectedFiles ?? [];
    const verified = await link.verify(target);
    const bundle = await link.exportBundle({ target, ...narrative, selectedFiles });
    assertBundleMatches(bundle, narrative, selectedFiles, target);
    const commit = assertBundleCommit(verified, bundle);
    return {
      bundle, sourceMachine: target.machineKey,
      summary: {
        format: "portable-v1", state: "pending", manifestPath: contextManifestPath(input.requestId), manifestSha256: null, commit,
        decisions: narrative.decisions.length, messages: narrative.messages.length,
        omittedMessages: narrative.omitted.messageIds.length, omittedAttachments: narrative.omitted.attachmentIds.length,
        files: bundle.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      },
    };
  }

  /** Import the held bundle on the owner of the accepted session; idempotent per request ID on the owner. */
  async function deliver(requestId: string, record: Stored) {
    const context = record.receipt.context;
    const threadId = record.receipt.threadId;
    if (!context || context.state === "delivered" || !threadId || !dependencies.contextBundle) return;
    const bundle = bundles.get(requestId);
    if (!bundle) {
      if (context.state === "pending") {
        context.state = "failed";
        record.receipt.warning = warning(record.receipt.warning, "The structured context was prepared before this plugin restarted and is no longer held, so it was not delivered. The new session will report that it did not arrive.");
      }
      return;
    }
    try {
      const machine = z.string().min(1).max(40).parse(record.receipt.route?.machine);
      const target = await dependencies.contextBundle.ownerTarget({ machine, threadId });
      if (target.threadId !== threadId || target.machineKey !== machine || target.serverId !== record.receipt.route?.serverId) throw new Error("the destination resolved a different owner session.");
      const delivered = verifyImport(await dependencies.contextBundle.importBundle({ target, requestId, bundle }), { target, requestId, bundle });
      context.state = "delivered";
      context.manifestSha256 = delivered.manifestSha256;
      bundles.delete(requestId);
    } catch (cause) {
      context.state = "failed";
      record.receipt.warning = warning(record.receipt.warning, `The structured context could not be delivered yet: ${message(cause).replace(/\.$/, "")}. Check this receipt again to retry; do not start another copy.`);
    }
  }

  async function attach(requestId: string, record: Stored): Promise<NativeWorkReceipt> {
    const receipt = record.receipt;
    if (!receipt.threadId || record.association !== "pending") return receipt;
    record.association = "attaching";
    try {
      // A durable claim prevents a reload or duplicate click re-running side effects.
      await save(requestId, record);
      const identity = await fleet.board();
      const own = identity.available && identity.board && receipt.route?.machine === identity.board.serverKey && receipt.route?.serverId === identity.board.serverId;
      if (own) receipt.localThreadId = receipt.threadId;
      else {
        if (!receipt.route?.machine) throw new Error("The accepted job has no resolved owner machine.");
        const opened = await fleet.mirrorOpen({ machine: receipt.route.machine, threadId: receipt.threadId, ...(record.localProjectId ? { localProjectId: record.localProjectId } : {}) });
        receipt.localThreadId = opened.localThreadId;
      }
      await saveAccepted(requestId, record);
      if (record.rootThreadId) await sessions.adoptStarted({ rootThreadId: record.rootThreadId, threadId: receipt.localThreadId, sourceThreadId: record.sourceThreadId });
      record.association = "complete";
    } catch (cause) {
      record.association = "failed";
      if (receipt.localThreadId) {
        try { await bb.sdk.threads.update({ threadId: receipt.localThreadId, visibility: "visible" }); }
        catch (visibilityError) { receipt.warning = warning(receipt.warning, `The local session could not be revealed: ${message(visibilityError)}.`); }
      }
      receipt.warning = warning(receipt.warning, `The work was accepted, but could not be added to this view: ${message(cause)}. Open its original session; do not start another copy.`);
    }
    await saveAccepted(requestId, record);
    return receipt;
  }

  function accepted(record: Stored, result: FleetStart, requestId: string) {
    if (result.requestId && result.requestId !== requestId) throw new Error("Fleet returned a different request receipt; check the destination before starting another job.");
    record.phase = "accepted";
    record.receipt = nativeWorkStartOutput.parse({
      outcome: result.outcome, requestId, threadId: result.threadId, localThreadId: null,
      commandId: result.commandId ?? null, url: result.url ?? null, route: result.route ?? record.receipt.route,
      ...(result.attachments ? { attachments: result.attachments } : {}),
      ...(record.receipt.context ? { context: record.receipt.context } : {}),
      warning: warning(...record.warnings, ...(result.route?.warnings ?? []), !result.threadId ? "Fleet accepted the work; the owner has not returned a session yet." : null),
    });
  }

  function notStarted(record: Stored, detail: z.infer<typeof fleetNotStartedSchema>) {
    record.phase = "not-started";
    bundles.delete(record.receipt.requestId);
    const { context: _context, ...previous } = record.receipt;
    record.receipt = {
      ...previous, outcome: "unknown", threadId: null, localThreadId: null, commandId: null, url: null,
      notStarted: detail, warning: warning(...record.warnings, `${detail.message} Nothing was started. Your draft is kept; you can try again.`),
    };
  }

  async function start(raw: z.input<typeof nativeWorkStartInput>) {
    const input = nativeWorkStartInput.parse(raw);
    return serial(input.requestId, async () => {
      const hash = fingerprint(input);
      const existing = await read(input.requestId);
      if (existing) {
        if (existing.fingerprint !== hash) throw new Error("This request ID already belongs to a different task. Inspect its original receipt before creating new work.");
        return existing.receipt;
      }
      const prepared = await prepare(input);
      const route = fleetRouteSchema.parse(await fleet.route(prepared.routeInput));
      if (!route.machine || !route.serverId) throw new Error(route.reason || "No eligible machine can run this task.");
      const record: Stored = {
        fingerprint: hash, phase: "starting", association: "pending", warnings: prepared.warnings,
        ...(prepared.session ? { rootThreadId: prepared.session.rootThreadId, localProjectId: prepared.session.projectId } : {}),
        ...(prepared.sourceThreadId ? { sourceThreadId: prepared.sourceThreadId } : {}),
        receipt: { outcome: "unknown", requestId: input.requestId, threadId: null, localThreadId: null, commandId: null, url: null, route, warning: `Request ${input.requestId} may be in progress. Check this receipt; do not start another copy.`, ...(prepared.structured ? { context: prepared.structured.summary } : {}) },
      };
      if (prepared.structured) {
        bundles.set(input.requestId, prepared.structured.bundle);
        // At most a few undelivered bundles (each up to 12 MiB) are held; older ones report "not held".
        while (bundles.size > 8) bundles.delete(bundles.keys().next().value!);
      }
      // Persist before crossing the provider/remote-start boundary.
      await save(input.requestId, record);
      try {
        accepted(record, await fleet.start({ ...prepared.routeInput, prompt: prepared.prompt, requestId: input.requestId, ...(input.title ? { title: input.title } : {}) }), input.requestId);
      } catch (cause) {
        record.phase = "unknown";
        record.receipt.warning = warning(...record.warnings, `No confirmed start receipt was received: ${message(cause)}. Keep request ${input.requestId}; do not submit a new request.`);
        if (fleet.workReceipt) {
          try {
            const recovered = await fleet.workReceipt({ requestId: input.requestId });
            if (recovered.state === "completed" && recovered.result) accepted(record, recovered.result, input.requestId);
            else if (recovered.state === "missing" && recovered.result === null && recovered.notStarted) notStarted(record, fleetNotStartedSchema.parse(recovered.notStarted));
          } catch { /* The original start remains uncertain without a positive receipt. */ }
        }
        if (record.receipt.threadId) await deliver(input.requestId, record);
        await saveAccepted(input.requestId, record);
        return record.receipt.outcome !== "unknown" ? attach(input.requestId, record) : record.receipt;
      }
      await deliver(input.requestId, record);
      await saveAccepted(input.requestId, record);
      return attach(input.requestId, record);
    });
  }

  async function receipt(raw: z.input<typeof nativeWorkReceiptInput>) {
    const { requestId } = nativeWorkReceiptInput.parse(raw);
    return serial(requestId, async () => {
      const record = await read(requestId);
      if (!record) throw new Error("No native work receipt exists for this request ID.");
      if (record.phase !== "accepted" && record.phase !== "not-started" && fleet.workReceipt) {
        try {
          const recovered = await fleet.workReceipt({ requestId });
          if (recovered.state === "completed" && recovered.result) accepted(record, recovered.result, requestId);
          else if (recovered.state === "missing" && recovered.result === null && recovered.notStarted) notStarted(record, fleetNotStartedSchema.parse(recovered.notStarted));
        } catch (cause) { record.receipt.warning = warning(record.receipt.warning, `The original request could not be checked: ${message(cause)}.`); }
      }
      if (record.phase === "accepted" && !record.receipt.threadId && record.receipt.commandId && fleet.commandGet) {
        try {
          const command = await fleet.commandGet({ commandId: record.receipt.commandId });
          if (command.threadId) {
            if (command.machine && command.machine !== record.receipt.route?.machine) throw new Error("The accepted command's machine does not match its original route. Inspect the owner session before opening a local copy.");
            record.receipt.threadId = command.threadId;
            record.receipt.url = command.url ?? record.receipt.url;
            record.receipt.outcome = "started";
            record.receipt.warning = warning(...record.warnings, ...(record.receipt.route?.warnings ?? []));
          } else if (command.error || ["failed", "error", "unknown"].includes(command.status)) {
            record.receipt.warning = warning(...record.warnings, `The accepted command is ${command.status}: ${command.error ?? "its outcome is not confirmed"}. Do not create another job automatically.`);
          }
        } catch (cause) { record.receipt.warning = warning(record.receipt.warning, `The accepted command could not be checked: ${message(cause)}.`); }
      }
      if (record.phase === "accepted") await deliver(requestId, record);
      if (record.association === "attaching") record.receipt.warning = warning(record.receipt.warning, "The work was accepted, but grouping was interrupted. Inspect its original session instead of starting another copy.");
      await saveAccepted(requestId, record);
      return attach(requestId, record);
    });
  }

  /** Build a bundle from a conversation on this Mac and hand it back, so it can be saved or sent later. */
  async function exportContext(raw: z.input<typeof nativeContextExportInput>) {
    const input = nativeContextExportInput.parse(raw);
    const source = await bb.sdk.threads.get({ threadId: input.sourceThreadId });
    if (source.deletedAt !== null) throw new Error("That conversation was deleted.");
    const built = await buildStructured({ requestId: createHash("sha256").update(input.sourceThreadId).digest("hex").slice(0, 8), structuredContext: input.structuredContext }, input.sourceThreadId, input.note || "Exported conversation context");
    const summary = previewBundle(built.bundle);
    const stamp = new Date(built.bundle.createdAt).toISOString().replace(/[:T]/g, "-").slice(0, 16);
    return { filename: `context-bundle-${input.sourceThreadId}-${stamp}.json`, summary, bundle: built.bundle };
  }

  /** Check a saved bundle and describe it, without sending it anywhere. */
  async function inspectContext(raw: z.input<typeof nativeContextInspectInput>) {
    return previewBundle(nativeContextInspectInput.parse(raw).bundle);
  }
  return { start, receipt, exportContext, inspectContext };
}

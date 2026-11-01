import { useEffect, useMemo, useRef, useState } from "react";
import {
  UrlLink,
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate, useRpc, useSdk,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue, NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { z } from "zod";
import type { rpcContract } from "../server";
import type { NativeWorkInput, NativeWorkReceipt } from "../server-native-work";
import { AllowanceChip } from "./allowance";
import { RoutePreviewPanel, type RoutePreviewRequest } from "./route-preview";
import { ContextArrival, ContextControls, parseContextFilePaths, type ImportedBundle } from "./context-bundle-controls";
import { ghostButton, field } from "./controls";
import { getProfile, useProfile } from "./use-profile";
import { useFeature } from "./use-feature";
import { consoleSection } from "../lib/profile-console";
import { workloadFor, type Profile } from "../profile/schema";
import { machineName } from "./words";

/**
 * Start a model alongside the current conversation, either on this Mac
 * ("here", a native hidden child grouped into the conversation) or on another
 * Mac through Fleet (`native_work_start`). The host-owned NewThreadComposer
 * keeps the native editor, attachments, model, effort, project, workspace and
 * permission controls; this component only adds placement and routing intent.
 */

export type NativeWorkPlacement = string;
export type NativeWorkMachine = Exclude<NativeWorkPlacement, "here">;
export type NativeWorkStarted =
  | { kind: "local"; threadId: string; grouped: boolean }
  | { kind: "routed"; receipt: NativeWorkReceipt };
export type NativeWorkComposerProps = {
  rootThreadId?: string;
  sourceThreadId?: string;
  projectId?: string;
  defaultSelection?: ExperimentalProviderModelPickerValue;
  defaultEnvironment?: NewThreadRequest["environment"];
  /** Defaults to "here". The always-on Mac's own rail passes its machine id. */
  initialMachine?: NativeWorkPlacement;
  draftKey?: string;
  onStarted?: (started: NativeWorkStarted) => void;
};
/** Everything the routed request carries except its idempotency key. */
export type NativeWorkPayload = Omit<NativeWorkInput, "requestId">;
export type NativeWorkRouting = { workload: string; needsNas: boolean; unattended: boolean; needsXcode?: boolean };
/** The capability names Fleet verifies on a Mac; a Mac without the tool is not eligible. */
const XCODE_CAPABILITY = "xcode";
function requiredCapabilities(routing: Pick<NativeWorkRouting, "needsXcode">): string[] | undefined {
  return routing.needsXcode ? [XCODE_CAPABILITY] : undefined;
}
export type NativeWorkOptions = {
  machine: NativeWorkMachine;
  /** Which kinds of attachment may travel (features F59 images, F60 other files). Absent means both. */
  attach?: { images: boolean; files: boolean };
  sourceThreadId?: string;
  rootThreadId?: string;
  destinationProjectName?: string;
  includeContext: boolean;
  /** Opt-in: send a versioned structured context bundle instead of the text snapshot. */
  structuredContext?: boolean;
  /** Project-relative files, one per line, carried with structured context. */
  contextFiles?: string;
  /** A saved bundle sent in place of one built from the conversation. */
  contextBundle?: ImportedBundle["bundle"];
  routing: NativeWorkRouting;
};

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export type MachineOption = { key: string; value: NativeWorkPlacement; label: string; hint: string };

/** The picker's own identity for a placement. Its own options are "@here" and "@auto" and a profile machine is "m:<id>", so no machine id can collide with them. */
export function placementKey(placement: NativeWorkPlacement): string {
  return placement === "here" ? "@here" : placement === "Auto" ? "@auto" : `m:${placement}`;
}

/**
 * Where new work can run: this Mac, Auto, then every other machine in the profile with a short hint (the profile may carry its own hints).
 * A profile with a single machine, or a machine called "This Mac", does not list it again: "This Mac" already stands for it.
 */
export function machineOptions(profile: Profile): readonly MachineOption[] {
  const hints = consoleSection(profile).machineHints;
  const others = profile.machines.filter((m) => profile.machines.length > 1 && m.label.trim().toLowerCase() !== "this mac");
  return [
    { key: "@here", value: "here", label: "This Mac", hint: "A native session on this Mac." },
    { key: "@auto", value: "Auto", label: "Auto", hint: "Fleet picks an eligible Mac for this new work." },
    ...others.map((m) => {
      const workload = profile.workloads.find((w) => w.machine === m.id);
      const byRole = m.role === "always-on" ? "Always-on Mac." : m.restricted ? (workload ? `The ${workload.label} Mac.` : "A restricted Mac.") : "Another Mac.";
      return { key: `m:${m.id}`, value: m.id, label: m.label, hint: hints[m.id] ?? byRole };
    }),
  ];
}
const button = ghostButton;
const explain = (error: unknown) => error instanceof Error ? error.message : String(error);
const SUPPORTED_WORKSPACES = "Choose a new worktree from a base branch, or the project's checkout on the destination Mac (optionally on an existing or new branch).";
const nativeBranch = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), name: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("new"), baseBranch: z.string().min(1).max(200) }).strict(),
]);
const nativeCheckout = z.object({ path: z.string().min(1).optional(), branch: nativeBranch.optional() }).strict();
const nativeWorktree = z.object({ branch: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z.object({ kind: z.literal("named"), name: z.string().min(1).max(200) }).strict(),
]).optional() }).strict();

/** The away mirror and the NAS share are the same AIOS; every other name passes through unchanged. */
export function nativeDestinationProjectName(name: string): string {
  const sec = consoleSection(getProfile());
  return sec.nasAwayProject && sec.nasProject && name === sec.nasAwayProject ? sec.nasProject : name;
}
/** The profile workload a project name belongs to, else "general". */
export function inferNativeWorkload(projectName: string | null | undefined): string {
  return workloadFor(getProfile(), projectName)?.id ?? "general";
}
/** Canonical key of the exact payload; the same key always reuses the same request ID. */
export function nativeWorkPayloadKey(payload: NativeWorkPayload): string {
  return JSON.stringify(payload);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function mapWorkspace(environment: NewThreadRequest["environment"]): { ok: true; workspace: NativeWorkPayload["workspace"] } | { ok: false; error: string } {
  if (environment.type === "project-default") return { ok: true, workspace: undefined };
  if (environment.type === "reuse") return { ok: false, error: `An existing workspace on this Mac cannot be reused on another Mac. ${SUPPORTED_WORKSPACES}` };
  if (environment.type === "provider") {
    if (environment.machine?.type === "new") return { ok: false, error: `Provisioning a new machine cannot be routed to an existing Mac. ${SUPPORTED_WORKSPACES}` };
    if (environment.environmentProviderId === "project-checkout") {
      const parsed = nativeCheckout.safeParse(environment.inputs ?? {});
      if (!parsed.success) return { ok: false, error: `The native checkout contains unsupported options. ${SUPPORTED_WORKSPACES}` };
      return mapWorkspace({ type: "host", workspace: { type: "unmanaged", path: parsed.data.path ?? null, ...(parsed.data.branch ? { branch: parsed.data.branch } : {}) } });
    }
    if (environment.environmentProviderId === "git-worktree") {
      const parsed = nativeWorktree.safeParse(environment.inputs ?? {});
      if (!parsed.success) return { ok: false, error: `An existing worktree or unsupported native worktree options cannot be routed to another Mac. ${SUPPORTED_WORKSPACES}` };
      return { ok: true, workspace: { type: "managed-worktree", baseBranch: parsed.data.branch ?? { kind: "default" } } };
    }
    return { ok: false, error: `A custom environment provider cannot run on another Mac yet. ${SUPPORTED_WORKSPACES}` };
  }
  const workspace = environment.workspace;
  if (workspace.type === "personal") return { ok: false, error: `"Don't work in a project" cannot be routed to another Mac. Choose a project. ${SUPPORTED_WORKSPACES}` };
  if (workspace.type === "managed-worktree") {
    const base = workspace.baseBranch;
    return { ok: true, workspace: { type: "managed-worktree", baseBranch: base.kind === "named" ? { kind: "named", name: base.name } : { kind: "default" } } };
  }
  if (workspace.path !== null) return { ok: false, error: `A specific folder path on this Mac cannot be used on another Mac. ${SUPPORTED_WORKSPACES}` };
  const branch = workspace.branch;
  return { ok: true, workspace: {
    type: "unmanaged", path: null,
    ...(branch ? { branch: branch.kind === "existing" ? { kind: "existing" as const, name: branch.name } : { kind: "new" as const, baseBranch: branch.baseBranch } } : {}),
  } };
}

/**
 * Map one native composer submission to the routed request, or refuse it
 * before any work starts. Fields are copied one by one so nothing the backend
 * cannot honour is silently dropped or smuggled through.
 */
export function buildNativeWorkInput(request: NewThreadRequest, options: NativeWorkOptions): { ok: true; input: NativeWorkPayload } | { ok: false; error: string } {
  const keep = " Your draft is kept.";
  if (request.permissionMode !== "full") return { ok: false, error: `Work on another Mac runs with full permissions. Set the permission mode to Full, or choose This Mac.${keep}` };
  if (request.sessionOptions && Object.keys(request.sessionOptions).length > 0) return { ok: false, error: `Agent options from the model menu cannot be sent to another Mac yet. Reset them, or choose This Mac.${keep}` };
  if (request.sendAt !== undefined) return { ok: false, error: `Scheduled sends cannot be routed to another Mac yet. Send now, or choose This Mac.${keep}` };
  const sourceIds = new Set([options.sourceThreadId, options.rootThreadId].filter((id): id is string => !!id));
  const texts: string[] = [];
  const attachments: NonNullable<NativeWorkPayload["attachments"]> = [];
  let knownBytes = 0;
  for (const block of request.input) {
    if (block.visibility === "agent-only") return { ok: false, error: `This draft contains hidden agent-only content that cannot be routed. Choose This Mac.${keep}` };
    if (block.type === "image") return { ok: false, error: `An image URL cannot be transferred as an attachment. Attach the image file, or choose This Mac.${keep}` };
    if (block.type === "localImage" || block.type === "localFile") {
      if (block.type === "localImage" && options.attach?.images === false) return { ok: false, error: `Sending images to another Mac is switched off in setup. Remove the image, or choose This Mac.${keep}` };
      if (block.type === "localFile" && options.attach?.files === false) return { ok: false, error: `Sending files to another Mac is switched off in setup. Remove the file, or choose This Mac.${keep}` };
      if (block.hostId || /^(?:[\\/]|[A-Za-z]:)/.test(block.path)) return { ok: false, error: `This attachment points to a file on this Mac. Upload it with the attachment button before sending it to another Mac, or choose This Mac.${keep}` };
      const sourceProjectId = block.sourceProjectId ?? request.projectId;
      const name = (block.type === "localFile" ? block.name : undefined) ?? block.path.split(/[\\/]/).at(-1) ?? "";
      const mimeType = block.type === "localFile" ? block.mimeType ?? null : null;
      if (!sourceProjectId || !block.path || block.path.length > 2000 || !name || name.length > 240 || /[\\/\0]/.test(name) || (mimeType?.length ?? 0) > 200) return { ok: false, error: `This attachment has no valid uploaded file reference. Remove it and attach the file again.${keep}` };
      if (block.type === "localFile" && block.sizeBytes !== undefined) {
        if (!Number.isSafeInteger(block.sizeBytes) || block.sizeBytes < 0) return { ok: false, error: `This attachment has an invalid size. Remove it and attach the file again.${keep}` };
        knownBytes += block.sizeBytes;
      }
      attachments.push({ type: block.type, sourceProjectId, path: block.path, name, mimeType });
      if (attachments.length > 10 || knownBytes > MAX_ATTACHMENT_BYTES) return { ok: false, error: `Send up to 10 attachments totalling 8 MiB per task. The destination checks the actual bytes before starting.${keep}` };
      continue;
    }
    for (const mention of block.mentions ?? []) {
      const resource = mention.resource;
      if (resource.kind === "path" || resource.kind === "attachment") return { ok: false, error: `"${resource.label}" is a file on this Mac. Upload it with the attachment button to transfer it, or choose This Mac.${keep}` };
      if (resource.kind === "plugin") return { ok: false, error: `"${resource.label}" is a plugin reference that cannot be routed. Remove it, or choose This Mac.${keep}` };
      if (resource.kind === "thread" && !sourceIds.has(resource.threadId)) return { ok: false, error: `"${resource.label}" is another conversation on this Mac. Only this conversation can travel, as a text snapshot.${keep}` };
      if (resource.kind === "thread" && !options.includeContext) return { ok: false, error: `The draft refers to this conversation, but "Include conversation context" is off. Turn it on, or remove the reference.${keep}` };
    }
    texts.push(block.text);
  }
  const prompt = texts.join("\n\n");
  if (!prompt.trim()) return { ok: false, error: "Enter a task first." };
  if (utf8Bytes(prompt) > MAX_PROMPT_BYTES) return { ok: false, error: `The task is larger than 256 KiB. Shorten it; nothing was truncated.${keep}` };
  const mapped = mapWorkspace(request.environment);
  if (!mapped.ok) return { ok: false, error: mapped.error + keep };
  const destination = options.destinationProjectName?.trim();
  const carried = parseContextFilePaths(options.contextFiles ?? "");
  const structured = sourceIds.size > 0 && options.includeContext && options.structuredContext && !options.contextBundle;
  if (structured && !carried.ok) return { ok: false, error: carried.error + keep };
  const input: NativeWorkPayload = {
    machine: options.machine,
    prompt,
    ...(options.sourceThreadId ? { sourceThreadId: options.sourceThreadId } : {}),
    ...(options.rootThreadId ? { rootThreadId: options.rootThreadId } : {}),
    ...(destination ? { destinationProjectName: destination } : {}),
    includeContext: sourceIds.size > 0 && options.includeContext,
    ...(structured && carried.ok ? { structuredContext: carried.files.length ? { selectedFiles: carried.files } : {} } : {}),
    ...(options.contextBundle ? { contextBundle: options.contextBundle } : {}),
    providerId: request.providerId,
    model: request.model,
    reasoningLevel: request.reasoningLevel,
    ...(request.serviceTier ? { serviceTier: request.serviceTier } : {}),
    routing: {
      workload: options.routing.workload,
      ...(options.routing.needsNas ? { needsNas: true } : {}),
      ...(options.routing.unattended ? { unattended: true } : {}),
      ...(options.routing.needsXcode ? { requiredCapabilities: [XCODE_CAPABILITY] } : {}),
    },
    ...(mapped.workspace ? { workspace: mapped.workspace } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
  return { ok: true, input };
}

/** The read-only route check for what the dialog currently describes; null while the work stays on this Mac. */
export function buildRoutePreviewInput(options: {
  machine: NativeWorkPlacement; destination: string; routing: NativeWorkRouting;
  selection?: Pick<ExperimentalProviderModelPickerValue, "providerId" | "model" | "reasoningLevel" | "serviceTier">;
  environment?: NewThreadRequest["environment"];
}): RoutePreviewRequest | null {
  if (options.machine === "here") return null;
  const mapped = options.environment ? mapWorkspace(options.environment) : null;
  const capabilities = requiredCapabilities(options.routing);
  const selection = options.selection;
  return {
    machine: options.machine,
    ...(selection?.providerId ? { providerId: selection.providerId } : {}),
    ...(selection?.providerId && selection.model ? { model: selection.model } : {}),
    ...(selection?.providerId && selection.model && selection.reasoningLevel ? { reasoningLevel: selection.reasoningLevel } : {}),
    ...(options.destination.trim() ? { destinationProjectName: options.destination.trim() } : {}),
    routing: {
      workload: options.routing.workload,
      ...(options.routing.needsNas ? { needsNas: true } : {}),
      ...(options.routing.unattended ? { unattended: true } : {}),
      ...(capabilities ? { requiredCapabilities: capabilities } : {}),
    },
    ...(mapped?.ok && mapped.workspace ? { workspace: mapped.workspace } : {}),
  };
}

/** Plain statement of a workspace seed, for the destination line. */
export function describeNativeWorkspace(environment: NewThreadRequest["environment"] | undefined): string {
  if (!environment || environment.type === "project-default") return "the destination project's default workspace";
  if (environment.type === "reuse") return "an existing workspace on this Mac (not available elsewhere)";
  if (environment.type === "provider") {
    const mapped = mapWorkspace(environment);
    return mapped.ok && mapped.workspace ? describeNativeWorkspace({ type: "host", workspace: mapped.workspace }) : "a custom environment (not available elsewhere)";
  }
  const workspace = environment.workspace;
  if (workspace.type === "personal") return "no project";
  if (workspace.type === "managed-worktree") return workspace.baseBranch.kind === "named" ? `a new worktree from ${workspace.baseBranch.name}` : "a new worktree from the default branch";
  if (workspace.branch?.kind === "existing") return `the project checkout on branch ${workspace.branch.name}`;
  if (workspace.branch?.kind === "new") return `the project checkout on a new branch from ${workspace.branch.baseBranch}`;
  return "the project checkout";
}

function newRequestId(): string {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (source && typeof source.getRandomValues === "function") source.getRandomValues(bytes);
  else for (let index = 0; index < 16; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type RoutedSeed = { state: "ready"; environment: NewThreadRequest["environment"] | undefined } | { state: "loading" } | { state: "unsupported"; environment: undefined };

/**
 * A routed placement cannot reuse a workspace on this Mac. Re-seed it once to
 * the same intent the destination can honour: a new worktree from the source
 * branch for git, otherwise the project's configured checkout.
 */
function useRoutedSeed(environment: NewThreadRequest["environment"] | undefined): RoutedSeed {
  const sdk = useSdk();
  const reuseId = environment?.type === "reuse" ? environment.environmentId : null;
  const [resolved, setResolved] = useState<{ id: string; seed: RoutedSeed } | null>(null);
  useEffect(() => {
    if (!reuseId) return;
    let live = true;
    void sdk.environments.get({ environmentId: reuseId }).then((found) => {
      if (!live) return;
      const seed: NewThreadRequest["environment"] = found.isGitRepo
        ? { type: "host", hostId: found.hostId, workspace: { type: "managed-worktree", baseBranch: found.branchName ? { kind: "named", name: found.branchName } : { kind: "default" } } }
        : { type: "host", hostId: found.hostId, workspace: { type: "unmanaged", path: null } };
      setResolved({ id: reuseId, seed: { state: "ready", environment: seed } });
    }, () => { if (live) setResolved({ id: reuseId, seed: { state: "unsupported", environment: undefined } }); });
    return () => { live = false; };
  }, [sdk, reuseId]);
  if (!environment || environment.type === "project-default") return { state: "ready", environment: undefined };
  if (environment.type === "provider") return mapWorkspace(environment).ok ? { state: "ready", environment } : { state: "unsupported", environment: undefined };
  if (environment.type === "host") {
    if (environment.workspace.type === "personal" || (environment.workspace.type === "unmanaged" && environment.workspace.path !== null)) return { state: "unsupported", environment: undefined };
    return { state: "ready", environment };
  }
  return resolved?.id === reuseId ? resolved.seed : { state: "loading" };
}

function useProjectName(projectId: string | undefined) {
  const sdk = useSdk();
  const [project, setProject] = useState<{ id: string; name: string; personal: boolean } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void sdk.projects.get({ projectId }).then((found) => { if (live) setProject({ id: found.id, name: found.name, personal: found.kind === "personal" }); }, () => {});
    return () => { live = false; };
  }, [sdk, projectId]);
  return project?.id === projectId ? project : null;
}

/**
 * The routed submission for one draft, saved BEFORE the start request leaves
 * this Mac. The draft survives a reload, so its request ID must too: a lost
 * response followed by a reload then checks the original receipt instead of
 * creating a second job. Holds no secrets; the draft store already has the text.
 */
export type NativeWorkPending = {
  requestId: string;
  payloadHash: string;
  machine: NativeWorkMachine;
  receipt: NativeWorkReceipt | null;
  /** onStarted has fired for this request. */
  notified: boolean;
  savedAt: number;
};
const STORE = "navaigate:native-work:";

/** Compact, stable fingerprint of the exact payload (two FNV-1a passes plus length). */
export function nativeWorkPayloadHash(payload: NativeWorkPayload): string {
  const text = nativeWorkPayloadKey(payload);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code ^ (index & 0xff), 0x01000193) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}-${text.length}`;
}
const RECENT = "navaigate:native-work-recent:";
function store(): Storage | null {
  try {
    const target = globalThis.localStorage;
    return target && typeof target.getItem === "function" && typeof target.setItem === "function" ? target : null;
  } catch { return null; }
}
/**
 * Request IDs this draft already used, by payload hash. An identical payload
 * always reuses its ID, so the backend answers with the original receipt
 * instead of starting a copy, even after the receipt was dismissed.
 */
function readRecent(draftKey: string): [string, string][] {
  try {
    const value = JSON.parse(store()?.getItem(RECENT + draftKey) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is [string, string] => Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "string") : [];
  } catch { return []; }
}
function rememberRecent(draftKey: string, hash: string, requestId: string): void {
  try { store()?.setItem(RECENT + draftKey, JSON.stringify([[hash, requestId] as [string, string], ...readRecent(draftKey).filter(([known]) => known !== hash)].slice(0, 20))); }
  catch { /* Memory still holds it for this view. */ }
}
export function readNativeWorkPending(draftKey: string): NativeWorkPending | null {
  try {
    const raw = store()?.getItem(STORE + draftKey);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<NativeWorkPending>;
    if (typeof value.requestId !== "string" || typeof value.payloadHash !== "string" || typeof value.machine !== "string") return null;
    return { requestId: value.requestId, payloadHash: value.payloadHash, machine: value.machine as NativeWorkMachine, receipt: value.receipt ?? null, notified: value.notified === true, savedAt: typeof value.savedAt === "number" ? value.savedAt : 0 };
  } catch { return null; }
}
/** True only when the entry is durably readable back from the store. */
function writePending(draftKey: string, value: NativeWorkPending | null): boolean {
  try {
    const target = store();
    if (!target) return false;
    if (!value) { target.removeItem(STORE + draftKey); return true; }
    const text = JSON.stringify(value);
    target.setItem(STORE + draftKey, text);
    return target.getItem(STORE + draftKey) === text;
  } catch { return false; }
}
function forgetRecent(draftKey: string, hash: string): void {
  try { store()?.setItem(RECENT + draftKey, JSON.stringify(readRecent(draftKey).filter(([known]) => known !== hash))); }
  catch { /* Nothing to forget. */ }
}
const STORAGE_UNAVAILABLE = "This view cannot save the request ID, so a reload could start the same work twice. Nothing was sent. Your draft is kept. Allow site storage, free some space, or choose This Mac.";
/** The backend saves its record before crossing the start boundary, so "missing" means nothing started. */
const missingReceipt = (cause: unknown) => /No native work receipt exists/i.test(explain(cause));

function readableAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
}

function Receipt({ pending, checking, checkError, onCheck, onRelease }: { pending: NativeWorkPending; checking: boolean; checkError: string | null; onCheck: () => void; onRelease: () => void }) {
  const navigate = useBbNavigate();
  const [confirm, setConfirm] = useState(false);
  const receipt = pending.receipt;
  const where = receipt?.route?.machine ? machineName(receipt.route.machine) : pending.machine === "Auto" ? "the chosen Mac" : machineName(pending.machine);
  const accepted = receipt?.outcome === "started" || receipt?.outcome === "sent";
  const verifiedFiles = accepted && !receipt?.notStarted && receipt?.route?.machine
    ? receipt.attachments?.filter((file) => file.verified === true) ?? [] : [];
  const headline = !receipt ? `Waiting for a receipt from ${where}` : receipt.outcome === "started" ? `Started on ${where}` : receipt.outcome === "sent" ? `Sent to ${where}` : `Not confirmed on ${where}`;
  return <div role="status" data-native-work-receipt={receipt?.outcome ?? "pending"} className="mb-3 rounded-lg border border-border bg-muted/40 p-3 text-xs">
    <p className="font-medium text-foreground">{headline}</p>
    {receipt?.route?.reason ? <p className="mt-1 text-muted-foreground">Route: {receipt.route.reason}</p> : null}
    {receipt?.context ? <ContextArrival context={receipt.context} where={where} /> : null}
    {receipt?.warning ? <p className="mt-1 text-muted-foreground">{receipt.warning}</p> : null}
    {verifiedFiles.length > 0 ? <div className="mt-1 text-muted-foreground">
      <p>Files verified on {where} (destination Mac)</p>
      <ul>
        {verifiedFiles.map((file, index) => <li key={index} className="break-words">{file.name} · {readableAttachmentSize(file.sizeBytes)}</li>)}
      </ul>
    </div> : null}
    {!accepted ? <p className="mt-1 text-muted-foreground">{checking ? "Checking the receipt…" : "This request may still start. Check it before sending anything else. Nothing is resent automatically."}</p> : null}
    {checkError ? <p role="alert" className="mt-1 text-destructive-text">Could not check the receipt: {checkError}</p> : null}
    <p className="mt-1 text-muted-foreground">Request {pending.requestId}</p>
    <div className="mt-2 flex flex-wrap gap-2">
      {receipt?.localThreadId ? <button type="button" className={button} onClick={() => navigate.toThread(receipt.localThreadId!)}>Open session</button> : null}
      {receipt?.url ? <UrlLink href={receipt.url} className={button}>Open on {where}</UrlLink> : null}
      {!accepted || (!receipt?.localThreadId && !receipt?.url) ? <button type="button" className={button} disabled={checking} onClick={onCheck}>Check again</button> : null}
      {accepted ? <button type="button" className={button} onClick={onRelease}>Start other work</button>
        : confirm ? null : <button type="button" className={button} disabled={checking} onClick={() => setConfirm(true)}>Start other work</button>}
    </div>
    {confirm && !accepted ? <div role="alert" className="mt-2 rounded-md border border-border p-2">
      <p className="text-foreground">Request {pending.requestId} may still start on {where}. If you release it and send new work, both could run.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className={button} onClick={() => { setConfirm(false); onRelease(); }}>Release request</button>
        <button type="button" className={button} onClick={() => setConfirm(false)}>Keep waiting</button>
      </div>
    </div> : null}
  </div>;
}

export function NativeWorkComposer({ rootThreadId, sourceThreadId, projectId, defaultSelection, defaultEnvironment, initialMachine = "here", draftKey, onStarted }: NativeWorkComposerProps) {
  const whereOn = useFeature("F10");
  const projectOn = useFeature("F05");
  const xcodeOn = useFeature("F15");
  const previewOn = useFeature("F14");
  const workTypeOn = useFeature("F24");
  const attachImagesOn = useFeature("F59");
  const allowanceOn = useFeature("F48");
  const attachFilesOn = useFeature("F60");
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const key = draftKey ?? `native-work:${rootThreadId ?? sourceThreadId ?? "standalone"}`;
  const profile = useProfile();
  const MACHINES = machineOptions(profile);
  const [choice, setChoice] = useState<string>(() => placementKey(initialMachine));
  // The chosen option's placement; a choice the profile no longer lists (or never listed, such as this Mac's own id) falls back to this Mac.
  const chosen = MACHINES.find((item) => item.key === choice) ?? MACHINES[0]!;
  const placement: NativeWorkPlacement = chosen.value;
  const [pending, setPending] = useState<NativeWorkPending | null>(() => readNativeWorkPending(key));
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [structuredContext, setStructuredContext] = useState(false);
  const [needsNas, setNeedsNas] = useState(false);
  const [unattended, setUnattended] = useState(false);
  const [needsXcode, setNeedsXcode] = useState(false);
  const [contextFiles, setContextFiles] = useState("");
  const [imported, setImported] = useState<ImportedBundle | null>(null);
  const [workloadEdit, setWorkloadEdit] = useState<string | null>(null);
  const [destinationEdit, setDestinationEdit] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const checkTicket = useRef<symbol | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; checkTicket.current = null; }; }, []);
  const keyRef = useRef(key);
  keyRef.current = key;
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;
  const project = useProjectName(projectId);
  const routedSeed = useRoutedSeed(defaultEnvironment);
  const routed = placement !== "here";
  const source = sourceThreadId ?? rootThreadId;
  const inferredDestination = project && !project.personal ? nativeDestinationProjectName(project.name) : "";
  const destination = destinationEdit ?? inferredDestination;
  const workload = workloadEdit ?? inferNativeWorkload(destination || project?.name);
  // Every default* prop change re-seeds every picker, so the seed may change
  // only when crossing between this Mac and another Mac, never between Macs.
  const environmentSeed = useMemo(() => routed ? (routedSeed.state === "ready" ? routedSeed.environment : undefined) : defaultEnvironment, [routed, routedSeed, defaultEnvironment]);
  const seedKey = JSON.stringify(environmentSeed ?? null);
  const stableSeed = useMemo(() => environmentSeed, [seedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleOwner = (owner: string) => mounted.current && keyRef.current === owner;
  const matches = (value: NativeWorkPending | null, expected: NativeWorkPending) => value?.requestId === expected.requestId && value.payloadHash === expected.payloadHash;
  const currentEntry = (owner: string, expected: NativeWorkPending): NativeWorkPending | null => {
    if (!visibleOwner(owner)) return null;
    const latest = readNativeWorkPending(owner);
    if (matches(latest, expected)) return latest;
    if (latest) setPending(latest);
    return null;
  };
  const persist = (owner: string, value: NativeWorkPending | null): boolean => {
    const saved = writePending(owner, value);
    if (saved && visibleOwner(owner)) setPending(value);
    return saved;
  };
  const replaceCurrent = (owner: string, expected: NativeWorkPending, value: NativeWorkPending | null): boolean => !!currentEntry(owner, expected) && persist(owner, value);
  const releaseNotStarted = (owner: string, expected: NativeWorkPending): boolean => {
    if (!replaceCurrent(owner, expected, null)) return false;
    if (requestIds.current.get(expected.payloadHash) === expected.requestId) requestIds.current.delete(expected.payloadHash);
    if (readRecent(owner).some(([hash, id]) => hash === expected.payloadHash && id === expected.requestId)) forgetRecent(owner, expected.payloadHash);
    return true;
  };
  const staleResult = (requestId: string) => new Error(`Request ${requestId} belongs to an earlier draft or view. Its receipt did not replace the current request. Your draft is kept; check the original request before starting another copy.`);
  const check = async (owner: string, expected: NativeWorkPending): Promise<NativeWorkReceipt | null | undefined> => {
    if (!currentEntry(owner, expected)) return undefined;
    const ticket = Symbol();
    checkTicket.current = ticket;
    setChecking(true);
    setCheckError(null);
    try {
      const result = await rpc.call("native_work_receipt", { requestId: expected.requestId });
      const latest = currentEntry(owner, expected);
      if (!latest) return undefined;
      if (result.requestId !== expected.requestId) throw new Error("The returned receipt belongs to a different request. The original request remains unconfirmed.");
      if (latest.receipt && latest.receipt.outcome !== "unknown" && result.outcome === "unknown") return latest.receipt;
      if (result.notStarted) {
        if (!releaseNotStarted(owner, expected)) return undefined;
        toast.warning(result.notStarted.message, { description: "Nothing was started. Your draft is kept; you can try again." });
        return result;
      }
      const notify = !latest.notified && result.outcome !== "unknown";
      if (!replaceCurrent(owner, expected, { ...latest, receipt: result, notified: latest.notified || notify })) return undefined;
      rememberRecent(owner, expected.payloadHash, expected.requestId);
      if (notify && currentEntry(owner, expected)) onStartedRef.current?.({ kind: "routed", receipt: result });
      return result;
    } catch (cause) {
      const latest = currentEntry(owner, expected);
      if (!latest) return undefined;
      if (missingReceipt(cause) && !latest.receipt) return replaceCurrent(owner, expected, null) ? null : undefined;
      setCheckError(explain(cause));
      return undefined;
    } finally {
      if (visibleOwner(owner) && checkTicket.current === ticket) { checkTicket.current = null; setChecking(false); }
    }
  };

  useEffect(() => {
    checkTicket.current = null;
    setChecking(false);
    const saved = readNativeWorkPending(key);
    setPending(saved);
    setCheckError(null);
    setSubmitError(null);
    if (saved) void check(key, saved);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const release = (expected: NativeWorkPending) => {
    if (replaceCurrent(key, expected, null)) { checkTicket.current = null; setChecking(false); setCheckError(null); }
  };

  const startHere = async (request: NewThreadRequest) => {
    if (!rootThreadId) {
      const thread = await sdk.threads.spawn({ ...request });
      toast.success("Session started on this Mac");
      onStarted?.({ kind: "local", threadId: thread.id, grouped: false });
      return;
    }
    if (projectId && request.projectId !== projectId) throw new Error("Choose this conversation's project for a model alongside it. Your draft is kept.");
    // Visible and without a core parent: deleting the root never cascades to
    // this session, and a crash before adoption cannot leave a hidden orphan.
    // Adoption groups it by plugin metadata and hides it only once recorded.
    const child = await sdk.threads.spawn({
      ...request,
      pluginMetadata: { nativeConversation: { rootThreadId, sourceThreadId: source ?? rootThreadId, kind: "parallel" } },
    });
    try { await rpc.call("native_session_adopt", { rootThreadId, threadId: child.id, kind: "parallel" }); }
    catch (cause) {
      await sdk.threads.update({ threadId: child.id, visibility: "visible" }).catch(() => {});
      toast.warning("The model started in a separate native session", { description: `${explain(cause)} Open it rather than starting another copy.`, action: { label: "Open real thread", onClick: () => navigate.toThread(child.id) } });
      onStarted?.({ kind: "local", threadId: child.id, grouped: false });
      return;
    }
    toast.success("Model is working alongside", { description: "Its native session is in this conversation's model list." });
    onStarted?.({ kind: "local", threadId: child.id, grouped: true });
  };

  const startRouted = async (request: NewThreadRequest, machine: NativeWorkMachine) => {
    let destinationName = destination;
    if (destinationEdit === null && projectId && request.projectId !== projectId) {
      const chosen = await sdk.projects.get({ projectId: request.projectId }).catch(() => null);
      destinationName = chosen && chosen.kind !== "personal" ? nativeDestinationProjectName(chosen.name) : "";
    }
    const built = buildNativeWorkInput(request, {
      machine, attach: { images: attachImagesOn, files: attachFilesOn }, sourceThreadId, rootThreadId, destinationProjectName: destinationName, includeContext, structuredContext, contextFiles, contextBundle: imported?.bundle,
      routing: { workload: workloadEdit ?? inferNativeWorkload(destinationName || project?.name), needsNas, unattended, needsXcode },
    });
    if (!built.ok) throw new Error(built.error);
    const owner = key;
    if (!visibleOwner(owner)) throw new Error("The draft view changed before this task could start. Your draft is kept.");
    const hash = nativeWorkPayloadHash(built.input);
    // Re-read the store: another view of the same draft may have started work.
    const current = readNativeWorkPending(owner) ?? pending;
    if (current?.receipt) throw new Error("Review the receipt above first, then choose Start other work. Your draft is kept.");
    if (current && current.payloadHash !== hash) throw new Error(`Request ${current.requestId} is not resolved yet. Check it again, or release it with Start other work. Your draft is kept.`);
    // An ID from the recent list already has a receipt: the backend answers
    // with that original receipt, so it must not be reported as a new start.
    const earlier = current ? undefined : readRecent(owner).find(([known]) => known === hash)?.[1];
    const requestId = current?.requestId ?? earlier ?? requestIds.current.get(hash) ?? newRequestId();
    const entry: NativeWorkPending = current ?? { requestId, payloadHash: hash, machine, receipt: null, notified: false, savedAt: Date.now() };
    // Fail closed: without a durable ledger a reload could start a copy.
    const savedBeforeStart = readNativeWorkPending(owner);
    if (current ? !matches(savedBeforeStart, current) : savedBeforeStart !== null) throw staleResult(requestId);
    if (!persist(owner, entry)) throw new Error(STORAGE_UNAVAILABLE);
    requestIds.current.set(hash, requestId);
    let result: NativeWorkReceipt;
    try { result = await rpc.call("native_work_start", { ...built.input, requestId }); }
    catch (cause) {
      if (!currentEntry(owner, entry)) throw staleResult(requestId);
      if (/already belongs to a different task/i.test(explain(cause))) {
        // A stale or colliding ID: forget it so the next send gets a fresh one,
        // and never adopt the other task's receipt into this draft.
        if (!releaseNotStarted(owner, entry)) throw staleResult(requestId);
        throw new Error(`${explain(cause)} Your draft is kept; send it again for a new request.`);
      }
      // Never resend on our own. One read-only check tells a refusal (nothing
      // recorded) from a lost response (the original receipt).
      const recovered = await check(owner, entry);
      if (recovered?.notStarted) throw new Error(`${recovered.notStarted.message} Nothing was started. Your draft is kept; you can try again.`);
      if (recovered && recovered.outcome !== "unknown") { if (currentEntry(owner, entry)) toast.warning("The start response was lost; showing its original receipt"); return; }
      if (recovered) throw new Error(`Request ${requestId} is not confirmed. Your draft is kept for review. Check the receipt before sending anything else.`);
      if (recovered === null) throw new Error(`${explain(cause)} Nothing was started. Your draft is kept.`);
      throw new Error(`${explain(cause)} Request ${requestId} is not confirmed. Your draft is kept. Check the receipt before sending anything else; sending the same draft again reuses this request, so it cannot start twice.`);
    }
    const latest = currentEntry(owner, entry);
    if (!latest) throw staleResult(requestId);
    if (result.requestId !== requestId) throw new Error(`The returned receipt belongs to a different request. Request ${requestId} remains unconfirmed; check its receipt before sending anything else. Your draft is kept.`);
    if (latest.receipt && latest.receipt.outcome !== "unknown") return;
    if (result.notStarted) {
      if (!releaseNotStarted(owner, entry)) throw staleResult(requestId);
      throw new Error(`${result.notStarted.message} Nothing was started. Your draft is kept; you can try again.`);
    }
    const accepted = result.outcome !== "unknown";
    if (!replaceCurrent(owner, entry, { ...latest, receipt: result, notified: latest.notified || accepted })) throw staleResult(requestId);
    const notify = accepted && !latest.notified;
    rememberRecent(owner, hash, requestId);
    // Throwing keeps the draft: an unconfirmed start must stay reviewable, and
    // the visible receipt blocks a second start until the user resolves it.
    if (!accepted) throw new Error(`Request ${requestId} is not confirmed. Your draft is kept for review. Check the receipt before sending anything else.`);
    if (earlier) { toast.warning("This task was already started. Showing its original receipt. Change the text to run it again."); return; }
    if (!notify) return;
    toast.success(result.outcome === "started" ? `Started on ${machineName(result.route?.machine ?? machine)}` : `Sent to ${machineName(result.route?.machine ?? machine)}`);
    if (currentEntry(owner, entry)) onStartedRef.current?.({ kind: "routed", receipt: result });
  };

  const submit = async (request: NewThreadRequest) => {
    const submittedKey = key;
    let acquired = false;
    try {
      if (inFlight.current) throw new Error("A start is already in progress. Your draft is kept.");
      if (checking) throw new Error("Checking an earlier request first. Your draft is kept.");
      if (pending?.receipt) throw new Error("Review the receipt above first, then choose Start other work. Your draft is kept.");
      if (pending && placement === "here") throw new Error(`Request ${pending.requestId} is not resolved yet. Check it again, or release it with Start other work. Your draft is kept.`);
      inFlight.current = true;
      acquired = true;
      setSubmitError(null);
      if (placement === "here") await startHere(request);
      else await startRouted(request, placement);
    } catch (cause) {
      if (mounted.current && keyRef.current === submittedKey) setSubmitError(explain(cause));
      throw cause;
    } finally { if (acquired) inFlight.current = false; }
  };

  const machineHint = chosen.hint;
  const workspaceLine = routed
    ? routedSeed.state === "unsupported" ? `This conversation's workspace cannot move to another Mac. ${SUPPORTED_WORKSPACES}` : routedSeed.state === "loading" ? "Reading this conversation's workspace…" : `Workspace: ${describeNativeWorkspace(environmentSeed)} on the destination Mac, unless you change it below. Branch choices are kept; other workspace files are not copied.`
    : null;

  const previewRequest = buildRoutePreviewInput({
    machine: placement, destination, routing: { workload, needsNas, unattended, needsXcode }, selection: defaultSelection,
    environment: routedSeed.state === "ready" ? environmentSeed : undefined,
  });
  const allowanceProvider = defaultSelection?.providerId ?? null;

  return <div className="flex min-h-0 flex-col gap-3" data-native-work-composer data-placement={placement}>
    {submitError ? <p role="alert" className="rounded-md border border-destructive/30 p-2 text-xs text-destructive-text">{submitError}</p> : null}
    {pending ? <Receipt key={pending.requestId} pending={pending} checking={checking} checkError={checkError} onCheck={() => void check(key, pending)} onRelease={() => release(pending)} /> : null}
    {whereOn ? <fieldset className="flex flex-col gap-2 text-xs">
      <legend className="mb-1 font-medium text-foreground">Where it runs</legend>
      <div role="radiogroup" aria-label="Where it runs" className="flex flex-wrap gap-1">
        {MACHINES.map((item) => <button key={item.key} type="button" role="radio" aria-checked={chosen.key === item.key} title={item.hint} className={`${button} border border-border ${chosen.key === item.key ? "bg-accent text-foreground" : ""}`} onClick={() => setChoice(item.key)}>{item.label}</button>)}
      </div>
      <p className="text-muted-foreground">{machineHint}{placement === "Auto" ? " Work that is already running stays with the Mac that owns it." : ""}</p>
      {allowanceProvider && allowanceOn ? <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <AllowanceChip providerId={allowanceProvider} />
        <span data-testid="allowance-note" className="text-muted-foreground">{routed ? `This Mac's allowance for the starting model; ${placement === "Auto" ? "the chosen Mac" : machineName(placement)} uses its own sign-in.` : "This Mac's allowance for the starting model."}</span>
      </div> : null}
      {routed ? <>
        <div className="flex flex-wrap items-center gap-3">
          {projectOn ? <label className="flex items-center gap-1.5">Project on that Mac
            <input className={`${field} w-44`} value={destination} placeholder="Project name" aria-label="Destination project name" onChange={(event) => setDestinationEdit(event.target.value)} />
          </label> : null}
          <label className="flex items-center gap-1.5" hidden={profile.workloads.length === 0 || !workTypeOn}>Work type
            <select className={field} value={workload} aria-label="Work type" onChange={(event) => setWorkloadEdit(event.target.value)}>
              <option value="general">General</option>
              {profile.workloads.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={needsNas} onChange={(event) => setNeedsNas(event.target.checked)} />Needs the NAS</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={unattended} onChange={(event) => setUnattended(event.target.checked)} />Can run unattended</label>
          <label className="flex items-center gap-1.5" hidden={!xcodeOn} title="Only a Mac whose Xcode Fleet has checked can take this work"><input type="checkbox" checked={needsXcode} onChange={(event) => setNeedsXcode(event.target.checked)} />Needs Xcode</label>
          {source ? <label className="flex items-center gap-1.5"><input type="checkbox" checked={includeContext} onChange={(event) => setIncludeContext(event.target.checked)} />Include conversation context</label> : null}
          {source && includeContext ? <label className="flex items-center gap-1.5"><input type="checkbox" checked={structuredContext && !imported} disabled={!!imported} onChange={(event) => setStructuredContext(event.target.checked)} />Send structured context</label> : null}
        </div>
        {previewRequest && previewOn ? <RoutePreviewPanel request={previewRequest} providerId={defaultSelection?.providerId} label={placement === "Auto" ? "Auto" : machineName(placement)} /> : null}
        <p data-testid="native-work-context-hint" className="text-muted-foreground">{imported ? "The new session reads the saved context bundle in place of this conversation's context: its brief, decisions, recent messages, files and the commit the bundle states. " : source && includeContext ? structuredContext ? "The new session reads a versioned context bundle: the brief, decisions with their source messages, recent messages, what was left out and the verified repository commit. If the bundle is not supported there, a text snapshot is sent instead. " : "The new session gets a text snapshot of this conversation. Historic attachments and provider memory are not shared. " : "The new session starts without this conversation's context. "}Files attached below are transferred and verified before the task starts (up to 10 files, 8 MiB total). {workspaceLine} It runs with full permissions on that Mac.</p>
        <ContextControls sourceThreadId={source} filesText={contextFiles} onFilesText={setContextFiles} imported={imported} onImported={setImported} />
      </> : null}
    </fieldset> : null}
    <div className="min-h-[260px] rounded-lg border border-border p-2">
      <NewThreadComposer
        draftKey={key}
        defaultProjectId={projectId}
        defaultProviderId={defaultSelection?.providerId}
        defaultModel={defaultSelection?.model || undefined}
        defaultReasoningLevel={defaultSelection?.reasoningLevel}
        defaultServiceTier={defaultSelection?.serviceTier}
        defaultPermissionMode={routed ? "full" : undefined}
        defaultEnvironment={stableSeed}
        initialPrompt={source ? `Use this conversation as context: @thread:${source}\n\n` : undefined}
        placeholder={routed ? "Its own task, on the chosen Mac" : "Its own task, alongside the current work"}
        layout="document"
        onSubmit={submit}
      />
    </div>
  </div>;
}

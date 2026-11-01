import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";

const CONTROL_INPUT_PREFIX = "[fleet-control:v1]";
const REPLAY_INPUT_PREFIX = "[fleet-replay:v1]";
const ID = /^[a-f0-9]{64}$/;
export const CONTROL_PROTOCOL_VERSION = 1;

/** A project attachment on the machine that wrote the control; its bytes travel only through the owner transfer. */
export interface MirrorAttachment {
  type: "localImage" | "localFile";
  path: string;
  sourceProjectId: string;
  name: string;
  sizeBytes: number | null;
  mimeType: string | null;
}

/** The same attachment after the owner stored and verified it in the owning thread's project. */
export interface OwnerAttachment {
  type: "localImage" | "localFile";
  path: string;
  sourceProjectId: string;
  name: string;
  sizeBytes: number;
  mimeType: string | null;
  sha256: string;
}

export const MAX_MIRROR_ATTACHMENTS = 10;

export interface MirrorControlRequest {
  v: 1;
  id: string;
  localThreadId: string;
  targetServer: string;
  remoteThreadId: string;
  action: "send" | "steer" | "stop" | "respond";
  text: string;
  createdAt: number;
  expectedRemoteTurnId?: string;
  cancelRequestIds?: string[];
  attachments?: MirrorAttachment[];
  ownerAttachments?: OwnerAttachment[];
  /** respond only: the answer to one owner question or approval, bound to the fingerprint the user saw. */
  interaction?: MirrorInteractionAnswer;
}

export type MirrorInteractionResponse =
  | { kind: "approval"; decision: "deny" | "allow_once" | "allow_for_session" }
  | { kind: "user_answer"; answers: Record<string, { selected: string[]; freeText?: string }> };

export interface MirrorInteractionAnswer {
  interactionId: string;
  fingerprint: string;
  response: MirrorInteractionResponse;
}

/** The provider request id a mirror copy uses for an owner interaction; core scopes it per bridge process. */
export function interactionRequestId(ownerInteractionId: string): string {
  return `fleet-ix:${ownerInteractionId}`;
}

/** Map core's native resolution to the owner answer; null when it is not a question or approval answer. */
export function interactionResponseFrom(kind: "approval" | "user_question", resolution: unknown): MirrorInteractionResponse | null {
  if (typeof resolution !== "object" || resolution === null) return null;
  const value = resolution as { decision?: unknown; kind?: unknown; answers?: unknown };
  if (kind === "approval" && (value.decision === "deny" || value.decision === "allow_once" || value.decision === "allow_for_session")) return { kind: "approval", decision: value.decision };
  if (kind === "user_question" && value.kind === "user_answer" && typeof value.answers === "object" && value.answers !== null && !Array.isArray(value.answers)) {
    const answers: Record<string, { selected: string[]; freeText?: string }> = {};
    for (const [question, answer] of Object.entries(value.answers as Record<string, unknown>)) {
      const entry = answer as { selected?: unknown; freeText?: unknown };
      if (!Array.isArray(entry?.selected) || entry.selected.some((item) => typeof item !== "string")) return null;
      answers[question] = { selected: entry.selected as string[], ...(typeof entry.freeText === "string" && entry.freeText.trim() ? { freeText: entry.freeText } : {}) };
    }
    return { kind: "user_answer", answers };
  }
  return null;
}

/** The transport must resolve an uncertain previous dispatch, never blindly repeat it. */
export interface MirrorControlResult {
  state: "accepted" | "sent" | "queued" | "unknown" | "unavailable" | "failed";
  remoteRequestId?: string;
  message?: string;
}

export interface MirrorControlState extends Omit<MirrorControlResult, "state"> {
  state: MirrorControlResult["state"] | "pending" | "sending" | "cancelled";
  at: number;
  attempts: number;
  retryAt?: number;
  /** Last read-only owner/relay receipt check; it never grants permission to resend. */
  receiptCheckedAt?: number;
}

export interface MirrorReplayReference {
  requestId: string;
  token: string;
}

export function controlId(localThreadId: string, requestId: string, action: MirrorControlRequest["action"]): string {
  return createHash("sha256").update(`${localThreadId}\0${requestId}\0${action}`).digest("hex");
}

export function controlDir(feedDir: string): string {
  return join(feedDir, "controls");
}

function pathOf(dir: string, id: string, suffix: string): string {
  if (!ID.test(id)) throw new Error("Invalid Fleet control request id");
  return join(dir, `${id}.${suffix}.json`);
}

function atomicWrite(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeControl(feedDir: string, request: MirrorControlRequest): void {
  const dir = controlDir(feedDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = pathOf(dir, request.id, "request");
  if (existsSync(path)) {
    const old = readControl(feedDir, request.id);
    if (!old || old.localThreadId !== request.localThreadId || old.targetServer !== request.targetServer || old.remoteThreadId !== request.remoteThreadId || old.action !== request.action || old.text !== request.text || JSON.stringify(old.attachments ?? []) !== JSON.stringify(request.attachments ?? []) || JSON.stringify(old.interaction ?? null) !== JSON.stringify(request.interaction ?? null)) {
      throw new Error("Fleet control request identity was reused with different input");
    }
    return;
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(request), { mode: 0o600 });
  try {
    linkSync(tmp, path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const old = readControl(feedDir, request.id);
    if (!old || old.text !== request.text || old.action !== request.action || old.localThreadId !== request.localThreadId || old.targetServer !== request.targetServer || old.remoteThreadId !== request.remoteThreadId) throw new Error("Conflicting Fleet control request");
  } finally {
    unlinkSync(tmp);
  }
}

function validAnswer(value: unknown): boolean {
  const answer = value as Partial<MirrorInteractionAnswer> | undefined;
  return typeof answer?.interactionId === "string" && answer.interactionId.length > 0 && typeof answer.fingerprint === "string" && /^[a-f0-9]{64}$/.test(answer.fingerprint) && interactionResponseFrom(answer.response?.kind === "approval" ? "approval" : "user_question", answer.response?.kind === "approval" ? { decision: (answer.response as { decision?: unknown }).decision } : answer.response) !== null;
}

export function readControl(feedDir: string, id: string): MirrorControlRequest | null {
  try {
    const value = JSON.parse(readFileSync(pathOf(controlDir(feedDir), id, "request"), "utf8")) as Partial<MirrorControlRequest>;
    if (value.v !== 1 || value.id !== id || !ID.test(id) || typeof value.localThreadId !== "string" || typeof value.targetServer !== "string" || typeof value.remoteThreadId !== "string" || !["send", "steer", "stop", "respond"].includes(String(value.action)) || (value.action === "respond" && !validAnswer(value.interaction)) || typeof value.text !== "string" || !Number.isFinite(value.createdAt)) return null;
    return value as MirrorControlRequest;
  } catch {
    return null;
  }
}

export function listControls(feedDir: string): MirrorControlRequest[] {
  const dir = controlDir(feedDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const match = /^([a-f0-9]{64})\.request\.json$/.exec(name);
    const request = match ? readControl(feedDir, match[1]!) : null;
    return request ? [request] : [];
  }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** An exclusive durable claim closes the read/dispatch race across plugin processes. */
export function claimControl(feedDir: string, id: string): boolean {
  const dir = controlDir(feedDir);
  try { linkSync(pathOf(dir, id, "request"), pathOf(dir, id, "claimed")); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false; throw cause; }
}

export function releaseUnavailableClaim(feedDir: string, id: string): void {
  try { unlinkSync(pathOf(controlDir(feedDir), id, "claimed")); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
}

/** Cancellation races the same claim as dispatch; it never promises to undo a claimed send. */
export function cancelPendingControl(feedDir: string, id: string): boolean {
  const state = readControlState(feedDir, id);
  if (state && !["pending", "unavailable"].includes(state.state)) return false;
  if (!claimControl(feedDir, id)) return false;
  writeControlState(feedDir, id, { state: "cancelled", at: Date.now(), attempts: state?.attempts ?? 0, message: "Cancelled here before delivery to the owner." });
  return true;
}

export function readControlState(feedDir: string, id: string): MirrorControlState | null {
  try {
    const value = JSON.parse(readFileSync(pathOf(controlDir(feedDir), id, "state"), "utf8")) as MirrorControlState;
    if (!["pending", "sending", "accepted", "sent", "queued", "unknown", "unavailable", "failed", "cancelled"].includes(value.state) || !Number.isFinite(value.at) || !Number.isFinite(value.attempts)) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeControlState(feedDir: string, id: string, state: MirrorControlState): void {
  mkdirSync(controlDir(feedDir), { recursive: true, mode: 0o700 });
  atomicWrite(pathOf(controlDir(feedDir), id, "state"), state);
}

function hiddenInput(prefix: string, value: unknown): PromptInput {
  return { type: "text", text: prefix + JSON.stringify(value), mentions: [], visibility: "agent-only" };
}

function hiddenValue(input: readonly PromptInput[], prefix: string): unknown {
  for (const part of input) {
    if (part.type !== "text" || part.visibility !== "agent-only" || !part.text.startsWith(prefix)) continue;
    try { return JSON.parse(part.text.slice(prefix.length)); } catch { return null; }
  }
  return null;
}

/** Preserve this block on the destination send so its echo retains the request identity. */
export function mirrorControlInput(request: Pick<MirrorControlRequest, "id" | "text">): PromptInput[] {
  return [{ type: "text", text: request.text, mentions: [] }, hiddenInput(CONTROL_INPUT_PREFIX, { id: request.id })];
}

export function controlReference(input: readonly PromptInput[]): string | null {
  const value = hiddenValue(input, CONTROL_INPUT_PREFIX) as { id?: unknown } | null;
  return typeof value?.id === "string" && ID.test(value.id) ? value.id : null;
}

export function mirrorReplayInput(text: string, reference: MirrorReplayReference): PromptInput[] {
  return [{ type: "text", text, mentions: [] }, hiddenInput(REPLAY_INPUT_PREFIX, reference)];
}

export function replayReference(input: readonly PromptInput[]): MirrorReplayReference | null {
  const value = hiddenValue(input, REPLAY_INPUT_PREFIX) as Partial<MirrorReplayReference> | null;
  return typeof value?.requestId === "string" && typeof value.token === "string" ? { requestId: value.requestId, token: value.token } : null;
}

export function visibleMirrorInput(input: readonly PromptInput[]): PromptInput[] {
  return input.filter((part) => part.type !== "text" || part.visibility !== "agent-only" || (!part.text.startsWith(CONTROL_INPUT_PREFIX) && !part.text.startsWith(REPLAY_INPUT_PREFIX)));
}

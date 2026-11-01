import path from "node:path";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { decodePortableContextBundle, exportPortableContextBundle, portableContextManifest } from "./context-bundle";
import type { z } from "zod";
import type { OwnerCallOutcome } from "./transport";
import { MAX_OWNER_FILE_BYTES, ownerPathSchema, ownerWorkspaceContract, type OwnerWorkspaceMethod, type OwnerWorkspaceReceipt, type OwnerWorkspaceTarget } from "./workspace-contract";
export { ownerWorkspaceContract } from "./workspace-contract";

type PendingInteraction = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["get"]>>;
type Input<M extends OwnerWorkspaceMethod> = z.infer<typeof ownerWorkspaceContract[M]["input"]>;
type Output<M extends OwnerWorkspaceMethod> = z.infer<typeof ownerWorkspaceContract[M]["output"]>;
type Json = z.infer<typeof ownerWorkspaceContract.owner_workspace_receipt.output>["result"];
export interface OwnerWorkspaceOptions {
  identity(): Promise<{ serverId: string; machineKey: string }>;
  callOwner(target: { serverId: string; machineKey: string }, method: OwnerWorkspaceMethod, input: unknown, mutation: boolean): Promise<OwnerCallOutcome>;
  /** Machines that run only their own workloads: nothing is ever sent to them from here. */
  restricted?(machineKey: string): boolean;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const detail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 1800);
const within = (root: string, full: string) => full === root || full.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const missing = (cause: unknown) => /ENOENT|not found|does not exist|no such file|missing target/i.test(detail(cause));
function checkedPath(root: string, relative: string) {
  ownerPathSchema.parse(relative);
  const full = path.resolve(root, relative);
  if (!within(root, full)) throw new Error("Path is outside the owning environment");
  return full;
}
function decode(contentBase64: string, sha256: string) {
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64 || bytes.length > MAX_OWNER_FILE_BYTES || hash(bytes) !== sha256) throw new Error("File bytes do not match the supplied SHA256 or size limit");
  return bytes;
}
export function ownerInteractionFingerprint(item: PendingInteraction): string {
  return hash(canonical({ id: item.id, threadId: item.threadId, turnId: item.turnId, status: item.status, createdAt: item.createdAt, expiresAt: item.expiresAt, payload: item.payload, origin: item.origin }));
}
export function createOwnerWorkspace(bb: BbPluginApi, options: OwnerWorkspaceOptions) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_owner_workspace_receipts_v1 (
    request_id TEXT PRIMARY KEY, method TEXT NOT NULL, fingerprint TEXT NOT NULL,
    target_json TEXT NOT NULL, receipt_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  const table = "fleet_owner_workspace_receipts_v1";
  type Stored = { fingerprint: string; target_json: string; receipt_json: string };
  function stored(requestId: string) { return db.prepare(`SELECT fingerprint, target_json, receipt_json FROM ${table} WHERE request_id = ?`).get(requestId) as Stored | undefined; }
  function receipt(target: OwnerWorkspaceTarget, requestId: string, method: OwnerWorkspaceMethod | null, outcome: OwnerWorkspaceReceipt["outcome"], result: unknown = null, message: string | null = null): OwnerWorkspaceReceipt {
    return { owner: target, requestId, method, outcome, result: json(result), message, updatedAt: Date.now() };
  }
  function save(value: OwnerWorkspaceReceipt) {
    db.prepare(`UPDATE ${table} SET receipt_json = ?, updated_at = ? WHERE request_id = ?`).run(JSON.stringify(value), value.updatedAt, value.requestId);
    return value;
  }
  function claim(method: OwnerWorkspaceMethod, input: { target: OwnerWorkspaceTarget; requestId: string }) {
    return db.transaction(() => {
      const fingerprint = hash(canonical({ method, input }));
      const old = stored(input.requestId);
      if (old) {
        if (old.fingerprint !== fingerprint || old.target_json !== canonical(input.target)) throw new Error("Request ID already belongs to a different owner operation");
        return { existing: JSON.parse(old.receipt_json) as OwnerWorkspaceReceipt };
      }
      const pending = receipt(input.target, input.requestId, method, "unknown", null, "Claimed before dispatch; inspect this receipt before retrying");
      db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`).run(input.requestId, method, fingerprint, canonical(input.target), JSON.stringify(pending), pending.updatedAt);
      return { existing: null };
    })();
  }
  async function scope(target: OwnerWorkspaceTarget) {
    const env = await bb.sdk.environments.get({ environmentId: target.environmentId });
    if (env.id !== target.environmentId || env.hostId !== target.hostId || env.projectId !== target.projectId || env.status !== "ready" || !env.path || !path.isAbsolute(env.path)) throw new Error("Owner environment does not match the selected host and project or is not ready");
    const project = await bb.sdk.projects.get({ projectId: target.projectId });
    if (project.id !== target.projectId) throw new Error("Owner project is unavailable");
    if (target.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: target.threadId });
      if (thread.id !== target.threadId || thread.environmentId !== target.environmentId || thread.projectId !== target.projectId || thread.deletedAt !== null || thread.providerId === "fleet-mirror") throw new Error("Thread is not native to the selected owner environment");
    }
    const directory = await bb.sdk.hosts.directory({ hostId: target.hostId, path: env.path });
    if (!path.isAbsolute(directory.directory)) throw new Error("Owner root is not canonical");
    return { rootPath: directory.directory };
  }
  async function readFile(target: OwnerWorkspaceTarget, rootPath: string, relative: string) {
    const result = await bb.sdk.files.read({ hostId: target.hostId, rootPath, path: checkedPath(rootPath, relative) });
    if (result.sizeBytes > MAX_OWNER_FILE_BYTES) throw new Error("File exceeds the 8 MiB owner workspace limit");
    const bytes = Buffer.from(result.content, result.contentEncoding === "base64" ? "base64" : "utf8");
    const sha256 = hash(bytes);
    if (bytes.length !== result.sizeBytes || (result.sha256 && result.sha256 !== sha256)) throw new Error("Owner file bytes failed SHA256 verification");
    return { bytes, sha256, sizeBytes: bytes.length, mimeType: result.mimeType ?? null, sourceEncoding: result.contentEncoding };
  }
  async function preview(target: OwnerWorkspaceTarget, rootPath: string, enabled: boolean) {
    return enabled ? bb.sdk.files.createPreview({ hostId: target.hostId, rootPath, ttlMs: 5 * 60_000 }) : null;
  }
  async function mutate<M extends "owner_file_write" | "context_bundle_import" | "interaction_respond">(method: M, input: Input<M>, action: (args: { rootPath: string; markDispatched(): void; progress(value: unknown): void }) => Promise<unknown>) {
    const claimed = claim(method, input);
    if (claimed.existing) return claimed.existing;
    let dispatched = false;
    let progress: unknown = null;
    try {
      const { rootPath } = await scope(input.target);
      const result = await action({ rootPath, markDispatched() { dispatched = true; }, progress(value) {
        progress = value;
        save(receipt(input.target, input.requestId, method, "unknown", progress, "Operation in progress; do not resend"));
      } });
      return save(receipt(input.target, input.requestId, method, "applied", result));
    } catch (cause) {
      return save(receipt(input.target, input.requestId, method, dispatched ? "unknown" : "refused", progress, detail(cause)));
    }
  }
  const local = {
    async owner_file_stat(input: Input<"owner_file_stat">) {
      const { target, path: relative } = input;
      const { rootPath } = await scope(target);
      const base = { owner: target, rootPath, path: relative, preview: null };
      if (relative === ".") return { ...base, kind: "directory" as const, sizeBytes: null, sha256: null };
      try {
        const file = await readFile(target, rootPath, relative);
        return { ...base, kind: "file" as const, sizeBytes: file.sizeBytes, sha256: file.sha256, preview: await preview(target, rootPath, input.preview) };
      } catch (cause) {
        if (missing(cause)) return { ...base, kind: "missing" as const, sizeBytes: null, sha256: null };
        if (/directory|regular file|EISDIR/i.test(detail(cause))) {
          const directory = await bb.sdk.hosts.directory({ hostId: target.hostId, path: checkedPath(rootPath, relative) });
          if (!within(rootPath, directory.directory)) throw new Error("Directory symlink escapes the owning environment");
          return { ...base, kind: "directory" as const, sizeBytes: null, sha256: null };
        }
        throw cause;
      }
    },
    async owner_file_list(input: Input<"owner_file_list">) {
      const { rootPath } = await scope(input.target);
      const directory = await bb.sdk.hosts.directory({ hostId: input.target.hostId, path: checkedPath(rootPath, input.path) });
      if (!within(rootPath, directory.directory)) throw new Error("Directory symlink escapes the owning environment");
      const entries = directory.entries.map((entry) => {
        if (!within(rootPath, entry.path)) throw new Error("Directory entry escapes the owning environment");
        return { name: entry.name, path: ownerPathSchema.parse(path.relative(rootPath, entry.path)), kind: entry.kind };
      }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).filter((entry) => input.after === undefined || entry.name > input.after);
      return { owner: input.target, rootPath, path: input.path, entries: entries.slice(0, input.limit), nextAfter: entries.length > input.limit ? entries[input.limit - 1]!.name : null };
    },
    async owner_file_read(input: Input<"owner_file_read">) {
      const { rootPath } = await scope(input.target);
      const file = await readFile(input.target, rootPath, input.path);
      if (input.expectedSha256 && input.expectedSha256 !== file.sha256) throw new Error("File changed since the selected SHA256");
      if (input.offset > file.sizeBytes) throw new Error("Read offset exceeds the owner file length");
      const end = Math.min(file.sizeBytes, input.offset + input.length);
      return { owner: input.target, rootPath, path: input.path, contentBase64: file.bytes.subarray(input.offset, end).toString("base64"), sha256: file.sha256, sizeBytes: file.sizeBytes, mimeType: file.mimeType, sourceEncoding: file.sourceEncoding, offset: input.offset, nextOffset: end < file.sizeBytes ? end : null, preview: await preview(input.target, rootPath, input.preview) };
    },
    async owner_file_preview(input: Input<"owner_file_preview">) {
      const { rootPath } = await scope(input.target);
      checkedPath(rootPath, input.path);
      const lease = await bb.sdk.files.createPreview({ hostId: input.target.hostId, rootPath, ttlMs: 5 * 60_000 });
      if (!/^\/api\/v1\/file-previews\/[A-Za-z0-9_-]+$/.test(lease.baseUrl) || !Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs <= Date.now()) throw new Error("Native preview lease is invalid or expired");
      const loopback = new URL(bb.server.loopbackBaseUrl);
      if (!["http:", "https:"].includes(loopback.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(loopback.hostname) || loopback.username || loopback.password) throw new Error("Native owner loopback route is unavailable");
      const url = new URL(`${lease.baseUrl}/${input.path.split("/").map(encodeURIComponent).join("/")}`, loopback);
      const response = await fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (response.status !== 200) throw new Error(`Native owner preview validation failed (${response.status})`);
      const length = response.headers.get("content-length");
      const sizeBytes = length !== null && /^\d+$/.test(length) ? Number(length) : NaN;
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || response.headers.get("accept-ranges")?.toLowerCase() !== "bytes") throw new Error("Native owner range preview metadata is unavailable");
      if (lease.expiresAtMs <= Date.now()) throw new Error("Native preview lease expired during validation");
      return { owner: input.target, rootPath, path: input.path, sizeBytes, mimeType: response.headers.get("content-type"), etag: response.headers.get("etag"), rangeSupported: true as const, preview: lease };
    },
    async owner_file_write(input: Input<"owner_file_write">) {
      return mutate("owner_file_write", input, async ({ rootPath, markDispatched }) => {
        const bytes = decode(input.contentBase64, input.sha256);
        const absolutePath = checkedPath(rootPath, input.path);
        const found = await bb.sdk.hosts.pathsExist({ hostId: input.target.hostId, paths: [absolutePath] });
        if (input.expectedSha256 === null) {
          if (found.existence[absolutePath]) throw new Error("Create refused: the destination already exists");
        } else {
          const before = await readFile(input.target, rootPath, input.path);
          if (before.sha256 !== input.expectedSha256) throw new Error("Compare-and-swap refused: the destination changed");
        }
        markDispatched();
        await bb.sdk.files.write({ hostId: input.target.hostId, rootPath, path: absolutePath, content: input.contentBase64, contentEncoding: "base64", expectedSha256: input.expectedSha256, createParents: false });
        const after = await readFile(input.target, rootPath, input.path);
        if (after.sha256 !== input.sha256 || after.sizeBytes !== bytes.length) throw new Error("Written owner bytes failed verification");
        return { path: input.path, absolutePath, sha256: after.sha256, sizeBytes: after.sizeBytes, hostId: input.target.hostId, environmentId: input.target.environmentId, projectId: input.target.projectId };
      });
    },
    async context_bundle_export(input: Input<"context_bundle_export">) {
      const { target, ...selection } = input;
      const { rootPath } = await scope(target);
      return exportPortableContextBundle(bb, { target, rootPath, selection, readFile: (relative) => readFile(target, rootPath, relative) });
    },
    async context_bundle_import(input: Input<"context_bundle_import">) {
      return mutate("context_bundle_import", input, async ({ rootPath, markDispatched, progress }) => {
        const portable = input.bundle ? decodePortableContextBundle(input.bundle) : null;
        const files = (portable?.files ?? input.files).map((file) => ({ ...file, bytes: decode(file.contentBase64, file.sha256) }));
        if (files.reduce((sum, file) => sum + file.bytes.length, 0) > MAX_OWNER_FILE_BYTES) throw new Error("Context bundle exceeds the 8 MiB total byte limit");
        const folder = `.bb/fleet-context/${input.requestId}`;
        const attachments: unknown[] = [];
        const runtimeFiles: unknown[] = [];
        for (const [index, file] of files.entries()) {
          markDispatched();
          const uploaded = await bb.sdk.projects.attachments.upload({ projectId: input.target.projectId, filename: file.name, mimeType: file.mimeType, clientFile: file.bytes });
          attachments.push({ ...uploaded, sourceProjectId: input.target.projectId, sha256: file.sha256, verified: false });
          progress({ attachments, runtimeFiles });
          const hosted = await bb.sdk.projects.attachments.read({ projectId: input.target.projectId, path: uploaded.path });
          if (hosted.sizeBytes !== file.bytes.length || hash(hosted.bytes) !== file.sha256) throw new Error("Destination project upload failed byte verification");
          attachments[attachments.length - 1] = { ...uploaded, sourceProjectId: input.target.projectId, sha256: file.sha256, verified: true };
          progress({ attachments, runtimeFiles });
          const relative = `${folder}/${index}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
          await bb.sdk.files.write({ hostId: input.target.hostId, rootPath, path: checkedPath(rootPath, relative), content: file.contentBase64, contentEncoding: "base64", expectedSha256: null, createParents: true });
          const copied = await readFile(input.target, rootPath, relative);
          if (copied.sha256 !== file.sha256 || copied.sizeBytes !== file.bytes.length) throw new Error("Destination host copy failed byte verification");
          runtimeFiles.push({ name: file.name, path: relative, absolutePath: checkedPath(rootPath, relative), sha256: copied.sha256, sizeBytes: copied.sizeBytes, hostId: input.target.hostId, environmentId: input.target.environmentId });
          progress({ attachments, runtimeFiles });
        }
        const manifest = { owner: input.target, context: input.context, contextSourceVerification: "caller-supplied", contextFormat: portable ? "portable-v1" : "legacy-unversioned", portableContext: portable ? portableContextManifest(portable.bundle) : null, attachments, runtimeFiles };
        const bytes = Buffer.from(JSON.stringify(manifest));
        const manifestPath = `${folder}/context.json`;
        markDispatched();
        await bb.sdk.files.write({ hostId: input.target.hostId, rootPath, path: checkedPath(rootPath, manifestPath), content: bytes.toString("base64"), contentEncoding: "base64", expectedSha256: null, createParents: true });
        const written = await readFile(input.target, rootPath, manifestPath);
        if (written.sha256 !== hash(bytes)) throw new Error("Context manifest failed byte verification");
        return { ...manifest, manifestPath, manifestSha256: written.sha256 };
      });
    },
    async interaction_list(input: Input<"interaction_list">) {
      await scope(input.target);
      const all = await bb.sdk.threads.interactions.list({ threadId: input.target.threadId! });
      const pending = all.filter((item) => item.threadId === input.target.threadId && item.status === "pending" && (item.expiresAt == null || item.expiresAt > Date.now()));
      const bounded = pending.filter((item) => Buffer.byteLength(JSON.stringify(item.payload)) <= 64_000);
      return { owner: input.target, interactions: bounded.slice(0, 20).map((item) => ({ id: item.id, threadId: item.threadId, turnId: item.turnId ?? null, kind: item.payload.kind, createdAt: item.createdAt, expiresAt: item.expiresAt ?? null, fingerprint: ownerInteractionFingerprint(item), payload: json(item.payload) })), truncated: pending.length > 20 || bounded.length !== pending.length };
    },
    async interaction_respond(input: Input<"interaction_respond">) {
      return mutate("interaction_respond", input, async ({ markDispatched }) => {
        const item = await bb.sdk.threads.interactions.get({ threadId: input.target.threadId!, interactionId: input.interactionId });
        if (item.threadId !== input.target.threadId || item.id !== input.interactionId || item.status !== "pending" || (item.expiresAt != null && item.expiresAt <= Date.now()) || ownerInteractionFingerprint(item) !== input.expectedFingerprint) throw new Error("Native interaction changed or expired; reload before answering");
        const response = input.response;
        if (response.kind === "user_answer" && item.payload.kind === "user_question") {
          const questions = item.payload.questions;
          if (Object.keys(response.answers).length !== questions.length) throw new Error("Answer every native question exactly once");
          for (const question of questions) {
            const answer = response.answers[question.id];
            if (!Object.hasOwn(response.answers, question.id) || !answer || new Set(answer.selected).size !== answer.selected.length || (!question.multiSelect && answer.selected.length > 1) || answer.selected.some((value) => !question.options?.some((option) => option.value === value)) || (answer.freeText && !question.allowFreeText) || (answer.selected.length === 0 && !answer.freeText)) throw new Error("Answer does not match the native question choices");
          }
          markDispatched();
          await bb.sdk.threads.interactions.resolve({ threadId: item.threadId, interactionId: item.id, resolution: { kind: "user_answer", answers: response.answers } });
        } else if (response.kind === "approval" && item.payload.kind === "approval") {
          if (!item.payload.availableDecisions.includes(response.decision)) throw new Error("Decision is not available on this native approval");
          markDispatched();
          await bb.sdk.threads.interactions.resolve({ threadId: item.threadId, interactionId: item.id, resolution: response.decision === "deny" ? { decision: "deny" } : { decision: response.decision, grantedPermissions: null } });
        } else if (response.kind === "plugin" && item.payload.kind === "plugin") {
          markDispatched();
          await bb.sdk.threads.interactions.respond({ threadId: item.threadId, interactionId: item.id, value: response.value });
        } else throw new Error("Response kind does not match the native interaction");
        return { interactionId: item.id, threadId: item.threadId, status: "submitted", fingerprint: input.expectedFingerprint };
      });
    },
    async owner_workspace_receipt(input: Input<"owner_workspace_receipt">) {
      const row = stored(input.requestId);
      if (!row) return receipt(input.target, input.requestId, null, "unknown", null, "No owner receipt exists for this request ID; do not infer non-delivery");
      if (row.target_json !== canonical(input.target)) throw new Error("Receipt does not belong to the selected owner target");
      return JSON.parse(row.receipt_json) as OwnerWorkspaceReceipt;
    },
  };
  async function dispatch<M extends OwnerWorkspaceMethod>(method: M, raw: unknown): Promise<Output<M>> {
    const input = ownerWorkspaceContract[method].input.parse(raw);
    const identity = await options.identity();
    if (input.target.serverId === identity.serverId) {
      if (input.target.machineKey !== identity.machineKey) throw new Error("Selected owner machine does not match this server");
      const result = await (local[method] as (input: unknown) => Promise<unknown>)(input);
      return ownerWorkspaceContract[method].output.parse(result) as Output<M>;
    }
    const mutation = method === "owner_file_write" || method === "context_bundle_import" || method === "interaction_respond";
    let result: OwnerCallOutcome;
    if (options.restricted?.(input.target.machineKey)) result = { ok: false, kind: "unavailable", message: `no-authenticated-owner-route: ${input.target.machineKey}` };
    else {
      try { result = await options.callOwner({ serverId: input.target.serverId, machineKey: input.target.machineKey }, method, input, mutation); }
      catch (cause) { result = { ok: false, kind: mutation ? "unknown" : "unavailable", message: detail(cause) }; }
    }
    if (!result.ok) {
      if ("requestId" in input) return receipt(input.target, String(input.requestId), method, result.kind, null, result.message.slice(0, 1800)) as Output<M>;
      throw new Error(`${result.kind}: ${result.message}`);
    }
    try {
      const parsed = ownerWorkspaceContract[method].output.parse(result.result);
      if (method === "context_bundle_export") {
        const bundle = ownerWorkspaceContract.context_bundle_export.output.parse(parsed);
        if (canonical(bundle.source.owner) !== canonical(input.target)) throw new Error("Portable source owner does not match the requested owner");
        const requested = ownerWorkspaceContract.context_bundle_export.input.parse(input);
        const { target: _target, selectedFiles, ...narrative } = requested;
        if (canonical(bundle.narrative) !== canonical({ ...narrative, provenance: "caller-supplied" }) || canonical(bundle.files.map((file) => file.path)) !== canonical(selectedFiles.map((file) => file.path))) throw new Error("Portable response does not match the requested narrative and selected files");
        decodePortableContextBundle(bundle);
        return bundle as Output<M>;
      }
      if (!("owner" in parsed) || canonical(parsed.owner) !== canonical(input.target)) throw new Error("Response owner identity does not match the selected server, host and environment");
      if (method === "owner_file_preview" && ("path" in parsed && "path" in input ? parsed.path !== input.path : true)) throw new Error("Preview response path does not match the selected owner file");
      if ("requestId" in input && (!("requestId" in parsed) || parsed.requestId !== input.requestId || (method !== "owner_workspace_receipt" && (!("method" in parsed) || parsed.method !== method)))) throw new Error("Response request or operation does not match the pending owner intent");
      return parsed as Output<M>;
    } catch (cause) {
      if ("requestId" in input) return receipt(input.target, String(input.requestId), method, "unknown", null, detail(cause)) as Output<M>;
      throw cause;
    }
  }
  return { handlers: {
    owner_file_stat: (input: Input<"owner_file_stat">) => dispatch("owner_file_stat", input),
    owner_file_list: (input: Input<"owner_file_list">) => dispatch("owner_file_list", input),
    owner_file_read: (input: Input<"owner_file_read">) => dispatch("owner_file_read", input),
    owner_file_preview: (input: Input<"owner_file_preview">) => dispatch("owner_file_preview", input),
    owner_file_write: (input: Input<"owner_file_write">) => dispatch("owner_file_write", input),
    context_bundle_export: (input: Input<"context_bundle_export">) => dispatch("context_bundle_export", input),
    context_bundle_import: (input: Input<"context_bundle_import">) => dispatch("context_bundle_import", input),
    interaction_list: (input: Input<"interaction_list">) => dispatch("interaction_list", input),
    interaction_respond: (input: Input<"interaction_respond">) => dispatch("interaction_respond", input),
    owner_workspace_receipt: (input: Input<"owner_workspace_receipt">) => dispatch("owner_workspace_receipt", input),
  } };
}

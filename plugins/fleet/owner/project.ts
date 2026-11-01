import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { OwnerCallOutcome } from "./transport";
import { ownerProjectContract, projectRemoteSchema, TRANSFER_FILE_BYTES, TRANSFER_TOTAL_BYTES, type OwnerProjectMethod, type OwnerProjectReceipt, type ProjectOwnerTarget } from "./project-contract";
export { ownerProjectContract } from "./project-contract";

type Input<M extends OwnerProjectMethod> = z.infer<typeof ownerProjectContract[M]["input"]>;
type Output<M extends OwnerProjectMethod> = z.infer<typeof ownerProjectContract[M]["output"]>;
type Mutation = "project_prepare" | "transfer_manifest_apply";
export interface OwnerProjectOptions {
  identity(): Promise<{ serverId: string; machineKey: string; hostId: string | null }>;
  callOwner(target: { serverId: string; machineKey: string; hostId: string }, method: OwnerProjectMethod, input: unknown, mutation: boolean): Promise<OwnerCallOutcome>;
  /** Machines that run only their own workloads: nothing is ever sent to them from here. */
  restricted?(machineKey: string): boolean;
  inspectRepository?(rootPath: string): Promise<{ rootPath: string; remoteUrl: string | null }>;
  now?: () => number;
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const json = (value: unknown): z.infer<typeof ownerProjectContract.transfer_receipt.output>["result"] => JSON.parse(JSON.stringify(value));
const errorText = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/(?:https?|ssh):\/\/[^\s/@]+:[^\s/@]+@[^\s]+/g, "[credential URL omitted]").slice(0, 1500);
};
const within = (root: string, value: string) => value === root || value.startsWith(root + path.sep);
const absent = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === "ENOENT";
export function transferPathAllowed(relative: string): boolean {
  const parts = relative.toLowerCase().split("/");
  return parts.every((part) => !part.startsWith(".env") && ![".git", ".ssh", ".aws", ".azure", ".gnupg", ".npmrc", ".pypirc", ".netrc", "credentials", "credential", "secrets", "secret", "keys", "key", "authorized_keys", "known_hosts"].includes(part) && !/(?:^|[._-])(?:credentials?|secrets?|tokens?|keys?)(?:[._-]|$)/.test(part) && !/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(part) && !/\.(?:pem|key|p12|pfx|kdbx|keystore)$/.test(part));
}
async function noSymlinks(absolutePath: string, allowMissing = false) {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  const parts = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const [index, component] of parts.entries()) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Symlinks are not permitted in owner project or transfer paths");
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error("A selected parent is not a directory");
    } catch (cause) { if (allowMissing && absent(cause)) return; throw cause; }
  }
}
async function gitRead(rootPath: string, args: string[]): Promise<{ code: number; text: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_") && !key.startsWith("BB_"))) as Record<string, string>;
  return new Promise((resolve) => execFile("git", ["--no-optional-locks", "-C", rootPath, ...args], { timeout: 15_000, maxBuffer: 64 * 1024, env }, (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, text: String(stdout).trim() })));
}
async function inspectRepository(rootPath: string) {
  const root = await gitRead(rootPath, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0 || root.text !== rootPath) throw new Error("The selected environment is not the root of its actual Git checkout");
  const origin = await gitRead(rootPath, ["config", "--local", "--get-all", "remote.origin.url"]);
  if (origin.code !== 0 && origin.code !== 1) throw new Error("The owner could not inspect its repository origin");
  if (origin.text.includes("\n")) throw new Error("The owner repository has ambiguous origin URLs");
  const remoteUrl = origin.code === 1 ? null : projectRemoteSchema.safeParse(origin.text);
  if (remoteUrl !== null && !remoteUrl.success) throw new Error("The actual repository origin is not a supported credential-free remote; its value is omitted");
  return { rootPath, remoteUrl: remoteUrl?.data ?? null };
}
const gitStatusSchema = z.object({
  outcome: z.string(), workspace: z.object({
    checkout: z.object({ kind: z.enum(["branch", "detached", "unborn", "unknown"]), headSha: z.string().nullable().optional(), branchName: z.string().nullable().optional() }).passthrough(),
    branch: z.object({ currentBranch: z.string().nullable() }).passthrough(),
    workingTree: z.object({ hasUncommittedChanges: z.boolean() }).passthrough(),
  }).optional(),
}).passthrough();

export function createOwnerProject(bb: BbPluginApi, options: OwnerProjectOptions) {
  const now = options.now ?? Date.now;
  const db = bb.storage.database();
  db.exec("CREATE TABLE IF NOT EXISTS fleet_owner_project_receipts_v1 (request_id TEXT PRIMARY KEY, method TEXT NOT NULL, fingerprint TEXT NOT NULL, target_json TEXT NOT NULL, receipt_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  type Row = { method: Mutation; fingerprint: string; target_json: string; receipt_json: string };
  const get = (requestId: string) => db.prepare("SELECT method, fingerprint, target_json, receipt_json FROM fleet_owner_project_receipts_v1 WHERE request_id = ?").get(requestId) as Row | undefined;
  const receipt = (owner: ProjectOwnerTarget, requestId: string, method: Mutation | null, fingerprint: string | null, outcome: OwnerProjectReceipt["outcome"], result: unknown = null, message: string | null = null): OwnerProjectReceipt => ({ owner, requestId, method, fingerprint, outcome, result: json(result), message, updatedAt: now() });
  function save(value: OwnerProjectReceipt) {
    db.prepare("UPDATE fleet_owner_project_receipts_v1 SET receipt_json = ?, updated_at = ? WHERE request_id = ?").run(JSON.stringify(value), value.updatedAt, value.requestId);
    return value;
  }
  function claim(method: Mutation, input: Input<Mutation>) {
    return db.transaction(() => {
      const fingerprint = digest(canonical({ method, input }));
      const old = get(input.requestId);
      if (old) {
        if (old.fingerprint !== fingerprint || old.target_json !== canonical(input.target)) return { fingerprint, old: receipt(input.target, input.requestId, method, fingerprint, "refused", null, "Request ID already belongs to another owner operation") };
        return { fingerprint, old: ownerProjectContract.transfer_receipt.output.parse(JSON.parse(old.receipt_json)) };
      }
      const pending = receipt(input.target, input.requestId, method, fingerprint, "unknown", null, "Durably claimed before dispatch; reconcile this receipt before starting another operation");
      db.prepare("INSERT INTO fleet_owner_project_receipts_v1 VALUES (?, ?, ?, ?, ?, ?)").run(input.requestId, method, fingerprint, canonical(input.target), JSON.stringify(pending), pending.updatedAt);
      return { fingerprint, old: null };
    })();
  }
  async function localIdentity(target: ProjectOwnerTarget) {
    const identity = await options.identity();
    if (identity.serverId !== target.serverId || identity.machineKey !== target.machineKey || identity.hostId === null || identity.hostId !== target.hostId) throw new Error("Selected server, machine and exact authenticated local host do not match this owner");
    const host = await bb.sdk.hosts.get({ hostId: target.hostId });
    if (host.id !== target.hostId || host.status !== "connected") throw new Error("The exact owner host is not connected");
  }
  async function scope(target: ProjectOwnerTarget) {
    await localIdentity(target);
    if (target.projectId === null || target.environmentId === null) throw new Error("Select an existing owner project and environment");
    const [environment, project] = await Promise.all([bb.sdk.environments.get({ environmentId: target.environmentId }), bb.sdk.projects.get({ projectId: target.projectId })]);
    if (project.id !== target.projectId || environment.id !== target.environmentId || environment.hostId !== target.hostId || environment.projectId !== target.projectId || environment.status !== "ready" || !environment.path || !path.isAbsolute(environment.path)) throw new Error("Environment does not match the selected owner host and project or is not ready");
    const rootPath = await realpath(environment.path);
    await noSymlinks(rootPath);
    if (!(await lstat(rootPath)).isDirectory()) throw new Error("Owner checkout root is not a directory");
    const directory = await bb.sdk.hosts.directory({ hostId: target.hostId, path: environment.path });
    if (directory.directory !== rootPath) throw new Error("Native host directory and authenticated owner filesystem disagree");
    return { rootPath, project };
  }
  async function verify(input: Input<"project_verify">): Promise<Output<"project_verify">> {
    const base = { owner: input.target, available: false, verified: false, repository: null, mismatches: [], message: null, observedAt: now() };
    try {
      const { rootPath } = await scope(input.target);
      const native = await bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "workspaceStatus", input: { environmentId: input.target.environmentId! }, outputSchema: gitStatusSchema });
      if (native.outcome !== "available" || !native.workspace || native.workspace.checkout.kind === "unknown") throw new Error("Native Git status is unavailable or its checkout identity is unknown");
      const rawIdentity = await (options.inspectRepository ?? inspectRepository)(rootPath);
      if (rawIdentity.rootPath !== rootPath) throw new Error("Repository root does not match this owner environment");
      const identity = { rootPath, remoteUrl: rawIdentity.remoteUrl === null ? null : projectRemoteSchema.parse(rawIdentity.remoteUrl) };
      const commit = native.workspace.checkout.kind === "unborn" ? null : native.workspace.checkout.headSha ?? null;
      const repository = { ...identity, branch: native.workspace.branch.currentBranch, commit, dirty: native.workspace.workingTree.hasUncommittedChanges };
      const mismatches = (Object.keys(input.expected) as (keyof typeof input.expected)[]).filter((key) => input.expected[key] !== repository[key]);
      return ownerProjectContract.project_verify.output.parse({ ...base, available: true, verified: mismatches.length === 0, repository, mismatches });
    } catch (cause) { return { ...base, message: errorText(cause) }; }
  }
  async function mutate<M extends Mutation>(method: M, input: Input<M>): Promise<OwnerProjectReceipt> {
    const claimed = claim(method, input);
    if (claimed.old) return claimed.old;
    let dispatched = false;
    let result: unknown = null;
    const progress = (value: unknown) => { result = value; save(receipt(input.target, input.requestId, method, claimed.fingerprint, "unknown", value, "Owner operation in progress; do not resend")); };
    try {
      await localIdentity(input.target);
      if (method === "project_prepare") {
        const args = input as Input<"project_prepare">;
        const prepare = args.prepare;
        const full = prepare.mode === "clone_source" ? prepare.destinationPath : prepare.path;
        await noSymlinks(full, prepare.mode === "clone_source");
        if (prepare.mode === "clone_source") {
          try { await lstat(full); throw new Error("Clone refused: the destination already exists, including empty directories"); } catch (cause) { if (!absent(cause)) throw cause; }
        } else if (!(await lstat(full)).isDirectory() || await realpath(full) !== full) throw new Error("Register an existing canonical directory without symlinks");
        let project: Awaited<ReturnType<typeof bb.sdk.projects.get>> | null = null;
        if (input.target.projectId !== null) {
          project = await bb.sdk.projects.get({ projectId: input.target.projectId });
          if (project.id !== input.target.projectId || project.sources.some((source) => source.hostId === input.target.hostId)) throw new Error("The selected project already has a source on this host or is unavailable");
        }
        if (prepare.mode !== "clone_source") {
          const actual = await (options.inspectRepository ?? inspectRepository)(full);
          if (actual.rootPath !== full || actual.remoteUrl !== prepare.expectedRemoteUrl) throw new Error("Existing checkout origin/root does not match the explicitly selected repository");
        } else if (project?.gitRemoteUrl && project.gitRemoteUrl !== prepare.remoteUrl) throw new Error("Clone remote does not match the selected owner's project anchor");
        dispatched = true;
        if (prepare.mode === "create_project") {
          const created = await bb.sdk.projects.create({ name: prepare.name, source: { type: "local_path", hostId: input.target.hostId, path: full } });
          result = { projectId: created.id, sources: created.sources.map((source) => ({ id: source.id, hostId: source.hostId, path: source.path })), environmentId: null, path: full, next: "Use the native composer to attach a ready environment, then project_verify before transferring files" };
        } else {
          const source = await bb.sdk.projects.sources.add(prepare.mode === "clone_source" ? { projectId: input.target.projectId!, type: "clone", hostId: input.target.hostId, targetPath: full, remoteUrl: prepare.remoteUrl } : { projectId: input.target.projectId!, type: "local_path", hostId: input.target.hostId, path: full });
          progress({ projectId: input.target.projectId, sourceId: source.id, path: source.path, environmentId: null });
          if (source.hostId !== input.target.hostId || source.projectId !== input.target.projectId || source.path !== full) throw new Error("Native source result does not match the selected owner path and project");
          const actual = await (options.inspectRepository ?? inspectRepository)(full);
          const expected = prepare.mode === "clone_source" ? prepare.remoteUrl : prepare.expectedRemoteUrl;
          if (actual.rootPath !== full || actual.remoteUrl !== expected) throw new Error("Prepared checkout did not verify against its selected repository origin");
          result = { projectId: source.projectId, sourceId: source.id, path: source.path, environmentId: null, remoteUrl: actual.remoteUrl, next: "Use the native composer to attach a ready environment, then project_verify before transferring files" };
        }
      } else {
        const args = input as Input<"transfer_manifest_apply">;
        const { rootPath } = await scope(input.target);
        const files = args.files.map((file) => {
          if (!transferPathAllowed(file.path)) throw new Error("Selected manifest contains a protected secret, key, credential or Git path");
          const bytes = Buffer.from(file.contentBase64, "base64");
          if (bytes.toString("base64") !== file.contentBase64 || bytes.length !== file.sizeBytes || bytes.length > TRANSFER_FILE_BYTES || digest(bytes) !== file.sha256) throw new Error("Selected file bytes do not match canonical base64, SHA256 or the 1 MiB limit");
          if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(bytes.toString("utf8"))) throw new Error("Private key material is not permitted in a selected transfer");
          const full = path.resolve(rootPath, file.path);
          if (!within(rootPath, full)) throw new Error("Selected path escapes the owner environment");
          return { ...file, full };
        });
        if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > TRANSFER_TOTAL_BYTES) throw new Error("Selected files exceed the 8 MiB total limit");
        for (const file of files) {
          await noSymlinks(file.full, true);
          try { await lstat(file.full); throw new Error("Transfer refused: a selected destination already exists; nothing will be overwritten"); } catch (cause) { if (!absent(cause)) throw cause; }
        }
        const applied: { path: string; sha256: string; sizeBytes: number }[] = [];
        for (const file of files) {
          const currentScope = await scope(input.target);
          if (currentScope.rootPath !== rootPath) throw new Error("Owner environment path changed during the selected transfer");
          await noSymlinks(file.full, true);
          dispatched = true;
          const written = await bb.sdk.files.write({ hostId: input.target.hostId, rootPath, path: file.full, content: file.contentBase64, contentEncoding: "base64", expectedSha256: null, createParents: true, mode: 0o600 });
          if (written.outcome !== "written" || written.sha256 !== file.sha256 || written.sizeBytes !== file.sizeBytes) throw new Error("Native create-only write refused or did not verify the selected bytes");
          await noSymlinks(file.full);
          const after = await bb.sdk.files.read({ hostId: input.target.hostId, rootPath, path: file.full });
          const bytes = Buffer.from(after.content, after.contentEncoding === "base64" ? "base64" : "utf8");
          if (bytes.length !== file.sizeBytes || after.sizeBytes !== file.sizeBytes || digest(bytes) !== file.sha256) throw new Error("Transferred owner bytes failed read-back SHA256 verification");
          applied.push({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes });
          progress({ files: applied, count: applied.length, totalBytes: applied.reduce((sum, entry) => sum + entry.sizeBytes, 0) });
        }
        result = { files: applied, count: applied.length, totalBytes: applied.reduce((sum, file) => sum + file.sizeBytes, 0), rootPath };
      }
      return save(receipt(input.target, input.requestId, method, claimed.fingerprint, "applied", result));
    } catch (cause) { return save(receipt(input.target, input.requestId, method, claimed.fingerprint, dispatched ? "unknown" : "refused", result, errorText(cause))); }
  }
  function validateRemote<M extends OwnerProjectMethod>(method: M, input: Input<M>, value: unknown): Output<M> {
    const parsed = ownerProjectContract[method].output.parse(value);
    if (canonical(parsed.owner) !== canonical(input.target)) throw new Error("Owner reply does not match the exact selected server, machine, host, project and environment");
    if ("requestId" in input && (!("requestId" in parsed) || parsed.requestId !== input.requestId)) throw new Error("Owner reply does not match the selected request");
    return parsed as Output<M>;
  }
  async function dispatch<M extends OwnerProjectMethod>(method: M, raw: unknown): Promise<Output<M>> {
    const input = ownerProjectContract[method].input.parse(raw) as Input<M>;
    const identity = await options.identity();
    if (input.target.serverId === identity.serverId) {
      if (method === "project_verify") return verify(input as Input<"project_verify">) as Promise<Output<M>>;
      if (method === "transfer_receipt") {
        await localIdentity(input.target);
        const row = get((input as Input<"transfer_receipt">).requestId);
        if (row && row.target_json !== canonical(input.target)) throw new Error("Receipt is scoped to another owner target");
        return (row ? ownerProjectContract.transfer_receipt.output.parse(JSON.parse(row.receipt_json)) : receipt(input.target, (input as Input<"transfer_receipt">).requestId, null, null, "unknown", null, "No receipt exists; this does not prove that a prior owner side effect did not occur")) as Output<M>;
      }
      return mutate(method as Mutation, input as Input<Mutation>) as Promise<Output<M>>;
    }
    const mutation = method === "project_prepare" || method === "transfer_manifest_apply";
    let fingerprint: string | null = null;
    if (mutation) {
      const claimed = claim(method as Mutation, input as Input<Mutation>);
      if (claimed.old) return claimed.old as Output<M>;
      fingerprint = claimed.fingerprint;
    }
    const requestId = "requestId" in input ? String(input.requestId) : null;
    const prior = requestId ? get(requestId) : undefined;
    if (method === "transfer_receipt" && prior && prior.target_json !== canonical(input.target)) throw new Error("Receipt is scoped to another owner target");
    let response: OwnerCallOutcome;
    if (options.restricted?.(input.target.machineKey)) response = { ok: false, kind: "unavailable", message: `no-authenticated-owner-route: ${input.target.machineKey}` };
    else try { response = await options.callOwner({ serverId: input.target.serverId, machineKey: input.target.machineKey, hostId: input.target.hostId }, method, input, mutation); } catch (cause) { response = { ok: false, kind: mutation ? "unknown" : "unavailable", message: errorText(cause) }; }
    if (!response.ok) {
      if (!requestId) return { owner: input.target, available: false, verified: false, repository: null, mismatches: [], message: `${response.kind}: ${response.message}`.slice(0, 1800), observedAt: now() } as Output<M>;
      const value = receipt(input.target, requestId, mutation ? method as Mutation : prior?.method ?? null, fingerprint ?? prior?.fingerprint ?? null, response.kind, null, errorText(response.message));
      return (mutation ? save(value) : value) as Output<M>;
    }
    try {
      const parsed = validateRemote(method, input, response.result);
      if ("fingerprint" in parsed && ((mutation && (parsed.method !== method || parsed.fingerprint !== fingerprint)) || (!mutation && prior && (parsed.method !== prior.method || parsed.fingerprint !== prior.fingerprint)))) throw new Error("Owner receipt does not match the immutable request fingerprint and method");
      return (mutation || (prior && method === "transfer_receipt") ? save(parsed as OwnerProjectReceipt) : parsed) as Output<M>;
    } catch (cause) {
      if (!requestId) throw cause;
      const value = receipt(input.target, requestId, mutation ? method as Mutation : prior?.method ?? null, fingerprint ?? prior?.fingerprint ?? null, "unknown", null, errorText(cause));
      return (mutation ? save(value) : value) as Output<M>;
    }
  }
  return { handlers: {
    project_verify: (input: Input<"project_verify">) => dispatch("project_verify", input),
    project_prepare: (input: Input<"project_prepare">) => dispatch("project_prepare", input),
    transfer_manifest_apply: (input: Input<"transfer_manifest_apply">) => dispatch("transfer_manifest_apply", input),
    transfer_receipt: (input: Input<"transfer_receipt">) => dispatch("transfer_receipt", input),
  } };
}

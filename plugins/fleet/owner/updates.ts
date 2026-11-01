// Native owner version, update and provider matrix (F26, F78).
// The owner reads its own bb app update state and provider CLI state through
// the SDK, applies a bb update only through the external helper (which survives
// the restart and keeps the durable intent), and updates provider CLIs through
// the core installer with an exact from-version and a busy guard. The source
// side builds the fleet matrix from authenticated owners only and enforces the
// staged policy (test machine first, optional pinned version).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { HELPER_SHA256, HELPER_SOURCE } from "../updater/helper-source";
import { createCoalescer } from "../lib/coalesce";
import type { OwnerCallOutcome } from "./transport";
import type { UpdateDrainResult } from "./update-drain";

export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export const INTENT = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const machineSchema = z.string().min(1).max(40);
export type UpdateMachine = z.infer<typeof machineSchema>;

const intentSchema = z.object({
  intentId: z.string(),
  mode: z.string().optional(),
  phase: z.string(),
  fromVersion: z.string().optional(),
  targetVersion: z.string().optional(),
  reason: z.string().optional(),
  updatedAt: z.number().optional(),
  proof: z.object({ version: z.string() }).passthrough().optional(),
}).passthrough();
export type UpdateIntent = z.infer<typeof intentSchema>;

const providerRowSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  installed: z.boolean(),
  currentVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  needsUpdate: z.boolean(),
  actionKind: z.string().nullable(),
  exactInstall: z.boolean().optional(),
});

export const ownerUpdateStatusSchema = z.object({
  v: z.literal(1),
  machineKey: z.string(),
  serverId: z.string(),
  hostId: z.string().nullable(),
  observedAt: z.number(),
  platform: z.string(),
  arch: z.string(),
  app: z.object({
    current: z.string(),
    available: z.string().nullable(),
    exactApply: z.boolean(),
    desktopUpdateSupported: z.boolean(),
    support: z.string(),
    runningThreadCount: z.number().int().nonnegative(),
    activity: z.string(),
    lastResult: z.object({ id: z.string(), outcome: z.string(), toVersion: z.string() }).nullable(),
  }).nullable(),
  appError: z.string().nullable(),
  helper: z.object({ supported: z.boolean(), reason: z.string().nullable(), latestIntent: intentSchema.nullable() }),
  providers: z.array(providerRowSchema),
  providersError: z.string().nullable(),
});
export type OwnerUpdateStatus = z.infer<typeof ownerUpdateStatusSchema>;

export const updatesApplyInput = z.object({
  v: z.literal(1),
  intentId: z.string().regex(INTENT),
  fromVersion: z.string().regex(VERSION),
  targetVersion: z.string().regex(VERSION),
  mode: z.enum(["native", "bootstrap"]),
  quitMode: z.enum(["signal", "apple-event"]).optional(),
  drainTimeoutMs: z.number().int().min(0).max(24 * 3_600_000).optional(),
}).strict();
const applyResultSchema = z.object({
  state: z.enum(["started", "existing", "refused", "unavailable", "unknown"]),
  reason: z.string().nullable(),
  intent: intentSchema.nullable(),
});

export const providerUpdateInput = z.object({
  v: z.literal(1),
  requestId: z.string().regex(INTENT),
  provider: z.string().min(1).max(80),
  expectedFromVersion: z.string().min(1).max(80).nullable(),
}).strict();
const providerReceiptSchema = z.object({
  state: z.enum(["completed", "failed", "refused", "unknown", "unavailable"]),
  provider: z.string().nullable(),
  fromVersion: z.string().nullable(),
  toVersion: z.string().nullable(),
  message: z.string().nullable(),
});
export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;

const matrixRowSchema = z.object({
  machine: machineSchema,
  route: z.enum(["self", "ssh", "none"]),
  state: z.enum(["ok", "unavailable"]),
  reason: z.string().nullable(),
  status: ownerUpdateStatusSchema.nullable(),
});
const matrixSchema = z.object({
  observedAt: z.number(),
  policy: z.object({ testMachine: z.string().nullable(), pinnedVersion: z.string().nullable() }),
  rows: z.array(matrixRowSchema),
});
export type UpdateMatrix = z.infer<typeof matrixSchema>;

const policySchema = z.object({ testMachine: machineSchema.nullable(), pinnedVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/).nullable() }).strict();

export const updatesRpcContract = defineRpcContract({
  updates_policy_get: { input: z.null(), output: z.object({ testMachine: z.string().nullable(), pinnedVersion: z.string().nullable() }) },
  updates_policy_set: { input: policySchema, output: z.object({ testMachine: z.string().nullable(), pinnedVersion: z.string().nullable() }) },
  updates_status: { input: z.null(), output: ownerUpdateStatusSchema },
  updates_apply: { input: updatesApplyInput, output: applyResultSchema },
  updates_intent_get: { input: z.object({ intentId: z.string().regex(INTENT) }).strict(), output: intentSchema.nullable() },
  provider_update_apply: { input: providerUpdateInput, output: providerReceiptSchema },
  provider_update_receipt: { input: z.object({ requestId: z.string().regex(INTENT) }).strict(), output: providerReceiptSchema },
  updates_matrix: { input: z.null(), output: matrixSchema },
  update_dispatch: { input: updatesApplyInput.extend({ machine: machineSchema }).strict(), output: applyResultSchema },
  provider_update_dispatch: { input: providerUpdateInput.extend({ machine: machineSchema }).strict(), output: providerReceiptSchema },
});

export interface UpdatesDeps {
  bb: BbPluginApi;
  machineKey: string;
  /** Every machine the matrix lists, in display order (the profile's machines). Defaults to this machine only. */
  machines?(): string[];
  identity(): Promise<{ serverId: string; hostId: string | null }>;
  /** Owner call to another machine over an authenticated route; null when none exists. */
  callOwner(machine: UpdateMachine, method: "updates_status" | "updates_apply" | "updates_intent_get" | "provider_update_apply" | "provider_update_receipt", input: unknown, mutation: boolean): Promise<OwnerCallOutcome> | null;
  policy(): { testMachine: string | null; pinnedVersion: string | null };
  /** Persist a new staging machine and pin; absent when this bb cannot write its own settings. */
  setPolicy?(policy: { testMachine: string | null; pinnedVersion: string | null }): Promise<{ testMachine: string | null; pinnedVersion: string | null }>;
  stateDir?: string;
  platform?: NodeJS.Platform;
  launchHelper?(args: { nodeBin: string; nodeEnv: Record<string, string>; helperPath: string; mode: string; planPath: string; logPath: string }): void;
  nodeCandidates?: string[];
  appInfoPlist?: string;
  readVersion?(executablePath: string): Promise<string | null>;
  /** The owner's admission drain; a bb update never launches without a held, armed drain. */
  drain?: {
    begin(input: { v: 1; ownerServerId: string; hostId: string; intentId: string; fromVersion: string; targetVersion: string }): Promise<UpdateDrainResult>;
    arm(input: { v: 1; ownerServerId: string; hostId: string; intentId: string }): Promise<UpdateDrainResult>;
    cancel(input: { v: 1; ownerServerId: string; hostId: string; intentId: string }): Promise<UpdateDrainResult>;
  };
  now?: () => number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);

function defaultLaunch(args: { nodeBin: string; nodeEnv: Record<string, string>; helperPath: string; mode: string; planPath: string; logPath: string }): void {
  const log = openSync(args.logPath, "a");
  try {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("BB_") && !key.startsWith("ELECTRON_") && key !== "NODE_OPTIONS") env[key] = value;
    env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    const child = spawn(args.nodeBin, [args.helperPath, args.mode, args.planPath], { detached: true, stdio: ["ignore", log, log], env: { ...env, ...args.nodeEnv } });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export function createOwnerUpdates(deps: UpdatesDeps) {
  const { bb } = deps;
  const now = deps.now ?? Date.now;
  const os = deps.platform ?? platform();
  const stateDir = deps.stateDir ?? join(homedir(), "Library", "Application Support", "bb-fleet-updates");
  const db = bb.storage.database();
  db.exec("CREATE TABLE IF NOT EXISTS fleet_update_receipts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT, updated_at INTEGER NOT NULL)");

  const executables = new Map<string, string | null>();

  /** The installed CLI's own --version, read now (the core status is cached). */
  async function freshProviderVersion(provider: string): Promise<string | null> {
    const path = executables.get(provider);
    if (!path) return null;
    if (deps.readVersion) return deps.readVersion(path);
    return new Promise((resolve) => {
      execFile(path, ["--version"], { timeout: 20_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        resolve(error ? null : /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(stdout))?.[1] ?? null);
      });
    });
  }

  function readIntent(intentId: string): UpdateIntent | null {
    const path = join(stateDir, "intents", `${intentId}.json`);
    if (!existsSync(path)) return null;
    try { return intentSchema.parse(JSON.parse(readFileSync(path, "utf8"))); } catch { return null; }
  }

  function latestIntent(): UpdateIntent | null {
    const row = db.prepare("SELECT id FROM fleet_update_receipts WHERE kind = 'app' ORDER BY updated_at DESC LIMIT 1").get() as { id: string } | undefined;
    return row ? readIntent(row.id) ?? { intentId: row.id, phase: "launched" } : null;
  }

  function helperSupport(): { supported: boolean; reason: string | null } {
    if (os !== "darwin") return { supported: false, reason: "The desktop update helper is macOS only; use bb updates app apply on this host" };
    if (!existsSync(deps.appInfoPlist ?? "/Applications/bb.app/Contents/Info.plist")) return { supported: false, reason: "No /Applications/bb.app desktop install on this host" };
    return { supported: true, reason: null };
  }

  async function status(): Promise<OwnerUpdateStatus> {
    const { serverId, hostId } = await deps.identity();
    let app: OwnerUpdateStatus["app"] = null;
    let appError: string | null = null;
    try {
      const raw = await bb.sdk.system.appUpdate({ force: true } as never) as unknown as Record<string, unknown> & { current: { version: string }; available: { version: string } | null; support: { kind: string; reason?: string; mode?: string }; runningThreadCount: number; activity: { phase: string }; lastResult: { id: string; outcome: string; to: { version: string } } | null };
      app = {
        current: raw.current.version,
        available: raw.available?.version ?? null,
        exactApply: raw.experimental_exactApply === true,
        desktopUpdateSupported: raw.desktopUpdateSupported === true,
        support: raw.support.kind === "supported" ? `supported:${raw.support.mode ?? ""}` : `unsupported:${raw.support.reason ?? ""}`,
        runningThreadCount: raw.runningThreadCount,
        activity: raw.activity.phase,
        lastResult: raw.lastResult ? { id: raw.lastResult.id, outcome: raw.lastResult.outcome, toVersion: raw.lastResult.to.version } : null,
      };
    } catch (cause) { appError = errorText(cause); }
    let providers: OwnerUpdateStatus["providers"] = [];
    let providersError: string | null = null;
    if (hostId === null) providersError = "This server has no local host";
    else {
      try {
        const cli = await bb.sdk.hosts.providerCliStatus({ hostId }) as unknown as Record<string, { displayName: string; installed: boolean; executablePath?: string | null; currentVersion: string | null; latestVersion: string | null; needsUpdate: boolean; installAction: { kind: string } | null; experimental_exactInstall?: boolean }>;
        providers = Object.entries(cli).map(([provider, row]) => ({ provider, displayName: row.displayName, installed: row.installed, currentVersion: row.currentVersion, latestVersion: row.latestVersion, needsUpdate: row.needsUpdate, actionKind: row.installAction?.kind ?? null, exactInstall: row.experimental_exactInstall === true }));
        for (const [provider, row] of Object.entries(cli)) executables.set(provider, row.executablePath ?? null);
      } catch (cause) { providersError = errorText(cause); }
    }
    return { v: 1, machineKey: deps.machineKey, serverId, hostId, observedAt: now(), platform: os, arch: arch(), app, appError, helper: { ...helperSupport(), latestIntent: latestIntent() }, providers, providersError };
  }

  function nodeRuntime(): { nodeBin: string; nodeEnv: Record<string, string> } {
    for (const candidate of deps.nodeCandidates ?? ["/usr/local/bin/node", "/opt/homebrew/bin/node"]) if (existsSync(candidate)) return { nodeBin: candidate, nodeEnv: {} };
    return { nodeBin: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: "1" } };
  }

  async function apply(input: z.infer<typeof updatesApplyInput>): Promise<z.infer<typeof applyResultSchema>> {
    const fingerprint = sha256(JSON.stringify({ ...input, drainTimeoutMs: input.drainTimeoutMs ?? null, quitMode: input.quitMode ?? null }));
    const existing = db.prepare("SELECT fingerprint, status FROM fleet_update_receipts WHERE id = ?").get(input.intentId) as { fingerprint: string; status: string } | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { state: "refused", reason: "This intent id was already used for another update", intent: readIntent(input.intentId) };
      return { state: existing.status === "launched" ? "existing" : "unknown", reason: existing.status === "launched" ? null : "The helper launch outcome is unknown; read the intent before starting another", intent: readIntent(input.intentId) };
    }
    const support = helperSupport();
    if (!support.supported) return { state: "refused", reason: support.reason, intent: null };
    const current = await status();
    if (current.app === null) return { state: "unavailable", reason: current.appError ?? "bb did not report its update state", intent: null };
    if (current.app.current !== input.fromVersion) return { state: "refused", reason: `bb is ${current.app.current}, not the expected ${input.fromVersion}`, intent: null };
    if (input.mode === "native") {
      if (!current.app.exactApply || !current.app.desktopUpdateSupported) return { state: "refused", reason: "This server cannot pin an exact desktop update; use bootstrap with the exact official tag", intent: null };
      if (current.app.available !== input.targetVersion) return { state: "refused", reason: `bb ${current.app.available ?? "none"} is available, not ${input.targetVersion}`, intent: null };
    }
    if (current.hostId === null) return { state: "refused", reason: "This server has no local host to drain", intent: null };
    if (!deps.drain) return { state: "refused", reason: "No admission drain is available on this owner; nothing was started", intent: null };
    const drainTarget = { v: 1 as const, ownerServerId: current.serverId, hostId: current.hostId, intentId: input.intentId };
    const active = latestIntent();
    if (active && !["updated", "failed", "rolled-back", "rollback-failed", "rollback-held", "install-held", "refused", "busy", "conflict"].includes(active.phase)) return { state: "refused", reason: `Update ${active.intentId} is still ${active.phase}`, intent: active };
    const begun = await deps.drain.begin({ ...drainTarget, fromVersion: input.fromVersion, targetVersion: input.targetVersion });
    if (begun.state !== "held" && begun.state !== "busy") return { state: begun.state === "unknown" ? "unknown" : "refused", reason: `The admission drain did not hold: ${begun.reason ?? begun.state}; nothing was started`, intent: null };
    db.prepare("INSERT INTO fleet_update_receipts (id, kind, fingerprint, status, result, updated_at) VALUES (?, 'app', ?, 'launching', NULL, ?)").run(input.intentId, fingerprint, now());
    let launchArgs: Parameters<NonNullable<UpdatesDeps["launchHelper"]>>[0];
    try {
      mkdirSync(join(stateDir, "logs"), { recursive: true });
      const helperPath = join(stateDir, `desktop-update-${HELPER_SHA256.slice(0, 12)}.mjs`);
      if (!existsSync(helperPath) || sha256(readFileSync(helperPath, "utf8")) !== HELPER_SHA256) writeFileSync(helperPath, HELPER_SOURCE, { mode: 0o600 });
      if (sha256(readFileSync(helperPath, "utf8")) !== HELPER_SHA256) throw new Error("The staged helper does not match the shipped helper");
      const runtime = nodeRuntime();
      const planPath = join(stateDir, `plan-${input.intentId}.json`);
      writeFileSync(planPath, JSON.stringify({ intentId: input.intentId, fromVersion: input.fromVersion, targetVersion: input.targetVersion, ...(input.quitMode ? { quitMode: input.quitMode } : {}), ...(input.drainTimeoutMs !== undefined ? { drainTimeoutMs: input.drainTimeoutMs } : {}), nodeBin: runtime.nodeBin, nodeEnv: runtime.nodeEnv, drain: drainTarget }), { mode: 0o600 });
      launchArgs = { ...runtime, helperPath, mode: input.mode, planPath, logPath: join(stateDir, "logs", `${input.intentId}.log`) };
    } catch (cause) {
      db.prepare("DELETE FROM fleet_update_receipts WHERE id = ? AND status = 'launching'").run(input.intentId);
      await deps.drain.cancel(drainTarget).catch(() => undefined);
      return { state: "refused", reason: `The helper was not launched: ${errorText(cause)}`, intent: null };
    }
    const armed = await deps.drain.arm(drainTarget).catch((cause: unknown) => ({ helperArmed: false, reason: errorText(cause) }) as Pick<UpdateDrainResult, "helperArmed" | "reason">);
    if (!armed.helperArmed) {
      db.prepare("DELETE FROM fleet_update_receipts WHERE id = ? AND status = 'launching'").run(input.intentId);
      await deps.drain.cancel(drainTarget).catch(() => undefined);
      return { state: "refused", reason: `The admission drain could not be armed: ${armed.reason ?? "unknown"}; nothing was started`, intent: null };
    }
    try {
      (deps.launchHelper ?? defaultLaunch)(launchArgs);
    } catch (cause) {
      return { state: "unknown", reason: `The helper launch outcome is unknown (${errorText(cause)}); read updates_intent_get for ${input.intentId} before starting another`, intent: readIntent(input.intentId) };
    }
    try {
      db.prepare("UPDATE fleet_update_receipts SET status = 'launched', updated_at = ? WHERE id = ?").run(now(), input.intentId);
    } catch (cause) {
      bb.log.warn(`Update ${input.intentId} launched but its receipt was not updated: ${errorText(cause)}`);
    }
    return { state: "started", reason: null, intent: readIntent(input.intentId) ?? { intentId: input.intentId, phase: "launched", mode: input.mode, fromVersion: input.fromVersion, targetVersion: input.targetVersion } };
  }

  function providerReceipt(requestId: string): ProviderReceipt {
    const row = db.prepare("SELECT status, result FROM fleet_update_receipts WHERE id = ? AND kind = 'provider'").get(requestId) as { status: string; result: string | null } | undefined;
    if (!row) return { state: "unavailable", provider: null, fromVersion: null, toVersion: null, message: "no-receipt" };
    if (row.result) return providerReceiptSchema.parse(JSON.parse(row.result));
    return { state: "unknown", provider: null, fromVersion: null, toVersion: null, message: "The provider update outcome is unknown; read the provider version before starting another" };
  }

  /** Running threads on this host that use the provider; null when any lookup fails (unknown never authorises). */
  async function providerBusy(provider: string, hostId: string): Promise<number | null> {
    try {
      const running = z.array(z.object({ id: z.string(), hostId: z.string().nullable() })).parse(await bb.sdk.threads.listRunning());
      let count = 0;
      for (const entry of running) {
        if (entry.hostId !== null && entry.hostId !== hostId) continue;
        const thread = z.object({ providerId: z.string().nullable() }).passthrough().parse(await bb.sdk.threads.get({ threadId: entry.id }));
        if (thread.providerId === provider) count += 1;
      }
      return count;
    } catch {
      return null;
    }
  }

  async function providerApply(input: z.infer<typeof providerUpdateInput>): Promise<ProviderReceipt> {
    const fingerprint = sha256(JSON.stringify(input));
    const existing = db.prepare("SELECT fingerprint FROM fleet_update_receipts WHERE id = ?").get(input.requestId) as { fingerprint: string } | undefined;
    if (existing) return existing.fingerprint === fingerprint ? providerReceipt(input.requestId) : { state: "refused", provider: input.provider, fromVersion: null, toVersion: null, message: "This request id was already used for another update" };
    const current = await status();
    const row = current.providers.find((entry) => entry.provider === input.provider);
    const refuse = (message: string): ProviderReceipt => ({ state: "refused", provider: input.provider, fromVersion: row?.currentVersion ?? null, toVersion: null, message });
    if (current.hostId === null) return refuse("This server has no local host");
    if (!row) return refuse(current.providersError ?? `Provider ${input.provider} is not managed on this host`);
    if (row.currentVersion !== input.expectedFromVersion) return refuse(`${row.displayName} is ${row.currentVersion ?? "not installed"}, not the expected ${input.expectedFromVersion ?? "not installed"}`);
    if (row.actionKind === null) return refuse(`${row.displayName} has no update bb can apply here`);
    if (row.exactInstall !== true) return refuse(`This owner's bb cannot check ${row.displayName}'s version inside its installer (no experimental_exactInstall), so an exact update is refused`);
    const busy = await providerBusy(input.provider, current.hostId);
    if (busy !== 0) return refuse(busy === null ? `Could not verify which provider the running threads use; ${row.displayName} was not updated` : `${busy} running thread(s) on this host use ${row.displayName}; update it when they finish`);
    db.prepare("INSERT INTO fleet_update_receipts (id, kind, fingerprint, status, result, updated_at) VALUES (?, 'provider', ?, 'dispatching', NULL, ?)").run(input.requestId, fingerprint, now());
    let receipt: ProviderReceipt;
    const recheck = await providerBusy(input.provider, current.hostId);
    const observed = recheck === 0 ? await freshProviderVersion(input.provider) : null;
    if (recheck === 0 && observed !== input.expectedFromVersion) {
      receipt = refuse(`${row.displayName} reports ${observed ?? "no readable version"} right before the install, not the expected ${input.expectedFromVersion ?? "not installed"}; nothing was installed`);
      db.prepare("DELETE FROM fleet_update_receipts WHERE id = ? AND status = 'dispatching'").run(input.requestId);
      return receipt;
    }
    if (recheck !== 0) {
      receipt = refuse(recheck === null ? "Could not re-verify running threads immediately before the install; nothing was installed" : `${recheck} thread(s) started on ${row.displayName}; nothing was installed`);
      db.prepare("DELETE FROM fleet_update_receipts WHERE id = ? AND status = 'dispatching'").run(input.requestId);
      return receipt;
    }
    try {
      const events = await bb.sdk.hosts.installProviderCli({ hostId: current.hostId, provider: input.provider as never, actionKind: row.actionKind as never, experimental_expectedCurrentVersion: input.expectedFromVersion } as never) as unknown as { type: string; success?: boolean; message?: string }[];
      const completed = events.find((event) => event.type === "completed");
      const failure = events.find((event) => event.type === "error");
      const after = (await status()).providers.find((entry) => entry.provider === input.provider);
      receipt = completed?.success === true
        ? { state: "completed", provider: input.provider, fromVersion: row.currentVersion, toVersion: after?.currentVersion ?? null, message: null }
        : { state: "failed", provider: input.provider, fromVersion: row.currentVersion, toVersion: after?.currentVersion ?? null, message: failure?.message ?? "The installer did not report success" };
    } catch (cause) {
      receipt = { state: "unknown", provider: input.provider, fromVersion: row.currentVersion, toVersion: null, message: `Installer outcome unknown: ${errorText(cause)}` };
    }
    db.prepare("UPDATE fleet_update_receipts SET status = ?, result = ?, updated_at = ? WHERE id = ?").run(receipt.state, JSON.stringify(receipt), now(), input.requestId);
    return receipt;
  }

  async function remote<T>(machine: UpdateMachine, method: Parameters<UpdatesDeps["callOwner"]>[1], input: unknown, mutation: boolean, parse: (value: unknown) => T): Promise<{ ok: true; value: T } | { ok: false; kind: string; reason: string }> {
    const call = deps.callOwner(machine, method, input, mutation);
    if (call === null) return { ok: false, kind: "unavailable", reason: "no-authenticated-owner-route" };
    const outcome = await call;
    if (!outcome.ok) return { ok: false, kind: outcome.kind, reason: outcome.message };
    try { return { ok: true, value: parse(outcome.result) }; } catch (cause) { return { ok: false, kind: mutation ? "unknown" : "unavailable", reason: `Unexpected owner answer: ${errorText(cause)}` }; }
  }

  const matrixReads = createCoalescer();
  const MATRIX_TTL_MS = 3000;
  const matrix = () => matrixReads.run("matrix", MATRIX_TTL_MS, readMatrix);

  async function changing<T>(work: () => Promise<T>): Promise<T> {
    matrixReads.invalidate();
    try {
      return await work();
    } finally {
      matrixReads.invalidate();
    }
  }

  async function readMatrix(): Promise<UpdateMatrix> {
    const rows = await Promise.all((deps.machines?.() ?? [deps.machineKey]).map(async (machine) => {
      if (machine === deps.machineKey) return { machine, route: "self" as const, state: "ok" as const, reason: null, status: await status() };
      const answer = await remote(machine, "updates_status", null, false, (value) => ownerUpdateStatusSchema.parse(value));
      return answer.ok
        ? { machine, route: "ssh" as const, state: "ok" as const, reason: null, status: answer.value }
        : { machine, route: answer.reason === "no-authenticated-owner-route" ? "none" as const : "ssh" as const, state: "unavailable" as const, reason: answer.reason, status: null };
    }));
    return { observedAt: now(), policy: deps.policy(), rows };
  }

  async function stagedPolicyRefusal(machine: UpdateMachine, targetVersion: string): Promise<string | null> {
    const policy = deps.policy();
    if (policy.pinnedVersion && policy.pinnedVersion !== targetVersion) return `The fleet is pinned to ${policy.pinnedVersion}; change the pin before updating to ${targetVersion}`;
    if (!policy.testMachine || policy.testMachine === machine) return null;
    const test = policy.testMachine;
    const tested = test === deps.machineKey ? await status() : await remote(test as UpdateMachine, "updates_status", null, false, (value) => ownerUpdateStatusSchema.parse(value)).then((answer) => (answer.ok ? answer.value : null));
    if (tested?.app?.current !== targetVersion) return `Stage ${targetVersion} on the test machine ${test} first (it reports ${tested?.app?.current ?? "unknown"})`;
    return null;
  }

  async function dispatch(input: z.infer<typeof updatesApplyInput> & { machine: UpdateMachine }): Promise<z.infer<typeof applyResultSchema>> {
    const { machine, ...apply_ } = input;
    const refusal = await stagedPolicyRefusal(machine, input.targetVersion);
    if (refusal) return { state: "refused", reason: refusal, intent: null };
    if (machine === deps.machineKey) return apply(apply_);
    const answer = await remote(machine, "updates_apply", apply_, true, (value) => applyResultSchema.parse(value));
    if (answer.ok) return answer.value;
    if (answer.kind === "unavailable") return { state: "unavailable", reason: answer.reason, intent: null };
    return { state: "unknown", reason: `${answer.reason}. Read updates_intent_get for ${input.intentId} before trying again.`, intent: null };
  }

  async function providerDispatch(input: z.infer<typeof providerUpdateInput> & { machine: UpdateMachine }): Promise<ProviderReceipt> {
    const { machine, ...rest } = input;
    if (machine === deps.machineKey) return providerApply(rest);
    const answer = await remote(machine, "provider_update_apply", rest, true, (value) => providerReceiptSchema.parse(value));
    if (answer.ok) return answer.value;
    return { state: answer.kind === "unavailable" ? "unavailable" : "unknown", provider: input.provider, fromVersion: input.expectedFromVersion, toVersion: null, message: answer.kind === "unavailable" ? answer.reason : `${answer.reason}. Read provider_update_receipt before trying again.` };
  }

  return {
    status,
    matrix,
    readIntent,
    handlers: {
      updates_policy_get: () => deps.policy(),
      updates_policy_set: async (input: z.infer<typeof policySchema>) => {
        if (!deps.setPolicy) throw new Error("This bb cannot save the update policy");
        return deps.setPolicy(policySchema.parse(input));
      },
      updates_status: () => status(),
      updates_apply: (input: z.infer<typeof updatesApplyInput>) => apply(input),
      updates_intent_get: ({ intentId }: { intentId: string }) => readIntent(intentId),
      provider_update_apply: (input: z.infer<typeof providerUpdateInput>) => providerApply(input),
      provider_update_receipt: ({ requestId }: { requestId: string }) => providerReceipt(requestId),
      updates_matrix: () => matrix(),
      update_dispatch: (input: z.infer<typeof updatesApplyInput> & { machine: UpdateMachine }) => changing(() => dispatch(input)),
      provider_update_dispatch: (input: z.infer<typeof providerUpdateInput> & { machine: UpdateMachine }) => changing(() => providerDispatch(input)),
    },
  };
}

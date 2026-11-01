import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerUpdates, type OwnerUpdateStatus } from "./updates";
import { HELPER_SHA256, HELPER_SOURCE } from "../updater/helper-source";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function owner(options: { app?: Record<string, unknown>; providers?: Record<string, unknown>; running?: { providerId: string; hostId?: string | null; lookupFails?: boolean }[]; runningFails?: boolean; freshVersion?: string | null; launchThrows?: boolean; noDrain?: boolean; drainState?: string; armFails?: boolean; noExactInstall?: boolean; platform?: NodeJS.Platform; machineKey?: string; remote?: (machine: string, method: string, input: unknown, mutation: boolean) => unknown; policy?: { testMachine: string | null; pinnedVersion: string | null }; policyLive?: () => { testMachine: string | null; pinnedVersion: string | null }; setPolicy?: (next: { testMachine: string | null; pinnedVersion: string | null }) => Promise<{ testMachine: string | null; pinnedVersion: string | null }> } = {}) {
  const db = new Database(":memory:");
  dbs.push(db);
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-updates-"));
  const plist = join(stateDir, "Info.plist");
  writeFileSync(plist, "plist");
  const launches: { mode: string; planPath: string; helperPath: string; nodeBin: string }[] = [];
  const drainCalls: string[] = [];
  const drainResult = (intentId: string, state: string, helperArmed: boolean) => ({ ownerServerId: "laptop-srv", hostId: "host_laptop", intentId, state, gateActive: state === "held", helperArmed, safeToQuit: false, core: null, activity: null, helperPhase: null, reason: state === "unavailable" ? "No atomic core admission gate" : null }) as never;
  const installs: unknown[] = [];
  const app = { current: { version: "0.48.0", commit: null }, available: { version: "0.48.1" }, support: { kind: "unsupported", reason: "desktop" }, desktopUpdateSupported: true, experimental_exactApply: true, runningThreadCount: 0, activity: { phase: "idle" }, lastResult: null, blocked: null, ...options.app };
  const providers = { codex: { displayName: "Codex", installed: true, experimental_exactInstall: options.noExactInstall ? undefined : true, executablePath: "/usr/local/bin/codex", currentVersion: "1.2.0", latestVersion: "1.3.0", needsUpdate: true, installAction: { kind: "update" } }, ...options.providers };
  const bb = {
    storage: { database: () => db },
    sdk: {
      system: { appUpdate: async () => app },
      hosts: {
        providerCliStatus: async () => providers,
        installProviderCli: async (args: unknown) => { installs.push(args); (providers.codex as { currentVersion: string }).currentVersion = "1.3.0"; return [{ type: "completed", success: true }]; },
      },
      threads: {
        listRunning: async () => { if (options.runningFails) throw new Error("server busy"); return (options.running ?? []).map((thread, index) => ({ id: `thr_run${index}`, hostId: thread.hostId ?? "host_laptop" })); },
        get: async ({ threadId }: { threadId: string }) => { const index = Number(threadId.replace("thr_run", "")); const thread = (options.running ?? [])[index]; if (!thread || thread.lookupFails) throw new Error("not found"); return { id: threadId, providerId: thread.providerId }; },
      },
    },
  };
  const updates = createOwnerUpdates({
    bb: bb as never,
    machineKey: options.machineKey ?? "laptop",
    identity: async () => ({ serverId: "laptop-srv", hostId: "host_laptop" }),
    machines: () => ["laptop", "studio", "work"],
    policy: () => options.policyLive?.() ?? options.policy ?? { testMachine: null, pinnedVersion: null },
    ...(options.setPolicy ? { setPolicy: options.setPolicy } : {}),
    callOwner: (machine, method, input, mutation) => {
      const reply = options.remote?.(machine, method, input, mutation);
      return reply === undefined ? null : Promise.resolve(reply as never);
    },
    stateDir,
    platform: options.platform ?? "darwin",
    appInfoPlist: plist,
    nodeCandidates: [],
    ...(options.noDrain ? {} : {
      drain: {
        begin: async (input) => { drainCalls.push(`begin:${input.intentId}`); return drainResult(input.intentId, options.drainState ?? "held", false); },
        arm: async (input) => { drainCalls.push(`arm:${input.intentId}`); return drainResult(input.intentId, "held", options.armFails !== true); },
        cancel: async (input) => { drainCalls.push(`cancel:${input.intentId}`); return drainResult(input.intentId, "released", false); },
      },
    }),
    launchHelper: (args) => { if (options.launchThrows) throw new Error("spawn EAGAIN"); launches.push(args); },
    readVersion: async () => options.freshVersion === undefined ? (providers.codex as { currentVersion: string }).currentVersion : options.freshVersion,
  });
  return { updates, launches, installs, stateDir, app, providers, drainCalls };
}

const intent = { v: 1 as const, intentId: "laptop-native-0481", fromVersion: "0.48.0", targetVersion: "0.48.1", mode: "native" as const };

const studioStatus = (version: string): OwnerUpdateStatus => ({ v: 1, machineKey: "studio", serverId: "studio-srv", hostId: "host_studio", observedAt: 1, platform: "darwin", arch: "arm64", app: { current: version, available: null, exactApply: true, desktopUpdateSupported: true, support: "unsupported:desktop", runningThreadCount: 0, activity: "idle", lastResult: null }, appError: null, helper: { supported: true, reason: null, latestIntent: null }, providers: [], providersError: null });
describe("owner update status", () => {
  it("reports bb's exact update state and the provider CLI matrix from the SDK", async () => {
    const { updates } = owner();
    const status = await updates.status();
    expect(status).toMatchObject({ machineKey: "laptop", serverId: "laptop-srv", hostId: "host_laptop", app: { current: "0.48.0", available: "0.48.1", exactApply: true, desktopUpdateSupported: true, support: "unsupported:desktop" }, helper: { supported: true }, providers: [{ provider: "codex", currentVersion: "1.2.0", latestVersion: "1.3.0", actionKind: "update" }] });
  });
});

describe("owner bb update", () => {
  it("launches the shipped helper once with an exact plan and returns the existing intent on repeat", async () => {
    const { updates, launches } = owner();
    expect(await updates.handlers.updates_apply(intent)).toMatchObject({ state: "started" });
    expect(launches).toHaveLength(1);
    const helper = readFileSync(launches[0]!.helperPath, "utf8");
    expect(createHash("sha256").update(helper).digest("hex")).toBe(HELPER_SHA256);
    expect(helper).toBe(HELPER_SOURCE);
    expect(JSON.parse(readFileSync(launches[0]!.planPath, "utf8"))).toMatchObject({ intentId: "laptop-native-0481", fromVersion: "0.48.0", targetVersion: "0.48.1", nodeEnv: { ELECTRON_RUN_AS_NODE: "1" } });
    expect(launches[0]!.mode).toBe("native");
    expect(await updates.handlers.updates_apply(intent)).toMatchObject({ state: "existing" });
    expect(await updates.handlers.updates_apply({ ...intent, targetVersion: "0.48.2" })).toMatchObject({ state: "refused", reason: expect.stringContaining("another update") });
    expect(launches).toHaveLength(1);
  });

  it("keeps a launch with an uncertain outcome as unknown and never launches it again", async () => {
    const { updates, launches } = owner({ launchThrows: true });
    expect(await updates.handlers.updates_apply(intent)).toMatchObject({ state: "unknown" });
    expect(await updates.handlers.updates_apply(intent)).toMatchObject({ state: "unknown" });
    expect(launches).toHaveLength(0);
  });

  it("begins and arms the admission drain before launching, and never launches without it", async () => {
    const held = owner();
    expect(await held.updates.handlers.updates_apply(intent)).toMatchObject({ state: "started" });
    expect(held.drainCalls).toEqual(["begin:laptop-native-0481", "arm:laptop-native-0481"]);
    expect(JSON.parse(readFileSync(held.launches[0]!.planPath, "utf8"))).toMatchObject({ drain: { v: 1, ownerServerId: "laptop-srv", hostId: "host_laptop", intentId: "laptop-native-0481" } });
    const none = owner({ noDrain: true });
    expect(await none.updates.handlers.updates_apply(intent)).toMatchObject({ state: "refused", reason: expect.stringContaining("No admission drain") });
    const unavailable = owner({ drainState: "unavailable" });
    expect(await unavailable.updates.handlers.updates_apply(intent)).toMatchObject({ state: "refused", reason: expect.stringContaining("No atomic core admission gate") });
    const unarmed = owner({ armFails: true });
    expect(await unarmed.updates.handlers.updates_apply(intent)).toMatchObject({ state: "refused", reason: expect.stringContaining("could not be armed") });
    expect(unarmed.drainCalls).toEqual(["begin:laptop-native-0481", "arm:laptop-native-0481", "cancel:laptop-native-0481"]);
    expect([none, unavailable, unarmed].every((fixture) => fixture.launches.length === 0)).toBe(true);
  });

  it("refuses a native update the server cannot pin, a moved from-version, another target and a non-macOS host", async () => {
    expect(await owner({ app: { experimental_exactApply: undefined } }).updates.handlers.updates_apply(intent)).toMatchObject({ state: "refused", reason: expect.stringContaining("bootstrap") });
    expect(await owner({ app: { current: { version: "0.47.1" } } }).updates.handlers.updates_apply(intent)).toMatchObject({ state: "refused", reason: expect.stringContaining("not the expected 0.48.0") });
    expect(await owner({ app: { available: { version: "0.48.2" } } }).updates.handlers.updates_apply(intent)).toMatchObject({ state: "refused" });
    const linux = owner({ platform: "linux" });
    expect(await linux.updates.handlers.updates_apply(intent)).toMatchObject({ state: "refused", reason: expect.stringContaining("macOS only") });
    expect(linux.launches).toHaveLength(0);
  });

  it("allows a bootstrap for a legacy server and refuses a second update while one is active", async () => {
    const legacy = owner({ app: { experimental_exactApply: undefined, desktopUpdateSupported: undefined, current: { version: "0.46.0" } } });
    expect(await legacy.updates.handlers.updates_apply({ ...intent, intentId: "studio-boot-0001", fromVersion: "0.46.0", mode: "bootstrap", quitMode: "signal" })).toMatchObject({ state: "started" });
    expect(await legacy.updates.handlers.updates_apply({ ...intent, intentId: "studio-boot-0002", fromVersion: "0.46.0", mode: "bootstrap" })).toMatchObject({ state: "refused", reason: expect.stringContaining("still launched") });
  });
});

describe("provider CLI update", () => {
  it("updates from the exact version once and keeps the receipt", async () => {
    const { updates, installs } = owner();
    const request = { v: 1 as const, requestId: "prov-codex-0001", provider: "codex", expectedFromVersion: "1.2.0" };
    expect(await updates.handlers.provider_update_apply(request)).toMatchObject({ state: "completed", fromVersion: "1.2.0", toVersion: "1.3.0" });
    expect(await updates.handlers.provider_update_apply(request)).toMatchObject({ state: "completed" });
    expect(await updates.handlers.provider_update_receipt({ requestId: request.requestId })).toMatchObject({ state: "completed" });
    expect(installs).toEqual([{ hostId: "host_laptop", provider: "codex", actionKind: "update", experimental_expectedCurrentVersion: "1.2.0" }]);
  });

  it("refuses an exact provider update on a core that cannot check the version inside its installer", async () => {
    const old = owner({ noExactInstall: true });
    expect(await old.updates.handlers.provider_update_apply({ v: 1, requestId: "prov-codex-0009", provider: "codex", expectedFromVersion: "1.2.0" })).toMatchObject({ state: "refused", message: expect.stringContaining("experimental_exactInstall") });
    expect(old.installs).toHaveLength(0);
  });

  it("refuses when the CLI's own fresh --version differs from the cached status", async () => {
    const stale = owner({ freshVersion: "1.2.5" });
    expect(await stale.updates.handlers.provider_update_apply({ v: 1, requestId: "prov-codex-0007", provider: "codex", expectedFromVersion: "1.2.0" })).toMatchObject({ state: "refused", message: expect.stringContaining("reports 1.2.5 right before the install") });
    expect(stale.installs).toHaveLength(0);
    const unreadable = owner({ freshVersion: null });
    expect(await unreadable.updates.handlers.provider_update_apply({ v: 1, requestId: "prov-codex-0008", provider: "codex", expectedFromVersion: "1.2.0" })).toMatchObject({ state: "refused" });
  });

  it("refuses a moved version and a provider with running threads", async () => {
    expect(await owner().updates.handlers.provider_update_apply({ v: 1, requestId: "prov-codex-0002", provider: "codex", expectedFromVersion: "1.1.0" })).toMatchObject({ state: "refused" });
    const busy = owner({ running: [{ providerId: "codex" }] });
    expect(await busy.updates.handlers.provider_update_apply({ v: 1, requestId: "prov-codex-0003", provider: "codex", expectedFromVersion: "1.2.0" })).toMatchObject({ state: "refused", message: expect.stringContaining("running thread") });
    expect(busy.installs).toHaveLength(0);
  });

  it("uses the real listRunning shape: only this host's threads count, and an unknown lookup refuses", async () => {
    const elsewhere = owner({ running: [{ providerId: "codex", hostId: "host_other" }, { providerId: "claude-code" }] });
    expect(await elsewhere.updates.handlers.provider_update_apply({ v: 1, requestId: "prov-codex-0004", provider: "codex", expectedFromVersion: "1.2.0" })).toMatchObject({ state: "completed" });
    const unknownThread = owner({ running: [{ providerId: "codex", lookupFails: true }] });
    expect(await unknownThread.updates.handlers.provider_update_apply({ v: 1, requestId: "prov-codex-0005", provider: "codex", expectedFromVersion: "1.2.0" })).toMatchObject({ state: "refused", message: expect.stringContaining("Could not verify") });
    const unknownList = owner({ runningFails: true });
    expect(await unknownList.updates.handlers.provider_update_apply({ v: 1, requestId: "prov-codex-0006", provider: "codex", expectedFromVersion: "1.2.0" })).toMatchObject({ state: "refused" });
    expect(unknownThread.installs).toHaveLength(0);
    expect(unknownList.installs).toHaveLength(0);
  });
});

describe("fleet matrix and staged dispatch", () => {

  it("shows laptop itself, studio over its authenticated route and work as unavailable", async () => {
    const { updates } = owner({ remote: (machine, method) => (machine === "studio" && method === "updates_status" ? { ok: true, result: studioStatus("0.48.1") } : undefined) });
    const matrix = await updates.matrix();
    expect(matrix.rows.map((row) => [row.machine, row.route, row.state, row.status?.app?.current ?? null])).toEqual([["laptop", "self", "ok", "0.48.0"], ["studio", "ssh", "ok", "0.48.1"], ["work", "none", "unavailable", null]]);
  });

  it("refuses to update laptop before the test machine runs the target, then updates it once studio does", async () => {
    let studioVersion = "0.48.0";
    const { updates, launches } = owner({ policy: { testMachine: "studio", pinnedVersion: null }, remote: (machine, method) => (machine === "studio" && method === "updates_status" ? { ok: true, result: studioStatus(studioVersion) } : undefined) });
    expect(await updates.handlers.update_dispatch({ ...intent, machine: "laptop" })).toMatchObject({ state: "refused", reason: expect.stringContaining("test machine studio first") });
    studioVersion = "0.48.1";
    expect(await updates.handlers.update_dispatch({ ...intent, machine: "laptop" })).toMatchObject({ state: "started" });
    expect(launches).toHaveLength(1);
  });

  it("refuses a version other than the pin and reports a remote unknown as read-the-intent", async () => {
    const pinned = owner({ policy: { testMachine: null, pinnedVersion: "0.48.0" } });
    expect(await pinned.updates.handlers.update_dispatch({ ...intent, machine: "laptop" })).toMatchObject({ state: "refused", reason: expect.stringContaining("pinned") });
    const uncertain = owner({ remote: (machine, method) => (machine === "studio" && method === "updates_apply" ? { ok: false, kind: "unknown", message: "Owner outcome is unknown; do not resend" } : undefined) });
    expect(await uncertain.updates.handlers.update_dispatch({ ...intent, machine: "studio" })).toMatchObject({ state: "unknown", reason: expect.stringContaining("updates_intent_get") });
    expect(await uncertain.updates.handlers.update_dispatch({ ...intent, machine: "work" })).toMatchObject({ state: "unavailable", reason: "no-authenticated-owner-route" });
  });
});

describe("update policy rpc", () => {
  it("reads the live policy and writes a new one through the owner's setter", async () => {
    let stored = { testMachine: "studio" as string | null, pinnedVersion: null as string | null };
    const { updates } = owner({ policy: stored, setPolicy: async (next) => { stored = next; return next; } });
    expect(await updates.handlers.updates_policy_get()).toEqual({ testMachine: "studio", pinnedVersion: null });
    expect(await updates.handlers.updates_policy_set({ testMachine: "laptop", pinnedVersion: "0.48.1" })).toEqual({ testMachine: "laptop", pinnedVersion: "0.48.1" });
    expect(stored).toEqual({ testMachine: "laptop", pinnedVersion: "0.48.1" });
  });

  it("refuses a write when this bb cannot persist settings, and a pin that is not exact", async () => {
    const { updates } = owner();
    await expect(updates.handlers.updates_policy_set({ testMachine: null, pinnedVersion: null })).rejects.toThrow("cannot save");
    const writable = owner({ setPolicy: async (next) => next });
    await expect(writable.updates.handlers.updates_policy_set({ testMachine: null, pinnedVersion: "latest" })).rejects.toThrow();
  });

  it("applies a policy change to the very next update decision", async () => {
    let policy: { testMachine: string | null; pinnedVersion: string | null } = { testMachine: "studio", pinnedVersion: null };
    const { updates } = owner({ policy, policyLive: () => policy, setPolicy: async (next) => { policy = next; return next; }, remote: (machine, method) => (machine === "studio" && method === "updates_status" ? { ok: true, result: studioStatus("0.48.0") } : undefined) });
    expect(await updates.handlers.update_dispatch({ ...intent, machine: "laptop" })).toMatchObject({ state: "refused" });
    await updates.handlers.updates_policy_set({ testMachine: "laptop", pinnedVersion: null });
    expect(await updates.handlers.update_dispatch({ ...intent, machine: "laptop" })).toMatchObject({ state: "started" });
  });
});

describe("embedded helper", () => {
  it("matches updater/desktop-update.mjs byte for byte (run npm run gen:helper after editing it)", () => {
    expect(HELPER_SOURCE).toBe(readFileSync(new URL("../updater/desktop-update.mjs", import.meta.url), "utf8"));
  });
});

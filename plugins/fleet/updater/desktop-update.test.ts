import { describe, expect, it } from "vitest";
import { acquireHostLock, childEnv, parseLatestMacYml, releaseUrls, run, defaultPlan } from "./desktop-update.mjs";

type Exec = { code: number; stdout: string; stderr: string };

function machine(options: {
  installed: string;
  available?: string | null;
  running?: number[];
  shipIt?: { version: string; installsOnQuit: boolean } | null;
  official?: { version: string; sha512: string; badTeam?: boolean } | null;
  newVersionBoots?: boolean;
  exact?: boolean;
  quits?: boolean;
  gui?: boolean;
  appleEvents?: boolean;
  crashes?: boolean;
  probeBroken?: boolean;
  shipItProbe?: "running" | "error";
  unbootable?: string[];
  failInstallCopy?: boolean;
  extraBundles?: Record<string, string>;
  statusFailsAfter?: number;
  attachedRuntime?: boolean;
  drain?: { safeToQuit: boolean; state?: string; reason?: string | null }[];
  jobStartsDuringDrain?: boolean;
}) {
  const files = new Map<string, string>();
  const bundles = new Map<string, { version: string; team: string }>();
  const log: string[] = [];
  let now = 1_000;
  const MAIN = "/Applications/bb.app/Contents/MacOS/bb";
  const HELPER = "/Applications/bb.app/Contents/Frameworks/bb Helper.app/Contents/MacOS/bb Helper";
  const procs = new Map<number, { ppid: number; comm: string; role: "main" | "helper" | "bridge" | "server" }>();
  let nextPid = 4000;
  const spawnApp = (withRuntime: boolean) => {
    const main = nextPid++;
    procs.set(main, { ppid: 1, comm: MAIN, role: "main" });
    procs.set(nextPid++, { ppid: main, comm: HELPER, role: "helper" });
    if (withRuntime) {
      const bridge = nextPid++;
      procs.set(bridge, { ppid: main, comm: MAIN, role: "bridge" });
      procs.set(nextPid++, { ppid: bridge, comm: MAIN, role: "server" });
    }
  };
  procs.set(563, { ppid: 1, comm: MAIN, role: "main" });
  procs.set(600, { ppid: 563, comm: HELPER, role: "helper" });
  procs.set(3280, { ppid: options.attachedRuntime ? 563 : 1, comm: MAIN, role: "bridge" });
  procs.set(3294, { ppid: 3280, comm: MAIN, role: "server" });
  procs.set(90, { ppid: 1, comm: "/usr/libexec/other", role: "helper" });
  procs.set(81801, { ppid: 1, comm: "/Applications/Cursor.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt", role: "helper" });
  if (options.shipItProbe === "running") procs.set(777, { ppid: 1, comm: "/Applications/bb.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt", role: "helper" });
  const bundleRunning = () => [...procs.values()].some((proc) => proc.comm.startsWith("/Applications/bb.app/Contents/") && !proc.comm.endsWith("/ShipIt"));
  const serverUp = () => [...procs.values()].some((proc) => proc.role === "server");
  const removeTree = (pid: number) => {
    procs.delete(pid);
    for (const [child, proc] of [...procs]) if (proc.ppid === pid) removeTree(child);
  };
  const stopGui = () => {
    for (const [pid, proc] of [...procs]) if (proc.role === "main" || proc.role === "helper") if (proc.comm.startsWith("/Applications")) {
      for (const [child, sub] of [...procs]) if (sub.ppid === pid && sub.role === "bridge") procs.set(child, { ...sub, ppid: 1 });
      procs.delete(pid);
    }
  };
  let serverVersion = options.installed;
  let lastResultId: string | null = null;
  let statusCalls = 0;
  let stoppedSeen = 0;
  const drainReplies: { safeToQuit: boolean; state?: string; reason?: string | null }[] = [...(options.drain ?? [])];
  const running = [...(options.running ?? [0])];
  const home = "/Users/test";
  const appPath = "/Applications/bb.app";
  bundles.set(appPath, { version: options.installed, team: "9QCU24SXK5" });
  const shipItBundle = `${home}/Library/Caches/dev.bb.desktop.ShipIt/update.x/bb.app`;
  if (options.shipIt) {
    bundles.set(shipItBundle, { version: options.shipIt.version, team: "9QCU24SXK5" });
    files.set(`${home}/Library/Caches/dev.bb.desktop.ShipIt/ShipItState.plist`, "plist");
  }
  const bootable = (version: string) => !(options.unbootable ?? []).includes(version) && (version !== options.available || options.newVersionBoots !== false);
  for (const [path, version] of Object.entries(options.extraBundles ?? {})) bundles.set(path, { version, team: "9QCU24SXK5" });
  const ok = (stdout = ""): Exec => ({ code: 0, stdout, stderr: "" });
  const deps = {
    platform: "darwin" as string,
    uid: 501,
    async exec(rawBin: string, rawArgs: string[]): Promise<Exec> {
      const viaNode = rawArgs[0]?.endsWith("/host-daemon/dist/bb") === true;
      const bin = viaNode ? rawArgs[0]! : rawBin;
      const args = viaNode ? rawArgs.slice(1) : rawArgs;
      log.push([bin.split("/").at(-1), ...args].join(" "));
      if (bin.endsWith("plutil") && args[0] === "-extract") {
        const app = args.at(-1)!.replace(/\/Contents\/Info\.plist$/, "");
        const bundle = bundles.get(app);
        return bundle ? ok(`${bundle.version}\n`) : { code: 1, stdout: "", stderr: "missing" };
      }
      if (bin.endsWith("plutil") && args[0] === "-convert") return ok(JSON.stringify({ bundleIdentifier: "dev.bb.desktop", targetBundleURL: "file:///Applications/bb.app/", updateBundleURL: `file://${shipItBundle}/` }));
      if (bin.endsWith("codesign") && args[0] === "--verify") return bundles.has(args.at(-1)!) ? ok() : { code: 1, stdout: "", stderr: "not signed" };
      if (bin.endsWith("codesign")) {
        const bundle = bundles.get(args.at(-1)!);
        return { code: 0, stdout: "", stderr: `Identifier=dev.bb.desktop\nTeamIdentifier=${bundle?.team ?? "none"}\n` };
      }
      if (bin.endsWith("spctl")) return ok();
      if (bin.endsWith("stat")) return ok("1024\n");
      if (bin.endsWith("sqlite3")) { files.set(args[1]!.replace(/^\.backup '|'$/g, ""), "db"); return ok(); }
      if (bin.endsWith("launchctl")) return options.gui === false ? { code: 113, stdout: "", stderr: "no domain" } : ok();
      if (bin.endsWith("xattr")) return ok();
      if (bin === "/bin/ps") {
        if (options.probeBroken) return { code: -1, stdout: "", stderr: "spawn /bin/ps ENOENT" };
        if (options.shipItProbe === "error" && !bundleRunning() && stoppedSeen++ > 0) return { code: -1, stdout: "", stderr: "spawn /bin/ps ENOENT" };
        return ok([...procs].map(([pid, proc]) => `${String(pid).padStart(5)} ${String(proc.ppid).padStart(5)} ${proc.comm}`).join("\n") + "\n");
      }
      if (bin.endsWith("kill")) {
        const pid = Number(args[1]);
        const proc = procs.get(pid);
        if (!proc) return { code: 1, stdout: "", stderr: "No such process" };
        if (proc.role === "main") { const gui = pid; for (const [child, sub] of [...procs]) if (sub.ppid === gui && sub.role === "helper") procs.delete(child); for (const [child, sub] of [...procs]) if (sub.ppid === gui && sub.role === "bridge") removeTree(child); procs.delete(gui); }
        else removeTree(pid);
        return ok();
      }
      if (bin.endsWith("osascript")) {
        if (options.appleEvents === false) return { code: 1, stdout: "", stderr: "Not authorized to send Apple events to bb. (-1743)" };
        if (options.quits !== false) {
          stopGui();
          if (options.shipIt?.installsOnQuit) bundles.set(appPath, bundles.get(shipItBundle)!);
        }
        return ok();
      }
      if (bin.endsWith("open")) {
        const version = bundles.get(appPath)!.version;
        serverVersion = bootable(version) ? version : "";
        if (serverVersion !== "") spawnApp(true);
        else if (options.crashes !== true) spawnApp(false);
        return ok();
      }
      if (bin.endsWith("ditto")) {
        if (args[0] === "-x") {
          bundles.set(`${args[3]}/bb.app`, { version: options.official!.version, team: options.official!.badTeam ? "OTHERTEAM1" : "9QCU24SXK5" });
          return ok();
        }
        const source = bundles.get(args[0]!);
        if (!source) return { code: 1, stdout: "", stderr: "no source" };
        if (options.failInstallCopy && args[1] === appPath && args[0]!.includes("/staged/")) {
          bundles.set(appPath, { version: "partial", team: "none" });
          return { code: 1, stdout: "", stderr: "ditto: No space left on device" };
        }
        bundles.set(args[1]!, { ...source });
        return ok();
      }
      if (args[0] === "plugin" && args[4] === "update_drain_status") {
        const reply = drainReplies.length > 1 ? drainReplies.shift()! : drainReplies[0];
        if (reply === undefined) return { code: 1, stdout: JSON.stringify({ ok: false, error: { message: "Unknown RPC method update_drain_status" } }), stderr: "" };
        if (reply.safeToQuit && options.jobStartsDuringDrain) running.splice(0, running.length, 0);
        return ok(JSON.stringify({ ok: true, result: { intentId: "fleet-upd-0001", gateActive: true, helperArmed: true, state: "held", reason: null, ...reply } }));
      }
      if (args.join(" ") === "updates app --json") {
        if (!serverUp() || serverVersion === "") return { code: 1, stdout: "", stderr: "connect ECONNREFUSED" };
        if (options.statusFailsAfter !== undefined && statusCalls++ >= options.statusFailsAfter) return { code: 1, stdout: "", stderr: "timeout" };
        const count = running.length > 1 ? running.shift()! : running[0]!;
        return ok(JSON.stringify({ current: { version: serverVersion }, available: options.available ? { version: options.available } : null, runningThreadCount: count, desktopUpdateSupported: true, support: { kind: "unsupported", reason: "desktop" }, lastResult: lastResultId ? { id: lastResultId } : null, ...(options.exact ? { experimental_exactApply: true } : {}) }));
      }
      if (args[0] === "updates" && args[2] === "apply") {
        const id = args.indexOf("--request-id");
        lastResultId = id >= 0 ? args[id + 1]! : "vendor-random";
        const target = options.available!;
        bundles.set(appPath, { version: target, team: "9QCU24SXK5" });
        for (const pid of [...procs.keys()]) if (procs.get(pid)!.comm.startsWith("/Applications")) procs.delete(pid);
        serverVersion = bootable(target) ? target : "";
        if (serverVersion !== "") spawnApp(true);
        else if (options.crashes !== true) spawnApp(false);
        return ok("{}");
      }
      return { code: 127, stdout: "", stderr: `unexpected ${bin}` };
    },
    async download(url: string, path: string) {
      log.push(`download ${url}`);
      if (url.endsWith("latest-mac.yml")) files.set(path, `version: ${options.official!.version}\nfiles:\n  - url: bb-${options.official!.version}-arm64.zip\n    sha512: ${options.official!.sha512}\n    size: 42\npath: x\n`);
      else files.set(path, "zip");
    },
    async sha512() { return options.official?.sha512 ?? "nope"; },
    async readText(path: string) { const text = files.get(path); if (text === undefined) throw new Error(`ENOENT ${path}`); return text; },
    async writeText(path: string, text: string) { files.set(path, text); },
    exists: (path: string) => files.has(path) || bundles.has(path),
    async move(from: string, to: string) { const bundle = bundles.get(from); if (bundle) { bundles.delete(from); bundles.set(to, bundle); } },
    async mkdir() {},
    async sleep(ms: number) { now += ms; },
    lockHolder: null as null | { intentId: string; pid: number },
    async lock(_path: string, owner: { intentId: string }) {
      if (deps.lockHolder) return { acquired: false, holder: deps.lockHolder };
      deps.lockHolder = { intentId: owner.intentId, pid: 1 };
      return { acquired: true, release: async () => { deps.lockHolder = null; } };
    },
    now: () => now,
  };
  return { deps, log, bundles, files, appPath, home, procs, state: () => ({ appRunning: bundleRunning(), serverVersion }) };
}

const plan = (fixture: ReturnType<typeof machine>, overrides: Record<string, unknown>) => defaultPlan({ home: fixture.home, intentId: "fleet-upd-0001", drainTimeoutMs: 120_000, drainEveryMs: 30_000, allowUngatedQuit: true, ...overrides });

describe("vendor release metadata", () => {
  it("builds exact tag URLs and reads the published sha512 for the zip", () => {
    expect(releaseUrls("0.48.1")).toEqual({ fileName: "bb-0.48.1-arm64.zip", zip: "https://github.com/get-bb/bb/releases/download/desktop-v0.48.1/bb-0.48.1-arm64.zip", manifest: "https://github.com/get-bb/bb/releases/download/desktop-v0.48.1/latest-mac.yml" });
    expect(() => releaseUrls("0.48.1; rm -rf /")).toThrow();
    const yml = "version: 0.48.1\nfiles:\n  - url: bb-0.48.1-arm64.zip\n    sha512: abc==\n    size: 199796292\n  - url: bb-0.48.1-arm64.dmg\n    sha512: def==\n    size: 1\npath: bb-0.48.1-arm64.zip\n";
    expect(parseLatestMacYml(yml, "bb-0.48.1-arm64.zip")).toEqual({ sha512: "abc==", size: 199796292 });
  });
});

describe("admission drain gate", () => {
  const drain = { v: 1, ownerServerId: "studio-srv", hostId: "host_studio", intentId: "fleet-upd-0001" };

  it("refuses to stop bb without a drain unless the operator ran it unguarded", async () => {
    const fixture = machine({ installed: "0.46.0", official: { version: "0.48.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1", allowUngatedQuit: false }), fixture.deps);
    expect(result).toMatchObject({ phase: "refused", reason: expect.stringContaining("No admission drain") });
    expect(fixture.log.some((line) => line.startsWith("kill"))).toBe(false);
  });

  it("waits for the drain to report safe to quit, then stops bb", async () => {
    const fixture = machine({ installed: "0.46.0", official: { version: "0.48.1", sha512: "sha==" }, drain: [{ safeToQuit: false, state: "busy" }, { safeToQuit: false, state: "busy" }, { safeToQuit: true }] });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1", allowUngatedQuit: false, drain }), fixture.deps);
    expect(result.reason ?? "").toBe("");
    expect(result).toMatchObject({ phase: "updated", drain: "safe" });
    expect(fixture.log.filter((line) => line.includes("update_drain_status"))).toHaveLength(3);
  });

  it("refuses without stopping when the drain is released, unavailable or never safe", async () => {
    for (const reply of [{ safeToQuit: false, state: "unavailable", reason: "No atomic core admission gate" }, { safeToQuit: false, state: "released" }]) {
      const fixture = machine({ installed: "0.46.0", official: { version: "0.48.1", sha512: "sha==" }, drain: [reply] });
      const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1", allowUngatedQuit: false, drain }), fixture.deps);
      expect(result).toMatchObject({ phase: "refused", reason: expect.stringContaining(`The admission drain is ${reply.state}`) });
      expect(fixture.log.some((line) => line.startsWith("kill"))).toBe(false);
    }
    const never = machine({ installed: "0.46.0", official: { version: "0.48.1", sha512: "sha==" }, drain: [{ safeToQuit: false, state: "busy" }] });
    const result = await run(plan(never, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1", allowUngatedQuit: false, drain, drainTimeoutMs: 60_000 }), never.deps);
    expect(result).toMatchObject({ phase: "refused", reason: expect.stringContaining("never reported safe") });
  });

  it("aborts before stopping bb when the owner requested cancellation, and leaves a terminal refused receipt", async () => {
    const fixture = machine({ installed: "0.46.0", official: { version: "0.48.1", sha512: "sha==" }, drain: [{ safeToQuit: false, state: "held", cancelRequested: true } as never] });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1", allowUngatedQuit: false, drain }), fixture.deps);
    expect(result).toMatchObject({ phase: "refused", intentId: "fleet-upd-0001", fromVersion: "0.46.0", targetVersion: "0.48.1", reason: expect.stringContaining("cancelled on the owner") });
    expect(typeof result.updatedAt).toBe("number");
    expect(fixture.log.some((line) => line.startsWith("kill"))).toBe(false);
  });

  it("asks the native server to apply only after the drain is safe", async () => {
    const fixture = machine({ installed: "0.48.0", available: "0.48.1", exact: true, drain: [{ safeToQuit: false, state: "busy" }, { safeToQuit: true }] });
    const result = await run(plan(fixture, { mode: "native", fromVersion: "0.48.0", targetVersion: "0.48.1", allowUngatedQuit: false, drain }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated" });
    const applyAt = fixture.log.findIndex((line) => line.includes("updates app apply"));
    const lastDrain = fixture.log.map((line, index) => (line.includes("update_drain_status") ? index : -1)).filter((index) => index >= 0).at(-1)!;
    expect(lastDrain).toBeLessThan(applyAt);
  });
});

describe("child environment", () => {
  it("drops every inherited bb, Electron and PATH setting so the CLI cannot reach another server", () => {
    const env = childEnv({ BB_SERVER_URL: "http://laptop", BB_DATA_DIR: "/x", BB_THREAD_ID: "thr", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--x", PATH: "/evil", HOME: "/Users/tester" });
    expect(env).toEqual({ HOME: "/Users/tester", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  });
});

describe("bootstrap update (server without a desktop update relay)", () => {
  it("installs the vendor's staged ShipIt update on a graceful quit, relaunches and proves the version", async () => {
    const fixture = machine({ installed: "0.46.0", available: null, shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated", source: "vendor-shipit", proof: { version: "0.46.1" } });
    expect(fixture.bundles.get(`${fixture.home}/Library/Application Support/bb-fleet-updates/backups/bb-0.46.0.app`)).toMatchObject({ version: "0.46.0" });
    expect(fixture.log.filter((line) => line.startsWith("osascript"))).toHaveLength(1);
  });

  it("falls back to the verified official package when ShipIt does not install on quit", async () => {
    const fixture = machine({ installed: "0.46.0", shipIt: { version: "0.46.1", installsOnQuit: false }, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1", shipItTimeoutMs: 10_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated" });
    expect(result.history.map((entry: { phase: string }) => entry.phase)).toContain("installing");
    expect(fixture.log).toContain("download https://github.com/get-bb/bb/releases/download/desktop-v0.46.1/latest-mac.yml");
    expect(fixture.bundles.get(fixture.appPath)).toMatchObject({ version: "0.46.1" });
  });

  it("stops bb with SIGTERM when Apple Events are not allowed, and installs the verified official package", async () => {
    const fixture = machine({ installed: "0.46.0", appleEvents: false, shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1", shipItTimeoutMs: 10_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated", quitVia: "sigterm", installedFrom: "official-release" });
    expect(fixture.log).toContain("kill -TERM 563");
    expect(fixture.log).toContain("kill -TERM 3280");
  });

  it("refuses to restart when the final idle check gets no answer", async () => {
    const fixture = machine({ installed: "0.46.0", statusFailsAfter: 1, shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "refused" });
    expect(result.reason).toContain("final idle check");
    expect(fixture.log.some((line) => line.startsWith("osascript") || line.startsWith("kill"))).toBe(false);
  });

  it("quits with SIGTERM only when quitMode is signal, without Apple Events, and installs the official package", async () => {
    const fixture = machine({ installed: "0.46.0", shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.46.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated", quitVia: "sigterm", source: "official-release" });
    expect(fixture.log.some((line) => line.startsWith("osascript"))).toBe(false);
  });

  it("refuses while another helper holds the host lock and leaves the live intent untouched", async () => {
    const fixture = machine({ installed: "0.46.0", official: { version: "0.46.1", sha512: "sha==" } });
    const p = plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" });
    const live = JSON.stringify({ v: 1, intentId: p.intentId, mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1", phase: "installing", history: [] });
    await fixture.deps.writeText(`${p.stateDir}/intents/${p.intentId}.json`, live);
    fixture.deps.lockHolder = { intentId: p.intentId, pid: 4242 };
    const result = await run(p, fixture.deps);
    expect(result).toMatchObject({ phase: "busy" });
    expect(await fixture.deps.readText(`${p.stateDir}/intents/${p.intentId}.json`)).toBe(live);
    expect(fixture.log).toEqual([]);
  });

  it("refuses an intent id reused for another version or mode", async () => {
    const fixture = machine({ installed: "0.46.0", shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" } });
    const p = plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" });
    await run(p, fixture.deps);
    expect(await run({ ...p, targetVersion: "0.48.1" }, fixture.deps)).toMatchObject({ phase: "conflict" });
    expect(await run({ ...p, mode: "native" }, fixture.deps)).toMatchObject({ phase: "conflict" });
  });

  it("goes straight from 0.46.0 to 0.48.1 with the exact official tag, ignoring the mismatched staged 0.46.1", async () => {
    const fixture = machine({ installed: "0.46.0", shipIt: { version: "0.46.1", installsOnQuit: false }, official: { version: "0.48.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated", source: "official-release", quitVia: "sigterm", proof: { version: "0.48.1" } });
    expect(fixture.log).toContain("download https://github.com/get-bb/bb/releases/download/desktop-v0.48.1/latest-mac.yml");
    expect(fixture.log.some((line) => line.startsWith("osascript"))).toBe(false);
  });

  it.each(["running", "error"] as const)("holds before touching the app when ShipIt is %s after the quit", async (shipItProbe) => {
    const fixture = machine({ installed: "0.46.0", shipItProbe, official: { version: "0.48.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1", shipItTimeoutMs: 10_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "install-held" });
    expect(fixture.bundles.get(fixture.appPath)).toMatchObject({ version: "0.46.0" });
    expect(fixture.log.some((line) => line.startsWith("ditto /Users/test/Library/Application Support/bb-fleet-updates/staged"))).toBe(false);
    expect(fixture.log.some((line) => line.startsWith("open"))).toBe(false);
  });

  it("stops the orphaned 0.46.0 runtime as well as the desktop main process, by executable path not argv", async () => {
    const fixture = machine({ installed: "0.46.0", official: { version: "0.48.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated", quitVia: "sigterm" });
    expect(fixture.log.filter((line) => line.startsWith("kill")).sort()).toEqual(["kill -TERM 3280", "kill -TERM 563"]);
    expect(fixture.procs.has(90)).toBe(true);
    expect(fixture.procs.has(81801)).toBe(true);
    expect(fixture.log.some((line) => line.includes("81801"))).toBe(false);
  });

  it("never signals bb's own ShipIt and waits for it before touching the app", async () => {
    const fixture = machine({ installed: "0.46.0", shipItProbe: "running", official: { version: "0.48.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1", shipItTimeoutMs: 10_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "install-held" });
    expect(fixture.procs.has(777)).toBe(true);
    expect(fixture.log.some((line) => line === "kill -TERM 777")).toBe(false);
  });

  it("signals only the root when the runtime is still attached to the desktop main process", async () => {
    const fixture = machine({ installed: "0.46.0", attachedRuntime: true, official: { version: "0.48.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated" });
    expect(fixture.log.filter((line) => line.startsWith("kill"))).toEqual(["kill -TERM 563"]);
  });

  it("finishes the job when the desktop main process is already gone and only the runtime remains", async () => {
    const fixture = machine({ installed: "0.46.0", official: { version: "0.48.1", sha512: "sha==" } });
    fixture.procs.delete(563);
    fixture.procs.delete(600);
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.48.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated" });
    expect(fixture.log.filter((line) => line.startsWith("kill"))).toEqual(["kill -TERM 3280"]);
  });

  it("never treats a failed process probe as proof that bb quit", async () => {
    const fixture = machine({ installed: "0.46.0", probeBroken: true, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", quitMode: "signal", fromVersion: "0.46.0", targetVersion: "0.46.1", quitTimeoutMs: 10_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "failed" });
    expect(result.reason).toContain("did not fully stop");
    expect(fixture.bundles.get(fixture.appPath)).toMatchObject({ version: "0.46.0" });
    expect(fixture.log.some((line) => line.startsWith("ditto /Users/test/Library/Application Support/bb-fleet-updates/staged"))).toBe(false);
  });

  it("refuses a package signed by another team without quitting bb", async () => {
    const fixture = machine({ installed: "0.46.0", shipIt: null, official: { version: "0.46.1", sha512: "sha==", badTeam: true } });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "refused" });
    expect(result.reason).toContain("team identifier");
    expect(fixture.log.some((line) => line.startsWith("osascript"))).toBe(false);
    expect(fixture.state().appRunning).toBe(true);
  });

  it("waits for running threads and refuses without restarting when they never finish", async () => {
    const fixture = machine({ installed: "0.46.0", running: [2], shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" }), fixture.deps);
    expect(result.phase).toBe("refused");
    expect(fixture.log.some((line) => line.startsWith("osascript"))).toBe(false);
  });

  it("drains: proceeds once the running threads finish", async () => {
    const fixture = machine({ installed: "0.46.0", running: [1, 1, 0], shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" }), fixture.deps);
    expect(result.phase).toBe("updated");
  });

  it("refuses without a GUI login session and when the installed version is not the expected one", async () => {
    const noGui = machine({ installed: "0.46.0", gui: false, official: { version: "0.46.1", sha512: "sha==" } });
    expect(await run(plan(noGui, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" }), noGui.deps)).toMatchObject({ phase: "refused" });
    const moved = machine({ installed: "0.46.1", official: { version: "0.48.1", sha512: "sha==" } });
    const result = await run(plan(moved, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.48.1" }), moved.deps);
    expect(result.reason).toContain("not the expected 0.46.0");
  });

  it("rolls back to the backup when the new version crashes and never reconnects", async () => {
    const fixture = machine({ installed: "0.46.0", available: "0.46.1", crashes: true, shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" }, newVersionBoots: false });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1", reconnectTimeoutMs: 20_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "rolled-back" });
    expect(fixture.bundles.get(fixture.appPath)).toMatchObject({ version: "0.46.0" });
    expect(fixture.state().serverVersion).toBe("0.46.0");
  });

  it("holds the rollback when the new version is running but its work is unknown", async () => {
    const fixture = machine({ installed: "0.46.0", available: "0.46.1", shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" }, newVersionBoots: false });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1", reconnectTimeoutMs: 20_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "rollback-held", backup: `${fixture.home}/Library/Application Support/bb-fleet-updates/backups/bb-0.46.0.app` });
    expect(fixture.state().appRunning).toBe(true);
    expect(fixture.bundles.get(fixture.appPath)).toMatchObject({ version: "0.46.1" });
    expect(fixture.log.filter((line) => line.startsWith("osascript"))).toHaveLength(1);
  });

  it("moves a partial copy aside, restores the displaced bundle and proves the old version", async () => {
    const fixture = machine({ installed: "0.46.0", failInstallCopy: true, shipIt: null, official: { version: "0.46.1", sha512: "sha==" } });
    const result = await run(plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "failed" });
    expect(result.reason).toContain("was put back and reconnected");
    expect(fixture.bundles.get(fixture.appPath)).toMatchObject({ version: "0.46.0" });
    expect(fixture.bundles.get(`${fixture.home}/Library/Application Support/bb-fleet-updates/backups/partial-fleet-upd-0001.app`)).toMatchObject({ version: "partial" });
    expect(fixture.state().serverVersion).toBe("0.46.0");
  });

  it("is idempotent on a terminal intent and never repeats a quit or install", async () => {
    const fixture = machine({ installed: "0.46.0", shipIt: { version: "0.46.1", installsOnQuit: true }, official: { version: "0.46.1", sha512: "sha==" } });
    const p = plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" });
    await run(p, fixture.deps);
    const quits = fixture.log.filter((line) => line.startsWith("osascript")).length;
    expect(await run(p, fixture.deps)).toMatchObject({ phase: "updated" });
    expect(fixture.log.filter((line) => line.startsWith("osascript"))).toHaveLength(quits);
  });

  it("reconciles an interrupted helper without retrying the restart", async () => {
    const fixture = machine({ installed: "0.46.0", official: { version: "0.46.1", sha512: "sha==" } });
    const p = plan(fixture, { mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1" });
    await fixture.deps.writeText(`${p.stateDir}/intents/${p.intentId}.json`, JSON.stringify({ v: 1, intentId: p.intentId, mode: "bootstrap", fromVersion: "0.46.0", targetVersion: "0.46.1", phase: "quitting", history: [] }));
    const result = await run(p, fixture.deps);
    expect(result).toMatchObject({ phase: "failed" });
    expect(fixture.log.some((line) => line.startsWith("osascript"))).toBe(false);
  });
});

describe("explicit rollback", () => {
  it("backs up the current version first and restores it when the rollback target does not reconnect", async () => {
    const old = "/Users/test/Library/Application Support/bb-fleet-updates/backups/bb-0.46.0.app";
    const fixture = machine({ installed: "0.46.1", crashes: true, unbootable: ["0.46.0"], extraBundles: { [old]: "0.46.0" } });
    const result = await run(plan(fixture, { mode: "rollback", fromVersion: "0.46.1", targetVersion: "0.46.0", backupPath: old, reconnectTimeoutMs: 20_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "rolled-back", backup: "/Users/test/Library/Application Support/bb-fleet-updates/backups/bb-0.46.1.app" });
    expect(fixture.bundles.get(fixture.appPath)).toMatchObject({ version: "0.46.1" });
    expect(fixture.bundles.get(old)).toMatchObject({ version: "0.46.0" });
    expect(fixture.state().serverVersion).toBe("0.46.1");
  });

  it("swaps a verified backup in and proves it", async () => {
    const old = "/Users/test/Library/Application Support/bb-fleet-updates/backups/bb-0.46.0.app";
    const fixture = machine({ installed: "0.46.1", extraBundles: { [old]: "0.46.0" } });
    const result = await run(plan(fixture, { mode: "rollback", fromVersion: "0.46.1", targetVersion: "0.46.0", backupPath: old }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated", source: "backup" });
    expect(fixture.state().serverVersion).toBe("0.46.0");
  });
});

describe("host lock", () => {
  it("admits exactly one of several concurrent claimers", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = `${await mkdtemp(`${tmpdir()}/fleet-lock-`)}/host.lock.d`;
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireHostLock(dir, { intentId: `intent-${i}aaaa` })));
    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.acquired).every((claim) => claim.reason === "live" || claim.reason === "unreadable")).toBe(true);
  });

  it("never reclaims a dead or unreadable holder, even for the same intent", async () => {
    const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = `${await mkdtemp(`${tmpdir()}/fleet-lock-`)}/host.lock.d`;
    await mkdir(dir);
    expect(await acquireHostLock(dir, { intentId: "intent-cccc3" })).toMatchObject({ acquired: false, reason: "unreadable" });
    await writeFile(`${dir}/holder.json`, JSON.stringify({ intentId: "intent-dddd4", pid: 999_999, token: "t" }));
    expect(await acquireHostLock(dir, { intentId: "intent-dddd4" })).toMatchObject({ acquired: false, reason: "stale" });
    expect(JSON.parse(await readFile(`${dir}/holder.json`, "utf8"))).toMatchObject({ intentId: "intent-dddd4", pid: 999_999 });
  });

  it("releases only its own claim", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = `${await mkdtemp(`${tmpdir()}/fleet-lock-`)}/host.lock.d`;
    const mine = await acquireHostLock(dir, { intentId: "intent-eeee5" });
    await writeFile(`${dir}/holder.json`, JSON.stringify({ intentId: "intent-ffff6", pid: process.pid, token: "someone-else" }));
    await mine.release!();
    expect(existsSync(dir)).toBe(true);
    const fresh = `${dir}-2`;
    const own = await acquireHostLock(fresh, { intentId: "intent-gggg7" });
    await own.release!();
    expect(existsSync(fresh)).toBe(false);
  });
});

describe("native update (server relays to its desktop updater)", () => {
  it("applies exactly with the intent id and proves the result id and version after restart", async () => {
    const fixture = machine({ installed: "0.46.1", available: "0.48.1", exact: true });
    const result = await run(plan(fixture, { mode: "native", fromVersion: "0.46.1", targetVersion: "0.48.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "updated", exact: true, proof: { version: "0.48.1", resultId: "fleet-upd-0001" } });
    expect(fixture.log).toContain("bb updates app apply --no-wait --json --expect-version 0.48.1 --request-id fleet-upd-0001");
  });

  it("refuses a server that cannot pin the exact version", async () => {
    const fixture = machine({ installed: "0.46.1", available: "0.48.1" });
    const result = await run(plan(fixture, { mode: "native", fromVersion: "0.46.1", targetVersion: "0.48.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "refused" });
    expect(result.reason).toContain("exact official tag");
    expect(fixture.log.some((line) => line.includes("apply"))).toBe(false);
  });

  it("refuses when another version is available than the one requested", async () => {
    const fixture = machine({ installed: "0.46.1", available: "0.48.2" });
    const result = await run(plan(fixture, { mode: "native", fromVersion: "0.46.1", targetVersion: "0.48.1" }), fixture.deps);
    expect(result).toMatchObject({ phase: "refused" });
    expect(fixture.log.some((line) => line.includes("apply"))).toBe(false);
  });

  it("rolls back from the pre-update backup when the new version crashes and does not come back", async () => {
    const fixture = machine({ installed: "0.46.1", available: "0.48.1", exact: true, newVersionBoots: false, crashes: true });
    const result = await run(plan(fixture, { mode: "native", fromVersion: "0.46.1", targetVersion: "0.48.1", reconnectTimeoutMs: 30_000 }), fixture.deps);
    expect(result).toMatchObject({ phase: "rolled-back" });
    expect(fixture.bundles.get(fixture.appPath)).toMatchObject({ version: "0.46.1" });
  });
});

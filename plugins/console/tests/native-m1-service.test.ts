import { describe, expect, it } from "vitest";
import { createM1Service, M1_PROBE_SCRIPT } from "../server-m1-service";
import { parseProbe, serviceView, type ServiceProbe } from "../src/m1-service-model";

const BOOT = 1_793_000_000;

const probeText = (over: Record<string, string | string[]> = {}) => {
  const fields: Record<string, string | string[]> = {
    boot: String(BOOT),
    now: String(BOOT + 3 * 3600 + 12 * 60),
    bb: "running",
    version: "0.48.1",
    bbage: ["03:08:40", "03:08:39"],
    gui: "present",
    app: "absent",
    loginitem: "unknown",
    agent: "running",
    awake: "held",
    awakecfg: '{"enabled":true,"selection":{"mode":"all"}}',
    ...over,
  };
  return Object.entries(fields)
    .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}=${v}`))
    .join("\n");
};

describe("parsing what Studio reports", () => {
  it("reads whether bb.app is a login item", () => {
    expect(parseProbe(probeText({ loginitem: "present" })).loginItem).toBe("present");
    expect(parseProbe(probeText({ loginitem: "absent" })).loginItem).toBe("absent");
    expect(parseProbe(probeText({ loginitem: "garbled" })).loginItem).toBe("unknown");
  });

  it("reads boot time, uptime, bb state, desktop session and keep-awake", () => {
    const probe = parseProbe(probeText());
    expect(probe).toEqual({
      bootAt: BOOT * 1000,
      probedAt: (BOOT + 3 * 3600 + 12 * 60) * 1000,
      bbRunning: true,
      bbVersion: "0.48.1",
      bbStartedAt: (BOOT + 3 * 3600 + 12 * 60 - (3 * 3600 + 8 * 60 + 40)) * 1000,
      gui: "present",
      app: "absent",
      loginItem: "unknown",
      launchAgent: "running",
      awakeHeld: true,
      awakeSetting: { enabled: true, scope: "all hosts" },
    });
  });

  it("reads day-prefixed elapsed times and picks the oldest bb process", () => {
    const probe = parseProbe(probeText({ bbage: ["2-01:00:00", "00:10"], now: String(BOOT + 3 * 86400) }));
    expect(probe.bbStartedAt).toBe((BOOT + 3 * 86400 - (2 * 86400 + 3600)) * 1000);
  });

  it("marks unknown values rather than guessing", () => {
    const probe = parseProbe("now=100\nbb=down\n");
    expect(probe.bootAt).toBeNull();
    expect(probe.bbRunning).toBe(false);
    expect(probe.bbStartedAt).toBeNull();
    expect(probe.gui).toBe("unknown");
    expect(probe.app).toBe("unknown");
    expect(probe.loginItem).toBe("unknown");
    expect(probe.launchAgent).toBe("unknown");
    expect(probe.awakeHeld).toBeNull();
    expect(probe.awakeSetting).toBeNull();
  });

  it("describes a keep-awake setting that names specific hosts", () => {
    const probe = parseProbe(probeText({ awakecfg: '{"enabled":false,"selection":{"mode":"selected","hostIds":["a","b"]}}' }));
    expect(probe.awakeSetting).toEqual({ enabled: false, scope: "2 chosen hosts" });
  });
});

const probe = (over: Partial<ServiceProbe> = {}): ServiceProbe => ({
  bootAt: BOOT * 1000,
  probedAt: (BOOT + 3 * 3600 + 12 * 60) * 1000,
  bbRunning: true,
  bbVersion: "0.48.1",
  bbStartedAt: (BOOT + 90) * 1000,
  gui: "present",
  app: "absent",
  loginItem: "unknown",
  launchAgent: "running",
  awakeHeld: true,
  awakeSetting: { enabled: true, scope: "all hosts" },
  ...over,
});
const row = (view: ReturnType<typeof serviceView>, key: string) => view.rows.find((r) => r.key === key)!;

describe("Studio service view", () => {
  it("says Studio is running headless with the launch agent up, keep-awake on and when it booted", () => {
    const view = serviceView({ reachable: true, probe: probe() });
    expect(view.headline).toBe("Running headless");
    expect(view.tone).toBe("ok");
    expect(row(view, "service").value).toBe("bb 0.48.1 is running");
    expect(row(view, "service").detail).toBe("Background launch agent is running");
    expect(row(view, "app").value).toBe("Desktop app closed");
    expect(row(view, "app").tone).toBe("ok");
    expect(row(view, "keep-awake").value).toBe("Keep Awake is on: the Mac stays awake");
    expect(row(view, "keep-awake").detail).toBe("Turned on in bb for all hosts");
    expect(row(view, "boot").value).toMatch(/^\w{3} \d{1,2} \w{3}, \d{2}:\d{2}$/);
    expect(row(view, "boot").detail).toBe("Up 3h 12m");
  });

  it("treats a login session as information, not as a reason to doubt headless", () => {
    const view = serviceView({ reachable: true, probe: probe({ gui: "present" }) });
    expect(view.headline).toBe("Running headless");
    expect(row(view, "session").value).toBe("Login session open (the launch agent needs it)");
    expect(row(view, "session").tone).toBe("muted");
    expect(serviceView({ reachable: true, probe: probe({ gui: "absent" }) }).headline).toBe("Running headless");
  });

  it("reports the reboot check as passed when bb came up by itself with the app closed", () => {
    const view = serviceView({ reachable: true, probe: probe() });
    expect(view.reboot).toEqual({ state: "passed", text: "bb came up 1m 30s after the last boot with the desktop app closed. Start work on Studio to finish the check." });
  });

  it("does not claim headless while the desktop app is open", () => {
    const view = serviceView({ reachable: true, probe: probe({ app: "present" }) });
    expect(view.headline).toBe("Running with the desktop app open");
    expect(view.tone).toBe("warn");
    expect(row(view, "app").value).toBe("Desktop app is open");
    expect(view.reboot.state).toBe("waiting");
    expect(view.reboot.text).toContain("desktop app is open");
  });

  it("says when bb was started long after the boot, so it may have been started by hand", () => {
    const view = serviceView({ reachable: true, probe: probe({ bbStartedAt: (BOOT + 3600) * 1000 }) });
    expect(view.reboot.state).toBe("waiting");
    expect(view.reboot.text).toContain("started 1h 0m after the last boot");
  });

  it("says so when Keep Awake is on in bb but nothing is holding the Mac awake", () => {
    const view = serviceView({ reachable: true, probe: probe({ awakeHeld: false }) });
    expect(row(view, "keep-awake").value).toBe("Keep Awake is on in bb, but nothing is holding the Mac awake");
    expect(row(view, "keep-awake").tone).toBe("warn");
  });

  it("shows in plain words whether bb opens at login", () => {
    expect(row(serviceView({ reachable: true, probe: probe({ loginItem: "present" }) }), "login")).toMatchObject({ label: "At login", value: "bb opens at login", detail: "Login item for /Applications/bb.app", tone: "ok" });
    expect(row(serviceView({ reachable: true, probe: probe({ loginItem: "absent" }) }), "login")).toMatchObject({ value: "bb does not open at login", tone: "warn" });
    expect(row(serviceView({ reachable: true, probe: probe({ loginItem: "unknown" }) }), "login")).toMatchObject({ value: "Not readable", tone: "muted" });
  });

  it("counts bb opening at login as the reboot check passing, even with the desktop app open and a long uptime", () => {
    const view = serviceView({ reachable: true, probe: probe({ app: "present", loginItem: "present", bbStartedAt: (BOOT + 17 * 86400) * 1000 }) });
    expect(view.reboot.state).toBe("passed");
    expect(view.reboot.text).toContain("bb opens at login");
    expect(view.headline).toBe("bb runs in the desktop app, which opens at login");
    expect(view.tone).toBe("ok");
    expect(row(view, "app").value).toBe("Desktop app is open");
    expect(row(view, "app").tone).toBe("ok");
  });

  it("does not pass the reboot check on a login item while bb is not running", () => {
    const view = serviceView({ reachable: true, probe: probe({ bbRunning: false, bbStartedAt: null, app: "present", loginItem: "present" }) });
    expect(view.reboot.state).toBe("failed");
    expect(view.headline).toBe("bb is not running");
  });

  it("keeps waiting with the app open and no login item", () => {
    expect(serviceView({ reachable: true, probe: probe({ app: "present", loginItem: "absent" }) }).reboot.state).toBe("waiting");
    expect(serviceView({ reachable: true, probe: probe({ app: "present", loginItem: "unknown" }) }).headline).toBe("Running with the desktop app open");
  });

  it("describes a launch agent that is installed but stopped, or missing", () => {
    expect(row(serviceView({ reachable: true, probe: probe({ launchAgent: "stopped" }) }), "service").detail).toBe("Background launch agent is installed but not running");
    expect(row(serviceView({ reachable: true, probe: probe({ launchAgent: "absent" }) }), "service").detail).toBe("No background launch agent: bb runs only while the app does");
    expect(row(serviceView({ reachable: true, probe: probe({ launchAgent: "unknown" }) }), "service").detail).toBeNull();
  });

  it("flags bb not running and keep-awake not held", () => {
    const view = serviceView({ reachable: true, probe: probe({ bbRunning: false, bbStartedAt: null, awakeHeld: false, awakeSetting: { enabled: false, scope: "all hosts" } }) });
    expect(view.headline).toBe("bb is not running");
    expect(view.tone).toBe("bad");
    expect(row(view, "keep-awake").value).toBe("Keep Awake is off: the Mac may sleep");
    expect(row(view, "keep-awake").detail).toBe("Turned off in bb for all hosts");
    expect(view.reboot.state).toBe("failed");
  });

  it("reports an unreachable Studio without inventing values", () => {
    const view = serviceView({ reachable: false, probe: null });
    expect(view.headline).toBe("Studio not reachable");
    expect(view.tone).toBe("bad");
    expect(view.rows).toEqual([]);
    expect(view.reboot.state).toBe("waiting");
  });

  it("reads as checking before the first answer", () => {
    expect(serviceView({ reachable: null, probe: null }).headline).toBe("Checking Studio");
  });
});

describe("Studio service probe", () => {
  it("only reads: no write, no kill, no restart in the remote script", () => {
    expect(M1_PROBE_SCRIPT).not.toMatch(/\b(rm|kill|pkill|launchctl\s+(load|unload|bootstrap|bootout|kickstart)|reboot|shutdown|open\s|defaults\s+write|tee|>\s*[^/&\s])/);
  });

  it("looks for the launch agent, the desktop app and the caffeinate form keep-awake runs", () => {
    expect(M1_PROBE_SCRIPT).toContain("app.getbb.host-daemon.");
    expect(M1_PROBE_SCRIPT).toContain("^/Applications/bb\\.app/Contents/MacOS/bb( |$)");
    expect(M1_PROBE_SCRIPT).toContain("[c]affeinate -i -w");
    expect(M1_PROBE_SCRIPT).toContain("host-daemon/dist/");
  });

  it("runs bb's command line with the app's own runtime when Studio has no node on its path, and reads the login items", () => {
    expect(M1_PROBE_SCRIPT).toContain('ELECTRON_RUN_AS_NODE=1 perl -e \'alarm shift; exec @ARGV\' "$t" "$APP" "$BB"');
    expect(M1_PROBE_SCRIPT).toContain("APP=/Applications/bb.app/Contents/MacOS/bb");
    expect(M1_PROBE_SCRIPT).toContain("every login item");
  });

  it("returns the parsed probe and caches it between nearby calls", async () => {
    let calls = 0;
    let clock = 1_000;
    const service = createM1Service({ run: async () => { calls++; return probeText(); }, now: () => clock });
    const first = await service.get();
    expect(first.reachable).toBe(true);
    expect(first.probe?.bbRunning).toBe(true);
    clock += 5_000;
    await service.get();
    expect(calls).toBe(1);
    clock += 30_000;
    await service.get();
    expect(calls).toBe(2);
  });

  it("returns unreachable when the connection fails and the cache is empty", async () => {
    const service = createM1Service({ run: async () => { throw new Error("ssh: timed out"); }, now: () => 1 });
    expect(await service.get()).toEqual({ reachable: false, probe: null, checkedAt: 1, error: "ssh: timed out" });
  });

  it("keeps the last good probe and marks it old when the next connection fails", async () => {
    let fail = false;
    let clock = 1_000;
    const service = createM1Service({ run: async () => { if (fail) throw new Error("ssh: timed out"); return probeText(); }, now: () => clock });
    await service.get();
    fail = true;
    clock += 60_000;
    const next = await service.get();
    expect(next.reachable).toBe(false);
    expect(next.probe?.bbRunning).toBe(true);
    expect(next.error).toBe("ssh: timed out");
  });
});

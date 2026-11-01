import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { M1_PROBE_SCRIPT } from "../server-m1-service";
import { parseProbe } from "../src/m1-service-model";

const APP = "/Applications/bb.app/Contents/MacOS/bb";
const RUNTIME = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app";
const MACHINE = "/Users/studio/.bb-machines/laptop.example.test/npm/lib/node_modules/bb-app";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function runProbe(processes: Array<[etime: string, command: string]>, assertions = "") {
  const home = mkdtempSync(path.join(tmpdir(), "m1-probe-"));
  homes.push(home);
  const bin = path.join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const table = path.join(home, "ps.txt");
  writeFileSync(table, processes.map(([etime, command]) => `${etime} ${command}`).join("\n") + "\n");
  writeFileSync(
    path.join(bin, "ps"),
    `#!/bin/sh\ncase "$*" in\n  *etime=*) cat "${table}" ;;\n  *) sed -E 's/^[^ ]+ //' "${table}" ;;\nesac\n`,
  );
  chmodSync(path.join(bin, "ps"), 0o755);
  writeFileSync(path.join(bin, "pmset"), `#!/bin/sh\ncat <<'EOF'\n${assertions}\nEOF\n`);
  chmodSync(path.join(bin, "pmset"), 0o755);
  const stdout = execFileSync("/bin/bash", ["-c", M1_PROBE_SCRIPT], {
    encoding: "utf8",
    env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", BB_SERVER_URL: "http://127.0.0.1:9" },
  });
  return { stdout, probe: parseProbe(stdout) };
}

describe("Studio probe script", () => {
  it("does not count bb's own Electron-run processes as the desktop app or as bb's start", () => {
    const { stdout, probe } = runProbe([
      ["03:00:01", `${APP} /Applications/bb.app/Contents/Resources/app.asar/dist/bb-app-bridge.mjs`],
      ["03:00:00", `${APP} ${RUNTIME}/dist/bb-app.js host-daemon --supervise`],
      ["02:59:58", `${APP} ${RUNTIME}/host-daemon/dist/daemon-bundle.mjs`],
      ["05:00:00", `${APP} --enable-source-maps ${RUNTIME}/server/dist/start-server.js`],
    ]);
    expect(probe.app).toBe("absent");
    expect(stdout.split("\n").filter((line) => line.startsWith("bbage="))).toEqual(["bbage=03:00:00", "bbage=02:59:58"]);
  });

  it("sees the desktop app however it was opened, and leaves it out of bb's start", () => {
    for (const command of [APP, `${APP} -psn_0_123456`, `${APP} --inspect-brk=127.0.0.1:0`]) {
      const { stdout, probe } = runProbe([
        ["09:00:00", command],
        ["03:00:00", `/usr/local/bin/node ${MACHINE}/host-daemon/dist/daemon-bundle.mjs`],
      ]);
      expect(probe.app, command).toBe("present");
      expect(stdout.split("\n").filter((line) => line.startsWith("bbage=")), command).toEqual(["bbage=03:00:00"]);
    }
  });

  it("does not take the app's helper processes for the app", () => {
    const { probe } = runProbe([["01:00:00", "/Applications/bb.app/Contents/Frameworks/bb Helper (Renderer).app/Contents/MacOS/bb Helper (Renderer) --type=renderer"]]);
    expect(probe.app).toBe("absent");
  });

  it("counts a power assertion from an app such as Amphetamine as holding the Mac awake", () => {
    const held = "Assertion status system-wide:\n   PreventUserIdleSystemSleep    1\n   PreventSystemSleep             0\n";
    const system = "Assertion status system-wide:\n   PreventUserIdleSystemSleep    0\n   PreventSystemSleep             1\n";
    const none = "Assertion status system-wide:\n   PreventUserIdleSystemSleep    0\n   PreventSystemSleep             0\n";
    expect(runProbe([], held).probe.awakeHeld).toBe(true);
    expect(runProbe([], system).probe.awakeHeld).toBe(true);
    expect(runProbe([], none).probe.awakeHeld).toBe(false);
  });
});

describe("each bb command in the probe has its own time limit", () => {
  it("stops a hung bb after its own seconds and lets the next call run", () => {
    const home = mkdtempSync(path.join(tmpdir(), "m1-probe-limit-"));
    homes.push(home);
    const hung = path.join(home, "bb-hung");
    const fast = path.join(home, "bb-fast");
    writeFileSync(hung, "#!/bin/sh\nexec sleep 30\n");
    writeFileSync(fast, "#!/bin/sh\necho ok\n");
    chmodSync(hung, 0o755);
    chmodSync(fast, 0o755);
    const fn = M1_PROBE_SCRIPT.split("\n").find((line) => line.startsWith("bbrun()"))!;
    expect(fn).toBeTruthy();
    const started = Date.now();
    const out = execFileSync("/bin/bash", ["-c", `APP=${home}/none; BB=${hung}; ${fn}\nbbrun 1 --version; echo "hung=$?"; BB=${fast}; bbrun 1 --version; echo "fast=$?"`], { encoding: "utf8" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out).toMatch(/hung=(142|14|1\d\d)/);
    expect(out).toContain("ok\nfast=0");
  });

  it("gives each of the three bb calls a limit that fits inside the ssh timeout", () => {
    const limits = [...M1_PROBE_SCRIPT.matchAll(/bbrun (\d+) /g)].map((m) => Number(m[1]));
    expect(limits).toHaveLength(3);
    expect(limits.reduce((a, b) => a + b, 0) + 6).toBeLessThan(20);
  });
});

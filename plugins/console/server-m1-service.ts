// The always-on Mac as a background service, read-only. One SSH call to the `m1` alias
// (the same route server-m1.ts uses) prints when the Mac booted, whether bb is
// running and since when, whether the desktop app is open and is a login item,
// whether bb's launch agent (app.getbb.host-daemon.*, the machine service) is
// loaded, whether a login session exists, whether caffeinate is holding the Mac
// awake, and bb's own keep-awake setting. Nothing on the always-on Mac is changed.
import { execFile } from "node:child_process";
import { z } from "zod";
import { alwaysOnSsh, requireHandoff } from "./server-words";
import { parseProbe, type ServiceProbe } from "./src/m1-service-model";

const BB = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb";
const APP = "/Applications/bb.app/Contents/MacOS/bb";
const FRESH_MS = 20_000;

export const M1_PROBE_SCRIPT = [
  'export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"',
  `BB=${BB}`,
  `APP=${APP}`,
  // bb's command line is a node script and an SSH shell on the always-on Mac has no node: run it on the desktop app's own runtime.
  // The first argument is the call's own limit in seconds: a hung bb command cannot hold up the rest of the probe or use up the others' time.
  `bbrun() { t=$1; shift; if [ -x "$APP" ]; then ELECTRON_RUN_AS_NODE=1 perl -e 'alarm shift; exec @ARGV' "$t" "$APP" "$BB" "$@"; else perl -e 'alarm shift; exec @ARGV' "$t" "$BB" "$@"; fi; }`,
  'echo "boot=$(sysctl -n kern.boottime | sed -E \'s/.*sec = ([0-9]+),.*/\\1/\')"',
  'echo "now=$(date +%s)"',
  'if bbrun 5 settings show --json >/dev/null 2>&1; then echo "bb=running"; else echo "bb=down"; fi',
  'echo "version=$(bbrun 3 --version 2>/dev/null | head -1)"',
  "ps -axo etime=,command= | grep -E 'host-daemon/dist/[d]aemon|/dist/[b]b-app\\.js' | awk '{print \"bbage=\" $1}'",
  "if ps -axo command= | grep -E '^/Applications/bb\\.app/Contents/MacOS/bb( |$)' | grep -qvE '\\.[cm]?js( |$)'; then echo \"app=present\"; else echo \"app=absent\"; fi",
  'if launchctl print "gui/$(id -u)" >/dev/null 2>&1; then echo "gui=present"; else echo "gui=absent"; fi',
  'if ls "$HOME"/Library/LaunchAgents/app.getbb.host-daemon.*.plist >/dev/null 2>&1; then',
  "  if launchctl list 2>/dev/null | awk '$3 ~ /^app\\.getbb\\.host-daemon\\./ && $1 != \"-\" {found=1} END {exit !found}'; then echo \"agent=running\"; else echo \"agent=stopped\"; fi",
  'else echo "agent=absent"; fi',
  // Held awake by caffeinate, or by any app (Amphetamine, caffeinate -i/-s) that shows a sleep-preventing power assertion.
  'if pgrep -f "[c]affeinate -i -w" >/dev/null 2>&1 || pmset -g assertions 2>/dev/null | grep -qE "^[[:space:]]*(PreventUserIdleSystemSleep|PreventSystemSleep)[[:space:]]+1"; then echo "awake=held"; else echo "awake=none"; fi',
  'echo "awakecfg=$(bbrun 3 keep-awake status --json 2>/dev/null | head -1)"',
  "if items=$(perl -e 'alarm 6; exec @ARGV' osascript -e 'tell application \"System Events\" to get the path of every login item' 2>/dev/null); then",
  "  if printf '%s\\n' \"$items\" | tr ',' '\\n' | sed 's/^ *//' | grep -qxE '/Applications/bb\\.app/?'; then echo \"loginitem=present\"; else echo \"loginitem=absent\"; fi",
  'else echo "loginitem=unknown"; fi',
].join("\n");

const probeSchema = z.object({
  bootAt: z.number().nullable(),
  probedAt: z.number().nullable(),
  bbRunning: z.boolean().nullable(),
  bbVersion: z.string().nullable(),
  bbStartedAt: z.number().nullable(),
  gui: z.enum(["present", "absent", "unknown"]),
  app: z.enum(["present", "absent", "unknown"]),
  loginItem: z.enum(["present", "absent", "unknown"]).default("unknown"),
  launchAgent: z.enum(["running", "stopped", "absent", "unknown"]),
  awakeHeld: z.boolean().nullable(),
  awakeSetting: z.object({ enabled: z.boolean(), scope: z.string() }).nullable(),
});
export const m1ServiceSchema = z.object({
  /** null is never sent: the first answer is either a reading or a failure. */
  reachable: z.boolean(),
  probe: probeSchema.nullable(),
  checkedAt: z.number(),
  error: z.string().nullable().optional(),
});
export type M1ServiceState = z.infer<typeof m1ServiceSchema>;

function sshRun(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try { requireHandoff(); } catch (cause) { return reject(cause); }
    execFile("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", alwaysOnSsh(), script], { timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split("\n").slice(-1)[0] ?? "ssh failed"));
      else resolve(stdout);
    });
  });
}

export function createM1Service(deps: { run?: (script: string) => Promise<string>; now?: () => number } = {}) {
  const run = deps.run ?? sshRun;
  const now = deps.now ?? Date.now;
  let last: { at: number; probe: ServiceProbe } | null = null;
  let flight: Promise<M1ServiceState> | null = null;

  async function read(): Promise<M1ServiceState> {
    try {
      const probe = parseProbe(await run(M1_PROBE_SCRIPT));
      last = { at: now(), probe };
      return { reachable: true, probe, checkedAt: last.at, error: null };
    } catch (cause) {
      return { reachable: false, probe: last?.probe ?? null, checkedAt: now(), error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  return {
    async get(): Promise<M1ServiceState> {
      if (last && now() - last.at < FRESH_MS) return { reachable: true, probe: last.probe, checkedAt: last.at, error: null };
      flight ??= read().finally(() => { flight = null; });
      return flight;
    },
  };
}

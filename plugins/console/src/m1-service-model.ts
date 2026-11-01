import { Mac, mac, macLabel } from "./words";
// What the Console says about the always-on Mac running as a background service: the
// pieces a reboot check needs (bb up, whether bb.app opens at login or the launch
// agent keeps bb up, keep-awake held, when the Mac booted) read from the always-on Mac and
// turned into words. Headless means bb answers while the desktop app is not
// running; a login session is expected, because bb's launch agent lives in it. Pure, no
// React or SDK, so the same text is tested and drawn.

export type GuiState = "present" | "absent" | "unknown";
export type AppState = "present" | "absent" | "unknown";
export type LoginItemState = "present" | "absent" | "unknown";
export type AgentState = "running" | "stopped" | "absent" | "unknown";

export type ServiceProbe = {
  bootAt: number | null;
  probedAt: number | null;
  bbRunning: boolean | null;
  bbVersion: string | null;
  bbStartedAt: number | null;
  gui: GuiState;
  app: AppState;
  loginItem: LoginItemState;
  launchAgent: AgentState;
  awakeHeld: boolean | null;
  awakeSetting: { enabled: boolean; scope: string } | null;
};

export type ServiceInput = { reachable: boolean | null; probe: ServiceProbe | null };
export type Tone = "ok" | "warn" | "bad" | "muted";
export type ServiceRow = { key: "service" | "app" | "login" | "session" | "keep-awake" | "boot"; label: string; value: string; detail: string | null; tone: Tone };
export type RebootCheck = { state: "passed" | "waiting" | "failed"; text: string };
export type ServiceView = { headline: string; tone: Tone; stale: boolean; rows: ServiceRow[]; reboot: RebootCheck };

const BY_ITSELF_S = 10 * 60;

function seconds(text: string | undefined): number | null {
  if (!text) return null;
  const n = Number(text.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** ps elapsed time: "SS", "MM:SS", "HH:MM:SS" or "D-HH:MM:SS". */
function elapsedSeconds(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

function awakeSetting(raw: string | undefined): ServiceProbe["awakeSetting"] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown; selection?: { mode?: unknown; hostIds?: unknown } };
    if (typeof parsed.enabled !== "boolean") return null;
    const ids = parsed.selection?.mode === "selected" && Array.isArray(parsed.selection.hostIds) ? parsed.selection.hostIds.length : null;
    return { enabled: parsed.enabled, scope: ids === null ? "all hosts" : `${ids} chosen host${ids === 1 ? "" : "s"}` };
  } catch {
    return null;
  }
}

/** The key=value lines the always-on Mac probe prints. Anything missing stays unknown. */
export function parseProbe(stdout: string): ServiceProbe {
  const values = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    values.set(key, [...(values.get(key) ?? []), line.slice(at + 1).trim()]);
  }
  const one = (key: string) => values.get(key)?.[0];
  const boot = seconds(one("boot"));
  const now = seconds(one("now"));
  const ages = (values.get("bbage") ?? []).map(elapsedSeconds).filter((n): n is number => n !== null);
  const bb = one("bb");
  const gui = one("gui");
  const app = one("app");
  const loginItem = one("loginitem");
  const agent = one("agent");
  const awake = one("awake");
  return {
    bootAt: boot === null ? null : boot * 1000,
    probedAt: now === null ? null : now * 1000,
    bbRunning: bb === "running" ? true : bb === "down" ? false : null,
    bbVersion: one("version") || null,
    bbStartedAt: now === null || ages.length === 0 ? null : (now - Math.max(...ages)) * 1000,
    gui: gui === "present" || gui === "absent" ? gui : "unknown",
    app: app === "present" || app === "absent" ? app : "unknown",
    loginItem: loginItem === "present" || loginItem === "absent" ? loginItem : "unknown",
    launchAgent: agent === "running" || agent === "stopped" || agent === "absent" ? agent : "unknown",
    awakeHeld: awake === "held" ? true : awake === "none" ? false : null,
    awakeSetting: awakeSetting(one("awakecfg")),
  };
}

export function spanLabel(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const rest = s % 60;
    return rest ? `${Math.floor(s / 60)}m ${rest}s` : `${Math.floor(s / 60)}m`;
  }
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

export function bootLabel(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function rebootCheck(probe: ServiceProbe): RebootCheck {
  if (probe.bbRunning === false) return { state: "failed", text: `bb is not running on ${mac()}. After a reboot it should start without anyone opening the app.` };
  if (probe.bbRunning === null) return { state: "waiting", text: `Could not tell whether bb is running on ${mac()}.` };
  if (probe.loginItem === "present") return { state: "passed", text: `bb opens at login: /Applications/bb.app is a login item on ${mac()}, so bb starts again by itself after a reboot.` };
  const delay = probe.bbStartedAt !== null && probe.bootAt !== null ? (probe.bbStartedAt - probe.bootAt) / 1000 : null;
  if (delay === null || delay < 0) return { state: "waiting", text: "bb is running, but when it started could not be read." };
  if (delay > BY_ITSELF_S) return { state: "waiting", text: `bb started ${spanLabel(delay)} after the last boot, so it may have been started by hand. Reboot ${mac()} and leave the desktop app closed to check.` };
  if (probe.app === "present") return { state: "waiting", text: `bb is running, but the desktop app is open, so this does not show a headless start. Quit the app, reboot ${mac()} and leave it closed to check.` };
  if (probe.app === "unknown") return { state: "waiting", text: "bb came up by itself, but whether the desktop app is open could not be read." };
  return { state: "passed", text: `bb came up ${spanLabel(delay)} after the last boot with the desktop app closed. Start work on ${mac()} to finish the check.` };
}

const AGENT_DETAIL: Record<AgentState, string | null> = {
  running: "Background launch agent is running",
  stopped: "Background launch agent is installed but not running",
  absent: "No background launch agent: bb runs only while the app does",
  unknown: null,
};

function keepAwakeWords(probe: ServiceProbe): Pick<ServiceRow, "value" | "detail" | "tone"> {
  const setting = probe.awakeSetting;
  const detail = setting ? `Turned ${setting.enabled ? "on" : "off"} in bb for ${setting.scope}` : null;
  if (probe.awakeHeld === null) return { value: "Not readable", detail, tone: "muted" };
  if (probe.awakeHeld) return { value: setting?.enabled === false ? "The Mac is held awake, though Keep Awake is off in bb" : "Keep Awake is on: the Mac stays awake", detail, tone: "ok" };
  return { value: setting?.enabled ? "Keep Awake is on in bb, but nothing is holding the Mac awake" : "Keep Awake is off: the Mac may sleep", detail, tone: "warn" };
}

export function serviceView(input: ServiceInput): ServiceView {
  const { reachable, probe } = input;
  if (reachable === null && !probe) return { headline: `Checking ${mac()}`, tone: "muted", stale: false, rows: [], reboot: { state: "waiting", text: `Waiting for ${mac()} to answer.` } };
  if (!probe) return { headline: `${macLabel()} not reachable`, tone: "bad", stale: false, rows: [], reboot: { state: "waiting", text: `${Mac()} did not answer, so the reboot check cannot be read.` } };

  const rows: ServiceRow[] = [
    {
      key: "service",
      label: "Service",
      value: probe.bbRunning === true ? (probe.bbVersion ? `bb ${probe.bbVersion} is running` : "bb is running") : probe.bbRunning === false ? "bb is not running" : "Not readable",
      detail: AGENT_DETAIL[probe.launchAgent],
      tone: probe.bbRunning === true ? "ok" : probe.bbRunning === false ? "bad" : "muted",
    },
    {
      key: "app",
      label: "Desktop app",
      value: probe.app === "absent" ? "Desktop app closed" : probe.app === "present" ? "Desktop app is open" : "Not readable",
      detail: null,
      tone: probe.app === "absent" ? "ok" : probe.app === "present" ? (probe.loginItem === "present" ? "ok" : "warn") : "muted",
    },
    {
      key: "login",
      label: "At login",
      value: probe.loginItem === "present" ? "bb opens at login" : probe.loginItem === "absent" ? "bb does not open at login" : "Not readable",
      detail: probe.loginItem === "present" ? "Login item for /Applications/bb.app" : probe.loginItem === "absent" ? "Add bb to Login Items so it comes back after a reboot" : null,
      tone: probe.loginItem === "present" ? "ok" : probe.loginItem === "absent" ? "warn" : "muted",
    },
    {
      key: "session",
      label: "Session",
      value: probe.gui === "present" ? "Login session open (the launch agent needs it)" : probe.gui === "absent" ? "No login session" : "Not readable",
      detail: null,
      tone: "muted",
    },
    {
      key: "keep-awake",
      label: "Keep awake",
      ...keepAwakeWords(probe),
    },
    {
      key: "boot",
      label: "Last boot",
      value: probe.bootAt === null ? "Not readable" : bootLabel(probe.bootAt),
      detail: probe.bootAt !== null && probe.probedAt !== null ? `Up ${spanLabel((probe.probedAt - probe.bootAt) / 1000)}` : null,
      tone: "muted",
    },
  ];

  let headline: string;
  let tone: Tone;
  if (probe.bbRunning === false) [headline, tone] = ["bb is not running", "bad"];
  else if (probe.bbRunning === null) [headline, tone] = ["bb state unknown", "warn"];
  else if (probe.app === "absent") [headline, tone] = ["Running headless", "ok"];
  else if (probe.app === "present" && probe.loginItem === "present") [headline, tone] = ["bb runs in the desktop app, which opens at login", "ok"];
  else if (probe.app === "present") [headline, tone] = ["Running with the desktop app open", "warn"];
  else [headline, tone] = ["bb is running", "warn"];

  if (reachable === false) return { headline: `${macLabel()} not reachable`, tone: "bad", stale: true, rows, reboot: { state: "waiting", text: `${Mac()} did not answer, so this is the last reading.` } };
  return { headline, tone, stale: false, rows, reboot: rebootCheck(probe) };
}

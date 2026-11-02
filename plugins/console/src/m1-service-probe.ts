// Reading the always-on Mac's service probe: the probe types and the parser for its
// output. Split from m1-service-model.ts because the server imports the parser, and that
// file draws its words from the browser profile (@get-bb/plugin-sdk/app), which a server
// bundle cannot load on a clean install. Pure: no React, no SDK, no profile.

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

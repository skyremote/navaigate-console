// Machines in the rail: which Mac a chat runs on, and the chats the Fleet
// plugin publishes for Macs whose bb is not this one (a restricted Mac's own
// bb, the always-on Mac's own bb). Pure, no React or SDK, so
// `node --test tests/machines.test.ts` runs it as it is. Machine names, order and
// roles come from the profile, passed in by the caller.

import type { Profile } from "../profile/schema.ts";

export type RemoteState = "running" | "needs-you" | "queued" | "error" | "idle";

/** One chat on another Mac's bb, as Fleet publishes it. */
export type RemoteThread = {
  id: string;
  title: string;
  state: RemoteState;
  machine: string;
  projectName: string | null;
  providerId: string | null;
  updatedAt: number;
  url: string | null;
  /** The bb server that published it; this bb's own chats carry its serverId. */
  via: string;
};

/** What Fleet's machine snapshot says about a Mac's load; every reading can be missing. */
export type MachineSystem = {
  cpuPercent: number | null;
  cores: number | null;
  loadAvg: [number, number, number] | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memPressure: "normal" | "warn" | "critical" | null;
  swapUsedBytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  keepAwake: string[];
};

export type FleetColumn = {
  key: string;
  label: string;
  serverId: string | null;
  online: boolean;
  lastSeenAt: number | null;
  threads: RemoteThread[];
  /** That Mac's Fleet can mirror its chats here (they open as a local copy). */
  mirror?: boolean;
  ownerStatus?: "live" | "stale" | "unknown";
  ownerOnline?: boolean;
  enrolledOnline?: boolean;
  resources?: { observedAt: number; cpuCount: number; cpuUtilization: number | null; totalMemoryBytes: number; availableMemoryBytes: number } | null;
  system?: MachineSystem | null;
};

/** Fleet's board, trimmed to what the rail draws. */
export type FleetBoard = { serverId: string; serverKey: string; columns: FleetColumn[] };

export type Chip = { key: string; sub: string; online: boolean; cooking: number; /** Reported running but quiet for over two hours; not counted in `cooking`. */ stuck?: number; stuckAt?: number | null; lastSeenAt: number | null; ownerStatus?: "live" | "stale" | "unknown"; enrolledOnline?: boolean; resources?: FleetColumn["resources"]; system?: MachineSystem | null };

export const RESOURCES_STALE_MS = 60_000;

/** Seconds under a minute, then minutes, hours and days: "27s", "3m", "2h", "4d". */
export function sinceLabel(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export type MachineMetric = { line: string; age: string; stale: boolean };

/** What one machine tile shows: CPU % and free RAM on the first line, "updated Ns ago" on the second, with old or unverified data marked stale. */
export function machineMetric(c: Chip, now: number): MachineMetric {
  const r = c.resources;
  if (r) {
    const cpu = r.cpuUtilization === null ? "CPU n/a" : `${Math.round(r.cpuUtilization * 100)}% CPU`;
    const freeGb = r.availableMemoryBytes / 1024 ** 3;
    const free = `${freeGb < 1 ? freeGb.toFixed(1) : Math.round(freeGb)} GB free`;
    const stale = now - r.observedAt >= RESOURCES_STALE_MS || !c.online || (c.ownerStatus !== undefined && c.ownerStatus !== "live");
    const updated = `updated ${sinceLabel(r.observedAt, now)} ago`;
    return { line: `${cpu} · ${free}`, age: stale ? `stale · ${updated}` : updated, stale };
  }
  const status = c.ownerStatus === "unknown" ? "owner unverified" : c.ownerStatus === "stale" ? "owner stale" : c.online ? c.sub || " " : "offline";
  const seen = c.lastSeenAt ? `last seen ${sinceLabel(c.lastSeenAt, now)} ago` : "never seen";
  const stale = !c.online || (c.ownerStatus !== undefined && c.ownerStatus !== "live");
  return { line: status, age: stale ? `stale · ${seen}` : "no health data", stale };
}

export type SystemPressure = "normal" | "warn" | "critical";
export type SystemView = {
  /** 0 to 1, for the bar. */
  cpu: { fraction: number; text: string; cores: string | null } | null;
  ram: { fraction: number | null; text: string; pressure: SystemPressure | null; pressureText: string | null } | null;
  swap: string | null;
  load: string | null;
  disk: string | null;
  keepAwake: string | null;
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const GB = 1024 ** 3;
const gbText = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
const sizeText = (bytes: number) => (bytes >= 1024 * GB ? `${(bytes / (1024 * GB)).toFixed(1)} TB` : gbText(bytes));
const PRESSURE_WORDS: Record<SystemPressure, string> = { normal: "Memory pressure normal", warn: "Memory pressure rising", critical: "Memory pressure critical" };

/**
 * What hovering a machine tile says about load: CPU, RAM and its pressure, swap,
 * load average, disk and what keeps the Mac awake. Null for a restricted machine,
 * for a missing or null `system`, and when no reading is present.
 */
export function systemView(key: string, system: MachineSystem | null | undefined, profile: Profile): SystemView | null {
  if (profile.machines.some((m) => m.id === key && m.restricted) || !system) return null;
  const cpu = finite(system.cpuPercent)
    ? {
        fraction: Math.max(0, Math.min(1, system.cpuPercent / 100)),
        text: `${Math.round(system.cpuPercent)}%`,
        cores: finite(system.cores) && system.cores > 0 ? `${Math.round(system.cores)} cores` : null,
      }
    : null;
  const total = finite(system.memTotalBytes) && system.memTotalBytes > 0 ? system.memTotalBytes : null;
  const pressure = system.memPressure === "normal" || system.memPressure === "warn" || system.memPressure === "critical" ? system.memPressure : null;
  const ram =
    finite(system.memUsedBytes) && total !== null
      ? { fraction: Math.max(0, Math.min(1, system.memUsedBytes / total)), text: `${gbText(system.memUsedBytes)} of ${gbText(total)}`, pressure, pressureText: pressure ? PRESSURE_WORDS[pressure] : null }
      : null;
  const swap = finite(system.swapUsedBytes) && system.swapUsedBytes > 0 ? `${gbText(system.swapUsedBytes)} in use` : null;
  const load = Array.isArray(system.loadAvg) && system.loadAvg.length === 3 && system.loadAvg.every(finite) ? system.loadAvg.map((n) => n.toFixed(2)).join(" · ") : null;
  const disk = finite(system.diskFreeBytes) && finite(system.diskTotalBytes) && system.diskTotalBytes > 0 ? `${sizeText(system.diskFreeBytes)} free of ${sizeText(system.diskTotalBytes)}` : null;
  const awake = Array.isArray(system.keepAwake) ? system.keepAwake.filter((a) => typeof a === "string" && a.trim() !== "") : [];
  const keepAwake = awake.length > 0 ? `Kept awake by ${awake.join(", ")}` : null;
  if (!cpu && !ram && !swap && !load && !disk && !keepAwake) return null;
  return { cpu, ram, swap, load, disk, keepAwake };
}

/** Fleet's rule: a host name that contains a machine's id or label as a word ("Sam's Studio Mac") is that machine. A chat with no machine yet runs here. */
export function machineKeyOf(hostName: string | null, serverKey: string, profile: Profile): string {
  if (!hostName) return serverKey;
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of profile.machines) {
    const words = [m.id, m.label].filter((w) => w !== "");
    if (words.some((w) => new RegExp(`(^|[^A-Za-z0-9])${escape(w)}($|[^A-Za-z0-9])`, "i").test(hostName))) return m.id;
  }
  return hostName;
}

/** "Work Client" gives "Client" for key "Work"; a label that is only the key gives "". */
export function subLabel(label: string, key: string): string {
  return label.toLowerCase().startsWith(key.toLowerCase()) ? label.slice(key.length).trim() : label;
}

/** The chats Fleet lists for that machine from another bb. This bb's own chats come from the sidebar instead. */
export function remoteFor(board: FleetBoard, key: string): RemoteThread[] {
  const column = board.columns.find((c) => c.key === key);
  if (!column) return [];
  return column.threads
    .filter((t) => t.via !== board.serverId)
    .sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.updatedAt - a.updatedAt);
}

/** One chip per machine, the profile's machines first and in its order. `counts` is the one running view (src/running.ts): the same numbers every surface shows. */
export function chipsFor(board: FleetBoard, counts: Record<string, { running: number; stuck: number; stuckAt: number | null }>, profile: Profile): Chip[] {
  const order = profile.machines.map((m) => m.id);
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return board.columns
    .map((c) => ({
      key: c.key,
      sub: subLabel(c.label, c.key),
      online: c.ownerStatus ? c.ownerStatus === "live" : c.online,
      ...(c.ownerStatus ? { ownerStatus: c.ownerStatus } : {}),
      ...(c.enrolledOnline !== undefined ? { enrolledOnline: c.enrolledOnline } : {}),
      ...(c.resources !== undefined ? { resources: c.resources } : {}),
      ...(c.system ? { system: c.system } : {}),
      cooking: counts[c.key]?.running ?? 0,
      ...(counts[c.key]?.stuck ? { stuck: counts[c.key]!.stuck, stuckAt: counts[c.key]!.stuckAt } : {}),
      lastSeenAt: c.lastSeenAt,
    }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

/** Remote chats by project, in the order they first appear; a chat with no project is "Personal". */
export function remoteSections(threads: RemoteThread[]): Array<{ name: string; threads: RemoteThread[] }> {
  const sections = new Map<string, RemoteThread[]>();
  for (const t of threads) {
    const name = t.projectName ?? "Personal";
    const list = sections.get(name);
    if (list) list.push(t);
    else sections.set(name, [t]);
  }
  return [...sections.entries()].map(([name, list]) => ({ name, threads: list }));
}

/** The remembered machine while the board still has it, otherwise this bb's own. */
export function pickMachine(board: FleetBoard | null, wanted: string, profile: Profile): string {
  if (!board) return (profile.machines.find((m) => m.id === profile.thisMachine) ?? profile.machines[0])?.id ?? "";
  return board.columns.some((c) => c.key === wanted) ? wanted : board.serverKey;
}

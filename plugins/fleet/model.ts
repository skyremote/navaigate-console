// Pure fleet model: what a server publishes, and how the board is assembled
// from every server's snapshot. No I/O here so it is easy to test.
import { z } from "zod";
import { hostCapabilitiesSchema } from "./owner/capabilities";
import { alwaysOnMachine, machineOrder, type Profile } from "./profile/schema";
import { resolveMachineId, workloadIds, workloadRefusal } from "./lib/profile-fleet";

export const EXECUTION_FEATURE = "execution-selection-v1";
export const SEALED_RELAY_FEATURE = "sealed-relay-v1";
export const SEALED_COMMAND_PLACEHOLDER = "[fleet:sealed-command:v1]";
export const SEALED_CONTROL_PLACEHOLDER = "[fleet:sealed-control:v1]";
/** Domain-separated binding for encrypted broker sidecars. No task text is metadata. */
export function commandAad(input: { id: string; fromServer: string; targetServer: string; machine: string }): string {
  return JSON.stringify(["fleet-command-v1", input.id, input.fromServer, input.targetServer, input.machine]);
}
export function controlAad(input: { id: string; fromServer: string; targetServer: string; threadId: string; action: string }): string {
  return JSON.stringify(["fleet-control-v1", input.id, input.fromServer, input.targetServer, input.threadId, input.action]);
}
export const RESOURCE_STALE_MS = 60_000;
export const executionSelectionSchema = z.object({
  providerId: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  reasoningLevel: z.string().trim().min(1).max(80).optional(),
  serviceTier: z.string().trim().min(1).max(80).optional(),
}).strict();
export type ExecutionSelection = z.infer<typeof executionSelectionSchema>;

export const routingPreferencesSchema = z.object({
  /** "general", or a workload id from the profile (a restricted machine runs only its own workloads). */
  workload: z.string().trim().min(1).max(60).optional(),
  needsNas: z.boolean().optional(),
  unattended: z.boolean().optional(),
  requiredCapabilities: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
}).strict();
export type RoutingPreferences = z.infer<typeof routingPreferencesSchema>;
export const workWorkspaceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("managed-worktree"), baseBranch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("default") }).strict(), z.object({ kind: z.literal("named"), name: z.string().trim().min(1).max(200) }).strict()]) }).strict(),
  z.object({ type: z.literal("unmanaged"), path: z.null(), branch: z.discriminatedUnion("kind", [z.object({ kind: z.literal("existing"), name: z.string().trim().min(1).max(200) }).strict(), z.object({ kind: z.literal("new"), baseBranch: z.string().trim().min(1).max(200) }).strict()]).optional() }).strict(),
]);
export const workProjectSchema = z.object({ projectId: z.string().trim().min(1).max(120).optional(), projectName: z.string().trim().min(1).max(200).optional(), workspace: workWorkspaceSchema.optional() }).strict();
export type WorkProject = z.infer<typeof workProjectSchema>;

export const resourcesSchema = z.object({
  observedAt: z.number().finite(),
  cpuCount: z.number().int().positive(),
  cpuUtilization: z.number().min(0).max(1).nullable(),
  totalMemoryBytes: z.number().positive(),
  availableMemoryBytes: z.number().nonnegative(),
});
export type Resources = z.infer<typeof resourcesSchema>;

/** The most sleep holders published; matches the other capped arrays. */
const MAX_KEEP_AWAKE = 20;

export const systemSchema = z.object({
  cpuPercent: z.number().min(0).max(100).nullable(),
  cores: z.number().int().positive().nullable(),
  loadAvg: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]).nullable(),
  memUsedBytes: z.number().nonnegative().nullable(),
  memTotalBytes: z.number().positive().nullable(),
  memPressure: z.enum(["normal", "warn", "critical"]).nullable(),
  swapUsedBytes: z.number().nonnegative().nullable(),
  diskFreeBytes: z.number().nonnegative().nullable(),
  diskTotalBytes: z.number().positive().nullable(),
  keepAwake: z.array(z.string()).max(MAX_KEEP_AWAKE),
});
export type System = z.infer<typeof systemSchema>;

const finite = (value: number) => Number.isFinite(value) ? value : null;

/** The second sample's idle from `top -l 2` (the first is an average since boot), as busy per cent. */
export function parseTopCpu(output: string): number | null {
  const idle = [...output.matchAll(/CPU usage:.*?([\d.]+)% idle/g)].at(-1)?.[1];
  if (idle === undefined) return null;
  const busy = finite(100 - Number(idle));
  return busy === null || busy < -0.5 || busy > 100.5 ? null : Math.round(Math.min(100, Math.max(0, busy)) * 10) / 10;
}

/** `sysctl -n hw.ncpu hw.memsize` prints the core count, then the memory in bytes. */
export function parseCoresAndMemory(output: string): { cores: number | null; memTotalBytes: number | null } {
  const [cores, memory] = output.trim().split(/\s+/).map(Number);
  return {
    cores: cores !== undefined && Number.isInteger(cores) && cores > 0 ? cores : null,
    memTotalBytes: memory !== undefined && Number.isFinite(memory) && memory > 0 ? memory : null,
  };
}

/** `sysctl -n vm.loadavg` prints `{ 1.20 1.50 1.40 }`. */
export function parseLoadAvg(output: string): [number, number, number] | null {
  const match = /\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/.exec(output);
  if (!match) return null;
  const load = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  return load.every(Number.isFinite) ? load : null;
}

/** Used memory as Activity Monitor counts it: active + wired + the compressor's own pages. */
export function parseVmStatUsed(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  const pages = (label: string) => {
    const raw = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(output)?.[1];
    return raw === undefined ? null : Number(raw);
  };
  const active = pages("Pages active");
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  if (!Number.isFinite(pageSize) || pageSize <= 0 || active === null || wired === null || compressed === null) return null;
  return (active + wired + compressed) * pageSize;
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parsePressure(output: string): System["memPressure"] {
  const level = Number(output.trim());
  return level === 1 ? "normal" : level === 2 ? "warn" : level === 4 ? "critical" : null;
}

/** `sysctl -n vm.swapusage`: `total = 14336.00M  used = 13235.62M ...`. */
export function parseSwapUsed(output: string): number | null {
  const match = /used = ([\d.]+)([KMGT])/.exec(output);
  if (!match) return null;
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2] as "K" | "M" | "G" | "T"];
  const bytes = Number(match[1]) * unit;
  return Number.isFinite(bytes) ? Math.round(bytes) : null;
}

/**
 * `df -k /`: total and available kilobytes. On APFS, `/` is the sealed, read-only system volume, which shares
 * one container with the Data volume holding the user's files. So the capacity and available columns describe
 * the whole shared container (the free space the user's data can really use); the used column covers only the
 * system volume and is ignored here.
 */
export function parseDf(output: string): { diskFreeBytes: number | null; diskTotalBytes: number | null } {
  const row = output.trim().split("\n")[1]?.trim().split(/\s+/);
  const total = Number(row?.[1]);
  const free = Number(row?.[3]);
  return {
    diskFreeBytes: Number.isFinite(free) && free >= 0 ? free * 1024 : null,
    diskTotalBytes: Number.isFinite(total) && total > 0 ? total * 1024 : null,
  };
}

/** System daemons that hold a sleep assertion routinely; they say nothing about who chose to keep the Mac awake. */
const SYSTEM_SLEEP_HOLDERS = new Set(["powerd", "bluetoothd", "coreaudiod", "runningboardd", "sharingd", "mediaremoted", "WindowServer", "backupd", "apsd", "locationd"]);

/**
 * Who is keeping the Mac awake, from `pmset -g assertions`: the process names holding
 * PreventUserIdleSystemSleep or PreventSystemSleep (Amphetamine, caffeinate...), once
 * each. Routine system daemons (powerd, bluetoothd, coreaudiod...) are left out.
 */
export function parseSleepAssertions(pmsetOutput: string): string[] {
  const holders = new Set<string>();
  for (const match of pmsetOutput.matchAll(/^\s*pid \d+\(([^)]+)\):.*?\b(PreventUserIdleSystemSleep|PreventSystemSleep)\b/gm)) {
    if (!SYSTEM_SLEEP_HOLDERS.has(match[1]!)) holders.add(match[1]!);
  }
  return [...holders].slice(0, MAX_KEEP_AWAKE);
}

export interface SystemReads {
  top: string | null;
  hardware: string | null;
  loadavg: string | null;
  vmStat: string | null;
  pressure: string | null;
  swap: string | null;
  df: string | null;
  pmset: string | null;
}

/** Every field comes from its own read; one that failed (null output) leaves only its fields null. Null when every read failed. */
export function buildSystem(reads: SystemReads): System | null {
  if (Object.values(reads).every((output) => output === null)) return null;
  const hardware = reads.hardware === null ? null : parseCoresAndMemory(reads.hardware);
  const disk = reads.df === null ? null : parseDf(reads.df);
  return {
    cpuPercent: reads.top === null ? null : parseTopCpu(reads.top),
    cores: hardware?.cores ?? null,
    loadAvg: reads.loadavg === null ? null : parseLoadAvg(reads.loadavg),
    memUsedBytes: reads.vmStat === null ? null : parseVmStatUsed(reads.vmStat),
    memTotalBytes: hardware?.memTotalBytes ?? null,
    memPressure: reads.pressure === null ? null : parsePressure(reads.pressure),
    swapUsedBytes: reads.swap === null ? null : parseSwapUsed(reads.swap),
    diskFreeBytes: disk?.diskFreeBytes ?? null,
    diskTotalBytes: disk?.diskTotalBytes ?? null,
    keepAwake: reads.pmset === null ? [] : parseSleepAssertions(reads.pmset),
  };
}

/**
 * Available memory from macOS's `sysctl -n kern.memorystatus_level` (the kernel's
 * available-memory percentage). Node's freemem() on macOS counts only never-used
 * pages, a few per cent on a busy Mac, which made every owner look exhausted to Auto.
 * Returns null for anything that is not a 0-100 percentage.
 */
export function macAvailableMemoryBytes(sysctlOutput: string, totalMemoryBytes: number): number | null {
  const text = sysctlOutput.trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const level = Number(text);
  return level <= 100 ? Math.round((totalMemoryBytes * level) / 100) : null;
}

export const providerAvailabilitySchema = z.object({
  id: z.string(),
  available: z.boolean(),
  observedAt: z.number().finite(),
  displayName: z.string().optional(),
  auth: z.enum(["ready", "not_installed", "unauthenticated", "expired", "unsupported_version", "unknown"]).optional(),
  planLabel: z.string().nullable().optional(),
  fork: z.string().optional(),
});

export function executionSelection(input: ExecutionSelection): ExecutionSelection {
  const value = executionSelectionSchema.parse(input);
  if (!value.providerId && (value.model || value.reasoningLevel || value.serviceTier)) {
    throw new Error("Select a provider together with model, reasoning or service tier");
  }
  return value;
}

export function commandOptions(selection: ExecutionSelection, routing?: RoutingPreferences, project?: WorkProject): string {
  return JSON.stringify({ execution: executionSelection(selection), routing: routingPreferencesSchema.parse(routing ?? {}), project: workProjectSchema.parse(project ?? {}) });
}

export function readCommandOptions(raw: string | null, legacyProvider?: string | null): { execution: ExecutionSelection; routing: RoutingPreferences; project: WorkProject } {
  if (raw === null) return { execution: executionSelection(legacyProvider ? { providerId: legacyProvider } : {}), routing: {}, project: {} };
  const value = z.object({ execution: executionSelectionSchema, routing: routingPreferencesSchema, project: workProjectSchema.optional() }).strict().parse(JSON.parse(raw));
  return { execution: executionSelection(value.execution), routing: value.routing, project: value.project ?? {} };
}

export const threadStateSchema = z.enum(["running", "needs-you", "queued", "error", "idle"]);
export type ThreadState = z.infer<typeof threadStateSchema>;

/** The account a chat last ran on, as the owning Mac's Console reports it. */
export const threadAccountSchema = z.object({
  label: z.string().trim().min(1).max(60),
  email: z.string().max(200).nullable(),
  harness: z.enum(["claude", "codex", "cursor", "other"]),
});
export type ThreadAccount = z.infer<typeof threadAccountSchema>;

export const fleetThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: threadStateSchema,
  machine: z.string(), // machine key: a profile machine id
  projectId: z.string(),
  projectName: z.string().nullable(),
  providerId: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  url: z.string().nullable(),
  // Optional and backward compatible (older Fleets omit them, older parsers drop them):
  // what the remote list shows beside the title ("Opus · Max"), the Pinned
  // group and project sections.
  model: z.string().nullable().optional(),
  reasoningLevel: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  sectionName: z.string().nullable().optional(),
  account: threadAccountSchema.optional(),
});
export type FleetThread = z.infer<typeof fleetThreadSchema>;

export const machineInfoSchema = z.object({
  key: z.string(),
  label: z.string(),
  online: z.boolean(),
  capabilities: z.array(z.string()),
  // Declared capabilities are labels. Only independently checked ones are eligible for routing.
  verifiedCapabilities: z.array(z.string()).optional(),
});
export type MachineInfo = z.infer<typeof machineInfoSchema>;

export const snapshotSchema = z.object({
  serverId: z.string(),
  label: z.string(),
  url: z.string().nullable(),
  machineKey: z.string(),
  machines: z.array(machineInfoSchema),
  threads: z.array(fleetThreadSchema),
  publishedAt: z.number(),
  // What this server's Fleet understands. Absent = a Fleet from before the
  // two-way relay (it never delivers fleet_messages or publishes fleet_outputs).
  // Older parsers drop the key, so adding it is backward compatible.
  features: z.array(z.string()).optional(),
  // This Fleet's X25519 public key (base64url, raw 32 bytes). Mirror rows for a
  // chat it watches are sealed to it. Absent on a Fleet without the mirror.
  mirrorKey: z.string().optional(),
  ownerHostId: z.string().nullable().optional(),
  resources: resourcesSchema.nullable().optional(),
  system: systemSchema.nullable().optional(),
  providers: z.array(providerAvailabilitySchema).optional(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), workload: z.string().max(60).optional(), path: z.string().optional() })).optional(),
  capabilities: hostCapabilitiesSchema.optional(),
  appVersion: z.string().nullable().optional(),
  mcp: z.object({ installed: z.boolean(), enabled: z.boolean(), endpoint: z.string().nullable() }).optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const columnSchema = z.object({
  key: z.string(),
  label: z.string(),
  serverId: z.string().nullable(), // whose bb runs work started here
  url: z.string().nullable(),
  online: z.boolean(),
  local: z.boolean(), // this bb can start work there directly
  lastSeenAt: z.number().nullable(),
  capabilities: z.array(z.string()),
  threads: z.array(fleetThreadSchema.extend({ via: z.string() })),
  counts: z.object({ running: z.number(), needsYou: z.number(), queued: z.number() }),
  // The machine's own bb runs a Fleet with the mirror: its chats open here as copies.
  mirror: z.boolean().optional(),
  ownerStatus: z.enum(["live", "stale", "unknown"]).optional(),
  ownerOnline: z.boolean().optional(),
  enrolledOnline: z.boolean().optional(),
  ownerHostId: z.string().nullable().optional(),
  resources: resourcesSchema.nullable().optional(),
  system: systemSchema.nullable().optional(),
});
export type Column = z.infer<typeof columnSchema>;

export const routeCandidateSchema = z.object({
  machine: z.string(),
  serverId: z.string(),
  hostId: z.string().nullable(),
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  score: z.number().nullable(),
});
export const routeDecisionSchema = z.object({
  machine: z.string().nullable(),
  serverId: z.string().nullable(),
  hostId: z.string().nullable(),
  mode: z.enum(["auto", "manual"]),
  reason: z.string(),
  warnings: z.array(z.string()),
  candidates: z.array(routeCandidateSchema),
});
export type RouteDecision = z.infer<typeof routeDecisionSchema>;

/** Decide only where a new job starts. Existing threads and processes never migrate. */
export function chooseRoute(input: {
  machine: string;
  snapshots: Snapshot[];
  now: number;
  execution?: ExecutionSelection;
  routing?: RoutingPreferences;
  project?: WorkProject;
  /** Only these owners need the encrypted broker path; local/verified SSH routes do not. */
  brokerServerIds?: string[];
  profile: Profile;
}): RouteDecision {
  const profile = input.profile;
  const asked = input.machine.trim();
  const auto = asked.toUpperCase() === "AUTO";
  const target = auto ? "AUTO" : (resolveMachineId(profile, asked) ?? asked);
  const unattendedMachine = alwaysOnMachine(profile)?.id ?? null;
  const execution = executionSelection(input.execution ?? {});
  const preferences = routingPreferencesSchema.parse(input.routing ?? {});
  const project = workProjectSchema.parse(input.project ?? {});
  const newest = new Map<string, Snapshot>();
  for (const snapshot of input.snapshots) {
    if (!newest.has(snapshot.machineKey) || newest.get(snapshot.machineKey)!.publishedAt < snapshot.publishedAt) newest.set(snapshot.machineKey, snapshot);
  }
  const warnings: string[] = [];
  const candidates = [...newest.values()].filter((s) => auto || s.machineKey === target).map((snapshot) => {
    const own = snapshot.machines.find((machine) => machine.key === snapshot.machineKey);
    const reasons: string[] = [];
    if (!own?.online) reasons.push("The owning server does not report its execution host connected");
    if (input.now - snapshot.publishedAt > STALE_MS || snapshot.publishedAt > input.now + 5_000) reasons.push("The owning server snapshot is stale or its clock is invalid");
    if (input.brokerServerIds?.includes(snapshot.serverId) && (!(snapshot.features ?? []).includes(SEALED_RELAY_FEATURE) || !/^[A-Za-z0-9_-]{43}$/.test(snapshot.mirrorKey ?? ""))) reasons.push("The owner needs sealed-relay-v1 and its existing mirror key before new broker jobs can be sent; plaintext downgrade is disabled");
    const refusal = workloadRefusal(profile, snapshot.machineKey, preferences.workload);
    if (refusal !== null) reasons.push(refusal);
    if (project.projectId || project.projectName) {
      if (snapshot.projects === undefined) {
        if (auto) reasons.push("Destination project availability is unknown");
        else warnings.push(`${snapshot.machineKey}: the destination must validate the explicitly requested project`);
      } else if (!snapshot.projects.some((candidate) => project.projectId ? candidate.id === project.projectId : candidate.name === project.projectName)) reasons.push("The requested project has no checkout on this owner");
    }
    const verified = new Set((own?.verifiedCapabilities ?? []).map((value) => value.toLowerCase()));
    const required = [...(preferences.requiredCapabilities ?? []), ...(preferences.needsNas ? ["NAS"] : [])];
    for (const capability of required) if (!verified.has(capability.toLowerCase())) reasons.push(`${capability} has not been verified by this owner; declared labels are insufficient`);
    if ((Object.keys(execution).length > 0 || Object.keys(project).length > 0) && !(snapshot.features ?? []).includes(EXECUTION_FEATURE)) reasons.push("The owner has not advertised execution-selection-v1; upgrade it before sending an explicit model, project or workspace selection");
    if (execution.providerId) {
      const providers = snapshot.providers;
      if (providers === undefined) {
        if (auto) reasons.push("Provider availability is unknown");
        else warnings.push(`${snapshot.machineKey}: provider availability is unknown; the destination must validate it before spawning`);
      } else {
        const provider = providers.find((p) => p.id === execution.providerId);
        if (!provider?.available) reasons.push(`Provider ${execution.providerId} is not reported available on this owner`);
        else if (auto && (input.now - provider.observedAt > RESOURCE_STALE_MS || provider.observedAt > input.now + 5_000)) reasons.push("Provider availability observation is stale");
      }
    }
    let score: number | null = null;
    const resources = snapshot.resources;
    if (auto) {
      if (!resources || resources.cpuUtilization === null) reasons.push("CPU/RAM telemetry is unknown");
      else if (input.now - resources.observedAt > RESOURCE_STALE_MS || resources.observedAt > input.now + 5_000) reasons.push("CPU/RAM telemetry is stale or its clock is invalid");
      else {
        const free = resources.availableMemoryBytes / resources.totalMemoryBytes;
        if (resources.cpuUtilization >= 0.95 || free <= 0.05) reasons.push("The host has insufficient available CPU or RAM");
        else score = resources.cpuCount * (1 - resources.cpuUtilization) * Math.min(1, free);
      }
    }
    return { machine: snapshot.machineKey, serverId: snapshot.serverId, hostId: snapshot.ownerHostId ?? null, eligible: reasons.length === 0, reasons, score };
  });
  const eligible = candidates.filter((candidate) => candidate.eligible).sort((a, b) => {
    const priority = (candidate: typeof a) => preferences.unattended && candidate.machine === unattendedMachine ? 1 : 0;
    return priority(b) - priority(a) || (b.score ?? 0) - (a.score ?? 0) || a.machine.localeCompare(b.machine);
  });
  const chosen = eligible[0];
  return {
    machine: chosen?.machine ?? null,
    serverId: chosen?.serverId ?? null,
    hostId: chosen?.hostId ?? null,
    mode: auto ? "auto" : "manual",
    reason: chosen ? (auto ? `Selected ${chosen.machine}'s independent owner${preferences.unattended && chosen.machine === unattendedMachine ? " for unattended work" : " from fresh eligible CPU/RAM capacity"}` : `Selected ${chosen.machine}'s independent owner explicitly`) : (candidates.length === 0 ? `${target} has no authoritative owner snapshot` : candidates.map((c) => `${c.machine}: ${c.reasons.join("; ")}`).join(" | ")),
    warnings,
    candidates,
  };
}

/** A stale snapshot means this route has no current owner observation, not that the physical Mac is off. */
export const STALE_MS = 3 * 60_000;

export function threadState(t: {
  status: string;
  hasPendingInteraction?: boolean;
  queuedWork?: string;
  runtime?: { displayStatus?: string } | null;
}): ThreadState {
  if (t.hasPendingInteraction) return "needs-you";
  const display = t.runtime?.displayStatus ?? t.status;
  if (display === "error" || t.status === "error") return "error";
  if (["active", "starting", "stopping", "provisioning"].includes(display)) return "running";
  if (["pending", "waiting-for-host"].includes(display)) return "queued";
  if (t.queuedWork && t.queuedWork !== "none") return "queued";
  return "idle";
}

/** Finished work stays on the board this long. */
export const RECENT_MS = 7 * 24 * 3600_000;
export const BOARD_MAX_THREADS = 40;

const STATE_RANK: Record<ThreadState, number> = { "needs-you": 0, error: 1, running: 2, queued: 3, idle: 4 };

/**
 * Keep what matters on a board: anything live, every pinned chat, and
 * finished work from the last 7 days, at most 40. When the cap bites, live
 * chats go first, then pinned ones, then the most recent.
 */
export function selectThreads<T extends { state: ThreadState; updatedAt: number; pinned?: boolean }>(
  threads: T[],
  now: number,
  recentMs = RECENT_MS,
  max = BOARD_MAX_THREADS,
): T[] {
  const isLive = (t: T) => t.state === "running" || t.state === "queued" || t.state === "needs-you";
  const isRecent = (t: T) => (t.state === "idle" || t.state === "error") && now - t.updatedAt <= recentMs;
  const byNewest = (a: T, b: T) => b.updatedAt - a.updatedAt;
  const live = threads.filter(isLive).sort(byNewest);
  const pinned = threads.filter((t) => !isLive(t) && t.pinned === true).sort(byNewest);
  const recent = threads.filter((t) => !isLive(t) && t.pinned !== true && isRecent(t)).sort(byNewest);
  return [...live, ...pinned, ...recent]
    .slice(0, max)
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.updatedAt - a.updatedAt);
}

/**
 * Merge every server's snapshot into one column per physical machine.
 * A machine can appear in two snapshots (an always-on Mac runs its own bb AND
 * is enrolled in another Mac's), so threads are unioned and de-duplicated by id.
 * Columns follow the profile's machine order.
 */
export function buildColumns(snapshots: Snapshot[], localServerId: string, localMachines: string[], now: number, profile: Profile): Column[] {
  const byKey = new Map<string, Column>();
  const seen = new Set<string>();
  const ensure = (key: string, label: string): Column => {
    let col = byKey.get(key);
    if (col === undefined) {
      col = {
        key,
        label,
        serverId: null,
        url: null,
        online: false,
        local: localMachines.includes(key),
        lastSeenAt: null,
        capabilities: [],
        threads: [],
        counts: { running: 0, needsYou: 0, queued: 0 },
        mirror: false,
        ownerStatus: "unknown",
        ownerOnline: false,
        enrolledOnline: localMachines.includes(key),
        ownerHostId: null,
        resources: null,
        system: null,
      };
      byKey.set(key, col);
    }
    return col;
  };

  for (const snap of [...snapshots].sort((a, b) => a.publishedAt - b.publishedAt)) {
    const fresh = now - snap.publishedAt <= STALE_MS || snap.serverId === localServerId;
    // The machine that hosts this bb owns the column's "start work" route.
    const own = ensure(snap.machineKey, snap.machines.find((m) => m.key === snap.machineKey)?.label ?? snap.machineKey);
    own.serverId = snap.serverId;
    own.url = snap.url;
    own.lastSeenAt = Math.max(own.lastSeenAt ?? 0, snap.publishedAt);
    own.ownerStatus = fresh ? "live" : "stale";
    own.ownerOnline = fresh && (snap.machines.find((machine) => machine.key === snap.machineKey)?.online ?? false);
    own.ownerHostId = snap.ownerHostId ?? null;
    own.resources = snap.resources ?? null;
    own.system = snap.system ?? null;
    own.mirror = own.mirror === true || (snap.features ?? []).includes("mirror");
    for (const m of snap.machines) {
      const col = ensure(m.key, m.label);
      if (m.key === snap.machineKey) col.label = m.label;
      col.online = col.online || (fresh && m.online);
      for (const c of m.capabilities) if (!col.capabilities.includes(c)) col.capabilities.push(c);
    }
    for (const t of snap.threads) {
      const id = `${snap.serverId}:${t.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      ensure(t.machine, t.machine).threads.push({ ...t, via: snap.serverId });
    }
  }

  for (const col of byKey.values()) {
    col.threads.sort((a, b) => {
      const rank: Record<ThreadState, number> = { "needs-you": 0, error: 1, running: 2, queued: 3, idle: 4 };
      return rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt;
    });
    col.counts = {
      running: col.threads.filter((t) => t.state === "running").length,
      needsYou: col.threads.filter((t) => t.state === "needs-you").length,
      queued: col.threads.filter((t) => t.state === "queued").length,
    };
  }

  const known = machineOrder(profile);
  const order = (key: string) => {
    const i = known.indexOf(key);
    return i === -1 ? known.length : i;
  };
  return [...byKey.values()].sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
}

/**
 * Map an enrolled host's display name to a machine key: a setting alias first,
 * then a profile machine named by its id, label or hostname (the whole name, or
 * a whole word of it such as "Jo's studio MacBook Pro"), else the name itself.
 */
export function machineKeyForHost(hostName: string, aliases: Record<string, string>, profile: Profile): string {
  if (aliases[hostName] !== undefined) return aliases[hostName];
  const lower = hostName.trim().toLowerCase();
  const whole = profile.machines.find((m) => m.id.toLowerCase() === lower || m.label.toLowerCase() === lower || m.hostnames.some((h) => h.toLowerCase() === lower));
  if (whole) return whole.id;
  const word = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(hostName);
  return profile.machines.find((m) => word(m.id) || word(m.label))?.id ?? hostName;
}

export function threadUrl(serverUrl: string | null, projectId: string, threadId: string, personal: boolean): string | null {
  if (serverUrl === null) return null;
  const base = serverUrl.replace(/\/+$/, "");
  return personal ? `${base}/threads/${threadId}` : `${base}/projects/${projectId}/threads/${threadId}`;
}

// ---------- two-way relay: fleet_messages in, fleet_outputs out ----------

/** Advertised in every snapshot by a Fleet that runs the relay below. */
export const RELAY_FEATURES = ["messages", "outputs"];
/** Published output is cut to this many UTF-8 bytes (truncated = 1). */
export const OUTPUT_MAX_BYTES = 64 * 1024;
/** Largest message (or ask prompt) Fleet carries to another machine. */
export const MESSAGE_MAX_BYTES = 256 * 1024;
export const DEFAULT_WAIT_MS = 20 * 60_000;
/** bb's CLI gives a plugin command 65 minutes to answer, so waits stop at 60. */
export const MAX_WAIT_MS = 60 * 60_000;

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Cut text to at most maxBytes of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let cut = Math.max(0, maxBytes);
  // Step back over UTF-8 continuation bytes (10xxxxxx) to a character boundary.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return { text: new TextDecoder().decode(bytes.subarray(0, cut)), truncated: true };
}

/** A thread's turn has finished: there is an answer to publish. */
export function isSettled(state: ThreadState): boolean {
  return state === "idle" || state === "error";
}

export interface PublishedOutput {
  hash: string;
  state: string;
  updatedAt: number; // target clock
}

/**
 * Should the target publish this thread's output now? Only settled threads
 * publish, an idle thread with no answer yet does not, and a changed answer or
 * state does. One more case: a Fleet message delivered after the last publish
 * whose turn has since finished (the thread moved after the delivery) republishes
 * even an identical answer, so `bb fleet tell --wait` sees "PONG" twice.
 * All times come from the target's clock.
 */
export function decidePublish(input: {
  published: PublishedOutput | undefined;
  state: ThreadState;
  hash: string;
  empty: boolean;
  threadUpdatedAt: number;
  lastDeliveredAt: number | null;
}): boolean {
  const { published, state, hash, empty, threadUpdatedAt, lastDeliveredAt } = input;
  if (!isSettled(state)) return false;
  if (state === "idle" && empty) return false;
  if (published === undefined) return true;
  if (published.hash !== hash || published.state !== state) return true;
  return lastDeliveredAt !== null && lastDeliveredAt > published.updatedAt && threadUpdatedAt > lastDeliveredAt;
}

/** "20m", "90s", "2h", "500ms", or a bare number of seconds (as `bb thread wait`). */
export function parseDuration(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const ms = amount * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as Record<string, number>)[unit]!;
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

export type RelayCommand =
  | { kind: "ask"; machine: string; prompt: string; messageFile: string | null; timeoutMs: number; json: boolean; execution?: ExecutionSelection; routing?: RoutingPreferences }
  | {
      kind: "tell";
      machine: string;
      threadId: string;
      message: string;
      messageFile: string | null;
      wait: boolean;
      timeoutMs: number;
      json: boolean;
    }
  | { kind: "output"; machine: string; threadId: string; json: boolean }
  | { kind: "result"; commandId: string; wait: boolean; timeoutMs: number; json: boolean }
  | { kind: "help"; command: RelayCommandName };

export type RelayCommandName = "ask" | "tell" | "output" | "result";
export const RELAY_COMMANDS: RelayCommandName[] = ["ask", "tell", "output", "result"];

export const RELAY_USAGE: Record<RelayCommandName, string> = {
  ask: "bb fleet ask <machine|auto> <prompt...> [--provider <id> --model <id> --reasoning-level <level> --service-tier <id>] [--workload <id>] [--nas] [--unattended] [--require-capability <name>] [--message-file <path>] [--timeout 20m] [--json]",
  tell: "bb fleet tell <machine> <thread-id> <message...> [--message-file <path>] [--wait] [--timeout 20m] [--json]",
  output: "bb fleet output <machine> <thread-id> [--json]",
  result: "bb fleet result <command-id|request-id> [--wait] [--timeout 20m] [--json]",
};

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/;
const COMMAND_ID = /^[0-9A-Fa-f][0-9A-Fa-f-]{7,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;

/**
 * Parse `bb fleet ask|tell|output|result ...` (argv includes the subcommand).
 * Options may sit anywhere before a bare `--`; everything after `--` is text,
 * so a prompt can mention `--json` safely.
 */
export function parseRelayArgs(argv: string[], profile: Profile): { ok: true; command: RelayCommand } | { ok: false; error: string } {
  const [name, ...rest] = argv;
  if (!RELAY_COMMANDS.includes(name as RelayCommandName)) return { ok: false, error: `Unknown command: ${name ?? ""}` };
  const kind = name as RelayCommandName;
  const usage = `Usage: ${RELAY_USAGE[kind]}`;
  const fail = (error: string) => ({ ok: false as const, error: `${error}\n${usage}` });
  const allowed: Record<RelayCommandName, string[]> = {
    ask: ["json", "message-file", "timeout", "provider", "model", "reasoning-level", "service-tier", "workload", "nas", "unattended", "require-capability"],
    tell: ["json", "message-file", "wait", "timeout"],
    output: ["json"],
    result: ["json", "wait", "timeout"],
  };
  const words: string[] = [];
  const selection: ExecutionSelection = {};
  const routing: RoutingPreferences = {};
  const opts: { json: boolean; wait: boolean; messageFile: string | null; timeout: string | null } = {
    json: false,
    wait: false,
    messageFile: null,
    timeout: null,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--") {
      words.push(...rest.slice(i + 1));
      break;
    }
    if (arg === "--help" || (arg === "-h" && words.length === 0)) return { ok: true, command: { kind: "help", command: kind } };
    if (!arg.startsWith("--") || arg.length === 2) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (!allowed[kind].includes(key)) {
      return fail(`Unknown option '--${key}'. Put text that starts with -- after a bare --.`);
    }
    if (key === "nas" || key === "unattended") {
      if (eq !== -1) return fail(`--${key} takes no value`);
      if (key === "nas") routing.needsNas = true;
      else routing.unattended = true;
      continue;
    }
    if (key === "json" || key === "wait") {
      if (eq !== -1) return fail(`--${key} takes no value`);
      opts[key] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = rest[i + 1];
      i += 1;
    }
    if (value === undefined || value === "") return fail(`--${key} needs a value`);
    if (key === "message-file") opts.messageFile = value;
    else if (key === "timeout") opts.timeout = value;
    else if (key === "provider") selection.providerId = value;
    else if (key === "model") selection.model = value;
    else if (key === "reasoning-level") selection.reasoningLevel = value;
    else if (key === "service-tier") selection.serviceTier = value;
    else if (key === "workload") {
      const known = workloadIds(profile);
      if (!known.includes(value)) return fail(`--workload must be ${known.join(" or ")}`);
      routing.workload = value;
    } else if (key === "require-capability") routing.requiredCapabilities = [...(routing.requiredCapabilities ?? []), value];
  }

  let timeoutMs = DEFAULT_WAIT_MS;
  if (opts.timeout !== null) {
    const parsed = parseDuration(opts.timeout);
    if (parsed === null || parsed <= 0) return fail(`Invalid --timeout '${opts.timeout}' (use e.g. 90s, 20m, 1h)`);
    if (parsed > MAX_WAIT_MS) return fail("--timeout is at most 60m (bb stops waiting for a plugin command after 65 minutes)");
    timeoutMs = parsed;
  }
  // Asking for a timeout means asking to wait.
  const wait = opts.wait || opts.timeout !== null;

  if (kind === "result") {
    const [commandId, ...extra] = words;
    if (commandId === undefined) return fail("Missing <command-id>");
    if (!COMMAND_ID.test(commandId) && !REQUEST_ID.test(commandId)) return fail(`Not a fleet command or request id: ${commandId}`);
    if (extra.length > 0) return fail(`Unexpected argument: ${extra[0]}`);
    return { ok: true, command: { kind, commandId: commandId.toLowerCase(), wait, timeoutMs, json: opts.json } };
  }

  const [machineRaw, ...more] = words;
  if (machineRaw === undefined || machineRaw.trim() === "") return fail(`Missing <machine> (${machineOrder(profile).join(", ")})`);
  const asked = machineRaw.trim();
  const machine = asked.toUpperCase() === "AUTO" ? "AUTO" : (resolveMachineId(profile, asked) ?? asked);

  if (kind === "ask") {
    const prompt = more.join(" ").trim();
    if (prompt === "" && opts.messageFile === null) return fail("Missing <prompt> (or --message-file <path>)");
    try { executionSelection(selection); routingPreferencesSchema.parse(routing); } catch (cause) { return fail(cause instanceof Error ? cause.message : "Invalid execution options"); }
    return { ok: true, command: { kind, machine, prompt, messageFile: opts.messageFile, timeoutMs, json: opts.json, ...(Object.keys(selection).length ? { execution: selection } : {}), ...(Object.keys(routing).length ? { routing } : {}) } };
  }

  const [threadId, ...text] = more;
  if (threadId === undefined) return fail("Missing <thread-id>");
  if (!THREAD_ID.test(threadId)) return fail(`Not a thread id: ${threadId}`);
  if (kind === "output") {
    if (text.length > 0) return fail(`Unexpected argument: ${text[0]}`);
    return { ok: true, command: { kind, machine, threadId, json: opts.json } };
  }
  const message = text.join(" ").trim();
  if (message === "" && opts.messageFile === null) return fail("Missing <message> (or --message-file <path>)");
  return {
    ok: true,
    command: { kind, machine, threadId, message, messageFile: opts.messageFile, wait, timeoutMs, json: opts.json },
  };
}

/** Message text: the typed words, then the file's text, separated by a blank line. */
export function composeMessage(words: string, fileText: string | null): string {
  return [words.trim(), fileText ?? ""].filter((part) => part.trim() !== "").join("\n\n");
}

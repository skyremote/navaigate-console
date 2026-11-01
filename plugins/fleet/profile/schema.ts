// Shared NavAIgate Console profile: schema, defaults merge and selectors.
//
// This file is byte-identical in every plugin that reads the profile (Console,
// Fleet, Helper Desk). Edit the canonical copy and copy it to the others; the
// profile sync test fails when the copies differ.
//
// Pure: no node, React or SDK imports, so both the server and the browser
// bundle can import it. Reading and writing the file lives in ./load.ts.
//
// Everything personal (machine names, addresses, owner, paths, client
// workloads, pinned ids) comes from the profile, never from code. The
// community defaults describe one Mac with every remote feature off.
// Secrets are never stored here: the profile only names the secret to read.

import { z } from "zod";

export const PROFILE_SCHEMA_VERSION = 1;

export const MACHINE_ROLES = ["primary", "always-on", "restricted", "laptop", "other"] as const;
export type MachineRole = (typeof MACHINE_ROLES)[number];

const text = (max: number) => z.string().max(max);
const optionalText = (max: number) => z.string().max(max).nullable();

export const machineSchema = z.object({
  /** Stable key used in data and settings, e.g. "this-mac" or "studio". */
  id: z.string().min(1).max(40),
  /** What the interface shows. */
  label: z.string().min(1).max(60),
  role: z.enum(MACHINE_ROLES),
  /** Runs only its own workloads: no system view, nothing moves to or from it. */
  restricted: z.boolean(),
  /** Workload ids that must run on this machine. */
  workloads: z.array(text(60)),
  /** os.hostname() values (case-insensitive) that identify this machine. */
  hostnames: z.array(text(120)),
  /** SSH alias for a direct route to this machine, or null. */
  sshAlias: optionalText(120),
  /** Address of this machine's bb, or null. */
  bbUrl: optionalText(300),
  /** Home folder on that machine, or null when unknown. */
  home: optionalText(300),
});
export type ProfileMachine = z.infer<typeof machineSchema>;

export const workloadSchema = z.object({
  id: z.string().min(1).max(60),
  label: text(80),
  /** Machine id the workload is restricted to, or null for anywhere. */
  machine: optionalText(40),
  /** Case-insensitive words that tag a project or chat as this workload. */
  match: z.array(text(80)),
});
export type ProfileWorkload = z.infer<typeof workloadSchema>;

export const PRESETS = ["simple", "pro", "custom"] as const;
export type Preset = (typeof PRESETS)[number];

export const profileSchema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  edition: z.enum(["community", "private"]),
  owner: z.object({ name: text(120), username: text(120) }),
  /** Explicit id of the machine this profile file sits on, or null to match by hostname. */
  thisMachine: optionalText(40),
  machines: z.array(machineSchema).min(1),
  hosts: z.object({
    fleet: optionalText(300),
    brainMcp: optionalText(300),
    brainDb: optionalText(300),
    hooks: optionalText(300),
    bbRemotes: z.array(text(300)),
  }),
  paths: z.object({
    home: text(300),
    nas: optionalText(300),
    nasLocal: optionalText(300),
  }),
  workloads: z.array(workloadSchema),
  brain: z.object({
    url: optionalText(300),
    /** Name of the bb secret or environment variable holding the token. Never the token. */
    tokenSecret: optionalText(120),
  }),
  ids: z.object({
    projects: z.record(z.string(), z.string()),
    threads: z.record(z.string(), z.string()),
  }),
  features: z.object({
    preset: z.enum(PRESETS).nullable(),
    /** Feature id to ticked or not. A missing id uses the feature's picker default. */
    picks: z.record(z.string(), z.boolean()),
  }),
  setup: z.object({
    completedAt: z.number().nullable(),
    version: z.number().int(),
  }),
  /** Plugin-specific sections; each plugin validates its own section in its own module. */
  plugins: z.record(z.string(), z.unknown()),
});
export type Profile = z.infer<typeof profileSchema>;

/** Community defaults: this Mac only, remote features off until configured. Keep in step with community.defaults.json. */
export const COMMUNITY_DEFAULTS: Profile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  edition: "community",
  owner: { name: "", username: "" },
  thisMachine: null,
  machines: [
    { id: "this-mac", label: "This Mac", role: "primary", restricted: false, workloads: [], hostnames: [], sshAlias: null, bbUrl: null, home: null },
  ],
  hosts: { fleet: null, brainMcp: null, brainDb: null, hooks: null, bbRemotes: [] },
  paths: { home: "~", nas: null, nasLocal: null },
  workloads: [],
  brain: { url: null, tokenSecret: null },
  ids: { projects: {}, threads: {} },
  features: { preset: null, picks: {} },
  setup: { completedAt: null, version: 1 },
  plugins: {},
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars from `over` replace `base`. */
function merge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isObject(base) && isObject(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
    return out;
  }
  return over;
}

function fillMachine(raw: unknown): unknown {
  return merge(COMMUNITY_DEFAULTS.machines[0], raw);
}

export type ResolvedProfile = { profile: Profile; source: "defaults" | "file"; errors: string[] };

/**
 * Overlay a raw profile (parsed JSON, possibly partial) on the community
 * defaults and validate. An invalid profile falls back to the defaults and
 * reports why, so a typo never half-applies personal values.
 */
export function resolveProfile(raw: unknown): ResolvedProfile {
  if (raw === undefined || raw === null) return { profile: COMMUNITY_DEFAULTS, source: "defaults", errors: [] };
  if (!isObject(raw)) return { profile: COMMUNITY_DEFAULTS, source: "defaults", errors: ["profile is not a JSON object"] };
  const withMachines = Array.isArray(raw.machines) ? { ...raw, machines: raw.machines.map(fillMachine) } : raw;
  const merged = merge(COMMUNITY_DEFAULTS, withMachines);
  const parsed = profileSchema.safeParse(merged);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { profile: COMMUNITY_DEFAULTS, source: "defaults", errors };
  }
  const ids = new Set<string>();
  for (const m of parsed.data.machines) {
    if (ids.has(m.id)) return { profile: COMMUNITY_DEFAULTS, source: "defaults", errors: [`machines: duplicate id ${m.id}`] };
    ids.add(m.id);
  }
  return { profile: parsed.data, source: "file", errors: [] };
}

// ---------- selectors ----------

export function machineById(p: Profile, id: string | null | undefined): ProfileMachine | null {
  if (!id) return null;
  return p.machines.find((m) => m.id === id) ?? p.machines.find((m) => m.id.toLowerCase() === id.toLowerCase()) ?? null;
}

/** The interface name for a machine id; unknown ids show as they are. */
export function machineLabel(p: Profile, id: string | null | undefined): string {
  return machineById(p, id)?.label ?? (id || "");
}

/** Machine ids in profile order (the order tiles and columns are drawn in). */
export function machineOrder(p: Profile): string[] {
  return p.machines.map((m) => m.id);
}

/** The machine this profile sits on: explicit `thisMachine`, then a hostname match, then the first machine. */
export function thisMachine(p: Profile, hostname?: string | null): ProfileMachine {
  const explicit = machineById(p, p.thisMachine);
  if (explicit) return explicit;
  const h = (hostname ?? "").toLowerCase();
  if (h) {
    const byHost = p.machines.find((m) => m.hostnames.some((n) => n.toLowerCase() === h || h.startsWith(`${n.toLowerCase()}.`)));
    if (byHost) return byHost;
  }
  return p.machines[0] as ProfileMachine;
}

export function machinesWithRole(p: Profile, role: MachineRole): ProfileMachine[] {
  return p.machines.filter((m) => m.role === role);
}

/** The always-on machine (the one chats can be sent to), or null when none is configured. */
export function alwaysOnMachine(p: Profile): ProfileMachine | null {
  return machinesWithRole(p, "always-on")[0] ?? null;
}

export function isRestricted(p: Profile, id: string | null | undefined): boolean {
  return machineById(p, id)?.restricted === true;
}

export function hasTwoMachines(p: Profile): boolean {
  return p.machines.length >= 2;
}

/** The workload whose match words appear in `text` (a project name, path or tag), or null. */
export function workloadFor(p: Profile, text: string | null | undefined): ProfileWorkload | null {
  const t = (text ?? "").toLowerCase();
  if (!t) return null;
  return p.workloads.find((w) => w.id.toLowerCase() === t || w.match.some((word) => word && t.includes(word.toLowerCase()))) ?? null;
}

/** The machine a workload must run on, or null for anywhere. */
export function workloadMachine(p: Profile, workloadId: string | null | undefined): ProfileMachine | null {
  const w = p.workloads.find((x) => x.id === workloadId);
  return w?.machine ? machineById(p, w.machine) : null;
}

/** Whether a feature is ticked: the saved pick, else the feature's picker default. */
export function featureOn(p: Profile, featureId: string, pickerDefault: "on" | "off"): boolean {
  const pick = p.features.picks[featureId];
  return typeof pick === "boolean" ? pick : pickerDefault === "on";
}

export function setupDone(p: Profile): boolean {
  return p.setup.completedAt !== null;
}

/** Expand a leading "~" with the given home folder. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** A plugin's own section, or undefined. The plugin validates it. */
export function pluginSection(p: Profile, name: string): unknown {
  return p.plugins[name];
}

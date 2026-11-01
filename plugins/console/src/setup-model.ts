// The first-run setup screen without the screen: the draft the steps edit, the
// checks on what is typed, and how a draft becomes a profile. Pure, so it is
// tested without rendering.
import { COMMUNITY_DEFAULTS, setupDone, type MachineRole, type Preset, type Profile, type ProfileMachine } from "../profile/schema";
import { presetPicks } from "./features-enabled";

export const SETUP_PATH = "setup";
export const SETUP_HREF = `/plugins/navaigate-skin/${SETUP_PATH}`;

export type SetupRole = "laptop" | "always-on" | "restricted";
export const SETUP_ROLES: ReadonlyArray<{ value: SetupRole; label: string }> = [
  { value: "laptop", label: "Laptop" },
  { value: "always-on", label: "Always-on" },
  { value: "restricted", label: "Restricted" },
];

export type MachineDraft = { id: string | null; label: string; role: SetupRole; sshAlias: string; bbUrl: string };
/** `machine` is the label of the Mac the workload must run on (empty for anywhere). */
export type WorkloadDraft = { id: string | null; name: string; machine: string; match: string };

export type SetupDraft = {
  name: string;
  /** This Mac's name. */
  thisMac: string;
  /** Further Macs, in the order they are listed. */
  machines: MachineDraft[];
  workloads: WorkloadDraft[];
  hooks: string;
  brainUrl: string;
  brainTokenSecret: string;
  preset: Preset | null;
  picks: Record<string, boolean>;
};

const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A URL-safe id from a label: lower case, letters and digits joined by hyphens. */
export function slug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = base || "mac";
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
}

/**
 * Whether a value typed into a name field looks like a secret itself. The setup
 * screen only ever stores the NAME of a secret, so these are refused.
 */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v === "") return false;
  if (/\s/.test(v)) return true;
  if (/^(sk|pk|rk)[-_]/i.test(v) || /^(ghp|gho|ghu|ghs|ghr|github_pat)_/i.test(v) || /^xox[abprs]-/i.test(v) || /^AKIA[0-9A-Z]{12,}/.test(v) || /^bearer/i.test(v)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(v)) return true;
  if (/^[0-9a-f]{32,}$/i.test(v)) return true;
  if (v.length > 64) return true;
  // A long run with upper case, lower case and digits and no word separators is random, not a name.
  if (v.length >= 24 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v) && !/[_.-]/.test(v)) return true;
  return false;
}

export const TOKEN_REFUSAL = "That looks like the secret itself. Type only the name of the bb secret or environment variable that holds it, for example BRAIN_TOKEN. The secret is never stored here.";

/** The problem with a typed secret name, in plain words; null when it is fine (or empty). */
export function secretNameProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (looksLikeSecret(v)) return TOKEN_REFUSAL;
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(v)) return "A secret name uses letters, digits, underscores, dots and hyphens, and starts with a letter.";
  return null;
}

/** The problem with a typed address; null when it is fine (or empty). Addresses must not carry credentials. */
export function addressProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return "Write the full address, starting with https://";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Write the full address, starting with https://";
  if (url.username || url.password) return "Leave the user name and password out of the address. Only the name of a secret is stored.";
  for (const [k, val] of url.searchParams) if (/token|key|secret|password|auth/i.test(k) || looksLikeSecret(val)) return "Leave keys and tokens out of the address. Only the name of a secret is stored.";
  return null;
}

export type SetupProblems = Partial<Record<"name" | "thisMac" | "hooks" | "brainUrl" | "brainTokenSecret", string>> & { machines: Array<{ label?: string; sshAlias?: string; bbUrl?: string }>; workloads: Array<{ name?: string; machine?: string }> };

export function problemsOf(draft: SetupDraft): SetupProblems {
  const out: SetupProblems = { machines: [], workloads: [] };
  if (draft.name.trim() === "") out.name = "Write your name to continue.";
  if (draft.thisMac.trim() === "") out.thisMac = "Give this Mac a name.";
  const hooks = addressProblem(draft.hooks);
  if (hooks) out.hooks = hooks;
  const brainUrl = addressProblem(draft.brainUrl);
  if (brainUrl) out.brainUrl = brainUrl;
  const secret = secretNameProblem(draft.brainTokenSecret);
  if (secret) out.brainTokenSecret = secret;
  for (const m of draft.machines) {
    const p: { label?: string; sshAlias?: string; bbUrl?: string } = {};
    if (m.label.trim() === "") p.label = "Give this Mac a name.";
    if (m.sshAlias.trim() !== "" && !SSH_ALIAS.test(m.sshAlias.trim())) p.sshAlias = "Use the Host name from your SSH config: letters, digits, dots, underscores and hyphens.";
    const addr = addressProblem(m.bbUrl);
    if (addr) p.bbUrl = addr;
    out.machines.push(p);
  }
  const labels = new Set([draft.thisMac, ...draft.machines.map((m) => m.label)].map((l) => l.trim().toLowerCase()));
  for (const w of draft.workloads) {
    const p: { name?: string; machine?: string } = {};
    if (w.name.trim() === "") p.name = "Give this workload a name.";
    // A workload tied to a Mac that is not listed would silently run anywhere, so it is not accepted.
    if (w.machine.trim() !== "" && !labels.has(w.machine.trim().toLowerCase())) p.machine = "Pick one of your Macs.";
    out.workloads.push(p);
  }
  return out;
}

export function hasProblems(p: SetupProblems): boolean {
  return !!(p.name || p.thisMac || p.hooks || p.brainUrl || p.brainTokenSecret) || p.machines.some((m) => m.label || m.sshAlias || m.bbUrl) || p.workloads.some((w) => w.name || w.machine);
}

const roleOf = (m: ProfileMachine): SetupRole => (m.restricted || m.role === "restricted" ? "restricted" : m.role === "always-on" ? "always-on" : "laptop");

/** The draft a profile stands for. `preset` is the installer's choice, used only when no preset was saved. */
export function draftFromProfile(profile: Profile, installerPreset: "simple" | "pro" | null = null): SetupDraft {
  const [first, ...rest] = profile.machines;
  const draft: SetupDraft = {
    name: profile.owner.name,
    thisMac: first?.label ?? COMMUNITY_DEFAULTS.machines[0]!.label,
    machines: rest.map((m) => ({ id: m.id, label: m.label, role: roleOf(m), sshAlias: m.sshAlias ?? "", bbUrl: m.bbUrl ?? "" })),
    workloads: profile.workloads.map((w) => ({ id: w.id, name: w.label || w.id, machine: profile.machines.find((m) => m.id === w.machine)?.label ?? "", match: w.match.join(", ") })),
    hooks: profile.hosts.hooks ?? "",
    brainUrl: profile.brain.url ?? "",
    brainTokenSecret: profile.brain.tokenSecret ?? "",
    preset: profile.features.preset,
    picks: { ...profile.features.picks },
  };
  if (!profile.features.preset && Object.keys(profile.features.picks).length === 0 && installerPreset) return applyPreset(draft, installerPreset);
  return draft;
}

/** Choosing a preset sets the preset and every pick it stands for. */
export function applyPreset(draft: SetupDraft, preset: "simple" | "pro"): SetupDraft {
  return { ...draft, preset, picks: presetPicks(preset) };
}

/** Changing any box makes the choice custom. */
export function setPick(draft: SetupDraft, id: string, on: boolean): SetupDraft {
  return { ...draft, preset: "custom", picks: { ...draft.picks, [id]: on } };
}

/**
 * The profile a draft stands for, on top of the one already saved. Nothing the
 * screen does not ask about is lost (hostnames, homes, paths, plugin sections),
 * and plugin settings are never touched. Machine ids stay once they exist; on a
 * first run the placeholder id is replaced by one derived from the Mac's name.
 */
export function buildProfile(base: Profile, draft: SetupDraft, now: number | null): Profile {
  const done = setupDone(base);
  const old = new Map(base.machines.map((m) => [m.id, m]));
  const taken = new Set<string>();
  const claim = (id: string) => (taken.add(id), id);

  const firstOld = base.machines[0];
  const firstId = claim(firstOld && (done || firstOld.id !== COMMUNITY_DEFAULTS.machines[0]!.id) ? firstOld.id : uniqueId(slug(draft.thisMac), taken));
  const first: ProfileMachine = { ...(firstOld ?? COMMUNITY_DEFAULTS.machines[0]!), id: firstId, label: draft.thisMac.trim() };

  const others: ProfileMachine[] = draft.machines.map((m) => {
    const prev = m.id ? old.get(m.id) : undefined;
    const id = claim(prev ? prev.id : uniqueId(slug(m.label), taken));
    return {
      id,
      label: m.label.trim(),
      role: m.role as MachineRole,
      restricted: m.role === "restricted",
      workloads: [],
      hostnames: prev?.hostnames ?? [],
      sshAlias: m.sshAlias.trim() || null,
      bbUrl: m.bbUrl.trim() || null,
      home: prev?.home ?? null,
    };
  });

  const machines = [first, ...others];
  const workloadIds = new Set<string>();
  const workloads = draft.workloads.map((w) => {
    const id = uniqueId(w.id ?? (slug(w.name) || "workload"), workloadIds);
    workloadIds.add(id);
    const wanted = w.machine.trim().toLowerCase();
    const target = wanted ? (machines.find((m) => m.label.toLowerCase() === wanted) ?? null) : null;
    if (target && !target.workloads.includes(id)) target.workloads = [...target.workloads, id];
    return { id, label: w.name.trim(), machine: target ? target.id : null, match: w.match.split(",").map((x) => x.trim()).filter(Boolean) };
  });

  return {
    ...base,
    owner: { ...base.owner, name: draft.name.trim() },
    thisMachine: first.id,
    machines,
    hosts: { ...base.hosts, hooks: draft.hooks.trim() || null },
    workloads,
    brain: { url: draft.brainUrl.trim() || null, tokenSecret: draft.brainTokenSecret.trim() || null },
    features: { preset: draft.preset, picks: { ...draft.picks } },
    setup: { ...base.setup, completedAt: now ?? base.setup.completedAt },
  };
}

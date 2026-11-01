// Which features are on: the one rule behind the setup picker, every gate in the
// Console and the server. Pure: no React, no SDK, so the server imports it too.
//
// A feature is on when
//   - the profile is the private edition and no pick says false (everything
//     behaves as before, with no requirement or core check), or
//   - the saved pick (else the feature's default) is on, and every requirement
//     is met, and the core changes it needs are present in the running bb.
// `passedProbes` is the set of core-ledger ids the running bb passed. Probes need
// the SDK, so each side (browser, server) computes its own set (see
// core-probes.ts) and passes it in.
import { CORE_LEDGER } from "./core-ledger-data";
import { FEATURES } from "./features-guide-data";
import type { Feature, FeaturePicker } from "./features-guide-types";
import { featureOn, hasTwoMachines, setupDone, type Profile } from "../profile/schema";

const BY_ID = new Map<string, Feature>(FEATURES.map((f) => [f.id, f]));
const LEDGER = new Map(CORE_LEDGER.map((c) => [c.id, c]));

export type Probes = ReadonlySet<string>;
export const NO_PROBES: Probes = new Set();

export function featureById(id: string): Feature | undefined {
  return BY_ID.get(id);
}

/** Why a requirement is not met, in the words the setup screen shows; null when it is met. */
export function unmetReason(profile: Profile, requirement: string, probes: Probes, seen: ReadonlySet<string> = new Set()): string | null {
  if (requirement === "two-machines") return hasTwoMachines(profile) ? null : "needs a second Mac";
  if (requirement === "public-address") return profile.hosts.hooks ? null : "needs a public address";
  if (requirement === "brain") return profile.brain.url && profile.brain.tokenSecret ? null : "needs a brain";
  if (requirement.startsWith("feature:")) {
    const id = requirement.slice("feature:".length);
    if (seen.has(id)) return null;
    return featureEnabled(profile, id, probes, new Set([...seen, id])) ? null : `needs ${BY_ID.get(id)?.name ?? id} ticked`;
  }
  if (requirement.startsWith("core:")) return probes.has(requirement.slice("core:".length)) ? null : "needs a newer bb";
  return null;
}

/** The first requirement of a picker that is not met, as words; null when all are met. */
export function firstUnmet(profile: Profile, picker: FeaturePicker, probes: Probes, seen?: ReadonlySet<string>): string | null {
  // Core requirements hide a feature rather than grey it, so they are checked apart (see coreMissing).
  // Plain needs (a Mac, an address) come before "needs another feature ticked", so the reason names the root.
  const ordered = [...picker.requires].sort((x, y) => Number(x.startsWith("feature:")) - Number(y.startsWith("feature:")));
  for (const r of ordered) {
    if (r.startsWith("core:")) continue;
    const why = unmetReason(profile, r, probes, seen);
    if (why) return why;
  }
  return null;
}

/** True when a core change the feature needs is missing from the running bb. */
export function coreMissing(picker: FeaturePicker, probes: Probes): boolean {
  return picker.requires.some((r) => r.startsWith("core:") && !probes.has(r.slice("core:".length)));
}

function featureEnabled(profile: Profile, id: string, probes: Probes, seen: ReadonlySet<string>): boolean {
  const f = BY_ID.get(id);
  if (!f) return false;
  if (profile.edition === "private") return profile.features.picks[id] !== false;
  const picker = f.picker;
  if (!picker) return false;
  if (coreMissing(picker, probes)) return false;
  // A separate plugin is switched in bb's plugin settings, not here: the picker has no say, so it counts as on for the Console.
  if (picker.enforced === "plugin") return true;
  // An always-on feature cannot be unticked, but it still needs what it needs (a second Mac, a public address).
  if (picker.enforced !== "always" && !featureOn(profile, id, picker.default)) return false;
  return firstUnmet(profile, picker, probes, seen) === null;
}

/** Whether the feature is on for this profile in this bb. An unknown id is off. */
export function isFeatureEnabled(profile: Profile, id: string, probes: Probes = NO_PROBES): boolean {
  return featureEnabled(profile, id, probes, new Set([id]));
}

export type FeatureState =
  | { kind: "hidden" }
  | { kind: "locked" }
  /** A whole separate plugin: bb's plugin settings switch it, not the picker. The setup screen names it and links there. */
  | { kind: "plugin"; plugin: string }
  | { kind: "greyed"; reason: string }
  | { kind: "on" }
  | { kind: "off" };

/** What the setup picker draws for a feature: hidden (core change missing), locked on, greyed with a reason, or a plain box. */
export function featureState(profile: Profile, id: string, probes: Probes): FeatureState {
  const f = BY_ID.get(id);
  const picker = f?.picker;
  if (!f || !picker) return { kind: "hidden" };
  if (picker.enforced === "plugin") return { kind: "plugin", plugin: picker.plugin };
  // The private edition runs everything unless a box says otherwise: no requirement greys a box and no missing core change hides one.
  if (profile.edition === "private") return picker.enforced === "always" ? { kind: "locked" } : profile.features.picks[id] === false ? { kind: "off" } : { kind: "on" };
  if (coreMissing(picker, probes)) return { kind: "hidden" };
  const reason = firstUnmet(profile, picker, probes, new Set([id]));
  if (reason) return { kind: "greyed", reason };
  if (picker.enforced === "always") return { kind: "locked" };
  return featureOn(profile, id, picker.default) ? { kind: "on" } : { kind: "off" };
}

/** Features the community picker lists (not private-only), in guide order. */
export function pickerFeatures(): Feature[] {
  return FEATURES.filter((f) => f.edition === "both" && f.picker);
}

/** The picks a preset stands for: every listed feature ticked when the preset names it. Always-on features and separate plugins need no pick. */
export function presetPicks(preset: "simple" | "pro"): Record<string, boolean> {
  const picks: Record<string, boolean> = {};
  for (const f of pickerFeatures()) {
    if (!f.picker || f.picker.enforced === "always" || f.picker.enforced === "plugin") continue;
    picks[f.id] = f.picker.presets.includes(preset);
  }
  return picks;
}

/** The first run: the community edition, a profile the server has answered for, and setup never finished. */
export function shouldOpenSetup(state: { profile: Profile; loaded: boolean; errors: readonly string[] }): boolean {
  return state.loaded && state.errors.length === 0 && state.profile.edition === "community" && !setupDone(state.profile);
}

/** The core change ids a given set of detected capabilities passes (see core-probes.ts for how they are detected). */
export function ledgerIdsPassed(found: { releaseBuild: boolean; nativeHistory: boolean; cleanupSafety: boolean; continuationIntent: boolean }): Set<string> {
  const out = new Set<string>();
  for (const c of CORE_LEDGER) {
    if (c.effect === "none" && c.probe.kind === "none") {
      out.add(c.id);
      continue;
    }
    const ok =
      c.id === "native-history-and-composer-actions" ? found.nativeHistory
      : c.id === "protected-worktree-removal" ? found.cleanupSafety
      : c.id === "native-continuation" ? found.continuationIntent || found.releaseBuild
      : found.releaseBuild; // every other change is detected by the release-build marker (see the ledger probes)
    if (ok) out.add(c.id);
  }
  return out;
}

export function ledgerSummary(id: string): string | undefined {
  return LEDGER.get(id)?.summary;
}

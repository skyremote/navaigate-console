// The feature picker as the server's own code sees it. The profile is read each
// time (cheap, mtime-cached); the core probes are filled in by server-setup.ts.
import { loadProfile } from "./profile/load";
import { isFeatureEnabled, NO_PROBES, type Probes } from "./src/features-enabled";

let passed: Probes = NO_PROBES;

export function setServerProbes(next: Probes) {
  passed = next;
}

/** Whether a feature is on, for a server-side gate. Private edition: on unless a pick says false. */
export function serverFeatureOn(id: string): boolean {
  return isFeatureEnabled(loadProfile().profile, id, passed);
}

/** What a module that can be gated takes: a test passes its own, the server passes serverFeatureOn. */
export type FeatureGate = (id: string) => boolean;
export const ALL_ON: FeatureGate = () => true;

export type UpdateChannel = "stable" | "nightly";
export interface UpdatePolicy { testMachine: string | null; pinnedVersion: string | null }

const EXACT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** The staging machine is the nightly channel; every other machine is stable and waits for it. */
export function channelFor(policy: UpdatePolicy, machine: string): UpdateChannel {
  return policy.testMachine === machine ? "nightly" : "stable";
}

/** There is one test host: choosing nightly moves it, and choosing stable on it switches staging off. */
export function policyForChannel(policy: UpdatePolicy, machine: string, channel: UpdateChannel): UpdatePolicy {
  if (channel === "nightly") return { ...policy, testMachine: machine };
  return policy.testMachine === machine ? { ...policy, testMachine: null } : policy;
}

export function parsePinInput(text: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  return EXACT_VERSION.test(trimmed) ? { ok: true, value: trimmed } : { ok: false, error: "Use an exact version such as 0.48.1" };
}

export function policyFromSettings(values: { updateTestMachine: string; updatePinnedVersion: string }): UpdatePolicy {
  const pin = values.updatePinnedVersion.trim();
  return { testMachine: values.updateTestMachine.trim() || null, pinnedVersion: EXACT_VERSION.test(pin) ? pin : null };
}

export function policyToSettings(policy: UpdatePolicy): { updateTestMachine: string; updatePinnedVersion: string } {
  return { updateTestMachine: policy.testMachine ?? "", updatePinnedVersion: policy.pinnedVersion ?? "" };
}

interface GateRow { machine: string; status: { app: { current: string; available: string | null } | null } | null }

/** Why the updater would refuse to install what this machine is offered, using the rules `update_dispatch` enforces; null when it would go ahead. */
export function updateGate(policy: UpdatePolicy, rows: GateRow[], machine: string): string | null {
  const available = rows.find((row) => row.machine === machine)?.status?.app?.available ?? null;
  if (available === null) return null;
  if (policy.pinnedVersion !== null && policy.pinnedVersion !== available) return `Pinned to ${policy.pinnedVersion}`;
  if (policy.testMachine === null || policy.testMachine === machine) return null;
  const tested = rows.find((row) => row.machine === policy.testMachine)?.status?.app?.current ?? null;
  return tested === available ? null : `Waits for ${policy.testMachine} to run ${available} (it runs ${tested ?? "unknown"})`;
}

export function channelChangeMessage(policy: UpdatePolicy, machine: string, channel: UpdateChannel): string {
  if (channel === "nightly") return policy.testMachine !== null && policy.testMachine !== machine ? `${machine} is now the nightly test host; ${policy.testMachine} is back on stable` : `${machine} is now the nightly test host`;
  return policy.testMachine === machine ? `${machine} is on the stable channel; no machine is nightly` : `${machine} is on the stable channel`;
}

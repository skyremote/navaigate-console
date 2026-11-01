// Fleet's own section of the profile (`plugins.fleet`) and the machine rules
// derived from the shared profile. Pure: the browser bundle may import it.
//
// Keys here are Fleet-specific, so they live under `plugins.fleet` rather than
// in the shared schema. Every key has a community default.

import { z } from "zod";
import {
  type Profile,
  type ProfileMachine,
  alwaysOnMachine,
  isRestricted,
  machineById,
  machineLabel,
  pluginSection,
  workloadMachine,
} from "../profile/schema";

export const fleetSectionSchema = z.object({
  /** LAN address of the NAS, probed on port 445 to confirm the mount is reachable. Null = no NAS check. */
  nasHost: z.string().max(300).nullable().default(null),
  /** Where the Fleet provider's "install" link points. Null = the bb site. */
  installUrl: z.string().max(300).nullable().default(null),
  /** Project new work starts in when the plugin setting is blank. Blank = the personal workspace. */
  defaultProject: z.string().max(200).default(""),
});
export type FleetSection = z.infer<typeof fleetSectionSchema>;

export const FLEET_COMMUNITY_SECTION: FleetSection = { nasHost: null, installUrl: null, defaultProject: "" };

export const DEFAULT_INSTALL_URL = "https://getbb.app";

export function fleetSection(profile: Profile): FleetSection {
  const parsed = fleetSectionSchema.safeParse(pluginSection(profile, "fleet") ?? {});
  return parsed.success ? parsed.data : FLEET_COMMUNITY_SECTION;
}

/** The general workload id: work that may run anywhere. */
export const GENERAL_WORKLOAD = "general";

/** A workload id the profile defines, or "general". */
export function isWorkloadId(profile: Profile, value: unknown): value is string {
  return typeof value === "string" && (value === GENERAL_WORKLOAD || profile.workloads.some((w) => w.id === value));
}

export function workloadIds(profile: Profile): string[] {
  return [GENERAL_WORKLOAD, ...profile.workloads.map((w) => w.id)];
}

export function workloadLabel(profile: Profile, id: string): string {
  return profile.workloads.find((w) => w.id === id)?.label || id;
}

/** The profile's machine for a key typed by a person (case-insensitive), else null. */
export function resolveMachineId(profile: Profile, raw: string | null | undefined): string | null {
  return machineById(profile, (raw ?? "").trim())?.id ?? null;
}

export function isFleetMachine(profile: Profile, value: string | null | undefined): value is string {
  return machineById(profile, value) !== null;
}

/** The always-on machine that a direct SSH route can reach from `localKey`: needs an ssh alias and must not be this machine. */
export function directRouteMachine(profile: Profile, localKey: string): { machine: ProfileMachine; alias: string } | null {
  const machine = alwaysOnMachine(profile);
  if (machine === null || machine.sshAlias === null || machine.sshAlias.trim() === "") return null;
  if (machine.id === localKey) return null;
  return { machine, alias: machine.sshAlias.trim() };
}

/** Why `machineKey` may not take work with this workload, or null when it may. */
export function workloadRefusal(profile: Profile, machineKey: string, workload: string | undefined): string | null {
  const machine = machineById(profile, machineKey);
  if (machine !== null && isRestricted(profile, machineKey) && !(workload !== undefined && machine.workloads.includes(workload))) {
    const names = machine.workloads.map((id) => workloadLabel(profile, id));
    return `${machine.label} requires an explicitly ${names.length ? names.join(" or ") : "matching"} workload`;
  }
  if (workload !== undefined && workload !== GENERAL_WORKLOAD) {
    const required = workloadMachine(profile, workload);
    if (required !== null && required.id !== machine?.id) {
      return `${workloadLabel(profile, workload)} workloads require ${required.label}'s host-local access; capacity does not authorise transfer to a personal host`;
    }
  }
  return null;
}


export { machineLabel };

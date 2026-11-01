// Which Fleet features the owner has switched off in the setup picker.
//
// Pure: the browser bundle and the server both import it. The rule is the same
// one every plugin without a feature map uses: a feature is OFF only when the
// profile is not the private edition and its saved pick is exactly false. Setup
// writes an explicit pick for every feature, so an unticked box is false; no
// profile, or no pick, means on.
import type { Profile } from "../profile/schema";

type PickSource = Pick<Profile, "edition" | "features">;

export function pickedOff(profile: PickSource, id: string): boolean {
  return profile.edition !== "private" && profile.features.picks[id] === false;
}

/** Every feature id Fleet gates, with the control it hides. F01 (provider chips) is always on and not listed. */
export const FLEET_GATED = {
  F06: "Tell and Ask",
  F07: "MCP on/off",
  F18: "Open terminal",
  F21: "Simulators",
  F22: "Browser",
  F23: "Route chips",
  F25: "Copy MCP endpoint",
  F26: "Versions and updates",
  F29: "Ignored files transfer",
  F65: "New project on a machine",
  F77: "Load metrics",
  F78: "Update channels and Pin version",
  F82: "Machines enrolment",
} as const;
export type FleetGatedId = keyof typeof FLEET_GATED;

export const FLEET_GATED_IDS = Object.keys(FLEET_GATED) as FleetGatedId[];

/** The Fleet feature ids picked off, and nothing else, for the browser. */
export function picksOff(profile: PickSource): FleetGatedId[] {
  return FLEET_GATED_IDS.filter((id) => pickedOff(profile, id));
}

/** The plain refusal a server action gives when its feature is switched off. */
export function offMessage(id: FleetGatedId): string {
  return `${FLEET_GATED[id]} is switched off. Tick it in the Console's Setup, under Features, to use it.`;
}

/** Browser helper: is this id in the list the server sent? */
export function isOff(off: readonly string[], id: FleetGatedId): boolean {
  return off.includes(id);
}

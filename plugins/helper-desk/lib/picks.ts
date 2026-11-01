// Which Helper Desk features the owner has switched off in the setup picker.
//
// Pure: server and browser both import it. A feature is OFF only when the profile
// is not the private edition and its saved pick is exactly false. Setup writes an
// explicit pick for every feature, so an unticked box is false; no profile, or no
// pick, means on.
import type { Profile } from "../profile/schema";

type PickSource = Pick<Profile, "edition" | "features">;

/** The one feature Helper Desk gates: choosing and showing animated mascots. */
export const MASCOTS_FEATURE = "EXTRA-C";
export const HELPER_DESK_GATED = [MASCOTS_FEATURE] as const;

export function pickedOff(profile: PickSource, id: string): boolean {
  return profile.edition !== "private" && profile.features.picks[id] === false;
}

/** Helper Desk's own feature ids that are picked off, and nothing else, for the browser. */
export function picksOff(profile: PickSource): string[] {
  return HELPER_DESK_GATED.filter((id) => pickedOff(profile, id));
}

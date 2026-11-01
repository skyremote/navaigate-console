// Test helper: the neutral fixture profile (laptop, studio always-on with an
// ssh alias, work restricted to the client-a workload).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveProfile, type Profile } from "../profile/schema";

export const FIXTURE_PROFILE_PATH = fileURLToPath(new URL("../fixtures/profile.json", import.meta.url));

export function fixtureProfile(): Profile {
  return resolveProfile(JSON.parse(readFileSync(FIXTURE_PROFILE_PATH, "utf8"))).profile;
}

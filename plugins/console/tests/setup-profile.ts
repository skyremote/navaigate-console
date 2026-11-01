// Every test runs against the same fixture profile: three neutral machines
// (a laptop, an always-on "Studio" and a restricted "Work" machine) and an owner
// called Sam Example. The server reads it from NAVAIGATE_CONSOLE_PROFILE and the
// browser store is seeded with it, so no test depends on a real person's setup.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { beforeEach } from "vitest";
import { resolveProfile } from "../profile/schema";
import { setProfileState } from "../src/use-profile";

export const FIXTURE_PROFILE_PATH = resolve(process.cwd(), "tests/fixtures/profile.json");
process.env.NAVAIGATE_CONSOLE_PROFILE = FIXTURE_PROFILE_PATH;

export const fixtureProfile = () => resolveProfile(JSON.parse(readFileSync(FIXTURE_PROFILE_PATH, "utf8"))).profile;

// The browser store starts as the private edition, where every feature is on as it always was, so the
// existing tests see the whole Console. Tests of the community picker set their own profile.
beforeEach(() => {
  setProfileState({ profile: { ...fixtureProfile(), edition: "private" }, source: "file", errors: [], path: FIXTURE_PROFILE_PATH, stamp: "fixture" });
});

// The profile as the browser and the setup screen see it: read the resolved
// profile (with where it came from) and save a whole new one. The file itself
// lives outside the repository; see profile/README.md.
import { statSync } from "node:fs";
import { z } from "zod";
import { loadProfile, profilePath, saveProfile } from "./profile/load";
import { profileSchema, type Profile } from "./profile/schema";
import { consoleSectionProblems } from "./lib/profile-console";
import { addressCredentialProblem, secretNameProblem } from "./src/setup-model";

export const profileResultSchema = z.object({
  profile: profileSchema,
  source: z.enum(["defaults", "file"]),
  errors: z.array(z.string()),
  path: z.string(),
  /** Changes whenever the file does; the browser re-reads only when this moves. */
  stamp: z.string(),
});
export type ProfileResult = z.infer<typeof profileResultSchema>;

function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
}

export function profileResult(): ProfileResult {
  const file = profilePath();
  const resolved = loadProfile(file);
  return { profile: resolved.profile, source: resolved.source, errors: [...resolved.errors, ...consoleSectionProblems(resolved.profile)], path: file, stamp: stampOf(file) };
}

/** What the browser sends to save: the whole profile, and the stamp of the file it was loaded from (omitted: no check). */
export const profileSaveInput = z.object({ profile: profileSchema, expectedStamp: z.string().optional() });
export type ProfileSaveInput = z.infer<typeof profileSaveInput>;

/**
 * What must never reach the file whatever sent it: a token typed where a secret's name belongs, or a
 * credential inside an address. The setup screen checks the same things, so this only matters for
 * a caller that skipped the screen. Returns the first problem in plain words, or null.
 */
export function profileSecretProblem(p: Profile): string | null {
  const name = secretNameProblem(p.brain.tokenSecret ?? "");
  if (name) return `brain.tokenSecret: ${name}`;
  const addresses: Array<[string, string | null]> = [
    ["brain.url", p.brain.url],
    ["hosts.fleet", p.hosts.fleet],
    ["hosts.brainMcp", p.hosts.brainMcp],
    ["hosts.brainDb", p.hosts.brainDb],
    ["hosts.hooks", p.hosts.hooks],
    ...p.hosts.bbRemotes.map((v, i): [string, string] => [`hosts.bbRemotes[${i}]`, v]),
    ...p.machines.map((m): [string, string | null] => [`machines.${m.id}.bbUrl`, m.bbUrl]),
  ];
  for (const [where, value] of addresses) {
    if (value === null) continue;
    // Only a credential is refused here: a plain path or host name that is not a web address is allowed.
    const why = addressCredentialProblem(value);
    if (why) return `${where}: ${why}`;
  }
  return null;
}

export function createProfile(onSaved: () => void = () => undefined) {
  return {
    get: (): ProfileResult => profileResult(),
    save: (input: ProfileSaveInput): ProfileResult => {
      const file = profilePath();
      // Another window or process saved since Setup opened: do not overwrite it silently.
      if (input.expectedStamp !== undefined && input.expectedStamp !== stampOf(file)) {
        throw new Error("The profile changed since you opened Setup. Reload and try again.");
      }
      const secret = profileSecretProblem(input.profile);
      if (secret) throw new Error(secret);
      saveProfile(input.profile, file);
      onSaved();
      return profileResult();
    },
  };
}

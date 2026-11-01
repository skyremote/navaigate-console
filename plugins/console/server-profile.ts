// The profile as the browser and the setup screen see it: read the resolved
// profile (with where it came from) and save a whole new one. The file itself
// lives outside the repository; see profile/README.md.
import { statSync } from "node:fs";
import { z } from "zod";
import { loadProfile, profilePath, saveProfile } from "./profile/load";
import { profileSchema } from "./profile/schema";
import { consoleSectionProblems } from "./lib/profile-console";

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

export function createProfile(onSaved: () => void = () => undefined) {
  return {
    get: (): ProfileResult => profileResult(),
    save: (input: ProfileSaveInput): ProfileResult => {
      const file = profilePath();
      // Another window or process saved since Setup opened: do not overwrite it silently.
      if (input.expectedStamp !== undefined && input.expectedStamp !== stampOf(file)) {
        throw new Error("The profile changed since you opened Setup. Reload and try again.");
      }
      saveProfile(input.profile, file);
      onSaved();
      return profileResult();
    },
  };
}

// Shared NavAIgate Console profile: reading and writing the file (server only).
//
// Byte-identical in every plugin that reads the profile; see ./schema.ts.
//
// The file lives outside every repository, so choices survive plugin updates:
//   $NAVAIGATE_CONSOLE_PROFILE, else
//   ${XDG_CONFIG_HOME:-~/.config}/navaigate-console/profile.json
// A missing file means the community defaults. A broken file also means the
// defaults (with the reason in `errors`), and is never overwritten by a read.

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Profile, type ResolvedProfile, profileSchema, resolveProfile } from "./schema";

export const PROFILE_ENV = "NAVAIGATE_CONSOLE_PROFILE";

export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PROFILE_ENV];
  if (override && override.trim() !== "") return override;
  const config = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== "" ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(config, "navaigate-console", "profile.json");
}

let cache: { path: string; mtimeMs: number; size: number; resolved: ResolvedProfile } | null = null;

/** Read and resolve the profile. Cached until the file's mtime or size changes. */
export function loadProfile(path: string = profilePath()): ResolvedProfile {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    cache = null;
    return resolveProfile(undefined);
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.resolved;
  let resolved: ResolvedProfile;
  try {
    resolved = resolveProfile(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    resolved = { ...resolveProfile(undefined), errors: [`could not read ${path}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, resolved };
  return resolved;
}

/**
 * Validate and write the whole profile atomically, readable only by its owner.
 * Uses the same checks as reading (resolveProfile), so a profile the next read
 * would reject is never written over a good one.
 */
export function saveProfile(profile: Profile, path: string = profilePath()): Profile {
  const valid = profileSchema.parse(profile);
  const checked = resolveProfile(valid);
  if (checked.source !== "file" || checked.errors.length > 0) {
    throw new Error(`profile not saved: ${checked.errors.join("; ") || "it does not validate"}`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  cache = null;
  return valid;
}

/** Forget the cached read (tests, or after another process wrote the file). */
export function resetProfileCache(): void {
  cache = null;
}

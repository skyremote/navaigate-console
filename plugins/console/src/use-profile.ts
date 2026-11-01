// The profile in the browser: one cached copy that every component reads.
//
// `useProfile()` re-renders when the profile changes; `getProfile()` is the same
// value for plain functions. The first value is the community defaults, then the
// server's copy replaces it. The copy is re-read when the window gains focus and
// when the server says the file changed (its `stamp`), never on a timer.
import { useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { COMMUNITY_DEFAULTS, resolveProfile, type Profile } from "../profile/schema";
import type { rpcContract } from "../server";

export type ProfileResult = { profile: Profile; source: "defaults" | "file"; errors: string[]; path: string; stamp: string };
export type ProfileState = { profile: Profile; source: "defaults" | "file"; errors: string[]; path: string | null; stamp: string | null; loaded: boolean };

// The last profile the server returned is kept in localStorage, so a reload draws
// the owner's machines at once instead of one frame of community defaults. The
// profile holds no secrets. `loaded` still means "the server has answered".
const CACHE_KEY = "navaigate-console:profile";

function readCached(): Profile | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const res = resolveProfile(JSON.parse(raw));
    return res.source === "file" ? res.profile : null;
  } catch {
    return null;
  }
}

function writeCached(profile: Profile, source: "defaults" | "file") {
  try {
    if (typeof localStorage === "undefined") return;
    if (source === "file") localStorage.setItem(CACHE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage full or blocked: the next load reads the server */
  }
}

const initial = (): ProfileState => {
  const cached = readCached();
  return { profile: cached ?? COMMUNITY_DEFAULTS, source: cached ? "file" : "defaults", errors: [], path: null, stamp: null, loaded: false };
};

let state: ProfileState = initial();
const listeners = new Set<() => void>();

function publish(next: ProfileState) {
  state = next;
  for (const l of listeners) l();
}

/** The current profile, for code that is not a component. */
export function getProfile(): Profile {
  return state.profile;
}

export function getProfileState(): ProfileState {
  return state;
}

/** Replace the cached profile (the server's answer, or a test's fixture). */
export function setProfileState(next: Partial<ProfileState> & { profile: Profile }) {
  publish({ ...state, loaded: true, ...next });
}

/** Back to the community defaults, as before the first read. */
export function resetProfileState() {
  publish({ profile: COMMUNITY_DEFAULTS, source: "defaults", errors: [], path: null, stamp: null, loaded: false });
  writeCached(COMMUNITY_DEFAULTS, "defaults");
}

type Result = ProfileResult;
let inFlight: Promise<void> | null = null;

/** Take a profile the server just returned (a refresh, or the answer to a save). */
export function adoptProfile(res: Result) {
  if (!res || !res.profile) return;
  if (state.loaded && res.stamp === state.stamp) return;
  publish({ profile: res.profile, source: res.source, errors: res.errors, path: res.path, stamp: res.stamp, loaded: true });
  writeCached(res.profile, res.source);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

type Caller = { call: (name: "profile_get") => Promise<Result> };

/** Read the profile once at a time; failures keep the copy already held. */
export function refreshProfile(rpc: Caller): Promise<void> {
  if (!inFlight) {
    inFlight = rpc
      .call("profile_get")
      .then(adoptProfile, () => undefined)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

let watchers = 0;
let onFocus: (() => void) | null = null;

/** Keeps the cached profile fresh: reads it once, again on window focus, and when the server says it changed. Mount it once (see profile-loader.tsx). */
export function useProfileLoader(): void {
  const rpc = useRpc<typeof rpcContract>() as unknown as Caller;
  useEffect(() => {
    if (!state.loaded) void refreshProfile(rpc);
    watchers += 1;
    if (watchers === 1) {
      onFocus = () => void refreshProfile(rpc);
      window.addEventListener("focus", onFocus);
    }
    return () => {
      watchers -= 1;
      if (watchers === 0 && onFocus) {
        window.removeEventListener("focus", onFocus);
        onFocus = null;
      }
    };
  }, [rpc]);
  useRealtime("profile", () => void refreshProfile(rpc));
}

/** The profile state, with `loaded` false until the server has answered. Needs no runtime: tests seed it with setProfileState. */
export function useProfileState(): ProfileState {
  return useSyncExternalStore(subscribe, getProfileState, getProfileState);
}

/** The resolved profile; re-renders when it changes. */
export function useProfile(): Profile {
  return useProfileState().profile;
}

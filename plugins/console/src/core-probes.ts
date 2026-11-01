// What the running bb can do, as the set of core-ledger ids it passes. The server
// answers the release-build and worktree probes (core_probes); the browser adds
// the native-history SDK member. The last answer is kept in localStorage so a
// reload does not flicker. The private edition never reads this (see features-enabled.ts).
import { useEffect, useSyncExternalStore } from "react";
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { ledgerIdsPassed, NO_PROBES, type Probes } from "./features-enabled";

type Found = { releaseBuild: boolean; nativeHistory: boolean; cleanupSafety: boolean; continuationIntent: boolean };
const CACHE_KEY = "navaigate-console:core-probes";
const NONE: Found = { releaseBuild: false, nativeHistory: false, cleanupSafety: false, continuationIntent: false };

function readCached(): Found | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Found>;
    return { releaseBuild: v.releaseBuild === true, nativeHistory: v.nativeHistory === true, cleanupSafety: v.cleanupSafety === true, continuationIntent: v.continuationIntent === true };
  } catch {
    return null;
  }
}

let found: Found | null = readCached();
let passed: Probes = found ? ledgerIdsPassed(found) : NO_PROBES;
const listeners = new Set<() => void>();

/** The core changes the running bb passed; empty until the first answer (or the last session's, from the cache). */
export function getPassedProbes(): Probes {
  return passed;
}

/** Record what was found. Tests call this directly. */
export function setCoreFound(next: Partial<Found>) {
  found = { ...NONE, ...(found ?? {}), ...next };
  passed = ledgerIdsPassed(found);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(CACHE_KEY, JSON.stringify(found));
  } catch {
    /* storage full or blocked: the next load probes again */
  }
  for (const l of listeners) l();
}

export function resetCoreProbes() {
  found = null;
  passed = NO_PROBES;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear */
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function usePassedProbes(): Probes {
  return useSyncExternalStore(subscribe, getPassedProbes, getPassedProbes);
}

type Caller = { call: (name: "core_probes") => Promise<{ releaseBuild: boolean; cleanupSafety: boolean }> };

/** Mounted once (see profile-loader.tsx): asks the server, and checks the browser SDK. */
export function useCoreProbeLoader(): void {
  const rpc = useRpc() as unknown as Caller;
  const sdk = useSdk() as unknown as { experimental_nativeHistory?: unknown };
  useEffect(() => {
    let live = true;
    rpc.call("core_probes").then(
      (r) => {
        if (live) setCoreFound({ releaseBuild: r.releaseBuild, cleanupSafety: r.cleanupSafety, nativeHistory: sdk.experimental_nativeHistory !== undefined && sdk.experimental_nativeHistory !== null, continuationIntent: r.releaseBuild });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, sdk]);
}

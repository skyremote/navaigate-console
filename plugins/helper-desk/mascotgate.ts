// Whether the mascots are switched off in the Console's setup picker (feature EXTRA-C). The server answers the
// "picks" call; the answer is kept here and in this window's localStorage (so the next load starts right), and
// shared with every mounted card through useSyncExternalStore. Until the server has answered, the last answer is
// used; with none, the mascots show as they always did.
import { useEffect, useSyncExternalStore } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { MASCOTS_FEATURE } from "./lib/picks";
import type { rpcContract } from "./server";

export const GATE_STORAGE_KEY = "bb-plugin-helper-desk:mascots-off:v1";

function read(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(GATE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let off: boolean | null = null;
const listeners = new Set<() => void>();

export function getMascotsOff(): boolean {
  off ??= read();
  return off;
}

export function setMascotsOff(next: boolean) {
  off = next;
  try {
    window.localStorage.setItem(GATE_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Storage blocked: the answer still holds for this window.
  }
  for (const l of listeners) l();
}

/** Forgets the held answer and re-reads storage, for tests. */
export function reloadMascotGate() {
  off = read();
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when the owner has switched the mascots off: cards then show a still mark and offer no choice. */
export function useMascotsOff(): boolean {
  return useSyncExternalStore(subscribe, getMascotsOff, getMascotsOff);
}

/** Asks the server once on mount which features are off. Call it from each panel that draws mascots. */
export function useMascotGate() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    let live = true;
    rpc.call("picks", null).then(
      (answer) => {
        if (live) setMascotsOff(answer.picksOff.includes(MASCOTS_FEATURE));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc]);
}

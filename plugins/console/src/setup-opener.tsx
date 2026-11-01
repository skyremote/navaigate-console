// Opens the setup screen once per session on a first run: the community edition,
// a profile the server has answered for, and setup never finished. It waits for
// the server's answer (`loaded`), so the private edition never sees it and the
// community defaults are never mistaken for a first run.
import { useEffect } from "react";
import { shouldOpenSetup } from "./features-enabled";
import { openSetup } from "./setup-nav";
import { useProfileState } from "./use-profile";

const SESSION_KEY = "navaigate-console:setup-opened";
let openedThisLoad = false;

function alreadyOpened(): boolean {
  if (openedThisLoad) return true;
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function markOpened() {
  openedThisLoad = true;
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    /* the module flag still holds for this load */
  }
}

/** Test hook: forget that setup was opened. */
export function resetSetupOpener() {
  openedThisLoad = false;
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function SetupOpener() {
  const state = useProfileState();
  const first = shouldOpenSetup(state);
  useEffect(() => {
    if (!first || alreadyOpened()) return;
    markOpened();
    openSetup();
  }, [first]);
  return null;
}

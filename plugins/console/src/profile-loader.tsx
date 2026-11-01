// Invisible: keeps the profile and the core-probe caches fresh for every component
// (see use-profile.ts and core-probes.ts), and opens the first-run setup once.
import { useCoreProbeLoader } from "./core-probes";
import { useProfileLoader } from "./use-profile";
import { SetupOpener } from "./setup-opener";

export function ProfileLoader() {
  useProfileLoader();
  useCoreProbeLoader();
  return <SetupOpener />;
}

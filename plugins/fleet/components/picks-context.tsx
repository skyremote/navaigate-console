import { createContext, useContext } from "react";
import { isOff, type FleetGatedId } from "../lib/picks";

/** The Fleet feature ids the owner has switched off, as the server sent them. Empty until given: nothing is hidden. */
export const PicksOffContext = createContext<readonly string[]>([]);

/** True when the feature is switched off in the setup picker; the control then renders nothing. */
export function useFeatureOff(id: FleetGatedId): boolean {
  return isOff(useContext(PicksOffContext), id);
}

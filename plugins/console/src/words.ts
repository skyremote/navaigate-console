// The same words in the browser, from the cached profile (see use-profile.ts).
// A component that shows them calls useProfile() once so it redraws when the
// profile arrives.
import { alwaysOnLabel, alwaysOnPhrase, labelPhrase, ownerName, upperFirst } from "../lib/profile-text";
import { machineLabel } from "../profile/schema";
import { getProfile } from "./use-profile";

/** The always-on Mac in a sentence: "the M9", "Studio", "the always-on Mac". */
export const mac = () => alwaysOnPhrase(getProfile());
/** The same at the start of a sentence. */
export const Mac = () => upperFirst(mac());
/** The always-on Mac's label on its own: "M9", "Studio". */
export const macLabel = () => alwaysOnLabel(getProfile());
/** The owner's name, or "the owner". */
export const owner = () => ownerName(getProfile());

/** What a machine id is called on screen (its label in the profile); an unknown id shows as it is. */
export const machineName = (id: string | null | undefined) => machineLabel(getProfile(), id);
/** A machine in a sentence: "the M9" for a short code, the label for a name. */
export const machinePhraseOf = (id: string | null | undefined) => labelPhrase(machineName(id));

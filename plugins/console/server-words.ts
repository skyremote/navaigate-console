// Words the server puts in messages and prompts, taken from the profile: the
// always-on Mac as "the M9" or "Studio" (or neutral wording), and the owner.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { loadProfile } from "./profile/load";
import { alwaysOnMachine, machineById, machineLabel } from "./profile/schema";
import { consoleSection, expandProfilePath, handoffOn } from "./lib/profile-console";
import { alwaysOnLabel, alwaysOnPhrase, machineIdsSorted, ownerName, upperFirst } from "./lib/profile-text";

/** The always-on Mac in a sentence: "the M9", "Studio", "the always-on Mac". */
export const mac = () => alwaysOnPhrase(loadProfile().profile);
/** The same at the start of a sentence. */
export const Mac = () => upperFirst(mac());
/** The always-on Mac's label on its own: "M9", "Studio". */
export const macLabel = () => alwaysOnLabel(loadProfile().profile);
/** The owner's name, or "the owner". */
export const owner = () => ownerName(loadProfile().profile);

/** SSH alias of the always-on Mac, or "" when the profile has none (remote features stay off). */
export const alwaysOnSsh = () => alwaysOnMachine(loadProfile().profile)?.sshAlias ?? "";
/** The hand-over helper script, with "~" expanded, or "" when none is configured. */
export const handoffScriptPath = () => expandProfilePath(loadProfile().profile, consoleSection(loadProfile().profile).handoffScript, homedir()) ?? "";

/** Why moving chats to the always-on Mac cannot run, as a plain sentence; null when it can. */
export const handoffRefusal = (): string | null =>
  handoffOn(loadProfile().profile) ? null : "Moving a chat needs an always-on Mac with an SSH alias (or a hand-over script) in your profile. Add one in Setup, under Your Macs.";

/** Stops early, before anything is stopped, pushed or run, when there is no always-on Mac to reach. */
export function requireHandoff(): void {
  const why = handoffRefusal();
  if (why) throw new Error(why);
}

/**
 * The hand-over script, only when it is safe to run: set, an existing regular file, owned by the current
 * user, and not writable by the group or anyone else. Otherwise a plain refusal.
 */
export function trustedHandoffScript(): string {
  const file = handoffScriptPath();
  if (file === "") throw new Error("No hand-over script is set in your profile (plugins.console.handoffScript), so nothing can be handed over from here.");
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new Error(`The hand-over script ${file} does not exist, so it was not run.`);
  }
  if (!st.isFile()) throw new Error(`The hand-over script ${file} is not a regular file, so it was not run.`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`The hand-over script ${file} is not owned by you, so it was not run.`);
  if ((st.mode & 0o022) !== 0) throw new Error(`The hand-over script ${file} can be changed by other users (group or world writable), so it was not run. Remove that permission first.`);
  return file;
}

/** Every machine id in the profile, alphabetically: what fleet-wide reads loop over. */
export const machineKeys = () => machineIdsSorted(loadProfile().profile);
/** Whether the profile knows this machine id. */
export const knownMachine = (id: string | null | undefined) => machineById(loadProfile().profile, id) !== null;

/** What a greeting to the owner would say: their name, or "there". */
export const ownerHello = () => loadProfile().profile.owner.name.trim() || "there";

/** What a machine id is called on screen (its label in the profile); an unknown id shows as it is. */
export const machineName = (id: string | null | undefined) => machineLabel(loadProfile().profile, id);

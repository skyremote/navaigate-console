// Words the interface uses for the profile's machines and owner. Pure and
// browser-safe: the server and the browser both import it.
//
// A machine whose label looks like a short code ("M9") reads as "the M9" in a
// sentence; a named machine ("Studio") reads as its name. With no always-on
// machine in the profile the text falls back to neutral wording.
import { alwaysOnMachine, machineById, machineLabel, machineOrder, type Profile } from "../profile/schema";

export const NEUTRAL_ALWAYS_ON = "the always-on Mac";

const CODE_LIKE = /^[A-Za-z]\d+$/;

/** "the M9" for a short-code label, the label itself for a name. */
export function labelPhrase(label: string): string {
  return CODE_LIKE.test(label) ? `the ${label}` : label;
}

export function upperFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** How a sentence names a machine: "the M9", "Studio", or the bare id when the profile does not know it. */
export function machinePhrase(p: Profile, id: string | null | undefined): string {
  return labelPhrase(machineLabel(p, id));
}

/** The id of the machine this profile sits on (the explicit one, else the first): the browser's default before the board says. */
export function homeMachineId(p: Profile): string {
  return (machineById(p, p.thisMachine) ?? p.machines[0])?.id ?? "";
}

/** The always-on machine's id, or null. */
export function alwaysOnId(p: Profile): string | null {
  return alwaysOnMachine(p)?.id ?? null;
}

/** The always-on machine's label ("M9", "Studio"), or neutral wording. */
export function alwaysOnLabel(p: Profile): string {
  return alwaysOnMachine(p)?.label ?? "Always-on Mac";
}

/** The always-on machine in a sentence: "the M9", "Studio", or "the always-on Mac". */
export function alwaysOnPhrase(p: Profile): string {
  const m = alwaysOnMachine(p);
  return m ? labelPhrase(m.label) : NEUTRAL_ALWAYS_ON;
}

/** The machine this install runs on, in a sentence. */
export function machineKnown(p: Profile, id: string | null | undefined): boolean {
  return machineById(p, id) !== null;
}

/** The owner's first name for prompts and copy, or "the owner" when the profile has none. */
export function ownerName(p: Profile): string {
  return p.owner.name.trim() || "the owner";
}

/** Possessive of the owner's name: "Sam's", or "the owner's". */
export function ownerPossessive(p: Profile): string {
  return `${ownerName(p)}'s`;
}

/** Machine ids in alphabetical order: the order fleet-wide reads are issued and listed in. */
export function machineIdsSorted(p: Profile): string[] {
  return machineOrder(p)
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

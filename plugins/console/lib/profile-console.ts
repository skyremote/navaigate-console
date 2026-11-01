// Console-only profile keys, kept under `plugins.console` in the profile file and
// validated here (the shared schema stays generic). Pure and browser-safe.
//
// Every key defaults to null: with none set, the features that need them (moving
// a chat to the always-on Mac, NAS-aware starts, the daily brief) stay off.
import { z } from "zod";
import { alwaysOnMachine, expandHome, type Profile, type ProfileMachine } from "../profile/schema";

const nullableText = z.string().max(400).nullable();

export const consoleSectionSchema = z.object({
  /** Where the shared NAS folder is linked on this Mac (e.g. "~/Shared"), when it is not the mount itself. */
  nasLink: nullableText.default(null),
  /** bb project names to start NAS work in at home and when away. */
  nasProject: nullableText.default(null),
  nasAwayProject: nullableText.default(null),
  /** The helper script that answers "home or away" and hands chats and files to the always-on Mac. */
  handoffScript: nullableText.default(null),
  /** The file that script records handed-over chats in. */
  handoffFile: nullableText.default(null),
  /** Folder name (inside the NAS) the generated daily brief is written to, and the name of the bb automation that makes it (its project id is `ids.projects.dailyBrief`). */
  dailyBriefDir: nullableText.default(null),
  dailyBriefAutomation: nullableText.default(null),
  /** Short text under a machine in the new-work picker, by machine id. */
  machineHints: z.record(z.string().max(40), z.string().max(200)).default({}),
  /** What the inbox sort can file an email under: name to a plain description of what belongs there. */
  ventures: z.record(z.string().max(60), z.object({ what: z.string().max(600) })).default({
    Work: { what: "Paid work, clients, projects, colleagues, business admin and tools" },
    Personal: { what: "Family, friends, home, personal bills, health, holidays and personal travel" },
    Other: { what: "Anything that fits none of the other options, such as vendors, tools and general enquiries" },
  }),
});
export type ConsoleSection = z.infer<typeof consoleSectionSchema>;

const EMPTY: ConsoleSection = consoleSectionSchema.parse({});

type Checked = { section: ConsoleSection; problems: string[] };
const checkedCache = new WeakMap<object, Checked>();

/** Reads the section key by key, so one bad key falls back to its own default and the valid ones are kept. Unknown keys are ignored. */
function checkSection(raw: unknown): Checked {
  if (raw === undefined || raw === null) return { section: EMPTY, problems: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { section: EMPTY, problems: ["plugins.console: must be an object, so every Console profile key is off"] };
  const cached = checkedCache.get(raw);
  if (cached) return cached;
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const key of Object.keys(consoleSectionSchema.shape) as (keyof ConsoleSection)[]) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = consoleSectionSchema.shape[key].safeParse(value);
    if (parsed.success) values[key] = parsed.data;
    else problems.push(`plugins.console.${key}: ${parsed.error.issues[0]?.message ?? "not valid"}, so this key is ignored`);
  }
  const result = { section: consoleSectionSchema.parse(values), problems };
  checkedCache.set(raw, result);
  return result;
}

/** The Console's own section of the profile; a missing section reads as off, and a bad key reads as off on its own. */
export function consoleSection(p: Profile): ConsoleSection {
  return checkSection(p.plugins.console).section;
}

/** Plain sentences naming each key of the section that is not valid (empty when all are). */
export function consoleSectionProblems(p: Profile): string[] {
  return checkSection(p.plugins.console).problems;
}

/** Whether chats can be handed to an always-on Mac: one is configured with a way to reach it. */
export function handoffOn(p: Profile): boolean {
  const m = alwaysOnMachine(p);
  return m !== null && (m.sshAlias !== null || consoleSection(p).handoffScript !== null);
}

/** A path from the profile with "~" expanded against the given home folder. */
export function expandProfilePath(p: Profile, value: string | null, osHome: string): string | null {
  return value === null ? null : expandHome(value, homeOf(p, osHome));
}

/** This Mac's home folder: the profile's, or the operating system's when the profile says "~". */
export function homeOf(p: Profile, osHome: string): string {
  const home = p.paths.home;
  return home === "~" || home.startsWith("~/") ? expandHome(home, osHome) : home;
}

/** A machine's home folder, or null when the profile does not know it. */
export function machineHome(m: ProfileMachine | null): string | null {
  return m?.home ?? null;
}

/** The NAS as this Mac and the always-on Mac each see it: [local link, share], or null when either is unknown. */
export function nasPair(p: Profile, osHome: string): { link: string; nas: string } | null {
  const nas = p.paths.nas;
  const link = expandProfilePath(p, consoleSection(p).nasLink, osHome);
  return nas && link ? { link: link.replace(/\/+$/, ""), nas: nas.replace(/\/+$/, "") } : null;
}

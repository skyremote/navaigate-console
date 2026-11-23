// The Local loadout on disk: which of the user's own skills (~/.claude/skills/<name>/SKILL.md) and agents
// (~/.claude/agents/<name>.md) a Local chat on the Claude Code harness gets. They are given as links in the
// Local settings folder (<Local config>/skills/<name>, <Local config>/agents/<name>.md), which every Local
// chat on Claude Code shares, so one loadout serves them all.
//
// Rules this file keeps:
//   - The user's own folders are only read: nothing in them is moved, copied, edited or deleted.
//   - Only links this plugin made (its manifest) are ever removed, and only when the path is still a link
//     to the very target it made; removing a link never follows it.
//   - Nothing is written when a link folder (or the Local settings folder) is itself a link: a linked
//     skills folder could lead into the user's real one.
//   - The listing returns names and sizes only, never a file's contents, never throws, and is bounded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defaultChoice, loadoutCost, safeItemName, shareOf, type FirstPromptReading, type LoadoutAgent, type LoadoutChoice, type LoadoutListing, type LoadoutSkill, type MeasuredShare } from "./src/local-loadout";

/** Bounds on one listing: entries read per folder, time for the whole listing, bytes read from the top of a file. */
export const LOADOUT_SCAN_MAX_ENTRIES = 2_000;
export const LOADOUT_SCAN_MAX_MS = 2_000;
export const FRONT_MATTER_MAX_BYTES = 16_384;
/** How long a listing is kept before the folders are read again. */
export const LOADOUT_TTL_MS = 60_000;

export const realSkillsDir = (home: string) => path.join(home, ".claude", "skills");
export const realAgentsDir = (home: string) => path.join(home, ".claude", "agents");
/** Where the loadout is kept: per machine, in this plugin's data folder (not the profile, which can travel between Macs). */
export const loadoutFile = (dataDir: string = process.env.BB_DATA_DIR || path.join(os.homedir(), ".bb")) => path.join(dataDir, "plugins", "navaigate-skin", "local-loadout.json");

/**
 * Where bb's measured share is kept: the last FIRST_PROMPT_KEEP first requests of Local chats on Claude Code on
 * this Mac, numbers and a time only (no text, no answer, no chat id, no path). Written only by the Local route.
 */
export const firstPromptFile = (dataDir: string = process.env.BB_DATA_DIR || path.join(os.homedir(), ".bb")) => path.join(dataDir, "plugins", "navaigate-skin", "local-first-prompt.json");
export const FIRST_PROMPT_KEEP = 5;

/* ------------------------------- front matter ------------------------------ */

/** The lengths of name, description and tools in a file's YAML front matter (block scalars included); null when it has none. */
export function frontMatter(text: string): { name: string | null; descChars: number | null; tools: string | null } | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const fm = lines.slice(1, end);
  const value = (key: string): string | null => {
    const i = fm.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (i < 0) return null;
    const first = fm[i].replace(new RegExp(`^${key}\\s*:\\s*`), "");
    if (/^[|>][+-]?\s*$/.test(first)) {
      const block: string[] = [];
      for (let j = i + 1; j < fm.length && (/^\s+/.test(fm[j]) || fm[j] === ""); j++) block.push(fm[j].trim());
      return block.join(first.startsWith(">") ? " " : "\n").trim();
    }
    return first.replace(/^(["'])(.*)\1$/, "$2").trim();
  };
  const desc = value("description");
  return { name: value("name"), descChars: desc === null ? null : desc.length, tools: value("tools") };
}

async function readHead(file: string): Promise<string> {
  const h = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(FRONT_MATTER_MAX_BYTES);
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await h.close().catch(() => undefined);
  }
}

/* --------------------------------- listing --------------------------------- */

type Limits = { maxEntries?: number; maxMs?: number; now?: () => number };

/** Reads one folder's entries within the bounds; `false` in `complete` when a bound stopped it. */
async function entriesOf(dir: string, deadline: number, maxEntries: number, now: () => number): Promise<{ names: Array<{ name: string; dirent: fs.Dirent }>; complete: boolean }> {
  const out: Array<{ name: string; dirent: fs.Dirent }> = [];
  let handle: fs.Dir;
  try {
    handle = await fs.promises.opendir(dir);
  } catch {
    return { names: out, complete: true }; // a missing folder holds nothing
  }
  let complete = true;
  try {
    for (let read = 0; ; read++) {
      if (read >= maxEntries || now() > deadline) {
        complete = false;
        break;
      }
      const d = await handle.read();
      if (!d) break;
      if (safeItemName(d.name)) out.push({ name: d.name, dirent: d });
    }
  } catch {
    complete = false;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { names: out, complete };
}

/**
 * The user's skills and agents, with sizes only. A skill is a folder (or a link to one) holding a SKILL.md;
 * an agent is a .md file with front matter that has a description (Claude Code lists no other). Read-only,
 * never throws; missing folders give empty lists. `others` counts what someone put in the Local settings
 * folder by hand (not in `manifest`), which Claude Code lists too.
 */
export async function listLoadout(home: string | null, opts: Limits & { config?: string | null; manifest?: Record<string, string> } = {}): Promise<LoadoutListing> {
  const empty: LoadoutListing = { skills: [], agents: [], complete: false, others: { skills: 0, agents: 0 } };
  if (!home) return empty;
  try {
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.maxMs ?? LOADOUT_SCAN_MAX_MS);
    const maxEntries = opts.maxEntries ?? LOADOUT_SCAN_MAX_ENTRIES;
    let complete = true;
    const skills: LoadoutSkill[] = [];
    const sk = await entriesOf(realSkillsDir(home), deadline, maxEntries, now);
    complete &&= sk.complete;
    for (const { name, dirent } of sk.names) {
      if (now() > deadline) {
        complete = false;
        break;
      }
      if (!(dirent.isDirectory() || dirent.isSymbolicLink())) continue;
      const file = path.join(realSkillsDir(home), name, "SKILL.md");
      try {
        const st = await fs.promises.stat(file); // follows links, as Claude Code does
        if (!st.isFile()) continue;
        let descChars: number | null = null;
        try {
          descChars = frontMatter(await readHead(file))?.descChars ?? null;
        } catch {}
        skills.push({ name, descChars, bodyChars: st.size });
      } catch {}
    }
    const agents: LoadoutAgent[] = [];
    const ag = await entriesOf(realAgentsDir(home), deadline, maxEntries, now);
    complete &&= ag.complete;
    for (const { name, dirent } of ag.names) {
      if (now() > deadline) {
        complete = false;
        break;
      }
      if (!name.endsWith(".md") || !(dirent.isFile() || dirent.isSymbolicLink())) continue;
      const file = path.join(realAgentsDir(home), name);
      try {
        if (!(await fs.promises.stat(file)).isFile()) continue;
        const fm = frontMatter(await readHead(file));
        if (!fm || fm.descChars === null) continue;
        const base = name.slice(0, -3);
        if (!safeItemName(base)) continue;
        agents.push({ name: base, listChars: (fm.name ?? base).length + fm.descChars + (fm.tools ?? "*").length + 14 });
      } catch {}
    }
    const others = { skills: 0, agents: 0 };
    if (opts.config) {
      const mine = new Set(Object.keys(opts.manifest ?? {}));
      for (const kind of ["skills", "agents"] as const) {
        const dir = path.join(opts.config, kind);
        const got = await entriesOf(dir, deadline, maxEntries, now);
        others[kind] = got.names.filter((e) => !mine.has(path.join(dir, e.name)) && (kind === "skills" || e.name.endsWith(".md"))).length;
      }
    }
    const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { skills: skills.sort(byName), agents: agents.sort(byName), complete, others };
  } catch {
    return empty;
  }
}

/* ---------------------------------- store ---------------------------------- */

export const loadoutChoiceSchema = z.object({
  skills: z.array(z.string().min(1).max(200)).max(5_000),
  agents: z.array(z.string().min(1).max(200)).max(5_000),
  descriptions: z.boolean(),
  allTools: z.boolean(),
  thinkLess: z.boolean(),
});
const storedSchema = z.object({ v: z.literal(1), choice: loadoutChoiceSchema.nullable(), links: z.record(z.string(), z.string()) });
export type StoredLoadout = z.infer<typeof storedSchema>;
const EMPTY: StoredLoadout = { v: 1, choice: null, links: {} };

/** The stored loadout; an empty one when the file is missing or unreadable. Never throws. */
export function readLoadout(file: string): StoredLoadout {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}
/** Written whole, to a temporary file first, then renamed over the old one. */
export function writeLoadout(file: string, stored: StoredLoadout): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 1) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/* ------------------------------ measured share ----------------------------- */

const count = z.number().int().nonnegative().max(10_000_000);
const readingSchema = z.object({ at: z.number().int().nonnegative(), input: count, tools: count, trimmed: z.boolean(), loadout: count, user: count }).strict();
const firstPromptsSchema = z.object({ v: z.literal(1), readings: z.array(readingSchema).max(50) }).strict();

/** The kept readings, oldest first; none when the file is missing or unreadable. Never throws. */
export function readFirstPrompts(file: string): FirstPromptReading[] {
  try {
    const parsed = firstPromptsSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data.readings : [];
  } catch {
    return [];
  }
}
/**
 * Keeps one reading, with the FIRST_PROMPT_KEEP before it, when it gives a share (shareOf); a nonsense reading
 * (nothing read, a share below the floor) is not kept. Written whole, readable by the user alone.
 * Returns the share it gives, or null when nothing was written. Never throws.
 */
export function recordFirstPrompt(file: string, reading: FirstPromptReading): number | null {
  const parsed = readingSchema.safeParse(reading);
  if (!parsed.success) return null;
  const share = shareOf(parsed.data);
  if (share === null) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const readings = [...readFirstPrompts(file), parsed.data].slice(-FIRST_PROMPT_KEEP);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, readings }) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return share;
  } catch {
    return null;
  }
}
/** bb's share from the latest kept reading that gives one; null while there is none. */
export function measuredShare(file: string): MeasuredShare | null {
  const readings = readFirstPrompts(file);
  for (let i = readings.length - 1; i >= 0; i--) {
    const r = readings[i];
    const bb = shareOf(r);
    if (bb !== null) return { bb, at: r.at, tools: r.tools, trimmed: r.trimmed };
  }
  return null;
}

/* ---------------------------------- links ---------------------------------- */

export type ApplyResult = {
  ok: boolean;
  reason?: string;
  linked: { skills: number; agents: number };
  /** Items not linked, and why: a file of someone else's is in the way, or the system refused the link. */
  skipped: Array<{ kind: "skill" | "agent"; name: string; why: "taken" | "failed" }>;
};
const isRealDir = (p: string): boolean => {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};
const linkTarget = (p: string): string | null => {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null;
  } catch {
    return null;
  }
};
const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The entries of a stored link list that can be the plugin's own: an absolute, normalised path whose folder
 * is, on disk, exactly the Local settings folder's skills/ or agents/ (real paths compared, so a link or a
 * ".." cannot lead anywhere else), with a safe last part (agents end in .md). Anything else in the file (a
 * hand-edited or damaged list) is ignored, so nothing outside those two folders is ever removed.
 */
export function ownLinks(config: string, links: Record<string, string>): Record<string, string> {
  const real = (p: string): string | null => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const skills = real(path.join(config, "skills"));
  const agents = real(path.join(config, "agents"));
  const out: Record<string, string> = {};
  for (const [p, target] of Object.entries(links)) {
    if (typeof target !== "string" || !path.isAbsolute(p) || path.normalize(p) !== p) continue;
    const name = path.basename(p);
    const parent = real(path.dirname(p));
    if (parent === null) continue;
    if (skills !== null && parent === skills && safeItemName(name)) out[p] = target;
    else if (agents !== null && parent === agents && name.endsWith(".md") && safeItemName(name.slice(0, -3))) out[p] = target;
  }
  return out;
}

/** Why the Local folder may not be written: a link, or a folder that is the home folder or inside ~/.claude. */
export function localRootProblem(home: string, localRoot: string): string | null {
  try {
    if (fs.lstatSync(localRoot).isSymbolicLink()) return "the Local folder (~/.claude-local) is a link, so nothing is written through it";
  } catch {
    return null; // not there yet: it is made as a real folder
  }
  try {
    const root = fs.realpathSync(localRoot);
    const h = fs.realpathSync(home);
    let main: string | null = null;
    try {
      main = fs.realpathSync(path.join(home, ".claude"));
    } catch {}
    if (root === h || (main !== null && (root === main || root.startsWith(main + path.sep)))) return "the Local folder (~/.claude-local) is your home folder or your main ~/.claude, so nothing is written there";
  } catch {
    return "the Local folder could not be read";
  }
  return null;
}

/**
 * Makes the links of a choice in the Local settings folder and removes the plugin's own links that are no
 * longer chosen. Idempotent. Never touches the user's real folders, never removes a path it did not make
 * (its own list, only inside the Local skills/ and agents/ folders, still a link, same target) and never writes
 * through a linked folder. The plugin's own links that go are removed first, so one that differs only in case
 * from a new one never blocks it. The list is saved with the links about to be made BEFORE they are made, so an
 * interrupted run never leaves an unknown link. Where the system refuses links (some Windows setups), the item
 * is reported and left out: nothing is copied.
 */
export function applyLoadoutLinks(input: { home: string; config: string; localRoot: string; file: string; choice: LoadoutChoice; listing: LoadoutListing; symlink?: (target: string, p: string) => void }): ApplyResult {
  const none: ApplyResult = { ok: false, linked: { skills: 0, agents: 0 }, skipped: [] };
  const symlink = input.symlink ?? ((target: string, p: string) => fs.symlinkSync(target, p));
  const rootProblem = localRootProblem(input.home, input.localRoot);
  if (rootProblem) return { ...none, reason: rootProblem };
  // The Local settings folder must be a real folder inside the Local folder (never a link to ~/.claude).
  if (!isRealDir(input.config)) return { ...none, reason: "the Local settings folder is missing or is a link, so the loadout is not applied" };
  try {
    const root = fs.realpathSync(input.localRoot);
    if (!fs.realpathSync(input.config).startsWith(root + path.sep)) return { ...none, reason: "the Local settings folder is not inside the Local folder, so the loadout is not applied" };
  } catch {
    return { ...none, reason: "the Local folder could not be read, so the loadout is not applied" };
  }
  const dirs = { skill: path.join(input.config, "skills"), agent: path.join(input.config, "agents") };
  for (const d of Object.values(dirs)) {
    if (exists(d) && !isRealDir(d)) return { ...none, reason: `${path.basename(d)} in the Local settings folder is a link or a file, so the loadout leaves it as it is` };
  }
  try {
    for (const d of Object.values(dirs)) if (!exists(d)) fs.mkdirSync(d, { mode: 0o700 });
  } catch (e) {
    return { ...none, reason: `the Local settings folder could not be written (${e instanceof Error ? e.message : String(e)})` };
  }
  const stored = readLoadout(input.file);
  const manifest: Record<string, string> = ownLinks(input.config, stored.links);
  // What the choice asks for, from names the listing holds (never a name from anywhere else).
  const wanted = new Map<string, { kind: "skill" | "agent"; name: string; target: string }>();
  const skills = new Set(input.choice.skills);
  const agents = new Set(input.choice.agents);
  for (const s of input.listing.skills) if (skills.has(s.name) && safeItemName(s.name)) wanted.set(path.join(dirs.skill, s.name), { kind: "skill", name: s.name, target: path.join(realSkillsDir(input.home), s.name) });
  for (const a of input.listing.agents) if (agents.has(a.name) && safeItemName(a.name)) wanted.set(path.join(dirs.agent, `${a.name}.md`), { kind: "agent", name: a.name, target: path.join(realAgentsDir(input.home), `${a.name}.md`) });

  // First, the plugin's own links that go (not wanted, or wanted to another target): only a link whose target
  // is still the one recorded; one changed by someone else is no longer counted as the plugin's.
  for (const [p, target] of Object.entries(manifest)) {
    if (wanted.get(p)?.target === target && linkTarget(p) === target) continue;
    if (linkTarget(p) === target) {
      try {
        fs.unlinkSync(p); // the link itself; unlink never follows it
      } catch {
        continue; // kept in the list, tried again next time
      }
    }
    delete manifest[p];
  }
  const skipped: ApplyResult["skipped"] = [];
  const create: Array<[string, { kind: "skill" | "agent"; name: string; target: string }]> = [];
  for (const [p, w] of wanted) {
    if (manifest[p] === w.target) continue; // already the plugin's, as wanted
    if (exists(p)) {
      skipped.push({ kind: w.kind, name: w.name, why: "taken" });
      continue;
    }
    create.push([p, w]);
  }
  for (const [p, w] of create) manifest[p] = w.target;
  try {
    writeLoadout(input.file, { v: 1, choice: input.choice, links: manifest });
  } catch (e) {
    return { ...none, reason: `the loadout could not be saved (${e instanceof Error ? e.message : String(e)})` };
  }
  for (const [p, w] of create) {
    try {
      symlink(w.target, p);
    } catch {
      delete manifest[p];
      skipped.push({ kind: w.kind, name: w.name, why: "failed" });
    }
  }
  try {
    writeLoadout(input.file, { v: 1, choice: input.choice, links: manifest });
  } catch {}
  let linkedSkills = 0;
  let linkedAgents = 0;
  for (const [p, w] of wanted) if (manifest[p] === w.target) w.kind === "skill" ? linkedSkills++ : linkedAgents++;
  return { ok: true, linked: { skills: linkedSkills, agents: linkedAgents }, skipped };
}

/** The names whose links the plugin made and which are still in place (a link, to the target it recorded). */
export function linkedNames(config: string, manifest: Record<string, string>): { skills: string[]; agents: string[] } {
  const out = { skills: [] as string[], agents: [] as string[] };
  for (const [p, target] of Object.entries(ownLinks(config, manifest))) {
    if (linkTarget(p) !== target) continue;
    if (path.basename(path.dirname(p)) === "skills") out.skills.push(path.basename(p));
    else out.agents.push(path.basename(p).slice(0, -3));
  }
  return out;
}

/** The choice in force: the stored one, else the default for this listing (every skill but the oversized, no agent, no option). */
export const choiceOf = (stored: StoredLoadout, listing: LoadoutListing): { choice: LoadoutChoice; saved: boolean } =>
  stored.choice ? { choice: stored.choice, saved: true } : { choice: defaultChoice(listing), saved: false };

/* --------------------------------- service --------------------------------- */

export const loadoutListingSchema = z.object({
  skills: z.array(z.object({ name: z.string(), descChars: z.number().int().nonnegative().nullable(), bodyChars: z.number().int().nonnegative().nullable() })),
  agents: z.array(z.object({ name: z.string(), listChars: z.number().int().nonnegative() })),
  complete: z.boolean(),
  others: z.object({ skills: z.number().int().nonnegative(), agents: z.number().int().nonnegative() }),
});
export const loadoutStateOutput = z.object({
  /** False when the folders did not answer in time; the rest is then empty. */
  known: z.boolean(),
  listing: loadoutListingSchema,
  choice: loadoutChoiceSchema,
  /** False while no choice has been saved: `choice` is then the default for this listing. */
  saved: z.boolean(),
  /** Whether Local chats on Claude Code are switched on (Save is refused while they are off). */
  on: z.boolean(),
  /** What the Local settings folder really holds from this loadout: the plugin's own links, still in place. */
  linked: z.object({ skills: z.array(z.string()), agents: z.array(z.string()) }),
  /** Why the last attempt to make the links did not work, when it did not. */
  problem: z.string().nullable(),
  /** bb's share as measured in a Local chat's first request on this Mac (numbers and a time only); null while there is none. */
  measured: z.object({ bb: z.number().int().nonnegative(), at: z.number().int().nonnegative(), tools: z.number().int().nonnegative(), trimmed: z.boolean() }).nullable(),
});
export type LoadoutState = z.infer<typeof loadoutStateOutput>;
export const loadoutSaveInput = loadoutChoiceSchema.strict();
export const loadoutSaveOutput = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  linked: z.object({ skills: z.number().int(), agents: z.number().int() }),
  skipped: z.array(z.object({ kind: z.enum(["skill", "agent"]), name: z.string(), why: z.enum(["taken", "failed"]) })),
});
const NOT_KNOWN: LoadoutListing = { skills: [], agents: [], complete: false, others: { skills: 0, agents: 0 } };

type Setup = { (): { ok: true } | { ok: false; reason: string }; refresh(): { ok: true } | { ok: false; reason: string } };

/**
 * The loadout as bb's server serves it. Reading (state) writes nothing. Save writes the choice, runs the
 * Local setup again (its settings file takes the options at once, no bb restart) and then the links.
 * Saves run one at a time. Nothing here runs when a chat starts.
 */
export function createLocalLoadout(deps: {
  home: () => string | null;
  config: string;
  localRoot: string;
  file: string;
  /** Where the route keeps its first-request readings (firstPromptFile); read only when the state is asked for. */
  firstPrompts?: string;
  on: () => boolean;
  setup: Setup;
  warn?: (m: string) => void;
  now?: () => number;
  list?: typeof listLoadout;
  ttlMs?: number;
  maxMs?: number;
  symlink?: (target: string, p: string) => void;
}) {
  const now = deps.now ?? Date.now;
  const list = deps.list ?? listLoadout;
  const ttl = deps.ttlMs ?? LOADOUT_TTL_MS;
  const maxMs = deps.maxMs ?? LOADOUT_SCAN_MAX_MS;
  let cached: { at: number; value: LoadoutListing } | null = null;
  let running: Promise<LoadoutListing | null> | null = null;
  let hung = false;
  /** The listing, kept for ttl; null when the folders do not answer in time. A listing that hangs is never joined. */
  const listing = (fresh = false): Promise<LoadoutListing | null> => {
    if (!fresh && cached && now() - cached.at < ttl) return Promise.resolve(cached.value);
    if (running) return running;
    if (hung) return Promise.resolve(null);
    let job: Promise<LoadoutListing>;
    try {
      job = list(deps.home(), { maxMs, config: deps.config, manifest: readLoadout(deps.file).links });
    } catch {
      return Promise.resolve(null);
    }
    hung = true;
    void job.then(
      (value) => {
        cached = { at: now(), value };
      },
      () => undefined,
    ).finally(() => {
      hung = false;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), maxMs + 1_000)));
    running = Promise.race([job.catch(() => null), late]).finally(() => {
      clearTimeout(timer);
      running = null;
    });
    return running;
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const home = () => deps.home();
  const apply = (choice: LoadoutChoice, got: LoadoutListing): ApplyResult => {
    const h = home();
    if (!h) return { ok: false, reason: "the home folder is not known", linked: { skills: 0, agents: 0 }, skipped: [] };
    return applyLoadoutLinks({ home: h, config: deps.config, localRoot: deps.localRoot, file: deps.file, choice, listing: got, symlink: deps.symlink });
  };
  let problem: string | null = null;
  const note = (r: ApplyResult | null) => {
    if (r) problem = r.ok ? null : (r.reason ?? "the links were not made");
    return r;
  };
  const safeOn = () => {
    try {
      return deps.on();
    } catch {
      return false;
    }
  };
  return {
    listing,
    /** Answered after any save or apply under way, so what it says is linked is what is on disk. */
    state(): Promise<LoadoutState> {
      return serial(async () => {
        const got = await listing();
        const stored = readLoadout(deps.file);
        const { choice, saved } = choiceOf(stored, got ?? NOT_KNOWN);
        return { known: got !== null, listing: got ?? NOT_KNOWN, choice, saved, on: safeOn(), linked: linkedNames(deps.config, stored.links), problem, measured: deps.firstPrompts ? measuredShare(deps.firstPrompts) : null };
      });
    },
    /**
     * This loadout's own part of a first prompt now (skills, agents and items put in by hand, as linked, with the
     * stored options), for the route's reading; null when the folders do not answer in time. Writes nothing.
     */
    async part(): Promise<number | null> {
      const got = await listing();
      if (!got) return null;
      const stored = readLoadout(deps.file);
      const { choice } = choiceOf(stored, got);
      const linked = linkedNames(deps.config, stored.links);
      const c = loadoutCost(got, { ...choice, skills: linked.skills, agents: linked.agents });
      return c.skills + c.agents + c.others;
    },
    save(input: LoadoutChoice): Promise<z.infer<typeof loadoutSaveOutput>> {
      return serial(async () => {
        const none = { linked: { skills: 0, agents: 0 }, skipped: [] };
        if (!safeOn()) return { ok: false, reason: "Local chats on Claude Code are off in Setup, so the loadout is not saved.", ...none };
        const got = await listing(true);
        if (!got) return { ok: false, reason: "Your skills and agents folders did not answer in time, so nothing was changed. Try again.", ...none };
        // A listing cut short by its bounds would drop the links of everything past them: nothing is changed.
        if (!got.complete) return { ok: false, reason: `Your skills and agents folders hold more than can be read in time (${LOADOUT_SCAN_MAX_ENTRIES.toLocaleString("en-GB")} entries or ${LOADOUT_SCAN_MAX_MS / 1000} seconds), so nothing was changed.`, ...none };
        const skills = new Set(got.skills.map((s) => s.name));
        const agents = new Set(got.agents.map((a) => a.name));
        // Names the server listed now, or kept from the stored choice (a skill whose folder is briefly
        // unreachable stays ticked); only listed names are ever linked.
        const before = readLoadout(deps.file).choice;
        const keep = (n: string, listed: Set<string>, had: readonly string[] | undefined) => safeItemName(n) && (listed.has(n) || (had ?? []).includes(n));
        const choice: LoadoutChoice = {
          skills: [...new Set(input.skills)].filter((n) => keep(n, skills, before?.skills)),
          agents: [...new Set(input.agents)].filter((n) => keep(n, agents, before?.agents)),
          descriptions: input.descriptions,
          allTools: input.allTools,
          thinkLess: input.thinkLess,
        };
        try {
          writeLoadout(deps.file, { ...readLoadout(deps.file), v: 1, choice });
        } catch (e) {
          return { ok: false, reason: `The loadout could not be saved (${e instanceof Error ? e.message : String(e)}).`, ...none };
        }
        // The options go into the Local settings file now, through the one writer (ensureLocalClaude).
        const set = deps.setup.refresh();
        if (!set.ok) return { ok: false, reason: `Saved, but Local chats on Claude Code are not set up: ${set.reason}.`, ...none };
        const result = note(apply(choice, got))!;
        cached = null; // the Local folder's own count changed
        if (!result.ok) return { ...result, reason: `Saved, but the links were not made: ${result.reason}.` };
        return result;
      });
    },
    /** After the setup (at load, or on first use): makes the links of the stored choice, or of the default, which is then stored. */
    applyStored(): Promise<ApplyResult | null> {
      return serial(async () => {
        if (!safeOn() || !deps.setup().ok) return null;
        const got = await listing(true);
        if (!got) return null;
        const stored = readLoadout(deps.file);
        // Only from a whole listing: one cut short by a bound would fix a default without the rest, or drop their links.
        if (!got.complete) {
          problem = "your skills and agents folders hold more than can be read in time";
          return null;
        }
        const { choice } = choiceOf(stored, got);
        const result = note(apply(choice, got))!;
        if (!result.ok) deps.warn?.(`local loadout: not applied (${result.reason})`);
        return result;
      });
    },
  };
}

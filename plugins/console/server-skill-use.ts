// "Most used" in the Local loadout: how often each skill was used in Claude Code chats on this Mac in the last
// 30 days, counted from Claude Code's own chat records (~/.claude/projects/**/*.jsonl). Two traces are counted:
//   - the model calling the Skill tool: a tool_use block written as "name":"Skill","input":{"skill":"<name>"...
//   - a skill typed as a slash command: <command-name>/<name></command-name> in the user's message.
// Read as a stream, newest files first, byte by byte for those two markers: no line is parsed and no message
// text is kept, logged or sent anywhere. Only names and numbers leave this file. Bounded in time and bytes; when
// a bound stops it, the result says it is partial. Links inside ~/.claude/projects are not followed.
// Nothing here runs at load: only when the Local loadout panel asks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { safeItemName } from "./src/local-loadout";

/** How far back the count goes. */
export const SKILL_USE_DAYS = 30;
/**
 * Bounds on one count: time and bytes read. There is no cap on the number of files: the walk collects every chat
 * changed in the last SKILL_USE_DAYS days within the clock (a name and two numbers each, about 10 MB for 50,000),
 * so the newest are always read first; a walk the clock stops reads none.
 */
export const SKILL_USE_MAX_MS = 3_000;
export const SKILL_USE_MAX_BYTES = 8 * 1024 ** 3;
/** How long a count is kept (in memory and in the plugin's data folder) before it is made again. */
export const SKILL_USE_TTL_MS = 60 * 60_000;
/** How long a partial count (stopped at a limit) is kept: opening the panel a minute later counts again. */
export const SKILL_USE_PARTIAL_TTL_MS = 60_000;
const ttlOf = (u: SkillUse) => (u.partial ? SKILL_USE_PARTIAL_TTL_MS : SKILL_USE_TTL_MS);
/** The size of each piece read from a file (the most one scan step looks at before it gives the event loop a turn). */
const CHUNK = 256 * 1024;
export const SKILL_USE_PIECE_BYTES = CHUNK;
/** The most a skill's name may take after a marker; longer is not a name. */
const NAME_MAX = 200;

const TOOL_MARK = Buffer.from('"name":"Skill","input":{"skill":"');
const COMMAND_MARK = Buffer.from("<command-name>/");

export const projectsDir = (home: string) => path.join(home, ".claude", "projects");
export const skillUseFile = (dataDir: string = process.env.BB_DATA_DIR || path.join(os.homedir(), ".bb")) => path.join(dataDir, "plugins", "navaigate-skin", "local-skill-use.json");

export const skillUseSchema = z.object({
  /** Uses per skill name (names only). */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  /** True when a bound (time, bytes, files) stopped the count: it then holds the newest chats only. */
  partial: z.boolean(),
  /** When it was counted (epoch ms). */
  at: z.number(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  ms: z.number().int().nonnegative(),
});
export type SkillUse = z.infer<typeof skillUseSchema>;

/** Bytes kept back at the end of each piece: the longest marker and name, so nothing is cut in two. */
const TAIL = Math.max(TOOL_MARK.length, COMMAND_MARK.length) + NAME_MAX + 2;
export const SKILL_USE_TAIL_BYTES = TAIL;
/** Bytes before a cut kept as look-back only: a Skill call just after a cut still sees its id ("id":"toolu_..." just before it). */
const LOOK_BACK = 120;

const ID_MARK = Buffer.from('"id":"');
const USER_LINE = Buffer.from('"type":"user","message":{');
const NAME_OK = (raw: string) => !raw.includes("\\") && safeItemName(raw) && /^[\p{L}\p{N}._:@+-]+$/u.test(raw);
/** How many markers are handled between two looks at the clock inside one piece. */
const CLOCK_EVERY = 256;

/**
 * What one scan needs across pieces and files: the tool-use ids already counted (Claude Code's records repeat a
 * call, so a call is counted once per id), whether the current line is the user's own message so far
 * (top-level "type":"user" seen since the last line end), the deadline, and whether the scan stopped at it.
 */
type ScanState = { counts: Map<string, number>; ids: Set<string>; lineUser: boolean; deadline: number; now: () => number; stopped: boolean };

/**
 * Counts the names after each marker that STARTS in [from, limit) of `buf` (the bytes before `from` are look-back
 * only, already counted; the bytes from `limit` on are looked at with the next piece). Every byte is looked at a bounded number of times, whatever the lines hold, and the clock is
 * read every CLOCK_EVERY markers: past the deadline the scan stops and says so. A Skill call counts once per
 * tool-use id (the id comes just before the marker). A command tag counts only on a line that is the user's own
 * message: the line state is carried forward through the file, never searched for backwards.
 */
function scan(buf: Buffer, from: number, limit: number, st: ScanState): void {
  let n = 0;
  const late = () => (++n % CLOCK_EVERY === 0 && st.now() > st.deadline ? ((st.stopped = true), true) : false);
  let i = buf.indexOf(TOOL_MARK, from);
  while (i >= 0 && i < limit) {
    if (late()) return;
    const start = i + TOOL_MARK.length;
    const stop = buf.indexOf(0x22, start); // the closing quote of the JSON string
    if (stop >= 0 && stop - start <= NAME_MAX) {
      const raw = buf.toString("utf8", start, stop);
      // The id sits just before the marker ("id":"toolu_...","name":"Skill"...): only the last 120 bytes are searched.
      const back = Math.max(0, i - 120);
      const rel = buf.subarray(back, i).lastIndexOf(ID_MARK);
      const idAt = rel >= 0 ? back + rel : -1;
      const idEnd = idAt >= 0 ? buf.indexOf(0x22, idAt + ID_MARK.length) : -1;
      const id = idEnd > 0 && idEnd < i ? buf.toString("utf8", idAt + ID_MARK.length, idEnd) : null;
      if (NAME_OK(raw) && (id === null || !st.ids.has(id))) {
        if (id !== null) st.ids.add(id);
        st.counts.set(raw, (st.counts.get(raw) ?? 0) + 1);
      }
    }
    i = buf.indexOf(TOOL_MARK, start);
  }
  // The line state moves forward with a cursor: the bytes between two command tags are searched once for a line
  // end and once for the user-line marker, so the cost grows with the bytes, not with the tags.
  let cursor = from;
  let user = st.lineUser;
  const advance = (to: number) => {
    const nl = buf.subarray(cursor, to).lastIndexOf(0x0a);
    const from = nl >= 0 ? cursor + nl + 1 : cursor;
    // A user-line marker that starts in [from, to) (it may run past `to`).
    const seen = buf.subarray(from, Math.min(buf.length, to + USER_LINE.length - 1)).indexOf(USER_LINE) >= 0;
    user = nl >= 0 ? seen : user || seen;
    cursor = to;
  };
  i = buf.indexOf(COMMAND_MARK, from);
  while (i >= 0 && i < limit) {
    if (late()) return;
    advance(i);
    const start = i + COMMAND_MARK.length;
    const stop = buf.indexOf(0x3c, start); // the "<" of </command-name>
    if (stop >= 0 && stop - start <= NAME_MAX && user) {
      const raw = buf.toString("utf8", start, stop);
      if (NAME_OK(raw)) st.counts.set(raw, (st.counts.get(raw) ?? 0) + 1);
    }
    i = buf.indexOf(COMMAND_MARK, start);
  }
  advance(limit);
  st.lineUser = user;
}

/**
 * Counts skill uses in the chat records changed in the last SKILL_USE_DAYS days, newest first. Never throws;
 * a missing folder gives no counts. Entries that are links (folders or files) are not followed.
 */
export async function countSkillUse(
  home: string | null,
  /** onStep: told how long each synchronous step (one piece's scan) held the thread, in ms (tests measure it). */
  opts: { now?: () => number; maxMs?: number; maxBytes?: number; days?: number; onStep?: (ms: number) => void } = {},
): Promise<SkillUse> {
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = started + (opts.maxMs ?? SKILL_USE_MAX_MS);
  const maxBytes = opts.maxBytes ?? SKILL_USE_MAX_BYTES;
  const since = started - (opts.days ?? SKILL_USE_DAYS) * 86_400_000;
  const counts = new Map<string, number>();
  const st: ScanState = { counts, ids: new Set(), lineUser: false, deadline, now, stopped: false };
  let partial = false;
  let bytes = 0;
  let files = 0;
  const done = (): SkillUse => ({ counts: Object.fromEntries(counts), partial, at: now(), files, bytes, ms: Math.max(0, now() - started) });
  if (!home) return done();
  const root = projectsDir(home);
  // The files, by walking the folder without following links.
  const found: Array<{ file: string; mtime: number; size: number }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || partial) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (now() > deadline) {
        partial = true;
        return;
      }
      if (e.isSymbolicLink()) continue; // never leave ~/.claude/projects through a link
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = await fs.promises.lstat(p);
          if (st.isFile() && st.mtimeMs >= since) found.push({ file: p, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  };
  try {
    await walk(root, 0);
    // A walk the clock stopped has not seen every recent chat, so it cannot know which are newest: none is read.
    if (partial) return done();
    found.sort((a, b) => b.mtime - a.mtime);
    for (const f of found) {
      if (now() > deadline || bytes >= maxBytes) {
        partial = true;
        break;
      }
      files++;
      let handle: fs.promises.FileHandle;
      try {
        handle = await fs.promises.open(f.file, "r");
      } catch {
        continue;
      }
      try {
        const piece = Buffer.alloc(CHUNK + TAIL + LOOK_BACK);
        let carry = 0; // kept from the last piece: look-back, then the bytes not yet looked at (a marker may be cut there)
        let from = 0; // where, in the kept bytes, the bytes not yet looked at begin
        st.lineUser = false; // a file starts at the start of a line
        for (let pos = 0; ; ) {
          if (now() > deadline || bytes >= maxBytes) {
            partial = true;
            if (bytes >= maxBytes && carry > from) scan(piece.subarray(0, carry), from, carry, st); // what was already read
            break;
          }
          const { bytesRead } = await handle.read(piece, carry, CHUNK, pos);
          const filled = carry + bytesRead;
          const last = bytesRead === 0;
          const limit = last ? filled : Math.max(from, filled - TAIL);
          const t0 = performance.now();
          scan(piece.subarray(0, filled), from, limit, st);
          opts.onStep?.(performance.now() - t0);
          if (st.stopped) {
            partial = true;
            break;
          }
          if (last) break;
          pos += bytesRead;
          bytes += bytesRead;
          const keepFrom = Math.max(0, limit - LOOK_BACK);
          carry = filled - keepFrom;
          from = limit - keepFrom;
          piece.copy(piece, 0, keepFrom, filled);
          // Back to the event loop between pieces: a count never holds bb's server for more than one piece.
          await new Promise((r) => setImmediate(r));
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (partial) break;
    }
  } catch {
    partial = true;
  }
  return done();
}

/** The count as bb's server serves it: kept for SKILL_USE_TTL_MS (also on disk, names and numbers only), one count at a time. */
export function createSkillUse(deps: {
  home: () => string | null;
  file: string;
  /** The names of the user's listed skills; only these are ever kept (null: the listing is not known, nothing is kept). */
  listed: () => Promise<ReadonlySet<string> | null>;
  now?: () => number;
  count?: typeof countSkillUse;
  warn?: (m: string) => void;
}) {
  const now = deps.now ?? Date.now;
  const count = deps.count ?? countSkillUse;
  let memory: SkillUse | null = null;
  let running: Promise<SkillUse> | null = null;
  const read = (): SkillUse | null => {
    try {
      const got = skillUseSchema.safeParse(JSON.parse(fs.readFileSync(deps.file, "utf8")));
      return got.success ? got.data : null;
    } catch {
      return null;
    }
  };
  return {
    async get(): Promise<SkillUse> {
      // A kept count is filtered to the listed names on reading too (a file left by an older build may hold others).
      const keep = async (u: SkillUse): Promise<SkillUse> => {
        const listed = await deps.listed().catch(() => null);
        return { ...u, counts: listed ? Object.fromEntries(Object.entries(u.counts).filter(([name]) => listed.has(name))) : {} };
      };
      if (memory && now() - memory.at < ttlOf(memory)) return keep(memory);
      const stored = memory ?? read();
      if (stored && now() - stored.at < ttlOf(stored)) {
        memory = stored;
        return keep(stored);
      }
      if (running) return running;
      running = Promise.all([count(deps.home()), deps.listed().catch(() => null)])
        .then(([all, listed]) => {
          // Only the names of the user's listed skills, filtered BEFORE anything is kept: no other name (a built-in
          // command, another plugin's skill, a name typed in a chat) is ever stored, in memory or on disk.
          const got: SkillUse = { ...all, counts: listed ? Object.fromEntries(Object.entries(all.counts).filter(([name]) => listed.has(name))) : {} };
          if (!listed) return got; // not kept: the next ask counts again once the listing is known
          memory = got;
          try {
            fs.mkdirSync(path.dirname(deps.file), { recursive: true, mode: 0o700 });
            const tmp = `${deps.file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(got) + "\n", { mode: 0o600 });
            fs.renameSync(tmp, deps.file);
          } catch (e) {
            deps.warn?.(`local loadout: the skill-use count was not kept (${e instanceof Error ? e.message : String(e)})`);
          }
          return got;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}

export const skillUseOutput = z.object({
  /** False while Local chats on Claude Code are off, or when the count did not run. */
  known: z.boolean(),
  /** Uses per skill, for skills the listing holds only (names and numbers). */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  partial: z.boolean(),
  days: z.number().int().positive(),
});

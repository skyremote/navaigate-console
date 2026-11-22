// Session profiles on the server: the lean settings folder for Claude chats
// marked lean, the profile marks for the rail and Control room, and the
// owner's list of unlocked local models.
//
// HARD RULE: an ordinary (Online or Full) chat gets nothing at all from here.
// If it ever received environment, it would rebuild its session before its next
// turn. What is contributed, and to which chats:
//   - Lean: CLAUDE_CONFIG_DIR, only for a chat marked lean, on the bb server's
//     own Mac (where ~/.claude-lean lives), while that folder exists.
//   - Local on Claude Code: the launcher, the route, the model and the Local
//     settings folder, or entries that block the start, only for a chat marked
//     local (see localEnvFor), and for a chat made from one: a fork of a Local
//     chat (its sourceThreadId) or a chat it started (its parentThreadId), up
//     the line a few steps (see lineage below). Such a chat carries no mark of
//     its own (bb's Fork sends none), so without this it would start as an
//     ordinary Claude chat with the Local chat's history.
//   - The one exception: when a chat's mark cannot be read at all, on the bb
//     server's own Mac with the guard in place, the chat starts through the
//     guard (an Online chat goes on as normal, a local model name does not
//     start). Chats known to be Local are remembered on disk, so they never
//     reach that point.
//   - When a chat's mark reads as none but its line (the chat it was forked
//     from or started by) cannot be read, nothing is contributed: an ordinary
//     chat is never changed or blocked because of a failed read, and the read
//     is tried again at its next start.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseUnlockedList, readSessionProfile, SESSION_PROFILES, type SessionProfileMark } from "./src/session-profile";
import { consoleSection } from "./lib/profile-console";
import { loadProfile } from "./profile/load";

export const LEAN_DIR_NAME = ".claude-lean";
export const leanDir = (home: string = os.homedir()) => path.join(home, LEAN_DIR_NAME);
/** The lean folder is usable once the build script has written its settings. */
export const leanDirReady = (dir: string): boolean => fs.existsSync(path.join(dir, "settings.json"));

export type EnvEntry = { name: string; value: string | { serverPath: string }; reason: string };

/**
 * A Local chat on the Claude Code harness (server-local-claude.ts). A chat whose
 * local mark has been read gets something every time: the launcher and the route
 * when it can run here, otherwise a blocking entry, so it never starts as an
 * ordinary Claude chat whose prompt would go to an online account (refused there
 * is not the same as never sent). A chat whose mark cannot be read is handled by
 * the contributor below.
 * NAV_LOCAL_MODEL carries the model from the chat's mark: on a later turn bb can
 * ask for a Claude model by name, and the launcher and route ignore that.
 * CLAUDE_CONFIG_DIR is the Local settings folder, where Local transcripts are kept
 * (not the main ~/.claude): bb copies a fork's history from the folder named in the
 * fork's own environment, so a fork made without these entries cannot find it.
 * It is given with a block too, so a blocked fork fails on the blocked path, whose
 * last part says why in words, not on a missing history.
 */
export type LocalLine = "fork" | "child";
export function localEnvFor(input: {
  threadId: string | null;
  hostId: string;
  primaryHostId: string | null;
  mark: SessionProfileMark | null;
  launcher: string | null;
  serverPath: string;
  blocked: (why: string) => string;
  /** False when Local chats on Claude Code are switched off: a chat marked Local is then blocked, never started on an online account. */
  allowed?: boolean;
  /** The Local settings folder (CLAUDE_CONFIG_DIR for the chat); left out when not known. */
  configDir?: string | null;
  /** Set when the chat has no mark of its own and was forked from (fork) or started by (child) a Local chat. */
  line?: LocalLine | null;
}): EnvEntry[] {
  if (!input.threadId) return [];
  if (input.mark?.profile !== "local" && input.mark?.profile !== "local-unlocked") return [];
  const who = input.line === "fork" ? "Fork of a Local chat" : input.line === "child" ? "Chat started by a Local chat" : "Local chat";
  const config: EnvEntry[] = input.configDir ? [{ name: "CLAUDE_CONFIG_DIR", value: input.configDir, reason: `${who}: the Local settings folder, where its history is kept` }] : [];
  // bb shows the blocked path in its error, so the words say why; a chat made from a Local chat says that first.
  const prefix = input.line === "fork" ? "a-fork-of-a-local-chat-stays-on-this-mac--" : input.line === "child" ? "a-chat-started-by-a-local-chat-stays-on-this-mac--" : "";
  const block = (why: string, reason: string): EnvEntry[] => [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: input.blocked(prefix + why), reason: `${who} blocked: ${reason}` }, ...config];
  if (input.allowed === false) return block("local-chats-on-claude-code-are-switched-off", "Local chats on Claude Code are switched off in Setup");
  if (!input.primaryHostId) return block("bb-could-not-tell-which-mac-runs-local-models", "the bb server's own Mac is not known yet");
  if (input.hostId !== input.primaryHostId) return block("local-chats-run-only-on-the-bb-server-mac", "this chat would run on another machine");
  if (!input.launcher) return block("local-chat-setup-failed-see-plugin-log", "the launcher could not be set up");
  // Ollama's own name for an Ollama model; an LM Studio model keeps "lmstudio/" so the route knows where it runs.
  const model = (input.mark.model ?? "").replace(/^ollama\//, "");
  if (!model) return block("local-chat-has-no-model", "the chat's mark names no model");
  return [
    { name: "BB_CLAUDE_CODE_EXECUTABLE", value: input.launcher, reason: `${who}: Claude Code starts through the launcher that points it at the model on this Mac` },
    { name: "NAV_LOCAL_BASE_URL", value: { serverPath: input.serverPath }, reason: `${who}: the route on this bb server that forwards to Ollama or LM Studio on this Mac` },
    { name: "NAV_LOCAL_MODEL", value: model, reason: `${who}: the model the Local chat was created on, whatever a later turn asks for` },
    ...config,
  ];
}

/** The whole rule, with no input or output of its own, so a test can pin every case. */
export function leanEnvFor(input: {
  threadId: string | null;
  hostId: string;
  primaryHostId: string | null;
  mark: SessionProfileMark | null;
  dir: string;
  dirReady: boolean;
}): EnvEntry[] {
  if (!input.threadId) return [];
  if (input.mark?.profile !== "lean") return [];
  if (!input.primaryHostId || input.hostId !== input.primaryHostId) return [];
  if (!input.dirReady) return [];
  return [{ name: "CLAUDE_CONFIG_DIR", value: input.dir, reason: "Lean chat: starts with the lean settings folder" }];
}

const markOut = z.object({ profile: z.enum(SESSION_PROFILES), model: z.string().optional(), v: z.literal(1) });
export const sessionProfilesInput = z.object({ threadIds: z.array(z.string().min(1).max(64)).min(1).max(200) }).strict();
export const sessionProfilesOutput = z.record(z.string(), markOut);
export const sessionProfileConfigOutput = z.object({
  /** Exact model ids or names the owner treats as unlocked: the plugin setting and the profile together. */
  unlockedModels: z.array(z.string()),
  /** Words from the owner's profile that mark a model as unlocked when its id or name contains them. */
  unlockedWords: z.array(z.string()),
  /** Whether a lean settings folder is ready on the bb server's Mac; without it the Lean switch is not offered. */
  leanReady: z.boolean(),
});

/**
 * The chats known to be Local, kept on disk so a later failed read of a chat's mark (or a bb
 * restart) cannot make a Local chat start as an ordinary one. Small JSON, written whole to a
 * temporary file and renamed into place, readable by its owner only.
 */
/**
 * A chat known to be Local: its own mark, or (line set) the mark of the Local chat it was forked from or
 * started by. `placed` says what the environment rule did with a Claude Code chat made from a Local chat
 * at its last start: "launcher" (it runs on the local model) or "blocked". Only "launcher" is shown as Local.
 */
export type KnownLocal = SessionProfileMark & { line?: LocalLine; placed?: "launcher" | "blocked" };
export function createKnownLocalStore(file: string, warn: (m: string) => void = () => {}) {
  const known = new Map<string, KnownLocal>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { v?: number; chats?: Record<string, unknown> };
    for (const [id, mark] of Object.entries(raw?.chats ?? {})) {
      const m = mark as KnownLocal;
      if ((m?.profile === "local" || m?.profile === "local-unlocked") && typeof m.model === "string")
        known.set(id, {
          profile: m.profile,
          model: m.model,
          v: 1,
          ...(m.line === "fork" || m.line === "child" ? { line: m.line } : {}),
          ...(m.placed === "launcher" || m.placed === "blocked" ? { placed: m.placed } : {}),
        });
    }
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") warn(`session profile: could not read ${file} (${String(e)})`);
  }
  return {
    get: (threadId: string): KnownLocal | undefined => known.get(threadId),
    /** How many chats are on the list (none: Local chats on Claude Code have never run here). */
    size: (): number => known.size,
    add(threadId: string, mark: KnownLocal): void {
      const have = known.get(threadId);
      if (have && have.profile === mark.profile && have.model === mark.model && have.line === mark.line && have.placed === mark.placed) return;
      known.set(threadId, mark);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, chats: Object.fromEntries(known) }) + "\n", { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
      } catch (e) {
        warn(`session profile: could not save the Local chat list (${String(e)})`);
      }
    },
  };
}
export const knownLocalFile = (dataDir: string = process.env.BB_DATA_DIR || path.join(os.homedir(), ".bb")) => path.join(dataDir, "plugins", "navaigate-skin", "local-chats.json");

/** The unlocked models and words in the owner's profile (plugins.console); both empty by default. */
export function profileUnlocked(): { models: string[]; words: string[] } {
  try {
    const sec = consoleSection(loadProfile().profile);
    return { models: sec.unlockedModels, words: sec.unlockedWords };
  } catch {
    return { models: [], words: [] };
  }
}

type Deps = {
  home?: string;
  now?: () => number;
  /** The launcher, or null when it could not be set up (Local chats are then blocked). */
  launcher?: string | null;
  /** Used when a chat's mark cannot be read; null when it could not be set up. */
  guard?: string | null;
  /**
   * The launcher and the guard, set up on first use (they are written only once Local chats on Claude
   * Code are switched on). When given, it replaces `launcher` and `guard`.
   */
  localSetup?: () => { launcher: string | null; guard: string | null };
  localServerPath?: string;
  blocked?: (why: string) => string;
  /** Where the chats known to be Local are kept (default: this plugin's data folder). */
  knownLocalFile?: string;
  /** Whether a file exists (the guard); replaceable in tests. */
  exists?: (file: string) => boolean;
  /**
   * Whether Local chats on the Claude Code harness are switched on (the feature picker). Off: the
   * guard for a chat whose mark cannot be read contributes nothing, so ordinary chats are never
   * touched. A chat already marked Local is still blocked from starting on an online account.
   */
  localClaudeOn?: () => boolean;
  /** The owner's unlocked models and words from the profile; replaceable in tests. */
  profileUnlocked?: () => { models: string[]; words: string[] };
  /** The Local settings folder (~/.claude-local/config), given to Local chats and to chats made from them as CLAUDE_CONFIG_DIR. */
  localConfigDir?: string;
};

/** How far up a chat's line (fork source, then parent) the plugin looks for a Local chat. */
export const LINEAGE_DEPTH = 4;
type ThreadLine = { sourceThreadId: string | null; parentThreadId: string | null };

export function createSessionProfiles(bb: BbPluginApi, deps: Deps = {}) {
  const dir = leanDir(deps.home);
  const settings = bb.settings.define({
    unlockedModels: {
      type: "string",
      label: "Unlocked local models",
      description:
        "Local models to treat as unlocked (the padlock opens on the Local orb and the chat is flagged 'Local, unlocked'), one model id or name per line. Empty: no model is treated as unlocked.",
      default: "",
    },
  });

  // The bb server's own host. It does not change while the server runs, so a
  // good answer is kept; a failed read is asked again next time.
  let primary: string | null = null;
  const primaryHostId = async (): Promise<string | null> => {
    if (primary) return primary;
    try {
      primary = (await bb.sdk.system.config()).primaryHostId ?? null;
    } catch (e) {
      bb.log.warn(`session profile: primary host unknown (${String(e)})`);
    }
    return primary;
  };

  // A chat once read as lean stays lean here, so a passing metadata failure
  // cannot flip it to Full and back (each flip rebuilds its session).
  const knownLean = new Set<string>();
  // The same for a Local chat on the Claude Code harness: once read, its answer never changes, and it is kept on disk.
  // A test passes its own home, and then nothing is written outside it.
  const knownLocal = createKnownLocalStore(deps.knownLocalFile ?? (deps.home ? knownLocalFile(path.join(deps.home, ".bb")) : knownLocalFile()), (m) => bb.log.warn(m));
  const exists = deps.exists ?? ((file: string) => fs.existsSync(file));
  // A chat read once with no mark of its own keeps none: the mark is written when the chat is created and never added later.
  const noMark = new Set<string>();
  // A chat with no mark whose line was read and holds no Local chat: an ordinary (Online) chat, never read again.
  // Kept to a fixed size so a long-running server does not grow it without end; a chat that falls out is read again.
  const knownOnline = new Set<string>();
  const remember = (set: Set<string>, id: string) => {
    if (set.size >= 20_000) set.delete(set.values().next().value as string);
    set.add(id);
  };
  // Chats of any harness found, for a refusal, to be made from a Local chat. Kept in memory only and never
  // shown as Local: nothing here holds a Codex or other chat to a local model.
  const madeFromLocal = new Map<string, KnownLocal>();
  /** bb answers a read of a deleted thread with 404 (thread_not_found). */
  const gone = (e: unknown): boolean => {
    const x = e as { status?: unknown; statusCode?: unknown; code?: unknown; body?: { code?: unknown }; message?: unknown } | null;
    return x?.status === 404 || x?.statusCode === 404 || x?.code === "thread_not_found" || x?.body?.code === "thread_not_found" || /thread[_ ]not[_ ]found/i.test(String(x?.message ?? ""));
  };
  const isLocalKind = (mark: SessionProfileMark | null | undefined): mark is SessionProfileMark => mark?.profile === "local" || mark?.profile === "local-unlocked";
  const twice = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (e) {
      if (gone(e)) throw e; // a deleted thread stays deleted
      return await read(); // one more try; a second failure goes to the caller
    }
  };
  const readMark = async (threadId: string): Promise<SessionProfileMark | null> =>
    readSessionProfile(await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: bb.pluginId }));
  const markOf = async (threadId: string): Promise<KnownLocal | null> => {
    if (knownLean.has(threadId)) return { profile: "lean", v: 1 };
    const local = knownLocal.get(threadId);
    if (local) return local;
    if (noMark.has(threadId) || knownOnline.has(threadId)) return null;
    const mark = await twice(() => readMark(threadId));
    if (mark?.profile === "lean") knownLean.add(threadId);
    else if (isLocalKind(mark)) knownLocal.add(threadId, mark);
    else if (!mark) remember(noMark, threadId);
    return mark;
  };
  /** Where a chat came from: the chat it was forked from and the chat that started it (bb's own thread row). */
  const lineOf = async (threadId: string): Promise<ThreadLine> => {
    const got = (await twice(() => bb.sdk.threads.get({ threadId }))) as unknown as Partial<ThreadLine> & { thread?: Partial<ThreadLine> };
    const t = got.thread ?? got;
    const id = (v: unknown) => (typeof v === "string" && v.length > 0 && v !== threadId ? v : null);
    return { sourceThreadId: id(t.sourceThreadId), parentThreadId: id(t.parentThreadId) };
  };
  /**
   * The Local chat a chat with no mark was made from, if any: its fork source first, then the chat that
   * started it, then theirs, up to LINEAGE_DEPTH steps. A chat on the known-Local list answers with no
   * read; any other step costs one cached read of its mark and, when it has none, one of its line.
   * A deleted chat (bb answers 404) ends the line there: it is not Local (a Local chat that ever ran
   * here is on the known-Local list, which is checked before any read), and it is remembered.
   * Throws when a read fails twice for any other reason, so the caller can decide.
   */
  type Found = { mark: SessionProfileMark; line: LocalLine } | null;
  const localAncestor = async (line: ThreadLine, depth: number): Promise<{ found: Found; cut: boolean }> => {
    const steps: Array<[string, LocalLine]> = [];
    if (line.sourceThreadId) steps.push([line.sourceThreadId, "fork"]);
    if (line.parentThreadId && line.parentThreadId !== line.sourceThreadId) steps.push([line.parentThreadId, "child"]);
    let cut = false;
    for (const [id, how] of steps) {
      let mark: KnownLocal | null;
      try {
        mark = await markOf(id);
      } catch (e) {
        if (!gone(e)) throw e;
        remember(knownOnline, id);
        continue;
      }
      if (isLocalKind(mark)) return { found: { mark: { profile: mark.profile, ...(mark.model ? { model: mark.model } : {}), v: 1 }, line: how }, cut: false };
      if (mark || knownOnline.has(id)) continue;
      if (depth + 1 >= LINEAGE_DEPTH) {
        cut = true; // not looked at past here, so nothing is concluded about this chat
        continue;
      }
      let upLine: ThreadLine;
      try {
        upLine = await lineOf(id);
      } catch (e) {
        if (!gone(e)) throw e;
        remember(knownOnline, id);
        continue;
      }
      const up = await localAncestor(upLine, depth + 1);
      if (up.found) return { found: { mark: up.found.mark, line: how }, cut: false };
      // Its whole line was read and holds no Local chat: an ordinary chat, kept so a sibling does not read it again.
      if (!up.cut) remember(knownOnline, id);
      else cut = true;
    }
    return { found: null, cut };
  };
  const blocked = deps.blocked ?? ((why: string) => path.join(deps.home ?? os.homedir(), ".claude-local", "blocked", why));

  /**
   * A chat with no mark of its own: the mark of the Local chat it was forked from or started by, or
   * null for an ordinary chat, which joins the known-Online set so its line is read once per bb run at
   * most. The caller keeps a found mark (the environment rule on disk, a refusal in memory). A failed
   * read throws and is kept nowhere, so it is asked again.
   */
  const derivedMark = async (threadId: string, line: Promise<ThreadLine>): Promise<KnownLocal | null> => {
    const { found } = await localAncestor(await line, 0);
    if (!found) {
      // Also when the line was longer than LINEAGE_DEPTH: the chat is treated as ordinary from then on.
      remember(knownOnline, threadId);
      return null;
    }
    return { ...found.mark, line: found.line };
  };
  const providers = bb.providers as typeof bb.providers & { experimental_contributeEnv?: unknown };
  if (typeof providers.experimental_contributeEnv === "function") {
    bb.providers.experimental_contributeEnv("claude-code", async ({ threadId, hostId }) => {
      if (!threadId) return [];
      // A chat this plugin has not placed yet needs its own row (where it came from) as well as its mark:
      // both are read at once, so the line costs no extra wait. A known chat costs no read at all.
      const unplaced = !knownLean.has(threadId) && !knownLocal.get(threadId) && !knownOnline.has(threadId);
      const line = unplaced ? lineOf(threadId) : null;
      line?.catch(() => undefined); // its failure is handled where it is awaited
      try {
        let mark: KnownLocal | null = await markOf(threadId);
        if (!mark) {
          if (!line || knownOnline.has(threadId)) return [];
          try {
            mark = await derivedMark(threadId, line);
          } catch (e) {
            // The chat has no mark, and where it came from could not be read (twice). Nothing is
            // remembered: the next start reads again. While the plugin knows no Local chat on this Mac
            // (the known-Local list is empty), nothing is contributed and the chat starts as
            // it is. Once it knows one, this could be a chat a Local chat started, so this one start is
            // blocked with a reason in words; an ordinary chat then starts on the next try.
            if (knownLocal.size() === 0) {
              bb.log.warn(`session profile: could not read where ${threadId} came from (${String(e)}); it starts as an ordinary chat`);
              return [];
            }
            bb.log.warn(`session profile: could not read where ${threadId} came from (${String(e)}); this start is blocked`);
            return [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: blocked("could-not-check-whether-a-local-chat-started-this-chat--send-again"), reason: "Could not check whether a Local chat started this chat: send again" }];
          }
          if (!mark) return [];
        }
        if (mark.profile === "lean") return leanEnvFor({ threadId, hostId, primaryHostId: await primaryHostId(), mark, dir, dirReady: leanDirReady(dir) });
        // Only Claude chats reach this contributor, so a local mark here is a Local chat on the Claude Code
        // harness, or a chat made from a Local chat (line set). Each one gets the launcher or a block.
        const allowed = deps.localClaudeOn ? deps.localClaudeOn() : true;
        const launcher = allowed && deps.localServerPath ? (deps.localSetup ? deps.localSetup().launcher : (deps.launcher ?? null)) : null;
        const entries = localEnvFor({
          threadId,
          hostId,
          primaryHostId: await primaryHostId(),
          mark,
          launcher,
          serverPath: deps.localServerPath ?? "",
          blocked,
          allowed,
          configDir: deps.localConfigDir ?? null,
          line: mark.line ?? null,
        });
        const block = entries.find((e) => e.name === "BB_CLAUDE_CODE_EXECUTABLE" && e.value !== launcher);
        // A Claude Code chat made from a Local chat is kept on disk with what was done with it, so a restart
        // or a failed read cannot make it ordinary, and the rail shows it as Local only while it runs locally.
        if (mark.line) knownLocal.add(threadId, { ...mark, placed: block ? "blocked" : "launcher" });
        if (block) bb.log.warn(`session profile: ${threadId} blocked (${block.reason})`);
        else if (mark.line) bb.log.info(`session profile: ${threadId} is a ${mark.line === "fork" ? "fork of" : "chat started by"} a Local chat; it runs on the same local model`);
        return entries;
      } catch (e) {
        // The mark could not be read (twice). A chat known to be Local never gets here: markOf
        // answered it from the list on disk. So this is an ordinary chat or a Local chat on its
        // very first start, whose model is a local name. On the bb server's own Mac with the guard
        // in place, the guard starts a Claude model as normal and refuses a local name. Anywhere
        // else, nothing is contributed, so an ordinary chat is never changed or blocked.
        bb.log.warn(`session profile: could not read the mark of ${threadId} (${String(e)})`);
        if (!deps.localServerPath) return [];
        if (deps.localClaudeOn && !deps.localClaudeOn()) return [];
        const guard = deps.localSetup ? deps.localSetup().guard : (deps.guard ?? null);
        if (!guard) return [];
        const primary = await primaryHostId();
        if (!primary || hostId !== primary || !exists(guard)) return [];
        return [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: guard, reason: "Could not check whether this chat is Local: it starts only on a Claude model" }];
      }
    });
  } else bb.log.warn("session profile: this bb has no experimental_contributeEnv; lean chats start as Full");

  return {
    /**
     * The marks of the given chats; chats without one (Online) are left out. A Claude Code chat made from
     * a Local chat shows its Local chat's mark once it has started on that model; one that was blocked,
     * and a chat of any other harness made from a Local chat, shows none.
     */
    async marks(threadIds: string[]): Promise<Record<string, SessionProfileMark>> {
      const out: Record<string, SessionProfileMark> = {};
      const list = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds, pluginId: bb.pluginId });
      for (const row of list.threads) {
        const mark = readSessionProfile(row.metadata);
        if (mark) out[row.threadId] = mark;
      }
      for (const id of threadIds) {
        const known = out[id] ? undefined : knownLocal.get(id);
        if (known?.line && known.placed === "launcher") out[id] = { profile: known.profile, ...(known.model ? { model: known.model } : {}), v: 1 };
      }
      return out;
    },
    /**
     * Whether a chat is Local or made from one (its own mark, or its line), for actions that would carry
     * its conversation elsewhere (moving it to another machine). Throws when that cannot be read.
     */
    async localOf(threadId: string): Promise<SessionProfileMark | null> {
      const mark = await markOf(threadId);
      if (mark) return isLocalKind(mark) ? mark : null;
      if (knownOnline.has(threadId)) return null;
      const made = madeFromLocal.get(threadId);
      if (made) return made;
      const found = await derivedMark(threadId, lineOf(threadId));
      if (found) madeFromLocal.set(threadId, found); // memory only, never shown as Local
      return found;
    },
    async config(): Promise<z.infer<typeof sessionProfileConfigOutput>> {
      const s = await settings.get();
      const fromProfile = (deps.profileUnlocked ?? profileUnlocked)();
      const models = [...new Set([...parseUnlockedList(String(s.unlockedModels ?? "")), ...fromProfile.models])];
      return { unlockedModels: models, unlockedWords: fromProfile.words, leanReady: leanDirReady(dir) };
    },
  };
}

/**
 * Actions that would carry a chat's conversation to another model or machine (teleport, send to the
 * always-on Mac, new work on another Mac with the conversation, a model started alongside or a
 * continuation given its earlier messages) are refused for a Local chat or one made from it: its
 * conversation stays on this Mac. Refused too when that cannot be checked (none of these is urgent).
 */
export async function refuseLocalCopy(localOf: (threadId: string) => Promise<SessionProfileMark | null>, threadIds: readonly string[], what: string): Promise<void> {
  for (const threadId of new Set(threadIds)) {
    let local: SessionProfileMark | null;
    try {
      local = await localOf(threadId);
    } catch {
      throw new Error(`Could not check whether this conversation includes a Local chat, so ${what}. Try again in a moment.`);
    }
    if (local) throw new Error(`This conversation includes a Local chat, or one made from it: it stays on this Mac, so ${what}.`);
  }
}
/** Moving a chat to another machine (teleport, send to the always-on Mac). */
export const refuseLocalMove = (localOf: (threadId: string) => Promise<SessionProfileMark | null>, threadId: string): Promise<void> =>
  refuseLocalCopy(localOf, [threadId], "it is not moved to another machine");

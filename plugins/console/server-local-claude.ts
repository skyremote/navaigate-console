// A Local chat on the Claude Code harness: Claude Code itself, talking to a
// model that runs on this Mac (Ollama or LM Studio) instead of to Anthropic.
//
// How one chat is redirected, with no change to bb's core:
//   1. The chat is created on provider claude-code with the local model's own
//      name as its model. Anthropic does not know that name, so a chat that
//      ever misses the steps below is REFUSED by Anthropic: it cannot fall
//      through to a paid Claude model with a prompt meant to stay on this Mac.
//   2. For a chat marked local, the plugin contributes BB_CLAUDE_CODE_EXECUTABLE
//      (bb's own switch for which claude program a chat runs) pointing at a
//      small launcher, plus the address of the route below.
//   3. The launcher sets ANTHROPIC_BASE_URL to that route and starts the real
//      claude. The Account Pooler's own values stay untouched for every other chat.
//   4. The route checks a secret, repairs the one message layout local chat
//      templates refuse, and streams to Ollama or LM Studio on 127.0.0.1.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { BODY_CHARS_PER_TOKEN, FIRST_WORDS_MAX_CHARS, LOCAL_OUTPUT_TOKENS, SKILL_LISTING_BUDGET_FRACTION } from "./src/local-loadout";
import { localRootProblem } from "./server-local-loadout";
import { LMSTUDIO, LMSTUDIO_PREFIX, LOCAL_WINDOW_TOKENS, OLLAMA_BASE, lmStudioModel, OLLAMA_ELSEWHERE_REASON, REMOTE_REASON, isLmStudio, isRemoteModel, lmStudioReady, ollamaName } from "./server-local-models";

export const LOCAL_ROUTE = "/local";
export const LOCAL_SERVER_PATH = "/api/v1/plugins/navaigate-skin/http/local";
/**
 * The window Claude Code plans for: the local models' own 65,536 tokens. Claude Code compacts when the
 * prompt reaches this less 13,000 and the output cap (measured with /context, Claude Code 2.1.330), so
 * at 65,536 it compacts near 44,000 and prompt plus answer still fit. At 56,000 a Local chat in bb was
 * already within 299 tokens of compacting after its first turn (21 Nov 2026).
 */
const CONTEXT_TOKENS = LOCAL_WINDOW_TOKENS;
/**
 * Most a local model may write in one answer. Claude Code asks for 32,000 by default; with a
 * 36k-token prompt that is past the 65,536-token window, so the cap keeps prompt + answer inside it.
 */
const OUTPUT_TOKENS = LOCAL_OUTPUT_TOKENS;
/**
 * Claude Code's limit on a silent stream for a Local chat: the most CLAUDE_STREAM_IDLE_TIMEOUT_MS
 * allows (Claude Code 2.1.330 caps it at 1,800,000; its default is 300,000). It does not cover a runner
 * that holds its headers: Claude Code waited 360 s for headers without it (2.1.318 and 2.1.330), 360 s
 * with it on 2.1.318 and 600 s with it on 2.1.330 (API_TIMEOUT_MS), measured 22 Nov 2026. The route's
 * early answer (EARLY_HEADERS_MS) covers that case.
 */
export const STREAM_IDLE_MS = 1_800_000;

export const localDir = (home: string = os.homedir()) => path.join(home, ".claude-local");
export const launcherPath = (home?: string) => path.join(localDir(home), "bin", "claude-local");
export const guardPath = (home?: string) => path.join(localDir(home), "bin", "claude-guard");
/**
 * A path that is never created. bb refuses to start a chat whose BB_CLAUDE_CODE_EXECUTABLE is not
 * an executable file, and shows the path in its error, so the last part says why in words.
 */
export const blockedPath = (why: string, home?: string) => path.join(localDir(home), "blocked", why);

type Json = Record<string, unknown>;
type Block = { type?: string; text?: string };
type Message = { role?: string; content?: unknown };

/**
 * Claude Code sends some notes as a message with role "system" in the middle of
 * the conversation. Local chat templates (Qwen's, for one) refuse that. The note
 * is kept where it stands, as text on the user message beside it, so the start
 * of the prompt stays byte-for-byte the same from turn to turn and the model's
 * prompt cache keeps working.
 */
export function repairMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  const blocksOf = (content: unknown): Block[] =>
    typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];
  for (const m of messages) {
    if (m.role !== "system") {
      out.push(m);
      continue;
    }
    const notes = blocksOf(m.content)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => ({ type: "text", text: b.text }));
    if (notes.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === "user") out[out.length - 1] = { role: "user", content: [...blocksOf(last.content), ...notes] };
    else out.push({ role: "user", content: notes });
  }
  return out;
}

/** The request as Ollama should get it: its own model name, the repaired messages, nothing else changed. */
export function rewriteRequest(body: Json, model: string): Json {
  const next: Json = { ...body, model };
  // Claude Code opens every request with a billing line whose code changes each time. Left in, that
  // one change at the very top makes a local model read the whole prompt again on every turn.
  if (Array.isArray(body.system)) next.system = (body.system as Block[]).filter((b) => !(typeof b?.text === "string" && b.text.startsWith("x-anthropic-billing-header")));
  if (Array.isArray(body.messages)) next.messages = repairMessages(body.messages as Message[]);
  return next;
}

/**
 * LM Studio counts the cached part of the prompt twice: its input_tokens is the whole prompt and its
 * cache_read_input_tokens repeats the cached part (a 4,316-token prompt sent twice came back as 4,316
 * input + 4,312 cache read, 21 Nov 2026). Anthropic's input_tokens leaves the cached part out, and
 * Claude Code adds the two, so a 31,000-token chat looked like 62,000 and compacted after one turn.
 * This puts LM Studio's numbers the Anthropic way; numbers that already add up are left alone.
 */
export function fixLmStudioUsage(usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const input = u.input_tokens;
  const cached = u.cache_read_input_tokens;
  if (typeof input === "number" && typeof cached === "number" && cached > 0 && input >= cached) u.input_tokens = input - cached;
}
/** fixLmStudioUsage on one server-sent-events line ("data: {...}"); any other line is returned as it was. */
export function fixLmStudioEventLine(line: string): string {
  if (!line.startsWith("data:") || !line.includes("cache_read_input_tokens")) return line;
  const cr = line.endsWith("\r") ? "\r" : "";
  try {
    const event = JSON.parse(line.slice(5)) as { type?: string; message?: { usage?: unknown }; usage?: unknown };
    if (event.type === "message_start") fixLmStudioUsage(event.message?.usage);
    else if (event.type === "message_delta") fixLmStudioUsage(event.usage);
    else return line;
    return `data: ${JSON.stringify(event)}${cr}`;
  } catch {
    return line;
  }
}
/** The same for LM Studio's streamed answer, line by line, passing each line on as soon as it is whole. */
export function lmStudioUsageStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let rest = "";
  return new TransformStream({
    transform(chunk, controller) {
      rest += decoder.decode(chunk, { stream: true });
      const end = rest.lastIndexOf("\n");
      if (end < 0) return;
      const whole = rest.slice(0, end + 1);
      rest = rest.slice(end + 1);
      controller.enqueue(encoder.encode(whole.split("\n").map(fixLmStudioEventLine).join("\n")));
    },
    flush(controller) {
      rest += decoder.decode();
      if (rest) controller.enqueue(encoder.encode(fixLmStudioEventLine(rest)));
    },
  });
}

/**
 * What the route reads from a request that may be a Local chat's first (numbers only, nothing kept): its tools,
 * whether the trimmed tools were on (none of LOCAL_TRIMMED_TOOLS in it) and the user's own words in tokens
 * (text the user wrote, not Claude Code's <system-reminder> notes or its "system" messages). Null when it is not
 * a first request that can be used: no tools (a side request), an assistant turn already (a later turn, a resumed
 * chat), anything but text from the user (an image, a tool result), or long user words (a pasted text, the
 * summary that starts a shortened chat). Which request of a chat comes first is the route's to judge (by its
 * session, see createLocalClaudeRoute): a subagent's first request looks the same and comes later.
 */
export function firstPromptOf(body: Json): { tools: number; trimmed: boolean; user: number } | null {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: unknown }>) : [];
  const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : null;
  if (tools.length === 0 || !messages || messages.length === 0) return null;
  let chars = 0;
  for (const m of messages) {
    if (m.role === "assistant") return null;
    if (m.role !== "user") continue;
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as Block[]) : [];
    for (const b of blocks) {
      if (b?.type !== "text" || typeof b.text !== "string") return null;
      if (!b.text.startsWith("<system-reminder>")) chars += b.text.length;
    }
  }
  if (chars > FIRST_WORDS_MAX_CHARS) return null;
  const trimmedNames = new Set<string>(LOCAL_TRIMMED_TOOLS);
  return { tools: tools.length, trimmed: !tools.some((t) => typeof t?.name === "string" && trimmedNames.has(t.name)), user: Math.ceil(chars / BODY_CHARS_PER_TOKEN) };
}

/**
 * Passes a streamed answer on byte for byte and reads, on the side, how many tokens the runner says it read
 * (the last positive input_tokens of message_start or message_delta, before LM Studio's counts are put the
 * Anthropic way, so it is the whole prompt on both runners). onRead is called once, only when the answer ended
 * with message_stop and no error event; never for a stream that was cancelled, cut short or failed.
 */
export function usageTap(onRead: (input: number) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let rest = "";
  let input = 0;
  let stopped = false;
  let failed = false;
  const look = (line: string) => {
    if (!line.startsWith("data:")) return;
    if (!line.includes("input_tokens") && !line.includes("message_stop") && !line.includes('"error"')) return;
    try {
      const e = JSON.parse(line.slice(5)) as { type?: string; message?: { usage?: { input_tokens?: unknown } }; usage?: { input_tokens?: unknown } };
      if (e.type === "error") failed = true;
      else if (e.type === "message_stop") stopped = true;
      const n = e.type === "message_start" ? e.message?.usage?.input_tokens : e.type === "message_delta" ? e.usage?.input_tokens : undefined;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) input = n;
    } catch {}
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      rest += decoder.decode(chunk, { stream: true });
      let end = rest.indexOf("\n");
      while (end >= 0) {
        look(rest.slice(0, end).trim());
        rest = rest.slice(end + 1);
        end = rest.indexOf("\n");
      }
      if (rest.length > 1_000_000) rest = ""; // one line this long is answer text, not a count
    },
    flush() {
      look((rest + decoder.decode()).trim());
      if (stopped && !failed && input > 0) onRead(input);
    },
  });
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The launcher: a POSIX shell script, so the Agent SDK can start it as the claude program. */
/**
 * Environment variables the launcher removes before its own exports (besides every CLAUDE_CODE_USE_*): each
 * one, left as the user's environment has it, takes a Local chat's request off the route or adds the user's
 * own key or headers to it (Claude Code 2.1.330, captured 22 Nov 2026). Some are set again just below.
 */
export const LAUNCHER_UNSET = ["ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL", "CLAUDE_CODE_HOST_CREDS_FILE"] as const;

export function launcherScript(input: { secret: string; realClaude: string; configDir: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Written by navaigate-skin (server-local-claude.ts). Do not edit: it is rewritten when the plugin loads.
# Starts Claude Code for a Local chat: the model is on this Mac (Ollama or LM Studio), reached through bb.
# A chat the plugin has stopped: its reason, in words, is shown to the user, whatever else is set.
if [ -n "$NAV_LOCAL_BLOCKED" ]; then
  printf 'claude-local: %s\n' "$NAV_LOCAL_BLOCKED" >&2
  exit 78
fi
if [ -z "$NAV_LOCAL_BASE_URL" ]; then
  echo "claude-local: no local route was given, so this chat does not start (if Local chats on Claude Code are off in Setup, switch them on to continue it)" >&2
  exit 78
fi
# The model is the one the chat was marked with when it was created (NAV_LOCAL_MODEL, from bb's
# server), not the one bb asks for: on a later turn bb can ask for a Claude model by name.
model="$NAV_LOCAL_MODEL"
if [ -z "$model" ]; then
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--model" ]; then model="$a"; fi
    case "$a" in --model=*) model="\${a#--model=}" ;; esac
    prev="$a"
  done
fi
if [ -n "$model" ]; then
  # Claude Code is started on the local model too, so it plans for the local window, not a Claude one.
  prev=""
  for a in "$@"; do
    shift
    orig="$a"
    if [ "$prev" = "--model" ]; then a="$model"; fi
    case "$orig" in --model=*) a="--model=$model" ;; esac
    set -- "$@" "$a"
    prev="$orig"
  done
fi
# What the environment must not decide for a Local chat: where its requests go, and which key or headers they
# carry. Everything is unset here, before the launcher's own exports below.
# A provider switch (Bedrock, Vertex, Foundry, a gateway, ...) would send Claude Code to that provider whatever
# ANTHROPIC_BASE_URL says: every CLAUDE_CODE_USE_* variable goes.
for v in $(env | sed -n 's/^\\(CLAUDE_CODE_USE_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done
# Claude Code's own telemetry and tracing would send the chat's events, and its prompts when asked, to the
# collector the environment names: none for a Local chat.
for v in $(env | sed -n 's/^\\(\\(ANT_\\)\\{0,1\\}OTEL_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done
unset CLAUDE_CODE_ENABLE_TELEMETRY CLAUDE_CODE_ENHANCED_TELEMETRY_BETA ENABLE_BETA_TRACING_DETAILED BETA_TRACING_ENDPOINT
unset ${LAUNCHER_UNSET.join(" ")}
# A proxy from the environment never carries a request to this Mac's own route; the user's own entries, from either spelling, are kept after.
nav_np="127.0.0.1,localhost,::1\${NO_PROXY:+,$NO_PROXY}\${no_proxy:+,$no_proxy}"
export NO_PROXY="$nav_np"
export no_proxy="$nav_np"
export ANTHROPIC_BASE_URL="$NAV_LOCAL_BASE_URL"
export ANTHROPIC_AUTH_TOKEN=${q(input.secret)}
# Claude Code then takes no provider, address or key from any settings file or --settings, only from this environment.
export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1
if [ -n "$model" ]; then
  export ANTHROPIC_CUSTOM_HEADERS="x-nav-local-model: $model"
  export ANTHROPIC_SMALL_FAST_MODEL="$model"
  export CLAUDE_CODE_SUBAGENT_MODEL="$model"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="$model"
fi
export CLAUDE_CONFIG_DIR=${q(input.configDir)}
export ENABLE_TOOL_SEARCH=false
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${CONTEXT_TOKENS}
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=${OUTPUT_TOKENS}
# No billing line at the top of the prompt: it changes every request and would make the model read it all again.
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
# A local model can read a long prompt for more than 5 minutes before it sends a word. Claude Code
# drops a stream after 5 minutes with no bytes and sends the whole request again; this raises that
# limit to its maximum, 30 minutes (the route also sends a keep-alive ping every 30 seconds).
export CLAUDE_STREAM_IDLE_TIMEOUT_MS=${STREAM_IDLE_MS}
# Every agent a Local chat hands work to runs on the same local model, even one whose own settings
# name a Claude model (CLAUDE_CODE_SUBAGENT_MODEL alone loses to an agent's own model: line).
export CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1
# Settings from the user's settings file only (the Local settings folder, CLAUDE_CONFIG_DIR): never the project's
# own .claude/settings.json or settings.local.json, or ~/.claude/settings.json for a chat in the home folder,
# whose env could send this chat and its key to another address. bb passes --setting-sources=user,project,local;
# Claude Code takes the last one given (Claude Code 2.1.319, 2.1.322 and 2.1.330, 22 Nov 2026), so this goes
# last, or just before a bare "--" if bb ever passes one (after it, the flag would be read as a plain argument).
seen=""
for a in "$@"; do
  shift
  if [ -z "$seen" ] && [ "$a" = "--" ]; then set -- "$@" --setting-sources user --; seen=1; else set -- "$@" "$a"; fi
done
[ -n "$seen" ] || set -- "$@" --setting-sources user
exec ${q(input.realClaude)} "$@"
`;
}

/**
 * The claude program: bb's own BB_CLAUDE_CODE_EXECUTABLE, then this process's PATH, then the places
 * Claude Code's installers use, in the order bb's own lookup uses. bb looks it up for a chat with that
 * chat's environment, which can carry a longer PATH than bb's server: a claude found only there (an
 * npm or nvm install, say) is not found here, and Local chats on Claude Code are then blocked with a
 * line in the plugin log. File checks only: no shell is started, so this never holds up bb's server.
 */
export function findRealClaude(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env.BB_CLAUDE_CODE_EXECUTABLE?.trim()) candidates.push(env.BB_CLAUDE_CODE_EXECUTABLE.trim());
  for (const dir of (env.PATH ?? "").split(":")) if (dir) candidates.push(path.join(dir, "claude"));
  candidates.push(path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  for (const c of candidates) {
    if (!c || c.includes(".claude-local")) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (!fs.statSync(c).isFile()) continue;
      // The path as found, not its target: an update of Claude Code replaces the versioned file behind it.
      return c;
    } catch {}
  }
  return null;
}

/** The Local settings folder: CLAUDE_CONFIG_DIR of every Local chat, with its own transcripts under projects/. */
export const localConfigPath = (home?: string) => path.join(localDir(home), "config");

/**
 * Local transcripts are kept in the Local settings folder, apart from the main ~/.claude/projects.
 * An older version linked that folder to the main one; the link is replaced here, but only when it
 * is a link that leads to the main projects folder. A real folder, or a link someone else made, is
 * left as it is. Chats started through the old link keep their history where it was written.
 */
export function ownProjectsFolder(config: string, mainProjects: string): void {
  const projects = path.join(config, "projects");
  let link: string | null = null;
  try {
    if (fs.lstatSync(projects).isSymbolicLink()) link = fs.readlinkSync(projects);
  } catch {}
  if (link !== null) {
    const target = path.resolve(path.dirname(projects), link);
    let same = target === path.resolve(mainProjects);
    if (!same) {
      try {
        same = fs.realpathSync(projects) === fs.realpathSync(mainProjects);
      } catch {}
    }
    if (!same) return;
    fs.unlinkSync(projects); // the link only; the main folder it pointed at is not touched
  }
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
}

/**
 * Claude Code's own tools a Local chat goes without, by default: scheduling (CronCreate, CronDelete,
 * CronList, ScheduleWakeup), watching (Monitor), agent teams and messages (SendMessage, ListAgents),
 * workflows (Workflow), worktrees (EnterWorktree, ExitWorktree), ReportFindings, and WebSearch (not
 * tried against a local runner; a Local chat keeps WebFetch for the web). Their definitions are most of
 * the first prompt: with them the base request was 78,247 characters (18,688 tokens read by LM
 * Studio); without them 35,145 (Claude Code 2.1.330, captured 22 Nov 2026). File work (Read, Edit,
 * Write, NotebookEdit), the shell (Bash), skills (Skill), agents (Agent, TaskStop), WebFetch and
 * every MCP tool (bb's own included) are kept. They are listed as deny rules in the Local settings
 * file, which Claude Code applies in every permission mode, so their definitions are not sent.
 */
export const LOCAL_TRIMMED_TOOLS = [
  "Monitor",
  "SendMessage",
  "ListAgents",
  "Workflow",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterWorktree",
  "ExitWorktree",
  "ReportFindings",
  "WebSearch",
] as const;

/** Everything a Local Claude chat needs on disk. Safe to run again; it only writes inside ~/.claude-local. */
export function ensureLocalClaude(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  /**
   * The loadout's options, all written here and nowhere else. allTools: keep every Claude Code tool (no deny
   * rules); the default leaves out LOCAL_TRIMMED_TOOLS. descriptions: let Claude Code show skill descriptions
   * (skillListingBudgetFraction SKILL_LISTING_BUDGET_FRACTION; without it every user skill is listed by name).
   */
  opts: { allTools?: boolean; descriptions?: boolean } = {},
): { ok: true; launcher: string; guard: string; secret: string; config: string } | { ok: false; reason: string } {
  const dir = localDir(home);
  const mainDir = path.join(home, ".claude");
  if (path.resolve(dir) === path.resolve(mainDir) || path.resolve(dir) === path.resolve(home)) return { ok: false, reason: "refusing to write into the main Claude folder" };
  // ~/.claude-local that is a link, or that resolves to the home folder or into ~/.claude, is never written through.
  const rootProblem = localRootProblem(home, dir);
  if (rootProblem) return { ok: false, reason: rootProblem };
  const real = findRealClaude(home, env);
  if (!real) return { ok: false, reason: "the claude program was not found on this Mac" };
  const config = localConfigPath(home);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  const secretFile = path.join(dir, "secret");
  let secret = "";
  try {
    secret = fs.readFileSync(secretFile, "utf8").trim();
  } catch {}
  if (!/^[A-Za-z0-9_-]{40,}$/.test(secret)) {
    secret = crypto.randomBytes(32).toString("base64url");
    fs.writeFileSync(secretFile, secret + "\n", { mode: 0o600 });
  }
  fs.chmodSync(secretFile, 0o600);
  // Local chats keep their history as long as the main setup keeps its own: the main clean-up period
  // is copied, since Claude Code's default would delete old transcripts sooner.
  let cleanupPeriodDays: unknown;
  try {
    cleanupPeriodDays = (JSON.parse(fs.readFileSync(path.join(mainDir, "settings.json"), "utf8")) as Json).cleanupPeriodDays;
  } catch {}
  const settings = {
    enabledPlugins: {},
    hooks: {},
    ...(typeof cleanupPeriodDays === "number" ? { cleanupPeriodDays } : {}),
    ...(opts.allTools ? {} : { permissions: { deny: [...LOCAL_TRIMMED_TOOLS] } }),
    ...(opts.descriptions ? { skillListingBudgetFraction: SKILL_LISTING_BUDGET_FRACTION } : {}),
  };
  const settingsFile = path.join(config, "settings.json");
  const settingsText = JSON.stringify(settings, null, 2) + "\n";
  let current = "";
  try {
    current = fs.readFileSync(settingsFile, "utf8");
  } catch {}
  if (current !== settingsText) {
    // Written to a temporary file and renamed over the old one: a Local chat starting at that moment reads
    // the old settings or the new ones, never half a file.
    const tmp = `${settingsFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, settingsText, { mode: 0o600 });
    fs.renameSync(tmp, settingsFile);
  }
  ownProjectsFolder(config, path.join(mainDir, "projects"));
  const launcher = launcherPath(home);
  const script = launcherScript({ secret, realClaude: real, configDir: config });
  let have = "";
  try {
    have = fs.readFileSync(launcher, "utf8");
  } catch {}
  if (have !== script) fs.writeFileSync(launcher, script, { mode: 0o700 });
  fs.chmodSync(launcher, 0o700);
  const guard = guardPath(home);
  const guardText = guardScript({ realClaude: real });
  let haveGuard = "";
  try {
    haveGuard = fs.readFileSync(guard, "utf8");
  } catch {}
  if (haveGuard !== guardText) fs.writeFileSync(guard, guardText, { mode: 0o700 });
  fs.chmodSync(guard, 0o700);
  return { ok: true, launcher, guard, secret, config };
}

export type LocalClaudeSetup = ReturnType<typeof ensureLocalClaude>;

/**
 * The secret a launcher already on disk holds (~/.claude-local/secret), read without setting anything up: after
 * a plugin reload the route takes it, so a Local turn that runs across the reload is not refused with 401, and
 * nothing is written at load. None when the Local folder is a link or resolves into ~/.claude, or the file is
 * missing or not a well-formed secret.
 */
export function readStoredSecret(home: string = os.homedir()): string | null {
  const dir = localDir(home);
  if (localRootProblem(home, dir)) return null;
  try {
    const file = path.join(dir, "secret");
    const st = fs.lstatSync(file);
    // A secret anyone other than its owner can read is no secret: refused.
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    const secret = fs.readFileSync(file, "utf8").trim();
    return /^[A-Za-z0-9_-]{40,}$/.test(secret) ? secret : null;
  } catch {
    return null;
  }
}
/** How long a failed setup is kept before it is tried again (a missing claude program, say). */
export const SETUP_RETRY_MS = 60_000;
/**
 * The setup as bb's server uses it: nothing while the feature is off; done on first real use (never at
 * load) and kept while it is on; a failure kept for SETUP_RETRY_MS, so a missing claude is not looked for on every request, and
 * warned about once per reason.
 */
export function createLocalClaudeSetup(deps: { on: () => boolean; ensure: () => LocalClaudeSetup; warn: (m: string) => void; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let last: LocalClaudeSetup | null = null;
  let failedAt = 0;
  let warned = "";
  const setup = (): LocalClaudeSetup => {
    let on = false;
    try {
      on = deps.on();
    } catch {
      on = false; // the profile could not be read: treated as off, so nothing is written
    }
    if (!on) return { ok: false, reason: "Local chats on Claude Code are off in Setup" };
    if (last?.ok) return last;
    if (last && now() - failedAt < SETUP_RETRY_MS) return last;
    try {
      last = deps.ensure();
    } catch (e) {
      last = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!last.ok) {
      failedAt = now();
      if (last.reason !== warned) {
        warned = last.reason;
        deps.warn(`local claude: not ready (${last.reason}); Local chats on Claude Code do not start`);
      }
    }
    return last;
  };
  /**
   * Runs the setup again now (a changed loadout: its options go into the Local settings file at once, with
   * no bb restart). Writes nothing while the feature is off.
   */
  const refresh = (): LocalClaudeSetup => {
    last = null;
    failedAt = 0;
    return setup();
  };
  /** The last good setup of this run, without setting anything up (the route's secret: a caller never makes the plugin write). */
  const current = (): Extract<LocalClaudeSetup, { ok: true }> | null => (last?.ok ? last : null);
  return Object.assign(setup, { refresh, current });
}

/**
 * The guard: what a Claude chat starts through when the plugin could not read whether it is Local.
 * A Claude model name starts the real claude with everything as bb set it (an Online chat goes on
 * as normal), and so do Bedrock's names for Claude: an arn:aws:bedrock: ARN, or anthropic.claude-... with or
 * without one of Bedrock's cross-region prefixes (us., eu., apac., us-gov., global., jp., au.);
 * any other name could be a Local chat's model, so the chat does not start rather than risk its
 * prompt going to an online account. A gateway's own alias for a Claude model is refused too.
 */
export function guardScript(input: { realClaude: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Written by navaigate-skin (server-local-claude.ts). Do not edit: it is rewritten when the plugin loads.
model=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--model" ]; then model="$a"; fi
  case "$a" in --model=*) model="\${a#--model=}" ;; esac
  prev="$a"
done
case "$model" in
  ""|claude-*|opus|sonnet|haiku|fable|opusplan|default|best|opus\\[1m\\]|sonnet\\[1m\\]|fable\\[1m\\]|arn:aws:bedrock:*|anthropic.claude-*|us.anthropic.claude-*|eu.anthropic.claude-*|apac.anthropic.claude-*|us-gov.anthropic.claude-*|global.anthropic.claude-*|jp.anthropic.claude-*|au.anthropic.claude-*) exec ${q(input.realClaude)} "$@" ;;
esac
echo "claude-guard: bb could not check whether this chat is Local, and its model ($model) is not a Claude model, so it does not start. Send again in a moment." >&2
exit 78
`;
}

type Fetch = typeof fetch;

/** The request to the runner, given to a Poster. */
export type UpstreamPost = { headers: Record<string, string>; body: string; signal: AbortSignal };
/** Sends the request for an answer to the runner on 127.0.0.1 and gives back its answer as it arrives. */
export type Poster = (url: string, init: UpstreamPost) => Promise<Response>;

/** Response statuses that carry no body (a Response with a body and one of these cannot be made). */
const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * The request for an answer, sent with node:http (node:https for an https origin) rather than fetch. A local model can be silent for
 * many minutes while it reads a long prompt (LM Studio sends its headers at once and then nothing;
 * a runner may also hold its headers until its first token). fetch in Node (undici) stops such an
 * answer after 300 s with no bytes (bodyTimeout, measured: UND_ERR_BODY_TIMEOUT at 301 s, Node
 * 24.21) and also waits at most 300 s for headers. node:http sets no time limit on a request unless
 * asked, needs no package (undici is not one of this plugin's dependencies, and bb's runtime bundles
 * its own copy), and behaves the same on bb's own builds and on standard bb 0.49 (Node 24.22).
 * Stopping is kept: the caller's signal and cancelling the answer's body each close the connection
 * at once, so the runner stops working on a request nobody waits for.
 */
export const httpPost: Poster = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const reason = () => (init.signal.reason instanceof Error ? init.signal.reason : new Error("The request was stopped."));
    if (init.signal.aborted) return reject(reason());
    const body = Buffer.from(init.body, "utf8");
    // An https:// origin (OLLAMA_HOST may name one on this Mac) goes through node:https, which checks the
    // certificate the way the orb's own checks (fetch) do, so the two always agree on whether Ollama answers.
    const req = (url.startsWith("https:") ? https : http).request(url, { method: "POST", headers: { ...init.headers, "content-length": String(body.length) } });
    let settled = false;
    let finish: (e?: Error) => void = () => {};
    const onAbort = () => {
      const e = reason();
      req.destroy(e);
      finish(e);
    };
    init.signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => {
      if (!settled) {
        settled = true;
        init.signal.removeEventListener("abort", onAbort);
        reject(e);
      } else finish(e);
    });
    req.on("response", (res) => {
      settled = true;
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) for (const one of v) headers.append(k, one);
        else if (typeof v === "string") headers.set(k, v);
      }
      const status = res.statusCode ?? 502;
      if (NO_BODY.has(status)) {
        init.signal.removeEventListener("abort", onAbort);
        res.resume();
        return resolve(new Response(null, { status, headers }));
      }
      let done = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          finish = (e?: Error) => {
            if (done) return;
            done = true;
            init.signal.removeEventListener("abort", onAbort);
            if (e) controller.error(e);
            else controller.close();
          };
          res.on("data", (chunk: Buffer) => {
            if (done) return;
            controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            if ((controller.desiredSize ?? 1) <= 0) res.pause();
          });
          res.on("end", () => finish());
          res.on("error", (e) => finish(e));
          res.on("close", () => {
            if (!res.complete) finish(new Error(`The connection to ${new URL(url).host} closed before the answer was complete.`));
          });
        },
        pull() {
          res.resume();
        },
        cancel() {
          // Claude Code went away (or bb stopped the chat): close the connection so the runner stops too.
          done = true;
          init.signal.removeEventListener("abort", onAbort);
          req.destroy();
        },
      });
      resolve(new Response(stream, { status, headers }));
    });
    req.end(body);
  });

/** The same with fetch, for tests that hand the route their own fetch. */
export const fetchPost =
  (f: Fetch): Poster =>
  (url, init) =>
    f(url, { method: "POST", headers: init.headers, body: init.body, signal: init.signal });

/** How often the route tells Claude Code it is still there while the runner sends nothing. */
export const PING_EVERY_MS = 30_000;
/** How long the route waits for a runner's headers before it sends its own and starts the pings (one ping period). */
export const EARLY_HEADERS_MS = PING_EVERY_MS;
/** Anthropic's own keep-alive event, as its streaming API sends it. */
export const PING_EVENT = 'event: ping\ndata: {"type": "ping"}\n\n';

/**
 * A streamed answer (server-sent events) passed on unchanged, with one Anthropic `ping` event added
 * whenever the runner has sent nothing for PING_EVERY_MS. Claude Code drops a stream after 300 s
 * with no bytes and sends the whole request again (measured, Claude Code 2.1.330); a local model
 * reading a long prompt is silent for longer than that. A ping goes only between events (nothing
 * sent yet, or what was sent ends with a blank line), never inside one; while the runner is silent
 * in the middle of an event, no ping is sent (the launcher's longer idle limit covers that case).
 * Silence counts only while the route is waiting for the runner, not while Claude Code is slow to
 * read. Cancelling the result cancels the runner's stream at once. A fast answer gets no ping, so
 * it reaches Claude Code byte for byte as the runner sent it. `immediate` sends one ping at the start.
 */
export function withPings(
  source: ReadableStream<Uint8Array>,
  opts: { everyMs?: number; onEnd?: (pings: number) => void; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; immediate?: boolean } = {},
): ReadableStream<Uint8Array> {
  const every = opts.everyMs ?? PING_EVERY_MS;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  const ping = new TextEncoder().encode(PING_EVENT);
  const reader = source.getReader();
  let tail: number[] = []; // the last bytes sent, to know whether the stream stands between two events
  let waiting = false;
  let closed = false;
  let pings = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let arm = () => {};
  const between = () => {
    if (tail.length === 0) return true;
    const n = tail.length;
    return (tail[n - 1] === 10 && tail[n - 2] === 10) || (n >= 4 && tail[n - 1] === 10 && tail[n - 2] === 13 && tail[n - 3] === 10 && tail[n - 4] === 13);
  };
  const end = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimer(timer);
    opts.onEnd?.(pings);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      arm = () => {
        if (timer !== undefined) clearTimer(timer);
        timer = setTimer(() => {
          if (closed) return;
          try {
            if (waiting && between()) {
              controller.enqueue(ping);
              pings++;
            }
            arm();
          } catch {
            // The stream can no longer take a ping (it was closed or errored meanwhile): stop the timer for good.
            end();
          }
        }, every);
      };
      // The route has just sent its own headers after a silent wait: a first ping at once.
      if (opts.immediate) {
        controller.enqueue(ping);
        pings++;
      }
      arm();
    },
    async pull(controller) {
      waiting = true;
      let chunk: Uint8Array;
      // Read until a chunk with bytes or the end: an empty chunk enqueues nothing, and a pull that
      // enqueues nothing may not be called again, which would stall the answer.
      for (;;) {
        let got: ReadableStreamReadResult<Uint8Array>;
        try {
          got = await reader.read();
        } catch (e) {
          waiting = false;
          end();
          controller.error(e);
          return;
        }
        if (closed) {
          waiting = false;
          return;
        }
        if (got.done) {
          waiting = false;
          end();
          controller.close();
          return;
        }
        if (got.value.byteLength > 0) {
          chunk = got.value;
          break;
        }
      }
      waiting = false;
      controller.enqueue(chunk);
      tail = [...tail, ...chunk.subarray(Math.max(0, chunk.byteLength - 4))].slice(-4);
      arm(); // the silence is counted from the runner's last bytes
    },
    async cancel(why) {
      end();
      await reader.cancel(why).catch(() => undefined);
    },
  });
}

/** The error type Ollama gave, from a fixed list; anything else is "unknown". Never its free text. */
const OLLAMA_ERROR_TYPES = ["api_error", "invalid_request_error", "not_found_error", "overloaded_error", "rate_limit_error", "authentication_error", "permission_error", "request_too_large"] as const;
export function ollamaErrorType(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown } };
    const type = parsed?.error?.type;
    return typeof type === "string" && (OLLAMA_ERROR_TYPES as readonly string[]).includes(type) ? type : "unknown";
  } catch {
    return "not JSON";
  }
}

/**
 * How long the route remembers a request the runner failed, so an identical repeat is answered at once
 * without the runner reading the whole prompt again. Claude Code repeats a failed request on its own: after a
 * late error it asks once more without streaming, a 400 three times, a 500, 503 or 529 eight times or more
 * over minutes (measured with a stub, Claude Code 2.1.330, 22 Nov 2026); on Ollama each repeat is a full read.
 */
export const FAILURE_MEMORY_MS = 30_000;
/** At most this many failed requests are remembered (only a fingerprint of each, never the request). */
export const FAILURE_MEMORY_MAX = 50;
/**
 * The fingerprint of a request for the failure memory: the runner and the WHOLE request except whether it
 * streams (so Claude Code's whole-request repeat of a streamed one can match). Any other difference (the
 * answer's length, the effort, a new chat's own session data) makes it a new request that goes to the runner.
 * A SHA-256 digest; the request itself is never kept.
 */
export function requestFingerprint(url: string, out: Record<string, unknown>): string {
  const { stream: _stream, ...rest } = out;
  return crypto.createHash("sha256").update(JSON.stringify([url, rest])).digest("hex");
}

/** At most this many Claude Code sessions are remembered by the route for "first request" (hashes, in memory). */
export const SESSIONS_SEEN_MAX = 2_000;

/** At most one log line this often for callers refused for want of the secret. */
export const UNAUTHORISED_LOG_MS = 10 * 60_000;

/** The route Claude Code calls for a Local chat. */
export function createLocalClaudeRoute(deps: {
  secret: () => string | null;
  /** For the short reads (the model lists); also for the request for an answer when no `post` is given. */
  fetch?: Fetch;
  /** The request for an answer; default httpPost (no time limit), or fetchPost(fetch) when a test gives its own fetch. */
  post?: Poster;
  pingEveryMs?: number;
  /** How long a streamed request waits for the runner's headers before the route answers 200 itself (EARLY_HEADERS_MS). */
  earlyHeadersMs?: number;
  log?: (m: string) => void;
  ollama?: string | null;
  now?: () => number;
  /**
   * Called for a Local chat's first request (firstPromptOf, and the first request with tools of its Claude Code
   * session in this run), as it is sent; the function it returns gets what the runner read once the answer has
   * ended well. For bb's measured share; never called for any other request.
   */
  firstPrompt?: (seen: { tools: number; trimmed: boolean; user: number }) => (input: number) => void;
}) {
  const f: Fetch = deps.fetch ?? fetch;
  const post: Poster = deps.post ?? (deps.fetch ? fetchPost(deps.fetch) : httpPost);
  // The same Ollama address as the orb's checks (server-local-models.ts); null when it is another machine's.
  const ollamaBase = deps.ollama === undefined ? OLLAMA_BASE : deps.ollama;
  const OLLAMA = ollamaBase ?? "http://127.0.0.1:0";
  let models: { at: number; names: Set<string>; remote: Set<string> } | null = null;
  const known = async (): Promise<{ names: Set<string>; remote: Set<string> }> => {
    if (models && Date.now() - models.at < 60_000) return models;
    const res = await f(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { models?: Array<{ name?: string; remote_host?: string; remote_model?: string }> };
    const list = (body.models ?? []).filter((m) => m.name);
    models = { at: Date.now(), names: new Set(list.map((m) => String(m.name))), remote: new Set(list.filter(isRemoteModel).map((m) => String(m.name))) };
    return models;
  };
  // Log lines carry names, counts and reasons only, never prompt text.
  const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
  const now = deps.now ?? Date.now;
  // Callers without the secret are not logged one by one (anyone who reaches bb's server can call the
  // route): the first is, then at most one line every UNAUTHORISED_LOG_MS with how many there were.
  let refused = 0;
  let refusedLoggedAt = -Infinity;
  const error = (status: number, type: string, message: string, asked = "") => {
    if (status === 401) {
      refused++;
      if (now() - refusedLoggedAt >= UNAUTHORISED_LOG_MS) {
        deps.log?.(`local claude: answered 401 (${type}) to ${refused} request${refused === 1 ? "" : "s"} without the secret: ${clean(message)}`);
        refusedLoggedAt = now();
        refused = 0;
      }
    } else deps.log?.(`local claude: answered ${status} (${type})${asked ? ` for model "${clean(asked)}"` : ""}: ${clean(message)}`);
    return new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json" } });
  };
  const authorised = (req: Request): boolean => {
    const secret = deps.secret();
    if (!secret) return false;
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    const key = req.headers.get("x-api-key") ?? "";
    return safeEqual(bearer, secret) || safeEqual(key, secret);
  };

  /** Sends the rewritten request to the local server (Ollama or LM Studio) and streams its answer back. */
  /** The runner's streamed answer as Claude Code gets it: LM Studio's counts put the Anthropic way, text untouched; read on the side for a first request. */
  const answerStream = (upstream: Response, server: string, onRead?: (input: number) => void): ReadableStream<Uint8Array> => {
    const raw = onRead ? upstream.body!.pipeThrough(usageTap(onRead)) : upstream.body!;
    return server === "LM Studio" ? raw.pipeThrough(lmStudioUsageStream()) : raw;
  };
  // The Claude Code sessions whose first request with tools the route has seen in this run (SHA-256 of the
  // session id, in memory only, the oldest dropped past SESSIONS_SEEN_MAX): a subagent's first request carries
  // its chat's session and comes after the chat's own first, so it is never taken for it.
  const sessionsSeen = new Set<string>();
  const firstOf = (req: Request, body: Json): ((input: number) => void) | undefined => {
    if (!deps.firstPrompt || !Array.isArray(body.tools) || body.tools.length === 0) return undefined;
    const session = (req.headers.get("x-claude-code-session-id") ?? "").trim();
    if (!session) return undefined;
    const key = crypto.createHash("sha256").update(session).digest("hex");
    if (sessionsSeen.has(key)) return undefined;
    sessionsSeen.add(key);
    if (sessionsSeen.size > SESSIONS_SEEN_MAX) sessionsSeen.delete(sessionsSeen.values().next().value as string);
    const seen = firstPromptOf(body);
    if (!seen) return undefined;
    try {
      return deps.firstPrompt(seen);
    } catch {
      return undefined;
    }
  };
  const isStream = (upstream: Response) => (upstream.headers.get("content-type") ?? "").includes("text/event-stream") && upstream.body !== null;
  const pingLog = (model: string, started: number) => (pings: number) => {
    if (pings > 0) deps.log?.(`local claude: ${model} was silent for a while: ${pings} keep-alive ping${pings === 1 ? "" : "s"} sent, answer finished after ${Math.round((Date.now() - started) / 1000)} s`);
  };
  const firstLog = (model: string, out: Json, status: number, started: number) =>
    deps.log?.(
      `local claude: ${model} status ${status}, ${Array.isArray(out.messages) ? out.messages.length : 0} messages, ${Array.isArray(out.tools) ? out.tools.length : 0} tools, first byte after ${Date.now() - started} ms`,
    );
  /**
   * The error type of a late error event (after the route's own early 200). Measured with Claude Code 2.1.330 against a
   * stub (22 Nov 2026): after an error event of type api_error, invalid_request_error or not_found_error it made no
   * second streamed attempt and asked once more without streaming (that answer's status then decides: 404 once, 400
   * three times, 500/503/529 eight or more times with waits); after overloaded_error it streamed again three more times.
   * A runner that answered with an error has read the whole prompt, so no type here asks for a streamed retry:
   * only the two measured types pass; every other type is sent as api_error.
   */
  const lateErrorType = (type: string) => (type === "invalid_request_error" || type === "not_found_error" ? type : "api_error");
  const sseError = (type: string, message: string) => new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`);

  // Requests the runner failed (fingerprints only), answered again from here for FAILURE_MEMORY_MS, while the
  // runner's own state for that model is what it was then.
  const failures = new Map<string, { at: number; status: number; type: string; message: string; state: Promise<string> }>();
  /**
   * What the runner holds for the model now, read cheaply (Ollama's /api/ps, LM Studio's model list): a model
   * loaded, unloaded or loaded again since a failure makes the route send the same request again.
   */
  const runnerState = async (url: string, model: string): Promise<string> => {
    try {
      if (url.startsWith(LMSTUDIO)) {
        const entry = await lmStudioModel(f, model);
        return `lmstudio:${(entry?.loaded_instances ?? []).map((i) => `${i.id ?? ""}/${i.config?.context_length ?? ""}`).join(",")}`;
      }
      const res = await f(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string; size?: number; size_vram?: number }> };
      const m = (body.models ?? []).find((x) => (x.name ?? x.model) === model);
      return m ? `ollama:loaded:${m.size ?? ""}/${m.size_vram ?? ""}` : "ollama:not loaded";
    } catch {
      return "unknown";
    }
  };
  const messageOf = (text: string, fallback: string): string => {
    try {
      const m = (JSON.parse(text) as { error?: { message?: unknown } | string })?.error;
      const said = typeof m === "string" ? m : typeof m?.message === "string" ? m.message : "";
      return said || fallback;
    } catch {
      return fallback;
    }
  };
  /**
   * The runner's error as the route answers it, and remembers it. A runner 5xx other than 503 becomes 400
   * invalid_request_error with the runner's own message: Claude Code repeats a 5xx eight or more times with
   * waits, each one a full read on Ollama, and repeating cannot help a request the runner has already failed.
   * 503 (the runner is not running, or busy) passes as it is and is not remembered: starting it can help.
   */
  const runnerError = (key: string, status: number, text: string, server: string, url: string, model: string): { status: number; text: string } => {
    if (status === 503) return { status, text };
    let answer = { status, text };
    const said = messageOf(text, "");
    if (status >= 500) {
      const message = said ? `${server} answered ${status}: ${said}` : `${server} answered ${status}.`;
      answer = { status: 400, text: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }) };
    }
    const type = status >= 500 ? "invalid_request_error" : ollamaErrorType(text) === "not_found_error" ? "not_found_error" : "invalid_request_error";
    if (failures.size >= FAILURE_MEMORY_MAX) failures.delete(failures.keys().next().value as string);
    const state = runnerState(url, model);
    failures.set(key, { at: now(), status: answer.status, type, message: said || `${server} answered ${status}`, state });
    return answer;
  };
  const forward = async (url: string, out: Json, model: string, req: Request, onRead?: (input: number) => void): Promise<Response> => {
    const server = url.startsWith(LMSTUDIO) ? "LM Studio" : "Ollama";
    const started = Date.now();
    const key = requestFingerprint(url, out);
    const failed = failures.get(key);
    // The same request again, soon after the runner failed it, with the runner's state for the model unchanged:
    // answered from here, saying so. A changed request, a model loaded or unloaded since, or a later try goes on.
    if (failed && now() - failed.at < FAILURE_MEMORY_MS && (await failed.state) === (await runnerState(url, model))) {
      deps.log?.(`local claude: answered ${failed.status} for model "${clean(model)}" from memory: ${server} failed this same request ${Math.round((now() - failed.at) / 1000)} s ago, so it is not sent again`);
      // The runner was not asked this time, so the words never say it answered.
      const message = `${server} refused this a moment ago, so it was not sent again: ${failed.message}. Send again in half a minute, or change your message, to try once more.`;
      return new Response(JSON.stringify({ type: "error", error: { type: failed.type, message } }), { status: failed.status, headers: { "content-type": "application/json" } });
    }
    if (failed) failures.delete(key);
    // Stopped when Claude Code goes away (bb aborts req.signal) or cancels the answer: either one closes
    // the connection to the runner at once.
    const stop = new AbortController();
    const abort = () => stop.abort(req.signal.reason);
    if (req.signal.aborted) abort();
    else req.signal.addEventListener("abort", abort, { once: true });
    const pending = post(url, {
      headers: { "content-type": "application/json", "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01" },
      body: JSON.stringify(out),
      signal: stop.signal,
    });
    // A runner can hold its headers until its first word: Ollama sends none while it reads the prompt
    // (134.5 s for a first Claude Code prompt on a 27B model, 22 Nov 2026). Claude Code waits 360 s for
    // headers (600 s on 2.1.330 with the launcher's idle setting) and then sends the whole request again.
    // So for a streamed request whose runner has not answered
    // within EARLY_HEADERS_MS, the route answers 200 itself and keeps Claude Code waiting with pings; a
    // runner that answers in time is passed on exactly as before, its status included.
    const settled = pending.then(
      (r) => ({ r }) as const,
      (e: unknown) => ({ e }) as const,
    );
    let wait: ReturnType<typeof setTimeout> | undefined;
    const early =
      out.stream === true ? await Promise.race([settled, new Promise<null>((r) => (wait = setTimeout(() => r(null), deps.earlyHeadersMs ?? EARLY_HEADERS_MS)))]) : await settled;
    if (wait !== undefined) clearTimeout(wait);
    if (early === null) {
      deps.log?.(`local claude: ${model}: ${server} has not answered after ${Math.round((Date.now() - started) / 1000)} s; Claude Code is kept waiting with pings`);
      let body: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const late = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!body) {
            const got = await settled;
            if ("e" in got) {
              if (stop.signal.aborted) {
                deps.log?.(`local claude: ${model}: stopped by Claude Code before ${server} answered`);
                return controller.close();
              }
              deps.log?.(`local claude: answered 502 (api_error) for model "${clean(model)}": ${server} did not answer`);
              controller.enqueue(sseError("api_error", `${server} did not answer (${got.e instanceof Error ? got.e.message : String(got.e)}).`));
              return controller.close();
            }
            const upstream = got.r;
            firstLog(model, out, upstream.status, started);
            if (!upstream.ok || !isStream(upstream)) {
              // The headers are already sent, so the runner's error goes to Claude Code the way Anthropic's
              // streaming API sends one: an error event. Only its status and type are logged.
              const text = await upstream.text().catch(() => "");
              if (!upstream.ok) runnerError(key, upstream.status, text, server, url, model); // remembered for the whole-request repeat
              const type = upstream.ok ? "api_error" : ollamaErrorType(text);
              let message = upstream.ok ? `${server} did not stream its answer.` : `${server} answered ${upstream.status}.`;
              try {
                const m = (JSON.parse(text) as { error?: { message?: unknown } })?.error?.message;
                if (typeof m === "string" && m) message = m;
              } catch {}
              deps.log?.(`local claude: answered ${upstream.status} (from ${server}, ${type}) for model "${clean(model)}", as an error event`);
              controller.enqueue(sseError(lateErrorType(type), message));
              return controller.close();
            }
            body = answerStream(upstream, server, onRead).getReader();
          }
          const next = await body.read();
          if (next.done) return controller.close();
          controller.enqueue(next.value);
        },
        async cancel(why) {
          stop.abort(why);
          await body?.cancel(why).catch(() => undefined);
        },
      });
      return new Response(withPings(late, { everyMs: deps.pingEveryMs, onEnd: pingLog(model, started), immediate: true }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      });
    }
    if ("e" in early) {
      if (stop.signal.aborted) {
        deps.log?.(`local claude: ${model}: stopped by Claude Code before ${server} answered`);
        return new Response(null, { status: 502 }); // nobody reads it: the caller has gone
      }
      return error(502, "api_error", `${server} did not answer (${early.e instanceof Error ? early.e.message : String(early.e)}).`, model);
    }
    const upstream = early.r;
    firstLog(model, out, upstream.status, started);
    const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
    if (!upstream.ok) {
      // The body is passed on unchanged, but only the status and error type are logged: free text
      // (a tool-call parse error, say) can quote what the model wrote, and that can contain the prompt.
      const text = await upstream.text().catch(() => "");
      const answer = runnerError(key, upstream.status, text, server, url, model);
      deps.log?.(`local claude: answered ${answer.status} (from ${server}: ${upstream.status}, ${ollamaErrorType(text)}) for model "${clean(model)}"`);
      return new Response(answer.text, { status: answer.status, headers: answer.status === upstream.status ? headers : new Headers({ "content-type": "application/json", "cache-control": "no-store" }) });
    }
    if (isStream(upstream)) {
      const keptAlive = withPings(answerStream(upstream, server, onRead), { everyMs: deps.pingEveryMs, onEnd: pingLog(model, started) });
      return new Response(keptAlive, { status: upstream.status, headers });
    }
    if (server === "LM Studio") {
      const text = await upstream.text();
      try {
        const answer = JSON.parse(text) as { usage?: unknown };
        fixLmStudioUsage(answer.usage);
        return new Response(JSON.stringify(answer), { status: upstream.status, headers });
      } catch {
        return new Response(text, { status: upstream.status, headers });
      }
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  };

  return {
    async messages(req: Request): Promise<Response> {
      const header = (req.headers.get("x-nav-local-model") ?? "").trim();
      // The route is open to anyone who reaches bb's server, so nothing from a caller without the secret is logged.
      if (!authorised(req)) return error(401, "authentication_error", "This route is for Local chats started by bb on this Mac.");
      deps.log?.(`local claude: request in, chat model "${clean(header)}"`);
      let body: Json;
      try {
        body = (await req.json()) as Json;
      } catch {
        return error(400, "invalid_request_error", "The request was not JSON.", header);
      }
      // The chat's own model comes first: the launcher sets the header from the chat's Local mark, and
      // only the launcher holds the secret. The request's own model name is a fallback for an older
      // launcher; a Claude name there (a later turn, a side job) never decides anything.
      const asked = typeof body.model === "string" ? body.model : "";
      // An LM Studio chat: the launcher names it "lmstudio/<key>". It must be loaded with the full
      // window, because LM Studio would otherwise load it on demand with 4,096 tokens.
      const lm = isLmStudio(header) ? header : !header && isLmStudio(asked) ? asked : "";
      if (lm) {
        const key = lm.slice(LMSTUDIO_PREFIX.length);
        const ready = await lmStudioReady(f, key);
        if (!ready.ok) return error(ready.status, ready.type, ready.message, lm);
        return forward(`${LMSTUDIO}/v1/messages`, rewriteRequest(body, key), key, req, firstOf(req, body));
      }
      if (!ollamaBase) return error(403, "permission_error", `${OLLAMA_ELSEWHERE_REASON}.`, asked || header);
      let names: Set<string>;
      let remote: Set<string>;
      try {
        ({ names, remote } = await known());
      } catch {
        return error(503, "api_error", "Ollama is not running on this Mac. Start Ollama, then send again.", asked || header);
      }
      const model = (header ? ollamaName(names, header) : null) ?? (asked ? ollamaName(names, asked) : null) ?? "";
      if (!model) return error(404, "not_found_error", `No local model called "${asked || header}" on this Mac. Pick one from the Local orb.`, asked || header);
      // A Local chat's prompt stays on this Mac: a model Ollama serves from its cloud is refused.
      if (remote.has(model)) return error(403, "permission_error", `${REMOTE_REASON} (${model}).`, model);
      return forward(`${OLLAMA}/v1/messages`, rewriteRequest(body, model), model, req, firstOf(req, body));
    },
    /** Claude Code asks for a token count now and then; a local model has no such service, so this is an estimate. */
    async countTokens(req: Request): Promise<Response> {
      if (!authorised(req)) return error(401, "authentication_error", "This route is for Local chats started by bb on this Mac.");
      const text = await req.text();
      return new Response(JSON.stringify({ input_tokens: Math.ceil(text.length / 3.6) }), { headers: { "content-type": "application/json" } });
    },
  };
}

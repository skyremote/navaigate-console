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
import os from "node:os";
import path from "node:path";
import { LMSTUDIO, LMSTUDIO_PREFIX, LOCAL_WINDOW_TOKENS, OLLAMA_BASE, OLLAMA_ELSEWHERE_REASON, REMOTE_REASON, isLmStudio, isRemoteModel, lmStudioReady, ollamaName } from "./server-local-models";

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
const OUTPUT_TOKENS = 8_192;

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

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The launcher: a POSIX shell script, so the Agent SDK can start it as the claude program. */
export function launcherScript(input: { secret: string; realClaude: string; configDir: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Written by navaigate-skin (server-local-claude.ts). Do not edit: it is rewritten when the plugin loads.
# Starts Claude Code for a Local chat: the model is on this Mac (Ollama), reached through bb.
if [ -z "$NAV_LOCAL_BASE_URL" ]; then
  echo "claude-local: no local route was given, so this chat does not start" >&2
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
export ANTHROPIC_BASE_URL="$NAV_LOCAL_BASE_URL"
export ANTHROPIC_AUTH_TOKEN=${q(input.secret)}
unset ANTHROPIC_API_KEY
if [ -n "$model" ]; then
  export ANTHROPIC_CUSTOM_HEADERS="x-nav-local-model: $model"
  export ANTHROPIC_SMALL_FAST_MODEL="$model"
  export CLAUDE_CODE_SUBAGENT_MODEL="$model"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="$model"
fi
export CLAUDE_CONFIG_DIR=${q(input.configDir)}
export ENABLE_TOOL_SEARCH=false
unset _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${CONTEXT_TOKENS}
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=${OUTPUT_TOKENS}
# No billing line at the top of the prompt: it changes every request and would make the model read it all again.
export CLAUDE_CODE_ATTRIBUTION_HEADER=0
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
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

/** Everything a Local Claude chat needs on disk. Safe to run again; it only writes inside ~/.claude-local. */
export function ensureLocalClaude(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): { ok: true; launcher: string; guard: string; secret: string; config: string } | { ok: false; reason: string } {
  const dir = localDir(home);
  const mainDir = path.join(home, ".claude");
  if (path.resolve(dir) === path.resolve(mainDir) || path.resolve(dir) === path.resolve(home)) return { ok: false, reason: "refusing to write into the main Claude folder" };
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
  const settings = { enabledPlugins: {}, hooks: {}, ...(typeof cleanupPeriodDays === "number" ? { cleanupPeriodDays } : {}) };
  const settingsFile = path.join(config, "settings.json");
  const settingsText = JSON.stringify(settings, null, 2) + "\n";
  let current = "";
  try {
    current = fs.readFileSync(settingsFile, "utf8");
  } catch {}
  if (current !== settingsText) fs.writeFileSync(settingsFile, settingsText, { mode: 0o600 });
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
/** How long a failed setup is kept before it is tried again (a missing claude program, say). */
export const SETUP_RETRY_MS = 60_000;
/**
 * The setup as bb's server uses it: nothing while the feature is off; done once and kept while it is
 * on; a failure kept for SETUP_RETRY_MS, so a missing claude is not looked for on every request, and
 * warned about once per reason.
 */
export function createLocalClaudeSetup(deps: { on: () => boolean; ensure: () => LocalClaudeSetup; warn: (m: string) => void; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let last: LocalClaudeSetup | null = null;
  let failedAt = 0;
  let warned = "";
  return (): LocalClaudeSetup => {
    let on = false;
    try {
      on = deps.on();
    } catch {
      on = false; // the profile could not be read: treated as off, so nothing is written
    }
    if (!on) return { ok: false, reason: "Local chats on Claude Code are switched off" };
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

/** At most one log line this often for callers refused for want of the secret. */
export const UNAUTHORISED_LOG_MS = 10 * 60_000;

/** The route Claude Code calls for a Local chat. */
export function createLocalClaudeRoute(deps: { secret: () => string | null; fetch?: Fetch; log?: (m: string) => void; ollama?: string | null; now?: () => number }) {
  const f: Fetch = deps.fetch ?? fetch;
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
  const forward = async (url: string, out: Json, model: string, req: Request): Promise<Response> => {
    const server = url.startsWith(LMSTUDIO) ? "LM Studio" : "Ollama";
    const started = Date.now();
    let upstream: Response;
    try {
      upstream = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01" },
        body: JSON.stringify(out),
        signal: req.signal,
      });
    } catch (e) {
      return error(502, "api_error", `${server} did not answer (${e instanceof Error ? e.message : String(e)}).`, model);
    }
    deps.log?.(
      `local claude: ${model} status ${upstream.status}, ${Array.isArray(out.messages) ? out.messages.length : 0} messages, ${Array.isArray(out.tools) ? out.tools.length : 0} tools, first byte after ${Date.now() - started} ms`,
    );
    const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
    if (!upstream.ok) {
      // The body is passed on unchanged, but only the status and error type are logged: free text
      // (a tool-call parse error, say) can quote what the model wrote, and that can contain the prompt.
      const text = await upstream.text().catch(() => "");
      deps.log?.(`local claude: answered ${upstream.status} (from ${server}, ${ollamaErrorType(text)}) for model "${clean(model)}"`);
      return new Response(text, { status: upstream.status, headers });
    }
    if (server === "LM Studio") {
      // LM Studio's token counts are put the Anthropic way (fixLmStudioUsage); the text is untouched.
      if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream") && upstream.body)
        return new Response(upstream.body.pipeThrough(lmStudioUsageStream()), { status: upstream.status, headers });
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
        return forward(`${LMSTUDIO}/v1/messages`, rewriteRequest(body, key), key, req);
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
      return forward(`${OLLAMA}/v1/messages`, rewriteRequest(body, model), model, req);
    },
    /** Claude Code asks for a token count now and then; a local model has no such service, so this is an estimate. */
    async countTokens(req: Request): Promise<Response> {
      if (!authorised(req)) return error(401, "authentication_error", "This route is for Local chats started by bb on this Mac.");
      const text = await req.text();
      return new Response(JSON.stringify({ input_tokens: Math.ceil(text.length / 3.6) }), { headers: { "content-type": "application/json" } });
    },
  };
}

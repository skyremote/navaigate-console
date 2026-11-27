// Runs the person's own Claude Code CLI with only the Artifact tool, the documented way to list and
// publish claude.ai artifacts (https://code.claude.com/docs/en/artifacts).
//
// - CLAUDE_CODE_ARTIFACT=1 turns the Artifact tool on in print (-p) mode, where it is off by default.
// - bb's and Anthropic's own variables are removed (by prefix) so the CLI uses the person's claude.ai
//   login, not bb's agent proxy, and an API key in the environment can't take over.
// - The CLI loads no MCP servers, no user settings or hooks, no slash commands, and saves no session.
// - A list run has only the Artifact tool. A publish run also has Read, but nothing is pre-approved
//   except Artifact, and its only working folder is a private copy of the one page being published,
//   so it can't read or publish anything else on the machine.
// - CLAUDE_CODE_ARTIFACT_PUBLISH_EDITS=0: publishing never edits a file.
// - Never through a shell. A timed-out or unloaded run is killed with its whole process tree.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

const WIN = process.platform === "win32";

/** Variables bb or an agent session may set that would point the CLI away from the person's login. */
const STRIP_PREFIXES = ["CLAUDE_CODE_", "_CLAUDE_CODE_", "CLAUDECODE", "CLAUDE_AGENT_SDK", "BB_", "ANTHROPIC_"];
const STRIP_EXACT = ["CLAUDE_PID", "CLAUDE_EFFORT"];

export function cleanEnv(claudeCmd: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const k = key.toUpperCase();
    if (STRIP_PREFIXES.some((p) => k.startsWith(p)) || STRIP_EXACT.includes(k)) continue;
    env[key] = value;
  }
  // Apps opened from the macOS Finder get a minimal PATH; Homebrew and npm installs need these.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const extraDirs = [dirname(claudeCmd), ...(WIN ? [] : ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")])].filter((d) => d && d !== ".");
  env[pathKey] = [...new Set([...extraDirs, ...(env[pathKey] ?? "").split(delimiter)])].filter(Boolean).join(delimiter);
  return { ...env, ...extra };
}

export type ClaudeCommand = { cmd: string; prefix: string[] };

/**
 * How to start Claude Code: the setting if given, else the usual install places, else `claude` on
 * PATH. An npm install on Windows is a `.cmd` shim, which can't run without a shell, so its script
 * is run with `node` instead.
 */
export function findClaude(setting: string): ClaudeCommand {
  const home = homedir();
  const candidates = setting.trim()
    ? [setting.trim()]
    : WIN
      ? [join(home, ".local", "bin", "claude.exe"), join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm", "claude.cmd")]
      : [join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(home, ".claude", "local", "claude")];
  const found = candidates.find((p) => existsSync(p)) ?? (setting.trim() || "claude");
  if (/\.(cmd|bat)$/i.test(found)) {
    const script = join(dirname(found), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(script)) return { cmd: "node", prefix: [script] };
  }
  return { cmd: found, prefix: [] };
}

type Run = { code: number | null; stdout: string; stderr: string; timedOut: boolean; notFound: boolean };

const live = new Set<ChildProcess>();

function killTree(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (WIN) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

/** Kill every Claude Code run still going (plugin unload). */
export function killAll() {
  for (const child of live) killTree(child);
  live.clear();
}

export function runProcess(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ChildProcess;
    try {
      // detached on POSIX makes the child a process-group leader, so killTree can end its children too.
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !WIN });
    } catch (cause) {
      resolve({ code: null, stdout, stderr: String(cause), timedOut, notFound: true });
      return;
    }
    live.add(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      live.delete(child);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut, notFound: err.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      live.delete(child);
      resolve({ code, stdout, stderr, timedOut, notFound: code === 127 || (WIN && code === 9009) });
    });
  });
}

export type ClaudeStatus = { installed: boolean; loggedIn: boolean; email: string | null; plan: string | null; error: string | null };

const NOT_FOUND = "Claude Code wasn't found on this computer. Install it (https://code.claude.com), or set its path in this plugin's settings.";

export async function claudeStatus(claude: ClaudeCommand): Promise<ClaudeStatus> {
  const r = await runProcess(claude.cmd, [...claude.prefix, "auth", "status"], { env: cleanEnv(claude.cmd), timeoutMs: 30_000 });
  if (r.notFound) return { installed: false, loggedIn: false, email: null, plan: null, error: NOT_FOUND };
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    const loggedIn = j.loggedIn === true && j.authMethod === "claude.ai";
    return {
      installed: true,
      loggedIn,
      email: j.email ?? null,
      plan: j.subscriptionType ?? null,
      error: loggedIn || j.loggedIn !== true ? null : "Claude Code is signed in with an API key or another method. Artifacts need a claude.ai login.",
    };
  } catch {
    return { installed: true, loggedIn: false, email: null, plan: null, error: (r.stderr || r.stdout).trim().slice(0, 300) || "Couldn't read Claude Code's sign-in status." };
  }
}

/** Opens claude.ai's own sign-in page in the browser and waits (up to five minutes) for it to finish. */
export async function claudeSignIn(claude: ClaudeCommand): Promise<{ ok: boolean; error: string | null }> {
  const r = await runProcess(claude.cmd, [...claude.prefix, "auth", "login", "--claudeai"], { env: cleanEnv(claude.cmd), timeoutMs: 5 * 60_000 });
  if (r.notFound) return { ok: false, error: NOT_FOUND };
  if (r.timedOut) return { ok: false, error: "The sign-in wasn't finished within five minutes." };
  return r.code === 0 ? { ok: true, error: null } : { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) || "Sign-in failed." };
}

export type ToolResult = { text: string; isError: boolean };
export type TaskResult = { results: ToolResult[]; error: string | null };

const SYSTEM = "You operate the Artifact tool for an artifacts gallery. Make exactly the Artifact call the user describes, never call it for any other file or URL, never change files, then reply with one word: DONE.";

function parseStream(stdout: string): { results: ToolResult[]; stopped: string | null } {
  const results: ToolResult[] = [];
  let stopped: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let j: { type?: string; subtype?: string; message?: { content?: unknown[] } };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === "user") {
      for (const c of (j.message?.content ?? []) as { type?: string; content?: unknown; is_error?: boolean }[]) {
        if (c.type !== "tool_result") continue;
        const text = Array.isArray(c.content) ? (c.content as { text?: string }[]).map((x) => x.text ?? "").join("\n") : String(c.content ?? "");
        results.push({ text, isError: c.is_error === true });
      }
    }
    if (j.type === "result" && j.subtype !== "success") stopped = `Claude Code stopped: ${j.subtype}`;
  }
  return { results, stopped };
}

async function runTask(claude: ClaudeCommand, prompt: string, tools: string[], workDir: string, maxTurns: number): Promise<TaskResult> {
  const args = [
    ...claude.prefix,
    "-p", prompt,
    "--tools", ...tools,
    "--allowedTools", "Artifact",
    "--model", "haiku",
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(maxTurns),
    "--setting-sources", "local",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt", SYSTEM,
  ];
  const env = cleanEnv(claude.cmd, { CLAUDE_CODE_ARTIFACT: "1", CLAUDE_CODE_ARTIFACT_AUTO_OPEN: "0", CLAUDE_CODE_ARTIFACT_COMMENTS: "0", CLAUDE_CODE_ARTIFACT_PUBLISH_EDITS: "0" });
  const r = await runProcess(claude.cmd, args, { cwd: workDir, env, timeoutMs: 180_000 });
  if (r.notFound) return { results: [], error: NOT_FOUND };
  const { results, stopped } = parseStream(r.stdout);
  if (r.timedOut) return { results, error: "Claude Code took too long to answer." };
  if (/not logged in|run \/login/i.test(r.stdout + r.stderr)) return { results, error: "Claude Code isn't signed in to claude.ai. Use Sign in on the Artifacts page." };
  if (results.length === 0) return { results, error: stopped ?? (r.stderr.trim().slice(0, 300) || "Claude Code didn't use the Artifact tool. It needs Claude Code 2.1.281 or later and a Pro, Max, Ultra, Team or Enterprise plan.") };
  return { results, error: null };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "bb-artifacts-"));
}

function removeScratch(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* Windows may still hold a handle after a kill; the OS temp cleaner will take it */
  }
}

/** List the person's claude.ai artifacts (and ones shared with them). */
export async function listArtifacts(claude: ClaudeCommand): Promise<TaskResult> {
  const dir = scratch();
  try {
    return await runTask(claude, 'Call the Artifact tool once with action "list", scope "all" and limit 200.', ["Artifact"], dir, 2);
  } finally {
    removeScratch(dir);
  }
}

/**
 * Publish a page. The page is copied into a fresh private folder first, and that folder is the
 * run's only working folder, so the run can read the page and nothing else.
 * `extra` adds fields to the Artifact call, e.g. `, url "https://claude.ai/artifact/..."`.
 */
export async function publishArtifact(claude: ClaudeCommand, sourcePath: string, extra: string): Promise<TaskResult> {
  const dir = scratch();
  try {
    const copy = join(dir, basename(sourcePath));
    copyFileSync(sourcePath, copy);
    const prompt = `Call the Artifact tool exactly once with action "publish", file_path ${JSON.stringify(copy)}${extra}. Then stop.`;
    return await runTask(claude, prompt, ["Artifact", "Read"], dir, 3);
  } finally {
    removeScratch(dir);
  }
}

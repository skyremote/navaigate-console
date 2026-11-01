// Chat file links that point outside the chat's project.
//
// bb turns an agent's `file.md` (a bare name in backticks, or a relative path) into a link
// relative to the chat's workspace, so a file the agent saved somewhere else (for example on the
// NAS share while the chat runs in a local project) opens the file panel with "File not found.".
// This module finds the file the agent meant, in a fixed order, and only inside the user's home
// or a mounted volume. It never walks a directory tree: every candidate is one exact path.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { OUTSIDE_FILE_EXTENSIONS } from "./src/outside-file-extensions";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { modeNow } from "./server-nas";

export const fileResolveInput = z.object({
  path: z.string().min(1).max(2000),
  source: z.object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    hostId: z.string().nullable().optional(),
  }).strict(),
}).strict();

export const FILE_KINDS = ["markdown", "html", "text", "binary"] as const;
export const fileResolveOutput = z.object({
  /**
   * found: it lives outside the project, show it here. not-found: the workspace path was checked inside an
   * allowed folder and is missing, and nowhere else had it. Every other status (in-workspace, refused,
   * unchecked) leaves bb's own preview in charge.
   */
  status: z.enum(["in-workspace", "found", "not-found", "refused", "unchecked"]),
  realPath: z.string().nullable(),
  /** Where it was found: "as written", or the project folder or thread-written folder that holds it. */
  via: z.string().nullable(),
  tried: z.array(z.string()),
  reason: z.string().nullable(),
  kind: z.enum(FILE_KINDS).nullable(),
  size: z.number().nullable(),
  /** Text of a Markdown, HTML or plain-text file up to 1 MB; null otherwise. */
  content: z.string().nullable(),
  hostId: z.string().nullable(),
}).strict();
export type FileResolveOutput = z.infer<typeof fileResolveOutput>;

export const fileOpenInput = z.object({ path: z.string().min(1).max(2000), mode: z.enum(["reveal", "open"]) }).strict();
export const fileOpenOutput = z.object({ ok: z.boolean(), reason: z.string().nullable() }).strict();

const MAX_INLINE_BYTES = 1_000_000;
const MAX_HINTS = 60;
const MAX_CANDIDATES = 600;
const MAX_TRIED_SHOWN = 12;
// Away from home every file on the NAS takes minutes, so a click may touch it only a few times.
const AWAY_VOLUME_PROBES = 3;
const STAT_TIMEOUT_MS = 4_000;
const TOTAL_BUDGET_MS = 12_000;
const MAX_EVENT_STRINGS = 4_000;
// Folders under the home folder that hold credentials or app data. A chat link never opens them.
const HOME_DENY = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".claude", ".codex", "Library"]);
const SECRET_NAME = /^\.env(\.|$)|^\.(envrc|netrc|npmrc|git-credentials|claude\.json)$|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519|ecdsa)/iu;
const MARKDOWN_EXT = new Set([".md", ".markdown"]);
const HTML_EXT = new Set([".html", ".htm"]);
const TEXT_EXT = new Set([".txt", ".csv", ".json", ".log", ".yml", ".yaml", ".xml"]);

export function fileKind(file: string): (typeof FILE_KINDS)[number] {
  const ext = path.extname(file).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (HTML_EXT.has(ext)) return "html";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

export interface FileResolveContext {
  /** Folders the resolver may read from. Defaults to the home folder and mounted volumes. */
  allowedRoots: string[];
  home: string;
  /** The chat's own workspace folder. */
  workspaceRoot: string | null;
  /** Other project folders on the same host. */
  sources: string[];
  /** Text the thread has produced (commands, output, messages), newest first. */
  threadStrings: string[];
  hostId: string | null;
  /** True when the NAS share is only reachable over a slow link (laptop away from home). */
  away?: boolean;
  /** Home-folder links that lead onto a mounted volume (for example ~/Shared -> /Volumes/Shared). */
  volumeAliases?: string[];
  now?: () => number;
  statTimeoutMs?: number;
}

// Every look at the disk runs in a short-lived child process with a hard timeout. A hung network share
// can then only hang (and lose) that child; it can never tie up this server's own file-system threads.
const STAT_SCRIPT = [
  'out=$(/usr/bin/stat -L -f "%z %HT" -- "$1" 2>&1) || { case "$out" in *"No such file or directory"*) exit 4;; *) exit 5;; esac; }',
  'r=$(/usr/bin/readlink -f -- "$1") || exit 5',
  'printf "%s\\n%s\\n" "$out" "$r"',
].join("\n");

type Inspect = { state: "ok"; real: string; size: number; isFile: boolean } | { state: "missing" } | { state: "unreadable" };

function inspectPath(target: string, timeoutMs: number): Promise<Inspect> {
  if (target.includes("\n") || target.includes("\0")) return Promise.resolve({ state: "unreadable" });
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", STAT_SCRIPT, "sh", target], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin" } }, (err, stdout) => {
      if (err) {
        resolve((err as { code?: unknown }).code === 4 ? { state: "missing" } : { state: "unreadable" });
        return;
      }
      const [meta = "", real = ""] = stdout.split("\n");
      const size = Number(meta.split(" ")[0]);
      if (!real || !Number.isFinite(size)) resolve({ state: "unreadable" });
      else resolve({ state: "ok", real, size, isFile: meta.endsWith("Regular File") });
    });
  });
}

function readText(file: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/bin/cat", ["--", file], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_INLINE_BYTES + 1024, encoding: "utf8" }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Directories named by the text a thread has produced, newest mention first. Pure. */
export function collectPathHints(strings: readonly string[], home: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of strings) {
    for (const raw of text.split(/[\s"'`<>()=,;|\\[\]{}]+/u)) {
      let token = raw.replace(/[.,:;!?]+$/u, "");
      if (!token.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//iu.test(token) || /[$*?]/u.test(token) || token.startsWith("//")) continue;
      if (token === "~" || token.startsWith("~/")) token = path.posix.join(home, token.slice(1));
      else if (token.startsWith("./") || token.startsWith("../")) continue;
      token = token.replace(/\/+$/u, "");
      if (token.length < 3 || token.split("/").includes("..")) continue;
      const dir = path.posix.extname(token) ? path.posix.dirname(token) : token;
      if (dir === "" || dir === "." || dir === "/" || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
      if (out.length >= MAX_HINTS) return out;
    }
  }
  return out;
}

/** Every string inside a JSON value, shallowest first, capped. */
export function eventStrings(value: unknown, into: string[] = []): string[] {
  const queue: unknown[] = [value];
  for (let index = 0; index < queue.length && into.length < MAX_EVENT_STRINGS; index += 1) {
    const next = queue[index];
    if (typeof next === "string") into.push(next);
    else if (Array.isArray(next)) queue.push(...next);
    else if (next && typeof next === "object") queue.push(...Object.values(next));
  }
  return into;
}

function refusalFor(rel: string): string | null {
  const normal = path.posix.normalize(rel);
  if (!path.isAbsolute(rel) && (normal === ".." || normal.startsWith("../"))) {
    return `${rel} climbs out of the project folder, so it was not opened.`;
  }
  return null;
}

export async function resolveFileLink(input: z.infer<typeof fileResolveInput>, ctx: FileResolveContext): Promise<FileResolveOutput> {
  const result = await resolveFileLinkAll(input, ctx);
  return result.tried.length > MAX_TRIED_SHOWN ? { ...result, tried: result.tried.slice(0, MAX_TRIED_SHOWN) } : result;
}

async function resolveFileLinkAll(input: z.infer<typeof fileResolveInput>, ctx: FileResolveContext): Promise<FileResolveOutput> {
  const now = ctx.now ?? Date.now;
  const started = now();
  const statTimeout = ctx.statTimeoutMs ?? STAT_TIMEOUT_MS;
  const tried: string[] = [];
  const base = { realPath: null, via: null, tried, reason: null, kind: null, size: null, content: null, hostId: ctx.hostId } as const;
  const rel = input.path;

  const refusal = refusalFor(rel);
  if (refusal) return { ...base, status: "refused", reason: refusal };

  const allowed = (real: string) => {
    if (!ctx.allowedRoots.some((root) => within(root, real))) return false;
    if (within(ctx.home, real)) {
      const first = real.slice(ctx.home.length + 1).split("/")[0] ?? "";
      if (HOME_DENY.has(first)) return false;
    }
    return !SECRET_NAME.test(path.basename(real));
  };

  const onVolume = (file: string) => within("/Volumes", file) || (ctx.volumeAliases ?? []).some((alias) => within(alias, file));
  let volumeProbes = 0;
  let skippedForAway = 0;
  type Probe = { state: "hit"; real: string; size: number } | { state: "missing" } | { state: "blocked" };
  // missing: the file is not there. blocked: skipped, outside the allowed folders, not a file, or unreadable.
  const probe = async (candidate: string): Promise<Probe> => {
    const normal = path.resolve(candidate);
    if (tried.includes(normal)) return { state: "blocked" };
    if (ctx.away && onVolume(normal) && ++volumeProbes > AWAY_VOLUME_PROBES) {
      skippedForAway += 1;
      return { state: "blocked" };
    }
    tried.push(normal);
    if (!allowed(normal)) return { state: "blocked" };
    const seen = await inspectPath(normal, statTimeout);
    if (seen.state !== "ok") return { state: seen.state === "missing" ? "missing" : "blocked" };
    return seen.isFile && allowed(seen.real) ? { state: "hit", real: seen.real, size: seen.size } : { state: "blocked" };
  };

  const finish = async (hit: { real: string; size: number }, via: string): Promise<FileResolveOutput> => {
    const kind = fileKind(hit.real);
    const content = kind !== "binary" && hit.size <= MAX_INLINE_BYTES ? await readText(hit.real, statTimeout) : null;
    return { ...base, status: "found", realPath: hit.real, via, kind, size: hit.size, content };
  };
  const unchecked = (reason: string): FileResolveOutput => ({ ...base, status: "unchecked", reason });

  const overBudget = () => now() - started > TOTAL_BUDGET_MS;

  // 1. Where bb itself looked. Unless this was really checked, inside a folder we may read, bb's own preview stays in charge.
  if (path.isAbsolute(rel)) return unchecked("An absolute path is opened by bb directly.");
  if (!ctx.workspaceRoot) return unchecked("The chat's workspace folder is not known here.");
  const root = await inspectPath(path.resolve(ctx.workspaceRoot), statTimeout);
  if (root.state !== "ok" || root.isFile || !allowed(root.real)) return unchecked("The chat's workspace is not a folder this plugin may read on this Mac.");
  const workspaceReal = root.real;
  const here = await probe(path.join(workspaceReal, rel));
  if (here.state === "hit") return { ...base, status: "in-workspace", realPath: here.real, via: "this chat's project", kind: fileKind(here.real), size: here.size };
  if (here.state === "blocked") return unchecked("The file could not be checked in the chat's workspace.");

  // 2. The same relative path under any other project folder on this host.
  const ownRoots = new Set([path.resolve(ctx.workspaceRoot), workspaceReal]);
  const roots = [...new Set(ctx.sources.map((source) => path.resolve(source)))].filter((candidate) => !ownRoots.has(candidate));
  // A bare file name joined to a project folder almost never exists; the thread's own folders come first.
  if (rel.includes("/")) {
    for (const source of roots) {
      const hit = await probe(path.join(source, rel));
      if (hit.state === "hit") return finish(hit, `project folder ${source}`);
    }
  }

  // 3. Folders the thread itself named: a bare file name carries no folder, but the chat usually does.
  const name = path.basename(rel);
  const allRoots = [workspaceReal, ...roots];
  const candidates: { file: string; via: string }[] = [];
  for (const hint of collectPathHints(ctx.threadStrings, ctx.home)) {
    const dirs = path.isAbsolute(hint) ? [hint] : allRoots.map((dirRoot) => path.join(dirRoot, hint));
    for (const dir of dirs) {
      for (const file of !rel.includes("/") ? [path.join(dir, name)] : [path.join(dir, rel), path.join(dir, name)]) {
        candidates.push({ file, via: `a folder this chat used (${dir})` });
      }
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (overBudget()) break;
    const hit = await probe(candidate.file);
    if (hit.state === "hit") return finish(hit, candidate.via);
  }

  if (!rel.includes("/")) {
    for (const source of roots) {
      if (overBudget()) break;
      const hit = await probe(path.join(source, rel));
      if (hit.state === "hit") return finish(hit, `project folder ${source}`);
    }
  }

  const awayNote = skippedForAway > 0 ? ` You are away from home, so ${skippedForAway} place${skippedForAway === 1 ? "" : "s"} on the NAS ${skippedForAway === 1 ? "was" : "were"} not checked; open it from the NAS project when you are home.` : "";
  return { ...base, status: "not-found", reason: `No file at ${rel} was found. Tried ${tried.length} place${tried.length === 1 ? "" : "s"}.${awayNote}` };
}

const OPENABLE_EXTENSIONS = new Set<string>(OUTSIDE_FILE_EXTENSIONS.map((ext) => `.${ext}`));

/** Open or reveal a file the card found: only the deliverable types, only after its real path is checked again. */
export async function openOutsideFile(input: z.infer<typeof fileOpenInput>, allowedRoots: string[], home: string, timeoutMs = STAT_TIMEOUT_MS): Promise<z.infer<typeof fileOpenOutput>> {
  const refuse = (reason: string) => ({ ok: false, reason });
  if (!path.isAbsolute(input.path)) return refuse("That path is not absolute.");
  const seen = await inspectPath(path.resolve(input.path), timeoutMs);
  if (seen.state !== "ok" || !seen.isFile) return refuse("That file could not be found.");
  const real = seen.real;
  const inside = allowedRoots.some((root) => within(root, real))
    && !(within(home, real) && HOME_DENY.has(real.slice(home.length + 1).split("/")[0] ?? ""))
    && !SECRET_NAME.test(path.basename(real));
  if (!inside) return refuse("That path is outside your home folder and mounted volumes.");
  if (!OPENABLE_EXTENSIONS.has(path.extname(real).toLowerCase())) return refuse(`Only ${OUTSIDE_FILE_EXTENSIONS.join(", ")} files can be opened from a chat link.`);
  return new Promise((resolve) => {
    execFile("/usr/bin/open", input.mode === "reveal" ? ["-R", real] : [real], { timeout: 15_000 }, (err) => {
      resolve(err ? refuse(err.message.split("\n")[0] ?? "Could not open the file.") : { ok: true, reason: null });
    });
  });
}

export const defaultAllowedRoots = (home = os.homedir()) => {
  let real = home;
  try { real = realpathSync(home); } catch { /* keep the plain path */ }
  return [...new Set([home, real, "/Volumes"])];
};

type Bb = Pick<BbPluginApi, "sdk" | "log">;

/** Links in the home folder that point onto a mounted volume. Reading a link is local, so this never touches the share. */
export async function volumeAliasesIn(home: string): Promise<string[]> {
  const aliases: string[] = [];
  try {
    for (const entry of await fs.readdir(home, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const target = await fs.readlink(path.join(home, entry.name)).catch(() => "");
      if (within("/Volumes", target)) aliases.push(path.join(home, entry.name));
    }
  } catch { /* no aliases */ }
  return aliases;
}

export function createFileResolve(bb: Bb, home = os.homedir(), where: () => Promise<{ mode: "home" | "away" }> = modeNow) {
  const allowedRoots = defaultAllowedRoots(home);
  return {
    async resolve(raw: z.input<typeof fileResolveInput>): Promise<FileResolveOutput> {
      const input = fileResolveInput.parse(raw);
      let workspaceRoot: string | null = null;
      let hostId: string | null = input.source.hostId ?? null;
      if (input.source.environmentId) {
        const env = await bb.sdk.environments.get({ environmentId: input.source.environmentId }).catch(() => null);
        workspaceRoot = env?.path ? path.resolve(env.path) : null;
        hostId = hostId ?? env?.hostId ?? null;
      }
      const sources: string[] = [];
      try {
        for (const project of await bb.sdk.projects.list({ includePersonal: true } as never)) {
          for (const source of (project as { sources?: { type?: string; hostId?: string; path?: string }[] }).sources ?? []) {
            if (source.type === "local_path" && source.path && (!hostId || !source.hostId || source.hostId === hostId)) sources.push(source.path);
          }
        }
      } catch (cause) {
        bb.log.warn(`file link: project sources unavailable: ${String(cause)}`);
      }
      const threadStrings: string[] = [];
      if (input.source.threadId) {
        try {
          const rows = await bb.sdk.threads.events.list({ threadId: input.source.threadId, order: "desc", limit: "400", types: ["item/completed"] });
          for (const row of rows) eventStrings((row as { data?: unknown }).data, threadStrings);
        } catch (cause) {
          bb.log.warn(`file link: thread events unavailable: ${String(cause)}`);
        }
      }
      const away = (await where().catch(() => ({ mode: "away" as const }))).mode === "away";
      return resolveFileLink(input, { allowedRoots, home, workspaceRoot, sources, threadStrings, hostId, away, volumeAliases: await volumeAliasesIn(home) });
    },
    open: (input: z.input<typeof fileOpenInput>) => openOutsideFile(fileOpenInput.parse(input), allowedRoots, home),
  };
}

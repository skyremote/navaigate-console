// Which git worktree each agent works in. Pure: no I/O. The server feeds in
// tool calls (Claude Code transcripts, Codex rollouts, bb thread items) and
// git's own porcelain output, and asks for the answer.
//
// Agents rarely change their process cwd: a Claude Code agent keeps the
// session's cwd and reaches its worktree with `cd`, `git -C` and absolute
// file paths. So the worktree an agent works in is the git checkout its recent
// tool calls touch most, with edits and `cd` counting more than reads.

/** One sighting of a path in an agent's tool call. */
export interface PathHit {
  path: string;
  weight: number;
}

export const WEIGHT = { write: 3, cd: 2, read: 1 } as const;
/** Sightings kept per agent, newest last. Older ones drop out so a move to another worktree shows. */
export const HITS_MAX = 80;

const ABS = String.raw`(?:~|/)[^\s"'\`;&|()<>]*`;
const unquote = (p: string) => p.replace(/^["']|["']$/g, "");

/** Directories a shell command moves into or points git at. */
export function commandPaths(command: string): PathHit[] {
  const out: PathHit[] = [];
  const add = (p: string, weight: number) => {
    const clean = unquote(p.trim()).replace(/\/+$/, "");
    if (clean.startsWith("/") || clean.startsWith("~/")) out.push({ path: clean, weight });
  };
  for (const m of command.matchAll(new RegExp(String.raw`(?:^|[\s;&|(])cd\s+(["']?)(${ABS})\1`, "g"))) add(m[2], WEIGHT.cd);
  for (const m of command.matchAll(new RegExp(String.raw`\bgit\s+(?:--no-optional-locks\s+)?-C\s+(["']?)(${ABS})\1`, "g"))) add(m[2], WEIGHT.cd);
  for (const m of command.matchAll(new RegExp(String.raw`\bworktree\s+add\s+(?:-[bB]\s+\S+\s+|--\S+\s+)*(["']?)(${ABS})\1`, "g"))) add(m[2], WEIGHT.write);
  for (const m of command.matchAll(new RegExp(String.raw`--(?:cwd|prefix|root|dir)[= ](["']?)(${ABS})\1`, "g"))) add(m[2], WEIGHT.cd);
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Paths in one Claude Code tool call (a transcript tool_use block). */
export function claudeToolPaths(name: string, input: Record<string, unknown>): PathHit[] {
  const file = str(input.file_path) || str(input.notebook_path);
  switch (name) {
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? [{ path: file, weight: WEIGHT.write }] : [];
    case "Read":
      return file ? [{ path: file, weight: WEIGHT.read }] : [];
    case "Grep":
    case "Glob":
      return str(input.path) ? [{ path: str(input.path), weight: WEIGHT.read }] : [];
    case "Bash":
      return commandPaths(str(input.command));
    case "EnterWorktree":
      return str(input.path) ? [{ path: str(input.path), weight: WEIGHT.write }] : [];
    default:
      return [];
  }
}

/** Paths in one Codex tool call: `exec` code, `exec_command` arguments, or an `apply_patch` body. */
export function codexToolPaths(name: string, text: string): PathHit[] {
  const out: PathHit[] = [];
  for (const m of text.matchAll(/["']?workdir["']?\s*:\s*["']([^"']+)["']/g)) out.push({ path: m[1], weight: WEIGHT.cd });
  for (const m of text.matchAll(/["']?(?:cmd|command)["']?\s*:\s*["']((?:[^"'\\]|\\.)*)["']/g)) out.push(...commandPaths(m[1].replace(/\\"/g, '"')));
  if (name === "apply_patch" || /\*\*\* (?:Update|Add) File: /.test(text)) {
    for (const m of text.matchAll(/\*\*\* (?:Update|Add|Delete) File: (\/\S+)/g)) out.push({ path: m[1], weight: WEIGHT.write });
  }
  return out;
}

/** Paths in one bb thread item (commandExecution, fileChange, fileRead) when it carries them. */
export function itemPaths(item: Record<string, unknown>): PathHit[] {
  const type = str(item.type);
  const out: PathHit[] = [];
  if (type === "commandExecution") {
    if (str(item.cwd)) out.push({ path: str(item.cwd), weight: WEIGHT.cd });
    out.push(...commandPaths(str(item.command)));
  } else if (type === "fileChange") {
    for (const c of Array.isArray(item.changes) ? item.changes : []) if (str(obj(c).path)) out.push({ path: str(obj(c).path), weight: WEIGHT.write });
  } else if (type === "fileRead") {
    if (str(item.path)) out.push({ path: str(item.path), weight: WEIGHT.read });
  }
  return out;
}

export function pushHits(list: PathHit[], hits: PathHit[], max = HITS_MAX): PathHit[] {
  for (const h of hits) if (h.path) list.push(h);
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}

/**
 * The worktree the hits point at most, given a resolver from any path to its
 * git checkout root (null outside git). Ties go to the most recent sighting.
 * Returns every checkout touched too, best first.
 */
export function rankWorktrees(hits: readonly PathHit[], rootOf: (path: string) => string | null): { root: string; score: number }[] {
  const score = new Map<string, { score: number; last: number }>();
  hits.forEach((h, i) => {
    const root = rootOf(h.path);
    if (!root) return;
    const s = score.get(root) ?? { score: 0, last: 0 };
    s.score += h.weight;
    s.last = i;
    score.set(root, s);
  });
  return [...score.entries()].sort((a, b) => b[1].score - a[1].score || b[1].last - a[1].last).map(([root, s]) => ({ root, score: s.score }));
}

/** Candidate directories to test for a `.git` entry, from a path up to (not including) the home folder. */
export function ancestors(path: string, home: string): string[] {
  const expanded = path.startsWith("~/") ? home + path.slice(1) : path;
  const parts = expanded.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    const dir = "/" + parts.slice(0, i).join("/");
    if (dir === home || dir === "/Users" || dir === "/private" || dir === "/tmp" || dir === "/private/tmp") break;
    out.push(dir);
  }
  return out;
}

// ---------- git porcelain ----------

export interface GitStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** Changed, staged and untracked files. */
  changed: number;
  untracked: number;
}

/** `git status --porcelain=v2 --branch` */
export function parseStatus(text: string): GitStatus {
  const s: GitStatus = { branch: null, head: null, upstream: null, ahead: null, behind: null, changed: 0, untracked: 0 };
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13).trim();
      s.head = oid === "(initial)" ? null : oid.slice(0, 7);
    } else if (line.startsWith("# branch.head ")) {
      const b = line.slice(14).trim();
      s.branch = b === "(detached)" ? null : b;
    } else if (line.startsWith("# branch.upstream ")) s.upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        s.ahead = Number(m[1]);
        s.behind = Number(m[2]);
      }
    } else if (line.startsWith("? ")) {
      s.untracked += 1;
      s.changed += 1;
    } else if (/^[12u] /.test(line)) s.changed += 1;
  }
  return s;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
}

/** `git worktree list --porcelain`. The first entry is the main checkout. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9).trim(), head: null, branch: null, bare: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim().slice(0, 7);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line === "bare") cur.bare = true;
  }
  return out;
}

/** `git rev-list --left-right --count A...B` -> [left, right] */
export function parseLeftRight(text: string): [number, number] | null {
  const m = /^(\d+)\s+(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The branch a worktree's ahead/behind is measured against: its upstream when
 * it has one, otherwise the branch the repo's main checkout has out (where
 * worktree branches get merged back), unless that is the same branch.
 */
export function compareBase(status: Pick<GitStatus, "branch" | "upstream">, main: WorktreeEntry | undefined): string | null {
  if (status.upstream) return status.upstream;
  if (main?.branch && main.branch !== status.branch) return main.branch;
  return null;
}

/** "helper-desk-continuation" for /tmp/bbwt/helper-desk-continuation; the repo folder for a main checkout. */
export function shortPath(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

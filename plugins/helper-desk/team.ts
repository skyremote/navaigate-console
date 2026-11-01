// The chat's team: every agent working for the chat (the lead of each session,
// Claude Code and Codex sub-agents, Workflow runs and their agents, child bb
// threads and work sent to other Macs through Fleet) and the git worktree each
// one works in. Pure: schemas and parsers, no I/O.
import { z } from "zod";
import { clip } from "./model";

export const teamWorktreeSchema = z.object({
  path: z.string(),
  /** The folder name, e.g. "helper-desk-continuation". */
  name: z.string(),
  /** The main checkout's folder name, e.g. "navaigate-bb-mods". Null when git could not be read. */
  repo: z.string().nullable(),
  /** True for the repo's main checkout, false for a linked worktree. */
  isMain: z.boolean(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  /** Changed, staged and untracked files. */
  changed: z.number(),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  /** What ahead/behind is measured against: the upstream, or the main checkout's branch. */
  base: z.string().nullable(),
  error: z.string().nullable(),
});
export type TeamWorktree = z.infer<typeof teamWorktreeSchema>;

export const teamKindSchema = z.enum(["lead", "subagent", "workflow", "workflow-agent", "thread", "remote"]);
export type TeamKind = z.infer<typeof teamKindSchema>;
export const teamStateSchema = z.enum(["running", "finished", "failed", "interrupted", "waiting", "needs-you"]);
export type TeamState = z.infer<typeof teamStateSchema>;

export const teamAgentSchema = z.object({
  id: z.string(),
  kind: teamKindSchema,
  name: z.string(),
  /** "Claude Code", "Codex", "Cursor", ... */
  provider: z.string(),
  model: z.string(),
  state: teamStateSchema,
  /** The bb thread (session) the agent belongs to. */
  threadId: z.string(),
  parentId: z.string().nullable(),
  startedAt: z.number().nullable(),
  /** Workflow phase, or the Codex agent role. */
  phase: z.string().nullable(),
  /** Key into `worktrees`. */
  worktree: z.string().nullable(),
  /** Other checkouts its recent tool calls touched, best first. */
  alsoTouched: z.array(z.string()).max(3),
  /** Where the worktree came from: bb's environment, Claude Code's worktree isolation, or the agent's own tool calls. */
  worktreeSource: z.enum(["bb", "isolated", "tool-calls", "none"]),
  /**
   * A thread to open. `threadId` is the thread where the agent runs (here, or on `machine`), `url` opens it
   * on that Mac, and `localThreadId` is a chat in this bb to open: a child thread, or Fleet's read-only copy.
   */
  link: z
    .object({ threadId: z.string().nullable(), url: z.string().nullable(), machine: z.string().nullable(), localThreadId: z.string().nullable() })
    .nullable(),
  note: z.string(),
});
export type TeamAgent = z.infer<typeof teamAgentSchema>;

export const teamSessionSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  provider: z.string(),
  model: z.string(),
  /** "chat" for an ordinary chat; root / continuation / parallel inside a grouped native conversation. */
  role: z.enum(["chat", "root", "continuation", "parallel"]),
  /** The session the conversation is on now. */
  active: z.boolean(),
  status: z.string(),
  createdAt: z.number(),
});
export type TeamSession = z.infer<typeof teamSessionSchema>;

export const teamSchema = z.object({
  threadId: z.string(),
  sessions: z.array(teamSessionSchema).max(20),
  agents: z.array(teamAgentSchema).max(240),
  worktrees: z.array(teamWorktreeSchema).max(60),
  /** Agents left out to stay under the cap (oldest finished first). */
  omitted: z.number(),
  updatedAt: z.number(),
});
export type DeskTeam = z.infer<typeof teamSchema>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// ---------- Workflow journals ----------

export interface JournalAgent {
  agentId: string;
  label: string;
  phase: string;
  done: boolean;
}

/**
 * A Workflow run's journal.jsonl (in <session>/subagents/workflows/<run>/):
 * "started" rows name each agent's transcript (agent-<agentId>.jsonl) and label,
 * "result" rows mark it done. A label can start again (a retry): the newest wins.
 */
export function parseJournal(text: string): JournalAgent[] {
  const byLabel = new Map<string, JournalAgent>();
  const byId = new Map<string, JournalAgent>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    const agentId = str(row.agentId);
    if (row.type === "started" && agentId) {
      const a = { agentId, label: str(row.label), phase: str(row.phase), done: false };
      byLabel.set(a.label || agentId, a);
      byId.set(agentId, a);
    } else if (row.type === "result" && agentId) {
      const a = byId.get(agentId);
      if (a) a.done = true;
    }
  }
  return [...byLabel.values()];
}

/**
 * Which run folder holds a Workflow run seen in bb's events. bb's progress event
 * carries the agents' labels but not the folder, so pick the folder whose
 * journal shares the most labels (at least one, and at least half of the
 * smaller side). Ties go to the folder listed later (the newer run).
 */
export function matchRun(labels: readonly string[], runs: readonly { dir: string; agents: readonly JournalAgent[] }[]): string | null {
  const want = new Set(labels.filter(Boolean));
  if (!want.size) return null;
  let best: { dir: string; hits: number } | null = null;
  for (const run of runs) {
    const have = new Set(run.agents.map((a) => a.label));
    let hits = 0;
    for (const l of want) if (have.has(l)) hits++;
    const needed = Math.max(1, Math.ceil(Math.min(want.size, have.size) / 2));
    if (hits >= needed && (!best || hits >= best.hits)) best = { dir: run.dir, hits };
  }
  return best?.dir ?? null;
}

// ---------- Claude Code sub-agent meta ----------

export interface SubagentMeta {
  agentType: string;
  description: string;
  toolUseId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  model: string | null;
}

/** agent-<id>.meta.json beside each Claude Code sub-agent transcript. */
export function parseSubagentMeta(text: string): SubagentMeta | null {
  let m: Record<string, unknown>;
  try { m = JSON.parse(text); } catch { return null; }
  if (!m || typeof m !== "object") return null;
  return {
    agentType: str(m.agentType),
    description: str(m.description),
    toolUseId: str(m.toolUseId) || null,
    worktreePath: str(m.worktreePath) || null,
    worktreeBranch: str(m.worktreeBranch) || null,
    model: str(m.model) || null,
  };
}

// ---------- Codex sub-agent rollouts ----------

export interface CodexMeta {
  id: string;
  cwd: string;
  nickname: string;
  role: string;
  agentPath: string;
}

/** The session_meta row at the top of a Codex rollout file. */
export function parseCodexMeta(line: string): CodexMeta | null {
  let row: Record<string, unknown>;
  try { row = JSON.parse(line); } catch { return null; }
  if (row.type !== "session_meta") return null;
  const p = obj(row.payload);
  return { id: str(p.id), cwd: str(p.cwd), nickname: str(p.agent_nickname), role: str(p.agent_role), agentPath: str(p.agent_path) };
}

// ---------- Fleet: work sent to another Mac ----------

export interface FleetCall {
  verb: "start" | "ask" | "tell";
  machine: string;
  threadId: string | null;
  url: string | null;
  commandId: string | null;
  /** started: launched there; answered: its answer came back; sent: queued until that Mac picks it up; failed. */
  outcome: "started" | "answered" | "sent" | "waiting" | "failed";
  prompt: string;
  /** When the call ran (the bb item's time), 0 when unknown. The first call to a thread is kept as its start. */
  at: number;
}

const FLEET_RE = /(?:^|[\s;&|(])bb\s+fleet\s+(start|ask|tell)\s+(?:--\S+\s+)*([A-Za-z0-9_-]+)(?:\s+(thr_[A-Za-z0-9_-]+))?([^\n]*)/g;
/** What a real call prints: a started thread, an answer footer, a queued command, a JSON record, or a delivery. */
const FLEET_OUTPUT_RE = /Started thr_|^-- [A-Za-z0-9_-]+ · thread thr_|Sent to |"outcome"\s*:|Delivered|\/threads\/thr_/m;
const VALUE_FLAGS = /--(?:provider|model|timeout|title|project|cwd|effort|machine|message-file)(?:=|\s+)\S+/g;

/**
 * A `bb fleet start|ask|tell` call and what it printed. `start` prints
 * "Started thr_x" and the URL, `ask` ends with "-- <machine> · thread thr_x · URL",
 * `tell` names the thread, and --json prints the record.
 */
export function parseFleetCall(command: string, output: string, exitCode: number | null): FleetCall | null {
  // The last call in the command is the one that ran (a heredoc earlier in it may only mention Fleet).
  const m = [...command.matchAll(FLEET_RE)].pop();
  if (!m || /\s--help\b|\s-h\b/.test(m[0])) return null;
  if (!FLEET_OUTPUT_RE.test(output) && exitCode !== 2) return null;
  const verb = m[1] as FleetCall["verb"];
  let machine = m[2].toUpperCase();
  let threadId = verb === "tell" ? m[3] ?? null : null;
  let url: string | null = null;
  let commandId: string | null = null;
  try {
    const j = obj(JSON.parse(output.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? ""));
    if (str(j.threadId)) threadId = str(j.threadId);
    if (str(j.url)) url = str(j.url);
    if (str(j.commandId)) commandId = str(j.commandId);
    if (str(j.machine)) machine = str(j.machine).toUpperCase();
  } catch { /* plain text */ }
  const started = /Started (thr_[A-Za-z0-9_-]+)/.exec(output);
  if (started) threadId = started[1];
  const footer = /^-- ([A-Za-z0-9_-]+) · thread (thr_[A-Za-z0-9_-]+)/m.exec(output);
  if (footer) {
    machine = footer[1].toUpperCase();
    threadId = footer[2];
  }
  const link = /(https?:\/\/[^\s·]+\/threads\/(thr_[A-Za-z0-9_-]+))/.exec(output);
  if (link) {
    url = link[1];
    threadId = threadId ?? link[2];
  }
  const cmd = /(?:bb fleet result|command) ([0-9a-f]{8}-[0-9a-f-]{27,})/.exec(output);
  if (cmd) commandId = cmd[1];
  let outcome: FleetCall["outcome"];
  if (exitCode !== null && exitCode !== 0 && exitCode !== 2 && !threadId) outcome = "failed";
  else if (exitCode === 2) outcome = "waiting";
  else if (verb === "ask" && footer) outcome = "answered";
  else if (verb === "tell" && /--wait\b/.test(m[0]) && footer) outcome = "answered";
  else if (/Sent to /.test(output) && !threadId) outcome = "sent";
  else outcome = "started";
  const brief = /--message-file(?:=|\s+)["']?([^\s"']+)|\$\(cat\s+["']?([^\s"')]+)/.exec(m[0]);
  const prompt = brief
    ? `Brief from ${(brief[1] ?? brief[2]).split("/").pop()}`
    : m[4]
        .replace(/\s*(?:\d?>|\||&&|;).*$/, "")
        .replace(VALUE_FLAGS, "")
        .replace(/(^|\s)--\S*/g, " ")
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim();
  return { verb, machine, threadId, url, commandId, outcome, prompt: clip(prompt, 160), at: 0 };
}

/** A remote job counts as working for this long after it started, unless its answer came back. Helper Desk cannot see its progress from here. */
export const REMOTE_FRESH_MS = 6 * 60 * 60_000;

/** Fold a new call into the list: one entry per remote thread (or per queued command), newest outcome wins. */
export function mergeFleetCalls(list: FleetCall[], call: FleetCall, max = 40): FleetCall[] {
  const key = (c: FleetCall) => c.threadId ?? c.commandId ?? `${c.machine}:${c.prompt}`;
  const i = list.findIndex((c) => key(c) === key(call) || (call.commandId !== null && c.commandId === call.commandId));
  if (i >= 0) {
    const prev = list[i];
    list[i] = { ...prev, ...call, prompt: prev.prompt || call.prompt, url: call.url ?? prev.url, threadId: call.threadId ?? prev.threadId, commandId: call.commandId ?? prev.commandId, at: prev.at || call.at };
  } else list.push(call);
  if (list.length > max) list.splice(0, list.length - max);
  return list;
}

// ---------- Ordering ----------

const STATE_RANK: Record<TeamState, number> = { "needs-you": 0, running: 1, waiting: 2, failed: 3, interrupted: 4, finished: 5 };

/**
 * Keep the team under the cap: leads, then running agents and their parents,
 * then the newest finished ones. Returns the kept agents in their original
 * order and how many were left out.
 */
export function capTeam(agents: readonly TeamAgent[], max: number): { agents: TeamAgent[]; omitted: number } {
  if (agents.length <= max) return { agents: [...agents], omitted: 0 };
  const byId = new Map(agents.map((a) => [a.id, a]));
  const keep = new Set<string>();
  const add = (a: TeamAgent | undefined) => {
    for (let cur = a; cur && !keep.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) keep.add(cur.id);
  };
  for (const a of agents) if (a.kind === "lead") add(a);
  for (const a of agents) if (a.state === "running" || a.state === "needs-you") add(a);
  const rest = agents.filter((a) => !keep.has(a.id)).sort((x, y) => STATE_RANK[x.state] - STATE_RANK[y.state] || (y.startedAt ?? 0) - (x.startedAt ?? 0));
  for (const a of rest) {
    if (keep.size >= max) break;
    add(a);
  }
  const kept = agents.filter((a) => keep.has(a.id)).slice(0, max);
  return { agents: kept, omitted: agents.length - kept.length };
}

/** "Claude Code", "Codex", ... from a bb provider id. */
/** Fleet's thread metadata on a mirror thread (a read-only local copy of a chat on another Mac). */
export function parseMirrorMeta(metadata: unknown): { machine: string; serverId: string; remoteThreadId: string } | null {
  const m = obj(metadata);
  if (!str(m.remoteThreadId) || !str(m.machine)) return null;
  return { machine: str(m.machine).toUpperCase(), serverId: str(m.serverId), remoteThreadId: str(m.remoteThreadId) };
}

export function providerName(providerId: string): string {
  if (providerId.includes("claude")) return "Claude Code";
  if (providerId.includes("codex")) return "Codex";
  if (providerId.includes("cursor")) return "Cursor";
  if (providerId.includes("fleet-mirror")) return "Fleet mirror";
  return providerId ? clip(providerId, 24) : "Agent";
}

/** One line for a worktree chip: "navaigate/helperdesk-x · 2 changed · 3 ahead, 1 behind main". */
export function worktreeLine(w: TeamWorktree): string {
  const parts: string[] = [w.branch ?? (w.head ? `detached at ${w.head}` : "no branch")];
  parts.push(w.changed > 0 ? `${w.changed} changed` : "clean");
  if (w.ahead !== null && w.behind !== null && w.base) {
    parts.push(w.ahead === 0 && w.behind === 0 ? `level with ${w.base}` : `${w.ahead} ahead, ${w.behind} behind ${w.base}`);
  }
  return parts.join(" · ");
}

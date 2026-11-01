// Helper Desk — the chat's team, server side. Collects every agent working for
// a chat across its native continuation sessions, and the git worktree each one
// works in. Read-only: bb's SDK, the local Claude Code and Codex transcripts,
// and read-only git commands (`--no-optional-locks`, never a write).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { clip, effectiveState, type AgentRecord, type RawEvent, type ThreadState } from "./model";
import type { Conversation } from "./conversation";
import {
  capTeam,
  mergeFleetCalls,
  matchRun,
  parseCodexMeta,
  parseFleetCall,
  parseMirrorMeta,
  REMOTE_FRESH_MS,
  parseJournal,
  parseSubagentMeta,
  providerName,
  type DeskTeam,
  type FleetCall,
  type JournalAgent,
  type SubagentMeta,
  type TeamAgent,
  type TeamSession,
  type TeamState,
  type TeamWorktree,
} from "./team";
import {
  ancestors,
  claudeToolPaths,
  codexToolPaths,
  compareBase,
  itemPaths,
  parseLeftRight,
  parseStatus,
  parseWorktreeList,
  pushHits,
  rankWorktrees,
  shortPath,
  type PathHit,
} from "./worktrees";

export interface TeamDeps {
  sync: (threadId: string) => Promise<{ state: ThreadState; providerSessionId: string | null }>;
  conversationFor: (threadId: string) => Promise<Conversation | null>;
  /** The newest continuation that is working, else the newest: the session the conversation is on now. */
  followedThread: (threadId: string, conversation: Conversation | null) => string;
  leadModel: (threadId: string) => Promise<string>;
  modelLabel: (model: string) => string;
}

const MAX_AGENTS = 200;
const READ_BUDGET = 16 * 1024 * 1024;

/** Per-thread facts the team needs that Helper Desk's main reducer does not keep. Cached in plugin storage. */
interface Observed {
  version: 1;
  afterSeq: number;
  lead: PathHit[];
  /** Delegation id -> paths its items (streamed into the parent thread) touched. */
  delegations: Record<string, PathHit[]>;
  /** Delegation id -> provider child ref (Claude tool_use id, or Codex sub-agent thread id). */
  childRefs: Record<string, string>;
  fleet: FleetCall[];
}

const emptyObserved = (): Observed => ({ version: 1, afterSeq: 0, lead: [], delegations: {}, childRefs: {}, fleet: [] });

/** Fold bb thread items into the observed facts. Pure, exported for tests. */
export function observeEvents(o: Observed, events: readonly RawEvent[]): Observed {
  for (const e of events) {
    if (e.seq > o.afterSeq) o.afterSeq = e.seq;
    if (e.type !== "item/completed" && e.type !== "item/delegation/completed") continue;
    const item = (e.data.item ?? {}) as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    const parent = typeof item.parentToolCallId === "string" ? item.parentToolCallId : "";
    if (type === "delegation") {
      const id = typeof item.id === "string" ? item.id : "";
      if (id && typeof item.childRef === "string" && item.childRef) o.childRefs[id] = item.childRef;
      continue;
    }
    const hits = itemPaths(item);
    if (hits.length) {
      if (parent) {
        const list = (o.delegations[parent] ??= []);
        pushHits(list, hits, 40);
      } else pushHits(o.lead, hits);
    }
    if (type === "commandExecution" && typeof item.command === "string" && /\bfleet\s+(start|ask|tell)\b/.test(item.command)) {
      const call = parseFleetCall(item.command, String(item.aggregatedOutput ?? ""), typeof item.exitCode === "number" ? item.exitCode : null);
      if (call) mergeFleetCalls(o.fleet, { ...call, at: e.createdAt });
    }
  }
  const ids = Object.keys(o.delegations);
  if (ids.length > 300) for (const id of ids.slice(0, ids.length - 300)) delete o.delegations[id];
  return o;
}

/** Read-only git, with a short timeout. Null on any failure. */
function git(cwd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["--no-optional-locks", "-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

interface ToolTail {
  offset: number;
  remainder: string;
  hits: PathHit[];
  model: string;
  codex: { cwd: string; nickname: string; role: string } | null;
  mtimeMs: number;
}

export function createTeam(bb: BbPluginApi, deps: TeamDeps) {
  const home = homedir();
  const observed = new Map<string, { o: Observed; loaded: boolean; savedSeq: number }>();
  const observing = new Map<string, Promise<Observed>>();
  const tails = new Map<string, ToolTail>();
  const gitRoots = new Map<string, string | null>();
  const worktreeCache = new Map<string, { at: number; value: TeamWorktree }>();
  const codexFiles = new Map<string, string | null>();
  const dirListings = new Map<string, { at: number; value: unknown }>();
  const key = (threadId: string) => `team:v1:${threadId}`;

  // ---------- bb events: the lead's own paths, delegation refs, Fleet calls ----------

  async function observe(threadId: string): Promise<Observed> {
    const pending = observing.get(threadId);
    if (pending) return pending;
    const run = (async () => {
      let slot = observed.get(threadId);
      if (!slot) {
        slot = { o: emptyObserved(), loaded: false, savedSeq: 0 };
        observed.set(threadId, slot);
      }
      if (!slot.loaded) {
        slot.loaded = true;
        try {
          const cached = await bb.storage.kv.get<Observed>(key(threadId));
          if (cached && cached.version === 1) {
            slot.o = { ...emptyObserved(), ...cached };
            slot.savedSeq = cached.afterSeq;
          }
        } catch { /* rebuilt from the log */ }
      }
      for (let page = 0; page < 300; page++) {
        const rows = await bb.sdk.threads.events.list({
          threadId,
          afterSeq: String(slot.o.afterSeq),
          limit: "100",
          order: "asc",
          types: ["item/completed", "item/delegation/completed"] as unknown as Parameters<typeof bb.sdk.threads.events.list>[0]["types"],
        });
        if (!rows.length) break;
        observeEvents(slot.o, rows.map((r) => ({ seq: r.seq, type: r.type, createdAt: r.createdAt, data: (r.data ?? {}) as Record<string, unknown> })));
        if (rows.length < 100) break;
      }
      if (slot.o.afterSeq !== slot.savedSeq) {
        try {
          await bb.storage.kv.set(key(threadId), slot.o);
          slot.savedSeq = slot.o.afterSeq;
        } catch (e) {
          bb.log.warn(`team cache write failed for ${threadId}: ${String(e)}`);
        }
      }
      return slot.o;
    })();
    observing.set(threadId, run);
    try {
      return await run;
    } finally {
      observing.delete(threadId);
    }
  }

  // ---------- transcripts: paths each agent's tool calls touched ----------

  /** Tail a Claude Code (.jsonl) or Codex rollout transcript for tool-call paths and the model. */
  async function toolTail(path: string, codex: boolean): Promise<ToolTail> {
    let t = tails.get(path);
    if (!t) {
      t = { offset: 0, remainder: "", hits: [], model: "", codex: null, mtimeMs: 0 };
      tails.set(path, t);
    }
    let handle;
    try {
      const info = await stat(path);
      if (info.size < t.offset) Object.assign(t, { offset: 0, remainder: "", hits: [], model: "" });
      t.mtimeMs = info.mtimeMs;
      if (info.size === t.offset) return t;
      handle = await open(path, "r");
      // Only the tail matters for "where is it working now": skip far back on a first read of a big file.
      if (t.offset === 0 && info.size > READ_BUDGET) {
        if (codex) {
          const head = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(head, 0, head.length, 0);
          const first = head.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
          const meta = parseCodexMeta(first);
          if (meta) t.codex = { cwd: meta.cwd, nickname: meta.nickname, role: meta.role };
        }
        t.offset = info.size - READ_BUDGET;
        t.remainder = "";
        const skip = Buffer.alloc(1);
        // Drop the partial first line.
        let pos = t.offset;
        while (pos < info.size) {
          const { bytesRead } = await handle.read(skip, 0, 1, pos);
          pos++;
          if (!bytesRead || skip[0] === 10) break;
        }
        t.offset = pos;
      }
      const length = Math.min(info.size - t.offset, READ_BUDGET);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, t.offset);
      t.offset += bytesRead;
      const lines = (t.remainder + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      t.remainder = lines.pop() ?? "";
      if (t.remainder.length > 4_000_000) t.remainder = "";
      for (const line of lines) feedToolLine(t, line, codex);
    } catch {
      /* missing or unreadable: keep what we have */
    } finally {
      await handle?.close();
    }
    return t;
  }

  function feedToolLine(t: ToolTail, line: string, codex: boolean) {
    if (!line.trim()) return;
    if (codex ? !/"(session_meta|turn_context|custom_tool_call|function_call)"/.test(line) : !line.includes('"tool_use"') && !line.includes('"model"')) return;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { return; }
    if (codex) {
      const p = (row.payload ?? {}) as Record<string, unknown>;
      if (row.type === "session_meta") {
        const meta = parseCodexMeta(line);
        if (meta && !t.codex) t.codex = { cwd: meta.cwd, nickname: meta.nickname, role: meta.role };
      } else if (row.type === "turn_context") {
        if (typeof p.model === "string") t.model = p.model;
        if (typeof p.cwd === "string" && p.cwd) pushHits(t.hits, [{ path: p.cwd, weight: 1 }]);
      } else if (p.type === "custom_tool_call") pushHits(t.hits, codexToolPaths(String(p.name ?? ""), String(p.input ?? "")));
      else if (p.type === "function_call") pushHits(t.hits, codexToolPaths(String(p.name ?? ""), String(p.arguments ?? "")));
      return;
    }
    if (row.type !== "assistant") return;
    const message = (row.message ?? {}) as Record<string, unknown>;
    if (typeof message.model === "string" && message.model && !message.model.startsWith("<")) t.model = message.model;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const b = (block ?? {}) as Record<string, unknown>;
      if (b.type === "tool_use") pushHits(t.hits, claudeToolPaths(String(b.name ?? ""), (b.input ?? {}) as Record<string, unknown>));
    }
  }

  // ---------- git ----------

  /** The git checkout a path lives in (real path, so /tmp and /private/tmp agree), or null. */
  async function rootOf(path: string): Promise<string | null> {
    for (const dir of ancestors(path, home)) {
      if (gitRoots.has(dir)) {
        const hit = gitRoots.get(dir)!;
        if (hit) return hit;
        continue;
      }
      let found: string | null = null;
      try {
        await stat(join(dir, ".git"));
        found = await realpath(dir).catch(() => dir);
      } catch { /* not a checkout root */ }
      gitRoots.set(dir, found);
      if (gitRoots.size > 5000) gitRoots.clear();
      if (found) return found;
    }
    return null;
  }

  async function rank(hits: readonly PathHit[]) {
    const roots = new Map<string, string | null>();
    for (const h of hits) if (!roots.has(h.path)) roots.set(h.path, await rootOf(h.path));
    return rankWorktrees(hits, (p) => roots.get(p) ?? null);
  }

  async function worktree(path: string): Promise<TeamWorktree> {
    const hit = worktreeCache.get(path);
    if (hit && Date.now() - hit.at < 15_000) return hit.value;
    const value: TeamWorktree = { path, name: shortPath(path), repo: null, isMain: false, branch: null, head: null, changed: 0, ahead: null, behind: null, base: null, error: null };
    const [statusText, listText] = await Promise.all([git(path, ["status", "--porcelain=v2", "--branch"]), git(path, ["worktree", "list", "--porcelain"])]);
    if (statusText === null) value.error = "Could not read git status";
    else {
      const s = parseStatus(statusText);
      Object.assign(value, { branch: s.branch, head: s.head, changed: s.changed, ahead: s.ahead, behind: s.behind });
      const list = listText ? parseWorktreeList(listText) : [];
      const main = list[0];
      if (main) {
        const mainReal = await realpath(main.path).catch(() => main.path);
        value.repo = shortPath(mainReal);
        value.isMain = mainReal === path;
      }
      value.base = compareBase(s, main);
      if (value.base && !s.upstream && s.head) {
        const lr = parseLeftRight((await git(path, ["rev-list", "--left-right", "--count", `${value.base}...HEAD`])) ?? "");
        if (lr) [value.behind, value.ahead] = lr;
        else value.base = null;
      }
    }
    worktreeCache.set(path, { at: Date.now(), value });
    if (worktreeCache.size > 200) worktreeCache.clear();
    return value;
  }

  // ---------- files on disk ----------

  async function cachedDir<T>(path: string, ttl: number, read: () => Promise<T>): Promise<T> {
    const hit = dirListings.get(path);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = await read();
    dirListings.set(path, { at: Date.now(), value });
    if (dirListings.size > 400) dirListings.clear();
    return value;
  }

  /** Every <project>/<session> folder for a Claude Code session (a cwd change can split them). */
  async function sessionDirs(sessionId: string): Promise<string[]> {
    return cachedDir(`session:${sessionId}`, 10_000, async () => {
      const root = join(home, ".claude", "projects");
      const out: string[] = [];
      try {
        for (const dir of await readdir(root)) {
          const candidate = join(root, dir, sessionId);
          try {
            if ((await stat(candidate)).isDirectory()) out.push(candidate);
          } catch { /* not here */ }
        }
      } catch { /* no projects */ }
      return out;
    });
  }

  /** Claude Code sub-agent metas in a session: agent id -> meta. */
  async function subagentMetas(sessionId: string): Promise<{ id: string; file: string; meta: SubagentMeta }[]> {
    return cachedDir(`metas:${sessionId}`, 5_000, async () => {
      const out: { id: string; file: string; meta: SubagentMeta }[] = [];
      for (const dir of await sessionDirs(sessionId)) {
        const sub = join(dir, "subagents");
        let names: string[] = [];
        try { names = await readdir(sub); } catch { continue; }
        for (const name of names) {
          const m = /^agent-([A-Za-z0-9]+)\.meta\.json$/.exec(name);
          if (!m) continue;
          try {
            const meta = parseSubagentMeta(await readFile(join(sub, name), "utf8"));
            if (meta) out.push({ id: m[1], file: join(sub, `agent-${m[1]}.jsonl`), meta });
          } catch { /* unreadable */ }
        }
      }
      return out;
    });
  }

  /** Workflow run folders in a session, with their journals. */
  async function workflowRuns(sessionId: string): Promise<{ dir: string; agents: JournalAgent[] }[]> {
    return cachedDir(`runs:${sessionId}`, 4_000, async () => {
      const out: { dir: string; agents: JournalAgent[]; mtime: number }[] = [];
      for (const dir of await sessionDirs(sessionId)) {
        const wf = join(dir, "subagents", "workflows");
        let names: string[] = [];
        try { names = await readdir(wf); } catch { continue; }
        for (const name of names) {
          const journal = join(wf, name, "journal.jsonl");
          try {
            const [text, info] = await Promise.all([readFile(journal, "utf8"), stat(journal)]);
            out.push({ dir: join(wf, name), agents: parseJournal(text), mtime: info.mtimeMs });
          } catch { /* no journal yet */ }
        }
      }
      return out.sort((a, b) => a.mtime - b.mtime);
    });
  }

  /** ~/.codex/sessions/YYYY/MM/DD/rollout-...-<id>.jsonl, searched around the day it started. */
  async function codexRollout(id: string, at: number): Promise<string | null> {
    if (codexFiles.has(id)) return codexFiles.get(id) ?? null;
    const root = join(home, ".codex", "sessions");
    let found: string | null = null;
    for (const offset of [0, -1, 1]) {
      const d = new Date(at + offset * 86_400_000);
      const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
      try {
        const name = (await readdir(dir)).find((n) => n.endsWith(`-${id}.jsonl`));
        if (name) {
          found = join(dir, name);
          break;
        }
      } catch { /* no such day */ }
    }
    if (found || Date.now() - at > 120_000) codexFiles.set(id, found); // a brand-new rollout may not exist yet
    return found;
  }

  // ---------- assembly ----------

  function stateOf(rec: AgentRecord, now: number, lastLifeAt: number): TeamState {
    return effectiveState(rec, now, lastLifeAt);
  }

  async function team(threadId: string): Promise<DeskTeam> {
    const now = Date.now();
    const conversation = await deps.conversationFor(threadId);
    const followed = deps.followedThread(threadId, conversation);
    const members = conversation ? conversation.members : [{ threadId, kind: "root" as const, sourceThreadId: null, createdAt: 0, status: "" }];

    const agents: TeamAgent[] = [];
    const sessions: TeamSession[] = [];
    const usedPaths = new Map<string, number>();
    const use = (path: string | null) => {
      if (path) usedPaths.set(path, (usedPaths.get(path) ?? 0) + 1);
      return path;
    };
    const place = async (hits: readonly PathHit[]) => {
      const ranked = await rank(hits);
      return { worktree: use(ranked[0]?.root ?? null), alsoTouched: ranked.slice(1, 4).map((r) => use(r.root)!).filter(Boolean) };
    };

    for (const member of members) {
      const memberId = member.threadId;
      let thread: Awaited<ReturnType<typeof bb.sdk.threads.get>> | null = null;
      try {
        thread = await bb.sdk.threads.get({ threadId: memberId, include: "environment" });
      } catch {
        continue; // deleted
      }
      const provider = providerName(thread.providerId ?? "");
      const codexSession = (thread.providerId ?? "").includes("codex");
      const role: TeamSession["role"] = conversation ? member.kind : "chat";

      // A Fleet mirror: a read-only copy here of a chat running on another Mac. Its agent works there.
      if ((thread.providerId ?? "").includes("fleet-mirror")) {
        let mirror: ReturnType<typeof parseMirrorMeta> = null;
        try { mirror = parseMirrorMeta(await bb.sdk.threads.getPluginMetadata({ threadId: memberId, pluginId: "fleet" })); } catch { /* no Fleet */ }
        const machine = mirror?.machine ?? "another Mac";
        sessions.push({ threadId: memberId, title: clip(thread.title || "Chat on another Mac", 120), provider, model: `On ${machine}`, role, active: memberId === followed, status: thread.status, createdAt: thread.createdAt });
        agents.push({
          id: `mirror:${memberId}`,
          kind: "remote",
          name: clip(thread.title || `Chat on ${machine}`, 80),
          provider: `Fleet · ${machine}`,
          model: "",
          state: ["active", "starting", "pending", "stopping"].includes(thread.status) ? "running" : thread.status === "error" ? "failed" : "finished",
          threadId: memberId,
          parentId: null,
          startedAt: thread.createdAt,
          phase: null,
          worktree: null,
          alsoTouched: [],
          worktreeSource: "none",
          link: {
            threadId: mirror?.remoteThreadId ?? null,
            url: mirror && /^[a-z0-9-]+$/.test(mirror.serverId) ? `https://${mirror.serverId}.getbb.app/threads/${mirror.remoteThreadId}` : null,
            machine: mirror?.machine ?? null,
            localThreadId: memberId,
          },
          note: `Runs on ${machine}; this bb keeps a read-only copy`,
        });
        continue;
      }
      const [entry, obs, leadModel] = await Promise.all([deps.sync(memberId), observe(memberId), deps.leadModel(memberId)]);
      sessions.push({
        threadId: memberId,
        title: clip(thread.title || thread.titleFallback || "Untitled chat", 120),
        provider,
        model: leadModel,
        role,
        active: memberId === followed,
        status: thread.status,
        createdAt: thread.createdAt,
      });

      // The lead: bb's environment is where it starts; its own tool calls show where it works.
      const env = "environment" in thread ? thread.environment : null;
      const leadHits = [...obs.lead];
      if (entry.providerSessionId && !codexSession) {
        for (const dir of await sessionDirs(entry.providerSessionId)) {
          const file = `${dir}.jsonl`;
          const t = await toolTail(file, false);
          leadHits.push(...t.hits);
        }
      }
      const envRoot = env?.path ? await rootOf(env.path) : null;
      const leadPlace = await place(leadHits);
      const leadWorktree = leadPlace.worktree ?? use(envRoot);
      let pending = 0;
      try { pending = (await bb.sdk.threads.interactions.list({ threadId: memberId })).length; } catch { /* none */ }
      const leadId = `lead:${memberId}`;
      agents.push({
        id: leadId,
        kind: "lead",
        name: role === "continuation" ? "Lead (continuation)" : role === "parallel" ? "Lead (parallel)" : "Lead",
        provider,
        model: leadModel,
        state: pending > 0 || thread.status === "error" ? "needs-you" : ["active", "starting", "pending", "stopping"].includes(thread.status) ? "running" : "waiting",
        threadId: memberId,
        parentId: null,
        startedAt: thread.createdAt,
        phase: null,
        worktree: leadWorktree,
        alsoTouched: leadPlace.alsoTouched.filter((p) => p !== leadWorktree).slice(0, 3),
        worktreeSource: leadPlace.worktree ? "tool-calls" : envRoot ? "bb" : "none",
        link: null,
        note: env?.path ? clip(`Started in ${env.path}${env.branchName ? ` on ${env.branchName}` : ""}`, 200) : "",
      });

      // Sub-agents and Workflow runs from bb's events.
      const metas = entry.providerSessionId && !codexSession ? await subagentMetas(entry.providerSessionId) : [];
      const runs = entry.providerSessionId && !codexSession ? await workflowRuns(entry.providerSessionId) : [];
      const records = [...entry.state.agents.values()].sort((a, b) => a.order - b.order);
      const runAgents = new Map<string, AgentRecord[]>();
      for (const r of records) {
        if (!r.parentId || entry.state.agents.get(r.parentId)?.agentType !== "workflow" || !r.id.startsWith(`${r.parentId}:a`)) continue;
        const list = runAgents.get(r.parentId) ?? [];
        list.push(r);
        runAgents.set(r.parentId, list);
      }
      const runDirs = new Map<string, string | null>();
      for (const [runId, kids] of runAgents) runDirs.set(runId, matchRun(kids.map((k) => k.name), runs));

      for (const rec of records) {
        const isRunAgent = !!rec.parentId && runAgents.has(rec.parentId) && rec.id.startsWith(`${rec.parentId}:a`);
        const isRun = rec.agentType === "workflow" && !isRunAgent;
        let hits: PathHit[] = [...(obs.delegations[rec.id] ?? [])];
        let isolated: string | null = null;
        let model = rec.model;
        let phase: string | null = null;
        let lastLifeAt = 0;
        let note = "";
        if (isRunAgent) {
          phase = rec.agentType && rec.agentType !== "workflow agent" ? rec.agentType : null;
          const dir = runDirs.get(rec.parentId!);
          const ja = dir ? runs.find((r) => r.dir === dir)?.agents.find((a) => a.label === rec.name) : undefined;
          if (dir && ja) {
            const t = await toolTail(join(dir, `agent-${ja.agentId}.jsonl`), false);
            hits = hits.concat(t.hits);
            model = t.model || model;
            lastLifeAt = t.mtimeMs;
            try {
              const meta = parseSubagentMeta(await readFile(join(dir, `agent-${ja.agentId}.meta.json`), "utf8"));
              if (meta?.worktreePath) isolated = meta.worktreePath;
            } catch { /* no meta */ }
          }
        } else if (!isRun) {
          const ref = obs.childRefs[rec.id] ?? null;
          if (codexSession) {
            const file = ref ? await codexRollout(ref, rec.startedAt) : null;
            if (file) {
              const t = await toolTail(file, true);
              hits = hits.concat(t.hits);
              if (!hits.length && t.codex?.cwd) hits.push({ path: t.codex.cwd, weight: 1 });
              model = t.model || model;
              lastLifeAt = t.mtimeMs;
              if (t.codex?.role) phase = t.codex.role;
              if (t.codex?.nickname) note = `Codex agent ${t.codex.nickname}`;
            }
          } else {
            const meta =
              (ref ? metas.find((m) => m.meta.toolUseId === ref) : undefined) ??
              [...metas].reverse().find((m) => m.meta.description === rec.name);
            if (meta) {
              const t = await toolTail(meta.file, false);
              hits = hits.concat(t.hits);
              model = t.model || meta.meta.model || model;
              lastLifeAt = t.mtimeMs;
              if (meta.meta.worktreePath) isolated = meta.meta.worktreePath;
            }
          }
        }
        let worktreePath: string | null = null;
        let also: string[] = [];
        let source: TeamAgent["worktreeSource"] = "none";
        if (isolated) {
          worktreePath = use((await rootOf(isolated)) ?? isolated);
          source = "isolated";
        } else if (hits.length) {
          const p = await place(hits);
          worktreePath = p.worktree;
          also = p.alsoTouched;
          source = worktreePath ? "tool-calls" : "none";
        }
        const parentId = rec.parentId && entry.state.agents.has(rec.parentId) ? `${memberId}:${rec.parentId}` : leadId;
        agents.push({
          id: `${memberId}:${rec.id}`,
          kind: isRun ? "workflow" : isRunAgent ? "workflow-agent" : "subagent",
          name: clip(rec.name, 80),
          provider: isRun || isRunAgent ? "Workflow" : provider,
          model: model ? deps.modelLabel(model) : "",
          state: stateOf(rec, now, lastLifeAt),
          threadId: memberId,
          parentId,
          startedAt: rec.startedAt,
          phase,
          worktree: worktreePath,
          alsoTouched: also.filter((p) => p !== worktreePath).slice(0, 3),
          worktreeSource: source,
          link: null,
          note,
        });
      }

      // Child bb threads this session started (bb thread spawn --parent).
      let children: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
      try { children = await bb.sdk.threads.list({ parentThreadId: memberId, includeHidden: true, limit: 50 }); } catch { /* none */ }
      for (const child of children) {
        let cpath: string | null = null;
        let branch: string | null = null;
        try {
          const full = await bb.sdk.threads.get({ threadId: child.id, include: "environment" });
          const cenv = "environment" in full ? full.environment : null;
          cpath = cenv?.path ?? null;
          branch = cenv?.branchName ?? null;
        } catch { /* gone */ }
        const croot = cpath ? await rootOf(cpath) : null;
        agents.push({
          id: `thread:${child.id}`,
          kind: "thread",
          name: clip(child.title || "Untitled chat", 80),
          provider: providerName(child.providerId ?? ""),
          model: "",
          state: ["active", "starting", "pending", "stopping"].includes(child.status) ? "running" : child.status === "error" ? "failed" : "finished",
          threadId: memberId,
          parentId: leadId,
          startedAt: child.createdAt,
          phase: null,
          worktree: use(croot),
          alsoTouched: [],
          worktreeSource: croot ? "bb" : "none",
          link: { threadId: child.id, url: null, machine: null, localThreadId: child.id },
          note: cpath && !croot ? clip(`Works in ${cpath}`, 200) : branch ? `bb branch ${branch}` : "",
        });
      }

      // Work sent to another Mac through Fleet.
      for (const call of obs.fleet) {
        agents.push({
          id: `remote:${memberId}:${call.threadId ?? call.commandId ?? call.prompt}`,
          kind: "remote",
          name: call.prompt || `Work on ${call.machine}`,
          provider: `Fleet · ${call.machine}`,
          model: "",
          state: call.outcome === "answered" ? "finished" : call.outcome === "failed" ? "failed" : call.at && now - call.at > REMOTE_FRESH_MS ? "finished" : "running",
          threadId: memberId,
          parentId: leadId,
          startedAt: call.at || null,
          phase: null,
          worktree: null,
          alsoTouched: [],
          worktreeSource: "none",
          link: { threadId: call.threadId, url: call.url, machine: call.machine, localThreadId: null },
          note:
            call.outcome === "answered" ? "Answered" : call.outcome === "sent" ? `Queued until ${call.machine} picks it up` : call.outcome === "waiting" ? "Still working when Helper Desk last saw it" : call.outcome === "failed" ? "Could not start" : `Started on ${call.machine}`,
        });
      }
    }

    // Workflow runs: their worktrees are their agents' worktrees.
    for (const run of agents.filter((a) => a.kind === "workflow")) {
      const kids = agents.filter((a) => a.parentId === run.id && a.worktree);
      const counts = new Map<string, number>();
      for (const k of kids) counts.set(k.worktree!, (counts.get(k.worktree!) ?? 0) + 1);
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (ranked.length === 1) {
        run.worktree = ranked[0][0];
        run.worktreeSource = "tool-calls";
      } else if (ranked.length > 1) run.note = `${ranked.length} worktrees`;
    }

    const { agents: kept, omitted } = capTeam(agents, MAX_AGENTS);
    const wanted = new Set<string>();
    for (const a of kept) {
      if (a.worktree) wanted.add(a.worktree);
      for (const p of a.alsoTouched) wanted.add(p);
    }
    const paths = [...wanted].sort((a, b) => (usedPaths.get(b) ?? 0) - (usedPaths.get(a) ?? 0)).slice(0, 60);
    const worktrees = await Promise.all(paths.map((p) => worktree(p)));
    const known = new Set(paths);
    for (const a of kept) {
      if (a.worktree && !known.has(a.worktree)) a.worktree = null;
      a.alsoTouched = a.alsoTouched.filter((p) => known.has(p));
    }
    return { threadId, sessions, agents: kept, worktrees, omitted, updatedAt: now };
  }

  return { team, observe };
}

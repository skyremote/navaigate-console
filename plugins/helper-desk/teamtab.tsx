// Helper Desk — Team tab. Every agent working for this chat, across the
// conversation's sessions (a native continuation such as Sol to Opus keeps its
// own lead and agents), and the git worktree each one works in.
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { worktreeLine, type DeskTeam, type TeamAgent, type TeamKind, type TeamSession, type TeamState, type TeamWorktree } from "./team";
import { Mascot, colourForId, mascotStateFor } from "./mascots";
import { MascotChooser, MascotTrigger, useMascotMenu } from "./mascotpicker";
import "./team.css";

const KIND_LABEL: Record<TeamKind, string> = {
  lead: "Lead",
  subagent: "Sub-agent",
  workflow: "Workflow",
  "workflow-agent": "Workflow agent",
  thread: "Chat",
  remote: "Other Mac",
};
const STATE_LABEL: Record<TeamState, string> = {
  running: "Working",
  waiting: "Waiting for you",
  "needs-you": "Needs you",
  finished: "Finished",
  failed: "Failed",
  interrupted: "Stopped",
};
const LIVE: ReadonlySet<TeamState> = new Set(["running", "needs-you"]);

export function useTeam(threadId: string, active: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [data, setData] = useState<DeskTeam | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setData(await rpcRef.current.call("team", { threadId }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, [threadId]);
  useEffect(() => {
    if (!active) return;
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 10_000);
    return () => clearInterval(t);
  }, [active, load]);
  useRealtime("desk-changed", (payload) => {
    const p = payload as { threadId?: string } | null;
    if (active && p?.threadId === threadId) void load();
  });
  return { data, error, reload: load };
}

/** Keep the live agents and every ancestor they hang under. */
function withAncestors(agents: readonly TeamAgent[], pick: (a: TeamAgent) => boolean): TeamAgent[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const keep = new Set<string>();
  for (const a of agents) {
    if (!pick(a)) continue;
    for (let cur: TeamAgent | undefined = a; cur && !keep.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) keep.add(cur.id);
  }
  return agents.filter((a) => keep.has(a.id));
}

function WorktreeChip({ path, worktrees, dim = false }: { path: string; worktrees: Map<string, TeamWorktree>; dim?: boolean }) {
  const w = worktrees.get(path);
  if (!w) return null;
  const tone = w.error ? "unknown" : w.changed > 0 ? "dirty" : "clean";
  return (
    <span className={`ht-wt ht-wt-${tone}${dim ? " ht-wt-dim" : ""}`} title={`${w.path}${w.repo ? ` (${w.isMain ? "main checkout of" : "worktree of"} ${w.repo})` : ""}`}>
      <span className="ht-wt-dot" aria-hidden="true" />
      <span className="ht-wt-name">{w.name}</span>
      <span className="ht-wt-line">{w.error ? w.error : worktreeLine(w)}</span>
    </span>
  );
}

function AgentLine({ agent, worktrees, onOpenThread }: { agent: TeamAgent; worktrees: Map<string, TeamWorktree>; onOpenThread: (id: string) => void }) {
  const meta = [agent.provider, agent.model, agent.phase].filter(Boolean).join(" · ");
  const seed = agent.kind === "lead" ? agent.threadId : agent.id;
  const [picking, togglePicking] = useMascotMenu();
  return (
    <div className={`ht-agent ht-${agent.state} ht-kind-${agent.kind}`}>
      <MascotTrigger name={agent.name} open={picking} onToggle={togglePicking}>
        <Mascot seed={seed} colour={colourForId(seed)} state={mascotStateFor(agent.state)} size={24} />
      </MascotTrigger>
      <div className="ht-agent-main">
        <div className="ht-agent-top">
          <span className="ht-state-dot" aria-hidden="true" />
          <span className="ht-name" title={agent.name}>{agent.name}</span>
          <span className="ht-kind">{KIND_LABEL[agent.kind]}</span>
        </div>
        <div className="ht-meta">
          <span>{STATE_LABEL[agent.state]}</span>
          {meta && <span> · {meta}</span>}
        </div>
        {agent.worktree ? (
          <WorktreeChip path={agent.worktree} worktrees={worktrees} />
        ) : agent.kind !== "remote" ? (
          <span className="ht-wt ht-wt-none">{agent.note && agent.kind === "workflow" ? agent.note : "No git worktree seen yet"}</span>
        ) : null}
        {agent.alsoTouched.length > 0 && (
          <div className="ht-also">
            Also touched: {agent.alsoTouched.map((p) => worktrees.get(p)?.name ?? p).join(", ")}
          </div>
        )}
        {agent.note && agent.kind !== "workflow" && <div className="ht-note">{agent.note}</div>}
        {agent.link && (agent.link.url || agent.link.localThreadId || agent.link.threadId) && (
          <div className="ht-link">
            {agent.link.url && (
              <a href={agent.link.url} target="_blank" rel="noreferrer">
                Open on {agent.link.machine ?? "that Mac"}
              </a>
            )}
            {agent.link.localThreadId && (
              <button type="button" onClick={() => onOpenThread(agent.link!.localThreadId!)}>
                {agent.kind === "remote" ? "Open the copy here" : "Open chat"}
              </button>
            )}
            {!agent.link.url && !agent.link.localThreadId && agent.link.threadId && (
              <span className="ht-note">
                Thread {agent.link.threadId} on {agent.link.machine ?? "another Mac"}
              </span>
            )}
          </div>
        )}
        {picking && <MascotChooser seed={seed} name={agent.name} colour={colourForId(seed)} />}
      </div>
    </div>
  );
}

function Tree({ agents, worktrees, onOpenThread }: { agents: TeamAgent[]; worktrees: Map<string, TeamWorktree>; onOpenThread: (id: string) => void }) {
  const ids = new Set(agents.map((a) => a.id));
  const roots = agents.filter((a) => !a.parentId || !ids.has(a.parentId));
  const branch = (a: TeamAgent, depth: number): ReactElement => {
    const kids = depth < 5 ? agents.filter((c) => c.parentId === a.id) : [];
    return (
      <li key={a.id} className="ht-node">
        <AgentLine agent={a} worktrees={worktrees} onOpenThread={onOpenThread} />
        {kids.length > 0 && <ul className="ht-kids">{kids.map((k) => branch(k, depth + 1))}</ul>}
      </li>
    );
  };
  return <ul className="ht-tree">{roots.map((r) => branch(r, 0))}</ul>;
}

function SessionStrip({ sessions }: { sessions: TeamSession[] }) {
  if (sessions.length < 2) return null;
  // The main line (the first session and each continuation), then anything running alongside.
  const chain = sessions.filter((s) => s.role !== "parallel");
  const alongside = sessions.filter((s) => s.role === "parallel");
  const chip = (s: TeamSession, label: string) => (
    <span className={s.active ? "ht-session ht-session-now" : "ht-session"} key={s.threadId}>
      <span className="ht-session-model">{s.model || s.provider}</span>
      <span className="ht-session-role">{label}</span>
    </span>
  );
  return (
    <div className="ht-sessions" aria-label="Sessions in this conversation">
      {chain.map((s, i) => (
        <span className="ht-session-step" key={s.threadId}>
          {i > 0 && <span className="ht-session-arrow" aria-hidden="true">&#8594;</span>}
          {chip(s, s.active ? "now" : i === 0 ? "first" : "continuation")}
        </span>
      ))}
      {alongside.length > 0 && <span className="ht-session-sep">alongside</span>}
      {alongside.map((s) => chip(s, s.active ? "now" : "parallel"))}
    </div>
  );
}

export function TeamView({ data, onOpenThread }: { data: DeskTeam; onOpenThread: (id: string) => void }) {
  const worktrees = new Map(data.worktrees.map((w) => [w.path, w]));
  const multi = data.sessions.length > 1;
  const live = withAncestors(data.agents, (a) => LIVE.has(a.state));
  const liveIds = new Set(live.filter((a) => LIVE.has(a.state)).map((a) => a.id));
  const earlier = withAncestors(data.agents, (a) => !liveIds.has(a.id) && a.kind !== "lead");
  const working = data.agents.filter((a) => LIVE.has(a.state) && a.kind !== "lead").length;
  const bySession = (list: TeamAgent[]) =>
    data.sessions
      .map((s) => ({ session: s, agents: list.filter((a) => a.threadId === s.threadId) }))
      .filter((g) => g.agents.length > 0);
  const users = new Map<string, number>();
  for (const a of data.agents) if (a.worktree) users.set(a.worktree, (users.get(a.worktree) ?? 0) + 1);
  // Worktrees an agent works in first (most agents first); ones only read in passing go in a fold.
  const used = data.worktrees.filter((w) => (users.get(w.path) ?? 0) > 0).sort((a, b) => (users.get(b.path) ?? 0) - (users.get(a.path) ?? 0));
  const touched = data.worktrees.filter((w) => !users.get(w.path));
  const worktreeRow = (w: TeamWorktree) => (
    <li key={w.path}>
      <WorktreeChip path={w.path} worktrees={worktrees} />
      <span className="ht-wt-users">
        {users.get(w.path) ?? 0} {(users.get(w.path) ?? 0) === 1 ? "agent" : "agents"} · {w.path}
      </span>
    </li>
  );
  const groups = (list: TeamAgent[]) =>
    bySession(list).map(({ session, agents }) => (
      <section key={session.threadId} className="ht-group">
        {multi && (
          <h4 className="ht-group-h">
            {session.model || session.provider} session{session.active ? " · now" : ""}
            <span className="ht-group-sub">{session.title}</span>
          </h4>
        )}
        <Tree agents={agents} worktrees={worktrees} onOpenThread={onOpenThread} />
      </section>
    ));
  return (
    <div className="ht-root">
      <p className="ht-summary">
        {working === 0 ? "No agents working right now" : `${working} ${working === 1 ? "agent" : "agents"} working`} ·{" "}
        {used.length} {used.length === 1 ? "worktree" : "worktrees"} in use
        {multi ? ` · ${data.sessions.length} sessions` : ""}
      </p>
      <SessionStrip sessions={data.sessions} />
      <h3 className="ht-h">Working now</h3>
      {live.length ? groups(live) : <p className="ht-empty">Nobody is working for this chat right now.</p>}
      {earlier.length > 0 && (
        <details className="ht-earlier">
          <summary>Earlier in this chat · {earlier.filter((a) => a.kind !== "lead").length}</summary>
          {groups(earlier)}
        </details>
      )}
      {used.length > 0 && (
        <>
          <h3 className="ht-h">Worktrees</h3>
          <ul className="ht-wtlist">{used.map(worktreeRow)}</ul>
        </>
      )}
      {touched.length > 0 && (
        <details className="ht-earlier">
          <summary>Also touched, no agent working there · {touched.length}</summary>
          <ul className="ht-wtlist">{touched.map(worktreeRow)}</ul>
        </details>
      )}
      {data.omitted > 0 && <p className="ht-foot">{data.omitted} older finished agents not shown.</p>}
      <p className="ht-foot">Worktrees come from bb's environment, Claude Code's worktree isolation, or the folders each agent's own tool calls touch. Git is only read.</p>
    </div>
  );
}

export function TeamTab({ threadId, active }: { threadId: string; active: boolean }) {
  const { data, error } = useTeam(threadId, active);
  const nav = useBbNavigate();
  if (error && !data) return <p className="hd-empty">Could not load the team: {error}</p>;
  if (!data) return <p className="hd-empty">Finding every agent and worktree…</p>;
  return <TeamView data={data} onOpenThread={(id) => nav.toThread(id)} />;
}

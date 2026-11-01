// bb-plugin-fleet — frontend entry: the Fleet page.
//
// One column per machine in the profile. Each column shows whether the machine
// is reachable, what it can reach (NAS, VPN...), every live or recent thread,
// and a box to start work directly on that machine. The server's
// "fleet-changed" signal refetches; a 20s timer keeps "last seen" honest.
import { useCallback, useEffect, useRef, useState } from "react";
import { MirrorOwnerWorkspaceTab, useMirrorCopyVisible } from "./components/mirror-workspace-tab";
import { definePluginApp, useBbNavigate, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BoardResult, Column, rpcContract } from "./server";
import { FleetManagement, type FleetMachineEntry } from "./components/fleet-management";
import { RelayActions } from "./components/relay-actions";
import { SentFromHere } from "./components/sent-from-here";
import { StartBox, type StartMode } from "./components/start-box";
import { ThreadCard } from "./components/thread-card";
import { BOARD_MAX_STALE_MS, rpcFlight } from "./lib/rpc-flight";
import { reachOf } from "./lib/reach";
import { useVisiblePoll, useVisibleRealtime } from "./lib/visible-poll";


type Board = BoardResult;

const STYLE = `
.fleet{font-family:var(--font-sans);color:var(--foreground);padding:24px 28px 32px;overflow:auto;height:100%}
.fleet :is(button,input,select,textarea):focus-visible{outline:none;box-shadow:0 0 0 2px var(--ring)}
.fleet-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.fleet-h1{font-family:var(--font-display,var(--font-sans));font-size:24px;font-weight:500;line-height:32px}
.fleet-sum{font-size:13px;line-height:20px;color:var(--muted-foreground);margin-top:4px}
.fleet-pill{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--border);color:var(--muted-foreground);display:inline-flex;align-items:center;gap:6px}
.fleet-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;align-items:start}
.fleet-col{background:var(--surface-recessed);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0}
.fleet-mh{display:flex;align-items:center;justify-content:space-between;gap:8px}
.fleet-mn{font-size:14px;font-weight:500;display:flex;align-items:center;gap:8px}
.fleet-dot{width:8px;height:8px;border-radius:50%;flex:none}
.fleet-mu{font-size:12px;color:var(--muted-foreground);white-space:nowrap}
.fleet-caps{display:flex;flex-wrap:wrap;gap:4px}
.fleet-cap{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--card);border:1px solid var(--border);color:var(--muted-foreground)}
.fleet-stats{display:flex;gap:12px;font-size:12px;color:var(--muted-foreground)}
.fleet-stats b{color:var(--foreground);font-weight:500}
.fleet-list{display:flex;flex-direction:column;gap:8px;max-height:520px;overflow:auto;margin:0 -2px;padding:0 2px}
.fleet-card{text-align:left;width:100%;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;cursor:pointer;transition:border-color .15s;color:inherit;font:inherit}
.fleet-card:hover{border-color:var(--input)}
.fleet-proj{font-size:11px;color:var(--muted-foreground);margin-bottom:4px;display:flex;align-items:center;gap:6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.fleet-proj i{width:6px;height:6px;border-radius:2px;background:var(--muted-foreground);flex:none}
.fleet-tt{font-size:13px;font-weight:500;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fleet-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
.fleet-st{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;white-space:nowrap}
.fleet-st b{width:6px;height:6px;border-radius:50%;background:currentColor}
.fleet-st.running{color:var(--attention)}
.fleet-st.running b{animation:fleet-p 1.4s infinite}
.fleet-st.needs-you{color:var(--warning-text)}
.fleet-st.queued{color:var(--muted-foreground)}
.fleet-st.error{color:var(--destructive-text)}
.fleet-st.idle{color:var(--muted-foreground)}
.fleet-row-start{display:flex;align-items:center;gap:6px;min-width:0}
.fleet-acct{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--border);border-radius:4px;padding:0 6px;font-size:11px;line-height:16px;color:var(--muted-foreground)}
.fleet-meta{font-size:11px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fleet-empty{font-size:12px;color:var(--muted-foreground);text-align:center;padding:16px 0}
.fleet-start{border:1px dashed var(--input);border-radius:var(--radius);background:transparent;color:var(--muted-foreground);font:inherit;font-size:13px;min-height:32px;padding:6px 10px;cursor:pointer;width:100%}
.fleet-start:hover{color:var(--foreground);background:var(--accent)}
.fleet-box{background:var(--card);border:1px solid var(--input);border-radius:var(--radius);padding:8px}
.fleet-box textarea{width:100%;min-height:72px;resize:vertical;background:transparent;border:0;outline:0;color:var(--foreground);font:inherit;font-size:13px;line-height:1.45}
.fleet-box-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px}
.fleet-hint{font-size:11px;color:var(--muted-foreground)}
.fleet-btn{font:inherit;font-size:13px;min-height:32px;padding:4px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--secondary);color:var(--secondary-foreground);cursor:pointer;transition:background-color .15s}
.fleet-btn:hover:not(:disabled){background:var(--accent)}
.fleet-btn.p{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
.fleet-btn.p:hover:not(:disabled){background:var(--primary);opacity:.9}
.fleet-btn:disabled{opacity:.5;cursor:default}
.fleet-note{font-size:13px;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--card);color:var(--foreground);margin-bottom:16px;line-height:1.45}
.fleet-sent{margin-top:20px}
.fleet-sent h3{font-size:14px;font-weight:500;margin:0 0 8px}
.fleet-sent-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:8px 0;border-bottom:1px solid var(--border);gap:12px}
.fleet-sent-row:last-child{border-bottom:0}
.fleet-card-wrap{display:flex;flex-direction:column;gap:4px}
.fleet-card-tools{display:flex;gap:6px;justify-content:flex-end}
.fleet-mini{font:inherit;font-size:12px;min-height:24px;padding:2px 10px;border-radius:var(--radius);border:1px solid var(--border);background:transparent;color:var(--muted-foreground);cursor:pointer}
.fleet-mini:hover,.fleet-mini[aria-expanded=true]{color:var(--foreground);background:var(--accent)}
.fleet-card-panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:8px}
.fleet-link{background:none;border:0;padding:0;font:inherit;color:var(--foreground);text-decoration:underline;cursor:pointer}
@keyframes fleet-p{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.fleet-st.running b{animation:none}}
`;

function ago(at: number | null): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((fresh: boolean) => {
    rpcFlight().call("board_get", () => rpc.call("board_get", null), { fresh, maxStaleMs: BOARD_MAX_STALE_MS }).then(
      (b) => {
        setBoard(b);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  const refetch = useCallback(() => load(true), [load]);
  const poll = useCallback(() => load(false), [load]);
  useEffect(poll, [poll]);
  useVisiblePoll(poll, 20_000);
  useVisibleRealtime("fleet-changed", refetch);
  const connection = useRealtimeConnectionState();
  const seen = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (seen.current) refetch();
    seen.current = true;
  }, [connection, refetch]);
  return { rpc, board, error, refetch };
}

/** The machines (id and label, in the owner's order) from the server's resolved profile. */
function useProfileMachines(rpc: ReturnType<typeof useBoard>["rpc"], fallback: FleetMachineEntry[]): FleetMachineEntry[] {
  const [machines, setMachines] = useState<FleetMachineEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("profile_get", null).then(
      (profile) => { if (live) setMachines(profile.machines.map((machine) => ({ id: machine.id, label: machine.label }))); },
      () => undefined,
    );
    return () => { live = false; };
  }, [rpc]);
  return machines ?? fallback;
}

function FleetPage() {
  const { rpc, board, error, refetch } = useBoard();
  const machines = useProfileMachines(rpc, board ? board.columns.map((column) => ({ id: column.key, label: column.label })) : []);
  const navigate = useBbNavigate();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const open = (thread: Column["threads"][number]) => {
    if (board && thread.via === board.me.serverId) navigate.toThread(thread.id);
    else if (thread.url) navigate.openUrl(thread.url);
  };

  const [tellOpen, setTellOpen] = useState<string | null>(null);
  const [receiptsKey, setReceiptsKey] = useState(0);
  const [watchId, setWatchId] = useState<string | null>(null);

  const start = async (column: Column, prompt: string, mode: StartMode) => {
    try {
      const requestId = mode === "ask" ? crypto.randomUUID() : undefined;
      const r = await rpc.call("work_start", { machine: column.key, prompt, ...(requestId ? { requestId } : {}) });
      setReceiptsKey((n) => n + 1);
      if (requestId) {
        setWatchId(requestId);
        toast.success(`Asked ${column.label}. Its answer shows under Sent from here (receipt ${requestId}).`);
      } else if (r.outcome === "started") {
        toast.success(`Started on ${column.label}`);
        if (column.local && r.threadId) navigate.toThread(r.threadId);
      } else {
        toast.success(`Sent to ${column.label}. It starts within a few seconds if the machine is awake.`);
      }
      refetch();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  if (board === null) {
    return (
      <div className="fleet">
        <style>{STYLE}</style>
        <div className="fleet-sum">{error ?? "Loading Fleet"}</div>
      </div>
    );
  }

  const totals = board.columns.reduce(
    (acc, c) => ({
      running: acc.running + c.counts.running,
      needsYou: acc.needsYou + c.counts.needsYou,
      online: acc.online + (c.online ? 1 : 0),
    }),
    { running: 0, needsYou: 0, online: 0 },
  );

  return (
    <div className="fleet">
      <style>{STYLE}</style>
      <div className="fleet-top">
        <div>
          <div className="fleet-h1">Fleet</div>
          <div className="fleet-sum">
            {totals.online} of {board.columns.length} machines online · {totals.running} running
            {totals.needsYou > 0 ? ` · ${totals.needsYou} waiting on you` : ""}
          </div>
        </div>
        <span className="fleet-pill" title={board.error ?? undefined}>
          <span className="fleet-dot" style={{ background: board.error ? "var(--warning)" : board.me.joined ? "var(--success)" : "var(--muted-foreground)" }} />
          {board.me.label} · {board.me.joined ? (board.error ? "sync issue" : "sharing") : "not sharing"}
        </span>
      </div>

      {!board.me.joined ? (
        <div className="fleet-note">
          {board.me.brain
            ? "This bb shows only its own machines. To see and start work on the other Macs, switch on Join the fleet under Settings, Plugins, Fleet."
            : "This Mac has no brain connection, so it shows only itself. Connect a brain in the Console setup to see and reach other Macs."}
        </div>
      ) : null}

      <div className="fleet-grid">
        {board.columns.map((column) => {
          const reach = reachOf(column, board);
          return (
            <section key={column.key} className={`fleet-col${column.online ? "" : " off"}`}>
              <div className="fleet-mh">
                <span className="fleet-mn">
                  <span className="fleet-dot" style={{ background: column.online ? "var(--success)" : "var(--muted-foreground)" }} />
                  {column.label}
                </span>
                <span className="fleet-mu">{column.online ? (column.serverId ?? "enrolled") : `offline · ${ago(column.lastSeenAt)}`}</span>
              </div>
              {column.capabilities.length > 0 ? (
                <div className="fleet-caps">
                  {column.capabilities.map((c) => (
                    <span key={c} className="fleet-cap">
                      {c}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="fleet-stats">
                <span>
                  <b>{column.counts.running}</b> running
                </span>
                {column.counts.needsYou > 0 ? (
                  <span>
                    <b>{column.counts.needsYou}</b> need you
                  </span>
                ) : null}
                {column.counts.queued > 0 ? (
                  <span>
                    <b>{column.counts.queued}</b> queued
                  </span>
                ) : null}
              </div>
              <div className="fleet-list">
                {column.threads.length === 0 ? <div className="fleet-empty">Nothing in the last day</div> : null}
                {column.threads.map((t) => {
                  const key = `${t.via}:${t.id}`;
                  return (
                    <div key={key} className="fleet-card-wrap">
                      <ThreadCard thread={t} via={t.via !== column.serverId && column.serverId !== null ? t.via : null} age={ago(t.updatedAt)} onOpen={open} />
                      {reach !== null ? (
                        <div className="fleet-card-tools">
                          <button type="button" className="fleet-mini" aria-expanded={tellOpen === key} aria-label={`Tell ${column.label} about ${t.title}`} onClick={() => setTellOpen(tellOpen === key ? null : key)}>
                            Tell
                          </button>
                        </div>
                      ) : null}
                      {tellOpen === key ? (
                        <div className="fleet-card-panel">
                          <RelayActions machine={column.key} threadId={t.id} threadTitle={t.title} onSent={() => setReceiptsKey((n) => n + 1)} />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {reach !== null ? <StartBox column={column} reach={reach} onStart={(p, mode) => start(column, p, mode)} /> : null}
            </section>
          );
        })}
      </div>

      <FleetManagement localMachine={board.me.machineKey} machines={machines} threadsByMachine={Object.fromEntries(board.columns.map((column) => [column.key, column.threads.filter((thread) => column.serverId !== null && thread.via === column.serverId).map((thread) => ({ id: thread.id, title: thread.title }))]))} />

      <SentFromHere commands={board.commands} refreshKey={receiptsKey} watchId={watchId} onOpen={(url) => navigate.openUrl(url)} />
    </div>
  );
}

function RunningCount() {
  const { board } = useBoard();
  if (board === null) return null;
  const n = board.columns.reduce((a, c) => a + c.counts.running + c.counts.needsYou, 0);
  return n === 0 ? null : <span className="text-xs text-muted-foreground">{n}</span>;
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    id: "mirror-owner-workspace",
    title: "Owner workspace",
    icon: "Server",
    tooltip: "Files, previews and questions on the Mac that owns this chat",
    context: { kind: "thread" },
    availability: "fixed",
    useVisible: useMirrorCopyVisible,
    component: MirrorOwnerWorkspaceTab,
  });
  app.slots.navPanel({
    id: "fleet",
    title: "Fleet",
    icon: "Server",
    path: "fleet",
    component: FleetPage,
    // Gone from the SDK types in 0.6.75; older bbs still draw it.
    ...({ experimental_sidebarAccessory: RunningCount } as object),
  });
});

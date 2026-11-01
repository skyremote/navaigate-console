// The machine row (one tile per machine in the profile) and what the rail shows for a Mac whose bb
// is not this one: its NOW card, its chats by project and a "New chat" that
// starts work there. The data is the Fleet plugin's board (see
// server-fleet.ts); this file only draws it. A remote chat opens in this
// window as Fleet's hidden local copy.
import { useFeature } from "./use-feature";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useBbContext, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { isStuck, quietFor } from "./running";
import { machineMetric, systemView, type Chip, type RemoteThread } from "./machines";
import { LIVE, Lattice, NowHeadline, ago, caps, harnessOf, tnum } from "./shared";
import { Spinner } from "./rail-look";
import { Meter } from "./home-kit";
import { LogoOrb } from "./orb";
import { NativeWorkComposer, type NativeWorkPlacement } from "./native-work-composer";
import { PrBadge } from "./rail-extras";
import { Menu, MenuItem } from "./menu";
import { RelayDialog, type RelayMode } from "./remote-relay";
import type { AttentionPr } from "../server-attention";
import { useProfile } from "./use-profile";
import { machineById } from "../profile/schema";
import { machineName } from "./words";

const INSET = 6;
/** Blue while memory pressure is normal (live), ember when it rises, red when it is critical. */
const PRESSURE_COLOUR = { normal: LIVE, warn: "var(--warning-text)", critical: "var(--destructive-text)" } as const;
export { useFleetBoard, type FleetBoardView } from "./fleet-board";

/**
 * Open a chat that runs on another Mac: go to Fleet's local copy of it (made
 * on the first open and reused after). A late response must not take the user
 * away from another chat opened while the request was outstanding.
 */
export function useOpenRemote(): (t: RemoteThread) => void {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const { threadId } = useBbContext();
  const currentRoute = useRef(threadId);
  currentRoute.current = threadId;
  const generation = useRef(0);
  const pending = useRef<{ route: typeof threadId; toastId: string | number } | null>(null);
  const cancelPending = useCallback(() => {
    generation.current++;
    if (pending.current) toast.dismiss(pending.current.toastId);
    pending.current = null;
  }, []);
  useEffect(() => {
    if (pending.current && pending.current.route !== threadId) cancelPending();
  }, [threadId, cancelPending]);
  useEffect(() => {
    // Clicking the already-open chat does not change its route ID. Typing is
    // also an explicit choice to stay; neither may be stolen by a late open.
    const navigate = (event: MouseEvent) => {
      if (pending.current && event.target instanceof Element && event.target.closest('a[href], [role="tab"]')) cancelPending();
    };
    const edit = () => { if (pending.current) cancelPending(); };
    document.addEventListener("click", navigate, true);
    document.addEventListener("input", edit, true);
    return () => { document.removeEventListener("click", navigate, true); document.removeEventListener("input", edit, true); cancelPending(); };
  }, [cancelPending]);
  return useCallback((t: RemoteThread) => {
    const request = ++generation.current;
    const route = currentRoute.current;
    if (pending.current) toast.dismiss(pending.current.toastId);
    const waiting = toast.loading(`Opening the ${machineName(t.machine)} chat…`);
    pending.current = { route, toastId: waiting };
    const current = () => generation.current === request && currentRoute.current === route;
    rpc.call("fleet_mirror_open", { machine: t.machine, threadId: t.id }).then(
      (r) => {
        toast.dismiss(waiting);
        if (!current()) return;
        pending.current = null;
        nav.toThread(r.localThreadId);
      },
      (cause: unknown) => {
        toast.dismiss(waiting);
        if (!current()) return;
        pending.current = null;
        toast.error(`Could not open the ${machineName(t.machine)} chat`, { description: cause instanceof Error ? cause.message : String(cause), ...(t.url ? { action: { label: `Open on ${machineName(t.machine)}`, onClick: () => nav.openUrl(t.url!) } } : {}) });
      },
    );
  }, [rpc, nav]);
}

export function MachineRow({ chips, value, onChange, now, stale = false }: { chips: Chip[]; value: string; onChange: (key: string) => void; now: number; stale?: boolean }) {
  const profile = useProfile();
  const [tick, setTick] = useState(now);
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const clock = Math.max(now, tick);
  return (
    <div data-nav-part="machines" className="mx-1 mb-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(3, chips.length))}, minmax(0, 1fr))` }} role="group" aria-label="Machines">
      {chips.map((c) => {
        const on = c.key === value;
        const metric = machineMetric(c, clock);
        const behind = stale && !metric.stale;
        const age = behind ? `stale · ${metric.age}` : metric.age;
        const sub = `${metric.line} · ${age}`;
        const stuckNote = c.stuck ? `, ${c.stuck} stuck? (quiet ${quietFor(c.stuckAt ?? clock, clock)})` : "";
        const system = systemView(c.key, c.system, profile);
        const tile = (
          <button
            key={c.key}
            type="button"
            aria-pressed={on}
            data-nav-part="machine-tile"
            onClick={() => onChange(c.key)}
            title={c.ownerStatus ? `${machineName(c.key)}: independent owner ${c.ownerStatus}; enrolled host ${c.enrolledOnline ? "connected" : "not connected"}. ${sub}. ${c.cooking} running${stuckNote}` : c.online ? `${machineName(c.key)}${c.sub ? ` ${c.sub}` : ""}: ${c.cooking} running${stuckNote}` : `${machineName(c.key)} is offline (${sub})`}
            className={cn(
              "min-w-0 rounded-lg border px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
              on ? "text-foreground" : "border-border text-foreground hover:bg-[var(--state-hover)]",
            )}
            style={on ? { borderColor: "var(--surface-selected-border)", background: "var(--surface-selected)" } : undefined}
          >
            <span className="flex min-w-0 items-center justify-between gap-1">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                <span aria-hidden data-nav-part="status-dot" data-online={c.online ? "true" : "false"} className="size-2 shrink-0 rounded-full" style={{ background: c.online ? "var(--success)" : "var(--muted-foreground)" }} />
                {machineName(c.key)}
              </span>
              <span
                aria-label={`${c.cooking} running`}
                data-nav-part="count"
                className={cn("shrink-0 font-mono text-[11px] leading-none", c.cooking ? "text-foreground" : "text-muted-foreground")}
                style={tnum}
              >
                {c.cooking}
              </span>
            </span>
            <span data-nav-part="metric" className="mt-0.5 block truncate text-[11px] text-muted-foreground">{metric.line}</span>
            <span data-nav-part="metric" data-nav-role="age" data-stale={metric.stale || behind ? "true" : "false"} className={cn("block truncate text-[11px]", metric.stale || behind ? "text-destructive-text" : "text-muted-foreground")}>{age}</span>
            {c.stuck ? <span data-nav-part="stuck" className="block truncate text-[11px] text-muted-foreground">{c.stuck} stuck? · quiet {quietFor(c.stuckAt ?? clock, clock)}</span> : null}
          </button>
        );
        if (!system) return tile;
        return (
          <HoverCard key={c.key} openDelay={250} closeDelay={100}>
            <HoverCardTrigger asChild>{tile}</HoverCardTrigger>
            <HoverCardContent side="bottom" align="start" data-nav-part="system-card" className="w-60 p-3">
              <div className="mb-2 text-[12px] font-medium">{machineName(c.key)} now</div>
              <div className="space-y-2.5 text-[12px]">
                {system.cpu && (
                  <div data-nav-part="system-cpu">
                    <div className="mb-1 flex items-baseline justify-between gap-2"><span className="text-muted-foreground">CPU{system.cpu.cores ? ` · ${system.cpu.cores}` : ""}</span><span style={tnum}>{system.cpu.text}</span></div>
                    <Meter value={system.cpu.fraction} color={LIVE} label={`${machineName(c.key)} CPU`} />
                  </div>
                )}
                {system.ram && (
                  <div data-nav-part="system-ram">
                    <div className="mb-1 flex items-baseline justify-between gap-2"><span className="text-muted-foreground">Memory</span><span style={tnum}>{system.ram.text}</span></div>
                    <Meter value={system.ram.fraction} color={PRESSURE_COLOUR[system.ram.pressure ?? "normal"]} label={`${machineName(c.key)} memory in use`} />
                    {system.ram.pressureText && <div data-nav-part="system-pressure" data-pressure={system.ram.pressure} className="mt-1 text-[11px]" style={{ color: PRESSURE_COLOUR[system.ram.pressure ?? "normal"] }}>{system.ram.pressureText}</div>}
                  </div>
                )}
                {(system.swap || system.load || system.disk) && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    {system.swap && <><dt className="text-muted-foreground">Swap</dt><dd className="text-right" style={tnum}>{system.swap}</dd></>}
                    {system.load && <><dt className="text-muted-foreground">Load</dt><dd className="text-right" style={tnum}>{system.load}</dd></>}
                    {system.disk && <><dt className="text-muted-foreground">Disk</dt><dd className="text-right" style={tnum}>{system.disk}</dd></>}
                  </dl>
                )}
                {system.keepAwake && <div data-nav-part="system-awake" className="text-[11px] text-muted-foreground">{system.keepAwake}</div>}
              </div>
            </HoverCardContent>
          </HoverCard>
        );
      })}
    </div>
  );
}

/** The NOW card for another Mac: what is running there, from Fleet. */
export function RemoteNowCard({ machine, running, stuck, needs, onOpen }: { machine: string; running: RemoteThread[]; stuck?: { stuck: number; stuckAt: number | null }; needs: number; onOpen: (t: RemoteThread) => void }) {
  const nav = useBbNavigate();
  const lead = running[0];
  return (
    <div data-nav-part="now-card" className="mx-1 mb-5 mt-1 rounded-xl border border-border bg-card px-4 pb-0 pt-3 shadow-sm">
      <div className="flex gap-3">
        <div className="pb-3 pt-0.5">
          <LogoOrb size={58} mood={running.length > 0 ? "busy" : "idle"} onClick={() => nav.toPluginPanel("home")} title="NavAIgate Home" />
        </div>
        <div className="min-w-0 flex-1">
          <div data-nav-part="now-head" className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className={cn(caps, "flex min-w-0 items-center gap-2 whitespace-nowrap text-foreground")}>
              {running.length > 0 ? <Lattice cell={3} gap={1.5} /> : <span aria-hidden className="inline-block size-[6px] bg-muted-foreground" />}
              <NowHeadline prefix={machineName(machine)} count={running.length} word={running.length > 0 ? "cooking" : "quiet"} />
            </span>
            {needs > 0 ? <span data-nav-part="now-needs" className="shrink-0 whitespace-nowrap text-[11px] font-medium text-destructive-text" style={tnum}>{needs} need you</span> : null}
          </div>
          {lead ? (
            <button type="button" onClick={() => onOpen(lead)} className="mt-1 block w-full truncate text-left text-[14px] font-medium leading-6 text-foreground hover:underline">
              {lead.title}
            </button>
          ) : (
            <p className="mt-1 text-[14px] font-medium leading-6 text-foreground">Nothing running</p>
          )}
          <p data-nav-part="now-sub" className="mt-0.5 truncate pb-3 text-[12px] text-muted-foreground">
            {(lead ? (running.length > 1 ? `${harnessOf(lead.providerId ?? "").label} · and ${running.length - 1} more` : harnessOf(lead.providerId ?? "").label) : "Every harness is parked") + (stuck && stuck.stuck > 0 ? ` · ${stuck.stuck} stuck? (quiet ${quietFor(stuck.stuckAt ?? Date.now(), Date.now())})` : "")}
          </p>
        </div>
      </div>
      <div aria-hidden data-nav-part="now-line" className="-mx-4 h-[2px] overflow-hidden rounded-b-xl bg-border">
        {running.length > 0 ? <div data-nav-part="now-glow" className="h-full w-2/5 animate-pulse" style={{ background: LIVE }} /> : null}
      </div>
    </div>
  );
}

/** "New chat" for another Mac: a prompt box that hands the work to that Mac's own bb through Fleet. */
export function RemoteNewChat({ machine, onStarted, trigger }: { machine: string; onStarted: () => void; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const scope = usePortalScopeProps();
  useEffect(() => setOpen(false), [machine]);
  const target: NativeWorkPlacement = machineById(useProfile(), machine) ? machine : "Auto";
  return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger asChild>{trigger ?? <button type="button" title={`Start native work on ${machineName(machine)} or let Auto choose`} className="group/new relative isolate mb-3 flex h-8 w-full items-center gap-2.5 rounded-md pr-2 text-left text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring" style={{ paddingLeft: 10 + INSET - 1 }}><Icon name="Plus" className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">New work</span><span className="shrink-0 text-[11px]">{machineName(machine)} or Auto</span></button>}</Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" /><Dialog.Content {...scope} className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[min(600px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-xl"><div className="flex shrink-0 items-start justify-between gap-3 border-b border-border p-4"><div><Dialog.Title className="text-sm font-medium">New work</Dialog.Title><Dialog.Description className="mt-1 text-xs text-muted-foreground">Choose a model and where its native session runs</Dialog.Description></div><Dialog.Close className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">Close</Dialog.Close></div><div className="min-h-0 overflow-y-auto p-4"><NativeWorkComposer key={machine} initialMachine={target} draftKey={`native-fleet-work:${machine}`} onStarted={() => onStarted()} /></div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

/** Another Mac's chats, by project, drawn like the rail's own rows. */
export function RemoteList({ sections, now, title, onOpen, openable, prs }: {
  sections: Array<{ name: string; threads: RemoteThread[] }>;
  now: number;
  title?: string;
  onOpen: (t: RemoteThread) => void;
  /** Whether a row can be opened at all; by default, when Fleet gave it a link. */
  openable?: (t: RemoteThread) => boolean;
  /** Pull requests the owning Mac reports, keyed "<machine>:<owner thread id>". */
  prs?: ReadonlyMap<string, AttentionPr>;
}) {
  return (
    <div>
      {title ? <p data-nav-part="section-label" className={cn(caps, "mx-1 mb-1 mt-4")}>{title}</p> : null}
      {sections.map((s) => (
        <div key={s.name} className="mb-2">
          <div className="mx-1 mb-1 mt-3 flex items-center justify-between gap-2 text-[13px] font-medium text-foreground">
            <span className="min-w-0 truncate">{s.name}</span>
            <span data-nav-part="count" className="shrink-0 text-[12px] font-normal text-muted-foreground" style={tnum}>{s.threads.length}</span>
          </div>
          {s.threads.map((t) => <RemoteRow key={`${t.via}:${t.id}`} thread={t} now={now} onOpen={onOpen} canOpen={openable ? openable(t) : t.url !== null} pr={prs?.get(`${t.machine}:${t.id}`)} />)}
        </div>
      ))}
    </div>
  );
}

function RemoteRow({ thread, now, onOpen, canOpen, pr }: { thread: RemoteThread; now: number; onOpen: (t: RemoteThread) => void; canOpen: boolean; pr?: AttentionPr }) {
  const [relay, setRelay] = useState<RelayMode | null>(null);
  const relayOn = useFeature("F06");
  const lastMode = useRef<RelayMode>("tell");
  if (relay) lastMode.current = relay;
  // Reported running but quiet for over two hours: shown as "stuck?" with its age, not as live work.
  const stuck = thread.state === "running" && isStuck(thread.updatedAt, now);
  const running = thread.state === "running" && !stuck;
  const flag = thread.state === "needs-you" ? "needs you" : thread.state === "error" ? "error" : thread.state === "queued" ? "queued" : stuck ? `stuck? quiet ${quietFor(thread.updatedAt, now)}` : null;
  const second = [harnessOf(thread.providerId ?? "").label, flag].filter(Boolean).join(" · ");
  return (
    <>
      <Menu
        trigger={
          <div className="group/row relative isolate">
            <button
              type="button"
              disabled={!canOpen}
              onClick={() => onOpen(thread)}
              title={canOpen ? thread.title : "No link yet"}
              className="flex h-12 w-full items-start gap-2.5 rounded-md pr-2 pt-1.5 text-left text-[14px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
              style={{ paddingLeft: 10 + INSET }}
            >
              <span aria-hidden className="nav-fade pointer-events-none absolute inset-0 -z-10 rounded-md bg-[var(--state-hover)] opacity-0 group-hover/row:opacity-100" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex h-5 min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate leading-[18px]">{thread.title}</span>
                  <span className="relative inline-flex h-5 w-6 shrink-0 items-center justify-end text-[11px] font-normal text-muted-foreground" style={tnum}>
                    <span className="nav-fade inline-flex group-hover/row:opacity-0 group-focus-within/row:opacity-0">{running ? <Spinner size={12} /> : ago(thread.updatedAt, now)}</span>
                  </span>
                </span>
                <span className={cn("mt-1 flex h-4 min-w-0 items-center gap-1.5 text-[12px] font-normal leading-4", flag === "needs you" || flag === "error" ? "text-destructive-text" : "text-muted-foreground")}>
                  <span className="min-w-0 flex-1 truncate">{second}</span>
                  {pr ? <PrBadge pr={pr} machine={thread.machine} /> : null}
                </span>
              </span>
            </button>
            {relayOn ? <button
              type="button"
              data-nav-part="remote-relay"
              aria-label={`Ask or tell ${machineName(thread.machine)} about ${thread.title}`}
              title={`Ask or tell ${machineName(thread.machine)}`}
              onClick={() => setRelay(lastMode.current)}
              className="nav-fade absolute right-1.5 top-1.5 inline-flex size-[18px] items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100"
            >
              <Icon name="MessageCirclePlus" className="size-3.5" />
            </button> : null}
          </div>
        }
      >
        <MenuItem icon="ArrowUpRight" label="Open" disabled={!canOpen} onSelect={() => onOpen(thread)} />
        {relayOn ? <MenuItem icon="MessageCirclePlus" label="Tell this chat…" onSelect={() => setRelay("tell")} /> : null}
        {relayOn ? <MenuItem icon="Plus" label={`Ask ${machineName(thread.machine)}…`} onSelect={() => setRelay("ask")} /> : null}
      </Menu>
      <RelayDialog thread={thread} mode={lastMode.current} onMode={(mode) => { lastMode.current = mode; setRelay(mode); }} open={relay !== null} onOpenChange={(open) => { if (!open) setRelay(null); }} />
    </>
  );
}

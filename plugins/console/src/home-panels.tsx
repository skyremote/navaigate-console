// Home panels: the parts of Home that read live data and appear on both the
// Home page and the control room. Thread states come from bb's sidebar, the
// machines from Fleet's board, allowance from home_accounts and the window
// charts from usage_trend. Where a source has nothing yet, the card says so.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { HomeAccount } from "../server-home";
import type { Trend, UsageMachineRow } from "../server-usage-trend";
import { allowancesOf, longOf, machineRank, readState, sameAccountHints, sessionOf, sortMachines, usageTotals, type Allowance, type SameAccountHint } from "./usage-machines";
import { chipsFor, machineMetric, type Chip } from "./machines";
import { quietFor, splitLabel, type RunningView } from "./running";
import { useRunning } from "./use-running";
import { RemoteNewChat } from "./machine-row";
import { useFleetBoard } from "./fleet-board";
import { LIVE, Lattice, Node, ago, caps, display, harnessOf, stateOf, tnum, type Harness, type State } from "./shared";
import { AreaLine, Card, CountUp, Heading, Meter, Segmented, TrackBars, cardCls, cellDelay, ensureHomeKitStyle, tileCls } from "./home-kit";
import { useProfile } from "./use-profile";
import { useFeature } from "./use-feature";
import { homeMachineId } from "../lib/profile-text";
import { machineName } from "./words";

/* ----------------------------- thread model ----------------------------- */

export type ThreadModel = {
  live: PluginSidebarThread[];
  tally: Record<State, number>;
  rows: Array<{ h: Harness; s: Record<State, number>; total: number }>;
  needs: PluginSidebarThread[];
  recent: PluginSidebarThread[];
  max: number;
};

export function threadModel(threads: readonly PluginSidebarThread[]): ThreadModel {
  const live = threads.filter((t) => !t.isHidden && !t.isArchived);
  const tally = { running: 0, needs: 0, unread: 0, parked: 0 } as Record<State, number>;
  const perHarness = new Map<string, { h: Harness; s: Record<State, number>; total: number }>();
  for (const t of live) {
    const s = stateOf(t);
    tally[s] += 1;
    const h = harnessOf(t.providerId);
    const row = perHarness.get(h.key) ?? { h, s: { running: 0, needs: 0, unread: 0, parked: 0 }, total: 0 };
    row.s[s] += 1;
    row.total += 1;
    perHarness.set(h.key, row);
  }
  const rows = [...perHarness.values()].sort((a, b) => b.total - a.total);
  const needs = live.filter((t) => stateOf(t) === "needs").sort((a, b) => b.updatedAt - a.updatedAt);
  const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt);
  return { live, tally, rows, needs, recent, max: Math.max(1, ...rows.map((r) => r.total)) };
}

/* ------------------------------ stat tiles ------------------------------ */

const STATS: Array<{ key: State; label: string; note: string }> = [
  { key: "running", label: "Running", note: "working right now" },
  { key: "needs", label: "Needs you", note: "errors, questions, approvals" },
  { key: "unread", label: "Unread", note: "finished, not yet read" },
  { key: "parked", label: "Parked", note: "context intact" },
];

/** Chats that report running but have been quiet for over two hours: listed with their age, never counted. */
export function StuckLine({ view, now = Date.now() }: { view: RunningView; now?: number }) {
  const worst = view.stuck[0]!;
  const age = quietFor(worst.updatedAt, now);
  return (
    <div data-nav-part="stuck" title={view.stuck.map((i) => `${machineName(i.machine)}: ${i.title} (${quietFor(i.updatedAt, now)} quiet)`).join("\n")} className="mt-0.5 truncate text-[12px] text-muted-foreground">
      {view.stuck.length} stuck? · quiet {age}
    </div>
  );
}

export function StatTiles({ tally, start = 0, running }: { tally: Record<State, number>; start?: number; running?: { view: RunningView; machines: readonly string[] } }) {
  ensureHomeKitStyle();
  return (
    <div data-nav-part="stat-tiles" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {STATS.map((s, i) => {
        const n = s.key === "running" && running ? running.view.running.length : tally[s.key];
        const split = s.key === "running" && running && running.machines.length > 1 ? splitLabel(running.view, running.machines) : null;
        const color = s.key === "running" && n > 0 ? LIVE : s.key === "needs" && n > 0 ? "var(--destructive-text)" : undefined;
        return (
          <div key={s.key} data-nav-part="stat" data-state={s.key} className={cn(cardCls, "nav-hk-rise min-w-0 px-4 pb-3.5 pt-3.5")} style={{ ["--nav-hk-i" as string]: start + i }}>
            <div className="flex items-center gap-2.5">
              <span aria-hidden className={cn(tileCls, "inline-flex size-7 shrink-0 items-center justify-center")}>
                {s.key === "running" && n > 0 ? <Lattice cell={3} gap={1.5} /> : <Node state={s.key} size={7} />}
              </span>
              <span className={caps}>{s.label}</span>
            </div>
            <div className="mt-3 text-[32px] font-medium leading-none tracking-[-0.02em] text-foreground" style={{ ...display, ...tnum, color }}>
              <CountUp value={n} />
            </div>
            <div data-nav-part="stat-note" className="mt-1.5 truncate text-[12px] text-muted-foreground">{split && n > 0 ? split : s.note}</div>
            {s.key === "running" && running && running.view.stuck.length > 0 ? <StuckLine view={running.view} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------- machines ------------------------------- */

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

function gb(bytes: number): string {
  const v = bytes / 1024 ** 3;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

function MachineLoad({ c, now, compact }: { c: Chip; now: number; compact: boolean }) {
  const r = c.resources;
  const metric = machineMetric(c, now);
  if (!r) {
    return <div data-nav-part="metric" className="mt-2 text-[12px] text-muted-foreground">{c.online ? "No load reading yet" : metric.age}</div>;
  }
  const used = r.totalMemoryBytes - r.availableMemoryBytes;
  const cpu = r.cpuUtilization;
  return (
    <div className={cn("mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1", metric.stale ? "text-muted-foreground" : null)}>
      <div className="min-w-0">
        <Meter value={cpu} label={`${machineName(c.key)} CPU`} />
        <div className="mt-1 truncate text-[11px] text-muted-foreground" style={tnum}>{cpu === null ? "CPU n/a" : `${Math.round(cpu * 100)}% CPU${compact ? "" : ` · ${r.cpuCount} cores`}`}</div>
      </div>
      <div className="min-w-0">
        <Meter value={r.totalMemoryBytes ? used / r.totalMemoryBytes : null} label={`${machineName(c.key)} memory in use`} />
        <div className="mt-1 truncate text-[11px] text-muted-foreground" style={tnum}>{`${gb(used)} of ${gb(r.totalMemoryBytes)} GB`}</div>
      </div>
      <div data-nav-part="metric" data-nav-role="age" data-stale={metric.stale ? "true" : "false"} className="col-span-2 truncate text-[11px]" style={{ ...tnum, color: metric.stale ? "var(--destructive-text)" : "var(--muted-foreground)" }}>{metric.age}</div>
    </div>
  );
}

/** Every machine with what runs on each and their load now. Pick one to start work there. */
/** The machines card. While the machine dashboard (F19) is unticked it is only a New work entry for this Mac: no load, no other Macs. */
export function MachinesCard(props: { threads: readonly PluginSidebarThread[]; i?: number; compact?: boolean }) {
  return useFeature("F19") ? <MachinesCardBody {...props} /> : <ThisMacNewWork i={props.i} />;
}

function ThisMacNewWork({ i = 0 }: { i?: number }) {
  const machine = homeMachineId(useProfile());
  return (
    <Card
      i={i}
      part="new-work-card"
      label={<Heading label="New work" />}
      aside={
        <RemoteNewChat
          machine={machine}
          onStarted={() => {}}
          trigger={<button type="button" data-nav-part="machine-new-work" title={`Start native work on ${machineName(machine)} or let Auto choose`} className="nav-hk-hover inline-flex min-h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">New work on {machineName(machine)}</button>}
        />
      }
    >
      <p className="py-1 text-[13px] text-muted-foreground">Start a chat on {machineName(machine)} and pick its model.</p>
    </Card>
  );
}

function MachinesCardBody({ threads, i = 0, compact = false }: { threads: readonly PluginSidebarThread[]; i?: number; compact?: boolean }) {
  const fleet = useFleetBoard();
  const now = useNow(5_000);
  const { view, board } = useRunning(threads);
  const profile = useProfile();
  const serverKey = board?.serverKey ?? homeMachineId(profile);
  const chips = useMemo(() => (board ? chipsFor(board, view.byMachine, profile) : []), [board, view, profile]);
  const [picked, setPicked] = useState<string | null>(null);
  const machine = chips.some((c) => c.key === picked) ? picked! : (chips[0]?.key ?? serverKey);
  const running = view.running.length;
  const online = chips.filter((c) => c.online).length;

  const body: ReactNode = !fleet ? (
    <p className="py-4 text-[13px] text-muted-foreground">Reading the fleet</p>
  ) : !board ? (
    <p className="py-4 text-[13px] text-muted-foreground">The Fleet plugin is not answering{fleet.error ? `: ${fleet.error}` : ""}</p>
  ) : (
    <div role="group" aria-label="Machine for new work" data-tour="console-fleet" className={cn("grid gap-2", compact ? "sm:grid-cols-3" : null)}>
      {chips.map((c) => {
        const on = c.key === machine;
        return (
          <div
            key={c.key}
            data-nav-part="machine-tile"
            className={cn("nav-hk-tile nav-hk-hover relative min-w-0 rounded-[10px] border px-3 py-2.5", on ? "border-foreground/70 bg-[var(--surface-selected)]" : "border-transparent bg-muted hover:border-border")}
          >
            <button type="button" aria-pressed={on} onClick={() => setPicked(c.key)} className="flex w-full min-w-0 items-center justify-between gap-2 text-left outline-none">
              <span className="inline-flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
                <span aria-hidden data-nav-part="status-dot" data-online={c.online ? "true" : "false"} className="size-2 shrink-0 rounded-full" style={{ background: c.online ? "var(--success)" : "var(--muted-foreground)" }} />
                {machineName(c.key)}
                {c.sub ? <span className="truncate font-normal text-muted-foreground">{c.sub}</span> : null}
              </span>
              <span data-nav-part="count" className="inline-flex shrink-0 items-center gap-1.5 text-[12px]" style={{ ...tnum, color: c.cooking ? LIVE : "var(--muted-foreground)" }}>
                {c.cooking ? <Lattice cell={2.5} gap={1.2} /> : null}
                {c.cooking ? `${c.cooking} running` : c.online ? "idle" : "offline"}
              </span>
            </button>
            <MachineLoad c={c} now={now} compact={compact} />
            {c.stuck ? <div data-nav-part="stuck" className="mt-1 truncate text-[11px] text-muted-foreground" style={tnum}>{c.stuck} stuck? · quiet {quietFor(c.stuckAt ?? now, now)}</div> : null}
          </div>
        );
      })}
    </div>
  );

  return (
    <Card
      i={i}
      part="machines-card"
      label={<Heading label="Machines" figure={board ? <><CountUp value={online} /><span className="text-muted-foreground">/{chips.length}</span></> : undefined} note={board ? `online · ${running} running` : undefined} />}
      aside={board ? (
        <RemoteNewChat
          machine={machine}
          onStarted={() => {}}
          trigger={<button type="button" data-nav-part="machine-new-work" title={`Start native work on ${machineName(machine)} or let Auto choose`} className="nav-hk-hover inline-flex min-h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">New work on {machineName(machine)}</button>}
        />
      ) : null}
    >
      {body}
    </Card>
  );
}

/* ------------------------------- allowance ------------------------------ */

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n)}%`);
function resets(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const h = Math.round(ms / 3_600_000);
  return h < 48 ? `resets in ${h}h` : `resets in ${Math.round(h / 24)} days`;
}
const HIGH_USE = 85;
const whoOf = (a: HomeAccount) => (a.email ? a.email.split("@")[0].slice(0, 14) : "");
const flagOf = (a: HomeAccount) => ((a.week ?? 0) >= HIGH_USE ? "high use" : a.advice ? "plan advice" : null);
const dayTick = (day: string) => String(Number(day.slice(8, 10)));
const dayLong = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** One account's allowance: this week's (or month's) figure and its last 14 daily peaks. */
export function AllowanceCard({ accounts, value, onChange, workingBy, i = 0, icon }: {
  accounts: HomeAccount[] | null;
  value: string | null;
  onChange: (id: string) => void;
  workingBy: Set<string>;
  i?: number;
  icon: (harness: HomeAccount["harness"]) => ReactNode;
}) {
  const [active, setActive] = useState<number | null>(null);
  const a = accounts?.find((x) => x.id === value) ?? accounts?.[0] ?? null;
  useEffect(() => setActive(null), [a?.id]);
  const who = a ? whoOf(a) : "";
  const advised = (accounts ?? []).filter((x) => x.advice);
  const hovered = a && active !== null ? a.history[active] : null;
  const working = a ? workingBy.has(a.harness) : false;
  return (
    <Card
      i={i}
      part="allowance-card"
      label={
        <Heading
          label={a ? `${a.plan ?? a.label}${who ? ` · ${who}` : ""}` : "Allowance"}
          figure={a ? (a.week === null ? "–" : <CountUp value={Math.round(a.week)} format={(n) => `${n}%`} />) : undefined}
          note={hovered ? `${dayLong(hovered.day)} · peak ${Math.round(hovered.peak)}%` : a ? `${a.cycleLabel.toLowerCase()}${a.session !== null ? ` · session ${pct(a.session)}` : ""}` : undefined}
        />
      }
      aside={accounts && accounts.length > 1 ? (
        <Segmented
          label="Account"
          value={a?.id ?? ""}
          onChange={onChange}
          options={accounts.map((x) => {
            const flag = flagOf(x);
            return {
              value: x.id,
              title: `${x.label}${x.email ? ` · ${x.email}` : ""}${flag ? ` · ${flag}` : ""}`,
              label: <>{icon(x.harness)}{x.label}{whoOf(x) ? <span className="font-normal text-muted-foreground">{whoOf(x)}</span> : null}{flag ? <><span aria-hidden data-nav-part="account-flag" className="size-1.5 shrink-0 rounded-full" style={{ background: "var(--destructive-text)" }} /><span className="sr-only">{flag}</span></> : null}</>,
            };
          })}
        />
      ) : null}
    >
      {!accounts ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">Reading your subscriptions</p>
      ) : !a ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">No subscriptions found</p>
      ) : a.status === "error" ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">Could not read usage for this account</p>
      ) : a.history.length === 0 ? (
        <div className={cn(tileCls, "px-4 py-8 text-center text-[13px] text-muted-foreground")}>No daily peaks yet. One bar appears for each day the plugin sees this account.</div>
      ) : (
        <TrackBars
          label={`Daily peak use for the last ${a.history.length} days`}
          bars={a.history.map((h) => ({ key: h.day, value: h.peak, tick: dayTick(h.day), title: `${dayLong(h.day)}: peak ${Math.round(h.peak)}%`, color: h.peak >= HIGH_USE ? "var(--destructive-text)" : undefined }))}
          active={active}
          onActive={setActive}
        />
      )}
      {a ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-border pt-2.5 text-[12px] text-muted-foreground" style={tnum}>
          <span>{working ? <span style={{ color: LIVE }}>Working now · </span> : null}Daily peak, last {a.history.length || 14} days</span>
          <span>{resets(a.weekResetsAt)}</span>
        </div>
      ) : null}
      {advised.length ? (
        <ul data-nav-part="plan-advice" className="grid gap-1 text-[12px] text-foreground">
          {advised.map((x) => (
            <li key={x.id} className="flex flex-wrap gap-x-2">
              {accounts && accounts.length > 1 ? <span className="font-medium text-foreground">{x.label}{whoOf(x) ? ` · ${whoOf(x)}` : ""}</span> : null}
              <span>{x.advice}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/* ------------------------------ usage window ----------------------------- */

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayClock = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });

/** The selected account's current window from usage_trend, drawn since it opened. */
export function WindowCard({ trend, account, i = 0 }: { trend: Trend | null; account: HomeAccount | null; i?: number }) {
  const [span, setSpan] = useState<"session" | "long">("session");
  const t = trend?.accounts.find((x) => account && x.harness === account.harness && (!account.email || !x.email || x.email === account.email)) ?? null;
  const windows = t?.windows ?? [];
  const w = windows.find((x) => x.span === span) ?? windows[0] ?? null;
  const hasSession = windows.some((x) => x.span === "session");
  const hasLong = windows.some((x) => x.span === "long");
  const fmt = w?.span === "session" ? clock : dayClock;
  const domain: [number, number] | null = w && w.startsAt !== null && w.resetsAt !== null ? [w.startsAt, w.resetsAt] : null;
  return (
    <Card
      i={i}
      part="window-card"
      label={
        <Heading
          label={w ? `${w.label} window${w.model ? ` · ${w.model}` : ""}` : "Usage window"}
          figure={w ? <CountUp value={Math.round(w.pct)} format={(n) => `${n}%`} /> : undefined}
          note={w ? (w.idle ? "no session running" : w.forecastAtReset !== null ? `on course for ${Math.round(w.forecastAtReset)}% at reset` : w.burn !== null ? `${w.burn.toFixed(1)}% an hour` : undefined) : undefined}
        />
      }
      aside={hasSession && hasLong ? (
        <Segmented label="Window" value={span} onChange={setSpan} options={[{ value: "session", label: "Session" }, { value: "long", label: account?.harness === "cursor" ? "Month" : "Week" }]} />
      ) : null}
    >
      {!trend ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">Reading usage samples</p>
      ) : !t || !w ? (
        <div className={cn(tileCls, "px-4 py-8 text-center text-[13px] text-muted-foreground")}>No samples for {account ? account.label : "this account"} yet. The plugin samples each account every few minutes.</div>
      ) : !domain || w.series.length < 2 ? (
        <div className={cn(tileCls, "px-4 py-8 text-center text-[13px] text-muted-foreground")}>Not enough samples in this window yet</div>
      ) : (
        <AreaLine key={`${t.id}:${w.id}`} label={`${w.label} use since ${fmt(domain[0])}, ${Math.round(w.pct)}% now`} series={w.series} domain={domain} marks={[75, 90]} />
      )}
      {w && domain ? (
        <div className="flex justify-between border-t border-border pt-2.5 text-[12px] text-muted-foreground" style={tnum}>
          <span>Opened {fmt(domain[0])}</span>
          <span>Dashes at 75% and 90%</span>
          <span>Resets {fmt(domain[1])}</span>
        </div>
      ) : null}
    </Card>
  );
}

/* --------------------------------- recent -------------------------------- */

export function RecentCard({ model, projects, i = 0 }: { model: ThreadModel; projects: ReadonlyArray<{ id: string; name: string }>; i?: number }) {
  const now = useNow(30_000);
  const [scope, setScope] = useState<"all" | "needs">("all");
  const list = (scope === "needs" ? model.needs : model.recent).slice(0, 7);
  const name = (id: string | null | undefined) => projects.find((p) => p.id === id)?.name ?? null;
  return (
    <Card
      i={i}
      part="recent-card"
      label={<Heading label="Recent chats" />}
      aside={<Segmented size="sm" label="Show" value={scope} onChange={setScope} options={[{ value: "all", label: "All" }, { value: "needs", label: <>Needs you <span style={tnum} className="text-muted-foreground">{model.needs.length}</span></> }]} />}
    >
      {list.length === 0 ? (
        <p className="py-6 text-[13px] text-muted-foreground">{scope === "needs" ? "Nothing is waiting on you" : "No chats yet"}</p>
      ) : (
        <ul key={scope} className="-mx-2 -mt-1">
          {list.map((t, n) => {
            const s = stateOf(t);
            const second = [harnessOf(t.providerId).label, name(t.projectId)].filter(Boolean).join(" · ");
            return (
              <li key={t.id} className="nav-hk-row" style={{ animationDelay: `${n * 30}ms` }}>
                <a href={t.href} className="nav-hk-hover flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5 text-foreground no-underline hover:bg-[var(--state-hover)]">
                  <Node state={s} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-5">{t.displayTitle}</span>
                    <span className="block truncate text-[12px] leading-4" style={{ color: s === "needs" ? "var(--destructive-text)" : "var(--muted-foreground)" }}>{s === "needs" ? `Needs you · ${second}` : second}</span>
                  </span>
                  <span className="shrink-0 text-[12px]" style={{ ...tnum, color: s === "running" ? LIVE : "var(--muted-foreground)" }}>{s === "running" ? "running" : ago(t.updatedAt, now)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* -------------------------------- activity ------------------------------- */

const WEEKS = 18;
const DAY = 86_400_000;
const midnight = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

/** Chats started per day over the last 18 weeks, from the chats bb's sidebar still lists. Days are local calendar dates, so a clock change does not shift a chat to another day. */
export function ActivityCard({ threads, i = 0 }: { threads: readonly PluginSidebarThread[]; i?: number }) {
  const grid = useMemo(() => {
    const now = new Date();
    const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
    const dow = (now.getDay() + 6) % 7;
    const first = d - (WEEKS - 1) * 7 - dow;
    const start = midnight(y, m, first);
    const dayOf = (at: number) => {
      const t = new Date(at);
      return Math.round((midnight(t.getFullYear(), t.getMonth(), t.getDate()) - start) / DAY);
    };
    const todayIdx = dayOf(now.getTime());
    const counts = new Array<number>(WEEKS * 7).fill(0);
    let week = 0;
    for (const t of threads) {
      const idx = dayOf(t.createdAt);
      if (idx < 0 || idx > todayIdx) continue;
      counts[idx]++;
      if (idx > todayIdx - 7) week++;
    }
    const top = Math.max(1, ...counts);
    const cells = counts.map((n, idx) => ({ n, day: midnight(y, m, first + idx), future: idx > todayIdx, tier: n === 0 ? 0 : Math.min(4, Math.ceil((n / top) * 4)) }));
    const months: Array<{ col: number; label: string }> = [];
    for (let c = 0; c < WEEKS; c++) {
      const label = new Date(y, m, first + c * 7).toLocaleDateString("en-GB", { month: "short" });
      if (!months.length || months[months.length - 1].label !== label) months.push({ col: c, label });
    }
    if (months.length > 1 && months[1].col - months[0].col < 3) months.shift();
    return { cells, week, months, total: counts.reduce((a, b) => a + b, 0) };
  }, [threads]);
  const tierBg = ["var(--muted)", "color-mix(in srgb, var(--foreground) 22%, var(--muted))", "color-mix(in srgb, var(--foreground) 45%, var(--muted))", "color-mix(in srgb, var(--foreground) 70%, var(--muted))", "var(--foreground)"];
  return (
    <Card i={i} part="activity-card" label={<Heading label="Chats started" figure={<CountUp value={grid.week} />} note="in the last 7 days" />}>
      <div role="img" aria-label={`${grid.total} chats started in the last ${WEEKS} weeks, ${grid.week} in the last 7 days`}>
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))`, gridTemplateRows: "repeat(7, auto)", gridAutoFlow: "column" }}>
          {grid.cells.map((c, idx) => (
            <span
              key={idx}
              title={c.future ? undefined : `${new Date(c.day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${c.n} chat${c.n === 1 ? "" : "s"}`}
              className="nav-hk-pop aspect-square rounded-[3px]"
              style={{ background: c.future ? "transparent" : tierBg[c.tier], animationDelay: `${cellDelay(Math.floor(idx / 7), idx % 7)}ms` }}
            />
          ))}
        </div>
        <div className="mt-2 grid text-[11px] text-muted-foreground" style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}>
          {grid.months.map((m) => <span key={m.col} style={{ gridColumnStart: m.col + 1 }} className="whitespace-nowrap">{m.label}</span>)}
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-border pt-2.5 text-[12px] text-muted-foreground">
        <span>From the chats in your sidebar</span>
        <span className="inline-flex items-center gap-1">Fewer{tierBg.map((b, n) => <i key={n} aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: b }} />)}More</span>
      </div>
    </Card>
  );
}

/* --------------------------- usage across machines --------------------------- */

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", other: "Other" };
const STATE_TEXT = { current: "Current", retained: "Last reading kept", unavailable: "Unavailable" } as const;
const STATE_COLOR = { current: "var(--success)", retained: "var(--muted-foreground)", unavailable: "var(--destructive-text)" } as const;

function resetsIn(ms: number | null, now: number): string {
  if (ms === null || ms <= now) return "";
  const h = Math.round((ms - now) / 3_600_000);
  return h < 1 ? "resets within the hour" : h < 48 ? `resets in ${h}h` : `resets in ${Math.round(h / 24)} days`;
}
const resetClock = (ms: number) => new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const readAgo = (row: UsageMachineRow, now: number): string => {
  if (row.observedAt === null) return "No reading time";
  const t = ago(row.observedAt, now);
  return t === "now" ? "Read just now" : `Read ${t} ago`;
};

function Left({ r, now, withReset }: { r: ReturnType<typeof sessionOf>; now: number; withReset?: boolean }) {
  if (!r) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="block min-w-0">
      <span className="text-foreground" style={tnum}>{Math.round(r.remaining)}% left</span>
      <Meter value={r.remaining / 100} label={`${Math.round(r.remaining)}% left`} className="mt-1 w-16 bg-background" color={r.remaining <= 15 ? "var(--destructive-text)" : "var(--foreground)"} />
      {withReset && r.resetsAt ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{resetsIn(r.resetsAt, now)}</span> : null}
    </span>
  );
}

function ProviderRows({ harness, rows, missing, allowances, hints, now, busy, onLink }: {
  harness: string;
  rows: UsageMachineRow[];
  missing: Array<{ machine: string; state: string }>;
  allowances: Allowance[];
  hints: SameAccountHint[];
  now: number;
  busy: string | null;
  onLink: (keys: string[], linked: boolean) => void;
}) {
  const label = PROVIDER_LABEL[harness] ?? harness;
  const shared = allowances.filter((a) => a.shared);
  const plan = allowances.find((a) => a.plan)?.plan;
  return (
    <div data-nav-part="usage-provider" data-harness={harness} className={cn(tileCls, "min-w-0 px-3 py-3")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[13px] font-medium text-foreground">{label}{plan ? <span className="font-normal text-muted-foreground"> · {plan}</span> : null}</span>
        <span className="text-[12px] text-muted-foreground" style={tnum}>{allowances.length === 1 ? "1 allowance" : `${allowances.length} allowances`} · {rows.length} {rows.length === 1 ? "reading" : "readings"}</span>
      </div>
      <div className="-mx-1 mt-2 overflow-x-auto px-1">
        <table className="w-full min-w-[460px] border-collapse text-left text-[12px]">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="pb-1.5 pr-3 font-medium">Machine</th>
              <th scope="col" className="pb-1.5 pr-3 font-medium">Session</th>
              <th scope="col" className="pb-1.5 pr-3 font-medium">{harness === "cursor" ? "Month" : "Week"}</th>
              <th scope="col" className="pb-1.5 pr-3 font-medium">Updated</th>
              <th scope="col" className="pb-1.5 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = readState(row);
              const allowance = allowances.find((a) => a.id === row.allowanceId);
              return (
                <tr key={row.key} data-nav-part="usage-row" data-machine={row.machine} data-state={state} className={cn("border-t border-border align-top", state !== "current" ? "text-muted-foreground" : null)}>
                  <th scope="row" className="py-2 pr-3 font-medium text-foreground">
                    {machineName(row.machine)}
                    {row.label ? <span className="block truncate text-[11px] font-normal text-muted-foreground">{row.label}</span> : null}
                    {allowance?.shared ? <span data-nav-part="counted-once" className="block text-[11px] font-normal text-muted-foreground">same allowance as {allowance.machines.filter((m) => m !== row.machine).map(machineName).join(" / ")}</span> : null}
                  </th>
                  <td className="py-2 pr-3"><Left r={sessionOf(row)} now={now} /></td>
                  <td className="py-2 pr-3"><Left r={longOf(row)} now={now} withReset /></td>
                  <td data-nav-part="updated" className="py-2 pr-3 text-muted-foreground" style={tnum}>{readAgo(row, now)}</td>
                  <td className="py-2">
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: STATE_COLOR[state] }} />
                      {STATE_TEXT[state]}
                    </span>
                  </td>
                </tr>
              );
            })}
            {missing.map((m) => (
              <tr key={`missing:${m.machine}`} data-nav-part="usage-row" data-machine={m.machine} data-state="none" className="border-t border-border align-top text-muted-foreground">
                <th scope="row" className="py-2 pr-3 font-medium text-foreground">{machineName(m.machine)}</th>
                <td colSpan={3} className="py-2 pr-3 text-muted-foreground">No {label} reading from this machine</td>
                <td className="py-2"><span className="inline-flex items-center gap-1.5 text-foreground"><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: m.state === "fresh" ? STATE_COLOR.retained : STATE_COLOR.unavailable }} />{m.state === "stale" ? "Out of date" : m.state === "fresh" ? "Not reported" : "Unavailable"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shared.map((a) => (
        <div key={a.id} data-nav-part="one-allowance" className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border pt-2.5 text-[12px]">
          <span className="min-w-0 text-foreground" style={tnum}>
            <span className="font-medium">One allowance · {a.machines.map(machineName).join(" + ")}</span>
            {a.long ? <span> · {Math.round(a.long.remaining)}% left{a.long.resetsAt ? `, ${resetsIn(a.long.resetsAt, now)}` : ""}</span> : null}
            <span className="text-muted-foreground"> · counted once, {a.identity === "token-verified" ? "verified by the provider" : "confirmed by you"}</span>
          </span>
          {a.identity === "confirmed" ? (
            <button type="button" disabled={busy !== null} onClick={() => onLink(a.rows.map((r) => r.key), false)} className="nav-hk-hover inline-flex min-h-7 items-center rounded-full border border-border bg-card px-3 text-[12px] font-medium text-foreground outline-none hover:border-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">Count separately</button>
          ) : null}
        </div>
      ))}
      {hints.map((h) => (
        <div key={h.keys.join("|")} data-nav-part="same-account-hint" className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border pt-2.5 text-[12px]">
          <span className="min-w-0 text-foreground">{h.machines.map(machineName).join(" and ")} report the same reset time ({resetClock(h.resetsAt)}). Is this one {label} account? Until you confirm, they count as separate allowances.</span>
          <button type="button" disabled={busy !== null} onClick={() => onLink(h.keys, true)} className="nav-hk-hover inline-flex min-h-7 items-center rounded-full bg-primary px-3 text-[12px] font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{busy === h.keys.join("|") ? "Linking…" : "Count once"}</button>
        </div>
      ))}
    </div>
  );
}

/** Every provider on every machine, with when each was last read, and which readings are one subscription counted once. */
/** Usage across machines; draws nothing while F47 is unticked. */
export function UsageMachinesCard(props: { trend: Trend | null; onLink: (keys: string[], linked: boolean) => Promise<unknown>; i?: number }) {
  return useFeature("F47") ? <UsageMachinesCardBody {...props} /> : null;
}

function UsageMachinesCardBody({ trend, onLink, i = 0 }: { trend: Trend | null; onLink: (keys: string[], linked: boolean) => Promise<unknown>; i?: number }) {
  const countOnce = useFeature("F49");
  const now = useNow(30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = trend?.machines ?? [];
  const model = useMemo(() => {
    const allowances = allowancesOf(rows);
    const hints = countOnce ? sameAccountHints(rows) : [];
    const harnesses = [...new Set(rows.map((r) => r.harness))];
    return { allowances, hints, harnesses, totals: usageTotals(rows) };
  }, [rows]);
  const machines = sortMachines((trend?.sources ?? []).filter((s) => s.state !== "self").map((s) => s.machine));
  const link = (keys: string[], linked: boolean) => {
    setBusy(keys.join("|"));
    onLink(keys, linked).then(() => toast.success(linked ? "Counted as one allowance" : "Counted as separate allowances"), (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not change how these are counted")).finally(() => setBusy(null));
  };
  return (
    <Card
      i={i}
      part="usage-machines-card"
      label={<Heading label="Usage across machines" figure={trend ? <CountUp value={model.totals.allowances} /> : undefined} note={trend ? `${model.totals.allowances === 1 ? "allowance" : "allowances"} · ${model.totals.readings} ${model.totals.readings === 1 ? "reading" : "readings"}${model.totals.countedOnce > 0 ? ` · ${model.totals.countedOnce} counted once` : ""}` : undefined} />}
    >
      {!trend ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">Reading usage from every machine</p>
      ) : rows.length === 0 ? (
        <div className={cn(tileCls, "px-4 py-8 text-center text-[13px] text-muted-foreground")}>No readings yet. The plugin reads each machine's usage every few minutes.</div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {model.harnesses.map((h) => {
            const mine = rows.filter((r) => r.harness === h).sort((a, b) => machineRank(a.machine) - machineRank(b.machine) || a.machine.localeCompare(b.machine));
            const allowances = model.allowances.filter((a) => a.harness === h);
            const missing = h === "cursor" ? [] : machines.filter((m) => !mine.some((r) => r.machine === m)).map((machine) => ({ machine, state: trend.sources?.find((s) => s.machine === machine)?.state ?? "unavailable" }));
            return <ProviderRows key={h} harness={h} rows={mine} missing={missing} allowances={allowances} hints={model.hints.filter((x) => x.harness === h)} now={now} busy={busy} onLink={link} />;
          })}
        </div>
      )}
    </Card>
  );
}

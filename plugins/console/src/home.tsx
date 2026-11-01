// Home: the NavAIgate front page inside bb.
//   Head        N mark, today's date, what is running, today's brief (run on demand)
//   Stats       running, needs you, unread and parked across every harness
//   Ask         one box that starts a real bb chat; on Auto, Jev routes it to a harness
//   Machines    every machine with its load now; new work on the one you pick
//   Allowance   each subscription's week (month for Cursor) and its daily peaks
//   Window      the current session or week since it opened, from usage samples
//   Recent      the latest chats; Chats started, a grid of the last 18 weeks
//   Agenda, Inbox, Social, Audience and Money as before (their own files)
import { fieldArea } from "./controls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fullAccess, useWorkProject } from "./spawn";
import {
  experimental_ProviderIcon as BbProviderIcon,
  experimental_useProviders as useProviders,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { InboxCard } from "./inbox";
import { SocialCard } from "./social";
import { AudienceRow } from "./audience";
import { MoneyCard } from "./money";
import { LogoOrb } from "./orb";
import { rpcFlight } from "./rpc-flight";
import { useVisiblePoll } from "./visible-poll";
import { LIVE, caps, display, harnessOf, stateOf, tnum } from "./shared";
import type { Trend } from "../server-usage-trend";
import { Card, Heading, Reveal, Segmented, ensureHomeKitStyle, tileCls } from "./home-kit";
import { quietFor, splitLabel } from "./running";
import { useRunning } from "./use-running";
import { ActivityCard, AllowanceCard, MachinesCard, RecentCard, StatTiles, UsageMachinesCard, WindowCard, threadModel } from "./home-panels";
import { machineName } from "./words";
import { useFeature } from "./use-feature";


const PROVIDER: Record<string, string> = { claude: "claude-code", codex: "codex", cursor: "acp-cursor" };

/** The harness logo from bb's own provider records (id-only records fall back to a generic glyph). */
function ProviderIcon({ id, className }: { id: string; className?: string }) {
  const { providers } = useProviders();
  const rec = providers.find((p) => p.id === id) as { id: string; logoUrl?: string | null } | undefined;
  return <BbProviderIcon providerKind="agent" provider={rec ?? { id }} className={className} />;
}
function today() {
  return new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function usePoll<T>(key: string, fn: () => Promise<T>, ms: number): [T | null, () => void] {
  const [v, setV] = useState<T | null>(null);
  const alive = useRef(true);
  const run = useCallback((fresh = false) => {
    rpcFlight().call(key, fn, { ttlMs: ms / 2, fresh, slowStrikes: false }).then((r) => { if (alive.current) setV(r); }, () => {});
  }, [key, fn, ms]);
  const poll = useCallback(() => run(), [run]);
  useEffect(() => {
    alive.current = true;
    run();
    return () => { alive.current = false; };
  }, [run]);
  useVisiblePoll(poll, ms);
  const reload = useCallback(() => run(true), [run]);
  return [v, reload];
}

/* ------------------------------- Ask -------------------------------- */

type Who = "claude" | "codex" | "cursor";
type Route = {
  decisionId: string;
  source: "chip" | "text" | "jev" | "fallback";
  harness: Who;
  odds: Record<Who, number> | null;
  confidence: number | null;
  effort: "low" | "medium" | "high" | null;
  autoStart: boolean;
  message: string;
};
type AskLog = {
  recent: Array<{ id: string; at: number; text: string; source: string; suggested: Who; chosen: Who | null; confidence: number | null }>;
  jevDecisions: number;
  overrides: number;
};
const WHO_LABEL: Record<Who, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

function Ask() {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const { projects } = useSidebarThreads();
  const { providers, status } = useProviders();
  const [text, setText] = useState("");
  const [pick, setPick] = useState<"auto" | Who>("auto");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ route: Route; prompt: string } | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const project = useWorkProject();
  const logFn = useCallback(() => rpc.call("ask_log") as Promise<AskLog>, [rpc]);
  const [log, reloadLog] = usePoll("ask_log", logFn, 5 * 60_000);

  const rec = (h: Who) => providers.find((p) => p.id === PROVIDER[h]) as { available?: boolean; reasoningLevels?: Array<{ id: string }> } | undefined;
  // Unknown while loading counts as available; a provider bb reports as unavailable gets zero odds.
  const available = (h: Who) => status !== "ready" || (rec(h)?.available ?? false);

  const start = async (route: Route, harness: Who, prompt: string) => {
    if (!project) return;
    setBusy(true);
    try {
      const levels = rec(harness)?.reasoningLevels?.map((l) => l.id) ?? [];
      const reasoningLevel = route.source === "jev" && route.effort && levels.includes(route.effort) ? route.effort : undefined;
      const made = await sdk.threads.spawn(
        fullAccess({
          projectId: project.id,
          environment: { type: "project-default" },
          providerId: PROVIDER[harness],
          title: prompt.slice(0, 80),
          visibility: "visible",
          prompt,
          ...(reasoningLevel ? { reasoningLevel } : {}),
        }) as Parameters<typeof sdk.threads.spawn>[0],
      );
      await rpc.call("ask_commit", { decisionId: route.decisionId, harness }).catch(() => {});
      setText("");
      setConfirm(null);
      reloadLog();
      nav.toThread((made as { id: string }).id);
    } catch (e) {
      toast.error("Could not start the chat", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const go = async () => {
    const prompt = text.trim();
    if (!prompt || busy || !project) return;
    setBusy(true);
    setConfirm(null);
    let route: Route;
    try {
      route = (await rpc.call("ask_route", { text: prompt, pick, available: { claude: available("claude"), codex: available("codex"), cursor: available("cursor") } })) as Route;
    } catch (e) {
      setBusy(false);
      toast.error("Could not route the request", { description: e instanceof Error ? e.message : String(e) });
      return;
    }
    setBusy(false);
    reloadLog();
    setLine(route.autoStart ? route.message : null);
    if (route.autoStart) await start(route, route.harness, prompt);
    else setConfirm({ route, prompt });
  };

  const ranked = confirm?.route.odds ? (Object.entries(confirm.route.odds) as Array<[Who, number]>).sort((a, b) => b[1] - a[1]) : [];

  return (
    <Card i={4} part="ask-card" label={<Heading label="Ask" />} aside={<span className="text-[12px] text-muted-foreground">Starts a real chat in {project?.name ?? "your project"}. On Auto, Jev picks the harness</span>}>
      <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go();
        }}
        rows={3}
        aria-label="What should an agent do"
        placeholder="For example: check which Skool lessons still have the old hero image and list them"
        className={`${fieldArea} nav-hk-hover w-full resize-y py-2.5 text-[14px]`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Segmented
          label="Harness"
          value={pick}
          onChange={setPick}
          options={(["auto", "claude", "codex", "cursor"] as const).map((h) => ({
            value: h,
            disabled: h !== "auto" && !available(h),
            label: <>{h === "auto" ? <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h4l3-4h3M10 12h3M7 8l3 4" /></svg> : <ProviderIcon id={PROVIDER[h]} className="size-3.5" />}{h === "auto" ? "Auto" : harnessOf(PROVIDER[h]).label}</>,
          }))}
        />
        <button
          type="button"
          disabled={!text.trim() || busy}
          onClick={() => void go()}
          className="nav-hk-hover ml-auto inline-flex min-h-8 items-center rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          {busy ? "Starting…" : <>Start<kbd className="ml-1.5 rounded border border-current/30 px-1 font-mono text-[11px]">⌘↵</kbd></>}
        </button>
      </div>
      {confirm ? (
        <div className={cn(tileCls, "nav-hk-row mt-3 px-3 py-2.5")}>
          <div className="text-[13px] text-foreground" style={tnum}>
            Start this on {WHO_LABEL[confirm.route.harness]}?{" "}
            <span className="text-muted-foreground">
              {ranked.map(([h, o]) => `${h === confirm.route.harness ? "" : `${WHO_LABEL[h]} `}${o.toFixed(2)}`).join(" · ")}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(["claude", "codex", "cursor"] as const)
              .filter(available)
              .map((h) => (
                <button
                  key={h}
                  type="button"
                  disabled={busy}
                  onClick={() => void start(confirm.route, h, confirm.prompt)}
                  className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px]", h === confirm.route.harness ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                >
                  <ProviderIcon id={PROVIDER[h]} className="size-3.5" />
                  {WHO_LABEL[h]}
                </button>
              ))}
            <button type="button" onClick={() => setConfirm(null)} className="ml-auto px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {line ? <div className="mt-2 text-[12px] text-muted-foreground" style={tnum}>{line}</div> : null}
      {log && log.recent.length ? (
        <div className="mt-3 border-t border-border pt-2.5">
          <div className="mb-1 flex items-baseline gap-2">
            <span className={caps}>Recent routing</span>
            <span className="ml-auto text-[11px] text-muted-foreground" style={tnum}>
              Overrode Jev {log.overrides} of {log.jevDecisions}
            </span>
          </div>
          {log.recent.map((e, n) => (
            <div key={e.id} className="nav-hk-row grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-1 text-[12px]" style={{ animationDelay: `${n * 30}ms` }}>
              <span className="truncate text-foreground">{e.text}</span>
              <span className="text-muted-foreground" style={tnum}>
                {e.chosen ? WHO_LABEL[e.chosen] : "not started"} · {e.source === "jev" ? `Jev ${e.confidence?.toFixed(2) ?? ""}${e.chosen && e.chosen !== e.suggested ? " · overridden" : ""}` : e.source}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      </div>
    </Card>
  );
}

/* ------------------------------ Agenda ------------------------------ */

type Agenda = {
  configured: boolean;
  error: string | null;
  reconnect: string[];
  events: Array<{ title: string; start: string; end: string | null; allDay: boolean; account: string; location: string | null; link: string | null }>;
};

function AgendaCard({ agenda, i = 0 }: { agenda: Agenda | null; i?: number }) {
  const now = Date.now();
  const dayKey = (iso: string) => (iso.length <= 10 ? iso : new Date(iso).toLocaleDateString("en-CA"));
  const todayKey = new Date().toLocaleDateString("en-CA");
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const groups = new Map<string, Agenda["events"]>();
  for (const e of agenda?.events ?? []) {
    const k = dayKey(e.start);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return (
    <Card i={i} part="agenda-card" label={<Heading label="Agenda" figure={agenda?.configured && !agenda.error ? agenda.events.length : undefined} note={agenda?.configured && !agenda.error ? "today and tomorrow" : undefined} />}>
      <div>
      {!agenda ? (
        <div className="text-[13px] text-muted-foreground">Reading your calendars</div>
      ) : !agenda.configured ? (
        <div className="text-[13px] text-muted-foreground">Calendar comes through Composio. Add COMPOSIO_API_KEY to ~/.config/navaigate/composio.env.</div>
      ) : agenda.error ? (
        <div className="text-[13px] text-destructive-text">{agenda.error}</div>
      ) : (
        <>
          {agenda.reconnect.length ? (
            <div className="mb-2 rounded-md border border-border px-3 py-2 text-[12px] text-foreground">
              Google Calendar needs signing in again for {agenda.reconnect.join(", ")}. Ask in any chat to "reconnect my calendar".
            </div>
          ) : null}
          {groups.size === 0 ? (
            <div className="text-[13px] text-muted-foreground">{agenda.reconnect.length ? "" : "Nothing on today or tomorrow"}</div>
          ) : (
            Array.from(groups.entries()).map(([day, evs]) => (
              <div key={day} className="mb-2">
                <div className="mb-1 text-[12px] font-medium text-muted-foreground">{day === todayKey ? "Today" : "Tomorrow"}</div>
                {evs.map((e, i) => {
                  const live = !e.allDay && new Date(e.start).getTime() <= now && (!e.end || new Date(e.end).getTime() > now);
                  return (
                    <div key={i} className="nav-hk-row grid grid-cols-[92px_1fr_auto] items-baseline gap-3 py-1.5 text-[13px]" style={{ animationDelay: `${i * 30}ms` }}>
                      <span className="text-muted-foreground" style={tnum}>
                        {e.allDay ? "All day" : `${time(e.start)}${e.end ? `–${time(e.end)}` : ""}`}
                      </span>
                      <span className="truncate text-foreground" style={live ? { color: LIVE } : undefined}>
                        {live ? "Now · " : ""}
                        {e.title}
                      </span>
                      {e.link ? (
                        <a href={e.link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center text-[12px] text-muted-foreground hover:text-foreground">
                          Open
                        </a>
                      ) : (
                        <span />
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </>
      )}
      </div>
    </Card>
  );
}

/* ------------------------------- Page ------------------------------- */

export function HomePage() {
  ensureHomeKitStyle();
  const briefOn = useFeature("EXTRA-O");
  const trendOn = useFeature("EXTRA-AD");
  const askOn = useFeature("EXTRA-P");
  const inboxOn = useFeature("EXTRA-I");
  const socialOn = useFeature("EXTRA-L");
  const audienceOn = useFeature("EXTRA-M");
  const moneyOn = useFeature("EXTRA-K");
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const { threads: physical, projects } = useSidebarThreads();
  const { threads, view, board, now } = useRunning(physical);
  const accountsFn = useCallback(() => rpc.call("home_accounts").then((r) => r.accounts), [rpc]);
  const briefFn = useCallback(() => rpc.call("home_brief"), [rpc]);
  const agendaFn = useCallback(() => rpc.call("home_agenda") as Promise<Agenda>, [rpc]);
  const trendFn = useCallback(() => rpc.call("usage_trend") as Promise<Trend>, [rpc]);
  const [agenda] = usePoll("home_agenda", agendaFn, 5 * 60_000);
  const [accounts] = usePoll("home_accounts", accountsFn, 90_000);
  const [trend, reloadTrend] = usePoll("usage_trend", trendFn, 3 * 60_000);
  const linkUsage = useCallback((keys: string[], linked: boolean) => rpc.call("usage_link", { keys, linked }).then(() => reloadTrend()), [rpc, reloadTrend]);
  const [brief, reloadBrief] = usePoll("home_brief", briefFn, 5 * 60_000);
  const [running, setRunning] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(() => localStorage.getItem("nav-skin:home-account"));
  useEffect(() => {
    if (accountId) localStorage.setItem("nav-skin:home-account", accountId);
  }, [accountId]);

  const model = useMemo(() => threadModel(threads), [threads]);
  const workingBy = useMemo(() => {
    const s = new Set<string>();
    for (const i of view.running) s.add(harnessOf(i.providerId ?? "").key);
    return s;
  }, [view]);
  const working = view.running.length;
  const machineKeys = board?.columns.map((c) => c.key) ?? [];
  const account = accounts?.find((a) => a.id === accountId) ?? accounts?.[0] ?? null;

  const runBrief = async () => {
    setRunning(true);
    try {
      const r = await rpc.call("home_brief_run");
      (r.started ? toast.success : toast.error)(r.message);
      window.setTimeout(reloadBrief, 4 * 60_000);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div data-nav-part="home" data-tour="console-home" className="mx-auto flex max-w-[1180px] flex-col gap-4 px-4 py-6 sm:px-6">
        <header className="nav-hk-rise flex flex-wrap items-center gap-x-5 gap-y-3" style={{ ["--nav-hk-i" as string]: 0 }}>
          <LogoOrb size={56} mood={working ? "busy" : "idle"} />
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-medium sm:text-[28px] leading-tight tracking-[-0.02em] text-foreground" style={display}>{today()}</h1>
            <div className="mt-0.5 text-[13px]" style={working ? { color: LIVE } : undefined}>
              <span className={working ? undefined : "text-muted-foreground"}>{working ? `${working} agent${working === 1 ? "" : "s"} working right now` : "Nothing running right now"}</span>
              {working > 0 && machineKeys.length > 1 ? <span className="text-muted-foreground" data-nav-part="working-split">{` · ${splitLabel(view, machineKeys)}`}</span> : null}
              {view.stuck.length > 0 ? <span className="text-muted-foreground" data-nav-part="stuck" title={view.stuck.map((i) => `${machineName(i.machine)}: ${i.title} (quiet ${quietFor(i.updatedAt, now)})`).join("\n")}>{` · ${view.stuck.length} stuck? (quiet ${quietFor(view.stuck[0]!.updatedAt, now)})`}</span> : null}
            </div>
          </div>
          <button type="button" onClick={() => nav.toPluginPanel("delivery")} className="nav-hk-hover inline-flex min-h-8 items-center rounded-full border border-border bg-card px-3.5 text-[13px] font-medium text-foreground outline-none hover:border-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Delivery and PR proof
          </button>
          {briefOn ? <button type="button" disabled={running} onClick={() => void runBrief()} className="nav-hk-hover inline-flex min-h-8 items-center rounded-full border border-border bg-card px-3.5 text-[13px] font-medium text-foreground outline-none hover:border-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            {running ? "Starting…" : "Run today's brief"}
          </button> : null}
        </header>
        {briefOn ? <div data-nav-part="brief" className={cn(tileCls, "nav-hk-rise flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]")} style={{ ["--nav-hk-i" as string]: 1 }}>
          <span className={caps}>Brief</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{brief?.headline ?? "No brief yet"}</span>
          {brief?.date ? <span className="text-muted-foreground" style={tnum}>{brief.date}</span> : null}
        </div> : null}
        <StatTiles tally={model.tally} start={2} running={{ view, machines: machineKeys }} />
        <div className="grid items-start gap-4 lg:grid-cols-[1.25fr_1fr]">
          {askOn ? <Ask /> : <div />}
          <MachinesCard threads={physical} i={5} />
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-[1.25fr_1fr]">
          <AllowanceCard accounts={accounts} value={account?.id ?? null} onChange={setAccountId} workingBy={workingBy} i={6} icon={(h) => <ProviderIcon id={PROVIDER[h]} className="size-3.5" />} />
          {trendOn ? <WindowCard trend={trend} account={account} i={7} /> : <div />}
        </div>
        <UsageMachinesCard trend={trend} onLink={linkUsage} i={8} />
        <div className="grid items-start gap-4 lg:grid-cols-[1.25fr_1fr]">
          <RecentCard model={model} projects={projects} i={9} />
          <div className="grid gap-4">
            <AgendaCard agenda={agenda} i={10} />
            <ActivityCard threads={threads} i={11} />
          </div>
        </div>
        {inboxOn ? <Reveal i={12}><InboxCard /></Reveal> : null}
        {socialOn ? <Reveal i={13}><SocialCard /></Reveal> : null}
        {audienceOn ? <Reveal i={14}><AudienceRow /></Reveal> : null}
        {moneyOn ? <Reveal i={15}><MoneyCard /></Reveal> : null}
      </div>
    </div>
  );
}

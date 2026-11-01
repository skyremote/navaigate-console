// Calendar page: a Monday-to-Sunday month from both Composio Google Calendars,
// a day panel for the selected day, an "Ask about your calendar" box that starts
// a chat with the relevant events pasted in (routed through Ask/Jev), and
// Calendly booking links when Calendly is connected.
import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_useProviders as useProviders, useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { LIVE, caps, tnum } from "./shared";
import { PROVIDER_ID, useSpawn } from "./spawn";
import { fieldArea } from "./controls";

type Event = { title: string; start: string; end: string | null; allDay: boolean; account: string; location: string | null; link: string | null };
type Range = { configured: boolean; error: string | null; reconnect: string[]; events: Event[] };
type Calendly = { connected: boolean; via: string | null; error: string | null; schedulingUrl: string | null; eventTypes: Array<{ name: string; url: string; minutes: number | null }> };
type Who = keyof typeof PROVIDER_ID;

const DAY = 86_400_000;
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const atMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(atMidnight(d), -((d.getDay() + 6) % 7));
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const parseDay = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** The local days an event covers: all-day events span start..end-1, timed events sit on their start day. */
function daysOf(e: Event): string[] {
  if (!e.allDay) return [key(new Date(e.start))];
  const s = parseDay(e.start);
  const end = e.end ? parseDay(e.end) : addDays(s, 1);
  const out: string[] = [];
  for (let d = s; d < end && out.length < 62; d = addDays(d, 1)) out.push(key(d));
  return out.length ? out : [key(s)];
}
const sortEvents = (a: Event, b: Event) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1);
const line = (e: Event) =>
  `- ${e.allDay ? `${e.start.slice(0, 10)} all day` : `${new Date(e.start).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${e.end ? `–${time(e.end)}` : ""}`}: ${e.title}${e.location ? ` (${e.location})` : ""} [${e.account}]`;

const CHIPS = [
  { id: "next", label: "Prepare for my next meeting", days: 7 },
  { id: "week", label: "What does my week look like?", days: 7 },
  { id: "clash", label: "Check for scheduling clashes", days: 14 },
] as const;

function AskCalendar() {
  const rpc = useRpc<typeof rpcContract>();
  const { providers, status } = useProviders();
  const { spawn, busy, ready } = useSpawn();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const available = (h: Who) => status !== "ready" || ((providers.find((p) => p.id === PROVIDER_ID[h]) as { available?: boolean } | undefined)?.available ?? false);

  const go = async (question: string, days: number, kind: string | null) => {
    if (!question.trim() || busy || !ready) return;
    const now = new Date();
    const from = kind === "week" ? mondayOf(now) : atMidnight(now);
    const to = addDays(from, days);
    let evs: Event[] = [];
    try {
      const r = (await rpc.call("calendar_range", { from: from.toISOString(), to: to.toISOString() })) as Range;
      evs = r.events.filter((e) => (kind === "next" ? !e.allDay && new Date(e.end ?? e.start).getTime() > now.getTime() : true)).sort(sortEvents);
      if (kind === "next") evs = evs.slice(0, 3);
    } catch {
      /* the chat can still look them up */
    }
    // Route the question (not the event list) through Ask/Jev; low confidence falls back to Claude Code.
    let harness: Who = "claude";
    try {
      const route = (await rpc.call("ask_route", { text: question, pick: "auto", available: { claude: available("claude"), codex: available("codex"), cursor: available("cursor") } })) as {
        decisionId: string;
        harness: Who;
        autoStart: boolean;
        message: string;
      };
      harness = route.autoStart ? route.harness : available("claude") ? "claude" : route.harness;
      setNote(route.autoStart ? route.message : `Jev was unsure, so Claude Code takes it.`);
      void rpc.call("ask_commit", { decisionId: route.decisionId, harness }).catch(() => {});
    } catch {
      setNote(null);
    }
    const prompt = [
      question.trim(),
      evs.length
        ? `My calendar from ${from.toLocaleDateString("en-GB")} to ${addDays(to, -1).toLocaleDateString("en-GB")} (both Google Calendars, duplicates merged):\n${evs.map(line).join("\n")}`
        : "I could not paste my events; read them from Google Calendar through Composio (GOOGLECALENDAR_EVENTS_LIST on both connected accounts).",
      "Read-only: do not create, move or cancel any event, and do not email anyone, unless I say so.",
    ].join("\n\n");
    const ok = await spawn("cal", question.slice(0, 80), prompt, PROVIDER_ID[harness]);
    if (ok) setText("");
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className={cn(caps, "mb-2")}>Ask about your calendar</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void go(text, 14, null);
        }}
        rows={2}
        placeholder="For example: when could I fit a two-hour block for writing this week?"
        className={`${fieldArea} w-full resize-y outline-none placeholder:text-muted-foreground focus:border-ring`}
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={!!busy || !ready}
            onClick={() => void go(c.label, c.days, c.id)}
            className="rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:border-foreground hover:text-foreground disabled:opacity-40"
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          disabled={!text.trim() || !!busy}
          onClick={() => void go(text, 14, null)}
          className="ml-auto rounded-full px-3 py-1 text-[12px] font-medium bg-primary text-primary-foreground disabled:opacity-40"
        >
          {busy ? "Starting…" : "Ask"}
        </button>
      </div>
      {note ? <div className="mt-2 text-[11px] text-muted-foreground">{note}</div> : null}
    </section>
  );
}

function Booking() {
  const rpc = useRpc<typeof rpcContract>();
  const [c, setC] = useState<Calendly | null>(null);
  useEffect(() => {
    rpc.call("calendar_calendly").then((v) => setC(v as Calendly), () => {});
  }, [rpc]);
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className={cn(caps, "mb-2")}>Booking links</div>
      {!c ? (
        <div className="text-[12px] text-muted-foreground">Loading…</div>
      ) : !c.connected ? (
        <div className="text-[12px] leading-relaxed text-muted-foreground">
          Connect Calendly to list your event types here: connect the Calendly toolkit in Composio, or put a personal access token in ~/.config/navaigate/calendly.env as CALENDLY_API_TOKEN.
        </div>
      ) : c.error ? (
        <div className="text-[12px] text-destructive-text">{c.error}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {c.eventTypes.map((t) => (
            <a key={t.url} href={t.url} target="_blank" rel="noopener noreferrer" className="flex items-baseline gap-2 text-[13px] text-foreground hover:underline">
              <span className="truncate">{t.name}</span>
              {t.minutes ? <span className="text-[11px] text-muted-foreground" style={tnum}>{t.minutes} min</span> : null}
            </a>
          ))}
          {c.schedulingUrl ? (
            <a href={c.schedulingUrl} target="_blank" rel="noopener noreferrer" className="mt-1 text-[12px] text-muted-foreground hover:text-foreground">
              All booking pages
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function CalendarPage() {
  const rpc = useRpc<typeof rpcContract>();
  const today = atMidnight(new Date());
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState(key(today));
  const [data, setData] = useState<Range | null>(null);

  const gridStart = mondayOf(month);
  const lastOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const gridEnd = addDays(mondayOf(lastOfMonth), 7);
  const weeks = Math.round((gridEnd.getTime() - gridStart.getTime()) / (7 * DAY));

  const load = useCallback(() => {
    setData(null);
    rpc.call("calendar_range", { from: gridStart.toISOString(), to: gridEnd.toISOString() }).then((v) => setData(v as Range), (e) => setData({ configured: true, error: String(e?.message ?? e), reconnect: [], events: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, month.getTime()]);
  useEffect(load, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, Event[]>();
    for (const e of data?.events ?? []) for (const d of daysOf(e)) m.set(d, [...(m.get(d) ?? []), e]);
    for (const v of m.values()) v.sort(sortEvents);
    return m;
  }, [data]);

  const move = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const goToday = () => {
    setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelected(key(today));
  };
  const sel = parseDay(selected);
  const selEvents = byDay.get(selected) ?? [];
  const now = Date.now();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-4 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className={caps}>Calendar</span>
          <h1 className="text-[22px] font-medium text-foreground">{month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h1>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={goToday} className="rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-foreground">
              Today
            </button>
            <button type="button" aria-label="Previous month" onClick={() => move(-1)} className="rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-foreground">
              ‹
            </button>
            <button type="button" aria-label="Next month" onClick={() => move(1)} className="rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-foreground">
              ›
            </button>
          </div>
        </div>
        {data && !data.configured ? <div className="text-[13px] text-muted-foreground">Calendar comes through Composio. Add COMPOSIO_API_KEY to ~/.config/navaigate/composio.env.</div> : null}
        {data?.error ? <div className="text-[13px] text-destructive-text">{data.error}</div> : null}
        {data?.reconnect.length ? <div className="rounded-md border border-foreground px-3 py-2 text-[12px] text-foreground">Google Calendar needs signing in again for {data.reconnect.join(", ")}.</div> : null}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="rounded-xl border border-border bg-card p-3">
            <div className="grid grid-cols-7 gap-px pb-1">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <div key={d} className="px-2 text-[11px] font-medium text-muted-foreground">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1" style={{ gridTemplateRows: `repeat(${weeks}, minmax(104px, 1fr))` }}>
              {Array.from({ length: weeks * 7 }, (_, i) => {
                const d = addDays(gridStart, i);
                const k = key(d);
                const evs = byDay.get(k) ?? [];
                const inMonth = d.getMonth() === month.getMonth();
                const isToday = k === key(today);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSelected(k)}
                    className={cn(
                      "flex min-w-0 flex-col items-stretch rounded-lg border p-1.5 text-left transition-colors",
                      selected === k ? "border-foreground" : "border-border hover:border-muted-foreground/40",
                      inMonth ? "bg-background" : "bg-background/40",
                    )}
                  >
                    <span className={cn("mb-1 text-[12px]", inMonth ? "text-foreground" : "text-muted-foreground", isToday && "font-medium")} style={isToday ? { color: "var(--foreground)", ...tnum } : tnum}>
                      {d.getDate()}
                    </span>
                    {evs.slice(0, 3).map((e, j) => (
                      <span key={j} className="truncate text-[11px] leading-[1.45] text-foreground" title={e.title}>
                        {e.allDay ? (
                          <span className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: LIVE }} />
                        ) : (
                          <span className="mr-1 text-muted-foreground" style={tnum}>
                            {time(e.start)}
                          </span>
                        )}
                        {e.title}
                      </span>
                    ))}
                    {evs.length > 3 ? <span className="text-[11px] text-muted-foreground">+{evs.length - 3} more</span> : null}
                  </button>
                );
              })}
            </div>
            {!data ? <div className="pt-2 text-[12px] text-muted-foreground">Loading events…</div> : null}
          </section>
          <div className="flex flex-col gap-4">
            <section className="rounded-xl border border-border bg-card p-4">
              <div className={caps}>{key(sel) === key(today) ? "Today" : sel.toLocaleDateString("en-GB", { weekday: "long" })}</div>
              <div className="mb-3 text-[15px] font-medium text-foreground">{sel.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</div>
              {selEvents.length === 0 ? (
                <div className="text-[13px] text-muted-foreground">{data ? "Nothing on" : "Loading…"}</div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {selEvents.map((e, i) => {
                    const live = !e.allDay && new Date(e.start).getTime() <= now && (!e.end || new Date(e.end).getTime() > now);
                    return (
                      <div key={i} className="border-l-2 pl-2.5" style={{ borderColor: live ? LIVE : "var(--border)" }}>
                        <div className="text-[11px] text-muted-foreground" style={tnum}>
                          {e.allDay ? "All day" : `${time(e.start)}${e.end ? `–${time(e.end)}` : ""}`}
                          {live ? " · now" : ""}
                        </div>
                        <div className="text-[13px] text-foreground">{e.title}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {e.account}
                          {e.location ? ` · ${e.location}` : ""}
                        </div>
                        {e.link ? (
                          <a href={e.link} target="_blank" rel="noopener noreferrer" className="text-[11px] text-muted-foreground hover:text-foreground">
                            Open
                          </a>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <AskCalendar />
            <Booking />
          </div>
        </div>
      </div>
    </div>
  );
}

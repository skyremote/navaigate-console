// Inbox page: every email from the owner's three Gmail accounts (read-only, through
// Composio) and one button, Sort with Jev, that puts each email in a pile. The
// sort shows a live counter and a gold progress line, then the list flies into
// the piles with a FLIP animation (Web Animations API, transforms and opacity
// only). Time and cost in the banner are the server's measured numbers.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { InboxMessage, InboxPageData, InboxPageItem, InboxRun } from "../server-inbox-page";
import { BrandIcon } from "./brand-icons";
import { replyPrompt } from "./inbox";
import { rpcFlight } from "./rpc-flight";
import { useVisiblePoll } from "./visible-poll";
import { PILES, PILE_IDS, REPLY_RULE, URGENCY_LEVELS, type PileId } from "./piles";
import { LIVE, Lattice, caps, tnum } from "./shared";
import { useSpawn } from "./spawn";
import { prepareShow, runShow, type ShowEmail, type ShowPrep } from "./inbox-show";
import { field } from "./controls";

type Days = 7 | 30;
type View = "list" | "piles";
type Folder = "inbox" | "starred" | "sent";
type Filter = PileId | "unsorted" | null;
type Sorting = { running: boolean; done: number; total: number; remembered: number; count: number };

const INK = "var(--primary-foreground)";
const CARD_ROWS = 3;
const MAX_CHIPS = 66;
// Motion: a spring-like curve with a little overshoot for the rows, a soft
// ease-out for the cards, and a total budget of about 850 ms.
const SPRING = "cubic-bezier(.16,1,.3,1)";
const SOFT = "cubic-bezier(.16,1,.3,1)";
const ROW_MS = 520;
const TOTAL_MS = 860;

const PAGE_CSS = `
@keyframes nav-inbox-sweep { from { transform: translateX(-120%); } to { transform: translateX(420%); } }
@keyframes nav-inbox-breathe { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(.92); opacity: .78; } }
.nav-inbox-sweep { animation: nav-inbox-sweep 1.15s cubic-bezier(.16,1,.3,1) infinite; }
@keyframes nav-inbox-shimmer { from { transform: translateX(-110%) skewX(-18deg); } to { transform: translateX(380%) skewX(-18deg); } }
.nav-inbox-shimmer { animation: nav-inbox-shimmer 1.15s cubic-bezier(.16,1,.3,1) 120ms 1 both; }
.nav-inbox-breathe { animation: nav-inbox-breathe 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .nav-inbox-sweep, .nav-inbox-breathe, .nav-inbox-shimmer { animation: none; opacity: 0; } }
`;
function useInboxStyle() {
  useEffect(() => {
    if (document.getElementById("nav-inbox-style")) return;
    const el = document.createElement("style");
    el.id = "nav-inbox-style";
    el.textContent = PAGE_CSS;
    document.head.appendChild(el);
  }, []);
}

function useReducedMotion(): boolean {
  const q = "(prefers-reduced-motion: reduce)";
  const [r, setR] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return r;
}

// ---------- Senders ----------

const address = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
const senderName = (from: string) => {
  const n = from.replace(/<[^>]+>/, "").replace(/"/g, "").trim();
  return (n || address(from).replace(/@.*/, "")).slice(0, 48);
};
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|icloud|me|yahoo|proton|protonmail|gmx|web)\./;
function orgOf(from: string): string {
  const a = address(from);
  const d = a.split("@")[1] ?? "";
  if (!d || FREE_MAIL.test(d)) return a;
  const parts = d.split(".");
  const keep = /^(co|com|org|net|gov|ac)$/.test(parts.at(-2) ?? "") && parts.length > 2 ? 3 : 2;
  return parts.slice(-keep).join(".");
}
const BRAND_RULES: Array<[RegExp, string]> = [
  [/[@.]skool\.com$/, "skool"],
  [/[@.]youtube\.com$/, "youtube"],
  [/^calendar-notification@google\.com$/, "googlecalendar"],
  [/[@.]stripe\.com$/, "stripe"],
  [/[@.]vercel\.com$/, "vercel"],
  [/[@.](notion\.so|makenotion\.com|notion\.com)$/, "notion"],
  [/[@.]openrouter\.ai$/, "openrouter"],
  [/[@.]github\.com$/, "github"],
  [/[@.]linkedin\.com$/, "linkedin"],
  [/[@.]qonto\.com$/, "qonto"],
  [/[@.]calendly\.com$/, "calendly"],
];
function brandFor(from: string): string | null {
  const a = address(from);
  for (const [re, k] of BRAND_RULES) if (re.test(a)) return k;
  if (/google calendar/i.test(from)) return "googlecalendar";
  return null;
}
const AVATAR = ["#3f3f46", "#52525b", "#5b5b63", "#63636a", "#4a4a52", "#57575f", "#44444b", "#60606a"];
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function Avatar({ from, size = 30 }: { from: string; size?: number }) {
  const b = brandFor(from);
  if (b)
    return (
      <span data-avatar className="inline-flex shrink-0">
        <BrandIcon platform={b} size={size} />
      </span>
    );
  const n = senderName(from);
  const words = n.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
  const ini = ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  return (
    <span
      aria-hidden
      data-avatar
      className="inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: AVATAR[hash(address(from)) % AVATAR.length] }}
    >
      {ini}
    </span>
  );
}

// ---------- Small formatting ----------

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= mid) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.getTime() >= mid - 86_400_000) return "Yesterday";
  if (d.getTime() >= mid - 6 * 86_400_000) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const usd = (x: number) => `$${x < 0.01 ? x.toFixed(5) : x.toFixed(4)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
const accountLabel = (a: string) => (/@gmail\.com$/.test(a) ? "Gmail" : a.replace(/^.*@/, ""));
const tint = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;

// ---------- Marks ----------

/** Jev's mark: an ink hexagon with a J. */
function JevMark({ size = 34, busy = false }: { size?: number; busy?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-label="Jev" role="img" className={cn("shrink-0", busy && "nav-inbox-breathe")}>
      <path d="M16 2.6 27.6 9.3v13.4L16 29.4 4.4 22.7V9.3Z" fill="var(--primary)" stroke="var(--primary)" strokeWidth="2.6" strokeLinejoin="round" />
      <text x="16" y="21.6" textAnchor="middle" fontSize="15" fontWeight="700" fill={INK} style={{ fontFamily: "inherit" }}>
        J
      </text>
    </svg>
  );
}

function Star({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-label={on ? "Starred" : undefined} aria-hidden={!on}>
      <path
        d="m12 3.2 2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.5l-5.4 2.9 1.2-5.9-4.4-4.1 6-.7Z"
        fill={on ? "var(--foreground)" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        opacity={on ? 1 : 0.35}
      />
    </svg>
  );
}

/** A number the FLIP pass can count up: React sets the final value, the animation tweens the text. */
function Count({ value, className, style }: { value: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !el.dataset.anim) el.textContent = String(value);
  }, [value]);
  return <span ref={ref} data-count={value} className={className} style={{ ...tnum, ...style }} />;
}

/** The banner counter: ticks towards its target on each frame, never re-rendering React. */
function Ticker({ value, reduced }: { value: number; reduced: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      shown.current = value;
      el.textContent = String(value);
      return;
    }
    let raf = 0;
    const from = shown.current;
    const t0 = performance.now();
    const dur = Math.min(600, 120 + Math.abs(value - from) * 6);
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      shown.current = Math.round(from + (value - from) * e);
      el.textContent = String(shown.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced]);
  return <span ref={ref} style={tnum} />;
}

/** A banner figure that counts up from zero once, for the finale. */
function NumUp({ value, fmt, play }: { value: number; fmt: (x: number) => string; play: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = fmt(value);
    if (!play) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      el.textContent = fmt(value * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, play]);
  return <span ref={ref} style={tnum} />;
}

// ---------- Page ----------

export function InboxPage() {
  useInboxStyle();
  const rpc = useRpc<typeof rpcContract>();
  const reduced = useReducedMotion();
  const { spawn, busy, ready } = useSpawn();

  const [days, setDays] = useState<Days>(7);
  const [account, setAccount] = useState<string>("all");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [filter, setFilter] = useState<Filter>(null);
  const [view, setView] = useState<View>("list");
  const [page, setPage] = useState<InboxPageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [sorting, setSorting] = useState<Sorting | null>(null);
  const [justRan, setJustRan] = useState<InboxRun | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sortingRef = useRef(false);
  sortingRef.current = !!sorting?.running;
  const load = useCallback(
    async (refresh = false, fresh = refresh) => {
      setLoading(true);
      try {
        const p = (await rpcFlight().call(`inbox_list:${days}:${refresh ? "refresh" : "read"}`, () => rpc.call("inbox_list", { days, refresh }), { fresh })) as InboxPageData;
        setPage(p);
        return p;
      } catch (e) {
        toast.error("Could not read the inbox", { description: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        setLoading(false);
      }
    },
    [rpc, days],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useVisiblePoll(() => { if (!sortingRef.current) void load(); }, 5 * 60_000);

  // Pick up a sort that is already running (another window, or a reload mid-sort).
  useEffect(() => {
    rpc.call("inbox_sort_status").then(
      (s) => s.running && setSorting({ running: true, done: s.done, total: s.total, remembered: s.remembered, count: s.count }),
      () => {},
    );
  }, [rpc]);

  // ---------- Derived ----------
  const items = page?.items ?? [];
  const mine = useMemo(() => (account === "all" ? items : items.filter((i) => i.account === account)), [items, account]);
  const inbox = useMemo(() => mine.filter((i) => i.folder === "inbox"), [mine]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(PILE_IDS.map((p) => [p, 0])) as Record<PileId, number>;
    let unsorted = 0;
    for (const i of inbox) i.pile ? c[i.pile]++ : unsorted++;
    return { piles: c, unsorted, starred: mine.filter((i) => i.starred).length, sent: mine.filter((i) => i.folder === "sent").length };
  }, [inbox, mine]);
  const shown = useMemo(() => {
    if (folder === "sent") return mine.filter((i) => i.folder === "sent");
    if (folder === "starred") return mine.filter((i) => i.starred);
    if (filter === "unsorted") return inbox.filter((i) => !i.pile);
    return filter ? inbox.filter((i) => i.pile === filter) : inbox;
  }, [mine, inbox, folder, filter]);
  const groups = useMemo(() => {
    const g = new Map<string, InboxPageItem[]>();
    for (const i of shown) {
      const k = i.pile ?? "unsorted";
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(i);
    }
    const reply = g.get("reply_today");
    if (reply) reply.sort((a, b) => (b.jev?.urgency ?? 0) - (a.jev?.urgency ?? 0) || b.receivedAt.localeCompare(a.receivedAt));
    const order = [...PILE_IDS, "unsorted"] as const;
    const out = order.filter((k) => g.has(k)).map((k) => ({ key: k, rows: g.get(k)! }));
    if (!filter && folder === "inbox" && !g.has("reply_today") && inbox.some((i) => i.pile)) out.unshift({ key: "reply_today", rows: [] });
    return out;
  }, [shown, filter, folder, inbox]);

  const all = page?.items.filter((i) => i.folder === "inbox") ?? [];
  const sortedAll = all.filter((i) => i.pile).length;
  const unsortedAll = all.length - sortedAll;
  const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const today = all.filter((i) => new Date(i.receivedAt).getTime() >= midnight).length;
  const open = openId ? items.find((i) => i.id === openId) ?? null : null;

  // ---------- FLIP ----------
  const scrollRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ rects: Map<string, DOMRect>; to: View } | null>(null);
  const running = useRef<Animation[]>([]);

  const stopAnimations = () => {
    for (const a of running.current) a.cancel();
    running.current = [];
    scrollRef.current?.querySelectorAll<HTMLElement>("[data-anim]").forEach((el) => {
      delete el.dataset.anim;
      if (el.dataset.count) el.textContent = el.dataset.count;
    });
  };

  const switchView = useCallback(
    (to: View) => {
      if (to === view) return;
      stopAnimations();
      const root = scrollRef.current;
      if (reduced || !root) {
        setView(to);
        return;
      }
      // 1. Measure every row where it is now.
      const rects = new Map<string, DOMRect>();
      root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => rects.set(el.dataset.flip!, el.getBoundingClientRect()));
      pending.current = { rects, to };
      // 2. Render the other layout; the layout effect below plays 3 and 4.
      setView(to);
    },
    [view, reduced],
  );

  useLayoutEffect(() => {
    const p = pending.current;
    const root = scrollRef.current;
    if (!p || p.to !== view || !root) return;
    pending.current = null;
    root.scrollTop = 0;
    const box = root.getBoundingClientRect();
    const inView = (r: DOMRect) => r.bottom > box.top - 40 && r.top < box.bottom + 40;

    // Read everything first (one layout), then write: no thrash.
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-flip]")).map((el) => ({ el, to: el.getBoundingClientRect(), from: p.rects.get(el.dataset.flip!) }));
    const moving = rows.filter((r) => inView(r.to) || (r.from && inView(r.from)));
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-card]")).filter((c) => inView(c.getBoundingClientRect()));
    const chips = view === "piles" ? Array.from(root.querySelectorAll<HTMLElement>("[data-chip]")).filter((c) => inView(c.getBoundingClientRect())) : [];

    const n = moving.length;
    const stagger = n > 1 ? Math.max(5, Math.min(18, (TOTAL_MS - ROW_MS) / (n - 1))) : 0;
    const delayOf = new Map<HTMLElement, number>();
    const anims: Animation[] = [];
    const go = (el: HTMLElement, kf: Keyframe[], o: KeyframeAnimationOptions) => {
      el.style.willChange = "transform, opacity";
      el.dataset.anim = "1";
      const a = el.animate(kf, { fill: "backwards", ...o });
      anims.push(a);
      return a;
    };

    // 3. Each row from its old rect to its new slot.
    moving.forEach((r, i) => {
      const delay = i * stagger;
      delayOf.set(r.el, delay);
      if (r.from) {
        const dx = r.from.left - r.to.left;
        const dy = r.from.top - r.to.top;
        go(r.el, [{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6 }, { transform: "translate(0, 0)", opacity: 1 }], { duration: ROW_MS, delay, easing: SPRING });
      } else {
        go(r.el, [{ transform: "translateY(10px) scale(.98)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: ROW_MS - 120, delay, easing: SOFT });
      }
    });

    // Cards fade and lift in just before their first row lands; counts count up.
    for (const card of cards) {
      const first = card.querySelector<HTMLElement>("[data-flip]");
      const land = first ? (delayOf.get(first) ?? 0) : 0;
      const delay = Math.max(0, land - 90);
      card.querySelectorAll<HTMLElement>("[data-card-bg], [data-card-head]").forEach((el) =>
        go(el, [{ transform: "translateY(14px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 340, delay, easing: SOFT }),
      );
      const count = card.querySelector<HTMLElement>("[data-count]");
      if (count) {
        const target = Number(count.dataset.count ?? 0);
        count.dataset.anim = "1";
        count.textContent = "0";
        const t0 = performance.now() + delay;
        const dur = ROW_MS + 160;
        const tick = (t: number) => {
          if (!count.dataset.anim) return;
          const k = Math.max(0, Math.min(1, (t - t0) / dur));
          count.textContent = String(Math.round(target * (1 - Math.pow(1 - k, 3))));
          if (k < 1) requestAnimationFrame(tick);
          else delete count.dataset.anim;
        };
        requestAnimationFrame(tick);
      }
    }

    // The % chips pop in last, once the rows have landed.
    const end = (n > 0 ? (n - 1) * stagger : 0) + ROW_MS;
    chips.forEach((c, j) =>
      go(c, [{ transform: "scale(.9)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], {
        duration: 260,
        delay: end - 150 + Math.min(j * 6, 140),
        easing: "ease-out",
      }),
    );

    running.current = anims;
    Promise.all(anims.map((a) => a.finished.catch(() => undefined))).then(() => {
      if (running.current !== anims) return;
      for (const a of anims) {
        const el = (a.effect as KeyframeEffect | null)?.target as HTMLElement | null;
        if (el) {
          el.style.willChange = "";
          if (!el.dataset.count) delete el.dataset.anim;
        }
      }
      running.current = [];
    });
  }, [view]);

  // ---------- The show: after a sort, the list fires into the piles ----------
  // Phases: "lift" (chips onto the overlay, list fades), "fly" (buckets staged,
  // chips launched on the beat), "finale" (sure labels, % chips, banner numbers).
  const [phase, setPhase] = useState<"idle" | "lift" | "fly" | "finale">("idle");
  const [launching, setLaunching] = useState(false);
  const [finaleAt, setFinaleAt] = useState(0);
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem("navaigate-inbox-sound") === "on";
    } catch {
      return false;
    }
  });
  const prepRef = useRef<ShowPrep | null>(null);
  const runRef = useRef<InboxRun | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  const finale = useCallback((run: InboxRun | null) => {
    setLaunching(false);
    setSorting(null);
    setJustRan(run);
    setFinaleAt(Date.now());
    setPhase("finale");
  }, []);

  // 1. Lift: clone the rows as chips at their list positions, fade the real list out.
  useLayoutEffect(() => {
    if (phase !== "lift") return;
    const root = scrollRef.current;
    if (!root) return finale(runRef.current);
    const box = root.getBoundingClientRect();
    const els = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => els.set(el.dataset.flip!, el));
    const visible: string[] = [];
    for (const [id, el] of els) {
      const r = el.getBoundingClientRect();
      if (r.bottom > box.top + 4 && r.top < box.bottom - 4) visible.push(id);
    }
    const byId = new Map(shown.map((m) => [m.id, m]));
    const chosen = new Set(visible.filter((id) => byId.get(id)?.pile));
    for (const g of groups) for (const m of g.rows.slice(0, CARD_ROWS)) chosen.add(m.id);
    // Fill up to MAX in proportion to each pile's size, so big piles get more chips.
    const queues = groups.map((g) => ({ rows: g.rows.filter((m) => !chosen.has(m.id)), total: g.rows.length, got: g.rows.filter((m) => chosen.has(m.id)).length }));
    while (chosen.size < MAX_CHIPS) {
      const q = queues.filter((x) => x.rows.length).sort((a, b) => b.total / (b.got + 1) - a.total / (a.got + 1))[0];
      if (!q) break;
      chosen.add(q.rows.shift()!.id);
      q.got++;
    }
    // Launch order: the rows on screen first, top to bottom, then the rest interleaved across piles.
    const first = visible.filter((id) => chosen.has(id));
    const rest = new Map<string, string[]>();
    for (const id of chosen) {
      if (first.includes(id)) continue;
      const k = byId.get(id)?.pile ?? "unsorted";
      if (!rest.has(k)) rest.set(k, []);
      rest.get(k)!.push(id);
    }
    const order = [...first];
    const lists = [...rest.values()];
    for (let i = 0; order.length < chosen.size; i++) for (const l of lists) if (l[i]) order.push(l[i]);
    const emails: ShowEmail[] = order.map((id) => {
      const m = byId.get(id)!;
      return { id, subject: m.subject, color: m.pile ? PILES[m.pile].color : "#8e8e96", row: els.get(id) ?? null };
    });
    prepRef.current = prepareShow(emails, box);
    const list = root.firstElementChild as HTMLElement | null;
    const fade = list?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 190, easing: "ease-out", fill: "forwards" });
    const t = window.setTimeout(() => {
      fade?.cancel();
      if (list) list.style.opacity = "0";
      root.scrollTop = 0;
      setLaunching(true);
      setView("piles");
      setPhase("fly");
    }, 200);
    return () => window.clearTimeout(t);
  }, [phase]);

  // 2-4. Fly: stage the buckets and fire the chips; the finale follows the last catch.
  useLayoutEffect(() => {
    if (phase !== "fly" || view !== "piles" || !launching) return;
    const root = scrollRef.current;
    const prep = prepRef.current;
    if (!root || !prep) return finale(runRef.current);
    prepRef.current = null;
    const cards = new Map<string, HTMLElement>();
    const counts = new Map<string, { el: HTMLElement; total: number }>();
    const rows = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>("[data-card]").forEach((card) => {
      const k = card.dataset.card!;
      cards.set(k, card);
      const c = card.querySelector<HTMLElement>("[data-count]");
      if (c) counts.set(k, { el: c, total: Number(c.dataset.count ?? 0) });
      card.querySelectorAll<HTMLElement>("[data-flip]").forEach((r) => rows.set(r.dataset.flip!, r));
    });
    const pileOf = new Map(shown.map((m) => [m.id, m.pile ?? "unsorted"] as const));
    void runShow(prep, { cards, counts, rows, pileOf, sound }).then(() => finale(runRef.current));
  }, [phase, view, launching]);

  // Finale: sure labels fade in, % chips pop in left to right.
  useLayoutEffect(() => {
    if (phase !== "finale") return;
    setPhase("idle");
    const root = scrollRef.current;
    if (!root || reduced || view !== "piles") return;
    root.querySelectorAll<HTMLElement>("[data-sure]").forEach((el, i) =>
      el.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: i * 30, easing: SOFT, fill: "backwards" }),
    );
    const chips = Array.from(root.querySelectorAll<HTMLElement>("[data-chip]")).map((el) => ({ el, r: el.getBoundingClientRect() }));
    chips.sort((a, b) => a.r.left - b.r.left || a.r.top - b.r.top);
    chips.forEach(({ el }, i) =>
      el.animate([{ transform: "scale(.9)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], {
        duration: 280,
        delay: 80 + i * 16,
        easing: "ease-out",
        fill: "backwards",
      }),
    );
  }, [phase]);

  // ---------- Sort ----------
  const seenRef = useRef(new Set<string>());
  const sort = async (resortAll: boolean) => {
    if (sorting?.running || phase !== "idle") return;
    try {
      if (resortAll) {
        if (view === "piles") switchView("list");
        setPage((p) => p && { ...p, items: p.items.map((i) => ({ ...i, pile: null, sure: null, byRule: false, jev: null })) });
      }
      seenRef.current = new Set();
      setJustRan(null);
      setFilter(null);
      setFolder("inbox");
      const r = await rpc.call("inbox_sort", { days, all: resortAll });
      setSorting({ running: true, done: 0, total: r.total, remembered: r.remembered, count: r.count });
    } catch (e) {
      toast.error("Jev could not start", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  /** Jev touching each email: a 1-2 px shake on the row and its pile dot lighting up. */
  const touch = (recent: Array<{ id: string; pile: PileId }>) => {
    const root = scrollRef.current;
    const fresh = recent.filter((r) => !seenRef.current.has(r.id));
    for (const r of fresh) seenRef.current.add(r.id);
    if (!root || !fresh.length || viewRef.current !== "list") return;
    const box = root.getBoundingClientRect();
    const hits = fresh
      .map((r) => ({ r, el: root.querySelector<HTMLElement>(`[data-flip="${CSS.escape(r.id)}"]`) }))
      .filter((x): x is { r: { id: string; pile: PileId }; el: HTMLElement } => !!x.el)
      .map((x) => ({ ...x, rect: x.el.getBoundingClientRect() }));
    hits.forEach(({ r, el, rect }, i) => {
      const dot = el.querySelector<HTMLElement>("[data-dot]");
      if (dot) dot.style.background = PILES[r.pile].color;
      if (reducedRef.current || rect.bottom < box.top || rect.top > box.bottom) return;
      el.animate(
        [{ transform: "none" }, { transform: "translateX(-2px)" }, { transform: "translateX(2px)" }, { transform: "translateX(-1px)" }, { transform: "translateX(1px)" }, { transform: "none" }],
        { duration: 220, delay: i * 22, easing: "linear" },
      );
      dot?.animate([{ transform: "scale(.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 260, delay: i * 22, easing: "ease-out", fill: "backwards" });
    });
  };

  useEffect(() => {
    if (!sorting?.running) return;
    let stop = false;
    let waiting = false;
    const id = window.setInterval(async () => {
      if (waiting) return;
      waiting = true;
      try {
        const s = await rpc.call("inbox_sort_status");
        if (stop) return;
        touch(s.recent);
        if (s.running) {
          setSorting({ running: true, done: s.done, total: s.total, remembered: s.remembered, count: s.count });
          return;
        }
        stop = true;
        window.clearInterval(id);
        setSorting({ running: false, done: s.total, total: s.total, remembered: s.remembered, count: s.count });
        if (s.error && s.run && s.run.failed) toast.message(`Jev could not sort ${s.run.failed} emails`, { description: s.error });
        const p = await load(false, true);
        runRef.current = s.run;
        // The show only plays from the list; reduced motion goes straight to the piles.
        if (p && viewRef.current === "list" && !reducedRef.current) setPhase("lift");
        else {
          if (p && viewRef.current === "list") setView("piles");
          finale(s.run);
        }
      } catch {
        /* keep polling */
      } finally {
        waiting = false;
      }
    }, 200);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [sorting?.running, rpc, load]);

  // ---------- Reading pane ----------
  const bodies = useRef(new Map<string, InboxMessage | { error: string }>());
  const [, bump] = useState(0);
  useEffect(() => {
    if (!open || bodies.current.has(open.id)) return;
    let live = true;
    rpc.call("inbox_message", { account: open.account, id: open.id }).then(
      (m) => {
        bodies.current.set(open.id, m);
        if (live) bump((x) => x + 1);
      },
      (e) => {
        bodies.current.set(open.id, { error: e instanceof Error ? e.message : String(e) });
        if (live) bump((x) => x + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [open, rpc]);
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpenId(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const hand = (m: InboxPageItem) =>
    void spawn(m.id, `Reply: ${m.subject}`, replyPrompt({ account: m.account, from: m.from, subject: m.subject, id: m.id, threadId: m.threadId, venture: m.pile ? PILES[m.pile].label : null }));

  // ---------- Render ----------
  const isRunning = !!sorting?.running;
  const progress = sorting ? (sorting.count ? (sorting.remembered + sorting.done) / sorting.count : 1) : 0;
  const counter = sorting ? sorting.remembered + sorting.done : sortedAll;
  const lastRun = justRan ?? page?.lastRun ?? null;

  const celebrate = !reduced && Date.now() - finaleAt < 2500;
  let headline: ReactNode;
  let subline: string;
  if (!page) {
    headline = <>Reading your inboxes…</>;
    subline = "Three Gmail accounts, the last 7 days. The first read takes about ten seconds.";
  } else if (sorting && !sorting.running) {
    headline = (
      <>
        Jev has answered all <b style={tnum}>{sorting.count}</b>. Into the piles…
      </>
    );
    subline = "Every email goes to its bucket";
  } else if (sorting) {
    headline = (
      <>
        Jev is sorting <b style={tnum}>{sorting.count}</b> emails
      </>
    );
    subline = `Eight at a time${sorting.remembered ? `, ${sorting.remembered} remembered from earlier sorts` : ""}.`;
  } else if (justRan) {
    headline = (
      <>
        <b style={tnum}>{justRan.count}</b> emails sorted in{" "}
        <b>
          <NumUp key={`t${finaleAt}`} value={justRan.wallMs} fmt={secs} play={celebrate} />
        </b>{" "}
        for{" "}
        <b>
          <NumUp key={`c${finaleAt}`} value={justRan.costUsd} fmt={usd} play={celebrate} />
        </b>
        .
      </>
    );
    subline = `Tap any email to see why Jev put it there. ${justRan.fresh} new, ${justRan.remembered} remembered${justRan.model ? `, ${justRan.model}` : ""}.`;
  } else if (unsortedAll > 0) {
    headline = today ? (
      <>
        <b style={tnum}>{today}</b> new {today === 1 ? "email" : "emails"} since this morning.
      </>
    ) : (
      <>
        <b style={tnum}>{all.length}</b> emails in the last {days} days.
      </>
    );
    subline = `One tap and Jev puts every email in the right pile.${lastRun ? ` Last sort ${ago(lastRun.at)}: ${lastRun.count} emails in ${secs(lastRun.wallMs)} for ${usd(lastRun.costUsd)}.` : ""}`;
  } else {
    headline = (
      <>
        All <b style={tnum}>{sortedAll}</b> emails are in their piles.
      </>
    );
    subline = lastRun
      ? `Last sort ${ago(lastRun.at)}: ${lastRun.count} emails in ${secs(lastRun.wallMs)} for ${usd(lastRun.costUsd)} (${lastRun.fresh} new, ${lastRun.remembered} remembered). Tap any email to see why.`
      : "Tap any email to see why Jev put it there";
  }

  const pileTotal = (k: string) => (k === "unsorted" ? counts.unsorted : counts.piles[k as PileId] ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      {/* Header bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <BrandIcon platform="gmail" size={22} />
        <h1 className="text-[15px] font-medium tracking-tight">Inbox</h1>
        <div className="ml-3 flex items-center gap-0.5 rounded-lg border border-border p-0.5 text-[12px]" role="tablist" aria-label="Account">
          {["all", ...(page?.accounts.map((a) => a.email) ?? [])].map((a) => {
            const on = account === a;
            const n = a === "all" ? all.length : page?.accounts.find((x) => x.email === a)?.inbox ?? 0;
            return (
              <button
                key={a}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setAccount(a)}
                className={cn("rounded-md px-2.5 py-1 transition-colors", on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
                title={a === "all" ? "All accounts" : a}
              >
                {a === "all" ? "All" : accountLabel(a)} <span className="text-muted-foreground" style={tnum}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[12px]">
          <select
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value) as Days);
              setView("list");
              setJustRan(null);
            }}
            disabled={isRunning}
            className={`${field}`}
            aria-label="Range"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <button type="button" disabled={loading || isRunning} onClick={() => void load(true)} className="rounded-md border border-border px-2.5 py-1 text-muted-foreground hover:text-foreground disabled:opacity-50">
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </header>

      {/* Jev banner */}
      <section className="relative mx-4 mt-3 shrink-0 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-3.5 px-4 py-3">
          <JevMark busy={isRunning} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] text-foreground [&_b]:font-medium">{headline}</div>
            <div className="truncate text-[12px] text-muted-foreground" style={tnum}>
              {subline}
            </div>
          </div>
          <button
            type="button"
            disabled={!page || !!sorting || phase !== "idle" || all.length === 0}
            onClick={() => void sort(false)}
            className={cn(
              "inline-flex h-8 min-w-[176px] items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium transition-[background-color,border-color,color] duration-200",
              sorting ? "border border-border text-foreground" : "bg-primary text-primary-foreground disabled:opacity-50",
            )}
                      >
            {sorting ? (
              <>
                <Lattice cell={3} gap={1.4} label="Sorting" />
                <span style={tnum}>
                  Sorting {counter} of {sorting?.count ?? 0}
                </span>
              </>
            ) : unsortedAll > 0 && sortedAll > 0 ? (
              `Sort ${unsortedAll} new with Jev`
            ) : (
              "Sort with Jev"
            )}
          </button>
          <div className="w-[76px] border-l border-border pl-4 text-right">
            <div className="text-[22px] font-medium leading-none text-foreground">
              <Ticker value={counter} reduced={reduced} />
            </div>
            <div className={cn(caps, "mt-1 text-[11px]")}>sorted</div>
          </div>
        </div>
        {celebrate && justRan ? (
          <div
            key={finaleAt}
            aria-hidden
            className="nav-inbox-shimmer pointer-events-none absolute inset-y-0 left-0 w-1/3"
            style={{ background: tint("var(--foreground)", 6) }}
          />
        ) : null}
        {/* Progress line in the live colour while Jev works */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden" style={{ opacity: sorting ? 1 : 0, transition: "opacity 420ms ease 200ms" }}>
          <div className="h-full origin-left" style={{ background: LIVE, transform: `scaleX(${progress})`, transition: "transform 220ms cubic-bezier(.16,1,.3,1)" }} />
                  </div>
      </section>

      {page?.error ? <div className="mx-4 mt-2 rounded-md border border-destructive/50 px-3 py-2 text-[12px] text-destructive-text">{page.error}</div> : null}
      {page && !page.configured ? (
        <div className="mx-4 mt-2 text-[13px] text-muted-foreground">Mail comes through Composio. Add COMPOSIO_API_KEY to ~/.config/navaigate/composio.env.</div>
      ) : null}

      <div className="mt-3 flex min-h-0 flex-1 border-t border-border">
        {/* Left rail */}
        <nav className="w-[212px] shrink-0 overflow-y-auto border-r border-border px-2 py-3 text-[13px]" aria-label="Folders and piles">
          {(
            [
              ["inbox", "Inbox", inbox.length],
              ["starred", "Starred", counts.starred],
              ["sent", "Sent", counts.sent],
            ] as const
          ).map(([f, label, n]) => (
            <RailItem key={f} label={label} count={n} on={folder === f && !filter} onClick={() => (setFolder(f), setFilter(null))} />
          ))}
          <div className={cn(caps, "mb-1.5 mt-5 px-2.5 text-[11px]")}>Jev piles</div>
          {PILE_IDS.map((p) => (
            <RailItem key={p} label={PILES[p].label} count={counts.piles[p]} dot={PILES[p].color} on={folder === "inbox" && filter === p} onClick={() => (setFolder("inbox"), setFilter(filter === p ? null : p))} />
          ))}
          {counts.unsorted && sortedAll ? <RailItem label="Not sorted yet" count={counts.unsorted} dot="transparent" on={filter === "unsorted"} onClick={() => (setFolder("inbox"), setFilter(filter === "unsorted" ? null : "unsorted"))} /> : null}
        </nav>

        {/* List or piles */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-4 text-[12px]">
            <span className="font-medium text-foreground">{filter ? (filter === "unsorted" ? "Not sorted yet" : PILES[filter].label) : folder === "inbox" ? "Inbox" : folder === "starred" ? "Starred" : "Sent"}</span>
            <span className="text-muted-foreground" style={tnum}>
              {shown.length}
            </span>
            {filter ? (
              <button type="button" onClick={() => setFilter(null)} className="text-muted-foreground hover:text-foreground">
                Show all
              </button>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const on = !sound;
                  setSound(on);
                  try {
                    localStorage.setItem("navaigate-inbox-sound", on ? "on" : "off");
                  } catch {
                    /* private mode */
                  }
                }}
                aria-pressed={sound}
                className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground"
                title="A soft do-do-do as the emails fly"
              >
                Sound {sound ? "on" : "off"}
              </button>
              <button
                type="button"
                disabled={!!sorting || phase !== "idle" || !sortedAll}
                onClick={() => void sort(true)}
                className="rounded-md px-2 py-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                title="Forget every pile and ask Jev about every email again"
              >
                Re-sort all
              </button>
              <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5" role="tablist" aria-label="View">
                {(["list", "piles"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    disabled={v === "piles" && folder !== "inbox"}
                    onClick={() => switchView(v)}
                    className={cn("rounded-md px-2.5 py-0.5 capitalize transition-colors disabled:opacity-40", view === v ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
            {!page ? (
              <Skeleton />
            ) : shown.length === 0 ? (
              <div className="px-6 py-10 text-[13px] text-muted-foreground">{folder === "sent" ? "Nothing sent in this range" : folder === "starred" ? "No starred mail in this range" : "Nothing here"}</div>
            ) : view === "list" || folder !== "inbox" ? (
              <div key="list">
                {shown.map((m) => (
                  <ListRow key={m.id} m={m} open={openId === m.id} onOpen={() => setOpenId(m.id)} />
                ))}
              </div>
            ) : (
              <div key="piles" className="grid items-start gap-3 p-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(268px, 1fr))" }}>
                {groups.map(({ key, rows }) => (
                  <PileCard
                    key={key}
                    id={key}
                    rows={rows}
                    total={filter ? rows.length : pileTotal(key)}
                    expanded={expanded.has(key) || !!filter}
                    onExpand={() => setExpanded((s) => new Set(s).add(key))}
                    openId={openId}
                    onOpen={setOpenId}
                    launching={launching}
                  />
                ))}
              </div>
            )}
          </div>
        </main>

        {open ? <Reader m={open} body={bodies.current.get(open.id) ?? null} onClose={() => setOpenId(null)} onHand={() => hand(open)} handing={busy === open.id} canHand={ready && !busy} reduced={reduced} /> : null}
      </div>
    </div>
  );
}

function RailItem({ label, count, on, dot, onClick }: { label: string; count: number; on: boolean; dot?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on || undefined}
      className={cn("relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-[6px] text-left transition-colors", on ? "bg-muted font-medium text-foreground" : "text-foreground hover:bg-muted/50")}
    >
      {on ? <span aria-hidden className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-foreground" /> : null}
      {dot ? <span aria-hidden className="size-[8px] shrink-0 rounded-full border" style={{ background: dot, borderColor: dot === "transparent" ? "var(--muted-foreground)" : dot }} /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-[12px] text-muted-foreground" style={tnum}>
        {count}
      </span>
    </button>
  );
}

function activate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

function ListRow({ m, open, onOpen }: { m: InboxPageItem; open: boolean; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-flip={m.id}
      onClick={onOpen}
      onKeyDown={activate(onOpen)}
      className={cn(
        "relative grid w-full cursor-pointer grid-cols-[16px_30px_minmax(130px,200px)_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 bg-background px-4 py-2 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/60",
        open && "bg-muted/70",
      )}
    >
      {open ? <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-foreground" /> : null}
      <span className="text-muted-foreground">
        <Star on={m.starred} />
      </span>
      <Avatar from={m.from} />
      <div className="min-w-0">
        <div className={cn("truncate text-[13px]", m.unread ? "font-medium text-foreground" : "text-foreground")}>{m.folder === "sent" ? `To: ${senderName(m.to)}` : senderName(m.from)}</div>
        <div className="truncate text-[11px] text-muted-foreground">{orgOf(m.folder === "sent" ? m.to : m.from)}</div>
      </div>
      <div className="min-w-0 truncate text-[13px]">
        <span className={cn(m.unread ? "font-medium text-foreground" : "font-medium text-foreground")}>{m.subject}</span>
        <span className="text-muted-foreground"> · {m.snippet}</span>
      </div>
      <div className="flex items-center gap-2.5 pl-2">
        <span data-dot aria-label={m.pile ? PILES[m.pile].label : undefined} title={m.pile ? PILES[m.pile].label : undefined} className="size-2 rounded-full" style={m.pile ? { background: PILES[m.pile].color } : undefined} />
        <span className="w-[62px] text-right text-[12px] text-muted-foreground" style={tnum}>
          {when(m.receivedAt)}
        </span>
      </div>
    </div>
  );
}

function PileCard({
  id,
  rows,
  total,
  expanded,
  onExpand,
  openId,
  onOpen,
  launching,
}: {
  launching: boolean;
  id: string;
  rows: InboxPageItem[];
  total: number;
  expanded: boolean;
  onExpand: () => void;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const meta = id === "unsorted" ? { label: "Not sorted yet", color: "#8e8e96" } : PILES[id as PileId];
  const sure = rows.filter((r) => r.sure !== null);
  const mean = sure.length ? sure.reduce((a, r) => a + (r.sure ?? 0), 0) / sure.length : null;
  const visible = expanded ? rows : rows.slice(0, CARD_ROWS);
  return (
    <section data-card={id} className="relative rounded-xl" aria-label={meta.label}>
      <div
        data-card-bg
        aria-hidden
        className="absolute inset-0 rounded-xl border border-border bg-card"
        style={{ zIndex: 0, backgroundImage: `linear-gradient(to bottom, ${tint(meta.color, 16)} 0, ${tint(meta.color, 16)} 46px, transparent 46px)`, borderTop: `2px solid ${meta.color}` }}
      />
      <header data-card-head className="relative z-[1] flex h-[46px] items-center gap-2 px-3.5">
        <span aria-hidden className="size-[8px] shrink-0 rounded-full" style={{ background: meta.color }} />
        <span className="truncate text-[13px] font-medium text-foreground">{meta.label}</span>
        <Count value={total} className="ml-auto text-[13px] font-medium text-foreground" />
        {mean !== null ? (
          <span data-sure className={cn("text-[11px] text-muted-foreground", launching && "opacity-0")} style={tnum}>
            {pct(mean)} sure
          </span>
        ) : null}
      </header>
      <div className="relative z-[1] pb-1.5">
        {rows.length === 0 ? <div className="px-3.5 py-2 text-[12px] text-muted-foreground">Nobody is waiting on you today</div> : null}
        {visible.map((m) => (
          <div
            key={m.id}
            role="button"
            tabIndex={0}
            data-flip={m.id}
            onClick={() => onOpen(m.id)}
            onKeyDown={activate(() => onOpen(m.id))}
            className={cn("relative z-[1] grid cursor-pointer grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3.5 py-1.5 outline-none hover:bg-muted/50 focus-visible:bg-muted/60", openId === m.id && "bg-muted/70")}
          >
            <Avatar from={m.from} size={24} />
            <div className="min-w-0">
              <div className={cn("truncate text-[12px]", m.unread ? "font-medium text-foreground" : "font-medium text-foreground")}>{senderName(m.from)}</div>
              <div className="truncate text-[12px] text-muted-foreground">{m.subject}</div>
            </div>
            {m.sure !== null ? (
              <span data-chip className={cn("rounded-full px-1.5 py-[1px] text-[11px] font-medium text-foreground", launching && "opacity-0")} style={{ ...tnum, background: tint(meta.color, 22) }}>
                {pct(m.sure)}
              </span>
            ) : null}
          </div>
        ))}
        {!expanded && rows.length > CARD_ROWS ? (
          <button type="button" onClick={onExpand} className={cn("mx-3.5 mt-0.5 text-[12px] text-muted-foreground hover:text-foreground", launching && "invisible")} style={tnum}>
            +{rows.length - CARD_ROWS} more
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Bar({ value, color, label, note }: { value: number; color: string; label: string; note?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_92px_38px] items-center gap-2 text-[12px]">
      <span className="truncate text-foreground" title={note}>
        {label}
      </span>
      <span className="h-[5px] overflow-hidden rounded-full bg-muted">
        <span className="block h-full origin-left rounded-full" style={{ background: color, transform: `scaleX(${Math.max(0.02, value)})` }} />
      </span>
      <span className="text-right text-muted-foreground" style={tnum}>
        {pct(value)}
      </span>
    </div>
  );
}

function Reader({
  m,
  body,
  onClose,
  onHand,
  handing,
  canHand,
  reduced,
}: {
  m: InboxPageItem;
  body: InboxMessage | { error: string } | null;
  onClose: () => void;
  onHand: () => void;
  handing: boolean;
  canHand: boolean;
  reduced: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (reduced || !ref.current) return;
    ref.current.animate([{ transform: "translateX(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 260, easing: SOFT });
  }, [reduced]);
  const j = m.jev;
  const meta = m.pile ? PILES[m.pile] : null;
  const top = j
    ? Object.entries(j.probs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
    : [];
  const level = j ? Math.max(0, Math.min(3, Math.round(j.urgency))) : 0;
  return (
    <aside ref={ref} className="flex w-[min(460px,42%)] shrink-0 flex-col border-l border-border bg-card/40" aria-label="Email">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <Avatar from={m.from} size={34} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium leading-snug text-foreground">{m.subject}</div>
          <div className="mt-0.5 truncate text-[12px] text-foreground">{m.from}</div>
          <div className="truncate text-[11px] text-muted-foreground" style={tnum}>
            To {m.account} · {new Date(m.receivedAt).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-0.5 text-[16px] leading-none text-muted-foreground hover:text-foreground" aria-label="Close">
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {m.folder === "inbox" ? (
          <div className="mx-4 mt-3 rounded-lg border border-border bg-background/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <JevMark size={18} />
              <span className={cn(caps, "text-[11px]")}>Why Jev put it here</span>
              {meta ? (
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-[1px] text-[11px] font-medium text-foreground" style={{ background: tint(meta.color, 22) }}>
                  {meta.label} <span style={tnum}>{m.sure !== null ? pct(m.sure) : ""}</span>
                </span>
              ) : null}
            </div>
            {!j ? (
              <div className="text-[12px] text-muted-foreground">Not sorted yet. Press Sort with Jev.</div>
            ) : (
              <div className="space-y-2.5">
                {m.byRule ? (
                  <div className="text-[12px] leading-snug text-foreground">
                    Reply today is a rule, not a guess: a person asks you for something ({pct(j.needsReply)}, needs {pct(REPLY_RULE.needsReply)}), they wrote it themselves ({pct(j.fromPerson)}, needs {pct(REPLY_RULE.fromPerson)}), and it is soon ({URGENCY_LEVELS[level].toLowerCase()}).
                  </div>
                ) : null}
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">Which pile is this?</div>
                  <div className="space-y-1">
                    {top.map(([k, v]) => (
                      <Bar key={k} label={PILES[k as PileId]?.label ?? k} value={v} color={PILES[k as PileId]?.color ?? "#8e8e96"} />
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="mb-1 text-[11px] text-muted-foreground">The questions behind Reply today</div>
                  <Bar label="Does it ask you to answer or act?" value={j.needsReply} color="var(--foreground)" />
                  <Bar label="Did a person write it?" value={j.fromPerson} color="var(--foreground)" />
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">How soon do they need you?</div>
                  <div className="space-y-1">
                    {URGENCY_LEVELS.map((l, i) => (
                      <Bar key={l} label={l} value={j.urgencyProbs[i] ?? 0} color={i === level ? "var(--foreground)" : "var(--muted-foreground)"} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : null}

        <div className="flex gap-2 px-4 pt-3">
          <button type="button" disabled={!canHand} onClick={onHand} className="rounded-full bg-primary px-4 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-50">
            {handing ? "Starting…" : "Hand to agent"}
          </button>
          <a href={m.link} target="_blank" rel="noopener noreferrer" className="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground">
            Open in Gmail
          </a>
          <span className="ml-auto self-center text-[11px] text-muted-foreground">Drafts only, never sends</span>
        </div>

        <div className="px-4 pb-6 pt-4">
          {!body ? (
            <div className="space-y-2">
              {[92, 80, 86, 60].map((w) => (
                <div key={w} className="h-2.5 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : "error" in body ? (
            <div className="text-[12px] text-destructive-text">Could not fetch this email: {body.error}</div>
          ) : (
            <>
              <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">{body.text || m.snippet}</div>
              {body.truncated ? <div className="mt-3 text-[11px] text-muted-foreground">Long email: the rest is in Gmail.</div> : null}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function Skeleton() {
  return (
    <div className="divide-y divide-border/60">
      {Array.from({ length: 9 }, (_x, i) => (
        <div key={i} className="grid grid-cols-[16px_30px_180px_minmax(0,1fr)_60px] items-center gap-3 px-4 py-2.5">
          <span />
          <span className="size-[30px] animate-pulse rounded-full bg-muted" />
          <span className="h-2.5 animate-pulse rounded bg-muted" />
          <span className="h-2.5 animate-pulse rounded bg-muted" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
          <span className="h-2.5 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

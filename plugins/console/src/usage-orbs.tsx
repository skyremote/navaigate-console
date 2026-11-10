// Home's "Usage" card: one glass sphere of liquid for each subscription
// (Claude, Codex, Cursor), filled to what is left or what is used. Crossing a
// sphere with the pointer tilts the liquid; a press sloshes it. A subscription
// that is being used now burns, with flames scaled to its burn rate. Hover,
// focus or tap a sphere and the panel under the row gives its burn rate, when
// it runs out at that rate, and every window it has.
//
// The drawing is in usage-orb-engine.ts (plain canvas) and the numbers in
// usage-orbs-model.ts. This file is layout, pointer handling and words.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Trend } from "../server-usage-trend";
import { Card, CountUp, Heading, Meter, Segmented, prefersReducedMotion, tileCls } from "./home-kit";
import { LIVE, ago, caps, display, tnum } from "./shared";
import { ORB_CENTRE_Y, lightness, mountOrb, toRgb, type OrbHandle, type OrbLook, type Rgb } from "./usage-orb-engine";
import { hottest, usageOrbs, type OrbWindow, type UsageOrb } from "./usage-orbs-model";
import { machineName } from "./words";

type Mode = "left" | "used";
const MODE_KEY = "nav-skin:usage-orbs-mode";

/** Liquid colours: each harness's own, which a theme can replace through the variable. */
const LIQUID: Record<string, { css: string; fallback: Rgb }> = {
  claude: { css: "var(--nav-orb-claude, #d97757)", fallback: [217, 119, 87] },
  codex: { css: "var(--nav-orb-codex, #12a594)", fallback: [18, 165, 148] },
  cursor: { css: "var(--nav-orb-cursor, #4f7cff)", fallback: [79, 124, 255] },
  other: { css: "var(--nav-orb-other, #8b8f98)", fallback: [139, 143, 152] },
};

type Palette = { ink: Rgb; dark: boolean; liquid: Record<string, Rgb> };
const FALLBACK: Palette = { ink: [20, 20, 22], dark: false, liquid: Object.fromEntries(Object.entries(LIQUID).map(([k, v]) => [k, v.fallback])) };

/** The theme's colours as numbers for the canvas, read again when the theme changes. */
function usePalette(): [Palette, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [palette, setPalette] = useState<Palette>(FALLBACK);
  useEffect(() => {
    if (!el) return;
    const read = () => {
      const resolve = (css: string, fallback: Rgb): Rgb => {
        el.style.color = css;
        return toRgb(getComputedStyle(el).color, fallback);
      };
      const ink = resolve("var(--foreground)", FALLBACK.ink);
      const next: Palette = { ink, dark: lightness(ink) > 0.6, liquid: Object.fromEntries(Object.entries(LIQUID).map(([k, v]) => [k, resolve(v.css, v.fallback)])) };
      setPalette((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    read();
    const root = document.documentElement;
    const observer = typeof MutationObserver === "function" ? new MutationObserver(read) : null;
    observer?.observe(root, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const scheme = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    scheme?.addEventListener?.("change", read);
    return () => {
      observer?.disconnect();
      scheme?.removeEventListener?.("change", read);
    };
  }, [el]);
  return [palette, setEl];
}

/* -------------------------------- words -------------------------------- */

const rate = (b: number) => `${b === 0 ? "0" : b.toFixed(b < 10 ? 1 : 0)}%`;
const clock = (ms: number) => new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)} days`;
}
/** Plan and account; a reading with no account name is told apart by its machine. */
const whoOf = (o: UsageOrb) => [o.plan, o.who ?? o.machines.map(machineName).join(" + ")].filter(Boolean).join(" · ");
const fireText = (dark: boolean) => (dark ? "#ff9a3d" : "#c2410c");

function spoken(o: UsageOrb, mode: Mode): string {
  const level = mode === "left" ? `${Math.round(o.left)}% of the ${o.period} left` : `${Math.round(o.used)}% of the ${o.period} used`;
  const burn = o.state !== "current" ? "reading not current" : o.burn === null ? "burn rate not measured yet" : o.burn > 0 ? `burning ${rate(o.burn)} an hour` : "not burning";
  return `${o.name}${whoOf(o) ? `, ${whoOf(o)}` : ""}: ${level}, ${burn}`;
}

function Flame({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className} fill="currentColor">
      <path d="M8 1.5c.6 2.2-.4 3.4-1.5 4.6-1.1 1.2-2 2.3-2 4.1a3.5 3.5 0 0 0 7 0c0-1.4-.6-2.4-1.3-3.3-.2.9-.6 1.4-1.2 1.7.4-2.2.1-5-1-7.1Z" />
    </svg>
  );
}

/* ------------------------------- one sphere ------------------------------ */

/** Whether the reader asks for reduced motion, followed while the page is open. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const query = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (!query?.addEventListener) return;
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

function Sphere({ orb, mode, palette, working, on, picked, onPick, onHover, icon }: {
  orb: UsageOrb;
  mode: Mode;
  palette: Palette;
  working: boolean;
  /** The readout describes this sphere. */
  on: boolean;
  /** The reader pressed this sphere to keep its readout. */
  picked: boolean;
  onPick: () => void;
  onHover: (inside: boolean) => void;
  icon?: (brand: string) => ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<OrbHandle | null>(null);
  const lastX = useRef<number | null>(null);
  const touched = useRef(false);
  const reduced = useReducedMotion();
  const current = orb.state === "current";
  const liquid = palette.liquid[orb.brand] ?? palette.liquid.other;
  const look: OrbLook = {
    level: (mode === "left" ? orb.left : orb.used) / 100,
    liquid,
    ink: palette.ink,
    dark: palette.dark,
    heat: orb.heat,
    bubbles: working && current,
  };
  const lookRef = useRef(look);
  lookRef.current = look;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const h = mountOrb(el, lookRef.current, { still: prefersReducedMotion() });
    handle.current = h;
    const observer = h && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => h.resize()) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      h?.destroy();
      handle.current = null;
    };
  }, []);
  useEffect(() => {
    handle.current?.setStill(reduced);
  }, [reduced]);
  useEffect(() => {
    handle.current?.set(lookRef.current);
  }, [look.level, look.heat, look.bubbles, look.dark, liquid.join(","), palette.ink.join(",")]);

  const figure = Math.round(mode === "left" ? orb.left : orb.used);
  const halo = "0 0 10px var(--card), 0 0 4px var(--card), 0 1px 2px var(--card)";
  return (
    <button
      type="button"
      data-nav-part="usage-orb"
      data-orb={orb.id}
      data-brand={orb.brand}
      data-burning={orb.heat > 0 ? "true" : "false"}
      aria-pressed={picked}
      aria-label={spoken(orb, mode)}
      onClick={(e) => {
        // On a touch screen the sphere keeps focus after a tap, which would keep its readout: a second tap lets go of both.
        // A click made from the keyboard (detail 0) keeps its focus.
        if (picked && touched.current && e.detail !== 0) e.currentTarget.blur();
        onPick();
      }}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      onPointerEnter={(e) => {
        lastX.current = e.clientX;
        if (e.pointerType === "mouse") {
          onHover(true);
          handle.current?.sweep();
        }
      }}
      onPointerMove={(e) => {
        if (lastX.current !== null) handle.current?.nudge(e.clientX - lastX.current);
        lastX.current = e.clientX;
      }}
      onPointerLeave={(e) => {
        lastX.current = null;
        if (e.pointerType === "mouse") onHover(false);
      }}
      onPointerDown={(e) => {
        touched.current = e.pointerType !== "mouse";
        const box = e.currentTarget.getBoundingClientRect();
        handle.current?.tap(box.width ? ((e.clientX - box.left) / box.width) * 2 - 1 : 0);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handle.current?.tap(0.4);
      }}
      className={cn("group relative flex min-w-0 flex-col items-center rounded-[12px] px-1 pb-2 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring", on ? "bg-[var(--surface-selected,var(--muted))]" : null)}
      style={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
    >
      <span className="relative block aspect-square w-full max-w-[176px]" style={{ opacity: current ? 1 : 0.55 }}>
        <canvas ref={canvas} aria-hidden className="block size-full" />
        <span className="pointer-events-none absolute inset-x-0 flex -translate-y-1/2 flex-col items-center" style={{ top: `${ORB_CENTRE_Y * 100}%` }}>
          <span className="text-[26px] font-medium leading-none tracking-[-0.02em] text-foreground" style={{ ...display, ...tnum, textShadow: halo }}>{figure}%</span>
          <span className="mt-0.5 text-[11px] font-medium text-foreground" style={{ textShadow: halo }}>{mode}</span>
        </span>
      </span>
      <span className="mt-0.5 inline-flex max-w-full items-center gap-1.5 text-[13px] font-medium text-foreground">
        {icon?.(orb.brand)}
        <span className="truncate">{orb.name}</span>
      </span>
      <span className="block max-w-full truncate text-[11px] text-muted-foreground">{whoOf(orb) || orb.machines.map(machineName).join(" + ")}</span>
      {orb.heat > 0 && orb.burn !== null ? (
        <span data-nav-part="orb-burn" className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-medium" style={{ ...tnum, color: fireText(palette.dark) }}>
          <Flame className="size-3" />{rate(orb.burn)} an hour
        </span>
      ) : (
        <span className="mt-0.5 block max-w-full truncate text-[12px] text-muted-foreground" style={working && current ? { color: LIVE } : undefined}>
          {!current ? (orb.state === "retained" ? "Last reading kept" : "Unavailable") : working ? "Working now" : orb.burn === null ? "No burn rate yet" : "Not burning"}
        </span>
      )}
    </button>
  );
}

/* ------------------------------ the readout ------------------------------ */

function WindowRow({ w, mode, dark, now }: { w: OrbWindow; mode: Mode; dark: boolean; now: number }) {
  const burning = w.burn !== null && w.burn > 0;
  return (
    <div data-nav-part="orb-window" className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-border py-1.5 text-[12px] first:border-t-0" style={tnum}>
      <span className="min-w-0">
        <span className="block truncate text-foreground">{w.label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{w.resetsAt !== null && w.resetsAt > now ? `resets in ${span(w.resetsAt - now)}` : "not open"}</span>
      </span>
      <span className="min-w-0">
        <Meter value={(mode === "left" ? w.left : w.used) / 100} label={`${w.label}: ${Math.round(mode === "left" ? w.left : w.used)}% ${mode}`} className="bg-background" color={w.left <= 15 ? "var(--destructive-text)" : "var(--foreground)"} />
        <span className="mt-1 block text-[11px] text-muted-foreground">{Math.round(mode === "left" ? w.left : w.used)}% {mode}</span>
      </span>
      <span className="text-right" style={burning ? { color: fireText(dark) } : undefined}>
        <span className={burning ? "font-medium" : "text-muted-foreground"}>{w.burn === null ? "–" : `${rate(w.burn)}/h`}</span>
      </span>
    </div>
  );
}

function Readout({ orb, mode, dark, now }: { orb: UsageOrb; mode: Mode; dark: boolean; now: number }) {
  const hot = orb.hot;
  const first = orb.first;
  const current = orb.state === "current";
  const where = orb.machines.map(machineName).join(" + ");
  return (
    <div data-nav-part="orb-readout" data-orb={orb.id} className={cn(tileCls, "grid gap-x-6 gap-y-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]")}>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-foreground">{orb.name}{orb.plan ? ` ${orb.plan}` : ""}<span className="font-normal text-muted-foreground">{[orb.who, where].filter(Boolean).map((x) => ` · ${x}`).join("")}</span></div>
        <div className="mt-2.5 grid grid-cols-2 gap-x-4">
          <div className="min-w-0">
            <div className={caps}>Burn rate</div>
            <div data-nav-part="orb-rate" className="mt-0.5 text-[22px] font-medium leading-7 tracking-[-0.01em] text-foreground" style={{ ...display, ...tnum, ...(hot ? { color: fireText(dark) } : null) }}>
              {!current ? "Unavailable" : orb.burn === null ? "Collecting" : <>{rate(orb.burn)}<span className="ml-1.5 text-[13px] font-normal tracking-normal">an hour</span></>}
            </div>
            <div className="text-[11px] text-muted-foreground">{!current ? "The last reading is kept" : orb.burn === null ? "Needs 30 minutes of readings" : hot ? `${hot.label}, last 30 minutes` : "Nothing used in the last 30 minutes"}</div>
          </div>
          <div className="min-w-0">
            <div className={caps}>{first ? "Runs out" : "At this rate"}</div>
            <div className="mt-0.5 text-[22px] font-medium leading-7 tracking-[-0.01em] text-foreground" style={{ ...display, ...tnum }}>
              {first?.runsOutAt != null ? `in ${span(first.runsOutAt - now)}` : hot ? "Lasts" : "–"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {first?.runsOutAt != null ? `${first.label}: ${clock(first.runsOutAt)}${first.resetsAt !== null ? `, before it resets ${clock(first.resetsAt)}` : ""}` : hot ? `until it resets${hot.resetsAt !== null ? ` ${clock(hot.resetsAt)}` : ""}` : orb.resetsAt !== null && orb.resetsAt > now ? `The ${orb.period} resets in ${span(orb.resetsAt - now)}` : "No open window"}
            </div>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">{orb.observedAt === null ? "No reading time" : ago(orb.observedAt, now) === "now" ? "Read just now" : `Read ${ago(orb.observedAt, now)} ago`}</div>
      </div>
      <div className="min-w-0">
        {orb.windows.map((w) => <WindowRow key={w.key} w={w} mode={mode} dark={dark} now={now} />)}
      </div>
    </div>
  );
}

/* -------------------------------- the card ------------------------------- */

export function UsageOrbsCard({ trend, workingBy, icon, i = 0 }: { trend: Trend | null; workingBy?: ReadonlySet<string>; icon?: (brand: string) => ReactNode; i?: number }) {
  const [palette, probe] = usePalette();
  const [mode, setMode] = useState<Mode>(() => (typeof localStorage !== "undefined" && localStorage.getItem(MODE_KEY) === "used" ? "used" : "left"));
  const [hovered, setHovered] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const orbs = useMemo(() => (trend ? usageOrbs(trend) : []), [trend]);
  const now = trend?.now ?? Date.now();
  const top = hottest(orbs);
  const shown = orbs.find((o) => o.id === hovered) ?? orbs.find((o) => o.id === picked) ?? top;
  const burning = orbs.filter((o) => o.heat > 0);
  const fastest = burning.length ? hottest(burning) : null;
  const changeMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  };
  return (
    <Card
      i={i}
      part="usage-orbs-card"
      label={
        <Heading
          label="Usage"
          figure={!trend ? undefined : fastest && fastest.burn !== null ? <span style={{ color: fireText(palette.dark) }}>{rate(fastest.burn)}</span> : <CountUp value={orbs.length} />}
          note={!trend ? undefined : fastest ? `an hour · ${fastest.name}${fastest.plan ? ` ${fastest.plan}` : ""} is burning${burning.length > 1 ? `, and ${burning.length - 1} more` : ""}` : `${orbs.length === 1 ? "subscription" : "subscriptions"} · nothing burning`}
        />
      }
      aside={orbs.length ? <Segmented size="sm" label="Show" value={mode} onChange={changeMode} options={[{ value: "left", label: "Left" }, { value: "used", label: "Used" }]} /> : null}
    >
      <span ref={probe} aria-hidden className="hidden" />
      {!trend ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">Reading your subscriptions</p>
      ) : orbs.length === 0 ? (
        <div className={cn(tileCls, "px-4 py-8 text-center text-[13px] text-muted-foreground")}>No readings yet. The plugin reads each subscription every few minutes.</div>
      ) : (
        <>
          <div data-nav-part="usage-orbs" className="grid gap-x-2 gap-y-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))" }}>
            {orbs.map((o) => (
              <Sphere
                key={o.id}
                orb={o}
                mode={mode}
                palette={palette}
                // bb knows which harness is working, not which account: with two Claude plans, only a lone or burning sphere can claim the work.
                working={!!workingBy?.has(o.brand) && (o.heat > 0 || orbs.filter((x) => x.brand === o.brand).length === 1)}
                on={shown?.id === o.id}
                picked={picked === o.id}
                onPick={() => setPicked((p) => (p === o.id ? null : o.id))}
                onHover={(inside) => setHovered((h) => (inside ? o.id : h === o.id ? null : h))}
                icon={icon}
              />
            ))}
          </div>
          {shown ? <Readout orb={shown} mode={mode} dark={palette.dark} now={now} /> : null}
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-border pt-2.5 text-[12px] text-muted-foreground">
            <span>Hover or tap a sphere for its burn rate. Touch the liquid and it moves.</span>
            <span>Flames grow with the burn rate</span>
          </div>
        </>
      )}
    </Card>
  );
}

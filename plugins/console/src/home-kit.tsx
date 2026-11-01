// Home kit: the card, figure, segmented control and charts shared by the Home
// page and the control room. One ease (the house expo-out), BoardUI-length
// durations, and everything still under prefers-reduced-motion. Only live
// things loop, and none of them live here.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { LIVE, caps, display, tnum } from "./shared";

export const EASE = "cubic-bezier(.16,1,.3,1)";

const CSS = `
@keyframes nav-hk-rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes nav-hk-fade { from { opacity: .35 } to { opacity: 1 } }
@keyframes nav-hk-bar { from { transform: scaleY(0) } to { transform: scaleY(1) } }
@keyframes nav-hk-grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
@keyframes nav-hk-wipe { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0 0 0 0) } }
@keyframes nav-hk-pop { from { opacity: 0; transform: scale(.5) } to { opacity: 1; transform: none } }
@keyframes nav-hk-row { from { opacity: 0; transform: translateY(-4px); filter: blur(2px) } to { opacity: 1; transform: none; filter: none } }
.nav-hk-rise { animation: nav-hk-rise 420ms ${EASE} both; animation-delay: calc(var(--nav-hk-i, 0) * 55ms) }
.nav-hk-fade { animation: nav-hk-fade 220ms ${EASE} }
.nav-hk-bar { transform-origin: bottom; animation: nav-hk-bar 360ms ${EASE} both }
.nav-hk-bar > i { display: block; width: 100%; height: 100%; border-radius: inherit; transform-origin: bottom; transition: transform 450ms ${EASE}, background-color 150ms ${EASE} }
.nav-hk-grow { transform-origin: left center; animation: nav-hk-grow 450ms ${EASE} both }
.nav-hk-meter > span { display: block; height: 100% }
.nav-hk-meter i { display: block; width: 100%; height: 100%; border-radius: inherit; transform-origin: left center; transition: transform 450ms ${EASE} }
.nav-hk-wipe { animation: nav-hk-wipe 900ms ${EASE} both }
.nav-hk-pop { animation: nav-hk-pop 380ms ${EASE} both }
.nav-hk-row { animation: nav-hk-row 240ms ${EASE} both }
.nav-hk-seg-ind { transition: transform 200ms ${EASE}, width 200ms ${EASE} }
.nav-hk-seg > button { transition: color 200ms ${EASE} }
.nav-hk-tile > button::after { content: ""; position: absolute; inset: 0; border-radius: inherit }
.nav-hk-tile:has(> button:focus-visible) { outline: 2px solid var(--ring); outline-offset: 1px }
.nav-hk-hover { transition: background-color 150ms ${EASE}, opacity 150ms ${EASE} }
@media (prefers-reduced-motion: reduce) {
  .nav-hk-rise, .nav-hk-fade, .nav-hk-bar, .nav-hk-grow, .nav-hk-wipe, .nav-hk-pop, .nav-hk-row { animation: none !important }
  .nav-hk-bar > i, .nav-hk-meter i, .nav-hk-seg-ind, .nav-hk-seg > button, .nav-hk-hover { transition: none !important }
}
`;

let injected = false;
export function ensureHomeKitStyle() {
  if (injected || typeof document === "undefined") return;
  if (!document.getElementById("nav-hk-style")) {
    const el = document.createElement("style");
    el.id = "nav-hk-style";
    el.textContent = CSS;
    document.head.appendChild(el);
  }
  injected = true;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A Home card: hairline, 14px radius, label row with an optional control on the right. */
export const cardCls = "rounded-[14px] border border-border bg-card";
/** A tile inside a card: the recessed wash, 10px radius, no border. */
export const tileCls = "rounded-[10px] bg-muted";

export function Card({ label, aside, children, i = 0, className, part }: { label?: ReactNode; aside?: ReactNode; children: ReactNode; i?: number; className?: string; part?: string }) {
  ensureHomeKitStyle();
  return (
    <section data-nav-part={part} className={cn(cardCls, "nav-hk-rise flex min-w-0 flex-col gap-4 px-4 pb-3 pt-4", className)} style={{ ["--nav-hk-i" as string]: i } as CSSProperties}>
      {label || aside ? (
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {label ? <div className="min-w-0">{label}</div> : <span />}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Wraps a card that draws its own section, so it joins the page's entrance. */
export function Reveal({ i, children, className }: { i: number; children: ReactNode; className?: string }) {
  ensureHomeKitStyle();
  return <div className={cn("nav-hk-rise min-w-0", className)} style={{ ["--nav-hk-i" as string]: i } as CSSProperties}>{children}</div>;
}

/** Card heading: a 13px label over a large figure. */
export function Heading({ label, figure, note }: { label: ReactNode; figure?: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className={caps}>{label}</div>
      {figure !== undefined ? (
        <div className="mt-1 flex min-w-0 items-baseline gap-2">
          <span className="text-[24px] font-medium leading-8 tracking-[-0.01em] text-foreground" style={{ ...display, ...tnum }}>{figure}</span>
          {note ? <span className="truncate text-[12px] text-muted-foreground" style={tnum}>{note}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A whole number that counts up from zero the first time it has a value
 * (data often arrives a moment after the card), then fades in place when it
 * changes (BoardUI's number fade). Screen readers get the final value only.
 */
export function CountUp({ value, format = (n) => n.toLocaleString("en-GB"), ms = 700 }: { value: number; format?: (n: number) => string; ms?: number }) {
  ensureHomeKitStyle();
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  const counted = useRef(false);
  const [fadeKey, setFadeKey] = useState(0);
  useEffect(() => {
    if (counted.current) {
      setShown(value);
      setFadeKey((k) => k + 1);
      return;
    }
    if (value === 0) {
      setShown(0);
      return;
    }
    counted.current = true;
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = () => {
      const p = Math.max(0, Math.min(1, (performance.now() - t0) / ms));
      const eased = 1 - Math.pow(2, -10 * p);
      setShown(p >= 1 ? value : Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return (
    <span data-nav-part="figure" className="relative inline-block" style={tnum}>
      <span className="sr-only">{format(value)}</span>
      <span aria-hidden key={fadeKey} className={fadeKey ? "nav-hk-fade" : undefined}>{format(shown)}</span>
    </span>
  );
}

/**
 * The position of a sliding indicator under the chosen child of `wrap`. It is
 * measured when `chosen` changes and when the container is resized, not after
 * every render.
 */
export function useSlideIndicator(wrap: RefObject<HTMLElement | null>, find: (root: HTMLElement) => HTMLElement | undefined, chosen: string | undefined): { x: number; w: number } | null {
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const finder = useRef(find);
  finder.current = find;
  const measure = useCallback(() => {
    const root = wrap.current;
    const el = root ? finder.current(root) : undefined;
    if (!el) return;
    const next = { x: el.offsetLeft, w: el.offsetWidth };
    setInd((prev) => (prev && prev.x === next.x && prev.w === next.w ? prev : next));
  }, [wrap]);
  useLayoutEffect(measure, [measure, chosen]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (wrap.current) observer?.observe(wrap.current);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure, wrap, chosen]);
  return ind;
}

/** A segmented control with one sliding indicator. Selection is ink on a raised chip. */
export function Segmented<T extends string>({ options, value, onChange, label, size = "md" }: { options: ReadonlyArray<{ value: T; label: ReactNode; title?: string; disabled?: boolean }>; value: T; onChange: (v: T) => void; label: string; size?: "sm" | "md" }) {
  ensureHomeKitStyle();
  const wrap = useRef<HTMLDivElement>(null);
  const ind = useSlideIndicator(wrap, (root) => Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-value]")).find((b) => b.dataset.value === value), value);
  return (
    <div ref={wrap} role="group" aria-label={label} data-nav-part="segmented" className="nav-hk-seg relative inline-flex shrink-0 items-center gap-0.5 rounded-[10px] bg-muted p-1">
      {ind ? <span aria-hidden className="nav-hk-seg-ind pointer-events-none absolute left-0 top-1 bottom-1 rounded-md bg-card shadow-sm ring-1 ring-border" style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} /> : null}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-value={o.value}
            aria-pressed={on}
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative z-10 inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
              size === "sm" ? "min-h-6 px-2 text-[12px]" : "min-h-7 px-2.5 text-[13px]",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              !ind && on ? "bg-card shadow-sm" : null,
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A horizontal meter: track in the wash, fill grows from the left. The entrance runs on the wrapper and value changes scale the fill, so the two never share a transform. */
export function Meter({ value, color = "var(--foreground)", label, className }: { value: number | null; color?: string; label: string; className?: string }) {
  ensureHomeKitStyle();
  const v = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(v * 100)} className={cn("nav-hk-meter block h-1.5 overflow-hidden rounded-full bg-muted", className)}>
      <span className="nav-hk-grow"><i style={{ transform: `scaleX(${v})`, background: value === null ? "transparent" : color }} /></span>
    </span>
  );
}

/**
 * Bars over full-height tracks (BoardUI's "earned" chart, in ink). Each bar
 * rises from the baseline on entry, staggered, on its outer element; its
 * height is an inner element scaled with transform, so a new value never
 * triggers layout. Hovering one lifts it and reports it through `onActive`.
 */
export function TrackBars({ bars, max = 100, height = 132, label, active, onActive, color = "var(--foreground)" }: {
  bars: Array<{ key: string; value: number; tick: string; title: string; color?: string }>;
  max?: number;
  height?: number;
  label: string;
  active: number | null;
  onActive: (i: number | null) => void;
  color?: string;
}) {
  ensureHomeKitStyle();
  return (
    <div data-nav-part="track-bars" role="img" aria-label={label} onMouseLeave={() => onActive(null)}>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {bars.map((b, i) => {
          const h = Math.max(0, Math.min(1, b.value / max));
          const on = active === i;
          const dim = active !== null && !on;
          return (
            <div key={b.key} title={b.title} onMouseEnter={() => onActive(i)} className="relative flex h-full min-w-0 flex-1 items-end rounded-full bg-muted">
              <span className="nav-hk-bar nav-hk-hover block h-full w-full rounded-full" style={{ opacity: dim ? 0.45 : 1, animationDelay: `${i * 28}ms` }}>
                <i style={{ transform: `scaleY(${Math.max(h, b.value > 0 ? 0.06 : 0)})`, background: b.color ?? color }} />
              </span>
              {on ? <span aria-hidden className="pointer-events-none absolute -inset-[3px] rounded-full ring-2 ring-foreground/25" /> : null}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-1.5 text-[11px] text-muted-foreground" style={tnum}>
        {bars.map((b, i) => (
          <span key={b.key} className={cn("min-w-0 flex-1 truncate text-center", active === i ? "text-foreground" : null)}>{b.tick}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * A line with a soft area under it on a 0 to 100 scale, wiped in from the left.
 * `domain` is the window's start and end, so the unused part of the window
 * stays visibly empty.
 */
export function AreaLine({ series, domain, height = 132, label, color = "var(--foreground)", marks = [] }: {
  series: Array<[number, number]>;
  domain: [number, number];
  height?: number;
  label: string;
  color?: string;
  marks?: number[];
}) {
  ensureHomeKitStyle();
  const W = 600;
  const id = `nav-hk-g${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [t0, t1] = domain;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => height - (Math.max(0, Math.min(100, v)) / 100) * (height - 4) - 2;
  const pts = series.filter(([t]) => t >= t0 && t <= t1);
  const line = pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = pts.length > 1 ? `${line} L${x(pts[pts.length - 1][0]).toFixed(1)},${height} L${x(pts[0][0]).toFixed(1)},${height} Z` : "";
  const last = pts[pts.length - 1];
  return (
    <svg data-nav-part="area-line" role="img" aria-label={label} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.16" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {marks.map((m) => (
        <line key={m} x1="0" x2={W} y1={y(m)} y2={y(m)} stroke="var(--border)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      ))}
      <line x1="0" x2={W} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
      <g className="nav-hk-wipe">
        {area ? <path d={area} fill={`url(#${id})`} /> : null}
        {line ? <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
        {last ? <line x1={x(last[0])} x2={x(last[0])} y1={y(last[1])} y2={y(last[1])} stroke={color} strokeWidth="7" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
      </g>
    </svg>
  );
}

/** A stable 0 to 799ms delay for a grid cell, so cells fizz in rather than sweep. */
export function cellDelay(col: number, row: number): number {
  let h = Math.imul(col + 1, 0x9e3779b1) ^ Math.imul(row + 1, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return ((h >>> 7) % 800 + 800) % 800;
}

/** The live colour for a figure only when something is live. */
export const liveIf = (on: boolean): CSSProperties | undefined => (on ? { color: LIVE } : undefined);

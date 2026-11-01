// Shared vocabulary for every NavAIgate Skin surface: harness names, thread
// state, the 6px run-sheet node, section labels and tabular figures. Colours come
// only from host tokens so the bundled theme (or any palette) drives them.
import type { CSSProperties, JSX } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/** The one live colour: running work, the Now line, the lattice. Selection is ink. */
export const LIVE = "var(--attention)";
export const caps = "text-[12px] font-medium text-muted-foreground";
export const tnum: CSSProperties = { fontVariantNumeric: "tabular-nums" };
/** Titles and large figures: the theme's display face where it has one (Inter Tight in NavAIgate). */
export const display: CSSProperties = { fontFamily: "var(--font-display, var(--font-sans))" };

/**
 * "Now · 3 cooking" as one inline run. The parts carry data-nav-part hooks so a
 * theme (Ember) can set the count as a large numeral; without a theme rule the
 * text reads and renders exactly as the single string did.
 */
export function NowHeadline({ prefix, count, word }: { prefix: string; count: number; word: string }) {
  return (
    <span data-nav-part="now-headline">
      <span data-nav-part="now-prefix">{`${prefix} · `}</span>
      {count > 0 ? <><span data-nav-part="now-count">{count}</span>{" "}</> : null}
      <span data-nav-part="now-word">{word}</span>
    </span>
  );
}

export type Harness = { key: string; label: string };

export function harnessOf(providerId: string): Harness {
  const id = providerId.toLowerCase();
  if (id.includes("claude")) return { key: "claude", label: "Claude" };
  if (id.includes("codex")) return { key: "codex", label: "Codex" };
  if (id.includes("cursor")) return { key: "cursor", label: "Cursor" };
  if (id === "pi" || id.startsWith("pi-") || id.endsWith("-pi")) return { key: "pi", label: "Pi" };
  const bare = id.replace(/^acp-/, "");
  return { key: bare, label: bare.charAt(0).toUpperCase() + bare.slice(1) };
}

export type State = "running" | "needs" | "unread" | "parked";

const NEEDS_INDICATORS = new Set(["waiting-for-input", "unread-error", "queued-failed"]);

export function stateOf(t: PluginSidebarThread): State {
  const a = t.activity;
  const busy =
    t.status === "active" ||
    t.status === "starting" ||
    t.status === "stopping" ||
    a.workflows + a.backgroundAgents + a.backgroundCommands > 0;
  if (busy) return "running";
  if (t.hasPendingInteraction || t.status === "error" || NEEDS_INDICATORS.has(t.indicator)) return "needs";
  if (t.isUnread) return "unread";
  return "parked";
}

export const RANK: Record<State, number> = { running: 0, needs: 1, unread: 2, parked: 3 };
export const byUrgencyThenRecent = (a: PluginSidebarThread, b: PluginSidebarThread) =>
  RANK[stateOf(a)] - RANK[stateOf(b)] || b.updatedAt - a.updatedAt;

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.round(d / 7)}w`;
}

/** The 6px square node from the run sheet. */
export function Node({ state, size = 6 }: { state: State; size?: number }) {
  const style: CSSProperties = { width: size, height: size };
  let dot: JSX.Element;
  if (state === "running") dot = <Lattice cell={size <= 6 ? 2.5 : 3} gap={1.2} label="Working" />;
  else if (state === "needs") dot = <span aria-hidden className="inline-block bg-destructive" style={style} />;
  else if (state === "unread") dot = <span aria-hidden className="inline-block bg-foreground" style={style} />;
  else dot = <span aria-hidden className="inline-block border border-muted-foreground/60 bg-background" style={style} />;
  // A fixed 10px box keeps titles aligned whether the node is a dot or a lattice.
  return <span className="inline-flex w-[11px] shrink-0 items-center justify-center">{dot}</span>;
}

export function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="inline-block size-[6px]" style={{ background: color }} />
      {label}
    </span>
  );
}

/* --------------------------------------------------------------------------
 * Lattice — a 3×3 dot grid that orbits while a thread is cooking.
 * Inspired by React Bits' LatticeLoader (orbit pattern): the eight outer cells
 * light in turn around an empty centre, each with a staggered delay, so the
 * glow travels round the ring. Pure CSS; respects reduced motion.
 * ------------------------------------------------------------------------ */

const ORBIT: Array<number | null> = [0, 1, 2, 7, null, 3, 6, 5, 4];
const LATTICE_CSS = `
@keyframes nav-ll-on { 0%, 100% { opacity: .16; transform: scale(.82); } 14%, 34% { opacity: 1; transform: scale(1); } 52% { opacity: .16; transform: scale(.82); } }
.nav-ll > i { animation: nav-ll-on var(--nav-ll-cycle) cubic-bezier(.16,1,.3,1) infinite; }
@media (prefers-reduced-motion: reduce) { .nav-ll > i { animation-duration: 2400ms; animation-delay: 0ms !important; transform: none !important; } }
`;

let latticeStyleInjected = false;
function ensureLatticeStyle() {
  if (latticeStyleInjected || typeof document === "undefined") return;
  if (document.getElementById("nav-ll-style")) {
    latticeStyleInjected = true;
    return;
  }
  const el = document.createElement("style");
  el.id = "nav-ll-style";
  el.textContent = LATTICE_CSS;
  document.head.appendChild(el);
  latticeStyleInjected = true;
}

export function Lattice({ cell = 2.5, gap = 1.5, step = 110, label }: { cell?: number; gap?: number; step?: number; label?: string }) {
  ensureLatticeStyle();
  const cycle = step * 8;
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="nav-ll inline-grid shrink-0"
      style={{ gridTemplateColumns: `repeat(3, ${cell}px)`, gap, ["--nav-ll-cycle" as string]: `${cycle}ms` }}
    >
      {ORBIT.map((n, i) =>
        n === null ? (
          <b key={i} style={{ width: cell, height: cell }} />
        ) : (
          <i
            key={i}
            className="block rounded-full"
            style={{ width: cell, height: cell, background: LIVE, animationDelay: `${n * step}ms` }}
          />
        ),
      )}
    </span>
  );
}

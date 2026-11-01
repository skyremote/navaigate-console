// StatusMark — after React Bits' StatusMark, rebuilt as pure SVG + CSS for the
// "come back later" flag:
//   revisit  a still dashed ring in the text colour (unfinished)
//   done     a solid green ring that draws in once, then a check stroke
//   mistake  the same with a red ring and a cross
import type { LaterReason } from "./rail-state";

const CSS = `
@keyframes nav-sm-draw { from { stroke-dashoffset: var(--len); } to { stroke-dashoffset: 0; } }
.nav-sm-draw { stroke-dasharray: var(--len); animation: nav-sm-draw 360ms cubic-bezier(.77,0,.175,1) both; }
@media (prefers-reduced-motion: reduce) { .nav-sm-draw { animation: none; stroke-dasharray: none; } }
`;

let injected = false;
function ensureStyle() {
  if (injected || typeof document === "undefined") return;
  if (!document.getElementById("nav-sm-style")) {
    const el = document.createElement("style");
    el.id = "nav-sm-style";
    el.textContent = CSS;
    document.head.appendChild(el);
  }
  injected = true;
}

const LABEL: Record<LaterReason, string> = {
  revisit: "Come back to this",
  done: "Done, check it later",
  mistake: "Has a mistake, come back",
};

export const LATER_LABEL = LABEL;

export function StatusMark({ reason, size = 14 }: { reason: LaterReason; size?: number }) {
  ensureStyle();
  const C = 2 * Math.PI * 9; // ring circumference at r=9
  if (reason === "revisit") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={LABEL.revisit} className="shrink-0">
        <circle cx="12" cy="12" r="9" fill="none" stroke="var(--foreground)" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={`${C / 8 * 0.42} ${C / 8 * 0.58}`} />
        <circle cx="12" cy="12" r="2.2" fill="var(--foreground)" />
      </svg>
    );
  }
  const color = reason === "done" ? "var(--success)" : "var(--destructive)";
  const glyph = reason === "done" ? "M7.5 12.25 10.5 15.25 16.75 8.75" : "M8.75 8.75 15.25 15.25M15.25 8.75 8.75 15.25";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={LABEL[reason]} className="shrink-0 overflow-visible">
      <circle cx="12" cy="12" r="9" fill={color} fillOpacity=".1" stroke={color} strokeWidth="2.2" className="nav-sm-draw" style={{ ["--len" as string]: `${C}` }} />
      <path d={glyph} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="nav-sm-draw" style={{ ["--len" as string]: "16", animationDelay: "240ms" }} />
    </svg>
  );
}

/* ---- Task glyphs: the same family of marks for to-do items ----
 *  todo     dashed ring (waiting)          doing  lattice (handled by caller)
 *  check    gold ring with a soft ping     done   green tick, drawn once
 *  dropped  muted cross                                                     */
export type TaskGlyphKind = "todo" | "check" | "done" | "dropped";

export function TaskGlyph({ kind, size = 14 }: { kind: TaskGlyphKind; size?: number }) {
  ensureStyle();
  const C = 2 * Math.PI * 9;
  if (kind === "todo") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="To do" role="img" className="shrink-0">
        <circle cx="12" cy="12" r="9" fill="none" stroke="var(--muted-foreground)" strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(C / 8) * 0.42} ${(C / 8) * 0.58}`} />
      </svg>
    );
  }
  if (kind === "check") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Ready to check" role="img" className="shrink-0 overflow-visible">
        <circle cx="12" cy="12" r="9" fill="var(--foreground)" fillOpacity=".15" stroke="var(--foreground)" strokeWidth="2.2" />
        <circle cx="12" cy="12" r="3" fill="var(--foreground)" />
      </svg>
    );
  }
  if (kind === "done") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Done" role="img" className="shrink-0">
        <circle cx="12" cy="12" r="9" fill="var(--success)" fillOpacity=".12" stroke="var(--success)" strokeWidth="2.2" />
        <path d="M7.5 12.25 10.5 15.25 16.75 8.75" fill="none" stroke="var(--success)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="nav-sm-draw" style={{ ["--len" as string]: "16" }} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Dropped" role="img" className="shrink-0">
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--muted-foreground)" strokeOpacity=".5" strokeWidth="2" />
      <path d="M8.75 8.75 15.25 15.25M15.25 8.75 8.75 15.25" fill="none" stroke="var(--muted-foreground)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

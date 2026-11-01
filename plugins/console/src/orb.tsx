// Marks for NavAIgate Workspace.
//   LogoOrb     the NavAIgate N on a flat disc with a hairline ring. While agents
//               work, one thin arc in the live colour turns round the ring; while
//               Savvy listens or speaks, rings ripple out from it.
// Pure CSS and SVG; keyframes are injected once.
import type { CSSProperties, ReactNode } from "react";
import { NavMark } from "./navmark";

const CSS = `
@keyframes nav-orb-spin { to { transform: rotate(360deg) } }
@keyframes nav-orb-pulse { 0% { transform: scale(1); opacity: .5 } 100% { transform: scale(1.3); opacity: 0 } }
.nav-orb * { box-sizing: border-box }
@media (prefers-reduced-motion: reduce) { .nav-orb, .nav-orb * { animation-duration: 0s !important; animation-iteration-count: 1 !important } }
`;
let injected = false;
function inject() {
  if (injected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.dataset.navOrb = "1";
  el.textContent = CSS;
  document.head.appendChild(el);
  injected = true;
}

const LIVE = "var(--attention)";
const abs: CSSProperties = { position: "absolute", inset: 0, borderRadius: "50%" };

export type OrbMood = "idle" | "busy" | "listening" | "speaking" | "connecting";

export function LogoOrb({ size = 96, mood = "idle", onClick, title }: { size?: number; mood?: OrbMood; onClick?: () => void; title?: string }) {
  inject();
  const busy = mood === "busy";
  const voice = mood === "speaking" || mood === "listening" || mood === "connecting";
  const small = size < 40;
  const stroke = small ? 1.5 : 2;
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      aria-label={title ?? "NavAIgate"}
      className="nav-orb"
      style={{ position: "relative", width: size, height: size, flex: "none", padding: 0, border: 0, background: "transparent", cursor: onClick ? "pointer" : "default" }}
    >
      {voice
        ? [0, 0.6].map((d) => (
            <span key={d} style={{ ...abs, border: `1px solid ${LIVE}`, animation: `nav-orb-pulse ${mood === "speaking" ? "1.1s" : "2.2s"} cubic-bezier(.16,1,.3,1) ${d}s infinite` }} />
          ))
        : null}
      <span
        style={{
          ...abs,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--surface-raised)",
          boxShadow: `inset 0 0 0 1px ${voice ? LIVE : "var(--border)"}`,
          color: "var(--foreground)",
        }}
      >
        <NavMark size={Math.round(size * 0.48)} />
      </span>
      {busy ? (
        <svg viewBox="0 0 100 100" aria-hidden style={{ ...abs, width: size, height: size, animation: "nav-orb-spin 2.4s linear infinite" }}>
          <circle cx="50" cy="50" r={50 - (stroke * 100) / size / 2} fill="none" stroke={LIVE} strokeWidth={(stroke * 100) / size} strokeLinecap="round" strokeDasharray="38 400" />
        </svg>
      ) : null}
    </Tag>
  );
}

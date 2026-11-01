// Features guide: every feature from the video and the extras, with its status,
// where to find it and a Show me button. The data is src/features-guide-data.ts,
// generated from features/map.json; nothing here touches the network.
import { useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Segmented } from "./home-kit";
import { FEATURES, FEATURE_AREAS } from "./features-guide-data";
import { goToHref } from "./features-guide-nav";
import { statusLabel, type Feature, type ShowMe } from "./features-guide-types";

type Filter = "all" | Feature["status"]["kind"];

const PANEL_TITLE: Record<string, string> = { home: "Home", "work-needs-you": "Work needs you", stash: "Stash", delivery: "Delivery", board: "Board", features: "Features" };

const CSS = `
.nav-gd{box-sizing:border-box;height:100%;overflow:auto;padding:24px 28px 48px;color:var(--foreground);font-family:var(--font-sans);font-size:13px;line-height:20px}
.nav-gd *{box-sizing:border-box}
.nav-gd-wrap{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:24px}
.nav-gd h1{margin:0;font-family:var(--font-display,var(--font-sans));font-size:24px;line-height:32px;font-weight:500;letter-spacing:-0.01em}
.nav-gd-lede{margin:4px 0 0;color:var(--muted-foreground)}
.nav-gd-bar{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.nav-gd-search{flex:1 1 220px;min-width:0;height:36px;padding:0 12px;border:1px solid var(--input);border-radius:10px;background:var(--card);color:var(--foreground);font:inherit}
.nav-gd-search:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.nav-gd h2{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;font-size:13px;line-height:20px;font-weight:600}
.nav-gd h2 span{color:var(--muted-foreground);font-weight:400;font-variant-numeric:tabular-nums}
.nav-gd-list{margin:0;padding:0;list-style:none;border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden}
.nav-gd-row{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:4px 12px;padding:14px 16px;border-top:1px solid var(--border-hairline)}
.nav-gd-row:first-child{border-top:0}
.nav-gd-id{padding-top:2px;color:var(--muted-foreground);font-family:var(--font-mono);font-size:11px;line-height:18px}
.nav-gd-name{margin:0;font-size:14px;line-height:20px;font-weight:500}
.nav-gd-desc{margin:0;color:var(--muted-foreground)}
.nav-gd-where{margin:6px 0 0;color:var(--foreground)}
.nav-gd-where span{display:block;color:var(--muted-foreground);font-size:12px;line-height:16px}
.nav-gd-proof{margin:6px 0 0;color:var(--muted-foreground);font-size:12px;line-height:16px}
.nav-gd-proof b{display:inline-block;padding:0 6px;border:1px solid var(--border);border-radius:8px;color:var(--foreground);font-weight:500}
.nav-gd details{margin-top:6px;color:var(--muted-foreground)}
.nav-gd summary{cursor:pointer;font-size:12px;line-height:16px;color:var(--muted-foreground)}
.nav-gd summary:focus-visible,.nav-gd-go button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.nav-gd details p{margin:4px 0 0}
.nav-gd-side{grid-column:3;grid-row:1 / span 4;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:220px}
.nav-gd-pill{display:inline-flex;align-items:flex-start;gap:6px;max-width:220px;padding:2px 8px;border:1px solid var(--border);border-radius:12px;text-align:left;font-size:12px;line-height:16px;font-weight:500;color:var(--muted-foreground)}
.nav-gd-pill i{flex:none;width:8px;height:8px;margin-top:4px;border-radius:50%;border:1.5px solid currentColor}
.nav-gd-pill[data-status="live"]{color:var(--attention);border-color:var(--attention)}
.nav-gd-pill[data-status="live"] i{background:currentColor}
.nav-gd-pill[data-status="partly"]{color:var(--foreground)}
.nav-gd-pill[data-status="partly"] i{background:linear-gradient(90deg,currentColor 50%,transparent 50%)}
.nav-gd-pill[data-status="blocked"]{color:var(--foreground);border-color:var(--foreground)}
.nav-gd-pill[data-status="blocked"] i{border-radius:1px;background:currentColor}
.nav-gd-go{display:flex;flex-direction:column;align-items:flex-end;gap:4px;text-align:right}
.nav-gd-go button{min-height:32px;padding:0 12px;border:1px solid var(--input);border-radius:8px;background:var(--card);color:var(--foreground);font:inherit;font-weight:500;cursor:pointer;transition:background-color 120ms ease}
.nav-gd-go button:hover:not(:disabled){background:var(--state-hover)}
.nav-gd-go button:disabled{color:var(--muted-foreground);cursor:default;background:transparent}
.nav-gd-cap{color:var(--muted-foreground);font-size:12px;line-height:16px}
.nav-gd-link{padding:0;border:0;background:none;color:var(--foreground);font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.nav-gd-link:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.nav-gd-empty{margin:0;padding:24px 0;color:var(--muted-foreground)}
.nav-gd-filter{max-width:100%;overflow-x:auto}
@media (max-width:640px){.nav-gd-go button,.nav-gd-search{min-height:44px}.nav-gd-search{flex-basis:100%}.nav-gd-filter{flex:1 1 100%}.nav-gd{padding:16px}.nav-gd-row{grid-template-columns:minmax(0,1fr)}.nav-gd-id{padding:0}.nav-gd-side{grid-column:1;grid-row:auto;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;max-width:none}.nav-gd-go{align-items:flex-start;text-align:left}}
@media (prefers-reduced-motion:reduce){.nav-gd-go button{transition:none}}
`;

function ensureStyle() {
  if (typeof document === "undefined" || document.getElementById("nav-gd-style")) return;
  const el = document.createElement("style");
  el.id = "nav-gd-style";
  el.textContent = CSS;
  document.head.appendChild(el);
}

function caption(t: ShowMe): string | null {
  switch (t.kind) {
    case "panel": return `Opens ${PANEL_TITLE[t.path] ?? t.path}`;
    case "route": return `Opens ${t.label}`;
    case "compose": return "Opens a new chat";
    case "chat": return t.hint;
    case "none": return t.reason;
  }
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** What the live check found: a small mark when it was proven, the reason when it was not. */
function Proof({ f }: { f: Feature }) {
  const e = f.evidence;
  const when = `${DATE.format(new Date(`${e.date}T00:00:00Z`))}, ${e.build}`;
  if (e.verdict === "PASS")
    return <p className="nav-gd-proof" data-proof="pass"><b title={`Seen working on ${when}. ${e.note}`}>Proven live</b></p>;
  const lead = e.verdict === "UNVERIFIED" ? "Not proven live yet" : e.verdict === "FAIL" ? "Live check" : "After the live check";
  return <p className="nav-gd-proof" data-proof={e.verdict.toLowerCase()}>{lead}: {e.note} <span>({when})</span></p>;
}

function matches(f: Feature, q: string): boolean {
  if (!q) return true;
  return [f.id, f.name, f.description, f.where, f.area].some((s) => s.toLowerCase().includes(q));
}

function Row({ f, onShow }: { f: Feature; onShow: (t: ShowMe) => void }) {
  const enabled = f.showMe.kind === "panel" || f.showMe.kind === "route" || f.showMe.kind === "compose";
  const note = caption(f.showMe);
  return (
    <li className="nav-gd-row" data-feature={f.id}>
      <span className="nav-gd-id">{f.id.startsWith("EXTRA-") ? `(${f.id.slice(6).toLowerCase()})` : f.id}</span>
      <div style={{ minWidth: 0 }}>
        <h3 className="nav-gd-name" id={`nav-gd-${f.id}`}>{f.name}</h3>
        <p className="nav-gd-desc">{f.description}</p>
        <Proof f={f} />
        <p className="nav-gd-where"><span>Where to find it</span>{f.where}</p>
        {f.gap ? (
          <details>
            <summary>{f.status.kind === "live" ? "Good to know" : f.status.kind === "blocked" ? "Why it is blocked" : "What is missing"}</summary>
            <p>{f.gap}</p>
          </details>
        ) : null}
      </div>
      <div className="nav-gd-side">
        <span className="nav-gd-pill" data-status={f.status.kind}><i aria-hidden />{statusLabel(f.status)}</span>
        <div className="nav-gd-go">
          <button type="button" disabled={!enabled} aria-describedby={`nav-gd-${f.id}`} onClick={() => onShow(f.showMe)}>Show me</button>
          {note ? <span className="nav-gd-cap">{note}</span> : null}
        </div>
      </div>
    </li>
  );
}

export function FeaturesGuide() {
  ensureStyle();
  const nav = useBbNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const c = { live: 0, partly: 0, blocked: 0 };
    for (const f of FEATURES) c[f.status.kind]++;
    return c;
  }, []);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => FEATURES.filter((f) => (filter === "all" || f.status.kind === filter) && matches(f, q)), [filter, q]);
  const show = (t: ShowMe) => {
    if (t.kind === "panel") nav.toPluginPanel(t.path);
    else if (t.kind === "route") goToHref(t.href);
    else if (t.kind === "compose") nav.toCompose({ focusPrompt: true });
  };
  return (
    <main className="nav-gd" aria-label="Features guide" data-nav-part="features-guide" data-tour="console-features">
      <div className="nav-gd-wrap">
        <header>
          <h1>Features</h1>
          <p className="nav-gd-lede">
            {FEATURES.length} features from your video and your extras: {counts.live} live, {counts.partly} partly live and {counts.blocked} blocked.
          </p>
          <p className="nav-gd-lede"><button type="button" className="nav-gd-link" onClick={() => nav.toPluginPanel("setup")}>Set up the Console and choose which features are on</button></p>
        </header>
        <div className="nav-gd-bar">
          <input className="nav-gd-search" type="search" role="searchbox" aria-label="Search features" placeholder="Search by name, id or where to click" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="nav-gd-filter">
            <Segmented<Filter>
              label="Filter by status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All ${FEATURES.length}` },
                { value: "live", label: `Live ${counts.live}` },
                { value: "partly", label: `Partly live ${counts.partly}` },
                { value: "blocked", label: `Blocked ${counts.blocked}` },
              ]}
            />
          </div>
        </div>
        {shown.length === 0 ? <p className="nav-gd-empty">No feature matches that search.</p> : null}
        {FEATURE_AREAS.map((area) => {
          const rows = shown.filter((f) => f.area === area);
          if (rows.length === 0) return null;
          return (
            <section key={area} aria-label={area}>
              <h2>{area}<span>{rows.length}</span></h2>
              <ul className="nav-gd-list">
                {rows.map((f) => <Row key={f.id} f={f} onShow={show} />)}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}

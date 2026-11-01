// Dashboard: show any local web app you run (your own OS dashboard, a dev
// server, Grafana...) as a page inside bb, with a tab per app. The list comes
// from the plugin setting "Dashboards" (Name|URL per line). Nothing is bundled:
// the app keeps running on its own, bb only frames it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { caps } from "./shared";
import { ensureHomeKitStyle, useSlideIndicator } from "./home-kit";

type Dash = { name: string; url: string };

export function parseDashboards(raw: unknown): Dash[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("|");
      const name = (i > 0 ? l.slice(0, i) : "").trim();
      const url = (i > 0 ? l.slice(i + 1) : l).trim();
      try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        return { name: (name || u.host).slice(0, 40), url: u.toString() };
      } catch {
        return null;
      }
    })
    .filter((d): d is Dash => !!d)
    .slice(0, 8);
}

const KEY = "nav-skin:dashboard";

export function DashboardPage() {
  const { values, isLoading } = useSettings();
  const dashes = useMemo(() => parseDashboards(values?.dashboards), [values?.dashboards]);
  const [active, setActive] = useState<string>(() => localStorage.getItem(KEY) ?? "");
  const [nonce, setNonce] = useState(0);
  const [up, setUp] = useState<boolean | null>(null);
  const current = dashes.find((d) => d.url === active) ?? dashes[0];
  const bar = useRef<HTMLDivElement>(null);
  ensureHomeKitStyle();
  const ind = useSlideIndicator(bar, (root) => Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-url]")).find((x) => x.dataset.url === current?.url), current?.url);

  useEffect(() => {
    if (current) localStorage.setItem(KEY, current.url);
  }, [current]);

  // Reachability check: a no-cors fetch resolves when something is listening.
  useEffect(() => {
    if (!current) return;
    let live = true;
    setUp(null);
    fetch(current.url, { mode: "no-cors", cache: "no-store" })
      .then(() => live && setUp(true))
      .catch(() => live && setUp(false));
    return () => {
      live = false;
    };
  }, [current, nonce]);

  if (isLoading) return <div className="p-6 text-[12px] text-muted-foreground">Loading…</div>;
  if (!current)
    return (
      <div className="mx-auto max-w-[560px] p-8">
        <div className={caps}>Dashboard</div>
        <h2 className="mt-2 text-[20px] font-medium text-foreground">Show your own dashboard inside bb</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Run any local web app, then add it in Settings, Plugins, NavAIgate Workspace, under <b>Dashboards</b>, one per line as <code>Name|URL</code>, for example <code>My OS|http://localhost:8081</code>. It shows up here with a tab of its own.
        </p>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={bar} className="relative flex items-center gap-1 border-b border-border px-3 py-1.5">
        {ind ? <span aria-hidden data-nav-part="dashboard-tab-indicator" className="nav-hk-seg-ind pointer-events-none absolute -bottom-px left-0 h-0.5 rounded-full bg-foreground" style={{ width: ind.w, transform: `translateX(${ind.x}px)` }} /> : null}
        {dashes.map((d) => (
          <button
            key={d.url}
            type="button"
            data-url={d.url}
            aria-pressed={d.url === current.url}
            onClick={() => setActive(d.url)}
            className={cn("nav-hk-hover min-h-7 rounded-md px-2.5 py-1 text-[12px]", d.url === current.url ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {d.name}
          </button>
        ))}
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{current.url}</span>
        <button type="button" onClick={() => setNonce((n) => n + 1)} className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground" title="Reload">
          Reload
        </button>
        <a href={current.url} target="_blank" rel="noopener noreferrer" className="rounded-md px-2 py-1 text-[12px] text-muted-foreground no-underline hover:text-foreground">
          Open in browser
        </a>
      </div>
      {up === false ? (
        <div className="mx-auto max-w-[520px] p-8 text-[13px] text-muted-foreground">
          Nothing is answering at <code>{current.url}</code> yet. Start the app, then press Reload.
        </div>
      ) : (
        <iframe
          key={`${current.url}#${nonce}`}
          src={current.url}
          title={current.name}
          className="min-h-0 w-full flex-1 border-0 bg-background"
          allow="clipboard-read; clipboard-write; microphone; camera; autoplay; fullscreen"
        />
      )}
    </div>
  );
}

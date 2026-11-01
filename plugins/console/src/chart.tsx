// ::nav-chart — lets any agent reply with a real chart instead of a wall of numbers.
//   ::nav-chart{kind="bars" title="…" data="A:12,B:5" unit="h" highlight="A" note="Source: …"}
//   kinds: bars (default) | stats | split | steps (values done/now/next/blocked)
import type { ReactNode } from "react";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { LIVE, Node, caps, tnum, type State } from "./shared";

type Datum = { label: string; value: number };

const MAX_POINTS = 24;

function parseNumeric(raw: string | undefined): Datum[] | null {
  if (!raw) return null;
  const out: Datum[] = [];
  for (const part of raw.split(",").slice(0, MAX_POINTS)) {
    const idx = part.lastIndexOf(":");
    if (idx <= 0) return null;
    const label = part.slice(0, idx).trim().slice(0, 48);
    const value = Number(part.slice(idx + 1).trim());
    if (!label || !Number.isFinite(value)) return null;
    out.push({ label, value });
  }
  return out.length > 0 ? out : null;
}

function parseSteps(raw: string | undefined): Array<{ label: string; state: string }> | null {
  if (!raw) return null;
  const out = raw
    .split(",")
    .slice(0, MAX_POINTS)
    .map((part) => {
      const idx = part.lastIndexOf(":");
      const label = (idx > 0 ? part.slice(0, idx) : part).trim().slice(0, 64);
      const state = (idx > 0 ? part.slice(idx + 1) : "next").trim().toLowerCase();
      return { label, state: ["done", "now", "next", "blocked"].includes(state) ? state : "next" };
    })
    .filter((s) => s.label);
  return out.length > 0 ? out : null;
}

function fmt(n: number, unit?: string) {
  const s = Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
  return unit ? `${s}${unit.length <= 2 ? unit : ` ${unit}`}` : s;
}

function ChartFrame({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <figure className="my-3 max-w-[640px] rounded-lg border border-border bg-card px-4 pb-3.5 pt-3">
      {title ? <figcaption className={cn(caps, "mb-3 text-foreground")}>{title}</figcaption> : null}
      {children}
      {note ? <p className="mt-3 border-t border-border pt-2 text-[12px] text-muted-foreground">{note}</p> : null}
    </figure>
  );
}

export function NavChart({ attributes, source }: PluginMessageDirectiveProps) {
  const kind = (attributes.kind ?? "bars").toLowerCase();
  const title = attributes.title?.slice(0, 80);
  const note = attributes.note?.slice(0, 160);
  const unit = attributes.unit?.slice(0, 12);
  const highlight = attributes.highlight?.trim().toLowerCase();

  if (kind === "steps") {
    const steps = parseSteps(attributes.data);
    if (!steps) return <code className="text-[12px] text-destructive-text">{source}</code>;
    return (
      <ChartFrame title={title} note={note}>
        <ol className="relative">
          {steps.map((s, i) => {
            const st: State = s.state === "done" ? "unread" : s.state === "now" ? "running" : s.state === "blocked" ? "needs" : "parked";
            return (
              <li key={i} className="relative flex h-8 items-center gap-3 text-[14px]">
                {i < steps.length - 1 ? <span aria-hidden className="absolute left-[3px] top-[19px] h-[26px] w-px bg-border" /> : null}
                <Node state={st} size={s.state === "now" ? 8 : 6} />
                <span className={cn("flex-1", s.state === "done" ? "text-muted-foreground" : "text-foreground", s.state === "now" && "font-medium")}>{s.label}</span>
                <span className={caps} style={s.state === "now" ? { color: LIVE } : s.state === "blocked" ? { color: "var(--destructive-text)" } : undefined}>
                  {s.state}
                </span>
              </li>
            );
          })}
        </ol>
      </ChartFrame>
    );
  }

  const data = parseNumeric(attributes.data);
  if (!data) return <code className="text-[12px] text-destructive-text">{source}</code>;

  if (kind === "stats") {
    return (
      <ChartFrame title={title} note={note}>
        <div className="grid gap-x-6 gap-y-3" style={{ gridTemplateColumns: `repeat(${Math.min(4, data.length)}, minmax(0, 1fr))` }}>
          {data.map((d) => (
            <div key={d.label} className="min-w-0">
              <div className={cn(caps, "truncate")}>{d.label}</div>
              <div
                className="mt-1.5 text-[28px] font-medium leading-none tracking-[-0.02em]"
                style={{ ...tnum, color: highlight === d.label.toLowerCase() ? LIVE : undefined }}
              >
                {fmt(d.value, unit)}
              </div>
            </div>
          ))}
        </div>
      </ChartFrame>
    );
  }

  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);

  if (kind === "split") {
    const shades = ["var(--foreground)", "var(--muted-foreground)", "var(--input)", "var(--border)"];
    return (
      <ChartFrame title={title} note={note}>
        <div className="flex h-3 overflow-hidden rounded-[3px] bg-muted">
          {data.map((d, i) => (
            <div key={d.label} title={`${d.label}: ${fmt(d.value, unit)}`} style={{ width: `${(Math.max(0, d.value) / Math.max(1, total)) * 100}%`, background: shades[i % shades.length] }} />
          ))}
        </div>
        <div className="mt-3 grid gap-x-5 gap-y-1.5 text-[13px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
          {data.map((d, i) => (
            <span key={d.label} className="flex items-center gap-2">
              <span aria-hidden className="inline-block size-[6px] shrink-0" style={{ background: shades[i % shades.length] }} />
              <span className="truncate text-foreground">{d.label}</span>
              <span className="ml-auto text-muted-foreground" style={tnum}>
                {fmt(d.value, unit)} · {Math.round((Math.max(0, d.value) / Math.max(1, total)) * 100)}%
              </span>
            </span>
          ))}
        </div>
      </ChartFrame>
    );
  }

  // bars (default)
  const max = Math.max(...data.map((d) => d.value), 0);
  const hasHighlight = highlight !== undefined && data.some((d) => d.label.toLowerCase() === highlight);
  return (
    <ChartFrame title={title} note={note}>
      <div className="space-y-2">
        {data.map((d) => {
          const on = hasHighlight ? d.label.toLowerCase() === highlight : true;
          return (
            <div key={d.label} className="grid grid-cols-[minmax(72px,140px)_1fr_96px] items-center gap-3 text-[13px]">
              <span className={cn("truncate", on ? "text-foreground" : "text-muted-foreground")}>{d.label}</span>
              <div className="h-2.5 rounded-[3px] bg-muted">
                <div
                  className="h-full rounded-[3px]"
                  style={{
                    width: `${max > 0 ? (Math.max(0, d.value) / max) * 100 : 0}%`,
                    background: hasHighlight ? (on ? LIVE : "var(--muted-foreground)") : "var(--foreground)",
                  }}
                />
              </div>
              <span className={cn("text-right text-[13px]", on ? "font-medium text-foreground" : "text-muted-foreground")} style={tnum}>
                {fmt(d.value, unit)}
              </span>
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}


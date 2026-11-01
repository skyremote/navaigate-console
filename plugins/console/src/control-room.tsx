// Control room: one strip across every harness on bb's home screen: the four
// states, each harness split by state, what needs you, and the three Macs.
import { useMemo } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, type PluginHomepageSectionProps } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { LIVE, Legend, Node, ago, caps, harnessOf, tnum } from "./shared";
import { Card, CountUp, Heading, ensureHomeKitStyle } from "./home-kit";
import { MachinesCard, StatTiles, threadModel } from "./home-panels";
import { useRunning } from "./use-running";

function SplitBar({ parts, total, max, delay }: { parts: Array<{ n: number; color: string; label: string }>; total: number; max: number; delay: number }) {
  return (
    <div className="nav-hk-grow flex h-2.5 overflow-hidden rounded-full bg-muted" style={{ width: `${Math.max(6, (total / Math.max(1, max)) * 100)}%`, animationDelay: `${delay}ms` }}>
      {parts.map((p) =>
        p.n > 0 ? <div key={p.label} title={`${p.label}: ${p.n}`} style={{ width: `${(p.n / total) * 100}%`, background: p.color }} /> : null,
      )}
    </div>
  );
}

export function ControlRoom(_props: PluginHomepageSectionProps) {
  ensureHomeKitStyle();
  const { status, threads: physical } = useSidebarThreads();
  const now = Date.now();
  const { threads, view, board } = useRunning(physical);
  const model = useMemo(() => threadModel(threads), [threads]);

  if (status !== "ready" && threads.length === 0) return null;

  return (
    <div data-nav-part="control-room" className="flex w-full flex-col gap-3">
      <p className={cn(caps, "text-right")}>Every harness, live</p>
      <StatTiles tally={model.tally} running={{ view, machines: board?.columns.map((c) => c.key) ?? [] }} />
      <div className="grid items-start gap-3 md:grid-cols-[1.1fr_1fr]">
        <Card i={4} part="by-harness" label={<Heading label="By harness" figure={<CountUp value={model.live.length} />} note="chats" />}>
          <div className="space-y-3">
            {model.rows.map((r, n) => (
              <div key={r.h.key} className="grid grid-cols-[64px_1fr_32px] items-center gap-3 text-[13px]">
                <span className="truncate text-foreground">{r.h.label}</span>
                <SplitBar
                  total={r.total}
                  max={model.max}
                  delay={n * 60}
                  parts={[
                    { n: r.s.running, color: LIVE, label: "Running" },
                    { n: r.s.needs, color: "var(--destructive)", label: "Needs you" },
                    { n: r.s.unread, color: "var(--foreground)", label: "Unread" },
                    { n: r.s.parked, color: "var(--input)", label: "Parked" },
                  ]}
                />
                <span className="text-right text-[12px] text-muted-foreground" style={tnum}>
                  {r.total}
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
            <Legend color={LIVE} label="Running" />
            <Legend color="var(--destructive)" label="Needs you" />
            <Legend color="var(--foreground)" label="Unread" />
            <Legend color="var(--input)" label="Parked" />
          </div>
        </Card>
        <Card i={5} part="needs-you" label={<Heading label="Needs you" figure={<CountUp value={model.needs.length} />} />}>
          {model.needs.length === 0 ? (
            <p className="pb-2 text-[13px] text-muted-foreground">Nothing is waiting on you</p>
          ) : (
            <ul className="-mx-2 -mt-1">
              {model.needs.slice(0, 5).map((t, n) => (
                <li key={t.id} className="nav-hk-row" style={{ animationDelay: `${n * 30}ms` }}>
                  <a href={t.href} className="nav-hk-hover flex min-h-9 items-center gap-2.5 rounded-lg px-2 text-[13px] text-foreground no-underline hover:bg-[var(--state-hover)]">
                    <Node state="needs" />
                    <span className="min-w-0 flex-1 truncate">{t.displayTitle}</span>
                    <span className="text-[12px] text-muted-foreground">{harnessOf(t.providerId).label}</span>
                    <span className="w-7 text-right text-[11px] text-muted-foreground" style={tnum}>
                      {ago(t.updatedAt, now)}
                    </span>
                  </a>
                </li>
              ))}
              {model.needs.length > 5 ? <li className="px-2 pt-1 text-[12px] text-muted-foreground">and {model.needs.length - 5} more in the rail</li> : null}
            </ul>
          )}
        </Card>
      </div>
      <MachinesCard threads={physical} i={6} compact />
    </div>
  );
}

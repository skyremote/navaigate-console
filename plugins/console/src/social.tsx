// Social card on Home: Blotato accounts, the queue, the last published posts with
// their analytics, and a "Draft a post" button that starts a drafting chat.
// The plugin never publishes; the chat drafts and asks the owner first.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { Social } from "../server-social";
import { platformByKey } from "./directives";
import { BrandIcon } from "./brand-icons";
import { caps, tnum } from "./shared";
import { useSpawn } from "./spawn";

type Post = Social["recent"][number];

const compact = (n: number) => new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(n);
function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return `today ${time}`;
  if (days === -1) return `yesterday ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + ` ${time}`;
}

export function PlatformBadge({ platform, size = 22 }: { platform: string; size?: number }) {
  return <BrandIcon platform={platform} size={size} title={platformByKey(platform).name} />;
}

function PostRow({ p, queued }: { p: Post; queued?: boolean }) {
  const m = p.metrics;
  const stats = m
    ? [m.views !== null ? `${compact(m.views)} views` : null, m.likes !== null ? `${compact(m.likes)} likes` : null, m.comments ? `${compact(m.comments)} comments` : null, m.shares ? `${compact(m.shares)} shares` : null].filter(Boolean).join(" · ")
    : null;
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 py-1.5">
      <PlatformBadge platform={p.platform} />
      <div className="min-w-0">
        <div className="truncate text-[13px] text-foreground">{p.firstLine}</div>
        <div className="text-[11px] text-muted-foreground" style={tnum}>
          {queued ? "Scheduled " : ""}
          {when(p.at)}
          {stats ? ` · ${stats}` : !queued && p.platform === "linkedin" ? " · LinkedIn gives no metrics" : !queued ? " · metrics not in yet" : ""}
        </div>
      </div>
      {p.url ? (
        <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-muted-foreground hover:text-foreground">
          Open
        </a>
      ) : (
        <span />
      )}
    </div>
  );
}

export function SocialCard() {
  const rpc = useRpc<typeof rpcContract>();
  const { spawn, busy, ready } = useSpawn();
  const [social, setSocial] = useState<Social | null>(null);
  const load = useCallback(() => {
    rpc.call("home_social").then((v) => setSocial(v as Social), () => {});
  }, [rpc]);
  useEffect(() => {
    load();
    const id = window.setInterval(() => document.visibilityState === "visible" && load(), 10 * 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const draft = () => {
    const recent = (social?.recent ?? []).slice(0, 5).map((p) => `- ${platformByKey(p.platform).name}: ${p.firstLine}`).join("\n");
    const prompt = [
      "Help me draft my next social post.",
      "Work the content-desk way (use the content-desk skill, and the growth-marketer agent's positioning approach in ~/.claude/agents/growth-marketer.md), and write in my voice with the daniel-voice skill.",
      `Connected accounts in Blotato: ${(social?.accounts ?? []).map((a) => `${platformByKey(a.platform).name} (${a.name})`).join(", ") || "unknown"}.`,
      recent ? `What I posted most recently, so you do not repeat it:\n${recent}` : "",
      "Ask me first what the post is about if it is not obvious, then give me drafts per platform.",
      "DRAFT ONLY. Do not publish or schedule anything through Blotato or any other tool. Ask me before anything goes out.",
    ]
      .filter(Boolean)
      .join("\n\n");
    void spawn("draft", "Draft a social post", prompt);
  };

  return (
    <section className="rounded-[14px] border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={caps}>Social</span>
        <span className="text-[12px] text-muted-foreground">Through Blotato, read-only</span>
        <div className="ml-auto flex items-center gap-1.5">
          {(social?.accounts ?? []).map((a) => (
            <span key={a.id} title={`${platformByKey(a.platform).name}: ${a.name}`}>
              <PlatformBadge platform={a.platform} size={20} />
            </span>
          ))}
          <button
            type="button"
            disabled={!!busy || !ready}
            onClick={draft}
            className="ml-2 rounded-full px-2.5 py-1 text-[12px] font-medium bg-primary text-primary-foreground disabled:opacity-40"
          >
            {busy ? "Starting…" : "Draft a post"}
          </button>
        </div>
      </div>
      {!social ? (
        <div className="text-[12px] text-muted-foreground">Loading…</div>
      ) : !social.configured ? (
        <div className="text-[13px] text-muted-foreground">Blotato is not connected on this Mac. Add the Blotato MCP server (with its API key) to Claude Code, or set BLOTATO_API_KEY.</div>
      ) : social.error ? (
        <div className="text-[13px] text-destructive-text">{social.error}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <div className="mb-1 text-[12px] font-medium text-muted-foreground">Queue</div>
            {social.queue.length ? (
              <div className="divide-y divide-border">
                {social.queue.map((p) => (
                  <PostRow key={p.id} p={p} queued />
                ))}
              </div>
            ) : (
              <div className="py-1.5 text-[12px] text-muted-foreground">Nothing scheduled</div>
            )}
            <div className="mt-3 mb-1 text-[12px] font-medium text-muted-foreground">Accounts</div>
            <div className="flex flex-col gap-1">
              {social.accounts.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-[12px]">
                  <PlatformBadge platform={a.platform} size={18} />
                  <span className="text-foreground">{platformByKey(a.platform).name}</span>
                  <span className="truncate text-muted-foreground">{a.name}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[12px] font-medium text-muted-foreground">Last published</div>
            <div className={cn("divide-y divide-border")}>
              {social.recent.length ? social.recent.map((p) => <PostRow key={p.id} p={p} />) : <div className="py-1.5 text-[12px] text-muted-foreground">Nothing in the last 30 days</div>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

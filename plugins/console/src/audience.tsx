// Audience row on Home: one card per platform. A real number where a source
// gives one, otherwise a dashed card that says so and offers "Link profile".
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { audienceSchema } from "../server-audience";
import type { z } from "zod";
import { caps, tnum } from "./shared";
import { PlatformBadge } from "./social";
import { field } from "./controls";

type Audience = z.infer<typeof audienceSchema>;
type Card = Audience["platforms"][number];

const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);

function AudienceTile({ c, onLink }: { c: Card; onLink: (url: string | null) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(c.profileUrl ?? "");
  const live = c.count !== null;
  return (
    <div className={cn("flex min-h-[132px] flex-col rounded-[14px] bg-card p-4", live ? "border border-border" : "border border-dashed border-border")}>
      <div className="flex items-center gap-2">
        <PlatformBadge platform={c.platform} size={20} />
        <span className="text-[12px] text-muted-foreground">{c.label}</span>
      </div>
      {live ? (
        <>
          <div className="mt-2 text-[26px] font-medium leading-none text-foreground" style={tnum}>
            {fmt(c.count as number)}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground" style={tnum}>
            {c.change7d === null ? "7-day change after a week of snapshots" : `${c.change7d >= 0 ? "+" : "−"}${fmt(Math.abs(c.change7d))} in 7 days`}
          </div>
          <div className="mt-auto pt-2 text-[11px] text-muted-foreground">{c.source}</div>
        </>
      ) : (
        <>
          <div className="mt-2 text-[13px] font-medium text-foreground">No numbers yet</div>
          <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{c.note}</div>
        </>
      )}
      {editing ? (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void onLink(url.trim() || null).then(() => setEditing(false));
          }}
        >
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className={`${field} min-w-0 flex-1 outline-none focus:border-ring`}
          />
          <button type="submit" className="rounded-md border border-border px-2 py-1 text-[12px] text-foreground hover:border-foreground">
            Save
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={cn("mt-2 self-start rounded-md border border-border px-2.5 py-1 text-[12px] hover:border-foreground", live ? "text-muted-foreground" : "text-foreground")}
        >
          {c.profileUrl ? "Change profile" : "Link profile"}
        </button>
      )}
    </div>
  );
}

export function AudienceRow() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Audience | null>(null);
  const load = useCallback(() => {
    rpc.call("home_audience").then((v) => setData(v as Audience), () => {});
  }, [rpc]);
  useEffect(() => {
    load();
    const id = window.setInterval(() => document.visibilityState === "visible" && load(), 30 * 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const link = async (platform: Card["platform"], url: string | null) => {
    try {
      setData((await rpc.call("audience_link", { platform, url })) as Audience);
    } catch (e) {
      toast.error("Could not save the profile link", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section>
      <div className={cn(caps, "mb-2 px-1")}>Audience</div>
      {!data ? (
        <div className="rounded-[14px] border border-dashed border-border bg-card p-4 text-[12px] text-muted-foreground">Reading your profiles…</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {data.platforms.map((c) => (
            <AudienceTile key={`${c.platform}:${c.profileUrl ?? ""}`} c={c} onLink={(url) => link(c.platform, url)} />
          ))}
        </div>
      )}
    </section>
  );
}

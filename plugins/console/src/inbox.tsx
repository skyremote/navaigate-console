// Inbox card on Home: emails from the last 7 days that need a reply, across
// the owner's Gmail accounts, triaged by Jev on the server. "Hand to agent" starts a
// real bb chat that drafts a reply as the emailer agent. Drafts only, never sends.
import { useCallback, useEffect, useMemo, useState } from "react";
import { fullAccess, useWorkProject } from "./spawn";
import { experimental_useSidebarThreads as useSidebarThreads, useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { Inbox } from "../server-inbox";
import { BrandIcon } from "./brand-icons";
import { rpcFlight } from "./rpc-flight";
import { caps, tnum } from "./shared";
import { useVisiblePoll } from "./visible-poll";
import { owner } from "./words";

type Item = Inbox["items"][number];

const URGENCY = ["Low", "This week", "Soon", "Today"];
const HANDLER: Record<string, string> = { reply_myself: "You", emailer_draft: "Draft", ignore: "Skip" };

const name = (from: string) => (from.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || from.replace(/[<>]/g, "").trim()).slice(0, 40);
const short = (account: string) => account.replace(/@.*/, (d) => (/gmail\.com$/.test(d) ? "@gmail" : d.replace(/\.[a-z]+$/, "")));
function when(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (!Number.isFinite(h)) return "";
  if (h < 1) return "now";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The emailer prompt behind "Hand to agent": draft only, never send. Shared with the Inbox page. */
export function replyPrompt(m: { account: string; from: string; subject: string; id: string; threadId: string; venture?: string | null }): string {
  return [
    "Act as the emailer agent: read ~/.claude/agents/emailer.md first and follow its instructions.",
    `Then use the daniel-voice skill and draft a reply in ${owner()}'s voice to this email:`,
    "",
    `- Account (reply from this mailbox): ${m.account}`,
    `- From: ${m.from}`,
    `- Subject: ${m.subject}`,
    `- Gmail message id (Composio): ${m.id}`,
    `- Thread id: ${m.threadId}`,
    "",
    "Read the full message and thread through Composio (GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID / GMAIL_FETCH_MESSAGE_BY_THREAD_ID on that account) before writing.",
    m.venture ? `Jev thinks this is about ${m.venture}; check that before choosing the brand voice.` : "",
    "DRAFT ONLY. Never send the email, and do not label, archive or modify any mail. Show me the draft here; if I approve it, you may save it as a Gmail draft on that account.",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}

export function InboxCard() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const nav = useBbNavigate();
  const { projects } = useSidebarThreads();
  const project = useWorkProject();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((fresh = false) => {
    rpcFlight().call("home_inbox", () => rpc.call("home_inbox"), { fresh }).then((v) => setInbox(v as Inbox), () => {});
  }, [rpc]);
  useEffect(() => {
    load();
  }, [load]);
  useVisiblePoll(() => load(), 5 * 60_000);

  const hand = async (m: Item) => {
    if (!project || busy) return;
    setBusy(m.id);
    const prompt = replyPrompt(m);
    try {
      const made = await sdk.threads.spawn(
        fullAccess({
          projectId: project.id,
          environment: { type: "project-default" },
          providerId: "claude-code",
          title: `Reply: ${m.subject}`.slice(0, 80),
          visibility: "visible",
          prompt,
        }) as Parameters<typeof sdk.threads.spawn>[0],
      );
      nav.toThread((made as { id: string }).id);
    } catch (e) {
      toast.error("Could not start the chat", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const counts = inbox?.accounts.map((a) => `${short(a.email)} ${a.needReply}`).join(" · ");

  // "Sort all with Jev": clear the triage cache and re-run Jev on the last 7 days, with progress.
  const [sort, setSort] = useState<{ running: boolean; done: number; total: number } | null>(null);
  const sortAll = async () => {
    try {
      const r = await rpc.call("inbox_resort");
      if (!r.started) {
        toast.message("Jev is already sorting the inbox.");
      }
      setSort({ running: true, done: 0, total: 0 });
    } catch (e) {
      toast.error("Could not start sorting", { description: e instanceof Error ? e.message : String(e) });
    }
  };
  useEffect(() => {
    if (!sort?.running) return;
    let waiting = false;
    const id = window.setInterval(() => {
      if (waiting) return;
      waiting = true;
      rpc.call("inbox_status").then((s) => {
        waiting = false;
        setSort(s);
        if (!s.running) {
          window.clearInterval(id);
          load(true);
        }
      }, () => { waiting = false; });
    }, 1000);
    return () => window.clearInterval(id);
  }, [sort?.running, rpc, load]);

  return (
    <section className="rounded-[14px] border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <BrandIcon platform="gmail" size={16} />
        <button type="button" onClick={() => nav.toPluginPanel("inbox")} className={cn(caps, "inline-flex min-h-6 items-center hover:text-foreground")} title="Open the Inbox page">
          Inbox
        </button>
        <span className="text-[12px] text-muted-foreground">Last 7 days, needs a reply, triaged by Jev</span>
        <span className="ml-auto text-[12px] text-muted-foreground" style={tnum}>
          {counts ?? ""}
        </span>
        <button
          type="button"
          disabled={!!sort?.running}
          onClick={() => void sortAll()}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-foreground disabled:opacity-60"
          style={tnum}
        >
          {sort?.running ? (sort.total ? `Sorting ${sort.done} of ${sort.total}…` : "Reading mail…") : "Sort all with Jev"}
        </button>
        <button
          type="button"
          onClick={() => nav.toPluginPanel("inbox")}
          className="rounded-full px-2.5 py-1 text-[12px] font-medium bg-primary text-primary-foreground"
        >
          Open inbox
        </button>
      </div>
      {!inbox ? (
        <div className="text-[12px] text-muted-foreground">Reading your inboxes… the first pass asks Jev about each email and takes a little while.</div>
      ) : !inbox.configured ? (
        <div className="text-[13px] text-muted-foreground">Mail comes through Composio. Add COMPOSIO_API_KEY to ~/.config/navaigate/composio.env.</div>
      ) : (
        <>
          {inbox.error ? (
            <div className={cn("mb-2 rounded-md border px-3 py-2 text-[12px]", inbox.items.length ? "border-foreground text-foreground" : "border-border text-destructive-text")}>{inbox.error}</div>
          ) : null}
          {inbox.items.length === 0 ? (
            <div className="text-[13px] text-muted-foreground">{inbox.error ? "" : "Nothing waiting on a reply."}</div>
          ) : (
            <div className="divide-y divide-border">
              {inbox.items.map((m) => {
                const level = m.urgency === null ? null : Math.max(0, Math.min(3, Math.round(m.urgency)));
                return (
                  <div key={m.id} className="grid grid-cols-[76px_minmax(0,1fr)_auto] items-start gap-3 py-2">
                    <span
                      className={cn("mt-0.5 rounded-full border px-2 py-0.5 text-center text-[11px] font-medium", level !== null && level >= 2 ? "text-foreground" : "text-muted-foreground")}
                      style={level !== null && level >= 2 ? { borderColor: "var(--foreground)", color: level === 3 ? "var(--destructive-text)" : undefined } : undefined}
                      title={m.urgency === null ? "Not triaged" : `Urgency ${m.urgency.toFixed(2)} of 3`}
                    >
                      {level === null ? "Unread" : URGENCY[level]}
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
                        <span className="shrink-0 font-medium text-foreground">{name(m.from)}</span>
                        <span className="truncate text-foreground">{m.subject}</span>
                      </div>
                      <div className="truncate text-[12px] text-muted-foreground">{m.snippet}</div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground" style={tnum}>
                        <span>{short(m.account)}</span>
                        <span>{when(m.receivedAt)}</span>
                        {m.venture ? <span>{m.venture}</span> : null}
                        {m.handler ? <span>{HANDLER[m.handler] ?? m.handler}</span> : null}
                        {m.needsReply !== null ? <span title="Jev's probability that this needs a reply, and its confidence in the triage">Jev {m.needsReply.toFixed(2)}{m.confidence !== null ? ` · conf ${m.confidence.toFixed(2)}` : ""}</span> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <button
                        type="button"
                        disabled={!!busy || !project}
                        onClick={() => void hand(m)}
                        className="rounded-full px-2.5 py-1 text-[12px] font-medium bg-primary text-primary-foreground disabled:opacity-40"
                      >
                        {busy === m.id ? "Starting…" : "Hand to agent"}
                      </button>
                      {m.link ? (
                        <a href={m.link} target="_blank" rel="noopener noreferrer" className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground">
                          Open in Gmail
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

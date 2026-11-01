// "On the always-on Mac": chats handed over to the always-on Mac at home. The server polls
// the always-on Mac's bb; here we show a cloud on the row (colour = status there), and the
// row menu can send a chat over, open it on the always-on Mac, or pull its results back.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { experimental_useAppPanel as useAppPanel, useBbNavigate, useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { M1State } from "../server-m1";
import type { rpcContract } from "../server";
import { fieldArea } from "./controls";
import { mac, macLabel } from "./words";
import { getProfile, useProfile } from "./use-profile";
import { consoleSection } from "../lib/profile-console";
import type { Profile } from "../profile/schema";

export type M1Item = M1State["items"][string];

const EMPTY: M1State = { reachable: null, items: {} };

export function useM1() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<M1State>(EMPTY);
  const refetch = useCallback(() => {
    rpc.call("m1_state").then(setState, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("m1-handoffs", refetch);
  return state;
}

/** Where a status lands: working, finished, failed, or not known right now. */
export function m1Tone(status: string): { color: string; label: string; pulse: boolean } {
  if (["active", "starting", "running", "provisioning", "queued"].includes(status)) return { color: "var(--attention)", label: "working", pulse: true };
  if (status === "idle") return { color: "var(--success)", label: "finished", pulse: false };
  if (["error", "failed"].includes(status)) return { color: "var(--destructive)", label: "stopped with an error", pulse: false };
  if (status === "stopped") return { color: "var(--muted-foreground)", label: "stopped", pulse: false };
  return { color: "var(--muted-foreground)", label: `status unknown (${macLabel()} not reachable)`, pulse: false };
}

export function CloudGlyph({ size = 13, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

const open = (url: string) => window.open(url, "_blank", "noopener");

/** The cloud on a chat row. Clicking it opens the chat with its "On the always-on Mac" panel. */
export function M1Mark({ item, threadId }: { item: M1Item; threadId: string }) {
  useProfile();
  const nav = useBbNavigate();
  const panel = useAppPanel();
  const t = m1Tone(item.status);
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    nav.toThread(threadId);
    window.setTimeout(() => panel.openTab({ tab: { id: "m1", context: { kind: "thread" }, availability: "action" }, title: `On ${mac()}` }), 400);
  };
  return (
    <span
      role="link"
      tabIndex={-1}
      onClick={onClick}
      title={`On ${mac()}: ${t.label}. Click to see it.`}
      className={t.pulse ? "inline-flex shrink-0 animate-pulse cursor-pointer" : "inline-flex shrink-0 cursor-pointer"}
    >
      <CloudGlyph size={14} color={t.color} />
    </span>
  );
}

export function useM1Actions() {
  useProfile();
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const say = (threadId: string, text: string) =>
    sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
  return {
    /** The plugin writes the brief from the conversation and sends it, so a stuck chat can still be handed over. */
    send: (thread: { id: string; displayTitle: string; providerId: string }) => {
      const id = toast.loading(`Sending to ${mac()}…`, { description: "Reading the chat and writing the handoff." });
      return rpc.call("m1_handoff", { threadId: thread.id, title: thread.displayTitle, providerId: thread.providerId }).then(
        (res) =>
          toast.success(`On ${mac()} now`, {
            id,
            description: res.notes.length ? res.notes.join(" · ") : "The cloud on this chat shows how it's doing.",
            action: res.url ? { label: "Watch", onClick: () => open(res.url) } : undefined,
          }),
        (e: unknown) => toast.error(`Send to ${mac()} failed`, { id, description: e instanceof Error ? e.message : String(e) }),
      );
    },
    watch: (item: M1Item) => (item.url ? open(item.url) : toast.error(`No link for this chat on ${mac()}`)),
    pull: (threadId: string, item: M1Item) =>
      say(threadId, pullRequest(item.m1Thread)).then(
        () => toast.success(`Pulling the results from ${mac()}`),
        (e: unknown) => toast.error("Pull failed", { description: e instanceof Error ? e.message : String(e) }),
      ),
  };
}

/** What the agent is asked to do to bring a handed-over chat's results back. It names the hand-over helper only when the profile sets one. */
export function pullRequest(m1Thread: string, profile: Profile = getProfile()): string {
  const target = `that ${macLabel()} chat's results to this Mac, then list the local files`;
  return consoleSection(profile).handoffScript !== null
    ? `Use the hand-over helper: run \`m1 pull ${m1Thread}\` to bring ${target}.`
    : `Bring ${target}. The chat on the always-on Mac is ${m1Thread}.`;
}

/* ------------------- watching the always-on Mac from inside the chat ------------------- */

type M1Log = { mapped: boolean; m1Thread: string; url: string; log: string; error: string | null };

/** The always-on Mac side of this chat, refreshed every 10 seconds while shown. */
function useM1Log(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<M1Log | null>(null);
  const load = useCallback(() => {
    rpc.call("m1_log", { threadId }).then(setData, () => undefined);
  }, [rpc, threadId]);
  useEffect(() => {
    load();
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10_000);
    return () => window.clearInterval(t);
  }, [load]);
  return { data, reload: load };
}

/** Top-right button on a chat that has been sent to the always-on Mac: status, and opens the panel. */
export function M1HeaderButton({ threadId }: { threadId: string }) {
  useProfile();
  const state = useM1();
  const panel = useAppPanel();
  const item = state.items[threadId];
  if (!item) return null;
  const t = m1Tone(item.status);
  return (
    <button
      type="button"
      title={`See what ${mac()} is doing with this chat`}
      data-nav-part="header-action"
      onClick={() => panel.openTab({ tab: { id: "m1", context: { kind: "thread" }, availability: "action" }, title: `On ${mac()}` })}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <span className={t.pulse ? "inline-flex animate-pulse" : "inline-flex"}>
        <CloudGlyph size={14} color={t.color} />
      </span>
      {macLabel()} · {t.label.split(" (")[0]}
    </button>
  );
}

/** Side panel: the always-on Mac chat's recent turns, live, with a reply box and Pull results. */
export function M1Panel({ threadId }: { threadId: string }) {
  useProfile();
  const state = useM1();
  const item = state.items[threadId];
  const { data, reload } = useM1Log(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const actions = useM1Actions();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // Newest at the bottom, like the chat itself.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [data?.log]);

  if (!item && data && !data.mapped) {
    return (
      <div className="p-4 text-[13px] text-muted-foreground">
        This chat hasn't been sent to {mac()}. Right-click it in the sidebar and choose "Send to {mac()}".
      </div>
    );
  }
  const t = m1Tone(item?.status ?? "unknown");
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    rpc.call("m1_tell", { threadId, text: body }).then(
      () => {
        setText("");
        toast.success(`Sent to ${mac()}`);
        window.setTimeout(reload, 1500);
      },
      (e: unknown) => toast.error("Not sent", { description: e instanceof Error ? e.message : String(e) }),
    ).finally(() => setSending(false));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-[13px]">
        <span className={t.pulse ? "inline-flex animate-pulse" : "inline-flex"}>
          <CloudGlyph size={14} color={t.color} />
        </span>
        <span className="text-foreground">On {mac()}: {t.label}</span>
        <div className="ml-auto flex gap-1.5">
          {item ? (
            <button type="button" onClick={() => void actions.pull(threadId, item)} className="rounded-md border border-border px-2 py-0.5 text-[12px] text-foreground hover:border-foreground">
              Pull results
            </button>
          ) : null}
          {item?.url ? (
            <button type="button" onClick={() => open(item.url)} className="rounded-md border border-border px-2 py-0.5 text-[12px] text-foreground hover:border-foreground">
              Open there
            </button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!data ? (
          <div className="text-[12px] text-muted-foreground">Reading {mac()}…</div>
        ) : data.error ? (
          <div className="text-[12px] text-destructive-text">{data.error}</div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground">{data.log.trim() || "Nothing yet."}</pre>
        )}
        <div ref={endRef} />
      </div>
      <div className="border-t border-border p-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
          placeholder={`Tell ${mac()} something (⌘↵ to send)`}
          rows={2}
          className={`${fieldArea} w-full resize-none outline-none focus:border-ring`}
        />
        <div className="mt-1.5 flex justify-end">
          <button type="button" disabled={sending || !text.trim()} onClick={send} className="rounded-md bg-foreground px-3 py-1 text-[12px] font-medium text-background disabled:opacity-40">
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

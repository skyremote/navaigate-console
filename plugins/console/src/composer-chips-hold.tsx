// "Send when sub-agents finish": shown in a chat's chip row only while it has
// running child threads. It takes the typed message out of the composer and
// the server holds it (plugin kv, so reloads keep it) until every child has
// finished, then sends it to this chat. While held, a pill says how many it
// is waiting for; its cancel button puts the text back in the composer.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { HoldState } from "../server-hold";
import { useComposerHandle } from "./composer-bridge";

const chip =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs leading-tight text-muted-foreground transition-colors " +
  "hover:bg-state-hover hover:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

function useHold(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [s, setS] = useState<HoldState | null>(null);
  const refetch = useCallback(() => {
    rpc.call("hold_state", { threadId }).then(setS, () => undefined);
  }, [rpc, threadId]);
  useEffect(() => {
    setS(null);
    refetch();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refetch();
    }, 5_000);
    return () => window.clearInterval(id);
  }, [refetch]);
  useRealtime("holds", refetch);
  return { s, setS, refetch };
}

function HourGlass({ color = "currentColor" }: { color?: string }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

const plural = (n: number) => `${n} sub-agent${n === 1 ? "" : "s"}`;

export function HoldChip({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const handle = useComposerHandle(threadId);
  const { s, setS } = useHold(threadId);
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const n = s.running.length;

  if (s.hold) {
    const cancel = () => {
      setBusy(true);
      rpc
        .call("hold_cancel", { threadId })
        .then(
          ({ text }) => {
            setS({ ...s, hold: null });
            if (text && handle) handle.api.replace((current) => {
              const prefix = current.text ? `${text}\n\n` : text;
              return {
                text: prefix + current.text,
                mentions: current.mentions.map((mention) => ({ ...mention, from: mention.from + prefix.length, to: mention.to + prefix.length })),
              };
            });
            toast.success("Not held any more", { description: text ? "The message is back in the chat box." : undefined });
          },
          (e: unknown) => toast.error("Could not cancel", { description: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => setBusy(false));
    };
    const label = s.hold.error ? "Held · could not send" : n ? `Held · waiting for ${plural(n)}` : "Held · sending…";
    return (
      <span
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border pl-2 pr-0.5 text-xs leading-tight"
        style={{ color: s.hold.error ? "var(--destructive)" : "var(--foreground)" }}
        title={s.hold.error ? `The held message could not be sent: ${s.hold.error}` : `"${s.hold.text.slice(0, 160)}" goes to this chat once ${n ? s.running.map((r) => r.title).join(", ") : "they"} finish.`}
      >
        <span className={n && !s.hold.error ? "inline-flex animate-pulse" : "inline-flex"}>
          <HourGlass color="currentColor" />
        </span>
        {label}
        <button
          type="button"
          disabled={busy}
          onClick={cancel}
          className="ml-0.5 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-state-hover hover:text-foreground"
          aria-label="Cancel the hold and put the message back"
          title="Cancel: put the message back in the chat box"
        >
          <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </span>
    );
  }

  if (!n) return null;
  const empty = !handle || handle.view.draft.isEmpty;
  const hold = () => {
    if (!handle) return;
    const draft = handle.api.draft;
    const text = draft.text.trim();
    if (!text) return;
    setBusy(true);
    rpc
      .call("hold_create", { threadId, text })
      .then(
        (next) => {
          // Hold stores text only: leave attachments in the composer, and do
          // not erase anything typed while the server accepted the hold.
          handle.api.replace((current) => current.text === draft.text && current.mentions === draft.mentions ? { text: "", mentions: [] } : current);
          setS(next);
          toast.success(`Held until ${plural(next.running.length)} finish`, { description: "It goes to this chat by itself. Cancel on the pill puts it back." });
        },
        (e: unknown) => toast.error("Not held", { description: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      className={chip}
      disabled={busy || empty}
      onClick={hold}
      title={empty ? `Type a message first; it waits for ${plural(n)} to finish` : `Send this once the ${plural(n)} working in this chat have finished`}
    >
      <HourGlass color="currentColor" />
      Send when sub-agents finish
    </button>
  );
}

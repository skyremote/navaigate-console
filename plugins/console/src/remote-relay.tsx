// Ask and Tell for a chat on another Mac, from its row in the rail. Tell sends
// text into that chat through Fleet's thread_tell; Ask starts a new chat on that
// Mac in the same project (Fleet's work_start) and reads the answer back by its
// receipt. Reading an answer is one click, never a timer. Fleet releases older
// than these methods answer "offered: false"; the dialog then says what the
// Fleet cannot do yet, keeps the text, and points at the chat on its own bb.
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { RemoteThread } from "./machines";
import { outlineButton, fieldArea } from "./controls";
import { machineName } from "./words";

export type RelayMode = "tell" | "ask";
type Status = { tone: "ok" | "bad" | "note"; text: string };
type Answer = { text: string; state: string | null; truncated: boolean };

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const mintId = () => globalThis.crypto.randomUUID();

export const TELL_NOT_OFFERED = "This Fleet does not offer Tell yet. Your text is kept here; open the chat on its own bb to send it there.";
export const READ_NOT_OFFERED = "This Fleet cannot read answers back yet. Open the chat on its own bb to see it.";

const control = outlineButton;

function ModeButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("inline-flex h-7 items-center rounded-md px-2.5 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring", on ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {children}
    </button>
  );
}

export function RelayDialog({ thread, mode, onMode, open, onOpenChange }: { thread: RemoteThread; mode: RelayMode; onMode: (mode: RelayMode) => void; open: boolean; onOpenChange: (open: boolean) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const scope = usePortalScopeProps();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asked, setAsked] = useState<{ readId: string; url: string | null } | null>(null);
  const request = useRef<{ draft: string; id: string } | null>(null);
  const machine = thread.machine;
  const shown = machineName(machine);
  const url = asked?.url ?? thread.url;

  const switchTo = (next: RelayMode) => {
    onMode(next);
    setStatus(null);
    setAnswer(null);
  };

  const submit = async () => {
    const text = draft.trim();
    if (text === "" || busy) return;
    request.current = request.current?.draft === text ? request.current : { draft: text, id: mintId() };
    const requestId = request.current.id;
    setBusy(true);
    setStatus(null);
    setAnswer(null);
    try {
      if (mode === "tell") {
        const sent = await rpc.call("fleet_tell", { machine, threadId: thread.id, message: text, requestId });
        if (!sent.offered) {
          setStatus({ tone: "note", text: TELL_NOT_OFFERED });
          return;
        }
        setStatus({ tone: "ok", text: sent.delivered ? `Delivered to ${shown}${sent.delivery === "queued" ? " (queued behind the current turn)" : ""}. Receipt ${sent.requestId}` : `Queued for ${shown}; it is not delivered yet. Receipt ${sent.requestId}${sent.note ?? ""}` });
      } else {
        const started = await rpc.call("fleet_start", { machine, prompt: text, requestId, ...(thread.projectName ? { projectName: thread.projectName } : {}) });
        setAsked({ readId: started.requestId ?? started.commandId ?? requestId, url: started.url ?? null });
        setStatus({ tone: "ok", text: started.outcome === "started" ? `Started on ${shown}. Read the answer when it has finished.` : `Sent to ${shown}; it starts when the machine picks it up.` });
      }
      request.current = null;
      setDraft("");
    } catch (cause) {
      setStatus({ tone: "bad", text: reason(cause) });
    } finally {
      setBusy(false);
    }
  };

  const readLatest = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const found = await rpc.call("fleet_output", { machine, threadId: thread.id });
      if (!found.offered) {
        setAnswer(null);
        setStatus({ tone: "note", text: READ_NOT_OFFERED });
      } else setAnswer({ text: found.output, state: found.state, truncated: found.truncated });
    } catch (cause) {
      setStatus({ tone: "bad", text: reason(cause) });
    } finally {
      setBusy(false);
    }
  };

  const readAsk = async () => {
    if (!asked) return;
    setBusy(true);
    setStatus(null);
    try {
      const found = await rpc.call("fleet_receipt", { id: asked.readId });
      if (!found.offered) {
        setAnswer(null);
        setStatus({ tone: "note", text: READ_NOT_OFFERED });
        return;
      }
      if (found.url && found.url !== asked.url) setAsked({ ...asked, url: found.url });
      if (found.state === "failed") setStatus({ tone: "bad", text: found.message ?? "The answer could not be read" });
      else if (found.state === "pending") setStatus({ tone: "note", text: `Still working${found.message ? `: ${found.message}` : ""}` });
      if (found.output !== null) setAnswer({ text: found.output, state: null, truncated: found.truncated });
    } catch (cause) {
      setStatus({ tone: "bad", text: reason(cause) });
    } finally {
      setBusy(false);
    }
  };

  const heading = mode === "tell" ? `Tell ${shown} about ${thread.title}` : `Ask ${shown}`;
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" />
        <Dialog.Content {...scope} className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[min(520px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-xl">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border p-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-medium">{heading}</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                {mode === "tell"
                  ? `Sends your text into this chat on ${shown} as a follow-up.`
                  : `Starts a new chat on ${shown}${thread.projectName ? ` in ${thread.projectName}` : ""} and runs your question there.`}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">Close</Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex gap-1" role="group" aria-label="What to do">
              <ModeButton on={mode === "tell"} onClick={() => switchTo("tell")}>Tell this chat</ModeButton>
              <ModeButton on={mode === "ask"} onClick={() => switchTo("ask")}>{`Ask ${shown}`}</ModeButton>
            </div>
            <textarea
              aria-label={heading}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKey}
              placeholder={mode === "tell" ? "A follow-up, a correction or a long text to send into this chat" : `What should ${shown} find out or do?`}
              className={`${fieldArea} min-h-[88px] w-full resize-y leading-snug outline-none focus-visible:ring-1 focus-visible:ring-ring`}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={control} disabled={busy || draft.trim() === ""} onClick={() => void submit()}>{busy ? "Working…" : `Send to ${shown}`}</button>
              {mode === "tell" ? <button type="button" className={control} disabled={busy} onClick={() => void readLatest()}>Read latest answer</button> : null}
              {mode === "ask" && asked ? <button type="button" className={control} disabled={busy} onClick={() => void readAsk()}>Read the answer</button> : null}
              {url ? <button type="button" className={control} onClick={() => nav.openUrl(url)}>{`Open on ${shown}`}</button> : null}
              <span className="text-[11px] text-muted-foreground">Cmd+Enter</span>
            </div>
            {status ? (
              <p role={status.tone === "bad" ? "alert" : "status"} className={cn("break-words text-[12px] leading-snug", status.tone === "bad" ? "text-destructive-text" : "text-muted-foreground")}>
                {status.text}
              </p>
            ) : null}
            {answer ? (
              <div>
                <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 text-[12px] leading-snug text-foreground">{answer.text.trim() === "" ? "(no answer text yet)" : answer.text}</pre>
                <p className="mt-1 text-[11px] text-muted-foreground">{[answer.state, answer.truncated ? "answer cut to 64 KB; open the chat for all of it" : null].filter(Boolean).join(" · ")}</p>
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { nextRequestId, readAnswerOf, submitRelay, type RelayAnswer, type RelayCalls, type RelayStatus } from "../lib/relay-submit";

export const RELAY_STYLE = `
.rl{display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--foreground)}
.rl :is(button,input,textarea):focus-visible{outline:none;box-shadow:0 0 0 2px var(--ring)}
.rl textarea{width:100%;min-height:56px;resize:vertical;background:var(--background);border:1px solid var(--input);border-radius:var(--radius);padding:6px 8px;color:var(--foreground);font:inherit;font-size:13px;line-height:1.4}
.rl-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.rl-btn{font:inherit;font-size:13px;min-height:32px;padding:4px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--secondary);color:var(--secondary-foreground);cursor:pointer;transition:background-color .15s}
.rl-btn:hover:not(:disabled){background:var(--accent)}
.rl-btn.p{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
.rl-btn:disabled{opacity:.5;cursor:default}
.rl-label{font-size:12px;color:var(--muted-foreground)}
.rl-ok{color:var(--success)}
.rl-bad{color:var(--destructive-text)}
.rl-answer{background:var(--surface-recessed);border-radius:var(--radius);padding:8px;white-space:pre-wrap;max-height:180px;overflow:auto;font-size:13px;line-height:1.45}
`;


export interface RelayActionsViewProps {
  mode: "ask" | "tell";
  machine: string;
  threadTitle: string | null;
  draft: string;
  busy: boolean;
  status: RelayStatus | null;
  answer: RelayAnswer | null;
  onDraft: (value: string) => void;
  onSubmit: () => void;
  onReadAnswer: () => void;
}

export function RelayActionsView({ mode, machine, threadTitle, draft, busy, status, answer, onDraft, onSubmit, onReadAnswer }: RelayActionsViewProps) {
  const canSend = !busy && draft.trim() !== "";
  const heading = mode === "tell" ? `Tell ${machine} about ${threadTitle ?? "this thread"}` : `Ask ${machine}`;
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onSubmit();
  };
  return (
    <div className="rl">
      <style>{RELAY_STYLE}</style>
      <div className="rl-label">{heading}</div>
      <textarea aria-label={heading} value={draft} placeholder={mode === "tell" ? "A follow-up, correction or long text to send into this thread" : `What should ${machine} do? Its answer shows under Sent from here`} onChange={(event) => onDraft(event.target.value)} onKeyDown={onKey} />
      <div className="rl-row">
        <button type="button" className="rl-btn p" disabled={!canSend} onClick={onSubmit}>{busy ? "Sending..." : `Send to ${machine}`}</button>
        {mode === "tell" ? <button type="button" className="rl-btn" disabled={busy} onClick={onReadAnswer}>Read latest answer</button> : null}
        <span className="rl-label">Cmd+Enter</span>
      </div>
      {status ? <div className={status.tone === "ok" ? "rl-ok" : status.tone === "bad" ? "rl-bad" : "rl-label"} role="status">{status.text}</div> : null}
      {answer ? (
        <>
          <div className="rl-answer">{answer.text.trim() === "" ? "(no answer text yet)" : answer.text}</div>
          <div className="rl-label">{answer.state}{answer.truncated ? " · answer cut to 64 KB; open the thread for all of it" : ""}</div>
        </>
      ) : null}
    </div>
  );
}

export function RelayActions({ machine, threadId, threadTitle, onSent }: { machine: string; threadId: string | null; threadTitle?: string | null; onSent?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [answer, setAnswer] = useState<RelayAnswer | null>(null);
  const request = useRef<{ draft: string; id: string } | null>(null);
  const calls: RelayCalls = {
    thread_tell: (input) => rpc.call("thread_tell", input),
    work_start: (input) => rpc.call("work_start", input),
    thread_output_get: (input) => rpc.call("thread_output_get", input),
  };

  const submit = async () => {
    const text = draft.trim();
    if (text === "" || busy) return;
    request.current = nextRequestId(request.current, text);
    setBusy(true);
    setStatus(null);
    const result = await submitRelay(calls, { machine, threadId, text, requestId: request.current.id });
    setStatus(result.status);
    if (result.ok) {
      request.current = null;
      setDraft("");
      onSent?.();
    }
    setBusy(false);
  };

  const readAnswer = async () => {
    if (threadId === null) return;
    setBusy(true);
    const result = await readAnswerOf(calls, machine, threadId);
    if (result.ok) { setAnswer(result.answer); setStatus(null); } else setStatus(result.status);
    setBusy(false);
  };

  return <RelayActionsView mode={threadId === null ? "ask" : "tell"} machine={machine} threadTitle={threadTitle ?? null} draft={draft} busy={busy} status={status} answer={answer} onDraft={setDraft} onSubmit={() => void submit()} onReadAnswer={() => void readAnswer()} />;
}

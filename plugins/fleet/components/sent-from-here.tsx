import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, SentReceipt } from "../server";
import { isReceiptId, mergeSent, type BoardCommand, type SentRow } from "../lib/sent-receipts";
import { useVisiblePoll } from "../lib/visible-poll";
import { RELAY_STYLE } from "./relay-actions";
import { ago } from "./owner-refresh";

export interface ReadResult {
  state: "ready" | "pending" | "failed";
  message: string | null;
  answer: { output: string; truncated: boolean; state: string } | null;
}

const KIND_LABEL: Record<SentRow["kind"], string> = { ask: "Ask", tell: "Tell", start: "To" };

function Result({ result }: { result: ReadResult }) {
  return (
    <div className="rl">
      {result.state === "pending" ? <div className="rl-label">Still working{result.message ? `: ${result.message}` : ""}</div> : null}
      {result.state === "failed" ? <div className="rl-bad" role="alert">{result.message ?? "The answer could not be read"}</div> : null}
      {result.answer ? <div className="rl-answer">{result.answer.output.trim() === "" ? "(no answer text yet)" : result.answer.output}</div> : null}
      {result.answer?.truncated ? <div className="rl-label">Answer cut to 64 KB; open the thread for all of it</div> : null}
    </div>
  );
}

export interface SentFromHereViewProps {
  rows: SentRow[];
  results: Record<string, ReadResult>;
  lookup: string;
  lookupResult: ReadResult | null;
  now: number;
  onLookupChange: (value: string) => void;
  onLookup: () => void;
  onRead: (row: SentRow) => void;
  onOpen: (url: string) => void;
}

export function SentFromHereView({ rows, results, lookup, lookupResult, now, onLookupChange, onLookup, onRead, onOpen }: SentFromHereViewProps) {
  return (
    <div className="fleet-sent">
      <style>{RELAY_STYLE}</style>
      <h3>Sent from here</h3>
      {rows.length === 0 ? <div className="fleet-meta">Nothing sent from this Mac yet</div> : null}
      {rows.map((row) => (
        <div key={row.key}>
          <div className="fleet-sent-row">
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {row.kind === "start" ? `To ${row.machine}: ${row.title ?? "new task"}` : `${KIND_LABEL[row.kind]} ${row.machine}`}
              <span className="fleet-meta"> · {ago(row.at, now)} · {row.status} · {row.readId}</span>
            </span>
            <span className="rl-row">
              {row.canRead ? <button type="button" className="rl-btn" onClick={() => onRead(row)}>Read answer</button> : null}
              {row.url ? <button type="button" className="rl-btn" onClick={() => onOpen(row.url as string)}>Open</button> : null}
            </span>
          </div>
          {results[row.readId] ? <Result result={results[row.readId]!} /> : null}
        </div>
      ))}
      <div className="rl-row" style={{ marginTop: 8 }}>
        <input aria-label="Command or request id" className="fm-input" style={{ width: 260 }} value={lookup} placeholder="Command or request id" onChange={(event) => onLookupChange(event.target.value)} />
        <button type="button" className="rl-btn" disabled={!isReceiptId(lookup)} onClick={onLookup}>Read result</button>
      </div>
      {lookupResult ? <Result result={lookupResult} /> : null}
    </div>
  );
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function SentFromHere({ commands, refreshKey, watchId = null, onOpen }: { commands: BoardCommand[]; refreshKey: number; watchId?: string | null; onOpen: (url: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [receipts, setReceipts] = useState<SentReceipt[]>([]);
  const [results, setResults] = useState<Record<string, ReadResult>>({});
  const [lookup, setLookup] = useState("");
  const [lookupResult, setLookupResult] = useState<ReadResult | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadReceipts = useCallback(() => {
    rpc.call("receipts_list", null).then((list) => { setReceipts(list); setNow(Date.now()); }, () => undefined);
  }, [rpc]);
  useEffect(loadReceipts, [loadReceipts, refreshKey]);
  useVisiblePoll(loadReceipts, 30_000);

  const read = useCallback(async (id: string): Promise<ReadResult> => {
    try {
      const found = await rpc.call("receipt_result", { id });
      return { state: found.state, message: found.message, answer: found.answer ? { output: found.answer.output, truncated: found.answer.truncated, state: found.answer.state } : null };
    } catch (cause) {
      return { state: "failed", message: reason(cause), answer: null };
    }
  }, [rpc]);

  useEffect(() => {
    if (watchId === null) return;
    void read(watchId).then((value) => setResults((current) => ({ ...current, [watchId]: value })));
  }, [watchId, read]);

  const pending = Object.entries(results).filter(([, value]) => value.state === "pending").map(([id]) => id).join("|");
  useVisiblePoll(() => { for (const id of pending.split("|").filter(Boolean)) void read(id).then((value) => setResults((current) => ({ ...current, [id]: value }))); }, pending ? 15_000 : null);

  return (
    <SentFromHereView
      rows={mergeSent(commands, receipts)}
      results={results}
      lookup={lookup}
      lookupResult={lookupResult}
      now={now}
      onLookupChange={(value) => { setLookup(value); setLookupResult(null); }}
      onLookup={() => void read(lookup.trim()).then(setLookupResult)}
      onRead={(row) => void read(row.readId).then((value) => setResults((current) => ({ ...current, [row.readId]: value })))}
      onOpen={onOpen}
    />
  );
}

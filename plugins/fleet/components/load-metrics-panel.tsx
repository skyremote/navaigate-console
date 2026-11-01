import { useCallback, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { LOW_BANDWIDTH_BUDGET, formatBytes, summariseMetrics, type MetricsResult, type OpenReading, type OpenRow } from "../lib/load-metrics";
import type { mirrorMetricsContract } from "../mirror/metrics-contract";

type Summary = ReturnType<typeof summariseMetrics>;

const VERDICT_LABEL: Record<OpenRow["verdict"], string> = { within: "Within budget", over: "Over budget", pending: "Still loading", failed: "Failed" };
const seconds = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`);

const tone = (verdict: OpenRow["verdict"]) => (verdict === "within" ? "ok" : verdict === "over" ? "bad" : "");

function OpenCell({ reading, empty }: { reading: OpenReading | null; empty: string }) {
  if (reading === null) return <span className="fm-muted">{empty}</span>;
  return (
    <>
      <span className={`fm-chip ${tone(reading.verdict)}`}>{seconds(reading.latencyMs)}</span>
      {formatBytes(reading.bytes)}
      {reading.reasons.map((reason) => <div key={reason} className="fm-muted">{reason}</div>)}
    </>
  );
}

export function LoadMetricsView({ summary, loading, error, onLoad }: { summary: Summary | null; loading: boolean; error: string | null; onLoad: () => void }) {
  return (
    <div className="fm-card">
      <div className="fm-row" style={{ justifyContent: "space-between" }}>
        <h3>Thread load metrics</h3>
        <button type="button" className="fm-btn" disabled={loading} onClick={onLoad}>{loading ? "Loading..." : summary ? "Reload metrics" : "Load metrics"}</button>
      </div>
      <div className="fm-muted">Cold is the first open of a chat on this Mac and warm is a reopen of its saved copy. Bytes, open time, cursors and reads for mirrored chats opened on this Mac: no message content. Budget for a 200-turn chat: under {formatBytes(LOW_BANDWIDTH_BUDGET.bytes)} and under {LOW_BANDWIDTH_BUDGET.openMs / 1000} s.</div>
      {error ? <div className="fm-muted" role="alert">{error}</div> : null}
      {summary ? (
        <>
          <div className="fm-row" style={{ marginTop: 6 }}>
            <span className="fm-chip">{summary.totals.reads} reads</span>
            <span className="fm-chip">{formatBytes(summary.totals.bytes)} read</span>
            <span className="fm-chip">{Math.round(summary.totals.avgReadMs)} ms per read</span>
            <span className="fm-chip">{Math.round(summary.totals.duplicateShare * 100)}% duplicate events</span>
            {summary.totals.avgRenderMs !== null ? <span className="fm-chip">{Math.round(summary.totals.avgRenderMs)} ms render</span> : null}
            <span className={`fm-chip ${summary.passed.judged > 0 && summary.passed.within === summary.passed.judged ? "ok" : ""}`}>{summary.passed.within} of {summary.passed.judged} opens within budget</span>
          </div>
          {summary.chats.length > 0 ? (
            <table className="fm-table">
              <thead><tr><th>Chat</th><th>Cold open</th><th>Warm open</th></tr></thead>
              <tbody>
                {summary.chats.map((row) => (
                  <tr key={row.chat}>
                    <td>Chat {row.chat.slice(0, 6)}</td>
                    <td><OpenCell reading={row.cold} empty="no cold open yet" /></td>
                    <td><OpenCell reading={row.warm} empty="no warm open yet" />{row.warmOpens > 1 ? <div className="fm-muted">latest of {row.warmOpens} warm opens</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {summary.opens.length === 0 ? <div className="fm-muted">No mirrored chat has been opened yet.</div> : (
            <table className="fm-table">
              <thead><tr><th>Opened</th><th>Kind</th><th>Read</th><th>Open time</th><th>Reads (first / catch-up / earlier)</th><th>Cursor</th><th>Result</th></tr></thead>
              <tbody>
                {summary.opens.map((row) => (
                  <tr key={row.openId}>
                    <td>{new Date(row.openedAt).toLocaleTimeString()}</td>
                    <td>{row.temperature === "cold" ? "Cold" : "Warm"}</td>
                    <td>{formatBytes(row.bytes)}</td>
                    <td>{seconds(row.latencyMs)}</td>
                    <td>{row.initial} / {row.delta} / {row.history}</td>
                    <td>{row.cursor ?? "-"}</td>
                    <td><span className={`fm-chip ${row.verdict === "within" ? "ok" : row.verdict === "over" || row.verdict === "failed" ? "bad" : ""}`}>{VERDICT_LABEL[row.verdict]}</span>{row.reasons.map((reason) => <div key={reason} className="fm-muted">{reason}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="fm-muted">Phone test on throttled 3G is still to run: it needs a physical phone.</div>
        </>
      ) : null}
    </div>
  );
}

export function LoadMetricsPanel() {
  const rpc = useRpc<typeof mirrorMetricsContract>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    rpc.call("mirror_metrics_get", {}).then((value: MetricsResult) => { setSummary(summariseMetrics(value)); setError(null); }, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false));
  }, [rpc]);
  return <LoadMetricsView summary={summary} loading={loading} error={error} onLoad={load} />;
}

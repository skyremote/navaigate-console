import type { z } from "zod";
import type { mirrorMetricsContract } from "../mirror/metrics-contract";

export type MetricsResult = z.infer<typeof mirrorMetricsContract.mirror_metrics_get.output>;

/** The F77 acceptance gate: a 200-turn conversation opens under 500 KB and under 5 s. */
export const LOW_BANDWIDTH_BUDGET = { bytes: 500_000, openMs: 5_000 } as const;

export function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  const trim = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ""));
  if (value < 1_000_000) return `${trim(value / 1_000)} KB`;
  return `${trim(value / 1_000_000)} MB`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;

export type OpenVerdict = "within" | "over" | "pending" | "failed";
export interface OpenRow {
  openId: string;
  chat: string;
  temperature: "cold" | "warm";
  openedAt: number;
  outcome: MetricsResult["opens"][number]["outcome"];
  verdict: OpenVerdict;
  reasons: string[];
  bytes: number;
  reads: number;
  initial: number;
  delta: number;
  history: number;
  latencyMs: number | null;
  renderMs: number | null;
  cursor: number | null;
}

/** One open of a chat, as shown beside the other temperature. */
export interface OpenReading { latencyMs: number | null; bytes: number; verdict: OpenVerdict; reasons: string[] }
/** A chat's first (cold) open and its newest later (warm) open; opens that are still loading or failed are left out. */
export interface ChatRow { chat: string; cold: OpenReading | null; warm: OpenReading | null; warmOpens: number }

function chatRows(opens: OpenRow[]): ChatRow[] {
  const chats = new Map<string, OpenRow[]>();
  for (const row of opens) chats.set(row.chat, [...(chats.get(row.chat) ?? []), row]);
  const reading = (row: OpenRow | undefined): OpenReading | null => (row ? { latencyMs: row.latencyMs, bytes: row.bytes, verdict: row.verdict, reasons: row.reasons } : null);
  const newest = (rows: OpenRow[]) => Math.max(...rows.map((row) => row.openedAt));
  return [...chats.values()].sort((a, b) => newest(b) - newest(a)).map((rows) => {
    const finished = rows.filter((row) => row.verdict === "within" || row.verdict === "over").sort((a, b) => b.openedAt - a.openedAt);
    return {
      chat: rows[0]!.chat,
      cold: reading(finished.find((row) => row.temperature === "cold")),
      warm: reading(finished.find((row) => row.temperature === "warm")),
      warmOpens: finished.filter((row) => row.temperature === "warm").length,
    };
  });
}

export function summariseMetrics(result: MetricsResult) {
  const opens: OpenRow[] = result.opens.map((entry) => {
    const bytes = entry.counts.readBytes;
    const reasons: string[] = [];
    if (bytes > LOW_BANDWIDTH_BUDGET.bytes) reasons.push(`${formatBytes(bytes)} read (limit ${formatBytes(LOW_BANDWIDTH_BUDGET.bytes)})`);
    if (entry.openLatencyMs !== null && entry.openLatencyMs > LOW_BANDWIDTH_BUDGET.openMs) reasons.push(`${seconds(entry.openLatencyMs)} to open (limit ${seconds(LOW_BANDWIDTH_BUDGET.openMs)})`);
    const verdict: OpenVerdict = entry.outcome === "opening" ? "pending" : entry.outcome === "ready" ? (reasons.length ? "over" : "within") : "failed";
    return {
      openId: entry.openId, chat: entry.chat, temperature: entry.temperature, openedAt: entry.openedAt, outcome: entry.outcome, verdict, reasons, bytes,
      reads: entry.counts.reads, initial: entry.counts.initialReads, delta: entry.counts.deltaReads, history: entry.counts.historyReads,
      latencyMs: entry.openLatencyMs, renderMs: entry.counts.renderSamples ? entry.counts.renderDurationMs / entry.counts.renderSamples : null, cursor: entry.cursor,
    };
  });
  const total = result.cumulative;
  const events = total.uniqueEvents + total.duplicateEvents;
  const judged = opens.filter((row) => row.verdict === "within" || row.verdict === "over");
  return {
    opens,
    chats: chatRows(opens),
    totals: {
      reads: total.reads,
      bytes: total.readBytes,
      avgReadMs: total.reads ? total.readDurationMs / total.reads : 0,
      duplicateShare: events ? total.duplicateEvents / events : 0,
      avgRenderMs: total.renderSamples ? total.renderDurationMs / total.renderSamples : null,
    },
    passed: { within: judged.filter((row) => row.verdict === "within").length, judged: judged.length },
  };
}

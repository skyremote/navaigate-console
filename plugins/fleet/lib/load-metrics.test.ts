import { describe, expect, it } from "vitest";
import { LOW_BANDWIDTH_BUDGET, formatBytes, summariseMetrics, type MetricsResult } from "./load-metrics";

const counts = (over: Partial<MetricsResult["cumulative"]> = {}): MetricsResult["cumulative"] => ({
  reads: 0, readBytes: 0, eventBytes: 0, eventOccurrences: 0, uniqueEvents: 0, duplicateEvents: 0, brokerReads: 0, brokerRowBytes: 0, brokerRowOccurrences: 0, uniqueBrokerRows: 0, duplicateBrokerRows: 0,
  initialReads: 0, deltaReads: 0, historyReads: 0, lookupReads: 0, failedReads: 0, readsWithoutBody: 0, cursorAdvances: 0, readDurationMs: 0, renderSamples: 0, renderDurationMs: 0, ...over,
});
type OpenInput = Partial<Omit<MetricsResult["opens"][number], "counts">> & { counts?: Partial<MetricsResult["cumulative"]> };
const open = (over: OpenInput): MetricsResult["opens"][number] => ({
  openId: "00000000-0000-4000-8000-000000000001", openedAt: 1_000, endedAt: 2_000, openLatencyMs: 800, outcome: "ready", cursor: 42, chat: "aaaaaaaaaaaa", temperature: "cold", ...over, counts: counts(over.counts),
});
const result = (opens: MetricsResult["opens"], cumulative = counts()): MetricsResult => ({ version: 1, units: { bytes: "serialized-utf8-json", latency: "server-monotonic-ms", render: "client-reported-ms" }, cumulative, opens, observedAt: 9_000 });

describe("formatBytes", () => {
  it("uses plain units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(48_300)).toBe("48.3 KB");
    expect(formatBytes(2_400_000)).toBe("2.4 MB");
  });
});

describe("summariseMetrics", () => {
  it("states the acceptance budget the readout is held to", () => {
    expect(LOW_BANDWIDTH_BUDGET).toEqual({ bytes: 500_000, openMs: 5_000 });
  });

  it("marks an open within budget when bytes and latency are both under the limit", () => {
    const summary = summariseMetrics(result([open({ counts: { readBytes: 120_000, reads: 5, initialReads: 1, deltaReads: 4 } })]));
    expect(summary.opens[0]).toMatchObject({ verdict: "within", bytes: 120_000, reads: 5, initial: 1, delta: 4, latencyMs: 800, cursor: 42 });
  });

  it("marks an open over budget and says which limit it broke", () => {
    const summary = summariseMetrics(result([open({ openLatencyMs: 6_200, counts: { readBytes: 700_000 } })]));
    expect(summary.opens[0]).toMatchObject({ verdict: "over", reasons: ["700 KB read (limit 500 KB)", "6.2 s to open (limit 5 s)"] });
  });

  it("does not judge an open that is still loading or that failed", () => {
    const summary = summariseMetrics(result([open({ outcome: "opening", openLatencyMs: null, endedAt: null }), open({ outcome: "failed", openId: "00000000-0000-4000-8000-000000000002" })]));
    expect(summary.opens.map((row) => row.verdict)).toEqual(["pending", "failed"]);
  });

  it("totals the cumulative reads, bytes and duplicate share without content", () => {
    const summary = summariseMetrics(result([], counts({ reads: 10, readBytes: 250_000, uniqueEvents: 90, duplicateEvents: 10, readDurationMs: 2_000, renderSamples: 2, renderDurationMs: 300 })));
    expect(summary.totals).toEqual({ reads: 10, bytes: 250_000, avgReadMs: 200, duplicateShare: 0.1, avgRenderMs: 150 });
  });

  it("reports how many opens passed so the phone gate is visible", () => {
    const summary = summariseMetrics(result([open({ counts: { readBytes: 1_000 } }), open({ openId: "00000000-0000-4000-8000-000000000003", openLatencyMs: 9_000 })]));
    expect(summary.passed).toEqual({ within: 1, judged: 2 });
  });
});

describe("cold and warm opens per chat", () => {
  const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  it("labels each open cold or warm and carries its chat", () => {
    const summary = summariseMetrics(result([open({ openId: id(2), temperature: "warm" }), open({ openId: id(1) })]));
    expect(summary.opens.map((row) => [row.temperature, row.chat])).toEqual([["warm", "aaaaaaaaaaaa"], ["cold", "aaaaaaaaaaaa"]]);
  });

  it("puts a chat's cold open time and bytes beside its latest warm open", () => {
    const summary = summariseMetrics(result([
      open({ openId: id(3), openedAt: 3_000, temperature: "warm", openLatencyMs: 300, counts: { readBytes: 4_000 } }),
      open({ openId: id(2), openedAt: 2_000, temperature: "warm", openLatencyMs: 500, counts: { readBytes: 9_000 } }),
      open({ openId: id(1), openedAt: 1_000, temperature: "cold", openLatencyMs: 2_400, counts: { readBytes: 150_000 } }),
    ]));
    expect(summary.chats).toHaveLength(1);
    expect(summary.chats[0]).toMatchObject({ chat: "aaaaaaaaaaaa", warmOpens: 2, cold: { latencyMs: 2_400, bytes: 150_000, verdict: "within" }, warm: { latencyMs: 300, bytes: 4_000, verdict: "within" } });
  });

  it("keeps separate chats apart and leaves the missing side empty", () => {
    const summary = summariseMetrics(result([
      open({ openId: id(2), chat: "bbbbbbbbbbbb", temperature: "warm", openedAt: 2_000 }),
      open({ openId: id(1), chat: "aaaaaaaaaaaa", temperature: "cold", openedAt: 1_000 }),
    ]));
    expect(summary.chats.map((row) => [row.chat, row.cold === null, row.warm === null])).toEqual([["bbbbbbbbbbbb", true, false], ["aaaaaaaaaaaa", false, true]]);
  });

  it("does not report an open that is still loading or failed as a cold or warm time", () => {
    const summary = summariseMetrics(result([open({ outcome: "failed", openLatencyMs: null }), open({ openId: id(2), outcome: "opening", openLatencyMs: null, temperature: "warm" })]));
    expect(summary.chats[0]).toMatchObject({ cold: null, warm: null });
  });

  it("marks a slow or heavy cold open over budget while the warm open stays within", () => {
    const summary = summariseMetrics(result([open({ openId: id(2), temperature: "warm", openLatencyMs: 200, counts: { readBytes: 2_000 } }), open({ openLatencyMs: 6_000, counts: { readBytes: 700_000 } })]));
    expect(summary.chats[0]).toMatchObject({ cold: { verdict: "over" }, warm: { verdict: "within" } });
  });
});

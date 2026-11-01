import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findAll } from "../lib/element-tree";
import { summariseMetrics, type MetricsResult } from "../lib/load-metrics";
import { LoadMetricsView } from "./load-metrics-panel";

const zero = { reads: 0, readBytes: 0, eventBytes: 0, eventOccurrences: 0, uniqueEvents: 0, duplicateEvents: 0, brokerReads: 0, brokerRowBytes: 0, brokerRowOccurrences: 0, uniqueBrokerRows: 0, duplicateBrokerRows: 0, initialReads: 0, deltaReads: 0, historyReads: 0, lookupReads: 0, failedReads: 0, readsWithoutBody: 0, cursorAdvances: 0, readDurationMs: 0, renderSamples: 0, renderDurationMs: 0 };
const metrics: MetricsResult = {
  version: 1, units: { bytes: "serialized-utf8-json", latency: "server-monotonic-ms", render: "client-reported-ms" }, observedAt: 5,
  cumulative: { ...zero, reads: 12, readBytes: 180_000, readDurationMs: 2400, uniqueEvents: 95, duplicateEvents: 5 },
  opens: [
    { openId: "00000000-0000-4000-8000-000000000001", openedAt: 1, endedAt: 2, openLatencyMs: 1200, outcome: "ready", cursor: 310, chat: "a1b2c3d4e5f6", temperature: "cold", counts: { ...zero, reads: 8, readBytes: 150_000, initialReads: 1, deltaReads: 7 } },
    { openId: "00000000-0000-4000-8000-000000000002", openedAt: 3, endedAt: 4, openLatencyMs: 7400, outcome: "ready", cursor: 12, chat: "f6e5d4c3b2a1", temperature: "cold", counts: { ...zero, reads: 4, readBytes: 30_000, initialReads: 1, deltaReads: 3 } },
  ],
};

describe("LoadMetricsView", () => {
  it("offers a Load metrics button before anything has been read", () => {
    const html = renderToStaticMarkup(createElement(LoadMetricsView, { summary: null, loading: false, error: null, onLoad: () => undefined }));
    expect(html).toContain("Load metrics");
    expect(html).toContain("no message content");
  });

  it("shows per-open bytes, latency and a pass or fail against the 500 KB and 5 s budget", () => {
    const html = renderToStaticMarkup(createElement(LoadMetricsView, { summary: summariseMetrics(metrics), loading: false, error: null, onLoad: () => undefined }));
    expect(html).toContain("150 KB");
    expect(html).toContain("1.2 s");
    expect(html).toContain("Within budget");
    expect(html).toContain("Over budget");
    expect(html).toContain("7.4 s to open (limit 5 s)");
    expect(html).toContain("1 of 2 opens within budget");
    expect(html).toContain("Phone test on throttled 3G is still to run");
  });

  it("shows each chat's cold and warm open time and bytes side by side", () => {
    const warm = { ...metrics.opens[0]!, openId: "00000000-0000-4000-8000-000000000003", openedAt: 5, openLatencyMs: 250, temperature: "warm" as const, counts: { ...metrics.opens[0]!.counts, readBytes: 8_000 } };
    const html = renderToStaticMarkup(createElement(LoadMetricsView, { summary: summariseMetrics({ ...metrics, opens: [warm, ...metrics.opens] }), loading: false, error: null, onLoad: () => undefined }));
    expect(html).toContain("Cold open");
    expect(html).toContain("Warm open");
    expect(html).toContain("Chat a1b2c3");
    expect(html).toContain("1.2 s");
    expect(html).toContain("0.3 s");
    expect(html).toContain("8 KB");
    expect(html).toContain("no warm open yet");
  });

  it("calls the loader when the button is pressed and shows an error from the server", () => {
    const onLoad = vi.fn();
    const tree = createElement(LoadMetricsView, { summary: null, loading: false, error: "metrics unavailable", onLoad });
    (findAll(tree, (el) => el.type === "button")[0]!.props.onClick as () => void)();
    expect(onLoad).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(tree)).toContain("metrics unavailable");
  });
});

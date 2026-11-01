import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { mirrorMetricCountsSchema, mirrorMetricsContract, mirrorOpenMetricsSchema } from "./metrics-contract";
export { mirrorMetricsContract } from "./metrics-contract";
type Counts = z.infer<typeof mirrorMetricCountsSchema>;
type Open = z.infer<typeof mirrorOpenMetricsSchema>;
const streamSchema = z.object({ serverId: z.string().min(1).max(250), threadId: z.string().min(1).max(250), generation: z.string().min(1).max(250) }).strict();
export type MirrorMetricStream = z.infer<typeof streamSchema>;
const readSchema = z.object({
  kind: z.enum(["events", "broker"]).default("events"), readId: z.string().uuid(), openId: z.string().uuid().optional(), stream: streamSchema,
  mode: z.enum(["initial", "delta", "history", "lookup"]), startedAt: z.number().finite(), endedAt: z.number().finite(),
  events: z.array(z.object({ seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).passthrough()).max(2000).nullable(),
  cursorBefore: z.number().int().min(0).nullable(), cursorAfter: z.number().int().min(0).nullable(), failed: z.boolean().default(false),
}).strict().refine((value) => value.endedAt >= value.startedAt, "Read clock must be monotonic").refine((value) => value.events !== null || value.failed, "A missing response body must be recorded as failed");
export type MirrorMetricRead = z.input<typeof readSchema>;
export type MirrorMetricBrokerRead = Omit<MirrorMetricRead, "events" | "kind"> & { rows: MirrorMetricRead["events"] };
const empty = (): Counts => ({ reads: 0, readBytes: 0, eventBytes: 0, eventOccurrences: 0, uniqueEvents: 0, duplicateEvents: 0, brokerReads: 0, brokerRowBytes: 0, brokerRowOccurrences: 0, uniqueBrokerRows: 0, duplicateBrokerRows: 0, initialReads: 0, deltaReads: 0, historyReads: 0, lookupReads: 0, failedReads: 0, readsWithoutBody: 0, cursorAdvances: 0, readDurationMs: 0, renderSamples: 0, renderDurationMs: 0 });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const streamKey = (value: MirrorMetricStream) => hash(JSON.stringify([value.serverId, value.threadId, value.generation]));
function add(a: Counts, b: Counts): Counts {
  return mirrorMetricCountsSchema.parse(Object.fromEntries(Object.keys(a).map((key) => [key, a[key as keyof Counts] + b[key as keyof Counts]])));
}
export function createMirrorMetrics(bb: BbPluginApi, options: { now?: () => number; clock?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const clock = options.clock ?? (() => performance.now());
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_mirror_metric_totals_v1 (id INTEGER PRIMARY KEY, counts_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fleet_mirror_metric_reads_v1 (id_hash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fleet_mirror_metric_events_v1 (id_hash TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS fleet_mirror_metric_renders_v1 (id_hash TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS fleet_mirror_metric_opens_v1 (open_id TEXT PRIMARY KEY, stream_hash TEXT NOT NULL, value_json TEXT NOT NULL)`);
  db.prepare("INSERT OR IGNORE INTO fleet_mirror_metric_totals_v1 VALUES (1, ?)").run(JSON.stringify(empty()));
  const starts = new Map<string, number>();
  const total = () => mirrorMetricCountsSchema.parse({ ...empty(), ...JSON.parse((db.prepare("SELECT counts_json FROM fleet_mirror_metric_totals_v1 WHERE id=1").get() as { counts_json: string }).counts_json) });
  const setTotal = (value: Counts) => db.prepare("UPDATE fleet_mirror_metric_totals_v1 SET counts_json=? WHERE id=1").run(JSON.stringify(value));
  const openRow = (id: string) => db.prepare("SELECT stream_hash, value_json FROM fleet_mirror_metric_opens_v1 WHERE open_id=?").get(id) as { stream_hash: string; value_json: string } | undefined;
  const parseOpen = (row: { value_json: string }) => { const value = JSON.parse(row.value_json); return mirrorOpenMetricsSchema.parse({ ...value, counts: { ...empty(), ...value.counts } }); };
  const saveOpen = (value: Open) => db.prepare("UPDATE fleet_mirror_metric_opens_v1 SET value_json=? WHERE open_id=?").run(JSON.stringify(value), value.openId);
  function beginOpen(input: { openId: string; stream: MirrorMetricStream }): string {
    const openId = z.string().uuid().parse(input.openId);
    const key = streamKey(streamSchema.parse(input.stream));
    const old = openRow(openId);
    if (old) { if (old.stream_hash !== key) throw new Error("Metrics open ID belongs to another stream"); return openId; }
    const value: Open = { openId, openedAt: now(), endedAt: null, openLatencyMs: null, outcome: "opening", cursor: null, counts: empty() };
    db.prepare("INSERT INTO fleet_mirror_metric_opens_v1 VALUES (?, ?, ?)").run(openId, key, JSON.stringify(value));
    starts.set(openId, clock());
    return openId;
  }
  function finishOpen(openId: string, outcome: "ready" | "failed" | "cancelled"): Open {
    z.enum(["ready", "failed", "cancelled"]).parse(outcome);
    const row = openRow(z.string().uuid().parse(openId));
    if (!row) throw new Error("Unknown metrics open ID");
    const value = parseOpen(row);
    if (value.outcome !== "opening") return value;
    const started = starts.get(openId);
    value.endedAt = now(); value.outcome = outcome;
    value.openLatencyMs = started === undefined ? null : Math.max(0, clock() - started);
    saveOpen(value); starts.delete(openId);
    return value;
  }
  function recordRead(raw: MirrorMetricRead): boolean {
    const input = readSchema.parse(raw);
    const serialized = input.events === null ? null : JSON.stringify(input.events);
    const events = input.events ?? [];
    const readBytes = serialized === null ? 0 : Buffer.byteLength(serialized, "utf8");
    const key = streamKey(input.stream);
    const idHash = hash(input.readId);
    const fingerprintParts = [key, input.openId ?? null, input.mode, input.startedAt, input.endedAt, input.cursorBefore, input.cursorAfter, input.failed, serialized];
    const fingerprint = hash(JSON.stringify(input.kind === "events" ? fingerprintParts : ["broker", ...fingerprintParts]));
    return db.transaction(() => {
      const old = db.prepare("SELECT fingerprint FROM fleet_mirror_metric_reads_v1 WHERE id_hash=?").get(idHash) as { fingerprint: string } | undefined;
      if (old) { if (old.fingerprint !== fingerprint) throw new Error("Metrics read ID was reused for a different observation"); return false; }
      const row = input.openId ? openRow(input.openId) : undefined;
      if (input.openId && (!row || row.stream_hash !== key)) throw new Error("Metrics read does not match its open stream");
      let unique = 0;
      for (const event of events) unique += db.prepare("INSERT OR IGNORE INTO fleet_mirror_metric_events_v1 VALUES (?)").run(hash(input.kind === "events" ? `${key}:${event.seq}` : `${key}:broker:${event.seq}`)).changes;
      const delta = empty();
      delta.reads = 1; delta.readBytes = readBytes;
      if (input.kind === "broker") {
        delta.brokerReads = 1; delta.brokerRowBytes = events.reduce((sum, item) => sum + bytes(item), 0);
        delta.brokerRowOccurrences = events.length; delta.uniqueBrokerRows = unique; delta.duplicateBrokerRows = events.length - unique;
      } else {
        delta.eventBytes = events.reduce((sum, item) => sum + bytes(item), 0);
        delta.eventOccurrences = events.length; delta.uniqueEvents = unique; delta.duplicateEvents = events.length - unique;
      }
      delta[`${input.mode}Reads`] = 1; delta.failedReads = input.failed ? 1 : 0; delta.readsWithoutBody = input.events === null ? 1 : 0;
      delta.readDurationMs = input.endedAt - input.startedAt;
      const previousCursor = Math.max(input.cursorBefore ?? -1, row ? parseOpen(row).cursor ?? -1 : -1);
      delta.cursorAdvances = input.cursorAfter !== null && input.cursorAfter > previousCursor ? 1 : 0;
      setTotal(add(total(), delta));
      if (row) {
        const value = parseOpen(row);
        value.counts = add(value.counts, delta);
        if (input.cursorAfter !== null) value.cursor = Math.max(value.cursor ?? 0, input.cursorAfter);
        saveOpen(value);
      }
      db.prepare("INSERT INTO fleet_mirror_metric_reads_v1 VALUES (?, ?)").run(idHash, fingerprint);
      return true;
    })();
  }
  function recordBrokerRead({ rows, ...input }: MirrorMetricBrokerRead) { return recordRead({ ...input, events: rows, kind: "broker" }); }
  function recordRender(raw: z.infer<typeof mirrorMetricsContract.mirror_metrics_render.input>) {
    const input = mirrorMetricsContract.mirror_metrics_render.input.parse(raw);
    return db.transaction(() => {
      const row = openRow(input.openId);
      if (!row) throw new Error("Unknown metrics open ID");
      const recorded = db.prepare("INSERT OR IGNORE INTO fleet_mirror_metric_renders_v1 VALUES (?)").run(hash(`${input.openId}:${input.sampleId}`)).changes > 0;
      if (!recorded) return { recorded: false };
      const delta = empty(); delta.renderSamples = 1; delta.renderDurationMs = input.durationMs;
      setTotal(add(total(), delta));
      const value = parseOpen(row); value.counts = add(value.counts, delta); saveOpen(value);
      return { recorded: true };
    })();
  }
  function get(raw: z.infer<typeof mirrorMetricsContract.mirror_metrics_get.input>) {
    const { openId } = mirrorMetricsContract.mirror_metrics_get.input.parse(raw);
    const columns = "o.value_json, o.stream_hash, EXISTS (SELECT 1 FROM fleet_mirror_metric_opens_v1 earlier WHERE earlier.stream_hash = o.stream_hash AND earlier.rowid < o.rowid) AS reopened";
    const rows = (openId ? db.prepare(`SELECT ${columns} FROM fleet_mirror_metric_opens_v1 o WHERE o.open_id=?`).all(openId) : db.prepare(`SELECT ${columns} FROM fleet_mirror_metric_opens_v1 o ORDER BY o.rowid DESC LIMIT 25`).all()) as { value_json: string; stream_hash: string; reopened: number }[];
    const opens = rows.map((row) => ({ ...parseOpen(row), chat: row.stream_hash.slice(0, 12), temperature: row.reopened ? "warm" as const : "cold" as const }));
    return { version: 1 as const, units: { bytes: "serialized-utf8-json" as const, latency: "server-monotonic-ms" as const, render: "client-reported-ms" as const }, cumulative: total(), opens, observedAt: now() };
  }
  return { beginOpen, finishOpen, recordRead, recordBrokerRead, recordRender, get, handlers: { mirror_metrics_get: get, mirror_metrics_render: recordRender } };
}

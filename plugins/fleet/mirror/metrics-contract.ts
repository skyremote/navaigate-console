import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const duration = z.number().finite().min(0);
export const mirrorMetricCountsSchema = z.object({
  reads: count, readBytes: count, eventBytes: count, eventOccurrences: count, uniqueEvents: count, duplicateEvents: count,
  brokerReads: count, brokerRowBytes: count, brokerRowOccurrences: count, uniqueBrokerRows: count, duplicateBrokerRows: count,
  initialReads: count, deltaReads: count, historyReads: count, lookupReads: count, failedReads: count, readsWithoutBody: count, cursorAdvances: count,
  readDurationMs: duration, renderSamples: count, renderDurationMs: duration,
}).strict();
export const mirrorOpenMetricsSchema = z.object({
  openId: z.string().uuid(), openedAt: z.number(), endedAt: z.number().nullable(), openLatencyMs: duration.nullable(),
  outcome: z.enum(["opening", "ready", "failed", "cancelled", "interrupted"]), cursor: count.nullable(), counts: mirrorMetricCountsSchema,
}).strict();
/** What the Fleet page reads: the stored open plus a hashed chat id and whether it was the first open of that chat copy. */
export const mirrorOpenReportSchema = mirrorOpenMetricsSchema.extend({ chat: z.string().regex(/^[0-9a-f]{12}$/), temperature: z.enum(["cold", "warm"]) }).strict();
export const mirrorMetricsContract = defineRpcContract({
  mirror_metrics_get: {
    input: z.object({ openId: z.string().uuid().optional() }).strict(),
    output: z.object({ version: z.literal(1), units: z.object({ bytes: z.literal("serialized-utf8-json"), latency: z.literal("server-monotonic-ms"), render: z.literal("client-reported-ms") }), cumulative: mirrorMetricCountsSchema, opens: z.array(mirrorOpenReportSchema).max(25), observedAt: z.number() }).strict(),
  },
  mirror_metrics_render: {
    input: z.object({ openId: z.string().uuid(), sampleId: z.string().uuid(), durationMs: duration.max(3_600_000) }).strict(),
    output: z.object({ recorded: z.boolean() }).strict(),
  },
});

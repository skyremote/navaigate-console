import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createMirrorMetrics, type MirrorMetricRead } from "./metrics";
import { mirrorMetricsContract } from "./metrics-contract";
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
const stream = { serverId: "owner-fixture", threadId: "thr_fixture", generation: "fixture-generation" };
function fixture() {
  const host = createFakePluginHost({ pluginId: `metrics-${randomUUID()}` });
  disposals.push(() => host.harness.lifecycle.dispose());
  let clock = 10;
  let now = 1000;
  const options = { clock: () => clock, now: () => now };
  const service = createMirrorMetrics(host.bb, options);
  const openId = randomUUID();
  service.beginOpen({ openId, stream });
  const read = (overrides: Partial<MirrorMetricRead> = {}): MirrorMetricRead => ({ readId: randomUUID(), openId, stream, mode: "delta", startedAt: 12, endedAt: 14.75, events: [{ seq: 1, text: "Synthetic £ 字 fixture" }], cursorBefore: 0, cursorAfter: 1, ...overrides });
  return { ...host, service, options, openId, read, setClock(value: number) { clock = value; }, setNow(value: number) { now = value; } };
}
describe("actual mirror UTF8 read and latency counters", () => {
  it("counts exact serialized UTF8 event and array bytes including multibyte text, without estimating token or network compression costs", () => {
    const f = fixture();
    const observation = f.read();
    expect(f.service.recordRead(observation)).toBe(true);
    const snapshot = f.service.get({});
    const eventBytes = Buffer.byteLength(JSON.stringify(observation.events![0]), "utf8");
    expect(eventBytes).toBeGreaterThan(JSON.stringify(observation.events![0]).length);
    expect(snapshot.cumulative).toMatchObject({ reads: 1, readBytes: Buffer.byteLength(JSON.stringify(observation.events), "utf8"), eventBytes, eventOccurrences: 1, uniqueEvents: 1, duplicateEvents: 0, deltaReads: 1, readDurationMs: 2.75, cursorAdvances: 1, renderSamples: 0, renderDurationMs: 0 });
    expect(snapshot.opens[0]?.counts).toEqual(snapshot.cumulative);
    expect(snapshot.opens[0]?.cursor).toBe(1);
    expect(snapshot.units.bytes).toBe("serialized-utf8-json");
    expect(mirrorMetricsContract.mirror_metrics_get.output.safeParse(snapshot).success).toBe(true);
  });
  it("deduplicates stable read IDs through reload, rejects ID reuse and still counts actual repeated transfers with new IDs", () => {
    const f = fixture();
    const input = f.read();
    f.service.recordRead(input);
    const reloaded = createMirrorMetrics(f.bb, f.options);
    expect(reloaded.recordRead(input)).toBe(false);
    expect(() => reloaded.recordRead({ ...input, events: [{ seq: 1, text: "different bytes" }] })).toThrow("reused");
    reloaded.recordRead({ ...input, readId: randomUUID() });
    expect(reloaded.get({}).cumulative).toMatchObject({ reads: 2, uniqueEvents: 1, duplicateEvents: 1, eventOccurrences: 2, readBytes: 2 * Buffer.byteLength(JSON.stringify(input.events)) });
  });
  it("deduplicates repeated seq IDs within and across overlapping pages, while isolating owner/thread/generation", () => {
    const f = fixture();
    f.service.recordRead(f.read({ events: [{ seq: 1 }, { seq: 1 }, { seq: 2 }], cursorAfter: 2 }));
    f.service.recordRead(f.read({ events: [{ seq: 2 }, { seq: 3 }], cursorBefore: 2, cursorAfter: 3 }));
    for (const changed of [{ ...stream, generation: "another" }, { ...stream, serverId: "another" }, { ...stream, threadId: "another" }]) f.service.recordRead(f.read({ openId: undefined, stream: changed, events: [{ seq: 1 }] }));
    expect(f.service.get({}).cumulative).toMatchObject({ reads: 5, eventOccurrences: 8, uniqueEvents: 6, duplicateEvents: 2 });
  });
  it("keeps initial/delta/history/lookup reads distinct and counts empty or failed observations without fabricating events", () => {
    const f = fixture();
    for (const mode of ["initial", "delta", "history", "lookup"] as const) f.service.recordRead(f.read({ mode, events: [], cursorBefore: null, cursorAfter: null, failed: mode === "lookup" }));
    expect(f.service.get({}).cumulative).toMatchObject({ reads: 4, readBytes: 8, eventBytes: 0, uniqueEvents: 0, eventOccurrences: 0, initialReads: 1, deltaReads: 1, historyReads: 1, lookupReads: 1, failedReads: 1, cursorAdvances: 0 });
  });
  it("distinguishes an unavailable read with no body from an actual empty JSON array", () => {
    const f = fixture();
    f.service.recordRead(f.read({ failed: true, events: null, cursorBefore: null, cursorAfter: null }));
    expect(f.service.get({}).cumulative).toMatchObject({ reads: 1, failedReads: 1, readsWithoutBody: 1, readBytes: 0, eventBytes: 0, uniqueEvents: 0 });
    expect(() => f.service.recordRead(f.read({ events: null, failed: false }))).toThrow("missing response body");
  });
  it("counts actual broker row JSON bytes and stable row identities separately from native event IDs", () => {
    const f = fixture();
    const { events: _events, ...input } = f.read();
    const rows = [{ seq: 1, payload: "synthetic sealed £ row" }];
    expect(f.service.recordBrokerRead({ ...input, rows })).toBe(true);
    expect(f.service.recordBrokerRead({ ...input, rows })).toBe(false);
    f.service.recordBrokerRead({ ...input, readId: randomUUID(), rows });
    f.service.recordRead(f.read({ events: [{ seq: 1 }] }));
    expect(f.service.get({}).cumulative).toMatchObject({ reads: 3, brokerReads: 2, brokerRowOccurrences: 2, uniqueBrokerRows: 1, duplicateBrokerRows: 1, uniqueEvents: 1, duplicateEvents: 0, readBytes: 2 * Buffer.byteLength(JSON.stringify(rows)) + Buffer.byteLength('[{"seq":1}]') });
    const persisted = JSON.stringify(f.bb.storage.database().prepare("SELECT * FROM fleet_mirror_metric_reads_v1").all());
    expect(persisted).not.toContain("synthetic sealed");
  });
  it("keeps native event/read identity compatible when adding broker metrics to an existing metrics database", () => {
    const f = fixture();
    const input = f.read();
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const key = sha(JSON.stringify([stream.serverId, stream.threadId, stream.generation]));
    const fingerprint = sha(JSON.stringify([key, input.openId, input.mode, input.startedAt, input.endedAt, input.cursorBefore, input.cursorAfter, false, JSON.stringify(input.events)]));
    const db = f.bb.storage.database();
    db.prepare("INSERT INTO fleet_mirror_metric_reads_v1 VALUES (?, ?)").run(sha(input.readId), fingerprint);
    db.prepare("INSERT INTO fleet_mirror_metric_events_v1 VALUES (?)").run(sha(`${key}:1`));
    expect(f.service.recordRead(input)).toBe(false);
    expect(f.service.recordRead({ ...input, readId: randomUUID() })).toBe(true);
    expect(f.service.get({}).cumulative).toMatchObject({ uniqueEvents: 0, duplicateEvents: 1, brokerReads: 0 });
  });
  it("uses monotonic open latency despite wall-clock changes and does not overwrite completed opens", () => {
    const f = fixture();
    f.setClock(25.25); f.setNow(900);
    expect(f.service.finishOpen(f.openId, "ready")).toMatchObject({ outcome: "ready", openLatencyMs: 15.25, openedAt: 1000, endedAt: 900 });
    f.setClock(50);
    expect(f.service.finishOpen(f.openId, "failed")).toMatchObject({ outcome: "ready", openLatencyMs: 15.25 });
  });
  it("never computes latency across a factory restart from wall time", () => {
    const f = fixture();
    f.setNow(10000); f.setClock(1000);
    const reloaded = createMirrorMetrics(f.bb, f.options);
    expect(reloaded.finishOpen(f.openId, "ready")).toMatchObject({ openLatencyMs: null, outcome: "ready" });
  });
  it("rejects foreign open attribution, unknown opens, backwards clocks and unsupported fields before counters change", () => {
    const f = fixture();
    expect(() => f.service.beginOpen({ openId: f.openId, stream: { ...stream, serverId: "foreign" } })).toThrow("another stream");
    expect(() => f.service.recordRead(f.read({ stream: { ...stream, serverId: "foreign" } }))).toThrow("open stream");
    expect(() => f.service.recordRead(f.read({ openId: randomUUID() }))).toThrow("open stream");
    expect(() => f.service.recordRead(f.read({ endedAt: 1 }))).toThrow("monotonic");
    expect(() => f.service.recordRead({ ...f.read(), secret: "not accepted" } as never)).toThrow();
    expect(f.service.get({}).cumulative.reads).toBe(0);
  });
  it("keeps cursors monotonic in an open when overlapping reads report an earlier cursor", () => {
    const f = fixture();
    f.service.recordRead(f.read({ events: [{ seq: 8 }], cursorAfter: 8 }));
    f.service.recordRead(f.read({ events: [{ seq: 4 }], mode: "history", cursorBefore: null, cursorAfter: 4 }));
    expect(f.service.get({ openId: f.openId }).opens[0]?.cursor).toBe(8);
    expect(f.service.get({}).cumulative.cursorAdvances).toBe(1);
  });
  it("records only explicit bounded frontend render samples and deduplicates their IDs", () => {
    const f = fixture();
    const sample = { openId: f.openId, sampleId: randomUUID(), durationMs: 3.125 };
    expect(f.service.handlers.mirror_metrics_render(sample)).toEqual({ recorded: true });
    expect(f.service.handlers.mirror_metrics_render(sample)).toEqual({ recorded: false });
    expect(f.service.get({}).cumulative).toMatchObject({ renderSamples: 1, renderDurationMs: 3.125 });
    expect(() => f.service.recordRender({ ...sample, durationMs: -1 })).toThrow();
    expect(() => f.service.recordRender({ ...sample, durationMs: Infinity })).toThrow();
    expect(() => f.service.recordRender({ ...sample, openId: randomUUID() })).toThrow("Unknown");
  });
  it("stores and returns counters/hashes only, with no event text, credentials, source identifiers or payload JSON", () => {
    const f = fixture();
    f.service.recordRead(f.read({ events: [{ seq: 1, payload: { secret: "SYNTHETIC_SECRET_£_字", accessToken: "synthetic-token" } }] }));
    const db = f.bb.storage.database();
    const tables = ["totals", "reads", "events", "renders", "opens"];
    const persisted = JSON.stringify(tables.flatMap((name) => db.prepare(`SELECT * FROM fleet_mirror_metric_${name}_v1`).all()));
    expect(persisted).not.toMatch(/SYNTHETIC_SECRET|synthetic-token|owner-fixture|thr_fixture|fixture-generation|accessToken|payload/);
    expect(JSON.stringify(f.service.get({}))).not.toMatch(/SYNTHETIC_SECRET|synthetic-token|accessToken|payload/);
  });
  it("names each open by a hashed chat id and calls the first open of a chat cold and every later open warm", () => {
    const f = fixture();
    const second = randomUUID();
    const other = randomUUID();
    f.service.beginOpen({ openId: second, stream });
    f.service.beginOpen({ openId: other, stream: { ...stream, threadId: "thr_other" } });
    const opens = f.service.get({}).opens;
    const byId = new Map(opens.map((item) => [item.openId, item]));
    expect(byId.get(f.openId)).toMatchObject({ temperature: "cold" });
    expect(byId.get(second)).toMatchObject({ temperature: "warm" });
    expect(byId.get(other)).toMatchObject({ temperature: "cold" });
    expect(byId.get(second)?.chat).toBe(byId.get(f.openId)?.chat);
    expect(byId.get(other)?.chat).not.toBe(byId.get(f.openId)?.chat);
    expect(byId.get(f.openId)?.chat).toMatch(/^[0-9a-f]{12}$/);
    expect(f.service.get({ openId: second }).opens[0]).toMatchObject({ temperature: "warm" });
    expect(mirrorMetricsContract.mirror_metrics_get.output.safeParse(f.service.get({})).success).toBe(true);
  });
  it("treats a rebuilt copy of a chat, which has a new generation, as cold again", () => {
    const f = fixture();
    const rebuilt = randomUUID();
    f.service.beginOpen({ openId: rebuilt, stream: { ...stream, generation: "rebuilt-generation" } });
    expect(f.service.get({ openId: rebuilt }).opens[0]).toMatchObject({ temperature: "cold" });
  });
  it("judges cold and warm from every open ever recorded, not only the 25 returned", () => {
    const f = fixture();
    for (let index = 0; index < 30; index++) f.service.beginOpen({ openId: randomUUID(), stream });
    const opens = f.service.get({}).opens;
    expect(opens).toHaveLength(25);
    expect(opens.every((item) => item.temperature === "warm")).toBe(true);
    expect(f.service.get({ openId: f.openId }).opens[0]?.temperature).toBe("cold");
  });
  it("bounds recent open results and returns only the exact requested open", () => {
    const f = fixture();
    for (let index = 0; index < 30; index++) f.service.beginOpen({ openId: randomUUID(), stream });
    expect(f.service.get({}).opens).toHaveLength(25);
    expect(f.service.get({ openId: f.openId }).opens.map((item) => item.openId)).toEqual([f.openId]);
    expect(f.service.get({ openId: randomUUID() }).opens).toEqual([]);
  });
});

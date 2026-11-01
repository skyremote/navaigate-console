import { describe, expect, it } from "vitest";
import { createFleetLink } from "../server-fleet";

type Call = { pluginId: string; method: string; input: unknown; outputSchema: { parse: (v: unknown) => unknown } };

function link(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const bb = {
    sdk: { plugins: { callRpc: async (call: Call) => { calls.push(call); return call.outputSchema.parse(await answer(call)); } } },
  } as never;
  return { fleet: createFleetLink(bb), calls };
}

const unknownMethod = (method: string) => Object.assign(new Error(`plugin "fleet" has no rpc method "${method}"`), { code: "unknown_method" });
const REQUEST = "console-tell-0001";

describe("Tell, read the answer and read a receipt through Fleet", () => {
  it("sends exactly what Fleet's strict thread_tell takes and reports the delivery", async () => {
    const { fleet, calls } = link(() => ({ requestId: REQUEST, machine: "studio", threadId: "thr_a", delivered: true, delivery: "queued", messageId: "m1", url: "https://m1/threads/thr_a", extra: "ignored" }));
    const r = await fleet.tell({ machine: "studio", threadId: "thr_a", message: "Use the new schema", requestId: REQUEST });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pluginId: "fleet", method: "thread_tell", input: { machine: "studio", threadId: "thr_a", message: "Use the new schema", requestId: REQUEST } });
    expect(Object.keys(calls[0].input as object).sort()).toEqual(["machine", "message", "requestId", "threadId"]);
    expect(r).toEqual({ offered: true, requestId: REQUEST, delivered: true, delivery: "queued", url: "https://m1/threads/thr_a" });
  });

  it("says the Fleet does not offer Tell, instead of failing, when it has no thread_tell", async () => {
    const { fleet } = link(() => { throw unknownMethod("thread_tell"); });
    expect(await fleet.tell({ machine: "studio", threadId: "thr_a", message: "hello", requestId: REQUEST })).toEqual({ offered: false });
  });

  it("recognises a missing method by its message when the error carries no code", async () => {
    const { fleet } = link(() => { throw new Error('plugin "fleet" has no rpc method "thread_output_get"'); });
    expect(await fleet.output({ machine: "studio", threadId: "thr_a" })).toEqual({ offered: false });
  });

  it("lets every other failure through, so a refused or lost send is never reported as unsupported", async () => {
    const { fleet } = link(() => { throw Object.assign(new Error("This message may already have been sent; read the thread before sending it again"), { code: "handler_error" }); });
    await expect(fleet.tell({ machine: "studio", threadId: "thr_a", message: "hello", requestId: REQUEST })).rejects.toThrow(/may already have been sent/);
  });

  it("reads the latest answer of a remote chat", async () => {
    const { fleet, calls } = link(() => ({ machine: "studio", threadId: "thr_a", url: null, state: "idle", output: "Done: 3 files", truncated: false, publishedAt: 5 }));
    const r = await fleet.output({ machine: "studio", threadId: "thr_a" });
    expect(calls[0]).toMatchObject({ method: "thread_output_get", input: { machine: "studio", threadId: "thr_a" } });
    expect(r).toEqual({ offered: true, state: "idle", output: "Done: 3 files", truncated: false });
  });

  it("reads the receipt of a started ask: ready with the answer, or still working", async () => {
    const ready = link(() => ({ state: "ready", commandId: "c", threadId: "thr_n", url: "https://m1/threads/thr_n", answer: { machine: "studio", threadId: "thr_n", url: null, state: "idle", output: "42", truncated: false, publishedAt: 1 }, message: null }));
    expect(await ready.fleet.receipt({ id: "00000000-0000-4000-8000-000000000000" })).toEqual({ offered: true, state: "ready", message: null, output: "42", truncated: false, url: "https://m1/threads/thr_n" });
    expect(ready.calls[0]).toMatchObject({ method: "receipt_result", input: { id: "00000000-0000-4000-8000-000000000000" } });
    const pending = link(() => ({ state: "pending", commandId: null, threadId: null, url: null, answer: null, message: "Not ready yet" }));
    expect(await pending.fleet.receipt({ id: "00000000-0000-4000-8000-000000000000" })).toEqual({ offered: true, state: "pending", message: "Not ready yet", output: null, truncated: false, url: null });
  });

  it("says a Fleet without receipt_result cannot read an ask back", async () => {
    const { fleet } = link(() => { throw unknownMethod("receipt_result"); });
    expect(await fleet.receipt({ id: "00000000-0000-4000-8000-000000000000" })).toEqual({ offered: false });
  });
});

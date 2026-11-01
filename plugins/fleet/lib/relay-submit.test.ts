import { describe, expect, it, vi } from "vitest";
import { nextRequestId, readAnswerOf, submitRelay, type RelayCalls } from "./relay-submit";

const calls = (over: Partial<RelayCalls> = {}): RelayCalls => ({
  thread_tell: vi.fn(async (input) => ({ requestId: input.requestId, machine: input.machine, threadId: input.threadId, delivered: true, delivery: "sent", messageId: "studio", url: null })),
  work_start: vi.fn(async (input) => ({ outcome: "started" as const, threadId: "thr_new", url: null, commandId: null, requestId: input.requestId })),
  thread_output_get: vi.fn(async (input) => ({ machine: input.machine, threadId: input.threadId, url: null, state: "idle" as const, output: "done", truncated: false, publishedAt: 1 })),
  ...over,
});

describe("nextRequestId", () => {
  it("reuses the id while the text is unchanged so a retry cannot send twice, and mints a new one when it changes", () => {
    const first = nextRequestId(null, "hello", () => "id-1");
    expect(first).toEqual({ draft: "hello", id: "id-1" });
    expect(nextRequestId(first, "hello", () => "id-2")).toBe(first);
    expect(nextRequestId(first, "hello again", () => "id-3")).toEqual({ draft: "hello again", id: "id-3" });
  });
});

describe("submitRelay", () => {
  it("tells a thread with the request id and reports the receipt", async () => {
    const rpc = calls();
    const result = await submitRelay(rpc, { machine: "studio", threadId: "thr_a", text: "go", requestId: "req-00000001" });
    expect(rpc.thread_tell).toHaveBeenCalledWith({ machine: "studio", threadId: "thr_a", message: "go", requestId: "req-00000001" });
    expect(result).toEqual({ ok: true, status: { tone: "ok", text: "Delivered to studio. Receipt req-00000001" } });
  });

  it("says a queued tell is waiting rather than delivered", async () => {
    const rpc = calls({ thread_tell: vi.fn(async (input) => ({ requestId: input.requestId, machine: "studio", threadId: "thr_a", delivered: false, delivery: "queued", messageId: "m2", url: null, note: " studio was last seen 9 min ago." })) });
    const result = await submitRelay(rpc, { machine: "studio", threadId: "thr_a", text: "go", requestId: "req-00000001" });
    expect(result.status.text).toBe("Queued for studio; it is not delivered yet. Receipt req-00000001 studio was last seen 9 min ago.");
  });

  it("asks a machine by starting work and points at the receipt", async () => {
    const rpc = calls();
    const result = await submitRelay(rpc, { machine: "studio", threadId: null, text: "hostname", requestId: "req-00000002" });
    expect(rpc.work_start).toHaveBeenCalledWith({ machine: "studio", prompt: "hostname", requestId: "req-00000002" });
    expect(result.status.text).toBe("Started on studio. Receipt req-00000002: its answer shows under Sent from here");
  });

  it("reports a failure as an error and keeps the draft", async () => {
    const rpc = calls({ thread_tell: vi.fn(async () => { throw new Error("studio was not reached; nothing was sent"); }) });
    const result = await submitRelay(rpc, { machine: "studio", threadId: "thr_a", text: "go", requestId: "req-00000001" });
    expect(result).toEqual({ ok: false, status: { tone: "bad", text: "studio was not reached; nothing was sent" } });
  });
});

describe("readAnswerOf", () => {
  it("returns the answer text, state and truncation", async () => {
    expect(await readAnswerOf(calls(), "studio", "thr_a")).toEqual({ ok: true, answer: { text: "done", state: "idle", truncated: false } });
  });
  it("returns the error text when the answer cannot be read", async () => {
    const rpc = calls({ thread_output_get: vi.fn(async () => { throw new Error("No published answer"); }) });
    expect(await readAnswerOf(rpc, "studio", "thr_a")).toEqual({ ok: false, status: { tone: "bad", text: "No published answer" } });
  });
});

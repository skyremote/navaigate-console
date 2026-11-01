import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescer } from "./coalesce";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function source(latencyMs = 0) {
  let calls = 0;
  const work = vi.fn(async () => {
    const n = ++calls;
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return n;
  });
  return { work };
}

describe("coalescer", () => {
  it("answers 50 concurrent calls with one read", async () => {
    const reads = createCoalescer();
    const s = source(100);
    const all = Promise.all(Array.from({ length: 50 }, () => reads.run("k", 1000, s.work)));
    await vi.advanceTimersByTimeAsync(100);
    expect(await all).toEqual(Array(50).fill(1));
    expect(s.work).toHaveBeenCalledTimes(1);
  });

  it("keeps an answer for the TTL and then reads again", async () => {
    const reads = createCoalescer();
    const s = source();
    expect(await reads.run("k", 1000, s.work)).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(await reads.run("k", 1000, s.work)).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await reads.run("k", 1000, s.work)).toBe(2);
  });

  it("keeps keys apart", async () => {
    const reads = createCoalescer();
    const a = source();
    const b = source();
    await Promise.all([reads.run("a", 1000, a.work), reads.run("b", 1000, b.work)]);
    expect([a.work.mock.calls.length, b.work.mock.calls.length]).toEqual([1, 1]);
  });

  it("does not keep a failure, and passes it to everyone waiting", async () => {
    const reads = createCoalescer();
    let failing = true;
    const work = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (failing) throw new Error("owner unreachable");
      return "ok";
    });
    const crowd = Promise.allSettled(Array.from({ length: 50 }, () => reads.run("k", 1000, work)));
    await vi.advanceTimersByTimeAsync(10);
    expect((await crowd).every((r) => r.status === "rejected")).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
    failing = false;
    const next = reads.run("k", 1000, work);
    await vi.advanceTimersByTimeAsync(10);
    expect(await next).toBe("ok");
  });

  it("drops kept answers on invalidate", async () => {
    const reads = createCoalescer();
    const s = source();
    await reads.run("k", 60_000, s.work);
    reads.invalidate();
    expect(await reads.run("k", 60_000, s.work)).toBe(2);
  });

  it("does not keep a read that began before an invalidate", async () => {
    const reads = createCoalescer();
    const s = source(50);
    const first = reads.run("k", 60_000, s.work);
    reads.invalidate();
    await vi.advanceTimersByTimeAsync(50);
    expect(await first).toBe(1);
    const next = reads.run("k", 60_000, s.work);
    await vi.advanceTimersByTimeAsync(50);
    expect(await next).toBe(2);
  });
});

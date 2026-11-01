import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlight, isTransientRpcFailure } from "../src/rpc-flight";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const CROWD = 50;
const transport = () => Object.assign(new Error("Failed to fetch"), { code: "transport_error" });

function backend(latencyMs = 0) {
  let calls = 0;
  const load = vi.fn(async () => {
    const n = ++calls;
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return n;
  });
  return { load, get calls() { return calls; } };
}

describe("single flight", () => {
  it("answers 50 concurrent calls with one backend call", async () => {
    const flight = createFlight();
    const b = backend(100);
    const all = Promise.all(Array.from({ length: CROWD }, () => flight.call("k", b.load)));
    await vi.advanceTimersByTimeAsync(100);
    expect(await all).toEqual(Array(CROWD).fill(1));
    expect(b.calls).toBe(1);
  });

  it("keeps keys independent", async () => {
    const flight = createFlight();
    const a = backend();
    const c = backend();
    await Promise.all([flight.call("a", a.load), flight.call("c", c.load), flight.call("a", a.load)]);
    expect([a.calls, c.calls]).toEqual([1, 1]);
  });

  it("reuses a good answer for the TTL and then asks again", async () => {
    const flight = createFlight({ ttlMs: 1000 });
    const b = backend();
    expect(await flight.call("k", b.load)).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(await flight.call("k", b.load)).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await flight.call("k", b.load)).toBe(2);
  });

  it("lets a call choose its own TTL", async () => {
    const flight = createFlight({ ttlMs: 10_000 });
    const b = backend();
    await flight.call("k", b.load);
    await vi.advanceTimersByTimeAsync(600);
    expect(await flight.call("k", b.load, { ttlMs: 500 })).toBe(2);
  });
});

describe("fresh calls", () => {
  it("shares one follow-up read between 50 callers that arrive while a read is running", async () => {
    const flight = createFlight({ minGapMs: 400 });
    const b = backend(100);
    const first = flight.call("k", b.load);
    await vi.advanceTimersByTimeAsync(10);
    const crowd = Promise.all(Array.from({ length: CROWD }, () => flight.call("k", b.load, { fresh: true })));
    await vi.advanceTimersByTimeAsync(600);
    expect(await first).toBe(1);
    expect(await crowd).toEqual(Array(CROWD).fill(2));
    expect(b.calls).toBe(2);
  });

  it("never runs more than two reads for a key at once", async () => {
    const flight = createFlight({ minGapMs: 0 });
    let running = 0;
    let peak = 0;
    const load = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      running--;
    };
    const all = Promise.all(Array.from({ length: CROWD }, () => flight.call("k", load, { fresh: true })));
    await vi.advanceTimersByTimeAsync(1000);
    await all;
    expect(peak).toBe(2);
  });

  it("does not let an older read that settles late replace a newer answer", async () => {
    const flight = createFlight({ minGapMs: 0, ttlMs: 60_000 });
    let release!: (value: string) => void;
    const old = flight.call("k", () => new Promise<string>((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(5);
    expect(await flight.call("k", async () => "new", { fresh: true })).toBe("new");
    release("old");
    await old;
    expect(flight.peek("k")).toBe("new");
  });

  it("stops waiting for a read that never answers", async () => {
    const flight = createFlight({ minGapMs: 0, hangMs: 30_000 });
    const hung = () => new Promise<string>(() => undefined);
    void flight.call("k", hung);
    void flight.call("k", hung, { fresh: true });
    const third = flight.call("k", async () => "answer", { fresh: true });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await third).toBe("answer");
  });

  it("skips the TTL when nothing is running", async () => {
    const flight = createFlight({ minGapMs: 0, ttlMs: 60_000 });
    const b = backend();
    await flight.call("k", b.load);
    expect(await flight.call("k", b.load, { fresh: true })).toBe(2);
  });

  it("spaces a burst of fresh calls by the minimum gap", async () => {
    const flight = createFlight({ minGapMs: 400 });
    const b = backend();
    await flight.call("k", b.load);
    const burst = Promise.all(Array.from({ length: CROWD }, () => flight.call("k", b.load, { fresh: true })));
    await vi.advanceTimersByTimeAsync(399);
    expect(b.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(await burst).toEqual(Array(CROWD).fill(2));
    expect(b.calls).toBe(2);
  });

  it("lets plain callers join the queued follow-up instead of starting another read", async () => {
    const flight = createFlight({ minGapMs: 400 });
    const b = backend();
    await flight.call("k", b.load);
    const queued = flight.call("k", b.load, { fresh: true });
    const plain = flight.call("k", b.load);
    await vi.advanceTimersByTimeAsync(500);
    expect(await Promise.all([queued, plain])).toEqual([2, 2]);
    expect(b.calls).toBe(2);
  });
});

describe("backoff", () => {
  it("stops asking after a failure, serves the last good answer, and resumes later", async () => {
    const flight = createFlight({ ttlMs: 0, backoffBaseMs: 10_000 });
    let failing = false;
    const load = vi.fn(async () => {
      if (failing) throw transport();
      return "good";
    });
    expect(await flight.call("k", load)).toBe("good");
    failing = true;
    await expect(flight.call("k", load)).rejects.toThrow("Failed to fetch");
    expect(load).toHaveBeenCalledTimes(2);
    const crowd = await Promise.all(Array.from({ length: CROWD }, () => flight.call("k", load)));
    expect(crowd).toEqual(Array(CROWD).fill("good"));
    expect(load).toHaveBeenCalledTimes(2);
    failing = false;
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await flight.call("k", load)).toBe("good");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("raises the recorded failure while backing off when there is no good answer", async () => {
    const flight = createFlight({ ttlMs: 0 });
    const load = vi.fn(async () => { throw transport(); });
    await expect(flight.call("k", load)).rejects.toThrow("Failed to fetch");
    await expect(flight.call("k", load)).rejects.toThrow("Failed to fetch");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("doubles the wait for each failure in a row, up to the maximum", async () => {
    const flight = createFlight({ ttlMs: 0, backoffBaseMs: 1000, backoffMaxMs: 3000 });
    const load = vi.fn(async () => { throw transport(); });
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await flight.call("k", load).catch(() => undefined);
      waits.push(flight.blockedUntil("k") - Date.now());
      await vi.advanceTimersByTimeAsync(3001);
    }
    expect(waits).toEqual([1000, 2000, 3000, 3000]);
  });

  it("treats a slow answer as a reason to ease off, and a quick one as a reason to stop", async () => {
    const flight = createFlight({ ttlMs: 0, slowMs: 1000, backoffBaseMs: 5000 });
    let latency = 1500;
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, latency));
      return latency;
    });
    const slow = flight.call("k", load);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await slow).toBe(1500);
    const during = flight.call("k", load);
    expect(await during).toBe(1500);
    expect(load).toHaveBeenCalledTimes(1);
    latency = 10;
    await vi.advanceTimersByTimeAsync(5001);
    const quick = flight.call("k", load);
    await vi.advanceTimersByTimeAsync(10);
    expect(await quick).toBe(10);
    expect(flight.blockedUntil("k")).toBe(0);
  });

  it("does not back off slow answers for a key that opts out of slow strikes", async () => {
    const flight = createFlight({ ttlMs: 0, slowMs: 1000, backoffBaseMs: 60_000 });
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return "late";
    });
    for (let i = 0; i < 4; i++) {
      const call = flight.call("k", load, { slowStrikes: false });
      await vi.advanceTimersByTimeAsync(1500);
      await call;
      expect(flight.blockedUntil("k")).toBe(0);
    }
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("does not hold a fresh call back after a single failure", async () => {
    const flight = createFlight({ ttlMs: 0, minGapMs: 0, backoffBaseMs: 60_000 });
    let failing = true;
    const load = vi.fn(async () => {
      if (failing) throw transport();
      return "recovered";
    });
    await flight.call("k", load).catch(() => undefined);
    failing = false;
    expect(await flight.call("k", load, { fresh: true })).toBe("recovered");
  });

  it("holds a fresh call back for at most the cap after repeated failures", async () => {
    const flight = createFlight({ ttlMs: 0, minGapMs: 0, backoffBaseMs: 60_000, freshDelayCapMs: 2000 });
    let failing = true;
    const load = vi.fn(async () => {
      if (failing) throw transport();
      return "recovered";
    });
    await flight.call("k", load).catch(() => undefined);
    await flight.call("k", load, { fresh: true }).catch(() => undefined);
    failing = false;
    const fresh = flight.call("k", load, { fresh: true });
    await vi.advanceTimersByTimeAsync(1999);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(await fresh).toBe("recovered");
  });

  it("stops serving an old good answer past the stale limit while backing off", async () => {
    const flight = createFlight({ ttlMs: 0, backoffBaseMs: 600_000, backoffMaxMs: 600_000 });
    let failing = false;
    const load = async () => {
      if (failing) throw transport();
      return "good";
    };
    await flight.call("k", load);
    failing = true;
    await flight.call("k", load).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await flight.call("k", load, { maxStaleMs: 120_000 })).toBe("good");
    expect(flight.ageOf("k")).toBe(60_000);
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(flight.call("k", load, { maxStaleMs: 120_000 })).rejects.toThrow("Failed to fetch");
  });

  it("keeps the last good answer through a transient failure but drops it on a permanent one", async () => {
    const flight = createFlight({ ttlMs: 0, minGapMs: 0 });
    let failure: Error | null = null;
    const load = async () => {
      if (failure) throw failure;
      return "good";
    };
    await flight.call("transient", load);
    failure = transport();
    await flight.call("transient", load).catch(() => undefined);
    expect(flight.peek("transient")).toBe("good");
    await flight.call("permanent", async () => "good");
    failure = Object.assign(new Error("Root missing"), { code: "not_found", status: 404 });
    await flight.call("permanent", load).catch(() => undefined);
    expect(flight.peek("permanent")).toBeUndefined();
    await expect(flight.call("permanent", load)).rejects.toThrow("Root missing");
  });
});

describe("transient failures", () => {
  it.each([
    [Object.assign(new Error("x"), { code: "transport_error" }), true],
    [Object.assign(new Error("x"), { status: 503 }), true],
    [Object.assign(new Error("x"), { status: 429 }), true],
    [Object.assign(new Error("x"), { status: 404 }), false],
    [Object.assign(new Error("x"), { status: 403 }), false],
    [new Error("Root deleted"), false],
    ["text", false],
    [null, false],
  ])("classifies %s", (cause, expected) => {
    expect(isTransientRpcFailure(cause)).toBe(expected);
  });
});

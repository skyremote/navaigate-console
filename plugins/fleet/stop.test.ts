import { describe, expect, it } from "vitest";
import { TursoClient } from "./turso";
import { runCycle, stopSignal, waitOrStop, withStop } from "./stop";

const hangingFetch = ((_url: string, init: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
})) as unknown as typeof fetch;

describe("stop signal", () => {
  it("aborts an in-flight Turso request when the owning service stops", async () => {
    const turso = new TursoClient({ url: "https://fake.invalid", token: "t" }, hangingFetch);
    const controller = new AbortController();
    let failure: unknown = null;
    const cycle = runCycle(controller.signal, async () => {
      try { await turso.query("SELECT 1"); } catch (cause) { failure = cause; }
    }, 20);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await cycle;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("aborted");
  });

  it("lets a cycle that is finishing complete inside the grace period", async () => {
    const controller = new AbortController();
    let completed = false;
    const cycle = runCycle(controller.signal, async () => { await new Promise((resolve) => setTimeout(resolve, 30)); completed = true; }, 500);
    controller.abort();
    await cycle;
    expect(completed).toBe(true);
  });

  it("leaves a request outside any service untouched", async () => {
    expect(stopSignal()).toBeUndefined();
    const own = new AbortController().signal;
    expect(withStop(own)).toBe(own);
    expect(withStop(undefined)).toBeUndefined();
  });

  it("returns at once for a signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await runCycle(controller.signal, async () => { ran = true; });
    await waitOrStop(60_000, controller.signal);
    expect(ran).toBe(false);
  });

  it("clears its timer and listener when it is woken", async () => {
    const controller = new AbortController();
    let wake: (() => void) | null = null;
    const waiting = waitOrStop(60_000, controller.signal, (next) => { wake = next; });
    expect(wake).not.toBeNull();
    wake!();
    await waiting;
    expect(wake).toBeNull();
  });
});

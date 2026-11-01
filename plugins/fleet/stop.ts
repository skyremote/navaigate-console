import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<AbortSignal>();

/** The stop signal of the background service the running code belongs to, if any. */
export function stopSignal(): AbortSignal | undefined {
  return scope.getStore();
}

/** `signal` combined with the stop signal of the current service, when there is one. */
export function withStop(signal?: AbortSignal): AbortSignal | undefined {
  const stop = scope.getStore();
  if (stop === undefined) return signal;
  return signal === undefined ? stop : AbortSignal.any([signal, stop]);
}

/** How long a cycle may keep running after its service is told to stop, so a started write can finish. */
export const STOP_GRACE_MS = 2_000;

/**
 * Run one service cycle. After `signal` aborts the cycle gets `STOP_GRACE_MS` to
 * finish; then every Turso request and bb child process it started is aborted
 * and the call returns even when the cycle is stuck on something that cannot be
 * cancelled.
 */
export function runCycle(signal: AbortSignal, work: () => Promise<void>, graceMs = STOP_GRACE_MS): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const inFlight = new AbortController();
  return new Promise<void>((resolve) => {
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(grace);
      signal.removeEventListener("abort", onStop);
      resolve();
    };
    const onStop = () => {
      grace = setTimeout(() => {
        inFlight.abort();
        finish();
      }, graceMs);
    };
    signal.addEventListener("abort", onStop, { once: true });
    scope.run(inFlight.signal, work).then(finish, finish);
  });
}

/** Wait `ms`, or until `signal` aborts or `wake` is called, with the timer and listener always cleared. */
export function waitOrStop(ms: number, signal: AbortSignal, onWake?: (wake: (() => void) | null) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      onWake?.(null);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    onWake?.(done);
  });
}

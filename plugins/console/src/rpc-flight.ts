export type FlightConfig = {
  ttlMs: number;
  minGapMs: number;
  slowMs: number;
  hangMs: number;
  maxStaleMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  freshDelayCapMs: number;
  now: () => number;
};

export type FlightOptions = { ttlMs?: number; fresh?: boolean; maxStaleMs?: number; slowStrikes?: boolean };

export type Flight = {
  call<T>(key: string, load: () => Promise<T>, options?: FlightOptions): Promise<T>;
  peek<T>(key: string): T | undefined;
  ageOf(key: string): number | null;
  invalidate(key?: string): void;
  blockedUntil(key: string): number;
};

type Entry = {
  good: { value: unknown; at: number; startedAt: number } | null;
  running: Map<Promise<unknown>, Promise<void>>;
  newest: Promise<unknown> | null;
  queued: Promise<unknown> | null;
  lastStart: number;
  settledStart: number;
  strikes: number;
  blockedUntil: number;
  lastError: unknown;
};

const MAX_CONCURRENT = 2;

export const FLIGHT_DEFAULTS: Omit<FlightConfig, "now"> = {
  ttlMs: 2_000,
  minGapMs: 400,
  slowMs: 4_000,
  hangMs: 30_000,
  maxStaleMs: 300_000,
  backoffBaseMs: 10_000,
  backoffMaxMs: 120_000,
  freshDelayCapMs: 2_000,
};

export function isTransientRpcFailure(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  if ("code" in cause && cause.code === "transport_error") return true;
  return "status" in cause && typeof cause.status === "number" && [408, 429, 502, 503, 504].includes(cause.status);
}

/**
 * One in-flight request per key. Callers that arrive while it runs share it, a
 * recent good answer is reused for a short time, and a key that keeps failing
 * or answering slowly is left alone for a growing interval (the last good
 * answer is served meanwhile). `fresh` marks data known to have changed: it
 * skips the cache and shares a single follow-up request, spaced from the
 * previous start, with at most two requests running for a key at once.
 */
export function createFlight(overrides: Partial<FlightConfig> = {}): Flight {
  const config: FlightConfig = { ...FLIGHT_DEFAULTS, now: () => Date.now(), ...overrides };
  const entries = new Map<string, Entry>();
  const entryFor = (key: string): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { good: null, running: new Map(), newest: null, queued: null, lastStart: Number.NEGATIVE_INFINITY, settledStart: Number.NEGATIVE_INFINITY, strikes: 0, blockedUntil: 0, lastError: undefined };
      entries.set(key, entry);
    }
    return entry;
  };
  const backoff = (strikes: number) => Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** (strikes - 1));
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const run = <T>(entry: Entry, load: () => Promise<T>, slowStrikes: boolean): Promise<T> => {
    const started = config.now();
    entry.lastStart = started;
    const latest = () => started >= entry.settledStart;
    const pending: Promise<T> = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          const finished = config.now();
          if (!entry.good || started >= entry.good.startedAt) entry.good = { value, at: finished, startedAt: started };
          if (latest()) {
            entry.settledStart = started;
            entry.lastError = undefined;
            if (slowStrikes && finished - started >= config.slowMs) {
              entry.strikes++;
              entry.blockedUntil = finished + backoff(entry.strikes);
            } else {
              entry.strikes = 0;
              entry.blockedUntil = 0;
            }
          }
          return value;
        },
        (cause: unknown) => {
          if (latest()) {
            entry.settledStart = started;
            entry.strikes++;
            entry.lastError = cause;
            entry.blockedUntil = config.now() + backoff(entry.strikes);
            if (!isTransientRpcFailure(cause)) entry.good = null;
          }
          throw cause;
        },
      )
      .finally(() => {
        clearTimeout(abandon);
        forget();
      });
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const forget = () => {
      entry.running.delete(pending);
      if (entry.newest === pending) entry.newest = null;
      release();
    };
    const abandon = setTimeout(forget, config.hangMs);
    entry.running.set(pending, done);
    entry.newest = pending;
    return pending;
  };

  const queue = <T>(entry: Entry, load: () => Promise<T>, delay: number, slowStrikes: boolean): Promise<T> => {
    const queued = (async () => {
      if (delay > 0) await sleep(delay);
      while (entry.running.size >= MAX_CONCURRENT) await Promise.race(entry.running.values());
      const gap = entry.lastStart + config.minGapMs - config.now();
      if (gap > 0) await sleep(gap);
      entry.queued = null;
      return run(entry, load, slowStrikes);
    })();
    entry.queued = queued;
    return queued;
  };

  return {
    call<T>(key: string, load: () => Promise<T>, options: FlightOptions = {}): Promise<T> {
      const entry = entryFor(key);
      const now = config.now();
      const slowStrikes = options.slowStrikes ?? true;
      if (entry.queued) return entry.queued as Promise<T>;
      if (!options.fresh) {
        if (entry.newest) return entry.newest as Promise<T>;
        if (entry.good && now - entry.good.at < (options.ttlMs ?? config.ttlMs)) return Promise.resolve(entry.good.value as T);
        if (now < entry.blockedUntil) {
          const usable = entry.good && now - entry.good.at < (options.maxStaleMs ?? config.maxStaleMs);
          return usable ? Promise.resolve(entry.good!.value as T) : Promise.reject(entry.lastError);
        }
        return run(entry, load, slowStrikes);
      }
      const spacing = entry.lastStart + config.minGapMs - now;
      const blocked = entry.strikes >= 2 ? Math.min(entry.blockedUntil - now, config.freshDelayCapMs) : 0;
      const delay = Math.max(0, spacing, blocked);
      if (entry.running.size < MAX_CONCURRENT && delay <= 0) return run(entry, load, slowStrikes);
      return queue(entry, load, delay, slowStrikes);
    },
    peek<T>(key: string): T | undefined {
      return entries.get(key)?.good?.value as T | undefined;
    },
    ageOf(key: string) {
      const good = entries.get(key)?.good;
      return good ? config.now() - good.at : null;
    },
    invalidate(key?: string) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
    blockedUntil(key: string) {
      return entries.get(key)?.blockedUntil ?? 0;
    },
  };
}

let shared = createFlight();

export function rpcFlight(): Flight {
  return shared;
}

export function resetRpcFlight(overrides: Partial<FlightConfig> = {}): Flight {
  shared = createFlight(overrides);
  return shared;
}

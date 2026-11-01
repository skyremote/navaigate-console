type Slot = { pending: Promise<unknown> | null; value: { result: unknown; until: number } | null };

export type Coalescer = {
  run<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T>;
  invalidate(): void;
};

/**
 * One read per key at a time, shared by every caller that arrives while it
 * runs, and reused for a short time after it succeeds. A failure is passed to
 * the callers waiting on it and not kept. `invalidate` drops every kept answer
 * and stops a read that began earlier from being kept.
 */
export function createCoalescer(now: () => number = Date.now): Coalescer {
  const slots = new Map<string, Slot>();
  let epoch = 0;
  return {
    run<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T> {
      let slot = slots.get(key);
      if (!slot) {
        slot = { pending: null, value: null };
        slots.set(key, slot);
      }
      if (slot.value && slot.value.until > now()) return Promise.resolve(slot.value.result as T);
      if (slot.pending) return slot.pending as Promise<T>;
      const started = epoch;
      const owner = slot;
      const pending: Promise<T> = Promise.resolve()
        .then(work)
        .then((result) => {
          owner.value = { result, until: started === epoch ? now() + ttlMs : 0 };
          return result;
        })
        .finally(() => {
          if (owner.pending === pending) owner.pending = null;
        });
      owner.pending = pending;
      return pending;
    },
    invalidate() {
      epoch++;
      for (const slot of slots.values()) slot.value = null;
    },
  };
}

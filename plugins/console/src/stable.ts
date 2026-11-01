/**
 * A background read answers with a new object every time, even when nothing
 * changed. Setting that into state re-renders the whole rail and rebuilds its
 * model, so state that is read on a timer keeps its previous value when the new
 * one is the same data.
 */
export function keepIfSame<T>(previous: T, next: T): T {
  if (previous === next) return previous;
  try {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  } catch {
    return next;
  }
}

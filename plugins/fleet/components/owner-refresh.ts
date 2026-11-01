import type { OwnerDetail } from "../owner/detail-contract";

export const OWNER_REFRESH_MS = 15_000;
export const OWNER_STALE_AFTER_MS = 90_000;
export const OWNER_AGE_TICK_MS = 1_000;
export const OWNER_BACKOFF_MAX_MS = 120_000;

type Route = OwnerDetail["routes"][number];

export function ago(at: number | null, now: number = Date.now()): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

export function routeChip(route: Route, now: number): { label: string; tone: "ok" | "bad" | "" } {
  const stale = route.state === "healthy" && route.lastOkAt !== null && now - route.lastOkAt > OWNER_STALE_AFTER_MS;
  const state = stale ? "stale" : route.state;
  return {
    label: `${route.kind} ${state}${route.lastOkAt ? ` · ${ago(route.lastOkAt, now)}` : ""}`,
    tone: state === "healthy" ? "ok" : state === "unavailable" || state === "stale" ? "bad" : "",
  };
}

export function readAge(fetchedAt: number, failed: boolean, now: number): { label: string; tone: "ok" | "bad" | "" } {
  const old = now - fetchedAt > OWNER_STALE_AFTER_MS;
  const label = failed ? `refresh failed, last read ${ago(fetchedAt, now)}` : `read ${ago(fetchedAt, now)}`;
  return { label, tone: failed || old ? "bad" : "" };
}

export interface OwnerRefresher {
  start(): void;
  refresh(force?: boolean): void;
  setVisible(visible: boolean): void;
  stop(): void;
}

export interface OwnerRefresherOptions<T> {
  load: () => Promise<T>;
  onData: (value: T, at: number) => void;
  onError: (message: string) => void;
  visible: boolean;
  intervalMs?: number;
  now?: () => number;
}

export function createOwnerRefresher<T>(options: OwnerRefresherOptions<T>): OwnerRefresher {
  const intervalMs = options.intervalMs ?? OWNER_REFRESH_MS;
  const now = options.now ?? Date.now;
  let visible = options.visible;
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let again = false;
  let againForced = false;
  let failures = 0;
  let blockedUntil = 0;

  const clearTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const run = (force = false) => {
    if (stopped) return;
    if (inFlight) {
      again = true;
      againForced = againForced || force;
      return;
    }
    if (!force && now() < blockedUntil) return;
    inFlight = true;
    options.load().then(
      (value) => {
        failures = 0;
        blockedUntil = 0;
        if (!stopped) options.onData(value, now());
      },
      (cause: unknown) => {
        failures += 1;
        blockedUntil = failures >= 2 ? now() + Math.min(OWNER_BACKOFF_MAX_MS, intervalMs * 2 ** (failures - 1)) : 0;
        if (!stopped) options.onError(cause instanceof Error ? cause.message : String(cause));
      },
    ).finally(() => {
      inFlight = false;
      if (again && !stopped) {
        const forced = againForced;
        again = false;
        againForced = false;
        run(forced);
      }
    });
  };

  const arm = () => {
    clearTimer();
    if (running && visible && !stopped) timer = setInterval(() => run(), intervalMs);
  };

  return {
    start() {
      if (running || stopped) return;
      running = true;
      if (visible) run();
      arm();
    },
    refresh(force = false) {
      if (running && visible) run(force);
    },
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      if (!running) return;
      if (visible) run();
      arm();
    },
    stop() {
      stopped = true;
      running = false;
      clearTimer();
    },
  };
}

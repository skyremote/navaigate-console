// Usage spheres: the model behind Home's "Usage" card. One sphere is one
// subscription (an allowance), however many machines read it, so a plan seen on
// two Macs is one sphere. Levels come from the freshest machine reading, the
// same source as "Usage across machines"; burn rates come from the sampler's
// window of the same period and model.
import type { Trend, TrendWindow, UsageMachineRow } from "../server-usage-trend";
import { allowancesOf, readState, type ReadState } from "./usage-machines";
import { harnessOf } from "./shared";

const HOUR = 3_600_000;
const LONG_KINDS = ["weekly", "monthly", "daily"];

export type OrbWindow = {
  key: string;
  label: string;
  /** Percent of the window used, 0 once the window has reset. */
  used: number;
  left: number;
  resetsAt: number | null;
  /** Percent per hour over the last 30 minutes of readings; null while there are too few. */
  burn: number | null;
  /** When the window is full at that rate, if it is burning. */
  runsOutAt: number | null;
  /** True when it would be full before it resets. */
  beforeReset: boolean;
  main: boolean;
};

export type UsageOrb = {
  id: string;
  /** claude, codex, cursor or other: picks the liquid colour and the logo. */
  brand: string;
  name: string;
  plan: string | null;
  who: string | null;
  machines: string[];
  state: ReadState;
  observedAt: number | null;
  used: number;
  left: number;
  /** "week", "month", "session" and so on: what the level measures. */
  period: string;
  resetsAt: number | null;
  windows: OrbWindow[];
  /** The fastest-burning window, when any is burning: the burn rate shown is its rate. */
  hot: OrbWindow | null;
  /** The window that is full first at its own rate, when any would fill before it resets. A session climbs faster than a week, so this is not always `hot`. */
  first: OrbWindow | null;
  /** The highest burn rate among the windows; null while none has one. */
  burn: number | null;
  /** Flame strength from 0 to 1; 0 unless a current reading is burning. */
  heat: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

function labelOf(w: UsageMachineRow["windows"][number]): string {
  const base = w.kind === "five-hour" ? "Session" : w.kind === "weekly" ? "Week" : w.kind === "monthly" ? "Month" : w.kind === "daily" ? "Day" : w.label;
  return w.model ? `${base} · ${cap(w.model)}` : base;
}

/** The sampler's window for the same period and model. Old window ids linger in storage, so the one read most recently wins. */
function sampled(windows: readonly TrendWindow[], w: UsageMachineRow["windows"][number]): TrendWindow | null {
  const session = w.kind === "five-hour";
  const same = windows.filter((x) => (x.span === "session") === session && (x.model ?? null) === (w.model ?? null));
  const lastAt = (x: TrendWindow) => x.series[x.series.length - 1]?.[0] ?? 0;
  return same.sort((a, b) => lastAt(b) - lastAt(a))[0] ?? null;
}

/**
 * Flame strength for a burning window. Half of it is whether this rate would
 * fill the window before it resets, a quarter the rate itself, and any burn at
 * all shows a small flame.
 */
function heatOf(w: OrbWindow, now: number): number {
  if (w.burn === null || w.burn <= 0) return 0;
  const ref = w.label.startsWith("Session") ? 50 : 10;
  const pace = w.resetsAt !== null && w.resetsAt > now && w.left > 0 ? (w.burn * ((w.resetsAt - now) / HOUR)) / w.left : w.burn / (ref * 0.6);
  return clamp(0.25 + 0.5 * Math.min(1, pace / 2) + 0.25 * Math.min(1, w.burn / ref), 0, 1);
}

export function usageOrbs(trend: Trend, now: number = trend.now): UsageOrb[] {
  const orbs: UsageOrb[] = [];
  for (const allowance of allowancesOf(trend.machines ?? [])) {
    // The freshest reading that has windows; a machine with no reading draws nothing.
    const row = [...allowance.rows].filter((r) => r.windows.length > 0).sort((a, b) => Number(b.freshness !== "unavailable") - Number(a.freshness !== "unavailable") || (b.observedAt ?? 0) - (a.observedAt ?? 0))[0];
    if (!row) continue;
    const state = readState(row);
    const account = trend.accounts.find((a) => a.id === allowance.id) ?? null;
    const plain = row.windows.filter((w) => w.model === null);
    const mainRaw = LONG_KINDS.map((k) => plain.find((w) => w.kind === k)).find(Boolean) ?? plain.find((w) => w.kind !== "five-hour") ?? plain[0] ?? row.windows[0];
    const windows: OrbWindow[] = row.windows.map((w, n) => {
      const lapsed = w.resetsAt !== null && w.resetsAt <= now;
      const used = lapsed ? 0 : clamp(w.pct, 0, 100);
      const burn = lapsed || state !== "current" ? null : sampled(account?.windows ?? [], w)?.burn ?? null;
      const runsOutAt = burn !== null && burn > 0 && used < 100 ? now + ((100 - used) / burn) * HOUR : null;
      return {
        key: `${w.kind}:${w.model ?? ""}:${n}`,
        label: labelOf(w),
        used,
        left: 100 - used,
        resetsAt: lapsed ? null : w.resetsAt,
        burn,
        runsOutAt,
        beforeReset: runsOutAt !== null && (w.resetsAt === null || runsOutAt < w.resetsAt),
        main: w === mainRaw,
      };
    });
    const main = windows.find((w) => w.main) ?? windows[0];
    const burning = windows.filter((w) => w.burn !== null && w.burn > 0);
    const hot = [...burning].sort((a, b) => (b.burn ?? 0) - (a.burn ?? 0))[0] ?? null;
    const first = burning.filter((w) => w.beforeReset && w.runsOutAt !== null).sort((a, b) => (a.runsOutAt ?? 0) - (b.runsOutAt ?? 0))[0] ?? null;
    const rates = windows.map((w) => w.burn).filter((b): b is number => b !== null);
    const label = harnessOf(row.provider).label;
    // Machines can name one plan differently ("Pro", "ChatGPT Pro"): the fullest name reads best.
    const named = allowance.rows.map((r) => r.plan).filter((p): p is string => !!p).sort((a, b) => b.length - a.length)[0] ?? null;
    const plan = named && named.toLowerCase().startsWith(`${label.toLowerCase()} `) ? named.slice(label.length).trim() : named;
    orbs.push({
      id: allowance.id,
      brand: harnessOf(row.provider).key,
      name: label,
      plan,
      who: allowance.rows.find((r) => r.label)?.label ?? null,
      machines: allowance.machines,
      state,
      observedAt: row.observedAt,
      used: main.used,
      left: main.left,
      period: main.label.toLowerCase(),
      resetsAt: main.resetsAt,
      windows,
      hot,
      first,
      burn: rates.length ? Math.max(...rates) : null,
      heat: burning.reduce((most, w) => Math.max(most, heatOf(w, now)), 0),
    });
  }
  return orbs;
}

/** The sphere to describe when none is picked: the one burning fastest, or the first. */
export function hottest(orbs: readonly UsageOrb[]): UsageOrb | null {
  return [...orbs].filter((o) => o.heat > 0).sort((a, b) => (b.burn ?? 0) - (a.burn ?? 0))[0] ?? orbs[0] ?? null;
}

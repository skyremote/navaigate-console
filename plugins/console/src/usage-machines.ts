// Usage across machines: the model behind Home's "Usage across machines" card.
// Rows are one provider on one machine, as the usage sampler recorded them;
// an allowance is one subscription, which may be read on several machines.
import { getProfile } from "./use-profile";
import type { UsageMachineRow } from "../server-usage-trend";

export type MachineReading = { label: string; pct: number; remaining: number; resetsAt: number | null };
export type ReadState = "current" | "retained" | "unavailable";
export type Allowance = {
  id: string;
  harness: UsageMachineRow["harness"];
  rows: UsageMachineRow[];
  machines: string[];
  shared: boolean;
  identity: UsageMachineRow["identity"];
  plan: string | null;
  session: MachineReading | null;
  long: MachineReading | null;
  observedAt: number | null;
};
export type SameAccountHint = { harness: UsageMachineRow["harness"]; keys: string[]; machines: string[]; resetsAt: number };

const LONG_KINDS = ["weekly", "monthly", "daily"];
export const SAME_RESET_MS = 60_000;

export const machineRank = (machine: string) => {
  const order = getProfile().machines.map((m) => m.id);
  const i = order.indexOf(machine);
  return i === -1 ? order.length : i;
};
export const sortMachines = (machines: string[]) => [...machines].sort((a, b) => machineRank(a) - machineRank(b) || a.localeCompare(b));

export const readState = (row: UsageMachineRow): ReadState => (row.freshness === "fresh" ? "current" : row.freshness === "stale" || (row.windows.length > 0 && row.observedAt !== null) ? "retained" : "unavailable");

function reading(row: UsageMachineRow, pick: (kind: string) => boolean): MachineReading | null {
  const ws = row.windows.filter((w) => w.model === null && pick(w.kind));
  const w = LONG_KINDS.map((k) => ws.find((x) => x.kind === k)).find(Boolean) ?? ws[0];
  return w ? { label: w.label, pct: w.pct, remaining: Math.max(0, Math.min(100, 100 - w.pct)), resetsAt: w.resetsAt } : null;
}
export const sessionOf = (row: UsageMachineRow) => reading(row, (k) => k === "five-hour");
export const longOf = (row: UsageMachineRow) => reading(row, (k) => LONG_KINDS.includes(k));

/** The newest reading of a window among a subscription's machines. Never a sum: one allowance read twice is still one allowance. */
function freshest(rows: UsageMachineRow[], of: (row: UsageMachineRow) => MachineReading | null): MachineReading | null {
  const usable = rows.filter((r) => of(r) && r.freshness !== "unavailable").sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0));
  const best = usable[0] ?? rows.filter((r) => of(r)).sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0];
  return best ? of(best) : null;
}

export function allowancesOf(rows: readonly UsageMachineRow[]): Allowance[] {
  const groups = new Map<string, UsageMachineRow[]>();
  for (const row of rows) groups.set(row.allowanceId, [...(groups.get(row.allowanceId) ?? []), row]);
  const order: Record<string, number> = { claude: 0, codex: 1, cursor: 2, other: 3 };
  return [...groups].map(([id, members]) => {
    const machines = sortMachines([...new Set(members.map((m) => m.machine))]);
    const identity = members.some((m) => m.identity === "token-verified") ? "token-verified" : members.some((m) => m.identity === "confirmed") ? "confirmed" : "unknown";
    return {
      id,
      harness: members[0].harness,
      rows: [...members].sort((a, b) => machineRank(a.machine) - machineRank(b.machine) || a.machine.localeCompare(b.machine)),
      machines,
      shared: machines.length > 1,
      identity,
      plan: members.find((m) => m.plan)?.plan ?? null,
      session: freshest(members, sessionOf),
      long: freshest(members, longOf),
      observedAt: members.reduce<number | null>((n, m) => (m.observedAt === null ? n : Math.max(n ?? 0, m.observedAt)), null),
    } satisfies Allowance;
  }).sort((a, b) => order[a.harness] - order[b.harness] || a.id.localeCompare(b.id));
}

/**
 * Two readings of one provider on different machines that count as separate
 * allowances but report the same long-window reset time. Claude gives no
 * account id, so this is evidence for the owner to confirm, never a merge.
 */
export function sameAccountHints(rows: readonly UsageMachineRow[]): SameAccountHint[] {
  const hints: SameAccountHint[] = [];
  const all = allowancesOf(rows);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (a.harness !== b.harness || a.harness === "cursor" || a.harness === "other") continue;
      if (a.machines.some((m) => b.machines.includes(m))) continue;
      const ra = a.long?.resetsAt ?? null;
      const rb = b.long?.resetsAt ?? null;
      if (ra === null || rb === null || Math.abs(ra - rb) > SAME_RESET_MS) continue;
      if ([...a.rows, ...b.rows].some((r) => r.freshness === "unavailable")) continue;
      hints.push({ harness: a.harness, keys: [...a.rows, ...b.rows].map((r) => r.key), machines: sortMachines([...a.machines, ...b.machines]), resetsAt: Math.max(ra, rb) });
    }
  }
  return hints;
}

export function usageTotals(rows: readonly UsageMachineRow[]) {
  const allowances = new Set(rows.map((r) => r.allowanceId)).size;
  return { readings: rows.length, allowances, countedOnce: rows.length - allowances };
}

import type { Trend, UsageMachineRow } from "../../server-usage-trend";

const HOUR = 3_600_000;

const row = (over: Partial<UsageMachineRow>): UsageMachineRow => ({
  key: "", provider: "claude", harness: "claude", machine: "laptop", label: null, plan: null, observedAt: null, freshness: "fresh", identity: "unknown", allowanceId: "", windows: [], ...over,
});

export const CLAUDE_M5 = row({ key: "claude:host_m5:claude-pool", machine: "laptop", label: "sam", plan: "Max 20x", allowanceId: "claude-pool" });
export const CLAUDE_M1 = row({ key: "claude:host_m1:native-default", machine: "studio", plan: "Max 20x", allowanceId: "fleet-usage:claude:owner:m1" });
export const CODEX_M5 = row({ key: "codex:host_m5:codex-pool", provider: "codex", harness: "codex", machine: "laptop", label: "sam", plan: "ChatGPT Pro", allowanceId: "codex-pool" });

export function trendWithMachines(now: number): Trend {
  const week = now + 4 * 24 * HOUR;
  const win = (kind: "five-hour" | "weekly", pct: number, resetsAt: number) => ({ kind, label: kind === "weekly" ? "Week" : "Session", model: null, pct, resetsAt });
  return {
    now,
    sampledFrom: now - 2 * HOUR,
    accounts: [],
    sources: [
      { machine: "laptop", ownerServerId: "owner_m5", hostId: "host_m5", state: "self" },
      { machine: "studio", ownerServerId: "owner_m1", hostId: "host_m1", state: "fresh", providers: { claude: "fresh" } },
      { machine: "work", ownerServerId: null, hostId: null, state: "unavailable" },
    ],
    machines: [
      { ...CLAUDE_M5, observedAt: now - 60_000, windows: [win("five-hour", 30, now + 3 * HOUR), win("weekly", 41, week)] },
      { ...CLAUDE_M1, observedAt: now - 3 * 60_000, windows: [win("five-hour", 31, now + 3 * HOUR), win("weekly", 42, week + 20_000)] },
      { ...CODEX_M5, observedAt: now - 2 * 60_000, windows: [win("five-hour", 12, now + 2 * HOUR), win("weekly", 25, week + 3 * HOUR)] },
    ],
  };
}

export const SHA_BASE = "f8ee2514a0b1c2d3e4f5061728394a5b6c7d8e9f";
export const worktreeView = {
  readAt: 1_800_000_000_000,
  environmentId: "e-main",
  hostId: "m5",
  hostName: "Laptop",
  base: { ref: "main", sha: SHA_BASE },
  overlaps: [{ path: "src/native-session-rail.ts", branches: ["task/receipt-ui", "task/rail-sort"] }],
  warnings: ["Work could not be read: no route"],
  rows: [
    {
      path: "/w/receipt", branch: "task/receipt-ui", head: "0c095a2".padEnd(40, "1"), mergeBase: SHA_BASE, ahead: 2, behind: 0,
      additions: 118, deletions: 14, filesTruncated: false, dirty: false, locked: false, conflicts: [],
      files: [{ path: "src/native-receipt.tsx", additions: 96, deletions: 2 }, { path: "src/native-session-rail.ts", additions: 22, deletions: 12 }],
      hostId: "m1", hostName: "Studio", environmentId: "e-m1", environmentName: "receipt UI", sameHost: false,
    },
    {
      path: "/w/rail", branch: "task/rail-sort", head: "9d2e7b4".padEnd(40, "2"), mergeBase: SHA_BASE, ahead: 1, behind: 3,
      additions: 9, deletions: 4, filesTruncated: false, dirty: false, locked: false, conflicts: ["src/native-session-rail.ts"],
      files: [{ path: "src/native-session-rail.ts", additions: 9, deletions: 4 }],
      hostId: "m5", hostName: "Laptop", environmentId: "e-rail", environmentName: "rail sort", sameHost: true,
    },
    {
      path: "/w/scratch", branch: "task/scratch", head: "1111111".padEnd(40, "3"), mergeBase: SHA_BASE, ahead: 0, behind: 0,
      additions: 0, deletions: 0, filesTruncated: false, dirty: true, locked: false, conflicts: [], files: [],
      hostId: "m5", hostName: "Laptop", environmentId: "e-scratch", environmentName: "scratch", sameHost: true,
    },
  ],
};
export const prAvailable = (state: "open" | "draft", over: Record<string, unknown> = {}) => ({
  outcome: "available" as const,
  pullRequest: {
    number: 58, title: "Receipt UI", state, url: "https://github.com/example/x/pull/58", baseRefName: "main", headRefName: "task/receipt-ui",
    updatedAt: "2026-11-01T08:00:00Z", autoMerge: false, inMergeQueue: false,
    checks: { state: "passing" as const, totalCount: 3, passedCount: 3, failedCount: 0, pendingCount: 0 },
    review: { state: "approved" as const, reviewRequestCount: 0 },
    mergeability: { state: "mergeable" as const, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" },
    attention: "none", ...over,
  },
});

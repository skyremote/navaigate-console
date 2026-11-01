import { describe, expect, it } from "vitest";
import { readiness, readinessGroup, readinessSummary } from "../src/delivery-model";
import { prAvailable } from "./fixtures/delivery-worktrees";

const pr = (over: Record<string, unknown>) => prAvailable("open", over) as never;
const ready = pr({});
const pending = pr({ checks: { state: "pending", totalCount: 2, passedCount: 1, failedCount: 0, pendingCount: 1 } });
const draft = prAvailable("draft") as never;
const conflicts = pr({ mergeability: { state: "conflicts", mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } });

describe("merge readiness order", () => {
  it("sorts ready, then checks pending, then draft, then conflicts", () => {
    const ordered = [conflicts, draft, pending, ready].map((r) => readiness(r).tier);
    expect(ordered).toEqual([...ordered].sort((a, b) => b - a));
    expect(readiness(ready).tier).toBeLessThan(readiness(pending).tier);
    expect(readiness(pending).tier).toBeLessThan(readiness(draft).tier);
    expect(readiness(draft).tier).toBeLessThan(readiness(conflicts).tier);
  });
  it("puts a PR nobody can read after every verified one, so Unverified is never mistaken for ready", () => {
    expect(readiness({ outcome: "unavailable", message: "gitlab" }).tier).toBeGreaterThan(readiness(conflicts).tier);
  });
});

describe("readinessGroup and summary", () => {
  it("names a group per tier", () => {
    expect([ready, pending, draft, conflicts].map((r) => readinessGroup(readiness(r).tier))).toEqual(["Likely ready", "Checks pending", "Draft", "Conflicts"]);
  });
  it("counts rows per group in display order and leaves empty groups out", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
    const results = { a: conflicts, b: ready, c: ready, d: draft, e: { outcome: "unavailable", message: "x" } } as never;
    expect(readinessSummary(rows, results)).toEqual([
      { group: "Likely ready", count: 2 },
      { group: "Draft", count: 1 },
      { group: "Conflicts", count: 1 },
      { group: "Unverified", count: 1 },
    ]);
  });
});

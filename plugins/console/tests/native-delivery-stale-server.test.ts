import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createDelivery } from "../server-delivery";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const env = (id: string, ageDays: number, over: Record<string, unknown> = {}) => ({
  id, hostId: "m5", path: `/w/${id}`, projectId: "p", branchName: `task/${id}`, name: id, status: "ready", isGitRepo: true, isWorktree: true,
  managed: true, workspaceProvisionType: "managed-worktree", updatedAt: NOW - ageDays * DAY, lifecycle: { phase: "active" }, ...over,
});
function setup(options: { guarded?: boolean; dirty?: string[] } = {}) {
  const environments = [
    env("old-1", 20), env("old-2", 30), env("old-3", 12), env("old-dirty", 40), env("fresh", 1),
    env("plain-checkout", 90, { isWorktree: false, managed: false }),
  ];
  const cleanup = vi.fn(async () => undefined);
  const hostCall = vi.fn(async (_m: string, input: { cwd: string }) => {
    const dirty = (options.dirty ?? ["old-dirty"]).some((id) => input.cwd.endsWith(id));
    return { revision: "abc", dirty, ignored: false, locked: false, processState: "clear", reasons: dirty ? ["Tracked changes or untracked files are present."] : [] };
  });
  const callRpc = vi.fn(async () => {
    if (options.guarded === false) throw new Error("no such method");
    return { version: 1, retainsReferences: true, retainsLocalFiles: true, retainsBusyWorktrees: true, automaticRetirement: false };
  });
  const bb = {
    storage: { kv: { get: vi.fn(), set: vi.fn() } },
    realtime: { publish: vi.fn() },
    hosts: { experimental_client: () => ({ call: hostCall }) },
    sdk: {
      environments: {
        get: vi.fn(async ({ environmentId }: { environmentId: string }) => environments.find((item) => item.id === environmentId)),
        list: vi.fn(async () => environments),
        experimental_cleanup: cleanup,
      },
      hosts: { get: vi.fn(async () => ({ name: "Laptop", status: "connected", lifecycle: { phase: "active" } })) },
      threads: { list: vi.fn(async ({ environmentId }: { environmentId: string }) => (environmentId === "fresh" ? [] : [{ id: "x", updatedAt: NOW - 100 * DAY, deletedAt: 5, pinnedAt: null, status: "idle", archivedAt: 1 }])) },
      plugins: { callRpc },
    },
  };
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  return { engine: createDelivery(bb as unknown as BbPluginApi), cleanup, kvSet: bb.storage.kv.set, threadList: bb.sdk.threads.list };
}

describe("stale worktrees (server)", () => {
  it("lists only managed worktrees idle past the threshold, oldest first, each with its own plan", async () => {
    const { engine } = setup();
    const view = await engine.staleWorktrees({ days: 7 });
    expect(view.rows.map((r) => r.environmentId)).toEqual(["old-dirty", "old-2", "old-1", "old-3"]);
    expect(view.rows.map((r) => r.idleDays)).toEqual([40, 30, 20, 12]);
    expect(view.rows.find((r) => r.environmentId === "old-1")!.plan).toMatchObject({ eligible: true, blockers: [] });
    expect(view.guarded).toBe(true);
  });

  it("skips the worktree with local changes and says why", async () => {
    const { engine } = setup();
    const view = await engine.staleWorktrees({ days: 7 });
    const dirty = view.rows.find((r) => r.environmentId === "old-dirty")!;
    expect(dirty.plan.eligible).toBe(false);
    expect(dirty.plan.blockers.join(" ")).toContain("Tracked changes");
    expect(view.rows.filter((r) => r.plan.eligible)).toHaveLength(3);
  });

  it("reports that protected cleanup is missing on stock core instead of offering removal", async () => {
    const { engine } = setup({ guarded: false });
    const view = await engine.staleWorktrees({ days: 7 });
    expect(view.guarded).toBe(false);
    expect(view.rows.every((r) => !r.plan.eligible)).toBe(true);
  });

  it("requests cleanup only for rows still eligible with an unchanged plan", async () => {
    const { engine, cleanup } = setup();
    const view = await engine.staleWorktrees({ days: 7 });
    const items = view.rows.map((r) => ({ environmentId: r.environmentId, fingerprint: r.plan.fingerprint }));
    const result = await engine.staleCleanup({ items, intent: "explicit-user-action" });
    expect(cleanup.mock.calls.map((c) => (c[0] as { environmentId: string }).environmentId).sort()).toEqual(["old-1", "old-2", "old-3"]);
    expect(result.results.find((r) => r.environmentId === "old-dirty")).toMatchObject({ outcome: "skipped" });
    expect(result.results.filter((r) => r.outcome === "requested")).toHaveLength(3);
    expect(result.message).toContain("not proof");
  });

  it("skips a row whose plan changed after it was listed", async () => {
    const { engine, cleanup } = setup();
    const result = await engine.staleCleanup({ items: [{ environmentId: "old-1", fingerprint: "stale-fingerprint" }], intent: "explicit-user-action" });
    expect(cleanup).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ outcome: "skipped" });
    expect(result.results[0].message).toContain("changed");
  });

  it("reads the list without writing a stored plan for every row", async () => {
    const { engine, kvSet } = setup();
    await engine.staleWorktrees({ days: 7 });
    expect(kvSet).not.toHaveBeenCalled();
  });

  it("still lets a single plan be stored for the apply step", async () => {
    const { engine, kvSet } = setup();
    await engine.plan("old-1");
    expect(kvSet).toHaveBeenCalledTimes(1);
  });
});

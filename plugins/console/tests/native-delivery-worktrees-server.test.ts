import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createDelivery } from "../server-delivery";

const BASE = "a".repeat(40);
const row = (over: Record<string, unknown>) => ({
  path: "/w/x", branch: "x", head: "b".repeat(40), mergeBase: BASE, ahead: 1, behind: 0, additions: 3, deletions: 1,
  files: [{ path: "src/shared.ts", additions: 3, deletions: 1 }], filesTruncated: false, dirty: false, locked: false, conflicts: [], ...over,
});
const env = (id: string, hostId: string, path: string, branchName: string) => ({
  id, hostId, path, projectId: "p", branchName, name: branchName, status: "ready", isGitRepo: true, isWorktree: true, managed: true,
  lifecycle: { phase: "active" },
});
function setup(failM1 = false, extraHosts: string[] = [], remoteDelayMs = 0) {
  const environments = [
    env("e-main", "m5", "/w/main", "main"),
    env("e-a", "m5", "/w/a", "task-a"),
    env("e-m1", "m1", "/w/m1", "m1-task"),
    ...extraHosts.map((host) => env(`e-${host}`, host, `/w/${host}`, `${host}-task`)),
  ];
  const starts: string[] = [],
    finishes: string[] = [];
  const hostCall = vi.fn(async (method: string, input: { cwd: string }, options: { hostId: string }) => {
    if (method === "worktrees" && options.hostId === "m5")
      return { cwd: input.cwd, base: { ref: "main", sha: BASE }, overlaps: [], worktrees: [row({ path: "/w/a", branch: "task-a", head: "c".repeat(40) })] };
    if (method === "worktrees") {
      starts.push(options.hostId);
      if (remoteDelayMs) await new Promise((resolve) => setTimeout(resolve, remoteDelayMs));
      finishes.push(options.hostId);
      if (failM1) throw new Error("ssh: no route");
      return {
        cwd: input.cwd, base: { ref: BASE, sha: BASE }, overlaps: [],
        worktrees: [row({ path: "/w/main-clone", branch: "main", ahead: 0, files: [] }), row({ path: input.cwd, branch: `${options.hostId}-task`, head: "d".repeat(40), files: [{ path: "src/shared.ts", additions: 2, deletions: 0 }] })],
      };
    }
    if (method === "pushBranch") return { pushed: true };
    return { merged: true, sha: "e".repeat(40), previous: BASE, conflicts: [] };
  });
  const bb = {
    storage: { kv: { get: vi.fn(), set: vi.fn() } },
    realtime: { publish: vi.fn() },
    hosts: { experimental_client: () => ({ call: hostCall }) },
    sdk: {
      environments: {
        get: vi.fn(async ({ environmentId }: { environmentId: string }) => environments.find((item) => item.id === environmentId)),
        list: vi.fn(async () => environments),
      },
      hosts: { get: vi.fn(async ({ hostId }: { hostId: string }) => ({ name: ({ m5: "Laptop", m1: "Studio" } as Record<string, string>)[hostId] ?? hostId.toUpperCase(), status: "connected", lifecycle: { phase: "active" } })) },
      threads: { list: vi.fn(async () => []) },
      plugins: { callRpc: vi.fn() },
    },
  };
  return { engine: createDelivery(bb as unknown as BbPluginApi), hostCall, starts, finishes };
}

describe("delivery worktrees (server)", () => {
  it("shows the base once and every worktree across machines, flagging the file both edit", async () => {
    const { engine } = setup();
    const view = await engine.worktrees("e-main");
    expect(view.base).toEqual({ ref: "main", sha: BASE });
    expect(view.rows.map((r) => [r.branch, r.hostName, r.environmentId, r.sameHost])).toEqual([
      ["task-a", "Laptop", "e-a", true],
      ["m1-task", "Studio", "e-m1", false],
    ]);
    expect(view.overlaps).toEqual([{ path: "src/shared.ts", branches: ["task-a", "m1-task"] }]);
  });

  it("keeps the rest when one machine cannot be read and says which one", async () => {
    const { engine } = setup(true);
    const view = await engine.worktrees("e-main");
    expect(view.rows.map((r) => r.branch)).toEqual(["task-a"]);
    expect(view.warnings.join(" ")).toContain("Studio could not be read: ssh: no route");
  });

  it("merges a same-machine branch without any push", async () => {
    const { engine, hostCall } = setup();
    const result = await engine.worktreeMerge({ environmentId: "e-main", sourceEnvironmentId: "e-a", branch: "task-a", expectedHead: "c".repeat(40), expectedBaseHead: BASE, expectedBaseRef: "main", intent: "explicit-user-action" });
    expect(result.outcome.merged).toBe(true);
    expect(result.message).toContain("Nothing was pushed");
    expect(hostCall.mock.calls.map((call) => call[0])).toEqual(["mergeBack"]);
    expect(hostCall.mock.calls[0][1]).toMatchObject({ cwd: "/w/main", fetch: false });
  });

  it("pushes from the other machine first, then fetches and merges here", async () => {
    const { engine, hostCall } = setup();
    await engine.worktreeMerge({ environmentId: "e-main", sourceEnvironmentId: "e-m1", branch: "m1-task", expectedHead: "d".repeat(40), expectedBaseHead: BASE, expectedBaseRef: "main", intent: "explicit-user-action" });
    expect(hostCall.mock.calls.map((call) => [call[0], (call[2] as { hostId: string }).hostId])).toEqual([["pushBranch", "m1"], ["mergeBack", "m5"]]);
    expect(hostCall.mock.calls[1][1]).toMatchObject({ fetch: true });
  });

  it("reports a conflicting merge as not merged", async () => {
    const { engine, hostCall } = setup();
    hostCall.mockImplementationOnce(async () => ({ merged: false, sha: null, previous: BASE, conflicts: ["src/shared.ts"] }));
    const result = await engine.worktreeMerge({ environmentId: "e-main", sourceEnvironmentId: "e-a", branch: "task-a", expectedHead: "c".repeat(40), expectedBaseHead: BASE, expectedBaseRef: "main", intent: "explicit-user-action" });
    expect(result.outcome.merged).toBe(false);
    expect(result.message).toContain("1 file would conflict");
  });

  it("rejects a merge without the explicit intent", async () => {
    const { engine } = setup();
    await expect(engine.worktreeMerge({ environmentId: "e-main", sourceEnvironmentId: null, branch: "task-a", expectedHead: "c".repeat(40), expectedBaseHead: BASE } as never)).rejects.toThrow();
  });

  it("sends the base branch the panel showed, so a moved base is refused rather than merged into", async () => {
    const { engine, hostCall } = setup();
    await engine.worktreeMerge({ environmentId: "e-a", sourceEnvironmentId: "e-main", branch: "task-a", expectedHead: "c".repeat(40), expectedBaseHead: BASE, expectedBaseRef: "main", intent: "explicit-user-action" });
    expect(hostCall.mock.calls[0][1]).toMatchObject({ expectedBaseRef: "main" });
  });

  it("asked from a linked worktree, reports the shared base and lists the asking worktree as a row", async () => {
    const { engine } = setup();
    const view = await engine.worktrees("e-a");
    expect(view.base.ref).toBe("main");
    expect(view.environmentId).toBe("e-a");
    expect(view.rows.map((r) => r.branch)).toContain("task-a");
  });

  it("reads the other machines at the same time and gives each a short bound", async () => {
    vi.useFakeTimers();
    try {
      const { engine, hostCall, starts, finishes } = setup(false, ["m4", "m3"], 1000);
      const pending = engine.worktrees("e-main");
      await vi.advanceTimersByTimeAsync(10);
      expect(starts.sort()).toEqual(["m1", "m3", "m4"]);
      expect(finishes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      const view = await pending;
      expect(view.rows.map((r) => r.branch)).toEqual(["task-a", "m1-task", "m4-task", "m3-task"]);
      const remote = hostCall.mock.calls.filter((call) => (call[2] as { hostId: string }).hostId !== "m5");
      expect(remote.every((call) => (call[2] as { timeoutMs: number }).timeoutMs <= 20_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

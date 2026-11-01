import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { classifyHost, readGitHost, readReview } from "../host-delivery";
import { createDelivery } from "../server-delivery";
import { reviewSchema } from "../delivery-contract";

describe("naming the Git host", () => {
  it.each([
    ["github.com", "github", "GitHub", true],
    ["github.example-corp.com", "github", "GitHub", true],
    ["gitlab.com", "gitlab", "GitLab", true],
    ["gitlab.internal.example", "gitlab", "GitLab", true],
    ["bitbucket.org", "bitbucket", "Bitbucket", false],
    ["bitbucket.internal.example", "bitbucket", "Bitbucket", false],
    ["dev.azure.com", "azure", "Azure DevOps", false],
    ["acme.visualstudio.com", "azure", "Azure DevOps", false],
    ["git.sr.ht", "other", "git.sr.ht", false],
  ])("%s is %s", (hostname, kind, label, adapter) => {
    expect(classifyHost(hostname)).toEqual({ kind, label, reviewAdapter: adapter });
  });

  it("reads the host from the origin remote alone", async () => {
    const run = vi.fn(async () => "git@bitbucket.org:team/repo.git\n");
    expect(await readGitHost("/work/tree", run)).toEqual({ host: "bitbucket.org", hostKind: "bitbucket", label: "Bitbucket", reviewAdapter: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual(["git", ["remote", "get-url", "origin"], "/work/tree"]);
  });
});

describe("a review on a host without an adapter", () => {
  it("names the host instead of reporting an unexplained unknown", async () => {
    const result = await readReview("/work/tree", null, async () => "https://dev.azure.com/org/project/_git/repo");
    expect(result).toMatchObject({ provider: "unknown", host: "dev.azure.com", hostKind: "azure" });
    expect(result.text).toContain("Azure DevOps (dev.azure.com)");
    expect(result.warnings.join(" ")).toContain("Azure DevOps");
    expect(reviewSchema.safeParse(result).success).toBe(true);
  });

  it("carries the host on a GitLab merge request read too", async () => {
    const mr = { web_url: "https://gitlab.com/g/r/-/merge_requests/7", sha: "abc", iid: 7, title: "Fix" };
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "git") return "https://gitlab.com/g/r";
      if (args[0] === "api") return "[]";
      if (args[1] === "diff") return "diff";
      return JSON.stringify(mr);
    });
    const result = await readReview("/work/tree", null, run);
    expect(result).toMatchObject({ provider: "gitlab", host: "gitlab.com", hostKind: "gitlab", url: mr.web_url });
  });
});

describe("the hosts of many owner workspaces", () => {
  function delivery(hostCall: (method: string, input: { cwd: string }) => unknown, env: (id: string) => unknown) {
    const bb = {
      storage: { kv: { get: vi.fn(), set: vi.fn() } }, realtime: { publish: vi.fn() },
      hosts: { experimental_client: () => ({ call: vi.fn(async (method: string, input: { cwd: string }) => hostCall(method, input)) }) },
      sdk: { environments: { get: vi.fn(async ({ environmentId }: { environmentId: string }) => env(environmentId)) }, hosts: { get: vi.fn(async () => ({ name: "Studio", status: "connected", lifecycle: { phase: "active" } })) }, plugins: { callRpc: vi.fn() }, threads: { list: vi.fn(async () => []) }, system: {} },
    };
    return createDelivery(bb as unknown as BbPluginApi);
  }
  const ready = (id: string) => ({ id, path: `/work/${id}`, projectId: "p", hostId: "h", managed: true, isWorktree: true, workspaceProvisionType: "managed-worktree", status: "ready", lifecycle: { phase: "active" } });

  it("returns each workspace's host and null for one that cannot be read", async () => {
    const service = delivery(
      (method, input) => { if (method !== "gitHost") throw new Error("unexpected"); if (input.cwd.endsWith("bad")) throw new Error("no remote"); return { host: input.cwd.endsWith("gl") ? "gitlab.com" : "bitbucket.org", hostKind: input.cwd.endsWith("gl") ? "gitlab" : "bitbucket", label: input.cwd.endsWith("gl") ? "GitLab" : "Bitbucket", reviewAdapter: input.cwd.endsWith("gl") }; },
      (id) => (id === "gone" ? { ...ready(id), status: "stopped" } : ready(id)),
    );
    expect(await service.hosts(["a-gl", "b-bb", "bad", "gone"].map((id) => id.replace("a-gl", "gl").replace("b-bb", "bb")))).toEqual({
      gl: { host: "gitlab.com", hostKind: "gitlab", label: "GitLab", reviewAdapter: true },
      bb: { host: "bitbucket.org", hostKind: "bitbucket", label: "Bitbucket", reviewAdapter: false },
      bad: null,
      gone: null,
    });
  });
});

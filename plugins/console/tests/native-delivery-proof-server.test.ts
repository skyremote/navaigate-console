import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createDelivery } from "../server-delivery";
import type { PullRequest } from "../delivery-contract";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const basePr: PullRequest = {
  number: 7,
  title: "Fix",
  state: "open",
  url: "https://github.com/acme/widgets/pull/7",
  baseRefName: "main",
  headRefName: "fix",
  updatedAt: "2026-10-30T12:00:00Z",
  autoMerge: false,
  inMergeQueue: false,
  checks: { state: "passing", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 },
  review: { state: "approved", reviewRequestCount: 0 },
  mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" },
  attention: "ready_to_merge",
};
const receipt = {
  uploaded: true, repo: "acme/widgets", pr: 7, prUrl: basePr.url, branch: "delivery-proof", commit: "c".repeat(40), uploadedAt: "2026-11-01T10:00:00Z",
  accessPolicy: "Private repository: visible only to people with read access to acme/widgets.", expiry: "None: kept until the delivery-proof branch is deleted.",
  files: [{ name: "after.png", bytes: 16, mime: "image/png", sha256: "d".repeat(64), path: "pr-7/x/after.png", url: "https://github.com/acme/widgets/blob/c/pr-7/x/after.png?raw=true", verified: true }],
  comment: { id: 1, url: "https://github.com/acme/widgets/pull/7#issuecomment-9001", verified: true },
};
function setup(pr: Partial<PullRequest> | "absent" = {}, hostStatus = "connected") {
  const hostCall = vi.fn(async () => receipt);
  const callRpc = vi.fn(async ({ method }: { method: string }) =>
    method === "refresh" ? { ok: true } : { e: pr === "absent" ? { outcome: "absent" } : { outcome: "available", pullRequest: { ...basePr, ...pr } } },
  );
  const bb = {
    storage: { kv: { get: vi.fn(), set: vi.fn() } },
    realtime: { publish: vi.fn() },
    hosts: { experimental_client: () => ({ call: hostCall }) },
    sdk: {
      environments: { get: vi.fn(async () => ({ id: "e", path: "/work/tree", projectId: "p", hostId: "h", status: "ready", lifecycle: { phase: "active" } })) },
      hosts: { get: vi.fn(async () => ({ name: "Studio", status: hostStatus, lifecycle: { phase: "active" } })) },
      plugins: { callRpc },
    },
  };
  return { engine: createDelivery(bb as unknown as BbPluginApi), hostCall, callRpc };
}
const request = (over: Record<string, unknown> = {}) => ({
  environmentId: "e",
  intent: "explicit-user-action" as const,
  confirmRedacted: true as const,
  expectedUrl: basePr.url,
  expectedUpdatedAt: basePr.updatedAt,
  note: "Fix verified",
  branch: "delivery-proof",
  files: [{ name: "after.png", dataBase64: png.toString("base64") }],
  ...over,
}) as Parameters<ReturnType<typeof setup>["engine"]["attachProof"]>[0];

describe("delivery attachProof", () => {
  it("refreshes the PR, then asks the owner machine to upload to that PR with the working directory", async () => {
    const { engine, hostCall, callRpc } = setup();
    const result = await engine.attachProof(request());
    expect(result).toEqual(receipt);
    expect(callRpc.mock.calls.map(([i]) => i.method)).toEqual(["refresh", "pullRequests"]);
    expect(hostCall).toHaveBeenCalledTimes(1);
    const [method, payload, options] = hostCall.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>];
    expect(method).toBe("attachProof");
    expect(payload).toMatchObject({ cwd: "/work/tree", prUrl: basePr.url, note: "Fix verified", branch: "delivery-proof" });
    expect(options).toMatchObject({ hostId: "h" });
    expect(Number(options.timeoutMs)).toBeGreaterThanOrEqual(120_000);
  });

  it("allows a draft PR", async () => {
    const { engine, hostCall } = setup({ state: "draft" });
    await engine.attachProof(request());
    expect(hostCall).toHaveBeenCalled();
  });

  it.each([["merged"], ["closed"]])("refuses a %s PR", async (state) => {
    const { engine, hostCall } = setup({ state: state as PullRequest["state"] });
    await expect(engine.attachProof(request())).rejects.toThrow(/open|draft/i);
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("refuses when the PR changed after the panel was read", async () => {
    const { engine, hostCall } = setup();
    await expect(engine.attachProof(request({ expectedUpdatedAt: "old" }))).rejects.toThrow("changed");
    await expect(engine.attachProof(request({ expectedUrl: "https://github.com/acme/widgets/pull/8" }))).rejects.toThrow("changed");
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("refuses when the branch has no PR", async () => {
    const { engine, hostCall } = setup("absent");
    await expect(engine.attachProof(request())).rejects.toThrow(/no PR/i);
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("refuses when the owner machine is offline", async () => {
    const { engine, hostCall, callRpc } = setup({}, "disconnected");
    await expect(engine.attachProof(request())).rejects.toThrow("offline");
    expect(hostCall).not.toHaveBeenCalled();
    expect(callRpc).not.toHaveBeenCalled();
  });

  it("refuses without the explicit action and the redaction confirmation", async () => {
    const { engine, hostCall } = setup();
    await expect(engine.attachProof(request({ confirmRedacted: false }))).rejects.toThrow();
    await expect(engine.attachProof(request({ intent: "background" }))).rejects.toThrow();
    expect(hostCall).not.toHaveBeenCalled();
  });
});

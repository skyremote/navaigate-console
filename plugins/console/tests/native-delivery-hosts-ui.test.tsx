// @vitest-environment jsdom
import React from "react";
import { cleanup, configure, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";

const keyed = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...actual, experimental_useRpcKeyedQuery: () => ({ data: keyed.data, error: null, refetch: async () => undefined }), useRealtimeConnectionState: () => "connected" };
});

import { DeliveryPanel } from "../src/delivery";
import { hostBadge, mergeRequestFrom, reviewHeader } from "../src/delivery-model";

configure({ asyncUtilTimeout: 5000 });
afterEach(() => { cleanup(); keyed.data = {}; vi.clearAllMocks(); });

const env = (id: string, name: string) => ({ id, projectId: "p", hostId: "host_m5", name, path: `/work/${id}`, status: "ready" });
const gl = { host: "gitlab.com", hostKind: "gitlab" as const, label: "GitLab", reviewAdapter: true };
const bb = { host: "bitbucket.org", hostKind: "bitbucket" as const, label: "Bitbucket", reviewAdapter: false };
const gh = { host: "github.com", hostKind: "github" as const, label: "GitHub", reviewAdapter: true };
const pullRequest = { number: 12, title: "Fix the thing", state: "open", url: "https://github.com/a/b/pull/12", baseRefName: "main", headRefName: "fix", updatedAt: "2026-10-30T12:00:00Z", autoMerge: false, inMergeQueue: false, checks: { state: "passing", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 }, review: { state: "approved", reviewRequestCount: 0 }, mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, attention: "ready_to_merge" };
const mrReview = { provider: "gitlab", host: "gitlab.com", hostKind: "gitlab", url: "https://gitlab.com/g/r/-/merge_requests/7", revision: "abcdef1", text: JSON.stringify({ mergeRequest: { iid: 7, title: "Tidy the importer", state: "opened" }, notes: [] }), diff: "", truncated: false, readAt: 1, warnings: [] };

function mount(extra: Record<string, (input: unknown) => unknown> = {}) {
  keyed.data = { gh: { outcome: "available", pullRequest }, gl: { outcome: "absent" }, bb: { outcome: "absent" } };
  const hostCalls: unknown[] = [];
  const view = renderSlot({ component: () => <DeliveryPanel /> }, {}, {
    rpc: {
      delivery_queue: () => ({ readAt: 1, environments: [env("gh", "github-work"), env("gl", "gitlab-work"), env("bb", "bitbucket-work")], warnings: [] }),
      delivery_hosts: (input: unknown) => { hostCalls.push(input); return { gl, bb }; },
      delivery_review: () => mrReview,
      ...extra,
    } as never,
    sdk: { threads: { get: async () => ({ environmentId: null }) } } as never,
  });
  return { view, hostCalls };
}
const row = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

describe("naming the host of a workspace", () => {
  it("shows GitLab and Bitbucket on rows that have no GitHub pull request, and asks only about those", async () => {
    const { hostCalls } = mount();
    await waitFor(() => expect(row("gitlab-work").textContent).toContain("GitLab: read its merge request"));
    expect(row("bitbucket-work").textContent).toContain("Bitbucket: no review adapter yet");
    expect(row("Fix the thing").textContent).not.toMatch(/GitLab|Bitbucket/);
    expect((hostCalls[0] as { environmentIds: string[] }).environmentIds.sort()).toEqual(["bb", "gl"]);
  });

  it("reads the GitLab merge requests on request and puts them in the list", async () => {
    const reviews: unknown[] = [];
    mount({ delivery_review: (input) => { reviews.push(input); return mrReview; } });
    await waitFor(() => expect(row("gitlab-work").textContent).toContain("GitLab"));
    fireEvent.click(screen.getByRole("button", { name: "Read GitLab merge requests" }));
    await waitFor(() => expect(row("Tidy the importer").textContent).toContain("!7 Tidy the importer"));
    expect(reviews).toEqual([{ environmentId: "gl" }]);
    expect(row("Tidy the importer").textContent).not.toContain("read its merge request");
  });

  it("names the host in the review header and explains a host with no adapter", async () => {
    mount({ delivery_review: () => ({ ...mrReview, provider: "unknown", host: "bitbucket.org", hostKind: "bitbucket", url: null, revision: null, text: "Bitbucket (bitbucket.org) has no published review adapter.", warnings: ["Bitbucket review API parity requires a provider adapter; no review or permission state was inferred."] }) });
    await waitFor(() => expect(row("bitbucket-work").textContent).toContain("Bitbucket"));
    fireEvent.click(row("bitbucket-work"));
    fireEvent.click(await screen.findByRole("button", { name: "Read diff and review conversation" }));
    const header = await screen.findByText(/Bitbucket \(bitbucket.org\) · head unknown/);
    expect(header.textContent).not.toMatch(/^unknown/);
    expect(screen.getByText(/Bitbucket review API parity/)).toBeTruthy();
  });

  it("leaves a row alone when its host cannot be read", async () => {
    mount({ delivery_hosts: () => ({ gl: null, bb: null }) });
    await waitFor(() => expect(row("gitlab-work")).toBeTruthy());
    expect(row("gitlab-work").textContent).not.toContain("GitLab:");
    expect(screen.queryByRole("button", { name: "Read GitLab merge requests" })).toBeNull();
  });
});

describe("delivery host wording", () => {
  it("badges only the hosts the GitHub watcher does not cover", () => {
    expect(hostBadge(gh)).toBeNull();
    expect(hostBadge(null)).toBeNull();
    expect(hostBadge(gl)).toBe("GitLab: read its merge request");
    expect(hostBadge({ host: "dev.azure.com", hostKind: "azure", label: "Azure DevOps", reviewAdapter: false })).toBe("Azure DevOps: no review adapter yet");
    expect(hostBadge({ host: "git.sr.ht", hostKind: "other", label: "git.sr.ht", reviewAdapter: false })).toBe("git.sr.ht: no review adapter yet");
  });
  it("reads the merge request from a review, falling back to the URL when the text was cut short", () => {
    expect(mergeRequestFrom(mrReview)).toEqual({ number: 7, title: "Tidy the importer", state: "opened", url: mrReview.url });
    expect(mergeRequestFrom({ ...mrReview, text: '{"mergeRequest": {"iid": 7, "ti' })).toEqual({ number: 7, title: null, state: null, url: mrReview.url });
    expect(mergeRequestFrom({ provider: "github", url: "https://github.com/a/b/pull/1", text: "{}" })).toBeNull();
  });
  it("heads a review with the host by name", () => {
    expect(reviewHeader({ provider: "gitlab", host: "gitlab.example.com", hostKind: "gitlab", revision: "abc" })).toBe("GitLab (gitlab.example.com) · head abc");
    expect(reviewHeader({ provider: "unknown", host: "git.sr.ht", hostKind: "other", revision: null })).toBe("git.sr.ht · head unknown");
    expect(reviewHeader({ provider: "github", revision: "abc" })).toBe("github · head abc");
  });
});

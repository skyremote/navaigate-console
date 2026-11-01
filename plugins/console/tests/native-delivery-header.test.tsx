// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DeliveryHeaderButton } from "../src/delivery-header";

afterEach(cleanup);
const pr = (over: Record<string, unknown> = {}) => ({
  outcome: "available",
  pullRequest: {
    number: 41, title: "Stash", state: "open", url: "https://github.com/a/b/pull/41", baseRefName: "main", headRefName: "stash",
    updatedAt: "2026-11-01T08:00:00Z", autoMerge: false, inMergeQueue: false,
    checks: { state: "passing", totalCount: 3, passedCount: 3, failedCount: 0, pendingCount: 0 },
    review: { state: "approved", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" },
    attention: "none", ...over,
  },
});

describe("Delivery header button", () => {
  it("opens the Delivery tab for the thread", () => {
    const view = renderSlot({ component: () => <DeliveryHeaderButton threadId="t1" /> }, {}, {
      sdk: { threads: { get: async () => ({ id: "t1", environmentId: "env1" }) } },
    } as never);
    const button = view.getByRole("button", { name: /Delivery/ });
    expect(button.getAttribute("title")).toContain("⌘⇧Y");
    fireEvent.click(button);
    expect(view.experimental_panelCalls).toHaveLength(1);
    expect(JSON.stringify(view.experimental_panelCalls[0])).toContain('"id":"delivery"');
  });
  it("shows this thread's PR readiness on the button", async () => {
    const view = renderSlot({ component: () => <DeliveryHeaderButton threadId="t1" /> }, {}, {
      sdk: { threads: { get: async () => ({ id: "t1", environmentId: "env1" }) } },
      rpc: { pullRequests: async () => ({ env1: pr() }) },
    } as never);
    await waitFor(() => expect(view.getByRole("button", { name: /Delivery/ }).textContent).toContain("Likely ready"));
  });
  it("shows Draft for a draft PR", async () => {
    const view = renderSlot({ component: () => <DeliveryHeaderButton threadId="t1" /> }, {}, {
      sdk: { threads: { get: async () => ({ id: "t1", environmentId: "env1" }) } },
      rpc: { pullRequests: async () => ({ env1: pr({ state: "draft" }) }) },
    } as never);
    await waitFor(() => expect(view.getByRole("button", { name: /Delivery/ }).textContent).toContain("Draft"));
  });
});

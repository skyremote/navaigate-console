// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("../src/delivery-shared", async (original) => ({
  ...(await original<typeof import("../src/delivery-shared")>()),
  TaskDraft: ({ purpose }: { purpose: string }) => <div data-testid="task-draft">{purpose}</div>,
}));
vi.mock("@get-bb/plugin-sdk/app", async (original) => ({
  ...(await original<typeof import("@get-bb/plugin-sdk/app")>()),
  experimental_ProviderModelPicker: () => <div data-testid="model-picker" />,
}));
import { DeliveryPanel } from "../src/delivery";
import { prAvailable, worktreeView } from "./fixtures/delivery-worktrees";

afterEach(cleanup);
const env = (id: string, name: string) => ({ id, projectId: "p1", hostId: "m5", name, path: `/w/${id}`, status: "ready" });
const queue = { readAt: 1, warnings: [], environments: [env("e-draft", "draft work"), env("e-ready", "ready work"), env("e-conflict", "conflict work"), env("e-pending", "pending work")] };
const results = {
  "e-draft": prAvailable("draft", { number: 3, title: "Draft thing" }),
  "e-ready": prAvailable("open", { number: 1, title: "Ready thing" }),
  "e-conflict": prAvailable("open", { number: 4, title: "Conflict thing", mergeability: { state: "conflicts", mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } }),
  "e-pending": prAvailable("open", { number: 2, title: "Pending thing", checks: { state: "pending", totalCount: 2, passedCount: 1, failedCount: 0, pendingCount: 1 } }),
};
const settings = { revision: 0, entries: [], resolved: [], appliedTo: "delivery-tasks", remoteApplied: false };
const mount = (rpc: Record<string, (input: never) => unknown> = {}, threadId: string | undefined = "t1") =>
  renderSlot({ component: () => <DeliveryPanel threadId={threadId} /> }, {}, {
    sdk: { threads: { get: async () => ({ id: "t1", environmentId: "e-ready" }) } },
    rpc: {
      delivery_queue: () => queue, pullRequests: () => results, delivery_settings: () => settings,
      delivery_worktrees: () => ({ ...worktreeView, environmentId: "e-ready" }),
      delivery_stale_worktrees: () => ({ readAt: 1, staleAfterDays: 7, total: 0, guarded: true, rows: [], warnings: [] }),
      delivery_fleet_doctor: () => { throw new Error("not under test"); },
      ...rpc,
    },
    context: { projectId: "p1", threadId },
  } as never);

describe("Delivery panel sections", () => {
  it("offers Pull requests, Worktrees, Research, Diagnosis and Models as tabs", async () => {
    const view = mount();
    const tabs = view.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Pull requests", "Worktrees", "Research", "Diagnosis", "Models"]);
    expect(view.getByRole("tab", { name: "Pull requests" }).getAttribute("aria-selected")).toBe("true");
  });

  it("orders the pull requests ready, checks pending, draft, conflicts under readiness headings with counts", async () => {
    const view = mount();
    await waitFor(() => view.getByText("#1 Ready thing"));
    const headings = view.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Likely ready (1)", "Checks pending (1)", "Draft (1)", "Conflicts (1)"]);
    const titles = view.getAllByRole("listitem").map((li) => li.textContent!);
    expect(titles.map((t) => /#(\d)/.exec(t)![1])).toEqual(["1", "2", "3", "4"]);
    expect(view.getByLabelText("Readiness summary").textContent).toContain("Likely ready 1");
    expect(view.getByText(/Workspaces whose PR cannot be read show as Unverified/)).toBeTruthy();
  });

  it("shows this thread's worktrees and the stale worktree table under the Worktrees tab", async () => {
    const view = mount();
    fireEvent.click(view.getByRole("tab", { name: "Worktrees" }));
    await waitFor(() => view.getByLabelText("Shared base"));
    expect(view.getByRole("heading", { name: "Stale worktrees" })).toBeTruthy();
    expect(view.getByRole("listitem", { name: "task/receipt-ui" })).toBeTruthy();
  });

  it("puts the fleet doctor next to the private diagnosis, and the research collectors on their tab", async () => {
    const view = mount();
    fireEvent.click(view.getByRole("tab", { name: "Diagnosis" }));
    expect(view.getByRole("button", { name: "Run fleet doctor" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Collect context and version proof" })).toBeTruthy();
    fireEvent.click(view.getByRole("tab", { name: "Research" }));
    expect(within(view.getByRole("group", { name: "Collectors" })).getAllByRole("checkbox").length).toBeGreaterThan(3);
  });

  it("opens on the section the caller asks for", async () => {
    const view = renderSlot({ component: () => <DeliveryPanel threadId="t1" section="diagnosis" /> }, {}, { sdk: { threads: { get: async () => ({ id: "t1", environmentId: "e-ready" }) } }, rpc: { delivery_queue: () => queue, pullRequests: () => results, delivery_settings: () => settings }, context: { projectId: "p1", threadId: "t1" } } as never);
    expect(view.getByRole("tab", { name: "Diagnosis" }).getAttribute("aria-selected")).toBe("true");
  });
});

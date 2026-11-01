// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { WorktreesPanel } from "../src/delivery-worktrees";
import { rpcFlight } from "../src/rpc-flight";
import { prAvailable, worktreeView } from "./fixtures/delivery-worktrees";

afterEach(cleanup);
const mount = (rpc: Record<string, (input: never) => unknown>, results = {}) =>
  renderSlot(
    { component: () => <WorktreesPanel environmentId="e-main" threadId="t1" results={results as never} /> },
    {},
    { rpc: { delivery_worktrees: () => worktreeView, ...rpc }, context: { projectId: "p1", threadId: "t1" } } as never,
  );
const row = (view: ReturnType<typeof mount>, branch: string) => view.getByRole("listitem", { name: branch });

describe("Worktrees block", () => {
  it("shows the shared base commit and every worktree's branch, machine and change size", async () => {
    const view = mount({});
    await waitFor(() => row(view, "task/receipt-ui"));
    expect(view.getByLabelText("Shared base").textContent).toContain("main");
    expect(view.getByLabelText("Shared base").textContent).toContain("f8ee251");
    const receipt = row(view, "task/receipt-ui").textContent!;
    expect(receipt).toContain("Studio");
    expect(receipt).toContain("+118");
    expect(receipt).toContain("2 commits ahead");
    expect(row(view, "task/rail-sort").textContent).toContain("3 behind");
  });

  it("lays the changed files side by side and calls out the file two worktrees both edit", async () => {
    const view = mount({});
    await waitFor(() => view.getByLabelText("Files by worktree"));
    const table = view.getByLabelText("Files by worktree");
    expect(table.textContent).toContain("src/native-session-rail.ts");
    expect(view.getByLabelText("Overlapping edits").textContent).toContain("task/receipt-ui, task/rail-sort");
  });

  it("states each row's merge state and only offers merge where it is safe", async () => {
    const view = mount({});
    await waitFor(() => row(view, "task/receipt-ui"));
    expect(row(view, "task/receipt-ui").textContent).toContain("Ready to merge");
    expect(row(view, "task/rail-sort").textContent).toContain("Conflicts with main: src/native-session-rail.ts");
    expect(row(view, "task/scratch").textContent).toContain("Nothing committed to merge");
    expect(row(view, "task/scratch").textContent).toContain("Uncommitted changes stay in that worktree");
    expect(within(row(view, "task/rail-sort")).queryByRole("button", { name: /Merge into main/ })).toBeNull();
    expect(within(row(view, "task/rail-sort")).getByRole("button", { name: /Draft conflict resolution/ })).toBeTruthy();
  });

  it("asks for confirmation naming both commits, then merges and reports the result", async () => {
    const merge = vi.fn(async () => ({ outcome: { merged: true, sha: "e".repeat(40), previous: "f".repeat(40), conflicts: [] }, message: "Merged task/receipt-ui into the base workspace as eeeeeeeee." }));
    const view = mount({ delivery_worktree_merge: merge });
    await waitFor(() => row(view, "task/receipt-ui"));
    fireEvent.click(within(row(view, "task/receipt-ui")).getByRole("button", { name: /Merge into main/ }));
    const confirm = view.getByRole("group", { name: "Confirm merge back" });
    expect(confirm.textContent).toContain("task/receipt-ui");
    expect(confirm.textContent).toContain("from Studio");
    expect(merge).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm merge" }));
    await waitFor(() => expect(merge).toHaveBeenCalledTimes(1));
    expect(merge.mock.calls[0][0]).toMatchObject({
      environmentId: "e-main", sourceEnvironmentId: "e-m1", branch: "task/receipt-ui",
      expectedHead: "0c095a2".padEnd(40, "1"), expectedBaseHead: worktreeView.base.sha, expectedBaseRef: "main", intent: "explicit-user-action",
    });
    await waitFor(() => view.getByText(/Merged task\/receipt-ui into the base workspace/));
  });

  it("links the worktree to its pull request and its readiness", async () => {
    const view = mount({}, { "e-m1": prAvailable("open") });
    await waitFor(() => row(view, "task/receipt-ui"));
    const link = within(row(view, "task/receipt-ui")).getByRole("link", { name: /#58/ });
    expect(link.getAttribute("href")).toBe("https://github.com/example/x/pull/58");
    expect(row(view, "task/receipt-ui").textContent).toContain("Likely ready");
  });

  it("names a machine that could not be read instead of hiding it", async () => {
    const view = mount({});
    await waitFor(() => view.getByText(/Work could not be read: no route/));
  });

  it("draws the overlap call-outs from host tokens, with no amber or other warm colour", async () => {
    const view = mount({});
    await waitFor(() => view.getByLabelText("Overlapping edits"));
    expect(view.container.innerHTML).not.toMatch(/amber|yellow|orange|gold|rose|red-\d/);
    expect(view.getByLabelText("Overlapping edits").className).toContain("border-foreground");
  });

  it("offers a conflict draft only where this chat can work, and says where to go for a row on another machine", async () => {
    const other = { ...worktreeView, rows: worktreeView.rows.map((r) => (r.branch === "task/rail-sort" ? { ...r, sameHost: false, hostName: "Studio" } : r)) };
    const view = mount({ delivery_worktrees: () => other });
    await waitFor(() => row(view, "task/rail-sort"));
    const rail = row(view, "task/rail-sort");
    expect(within(rail).queryByRole("button", { name: /Draft conflict resolution/ })).toBeNull();
    expect(rail.textContent).toContain("Resolve this in a chat that runs in that worktree on Studio");
  });

  it("reads once for repeated opens within the cache window and again only on Refresh", async () => {
    const read = vi.fn(() => worktreeView);
    const first = mount({ delivery_worktrees: read });
    await waitFor(() => row(first, "task/receipt-ui"));
    first.unmount();
    const second = mount({ delivery_worktrees: read });
    await waitFor(() => row(second, "task/receipt-ui"));
    expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(second.getByRole("button", { name: "Refresh worktrees" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("does not put a slow read into back-off", async () => {
    const view = mount({});
    await waitFor(() => row(view, "task/receipt-ui"));
    expect(rpcFlight().blockedUntil("delivery_worktrees:e-main")).toBe(0);
  });
});

// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { StaleWorktreesPanel } from "../src/delivery-stale";

afterEach(cleanup);
const plan = (id: string, eligible: boolean, blockers: string[] = []) => ({ planId: `plan-${id}`, fingerprint: `fp-${id}`, eligible, blockers });
const rowOf = (id: string, idleDays: number, p = plan(id, true)) => ({
  environmentId: id, name: `task ${id}`, branch: `task/${id}`, hostId: "m5", hostName: "laptop", path: `/w/${id}`, lastActivityAt: 1, idleDays, plan: p,
});
const stale = (guarded: boolean | null = true) => ({
  readAt: 1, staleAfterDays: 7, total: 4, guarded, warnings: [],
  rows: [
    rowOf("a", 30), rowOf("b", 21), rowOf("c", 9),
    rowOf("d", 40, plan("d", false, ["Tracked changes or untracked files are present."])),
  ],
});
const mount = (rpc: Record<string, (input: never) => unknown>) =>
  renderSlot({ component: () => <StaleWorktreesPanel /> }, {}, { rpc: { delivery_stale_worktrees: () => stale(), ...rpc } } as never);

describe("Stale worktrees table", () => {
  it("lists the stale worktrees, three ready and the one with local changes skipped with its reason", async () => {
    const view = mount({});
    await waitFor(() => view.getByRole("table", { name: "Stale worktrees" }));
    const table = view.getByRole("table", { name: "Stale worktrees" });
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(table.textContent).toContain("30 days");
    const skipped = within(table).getByRole("row", { name: /task d/ });
    expect(skipped.textContent).toContain("Skipped: Tracked changes or untracked files are present.");
    expect((within(skipped).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(view.getByText(/3 of 4 can be cleaned up/)).toBeTruthy();
  });

  it("re-reads with the chosen idle threshold", async () => {
    const read = vi.fn(() => stale());
    const view = mount({ delivery_stale_worktrees: read });
    await waitFor(() => view.getByRole("table", { name: "Stale worktrees" }));
    fireEvent.change(view.getByLabelText("Idle for at least"), { target: { value: "30" } });
    await waitFor(() => expect(read).toHaveBeenLastCalledWith({ days: 30 }));
  });

  it("asks for confirmation, then cleans up only the ticked eligible rows and shows each result", async () => {
    const cleanup = vi.fn(async () => ({
      results: [{ environmentId: "a", outcome: "requested", message: "Protected cleanup requested." }, { environmentId: "b", outcome: "skipped", message: "Blocked: A process holds this workspace." }],
      message: "Protected cleanup requested for 1 of 2. A request is not proof the folder is gone.",
    }));
    const view = mount({ delivery_stale_cleanup: cleanup });
    await waitFor(() => view.getByRole("table", { name: "Stale worktrees" }));
    fireEvent.click(within(view.getByRole("row", { name: /task a/ })).getByRole("checkbox"));
    fireEvent.click(within(view.getByRole("row", { name: /task b/ })).getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: /Clean up 2 selected/ }));
    const confirm = view.getByRole("group", { name: "Confirm protected cleanup" });
    expect(confirm.textContent).toContain("task/a");
    expect(cleanup).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm cleanup" }));
    await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(cleanup.mock.calls[0][0]).toEqual({
      items: [{ environmentId: "a", fingerprint: "fp-a" }, { environmentId: "b", fingerprint: "fp-b" }],
      intent: "explicit-user-action",
    });
    await waitFor(() => view.getByText(/not proof the folder is gone/));
    expect(view.getByRole("row", { name: /task b/ }).textContent).toContain("Blocked: A process holds this workspace.");
  });

  it("says plainly when this BB core cannot do protected cleanup and offers no removal", async () => {
    const view = mount({ delivery_stale_worktrees: () => ({ ...stale(false), rows: stale().rows.map((r) => ({ ...r, plan: plan(r.environmentId, false, ["The Worktree provider does not advertise protected cleanup version 1."]) })) }) });
    await waitFor(() => view.getByRole("table", { name: "Stale worktrees" }));
    expect(view.getByRole("status").textContent).toContain("does not advertise protected cleanup");
    expect(view.queryByRole("button", { name: /Clean up/ })).toBeNull();
  });

  it("shows an empty state when nothing is idle", async () => {
    const view = mount({ delivery_stale_worktrees: () => ({ ...stale(), rows: [], total: 0 }) });
    await waitFor(() => view.getByText(/No managed worktree has been idle/));
  });

  it("reads once for repeated opens within the cache window and again only on Refresh", async () => {
    const read = vi.fn(() => stale());
    const first = mount({ delivery_stale_worktrees: read });
    await waitFor(() => first.getByRole("table", { name: "Stale worktrees" }));
    first.unmount();
    const second = mount({ delivery_stale_worktrees: read });
    await waitFor(() => second.getByRole("table", { name: "Stale worktrees" }));
    expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(second.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("keeps a separate cached answer for each idle threshold", async () => {
    const read = vi.fn(() => stale());
    const view = mount({ delivery_stale_worktrees: read });
    await waitFor(() => view.getByRole("table", { name: "Stale worktrees" }));
    fireEvent.change(view.getByLabelText("Idle for at least"), { target: { value: "30" } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    fireEvent.change(view.getByLabelText("Idle for at least"), { target: { value: "7" } });
    await waitFor(() => view.getByRole("table", { name: "Stale worktrees" }));
    expect(read).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { AttentionPage, AttentionSwipeRow, RetryAttention, attentionVisible } from "../src/attention";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);
const row = {
  threadId: "t",
  title: "Review client output",
  hostId: "m1",
  environmentId: null,
  status: "reviewable" as const,
  question: null,
  updatedAt: 10,
  pinned: false,
  wakeAt: null,
};
describe("native attention controls", () => {
  it("keeps pins and decisions visible when folding work", () => {
    expect(attentionVisible({ id: "t", isPinned: false }, "running", [], true)).toBe(false);
    expect(attentionVisible({ id: "t", isPinned: true }, "running", [], true)).toBe(true);
    expect(attentionVisible({ id: "t", isPinned: false }, "needs", [], true)).toBe(true);
  });
  it("provides keyboard-accessible scope, bulk controls and native navigation", async () => {
    const changes: unknown[] = [];
    const view = renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: () => ({ rows: [row], truncated: false }),
          attention_apply: (input) => {
            changes.push(input);
            return { receiptId: "receipt", results: [{ threadId: "t", ok: true, error: null }] };
          },
        },
      },
    );
    await screen.findByRole("button", { name: row.title });
    fireEvent.click(screen.getByRole("button", { name: row.title }));
    expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "t" }]);
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${row.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Settle selected" }));
    await waitFor(() => expect(changes).toEqual([{ threadIds: ["t"], action: "settle" }]));
    expect(screen.getByLabelText("Snooze until")).toBeTruthy();
  });
  it("previews and routes selected remote work to its exact owner and opens existing native mirrors", async () => {
    const changes: unknown[] = [];
    const remote = {
      ...row,
      title: "Remote output",
      remote: true,
      ownerServerId: "remote-owner",
      ownerHostId: "remote-host",
      machine: "studio" as const,
    };
    const view = renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: () => ({ rows: [row, remote], truncated: false, notices: [] }),
          attention_fleet_apply: (input) => {
            changes.push(input);
            return {
              receiptId: "source-receipt",
              results: [{ threadId: "t", ok: true, error: null }],
            };
          },
          fleet_mirror_open: () => ({ localThreadId: "native-mirror" }),
        },
      },
    );
    await screen.findByRole("button", { name: "Remote output" });
    fireEvent.click(screen.getByRole("button", { name: "Remote output" }));
    await waitFor(() =>
      expect(view.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "native-mirror" },
      ]),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Remote output" }));
    fireEvent.click(screen.getByRole("button", { name: "Settle selected" }));
    await waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({
      action: "settle",
      targets: [
        { ownerServerId: "remote-owner", hostId: "remote-host", machine: "studio", threadId: "t" },
      ],
    });
  });
  it("saves automatic settlement for a remote row against that row's owner and machine", async () => {
    const saves: unknown[] = [];
    const remote = {
      ...row,
      title: "Remote output",
      remote: true,
      ownerServerId: "remote-owner",
      ownerHostId: "remote-host",
      machine: "studio" as const,
      policy: {
        autoMerge: false,
        requiredPrUrls: [],
        requiredPrEnvironments: {},
        acceptancePending: true,
        inactiveAfterMs: null,
      },
    };
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: () => ({ rows: [row, remote], truncated: false, notices: [] }),
          attention_fleet_policy: (input) => {
            saves.push(input);
            return { receiptId: "r", results: [{ threadId: "t", ok: true, error: null }] };
          },
        },
      },
    );
    await screen.findByRole("button", { name: "Remote output" });
    const buttons = screen.getAllByRole("button", { name: "Automatic settlement" });
    fireEvent.click(buttons[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Save choices" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      target: { ownerServerId: "remote-owner", hostId: "remote-host", machine: "studio", threadId: "t" },
    });
  });
  it("groups the inbox into failed, question, reviewable and working sections with counts", async () => {
    const make = (threadId: string, title: string, status: string, machine?: "studio" | "laptop") => ({
      ...row,
      threadId,
      title,
      status: status as typeof row.status,
      ...(machine === "studio"
        ? {
            remote: true,
            ownerServerId: "m1-owner",
            ownerHostId: "m1-host",
            machine,
          }
        : {}),
    });
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: () => ({
            rows: [
              make("r1", "Review one", "reviewable"),
              make("w1", "Busy one", "running"),
              make("q1", "Question Laptop", "needs-you"),
              make("f1", "Failed Laptop", "failed"),
              make("q2", "Question Studio", "needs-you", "studio"),
              make("a1", "Accepted one", "accepted"),
            ],
            truncated: false,
            notices: [],
          }),
        },
      },
    );
    await screen.findByRole("button", { name: "Failed Laptop" });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Failed (1)", "Questions (2)", "Ready to review (1)", "Working (1)"]);
    const failed = screen.getByRole("list", { name: "Failed (1)" });
    expect(within(failed).getByRole("button", { name: "Failed Laptop" })).toBeTruthy();
    const questions = screen.getByRole("list", { name: "Questions (2)" });
    expect(within(questions).getByRole("button", { name: "Question Laptop" })).toBeTruthy();
    expect(within(questions).getByRole("button", { name: "Question Studio" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accepted one" })).toBeNull();
  });
  it("keeps non-inbox views as one flat list", async () => {
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: () => ({
            rows: [
              {
                ...row,
                threadId: "f1",
                title: "Failed one",
                status: "failed" as const,
              },
              {
                ...row,
                threadId: "q1",
                title: "Question one",
                status: "needs-you" as const,
              },
            ],
            truncated: false,
            notices: [],
          }),
        },
      },
    );
    await screen.findByRole("button", { name: "Failed one" });
    fireEvent.change(screen.getByLabelText("Attention view"), {
      target: { value: "all" },
    });
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Question one" })).toBeTruthy();
  });
  it("supports mobile swipe on plugin rows without hijacking buttons or vertical scrolling", () => {
    const settle = vi.fn(),
      snooze = vi.fn();
    const view = renderSlot(
      {
        component: () => (
          <ul>
            <AttentionSwipeRow row={row} onSettle={settle} onSnooze={snooze}>
              <span>Swipe area</span>
              <button>Explicit action</button>
            </AttentionSwipeRow>
          </ul>
        ),
      },
      {},
      {},
    );
    const area = screen.getByText("Swipe area");
    fireEvent.touchStart(area, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(area, { changedTouches: [{ clientX: 220, clientY: 15 }] });
    expect(settle).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(area, { touches: [{ clientX: 200, clientY: 10 }] });
    fireEvent.touchEnd(area, { changedTouches: [{ clientX: 30, clientY: 15 }] });
    expect(snooze).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(area, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(area, { changedTouches: [{ clientX: 220, clientY: 100 }] });
    expect(settle).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(area, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchStart(area, {
      touches: [
        { clientX: 100, clientY: 10 },
        { clientX: 110, clientY: 10 },
      ],
    });
    fireEvent.touchEnd(area, { changedTouches: [{ clientX: 220, clientY: 15 }] });
    expect(settle).toHaveBeenCalledTimes(1);
    const button = screen.getByRole("button");
    fireEvent.touchStart(button, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchEnd(button, { changedTouches: [{ clientX: 220, clientY: 15 }] });
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe("Quota retry tab", () => {
  it("explains an empty queue and shows the last retry decision", async () => {
    renderSlot(
      { component: () => <RetryAttention threadId="t" /> },
      {},
      {
        rpc: {
          attention_retries: () => ({ retries: [] }),
          attention_retry_decision: () => ({ decision: { kind: "decline", reason: "not-retryable", observedAt: 1_800_000_000_000, sendAt: null } }),
        },
      },
    );
    expect(await screen.findByText("No retry is waiting for this chat.")).toBeTruthy();
    expect(await screen.findByText(/no retry, because the error was not a usage limit or a temporary provider error/)).toBeTruthy();
  });
  it("lists a pending retry with its cancel button", async () => {
    renderSlot(
      { component: () => <RetryAttention threadId="t2" /> },
      {},
      { rpc: { attention_retries: () => ({ retries: [{ id: "r", threadId: "t2", sendAt: 1_800_000_000_000 }] }), attention_retry_decision: () => ({ decision: null }) } },
    );
    expect(await screen.findByText("Cancel retry")).toBeTruthy();
    expect(screen.queryByText("No retry is waiting for this chat.")).toBeNull();
  });
  it("says the read failed instead of claiming nothing is waiting", async () => {
    renderSlot(
      { component: () => <RetryAttention threadId="t3" /> },
      {},
      { rpc: { attention_retries: () => { throw new Error("down"); }, attention_retry_decision: () => ({ decision: null }) } },
    );
    expect(await screen.findByText(/Could not read the retries for this chat/)).toBeTruthy();
    expect(screen.queryByText("No retry is waiting for this chat.")).toBeNull();
  });
});

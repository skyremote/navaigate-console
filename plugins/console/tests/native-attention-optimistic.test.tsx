// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { AttentionPage } from "../src/attention";
vi.mock("sonner", () => ({
  toast: { success: vi.fn(() => "toast-id"), error: vi.fn(), dismiss: vi.fn() },
}));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
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
const remote = {
  ...row,
  title: "Remote output",
  remote: true,
  ownerServerId: "remote-owner",
  ownerHostId: "remote-host",
  machine: "studio" as const,
};
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const undoClick = () => {
  const calls = vi.mocked(toast.success).mock.calls as unknown as [
    string,
    { action?: { label: string; onClick(): void } }?,
  ][];
  const call = calls.find(([, o]) => o?.action?.label === "Undo");
  return call ? { message: call[0], click: call[1]!.action!.onClick } : null;
};
const inbox = (rows: unknown[]) => () => ({
  rows,
  truncated: false,
  notices: [],
});

describe("optimistic settle with immediate Undo", () => {
  it("removes the row and shows the Undo toast before the server answers", async () => {
    const apply = deferred<{
      receiptId: string;
      results: { threadId: string; ok: boolean; error: null }[];
    }>();
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: inbox([row]),
          attention_apply: () => apply.promise,
        },
      },
    );
    await screen.findByRole("button", { name: row.title });
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    await waitFor(() => expect(undoClick()).not.toBeNull());
    expect(undoClick()!.message).toBe("Settled");
    expect(screen.queryByRole("button", { name: row.title })).toBeNull();
    await act(async () =>
      apply.resolve({
        receiptId: "r1",
        results: [{ threadId: "t", ok: true, error: null }],
      }),
    );
  });

  it("runs an Undo clicked before the server answers once the receipt arrives", async () => {
    const apply = deferred<{
      receiptId: string;
      results: { threadId: string; ok: boolean; error: null }[];
    }>();
    const undone: unknown[] = [];
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: inbox([row]),
          attention_apply: () => apply.promise,
          attention_undo: (input) => {
            undone.push(input);
            return {
              receiptId: "r1",
              results: [{ threadId: "t", ok: true, error: null }],
            };
          },
        },
      },
    );
    await screen.findByRole("button", { name: row.title });
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    await waitFor(() => expect(undoClick()).not.toBeNull());
    await act(async () => undoClick()!.click());
    await screen.findByRole("button", { name: row.title });
    expect(undone).toEqual([]);
    await act(async () =>
      apply.resolve({
        receiptId: "r1",
        results: [{ threadId: "t", ok: true, error: null }],
      }),
    );
    await waitFor(() => expect(undone).toEqual([{ receiptId: "r1" }]));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("ignores a second Settle for the same thread while the first is in flight", async () => {
    const apply = deferred<{
      receiptId: string;
      results: { threadId: string; ok: boolean; error: null }[];
    }>();
    const calls: unknown[] = [];
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: inbox([row]),
          attention_apply: (input) => {
            calls.push(input);
            return apply.promise;
          },
        },
      },
    );
    await screen.findByRole("button", { name: row.title });
    const settle = screen.getByRole("button", { name: "Settle" });
    fireEvent.click(settle);
    fireEvent.click(settle);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () =>
      apply.resolve({
        receiptId: "r1",
        results: [{ threadId: "t", ok: true, error: null }],
      }),
    );
    expect(calls).toHaveLength(1);
    expect(
      vi.mocked(toast.success).mock.calls.filter(([, o]) => (o as { action?: unknown })?.action),
    ).toHaveLength(1);
  });

  it("restores the row and dismisses the toast when the server refuses the change", async () => {
    const apply = deferred<{
      receiptId: string;
      results: { threadId: string; ok: boolean; error: string }[];
    }>();
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: inbox([row]),
          attention_apply: () => apply.promise,
        },
      },
    );
    await screen.findByRole("button", { name: row.title });
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: row.title })).toBeNull());
    await act(async () =>
      apply.resolve({
        receiptId: "r1",
        results: [{ threadId: "t", ok: false, error: "gone" }],
      }),
    );
    await screen.findByRole("button", { name: row.title });
    expect(toast.dismiss).toHaveBeenCalledWith("toast-id");
    expect(toast.error).toHaveBeenCalledWith("1 of 1 changes failed", expect.anything());
  });

  it("restores the row and reports the error when the request rejects", async () => {
    const apply = deferred<never>();
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: inbox([row]),
          attention_apply: () => apply.promise,
        },
      },
    );
    await screen.findByRole("button", { name: row.title });
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: row.title })).toBeNull());
    await act(async () => apply.reject(new Error("timed out")));
    await screen.findByRole("button", { name: row.title });
    expect(toast.error).toHaveBeenCalledWith("timed out");
  });

  it("settles a remote owner row optimistically and defers its Undo to the owner receipt", async () => {
    const apply = deferred<{
      receiptId: string;
      results: { threadId: string; ok: boolean; error: null }[];
    }>();
    const undone: { receiptId: string; requestId: string }[] = [];
    renderSlot(
      { component: AttentionPage },
      {},
      {
        rpc: {
          attention_state: () => ({ records: [], foldWorking: false }),
          attention_fleet_inbox: inbox([remote]),
          attention_fleet_apply: () => apply.promise,
          attention_fleet_undo: (input) => {
            undone.push(input as { receiptId: string; requestId: string });
            return {
              receiptId: "x",
              results: [{ threadId: "t", ok: true, error: null }],
            };
          },
        },
      },
    );
    await screen.findByRole("button", { name: "Remote output" });
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    await waitFor(() => expect(undoClick()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Remote output" })).toBeNull();
    await act(async () => undoClick()!.click());
    await screen.findByRole("button", { name: "Remote output" });
    expect(undone).toEqual([]);
    await act(async () =>
      apply.resolve({
        receiptId: "source-receipt",
        results: [{ threadId: "t", ok: true, error: null }],
      }),
    );
    await waitFor(() => expect(undone).toHaveLength(1));
    expect(undone[0]!.receiptId).toBe("source-receipt");
  });

  it("scrolls: the Work needs you page sits in its own scrolling container", async () => {
    const { container } = renderSlot(
      { component: AttentionPage },
      {},
      { rpc: { attention_state: () => ({ records: [], foldWorking: false }), attention_fleet_inbox: inbox([row]) } },
    );
    await screen.findByRole("button", { name: row.title });
    const scroll = container.querySelector('[data-nav-part="work-needs-you-scroll"]');
    expect(scroll?.className).toContain("overflow-y-auto");
    expect(scroll?.className).toContain("h-full");
    expect(scroll?.querySelector('[data-nav-part="work-needs-you-page"]')).not.toBeNull();
  });
});

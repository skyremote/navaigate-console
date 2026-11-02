// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { AttentionPage, UNDO_TOAST_MS } from "../src/attention";
import { StashPage, groupByAge, stashIntro, untouchedLabel } from "../src/stash";
import { CoreEntries } from "../src/delivery";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(() => "toast-id"), error: vi.fn(), dismiss: vi.fn() },
}));
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base = { hostId: "m5", environmentId: null, question: null, pinned: false, wakeAt: null };
const stashed = (id: string, over: Record<string, unknown> = {}) => ({ ...base, threadId: id, title: `Chat ${id}`, status: "stashed", updatedAt: NOW - 9 * DAY, ...over });
const reviewable = { ...base, threadId: "rv", title: "Review me", status: "reviewable", updatedAt: NOW - 3_600_000 };
const inbox = (rows: unknown[]) => () => ({ rows, truncated: false, notices: [] });

describe("the Stash page", () => {
  const state = (stashAfterDays?: number) => () => ({ records: [], foldWorking: false, ...(stashAfterDays === undefined ? {} : { stashAfterDays }) });

  it("lists only stashed chats, each with a quiet line saying how long it has been untouched", async () => {
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox([stashed("a"), reviewable, stashed("b", { updatedAt: NOW - 8 * DAY, remote: true, machine: "studio", ownerServerId: "o", ownerHostId: "h" })]) } as never });
    await screen.findByText("Chat a");
    expect(screen.getByText("Chat b")).toBeTruthy();
    expect(screen.queryByText("Review me")).toBeNull();
    expect(screen.getByText("Untouched for 9 days")).toBeTruthy();
    expect(screen.getByText("Untouched for 8 days · Studio")).toBeTruthy();
    expect(screen.queryByText(/Idle \d/)).toBeNull();
  });

  it("explains itself with the number of days from the setting", async () => {
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(14), attention_fleet_inbox: inbox([stashed("a")]) } as never });
    await screen.findByText("Chat a");
    expect(screen.getByText(stashIntro(14))).toBeTruthy();
    expect(stashIntro(7)).toBe("Chats you have not touched for 7 days move here, to keep your sidebar clear. Chats in a folder stay in their folder. They are not archived. Open one and carry on, and it moves back to your list as soon as you send a message.");
    expect(stashIntro(1)).toContain("for 1 day move");
  });

  it("says the Stash is switched off when the setting is 0", async () => {
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(0), attention_fleet_inbox: inbox([stashed("a")]) } as never });
    expect(await screen.findByText(/switched off/)).toBeTruthy();
    expect(screen.queryByText(/not touched for 0 days/)).toBeNull();
  });

  it("falls back to the default of 7 days from a server that does not send the setting", async () => {
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox([stashed("a")]) } as never });
    expect(await screen.findByText(/not touched for 7 days/)).toBeTruthy();
  });

  it("says so when the Stash is empty", async () => {
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox([reviewable]) } as never });
    expect(await screen.findByText(/Nothing in the Stash/)).toBeTruthy();
  });

  it("scrolls inside its panel at any height", async () => {
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox([stashed("a")]) } as never });
    await screen.findByText("Chat a");
    const page = document.querySelector('[data-nav-part="stash-page"]') as HTMLElement;
    expect(page.className).toContain("h-full");
    expect(page.className).toContain("overflow-y-auto");
  });

  it("opens a chat from its title or Open, brings it back without opening, and offers no Delete for a chat that lives on another Mac", async () => {
    const view = renderSlot({ component: StashPage }, {}, { rpc: {
      attention_state: state(),
      attention_fleet_inbox: inbox([stashed("a"), stashed("m1", { remote: true, machine: "studio", ownerServerId: "o", ownerHostId: "h" })]),
      attention_apply: () => ({ receiptId: "r", results: [{ threadId: "a", ok: true, error: null }] }),
      fleet_mirror_open: () => ({ localThreadId: "copy" }),
    } as never });
    fireEvent.click(await screen.findByText("Chat a"));
    expect(view.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "a" });
    expect(screen.queryByText("Restore")).toBeNull();
    expect(screen.queryByText("Remove for good")).toBeNull();
    expect(screen.getAllByText("Delete")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Open Chat a"));
    expect(view.inspection.navigateCalls.filter((c) => c.method === "toThread" && c.threadId === "a")).toHaveLength(2);
    await act(async () => { fireEvent.click(screen.getByLabelText("Back to sidebar: Chat a")); });
    await waitFor(() => expect(view.inspection.rpcCalls.some((c) => c.method === "attention_apply" && (c.input as { action: string }).action === "restore")).toBe(true));
    fireEvent.click(screen.getByText("Chat m1"));
    await waitFor(() => expect(view.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "copy" }));
  });

  it("deletes only after the short confirmation", async () => {
    const del = vi.fn(async () => ({ ok: true as const }));
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox([stashed("a")]) } as never, sdk: { threads: { delete: del } } as never });
    fireEvent.click(await screen.findByLabelText("Delete Chat a"));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this chat? This cannot be undone.")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(del).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete this chat? This cannot be undone.")).toBeNull();
    fireEvent.click(screen.getByLabelText("Delete Chat a"));
    const group = screen.getByRole("group", { name: "Delete Chat a?" });
    await act(async () => { fireEvent.click(within(group).getByText("Delete")); });
    expect(del).toHaveBeenCalledWith({ threadId: "a", childThreadsConfirmed: true });
  });

  it("groups by age and leaves out a group with nothing in it", async () => {
    const rows = [stashed("recent", { updatedAt: NOW - 3 * DAY }), stashed("old", { updatedAt: NOW - 20 * DAY })];
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox(rows) } as never });
    await screen.findByText("Chat recent");
    const groups = [...document.querySelectorAll('[data-nav-part="stash-group"]')];
    expect(groups.map((g) => g.querySelector("h2")?.textContent)).toEqual(["This week", "Earlier"]);
    expect(within(groups[0] as HTMLElement).getByText("Chat recent")).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByText("Chat old")).toBeTruthy();
  });

  it("shows no heading for an empty group", async () => {
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox([stashed("old", { updatedAt: NOW - 20 * DAY })]) } as never });
    await screen.findByText("Chat old");
    expect([...document.querySelectorAll('[data-nav-part="stash-group"] h2')].map((h) => h.textContent)).toEqual(["Earlier"]);
    expect(groupByAge([], NOW)).toEqual([]);
  });

  it("offers no search box at ten chats", async () => {
    const few = Array.from({ length: 10 }, (_, i) => stashed(`f${i}`));
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox(few) } as never });
    await screen.findByText("Chat f0");
    expect(screen.queryByLabelText("Search stashed chats")).toBeNull();
  });

  it("filters the list by title once there are eleven chats", async () => {
    const many = Array.from({ length: 11 }, (_, i) => stashed(`m${i}`, { title: i === 4 ? "Pricing page idea" : `Chat ${i}` }));
    renderSlot({ component: StashPage }, {}, { rpc: { attention_state: state(), attention_fleet_inbox: inbox(many) } as never });
    const box = await screen.findByLabelText("Search stashed chats");
    fireEvent.change(box, { target: { value: "pricing" } });
    expect(screen.getByText("Pricing page idea")).toBeTruthy();
    expect(screen.queryByText("Chat 3")).toBeNull();
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("No stashed chat matches.")).toBeTruthy();
  });

  it("counts untouched days from the last activity", () => {
    expect(untouchedLabel(NOW - 7 * DAY - 1000, NOW)).toBe("Untouched for 7 days");
    expect(untouchedLabel(NOW - DAY, NOW)).toBe("Untouched for 1 day");
    expect(untouchedLabel(NOW - 1000, NOW)).toBe("Untouched today");
    expect(untouchedLabel(NOW - 90 * DAY, NOW)).toBe("Untouched for 3 months");
  });
});

describe("Work needs you offers Stash, and the Undo toast stays up for ten seconds", () => {
  const rpc = (apply = vi.fn(() => ({ receiptId: "r1", results: [{ threadId: "rv", ok: true, error: null }] }))) => ({
    attention_state: () => ({ records: [], foldWorking: false }),
    attention_fleet_inbox: inbox([reviewable, stashed("old")]),
    attention_apply: apply,
    attention_undo: () => ({ receiptId: "r1", results: [{ threadId: "rv", ok: true, error: null }] }),
  });

  it("keeps stashed chats out of the inbox, lists them in the stashed view with Back to sidebar", async () => {
    renderSlot({ component: AttentionPage }, {}, { rpc: rpc() as never });
    await screen.findByText("Review me");
    expect(screen.queryByText("Chat old")).toBeNull();
    fireEvent.change(screen.getByLabelText("Attention view"), { target: { value: "stashed" } });
    await screen.findByText("Chat old");
    expect(screen.queryByText("Review me")).toBeNull();
    expect(screen.getByText("Back to sidebar")).toBeTruthy();
    expect(screen.queryByText("Restore")).toBeNull();
    expect(screen.queryByText("Stash")).toBeNull();
  });

  it("stashes a reviewable chat at once and shows Undo for ten seconds", async () => {
    const apply = vi.fn(() => ({ receiptId: "r1", results: [{ threadId: "rv", ok: true, error: null }] }));
    const view = renderSlot({ component: AttentionPage }, {}, { rpc: rpc(apply) as never });
    await screen.findByText("Review me");
    await act(async () => { fireEvent.click(screen.getByText("Stash")); });
    expect(UNDO_TOAST_MS).toBe(10_000);
    const call = vi.mocked(toast.success).mock.calls.find(([, o]) => (o as { action?: { label: string } } | undefined)?.action?.label === "Undo");
    expect(call?.[0]).toBe("Stashed");
    expect((call?.[1] as { duration: number }).duration).toBe(10_000);
    await waitFor(() => expect(view.inspection.rpcCalls.some((c) => c.method === "attention_apply" && (c.input as { action: string }).action === "stash")).toBe(true));
  });

  it("gives the settle toast the same ten seconds", async () => {
    renderSlot({ component: AttentionPage }, {}, { rpc: rpc() as never });
    await screen.findByText("Review me");
    await act(async () => { fireEvent.click(screen.getByText("Settle")); });
    const call = vi.mocked(toast.success).mock.calls.find(([m]) => m === "Settled");
    expect((call?.[1] as { duration: number }).duration).toBe(10_000);
  });
});

describe("the Delivery page project icon", () => {
  it("opens the same icon chooser instead of a settings link that has no icon editor", async () => {
    const update = vi.fn(async () => ({}));
    const sdk = {
      plugins: { callRpc: async () => ({ items: {} }) },
      projects: { get: async () => ({ icon: null }), iconCandidates: async () => ({ candidates: ["logo.png"] }), update },
    };
    const view = renderSlot({ component: () => <CoreEntries projectId="p9" /> }, {}, { sdk: sdk as never });
    expect(view.container.querySelector('a[href^="/settings/projects/"]')).toBeNull();
    fireEvent.click(screen.getByText("Project icon", { selector: "button" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByText("logo.png"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ projectId: "p9", icon: { kind: "file", path: "logo.png" } }));
  });
});

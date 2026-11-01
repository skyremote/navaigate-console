// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RemoteThread } from "../src/machines";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() } }));
import { RemoteList } from "../src/machine-row";

const thread: RemoteThread = { id: "thr_a", machine: "studio", title: "Fix the invoice export", via: "macbookm1", url: "https://studio.example.test/threads/thr_a", state: "idle", projectName: "10_NavAIgate", providerId: "codex", updatedAt: 1 };
const NOW = 100_000;

function mount(rpc: Record<string, unknown> = {}, remote: RemoteThread = thread) {
  const onOpen = vi.fn();
  const view = renderSlot(
    { component: () => <RemoteList sections={[{ name: remote.projectName ?? "Other", threads: [remote] }]} now={NOW} onOpen={onOpen} /> },
    {},
    { rpc: rpc as never },
  );
  return { view, onOpen };
}
const relayButton = () => screen.getByRole("button", { name: /Ask or tell Studio about Fix the invoice export/ });
const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const send = () => fireEvent.click(screen.getByRole("button", { name: /^Send to Studio/ }));
const tellOk = { offered: true as const, requestId: "r", delivered: true, delivery: "delivered", url: thread.url };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Ask and Tell on a remote chat row", () => {
  it("keeps the row a single open button and puts the entry point beside it, not inside it", () => {
    mount();
    const open = screen.getByTitle("Fix the invoice export");
    expect(open.querySelectorAll("button")).toHaveLength(0);
    expect(open.contains(relayButton())).toBe(false);
  });

  it("still opens the chat when the title is clicked", () => {
    const { onOpen } = mount();
    fireEvent.click(screen.getByTitle("Fix the invoice export"));
    expect(onOpen).toHaveBeenCalledWith(thread);
  });

  it("tells the chat through Fleet with one request id, and says it was delivered", async () => {
    const calls: unknown[] = [];
    mount({ fleet_tell: (input: unknown) => { calls.push(input); return tellOk; } });
    fireEvent.click(relayButton());
    expect(await screen.findByText("Tell Studio about Fix the invoice export")).toBeTruthy();
    type("  Use the new schema  ");
    send();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ machine: "studio", threadId: "thr_a", message: "Use the new schema" });
    expect((calls[0] as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await screen.findByRole("status")).textContent).toContain("Delivered to Studio");
    expect(box().value).toBe("");
  });

  it("sends the same request id again for a retry of the same text, and a new one for new text", async () => {
    const ids: string[] = [];
    let fail = true;
    mount({ fleet_tell: (input: { requestId: string }) => { ids.push(input.requestId); if (fail) throw new Error("Fleet timed out"); return tellOk; } });
    fireEvent.click(relayButton());
    type("first");
    send();
    expect((await screen.findByRole("alert")).textContent).toContain("Fleet timed out");
    expect(box().value).toBe("first");
    fail = false;
    send();
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).toBe(ids[0]);
    await screen.findByRole("status");
    type("second");
    send();
    await waitFor(() => expect(ids).toHaveLength(3));
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("says plainly that Tell is not offered yet, keeps the text, and points at the chat on Studio", async () => {
    const { view } = mount({ fleet_tell: () => ({ offered: false }) });
    fireEvent.click(relayButton());
    type("Please also check the VAT line");
    send();
    expect((await screen.findByRole("status")).textContent).toContain("does not offer Tell yet");
    expect(box().value).toBe("Please also check the VAT line");
    const open = screen.getByRole("button", { name: "Open on Studio" });
    fireEvent.click(open);
    expect(view.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: thread.url });
  });

  it("reads the latest answer, and says so when the Fleet cannot", async () => {
    let offered = true;
    mount({ fleet_output: () => offered ? { offered: true, state: "idle", output: "Done: 3 files changed", truncated: false } : { offered: false } });
    fireEvent.click(relayButton());
    fireEvent.click(screen.getByRole("button", { name: "Read latest answer" }));
    expect(await screen.findByText("Done: 3 files changed")).toBeTruthy();
    offered = false;
    fireEvent.click(screen.getByRole("button", { name: "Read latest answer" }));
    expect((await screen.findByRole("status")).textContent).toContain("cannot read answers back yet");
    expect(screen.queryByText("Done: 3 files changed")).toBeNull();
  });

  it("asks the Mac in the chat's project and reads the answer back by its receipt", async () => {
    const starts: unknown[] = [];
    const receipts: unknown[] = [];
    let ready = false;
    mount({
      fleet_start: (input: unknown) => { starts.push(input); return { outcome: "started", threadId: "thr_new", requestId: "11111111-1111-4111-8111-111111111111", url: "https://studio.example.test/threads/thr_new" }; },
      fleet_receipt: (input: unknown) => { receipts.push(input); return ready ? { offered: true, state: "ready", message: null, output: "42 invoices", truncated: false, url: null } : { offered: true, state: "pending", message: "Not ready yet", output: null, truncated: false, url: null }; },
    });
    fireEvent.click(relayButton());
    fireEvent.click(screen.getByRole("button", { name: "Ask Studio" }));
    expect(await screen.findByText(/Starts a new chat on Studio in 10_NavAIgate/)).toBeTruthy();
    type("How many invoices are unpaid?");
    send();
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toMatchObject({ machine: "studio", prompt: "How many invoices are unpaid?", projectName: "10_NavAIgate" });
    expect((starts[0] as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await screen.findByRole("status")).textContent).toContain("Started on Studio");
    fireEvent.click(screen.getByRole("button", { name: "Read the answer" }));
    expect(await screen.findByText(/Still working: Not ready yet/)).toBeTruthy();
    ready = true;
    fireEvent.click(screen.getByRole("button", { name: "Read the answer" }));
    expect(await screen.findByText("42 invoices")).toBeTruthy();
    expect(receipts).toEqual([{ id: "11111111-1111-4111-8111-111111111111" }, { id: "11111111-1111-4111-8111-111111111111" }]);
  });

  it("starts an ask without a project name when the row has none, and falls back to the command id for the receipt", async () => {
    const starts: Array<Record<string, unknown>> = [];
    const receipts: unknown[] = [];
    mount({
      fleet_start: (input: Record<string, unknown>) => { starts.push(input); return { outcome: "sent", threadId: null, commandId: "cmd_12345678" }; },
      fleet_receipt: (input: unknown) => { receipts.push(input); return { offered: false }; },
    }, { ...thread, projectName: null });
    fireEvent.click(relayButton());
    fireEvent.click(screen.getByRole("button", { name: "Ask Studio" }));
    type("Status?");
    send();
    expect((await screen.findByRole("status")).textContent).toContain("Sent to Studio");
    expect("projectName" in starts[0]!).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Read the answer" }));
    expect((await screen.findAllByRole("status")).map((el) => el.textContent).join(" ")).toContain("cannot read answers back yet");
    expect(receipts).toEqual([{ id: "cmd_12345678" }]);
  });

  it("offers Tell and Ask in the right-click menu of the row", async () => {
    mount({});
    fireEvent.contextMenu(screen.getByTitle("Fix the invoice export"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Tell this chat…")).toBeTruthy();
    fireEvent.click(within(menu).getByText("Ask Studio…"));
    expect(await screen.findByText(/Starts a new chat on Studio/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask Studio" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("reports a Fleet that is not running as an error and keeps the text", async () => {
    mount({ fleet_tell: () => { throw new Error('plugin "fleet" is not loaded'); } });
    fireEvent.click(relayButton());
    type("hello");
    send();
    expect((await screen.findByRole("alert")).textContent).toContain("not loaded");
    expect(box().value).toBe("hello");
    await act(async () => {});
  });
});

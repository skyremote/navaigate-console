// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RemoteThread } from "../src/machines";

const route = vi.hoisted(() => ({ threadId: "thr_root" }));
vi.mock("@get-bb/plugin-sdk/app", async (original) => {
  const sdk = await original<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...sdk, useBbContext: () => ({ ...sdk.useBbContext(), threadId: route.threadId }) };
});
vi.mock("sonner", () => ({ toast: { loading: vi.fn(() => Math.random()), dismiss: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";
import { useOpenRemote } from "../src/machine-row";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const remote = (id: string): RemoteThread => ({ id, machine: "studio", title: id, via: "macbookm1", url: `https://studio.example.test/threads/${id}`, state: "idle", projectName: null, providerId: "codex", updatedAt: 1 });
function Openers() {
  const open = useOpenRemote();
  return <><button onClick={() => open(remote("thr_a"))}>Open A</button><button onClick={() => open(remote("thr_b"))}>Open B</button><a href="/threads/thr_root" onClick={(event) => event.preventDefault()}>Current chat</a><input aria-label="Current draft" /></>;
}
afterEach(() => { cleanup(); route.threadId = "thr_root"; vi.clearAllMocks(); });

describe("remote opening follows the current user navigation", () => {
  it("does not redirect after the user has opened another local chat", async () => {
    const pending = deferred<{ localThreadId: string }>();
    const view = renderSlot({ component: Openers }, {}, { context: { threadId: "thr_root" }, rpc: { fleet_mirror_open: () => pending.promise } });
    fireEvent.click(screen.getByText("Open A"));
    route.threadId = "thr_other";
    view.lifecycle.rerender(<Openers />);
    await act(async () => { pending.resolve({ localThreadId: "thr_copy_a" }); });
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(toast.dismiss).toHaveBeenCalled();
  });

  it("lets only the latest clicked remote chat navigate when responses arrive out of order", async () => {
    const a = deferred<{ localThreadId: string }>();
    const b = deferred<{ localThreadId: string }>();
    const view = renderSlot({ component: Openers }, {}, { context: { threadId: "thr_root" }, rpc: { fleet_mirror_open: (input) => (input as { threadId: string }).threadId === "thr_a" ? a.promise : b.promise } });
    fireEvent.click(screen.getByText("Open A"));
    fireEvent.click(screen.getByText("Open B"));
    await act(async () => { b.resolve({ localThreadId: "thr_copy_b" }); });
    await act(async () => { a.resolve({ localThreadId: "thr_copy_a" }); });
    expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_copy_b" }]);
  });

  it("does not navigate from a disposed sidebar", async () => {
    const pending = deferred<{ localThreadId: string }>();
    const view = renderSlot({ component: Openers }, {}, { rpc: { fleet_mirror_open: () => pending.promise } });
    fireEvent.click(screen.getByText("Open A"));
    view.lifecycle.unmount();
    await act(async () => { pending.resolve({ localThreadId: "thr_copy_a" }); });
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("cancels a pending open when the user clicks the already-open chat", async () => {
    const pending = deferred<{ localThreadId: string }>();
    const view = renderSlot({ component: Openers }, {}, { context: { threadId: "thr_root" }, rpc: { fleet_mirror_open: () => pending.promise } });
    fireEvent.click(screen.getByText("Open A"));
    fireEvent.click(screen.getByText("Current chat"));
    await act(async () => { pending.resolve({ localThreadId: "thr_copy_a" }); });
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("keeps the user in the current composer after they start typing", async () => {
    const pending = deferred<{ localThreadId: string }>();
    const view = renderSlot({ component: Openers }, {}, { context: { threadId: "thr_root" }, rpc: { fleet_mirror_open: () => pending.promise } });
    fireEvent.click(screen.getByText("Open A"));
    fireEvent.input(screen.getByLabelText("Current draft"), { target: { value: "Keep me here" } });
    await act(async () => { pending.resolve({ localThreadId: "thr_copy_a" }); });
    expect((screen.getByLabelText("Current draft") as HTMLInputElement).value).toBe("Keep me here");
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("offers the owner page explicitly after a failure instead of opening another server automatically", async () => {
    const pending = deferred<{ localThreadId: string }>();
    const view = renderSlot({ component: Openers }, {}, { rpc: { fleet_mirror_open: () => pending.promise } });
    fireEvent.click(screen.getByText("Open A"));
    await act(async () => { pending.reject(new Error("Studio route unavailable")); });
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith("Could not open the Studio chat", expect.objectContaining({ action: expect.objectContaining({ label: "Open on Studio" }) }));
    const options = vi.mocked(toast.error).mock.calls[0]?.[1] as { action: { onClick(): void } };
    options.action.onClick();
    expect(view.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://studio.example.test/threads/thr_a" }]);
  });
});

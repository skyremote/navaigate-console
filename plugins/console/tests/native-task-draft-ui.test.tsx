// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TaskDraft } from "../src/delivery-shared";
import { ComposerBridge, queueNewChatSelection } from "../src/composer-bridge";
import { deliveryPrompt } from "../src/delivery-prompts";

afterEach(cleanup);
const choice = { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" };
const settings = {
  revision: 1,
  resolved: [{ purpose: "pull-request", choice, inheritedFrom: { projectId: null, hostId: null } }],
  appliedTo: "delivery-tasks",
  remoteApplied: false,
};
const context = "Purpose: pull-request. Inspect the current task.";
function draft(props: { threadId?: string }) {
  return renderSlot({ component: TaskDraft }, { purpose: "pull-request", projectId: "proj-1", hostId: "m1", context, ...props } as never, {
    rpc: { delivery_settings: () => settings },
  } as never);
}
describe("PR copy drafting from the Delivery page", () => {
  it("offers a new chat's composer when the page has no thread", async () => {
    const view = draft({});
    const button = (await screen.findByRole("button", { name: "Put task in a new chat's composer" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toCompose", options: { projectId: "proj-1", hostId: "m1", initialPrompt: deliveryPrompt("pull-request", context), focusPrompt: true } },
    ]);
    expect(await screen.findByText(/Opened a new chat with the task/)).toBeTruthy();
  });
  it("keeps the in-thread button inside a thread", async () => {
    draft({ threadId: "t1" });
    expect(await screen.findByRole("button", { name: "Put task in this thread's composer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Put task in a new chat's composer" })).toBeNull();
  });
});
describe("model carried to the new chat's composer", () => {
  it("applies the queued model once, when the new-thread composer mounts", async () => {
    queueNewChatSelection(choice);
    const view = renderSlot({ component: ComposerBridge }, {}, { composer: { scope: { kind: "new-thread" } } } as never);
    await waitFor(() => expect(view.inspection.composer.selection?.model).toBe("claude-opus-5-5"));
    view.unmount();
    const again = renderSlot({ component: ComposerBridge }, {}, { composer: { scope: { kind: "new-thread" } } } as never);
    expect(again.inspection.composer.selection?.model).not.toBe("claude-opus-5-5");
  });
  it("does not touch an existing thread's composer", async () => {
    queueNewChatSelection(choice);
    const view = renderSlot({ component: ComposerBridge }, {}, { composer: { scope: { kind: "thread", threadId: "t1" } } } as never);
    expect(view.inspection.composer.selection?.model).not.toBe("claude-opus-5-5");
    const fresh = renderSlot({ component: ComposerBridge }, {}, { composer: { scope: { kind: "new-thread" } } } as never);
    await waitFor(() => expect(fresh.inspection.composer.selection?.model).toBe("claude-opus-5-5"));
  });
});

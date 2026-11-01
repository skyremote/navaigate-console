// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { z } from "zod";
import type { nativeSessionStateSchema } from "../server-native-sessions";

// The SDK harness does not expose a route setter. Keep its real RPC,
// realtime and composer implementations; override only the route input.
const route = vi.hoisted(() => ({ threadId: undefined as string | null | undefined, ambiguousComposers: false, duplicateSelections: 0 }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...actual, useComposers: () => {
    const composers = actual.useComposers();
    // Two mounted controllers may share a draft key while keeping separate
    // execution state. The test still uses the real harness composer handle.
    return route.ambiguousComposers ? composers.flatMap((composer) => [composer, { ...composer, setSelection: async () => {
      route.duplicateSelections++;
      throw new Error("An unrelated duplicate composer controller was used");
    } }]) : composers;
  }, useBbContext: () => {
    const context = actual.useBbContext();
    return route.threadId === undefined ? context : { ...context, threadId: route.threadId };
  } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { NativeConversationOverlay, NativeConversationPanel, NativeModelsComposer, NativeModelsHeader } from "../src/native-sessions";

type Session = z.infer<typeof nativeSessionStateSchema>;
function state(root: string, others: string[] = [], active = root): Session {
  return {
    rootThreadId: root, title: `${root} title`, projectId: "proj_test", activeThreadId: active,
    version: 1, pending: null, warning: null,
    members: [root, ...others].map((id, index) => ({
      id, sourceThreadId: index ? root : null, kind: index ? "continuation" : "root",
      providerId: index ? "claude-code" : "codex", environmentId: "env_shared", model: `${id}-model`, reasoningLevel: "high",
      serviceTier: "default", status: "idle", title: `${id} title`, createdAt: 1,
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const inputThread = (input: unknown) => (input as { threadId: string }).threadId;
const sdk = { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_test", environmentId: null }) } };

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  route.threadId = undefined;
  route.ambiguousComposers = false;
  route.duplicateSelections = 0;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function primaryWindow() {
  const parent = document.createElement("main");
  parent.style.position = "relative";
  const original = document.createElement("section");
  original.dataset.threadWindow = "";
  original.inert = false;
  const composer = document.createElement("div");
  composer.dataset.appComposerRole = "primary";
  original.append(composer);
  parent.append(original);
  document.body.append(parent);
  return original;
}

describe("native conversation route isolation", () => {
  it("releases an old multi-model overlay without navigating back when the user opens an unrelated thread", async () => {
    const original = primaryWindow();
    const unrelated = deferred<Session>();
    route.threadId = "thr_root";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: (input) => inputThread(input) === "thr_root" ? state("thr_root", ["thr_child"], "thr_child") : unrelated.promise },
    });
    await waitFor(() => expect(document.querySelector('[data-native-conversation-root="thr_root"]')).not.toBeNull(), { timeout: 5000 });
    expect(original.style.visibility).toBe("hidden");

    route.threadId = "thr_unrelated";
    view.lifecycle.rerender(<NativeConversationOverlay />);
    await waitFor(() => expect(document.querySelector("[data-nav-native-session]")).toBeNull());
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(original.style.visibility).toBe("");
    expect(original.inert).toBe(false);
    expect(original.hasAttribute("aria-hidden")).toBe(false);
    await act(async () => { unrelated.resolve(state("thr_unrelated")); });
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
  });

  it("canonicalises a verified member route to its logical root", async () => {
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_child", projectId: "proj_test" },
      rpc: { native_session_state: () => state("thr_root", ["thr_child"], "thr_child") },
    });
    await waitFor(() => expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_root" }]));
  });

  it("keeps the opened root and its composer when another workspace is the saved selection", async () => {
    const original = primaryWindow();
    const session = state("thr_root", ["thr_child"], "thr_child");
    session.members[1].environmentId = "env_parallel";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: () => session },
    });
    await waitFor(() => expect(view.inspection.rpcCalls).toHaveLength(1));
    await view.behavior.emitRealtime("native-sessions", {});
    await act(async () => {});
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
    expect(original.style.visibility).toBe("");
    view.lifecycle.rerender(<NativeConversationOverlay />);
    expect(view.inspection.navigateCalls).toHaveLength(0);
  });

  it("never pushes an opened root into a saved Studio mirror on refresh", async () => {
    const original = primaryWindow();
    const session = state("thr_root", ["thr_mirror"], "thr_mirror");
    session.members[1].providerId = "fleet-mirror";
    session.members[1].kind = "parallel";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: () => session },
    });
    await waitFor(() => expect(view.inspection.rpcCalls).toHaveLength(1));
    await view.behavior.emitRealtime("native-sessions", {});
    await act(async () => {});
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(original.style.visibility).toBe("");
    expect(original.inert).toBe(false);
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
  });

  it("keeps a physical worktree open when another window selects the root", async () => {
    const session = state("thr_root", ["thr_child"], "thr_root");
    session.members[1].environmentId = "env_parallel";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_child", projectId: "proj_test" },
      rpc: { native_session_state: () => session },
    });
    await waitFor(() => expect(view.inspection.rpcCalls).toHaveLength(1));
    await act(async () => {});
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("keeps an explicitly opened native child when a different window last selected a mirror", async () => {
    const session = state("thr_root", ["thr_child", "thr_mirror"], "thr_mirror");
    session.members[2].providerId = "fleet-mirror";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_child", projectId: "proj_test" },
      rpc: { native_session_state: () => session },
    });
    await waitFor(() => expect(view.inspection.rpcCalls).toHaveLength(1));
    await act(async () => {});
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("opens a mirror's physical workspace after an explicit Models selection", async () => {
    const session = state("thr_root", ["thr_mirror"], "thr_mirror");
    session.members[1].providerId = "fleet-mirror";
    session.members[1].kind = "parallel";
    const view = renderSlot({ component: NativeModelsHeader }, { threadId: "thr_root" }, {
      context: { threadId: "thr_root", projectId: "proj_test" }, sdk,
      rpc: { native_session_state: () => session, native_session_select: () => session },
    });
    await waitFor(() => expect(view.inspection.rpcCalls.some((call) => call.method === "native_session_state")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Conversation models" }));
    fireEvent.click(await screen.findByRole("button", { name: /fleet-mirror.*thr_mirror-model/ }));
    await waitFor(() => expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_mirror" }]));
    expect(view.inspection.rpcCalls.some((call) => call.method === "native_session_select")).toBe(true);
  });

  it("keeps the physical route for an owner-routed mirror even when its local environment matches", async () => {
    const session = state("thr_root", ["thr_child"], "thr_child");
    session.members[1].providerId = "fleet-mirror";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_child", projectId: "proj_test" },
      rpc: { native_session_state: () => session },
    });
    await act(async () => {});
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
  });

  it("does not redirect surviving members to a deleted logical root", async () => {
    const session = state("thr_root", ["thr_child"], "thr_child");
    session.members[0].status = "deleted";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_child", projectId: "proj_test" },
      rpc: { native_session_state: () => session },
    });
    await act(async () => {});
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it.each([
    new Error("Root deleted"),
    Object.assign(new Error("Root missing"), { code: "not_found", status: 404 }),
    Object.assign(new Error("Forbidden"), { code: "forbidden", status: 403 }),
  ])("restores the host view after a permanent state failure: $message", async (failure) => {
    const original = primaryWindow();
    let missing = false;
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: () => { if (missing) throw failure; return state("thr_root", ["thr_child"], "thr_child"); } },
    });
    await waitFor(() => expect(original.style.visibility).toBe("hidden"));
    missing = true;
    await view.behavior.emitRealtime("native-sessions", {});
    await waitFor(() => expect(document.querySelector("[data-nav-native-session]")).toBeNull());
    expect(original.style.visibility).toBe("");
    expect(original.inert).toBe(false);
  });

  it.each([
    Object.assign(new Error("Failed to fetch"), { code: "transport_error" }),
    Object.assign(new Error("Temporarily unavailable"), { code: "handler_error", status: 503 }),
    Object.assign(new Error("Rate limited"), { code: "handler_error", status: 429 }),
  ])("keeps the loaded model through a transient state failure: $message", async (failure) => {
    const original = primaryWindow();
    let failing = false;
    let selected = "thr_child";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: () => { if (failing) throw failure; return state("thr_root", ["thr_child"], selected); } },
    });
    await waitFor(() => expect(original.style.visibility).toBe("hidden"));
    failing = true;
    await view.behavior.emitRealtime("native-sessions", {});
    await act(async () => {});
    expect(document.querySelector('[data-native-conversation-root="thr_root"]')).not.toBeNull();
    expect(original.style.visibility).toBe("hidden");
    expect(original.inert).toBe(true);
    expect(view.inspection.navigateCalls).toEqual([]);
    failing = false;
    selected = "thr_root";
    await view.behavior.emitRealtime("native-sessions", {});
    await waitFor(() => expect(document.querySelector("[data-nav-native-session]")).toBeNull());
    expect(original.style.visibility).toBe("");
  });

  it("never carries a loaded model into another route whose first read fails", async () => {
    const original = primaryWindow();
    route.threadId = "thr_root";
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: (input) => {
        if (inputThread(input) !== "thr_root") throw Object.assign(new Error("Failed to fetch"), { code: "transport_error" });
        return state("thr_root", ["thr_child"], "thr_child");
      } },
    });
    await waitFor(() => expect(original.style.visibility).toBe("hidden"));
    route.threadId = "thr_unrelated";
    view.lifecycle.rerender(<NativeConversationOverlay />);
    await waitFor(() => expect(view.inspection.rpcCalls.some((call) => inputThread(call.input) === "thr_unrelated")).toBe(true));
    await act(async () => {});
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
    expect(original.style.visibility).toBe("");
    expect(original.inert).toBe(false);
    expect(view.inspection.navigateCalls).toEqual([]);
  });

  it("refuses to canonicalise a route that is absent from the returned member list", async () => {
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_unrelated", projectId: "proj_test" },
      rpc: { native_session_state: () => state("thr_root", ["thr_child"]) },
    });
    await waitFor(() => expect(view.inspection.rpcCalls).toHaveLength(1));
    await act(async () => {});
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
  });

  it("keeps the original writable composer when the root model is selected", async () => {
    const original = primaryWindow();
    renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: () => state("thr_root", ["thr_child"]) },
    });
    await act(async () => {});
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
    expect(screen.queryByTestId("bb-thread-chat")).toBeNull();
    expect(original.style.visibility).toBe("");
    expect(original.inert).toBe(false);
  });

  it("does not duplicate a writable child that is already open in another split pane", async () => {
    const original = primaryWindow();
    original.parentElement!.dataset.splitPaneId = "pane-root";
    const child = primaryWindow();
    child.parentElement!.dataset.splitPaneId = "pane-child";
    renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      sidebarSplitLayout: { panes: [
        { paneId: "pane-root", threadId: "thr_root", isFocused: true, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { paneId: "pane-child", threadId: "thr_child", isFocused: false, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } },
      ] },
      rpc: { native_session_state: () => state("thr_root", ["thr_child"], "thr_child") },
    });
    await act(async () => {});
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
    expect(screen.queryByTestId("bb-thread-chat")).toBeNull();
    expect(original.style.visibility).toBe("");
    expect(child.style.visibility).toBe("");
  });

  it("rebinds after the host replaces its primary window and restores the replacement on unmount", async () => {
    const original = primaryWindow();
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: () => state("thr_root", ["thr_child"], "thr_child") },
    });
    await waitFor(() => expect(original.style.visibility).toBe("hidden"));
    const oldSlot = document.querySelector("[data-nav-native-session]");
    const replacement = document.createElement("section");
    replacement.dataset.threadWindow = "";
    replacement.inert = false;
    const primary = document.createElement("div");
    primary.dataset.appComposerRole = "primary";
    replacement.append(primary);
    original.replaceWith(replacement);
    await waitFor(() => expect(replacement.style.visibility).toBe("hidden"));
    expect(original.style.visibility).toBe("");
    expect(original.inert).toBe(false);
    expect(document.querySelector("[data-nav-native-session]")).not.toBe(oldSlot);
    expect(oldSlot?.isConnected).toBe(false);
    view.lifecycle.unmount();
    expect(replacement.style.visibility).toBe("");
    expect(replacement.inert).toBe(false);
    expect(replacement.hasAttribute("aria-hidden")).toBe(false);
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
  });

  it("keeps the separate history panel read-only so it cannot add another execution controller", async () => {
    renderSlot({ component: NativeConversationPanel }, { threadId: "thr_root" }, {
      rpc: { native_session_state: () => state("thr_root", ["thr_child"], "thr_child") },
    });
    const chats = await screen.findAllByTestId("bb-thread-chat");
    expect(chats).toHaveLength(2);
    expect(chats.every((chat) => chat.dataset.variant === "timeline")).toBe(true);
  });

  it("does not recreate a hidden host window from a mutation microtask queued before unmount", async () => {
    const original = primaryWindow();
    const observers: Array<{ callback: MutationCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal("MutationObserver", class {
      callback: MutationCallback;
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: MutationCallback) { this.callback = callback; observers.push(this); }
    });
    const view = renderSlot({ component: NativeConversationOverlay }, {}, {
      context: { threadId: "thr_root", projectId: "proj_test" },
      rpc: { native_session_state: () => state("thr_root", ["thr_child"], "thr_child") },
    });
    await act(async () => {});
    expect(document.querySelector('[data-native-conversation-root="thr_root"]')).not.toBeNull();
    const queued: VoidFunction[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => { queued.push(callback); });
    observers[0].callback([], {} as MutationObserver);
    expect(queued).toHaveLength(1);
    view.lifecycle.unmount();
    for (const callback of queued) callback();
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
    expect(original.style.visibility).toBe("");
    expect(original.inert).toBe(false);
    expect(original.hasAttribute("aria-hidden")).toBe(false);
  });

  it("does not let an old route RPC replace the newly loaded header", async () => {
    const old = deferred<Session>();
    const view = renderSlot({ component: NativeModelsHeader }, { threadId: "thr_old" }, {
      sdk,
      rpc: { native_session_state: (input) => inputThread(input) === "thr_old" ? old.promise : state("thr_new", ["thr_new_child"]) },
    });
    view.lifecycle.rerender(<NativeModelsHeader threadId="thr_new" />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation models" }));
    await screen.findByText("thr_new_child-model");
    await act(async () => { old.resolve(state("thr_old", ["thr_old_child"])); });
    expect(screen.queryByText("thr_old_child-model")).toBeNull();
    expect(screen.getByText("thr_new_child-model")).toBeTruthy();
  });

  it("keeps the newest realtime result when an earlier request settles late", async () => {
    const first = deferred<Session>();
    const latest = deferred<Session>();
    let requests = 0;
    const view = renderSlot({ component: NativeModelsHeader }, { threadId: "thr_root" }, {
      sdk, rpc: { native_session_state: () => ++requests === 1 ? first.promise : latest.promise },
    });
    await view.behavior.emitRealtime("native-sessions", {});
    await act(async () => { latest.resolve(state("thr_root", ["thr_current_child"])); });
    fireEvent.click(screen.getByRole("button", { name: "Conversation models" }));
    await screen.findByText("thr_current_child-model");
    await act(async () => { first.resolve(state("thr_root", ["thr_stale_child"])); });
    expect(screen.queryByText("thr_stale_child-model")).toBeNull();
    expect(screen.getByText("thr_current_child-model")).toBeTruthy();
  });

  it("does not resurrect the first visit's result after navigating away and back", async () => {
    const firstVisit = deferred<Session>();
    let rootRequests = 0;
    const view = renderSlot({ component: NativeModelsHeader }, { threadId: "thr_root" }, {
      sdk, rpc: { native_session_state: (input) => inputThread(input) !== "thr_root" ? state("thr_other") : ++rootRequests === 1 ? firstVisit.promise : state("thr_root", ["thr_current_child"]) },
    });
    view.lifecycle.rerender(<NativeModelsHeader threadId="thr_other" />);
    await act(async () => {});
    view.lifecycle.rerender(<NativeModelsHeader threadId="thr_root" />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation models" }));
    await screen.findByText("thr_current_child-model");
    await act(async () => { firstVisit.resolve(state("thr_root", ["thr_first_visit_child"])); });
    expect(screen.queryByText("thr_first_visit_child-model")).toBeNull();
    expect(screen.getByText("thr_current_child-model")).toBeTruthy();
  });
});

describe("native composer model changes", () => {
  const contextFile = { type: "localFile" as const, path: ".bb/attachments/synthetic-context.txt", name: "conversation-context-test.txt", mimeType: "text/plain", sizeBytes: 5000, sourceProjectId: "proj_test" };
  const contextAttachment = () => ({ attachment: contextFile, sha256: "a".repeat(64), truncated: false, messageCount: 2, delivery: "uploaded-context-file" });
  const text = "Read @thread:thr_evidence and the attached file.";
  const mention = { from: 5, to: 25, label: "Evidence", kind: "thread" as const, threadId: "thr_evidence", projectId: "proj_test" };
  const attachments = [{ type: "localFile" as const, path: "/tmp/synthetic-evidence.txt", name: "synthetic-evidence.txt", sourceProjectId: "proj_test" }];
  const composer = { text, mentions: [mention], attachments, scope: { kind: "thread" as const, threadId: "thr_root" }, selection: { providerId: "codex", model: "thr_root-model", reasoningLevel: "high" as const } };

  it("does not arm or select a model when two native composer controllers match the active session", async () => {
    route.ambiguousComposers = true;
    const view = renderSlot({ component: NativeModelsHeader }, { threadId: "thr_root" }, {
      sdk, composer,
      rpc: { native_context_attachment: contextAttachment, native_session_state: () => state("thr_root"), native_session_arm: () => state("thr_root"), native_session_cancel: () => state("thr_root") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Conversation models" }));
    const apply = await screen.findByRole("button", { name: "Apply execution selection" });
    await act(async () => {});
    expect(apply.closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(apply);
    expect(view.inspection.rpcCalls.some((call) => call.method === "native_session_arm")).toBe(false);
    expect(route.duplicateSelections).toBe(0);
    expect(view.inspection.composer.selections).toEqual([]);
    expect(view.inspection.composer.draft).toEqual({ text, mentions: [mention], attachments });
  });

  it("uses the exact composer action's bound controller even when another matching controller exists", async () => {
    route.ambiguousComposers = true;
    const view = renderSlot({ component: NativeModelsComposer }, {}, {
      sdk, composer,
      rpc: { native_context_attachment: contextAttachment, native_session_state: () => state("thr_root"), native_session_arm: () => state("thr_root"), native_session_cancel: () => state("thr_root") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Conversation models" }));
    const apply = await screen.findByRole("button", { name: "Apply execution selection" });
    await waitFor(() => expect(apply.closest("fieldset")?.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "claude-code" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-next" } });
    fireEvent.click(apply);
    await waitFor(() => expect(view.inspection.composer.selection?.model).toBe("claude-next"));
    expect(route.duplicateSelections).toBe(0);
    expect(view.inspection.composer.draft).toEqual({ text, mentions: [mention], attachments: [...attachments, contextFile] });
    expect(view.inspection.composer.submits).toEqual([]);
  });

  it("arms before changing provider and preserves the real structured draft, attachments and intervening edits", async () => {
    const arm = deferred<Session>();
    const view = renderSlot({ component: NativeModelsHeader }, { threadId: "thr_root" }, {
      sdk, composer,
      rpc: { native_context_attachment: contextAttachment, native_session_state: () => state("thr_root"), native_session_arm: () => arm.promise, native_session_cancel: () => state("thr_root") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Conversation models" }));
    const apply = await screen.findByRole("button", { name: "Apply execution selection" });
    await waitFor(() => expect(apply.closest("fieldset")?.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "claude-code" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-next" } });
    fireEvent.click(apply);
    await waitFor(() => expect(view.inspection.rpcCalls.some((call) => call.method === "native_session_arm")).toBe(true));
    expect(view.inspection.composer.selections).toEqual([]);
    expect(view.inspection.composer.draft).toEqual({ text, mentions: [mention], attachments });
    await view.behavior.setComposerText(`${text}\nKeep this later edit.`);
    const edited = structuredClone(view.inspection.composer.draft);
    await act(async () => { arm.resolve(state("thr_root")); });
    await waitFor(() => expect(view.inspection.composer.selection?.providerId).toBe("claude-code"));
    expect(view.inspection.composer.selection?.model).toBe("claude-next");
    expect(view.inspection.composer.draft).toEqual({ ...edited, attachments: [...edited.attachments, contextFile] });
    expect(view.inspection.composer.submits).toEqual([]);
  });

  it("cancels an unsuccessful arm without changing the composer selection or uploaded attachments", async () => {
    const arm = deferred<Session>();
    const view = renderSlot({ component: NativeModelsHeader }, { threadId: "thr_root" }, {
      sdk, composer,
      rpc: { native_context_attachment: contextAttachment, native_session_state: () => state("thr_root"), native_session_arm: () => arm.promise, native_session_cancel: () => state("thr_root") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Conversation models" }));
    const apply = await screen.findByRole("button", { name: "Apply execution selection" });
    await waitFor(() => expect(apply.closest("fieldset")?.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "claude-code" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-next" } });
    fireEvent.click(apply);
    await waitFor(() => expect(view.inspection.rpcCalls.some((call) => call.method === "native_session_arm")).toBe(true));
    await act(async () => { arm.reject(new Error("Synthetic persistence failure")); });
    await waitFor(() => expect(apply.closest("fieldset")?.disabled).toBe(false));
    expect(view.inspection.rpcCalls.some((call) => call.method === "native_session_cancel")).toBe(false);
    expect(view.inspection.composer.selections).toEqual([]);
    expect(view.inspection.composer.selection).toEqual(composer.selection);
    expect(view.inspection.composer.draft).toEqual({ text, mentions: [mention], attachments });
    expect(view.inspection.composer.submits).toEqual([]);
  });
});

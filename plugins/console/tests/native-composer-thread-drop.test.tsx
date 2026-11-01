// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { droppedThreads, threadDragPayload } from "../src/context-workspace-model";
import { publishComposerHandle, unpublishComposerHandle } from "../src/composer-bridge";
import { ComposerThreadDrop } from "../src/composer-thread-drop";

const DRAG = "application/x-nav-thread";
afterEach(() => { cleanup(); document.body.innerHTML = ""; unpublishComposerHandle("new"); unpublishComposerHandle("thread:thr_open"); });

describe("what a rail row drags", () => {
  const thread = { id: "thr_a", projectId: "proj_1", title: "Plan" };
  it("is the row alone when nothing else is selected", () => {
    expect(JSON.parse(threadDragPayload(thread, ["thr_a"]))).toEqual({ id: "thr_a", projectId: "proj_1", title: "Plan" });
  });
  it("carries the whole selection when the row is dragged out of several", () => {
    expect(JSON.parse(threadDragPayload(thread, ["thr_a", "thr_b"]))).toEqual({ id: "thr_a", projectId: "proj_1", title: "Plan", ids: ["thr_a", "thr_b"] });
  });
  it("falls back to the id for an untitled chat", () => {
    expect(JSON.parse(threadDragPayload({ ...thread, title: null }, ["thr_a"])).title).toBe("thr_a");
  });
});

describe("dropped chats become mentions", () => {
  it("reads one dragged chat", () => {
    expect(droppedThreads('{"id":"thr_a","projectId":"proj_1","title":"Plan"}', () => undefined)).toEqual([
      { kind: "thread", from: 0, to: 4, label: "Plan", threadId: "thr_a", projectId: "proj_1" },
    ]);
  });
  it("reads every chat of a multi-selection, titled from the sidebar and without duplicates", () => {
    const titles: Record<string, string> = { thr_a: "Plan", thr_b: "Review" };
    const out = droppedThreads('{"id":"thr_a","projectId":"proj_1","title":"Plan","ids":["thr_a","thr_b","thr_b","thr_c"]}', (id) => titles[id]);
    expect(out.map((mention) => [mention.threadId, mention.label])).toEqual([["thr_a", "Plan"], ["thr_b", "Review"], ["thr_c", "thr_c"]]);
  });
  it("ignores anything that is not a chat", () => {
    expect(droppedThreads("not json", () => undefined)).toEqual([]);
    expect(droppedThreads('{"id":null}', () => undefined)).toEqual([]);
  });
});

function handle(insert = vi.fn()) {
  return { api: { insert, focus: vi.fn() } as never, view: {} as never, insert };
}
function shell(role: "primary" | "secondary" = "primary") {
  document.body.innerHTML = `<div data-app-composer-role="${role}"><div data-promptbox-shell><form><div class="editor" contenteditable>draft</div></form></div></div>`;
  return document.querySelector<HTMLElement>("[data-promptbox-shell]")!;
}
function drag(target: Element, type: "dragOver" | "drop" | "dragLeave", data: string | null = '{"id":"thr_a","projectId":"proj_1","title":"Plan"}') {
  const store = new Map<string, string>(data === null ? [] : [[DRAG, data]]);
  const dataTransfer = { types: data === null ? ["text/plain"] : [DRAG], getData: (key: string) => store.get(key) ?? "", dropEffect: "none", effectAllowed: "copyMove" };
  fireEvent[type](target, { dataTransfer });
  return dataTransfer;
}

describe("dropping a rail chat on the chat box", () => {
  beforeEach(() => { window.history.pushState({}, "", "/"); });

  it("adds the chat to the new-chat composer as a mention and marks the box while hovering", () => {
    const box = shell();
    const target = handle();
    publishComposerHandle("new", target as never);
    renderSlot({ component: ComposerThreadDrop }, {}, {});
    const over = drag(box.querySelector(".editor")!, "dragOver");
    expect(over.dropEffect).toBe("copy");
    expect(box.hasAttribute("data-nav-thread-drop")).toBe(true);
    act(() => { drag(box.querySelector(".editor")!, "drop"); });
    expect(target.insert).toHaveBeenCalledTimes(1);
    expect(target.insert.mock.calls[0][0]).toEqual([{ kind: "thread", from: 0, to: 4, label: "Plan", threadId: "thr_a", projectId: "proj_1" }]);
    expect(target.insert.mock.calls[0][1]).toEqual({ at: "end", block: true });
    expect(box.hasAttribute("data-nav-thread-drop")).toBe(false);
  });

  it("targets the open chat's composer when a chat is open", () => {
    window.history.pushState({}, "", "/threads/thr_open");
    const box = shell();
    const target = handle();
    const other = handle();
    publishComposerHandle("thread:thr_open", target as never);
    publishComposerHandle("new", other as never);
    renderSlot({ component: ComposerThreadDrop }, {}, { context: { threadId: "thr_open" } });
    act(() => { drag(box, "drop"); });
    expect(target.insert).toHaveBeenCalledTimes(1);
    expect(other.insert).not.toHaveBeenCalled();
  });

  it("targets the switched model's composer inside a grouped conversation, not the hidden first chat", () => {
    window.history.pushState({}, "", "/threads/thr_root");
    document.body.innerHTML = `<div data-app-composer-role="primary" hidden><div data-promptbox-shell><form></form></div></div><div data-nav-native-session><div data-native-conversation-root="thr_root" data-native-active-thread="thr_opus"><div data-app-composer-role="secondary"><div data-promptbox-shell id="visible"><form><div class="editor" contenteditable>draft</div></form></div></div></div></div>`;
    const box = document.getElementById("visible")!;
    const root = handle();
    const opus = handle();
    publishComposerHandle("thread:thr_root", root as never);
    publishComposerHandle("thread:thr_opus", opus as never);
    renderSlot({ component: ComposerThreadDrop }, {}, { context: { threadId: "thr_root" } });
    act(() => { drag(box.querySelector(".editor")!, "drop"); });
    expect(opus.insert).toHaveBeenCalledTimes(1);
    expect(root.insert).not.toHaveBeenCalled();
    unpublishComposerHandle("thread:thr_root");
    unpublishComposerHandle("thread:thr_opus");
  });

  it("does not add a chat to its own composer", () => {
    window.history.pushState({}, "", "/threads/thr_open");
    const box = shell();
    const target = handle();
    publishComposerHandle("thread:thr_open", target as never);
    renderSlot({ component: ComposerThreadDrop }, {}, { context: { threadId: "thr_open" } });
    act(() => { drag(box, "drop", '{"id":"thr_open","title":"Me"}'); });
    expect(target.insert).not.toHaveBeenCalled();
  });

  it("leaves other drags and drops outside the chat box alone", () => {
    const box = shell();
    const target = handle();
    publishComposerHandle("new", target as never);
    renderSlot({ component: ComposerThreadDrop }, {}, {});
    expect(drag(box, "dragOver", null).dropEffect).toBe("none");
    document.body.insertAdjacentHTML("beforeend", `<aside id="elsewhere"></aside>`);
    act(() => { drag(document.getElementById("elsewhere")!, "drop"); });
    expect(target.insert).not.toHaveBeenCalled();
    expect(box.hasAttribute("data-nav-thread-drop")).toBe(false);
  });

  it("leaves a drop on the Context tab's own dashed box to that box, even when it sits inside the chat box", () => {
    const box = shell();
    box.insertAdjacentHTML("beforeend", `<div id="own" data-nav-thread-drop-target=""><span id="inner">Drag a sidebar thread here</span></div>`);
    const target = handle();
    publishComposerHandle("new", target as never);
    renderSlot({ component: ComposerThreadDrop }, {}, {});
    const inner = document.getElementById("inner")!;
    expect(drag(inner, "dragOver").dropEffect).toBe("none");
    expect(box.hasAttribute("data-nav-thread-drop")).toBe(false);
    act(() => { drag(inner, "drop"); });
    expect(target.insert).not.toHaveBeenCalled();
  });

  it("draws the mark as a dashed outline while mounted and removes its style afterwards", () => {
    shell();
    const view = renderSlot({ component: ComposerThreadDrop }, {}, {});
    const style = document.head.querySelector("[data-nav-thread-drop-style]");
    expect(style?.textContent).toContain("[data-nav-thread-drop]");
    expect(style?.textContent).toContain("dashed");
    view.unmount();
    expect(document.head.querySelector("[data-nav-thread-drop-style]")).toBeNull();
  });

  it("clears the mark when the drag leaves the box", () => {
    const box = shell();
    publishComposerHandle("new", handle() as never);
    renderSlot({ component: ComposerThreadDrop }, {}, {});
    drag(box, "dragOver");
    expect(box.hasAttribute("data-nav-thread-drop")).toBe(true);
    fireEvent.dragLeave(box, { relatedTarget: document.body });
    expect(box.hasAttribute("data-nav-thread-drop")).toBe(false);
  });
});

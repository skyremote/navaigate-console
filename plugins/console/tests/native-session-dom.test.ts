// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSessionWindow, mountSessionWindow } from "../src/native-session-dom";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function chat(parent: HTMLElement, name: string, primary = true) {
  const element = document.createElement("section");
  element.dataset.threadWindow = "";
  element.dataset.fixtureChat = name;
  if (primary) {
    const composer = document.createElement("div");
    composer.dataset.appComposerRole = "primary";
    element.append(composer);
  }
  parent.append(element);
  return element;
}

function pane(id: string) {
  const element = document.createElement("main");
  element.dataset.splitPaneId = id;
  document.body.append(element);
  return element;
}

describe("native conversation pane targeting", () => {
  it("covers only the primary chat in the exact SDK-identified split pane", () => {
    const other = chat(pane("pane-other"), "other");
    const wanted = chat(pane("pane-root"), "root");
    const layout = [{ paneId: "pane-other", threadId: "thr_other" }, { paneId: "pane-root", threadId: "thr_root" }];
    expect(findSessionWindow(document, "thr_root", layout)).toBe(wanted);
    expect(findSessionWindow(document, "thr_other", layout)).toBe(other);
    expect(other.style.visibility).toBe("");
  });

  it("ignores a nested conversation portal and a timeline without a primary composer", () => {
    const wanted = chat(pane("pane-root"), "root");
    chat(wanted, "earlier-timeline", false);
    const portal = document.createElement("div");
    portal.dataset.navNativeSession = "";
    wanted.parentElement!.append(portal);
    chat(portal, "embedded-active");
    expect(findSessionWindow(document, "thr_root", [{ paneId: "pane-root", threadId: "thr_root" }])).toBe(wanted);
  });

  it("fails safely when a nested ThreadChat also has a primary composer", () => {
    const outer = chat(pane("pane-root"), "root");
    const nested = chat(outer, "embedded-active");
    expect(findSessionWindow(document, "thr_root", [{ paneId: "pane-root", threadId: "thr_root" }])).toBeNull();
    expect(nested.style.visibility).toBe("");
    expect(outer.style.visibility).toBe("");
  });

  it("refuses missing, duplicated or ambiguous SDK-to-DOM mappings", () => {
    chat(pane("pane-a"), "root");
    chat(pane("pane-b"), "other");
    expect(findSessionWindow(document, "thr_root", null)).toBeNull();
    expect(findSessionWindow(document, "thr_root", [])).toBeNull();
    expect(findSessionWindow(document, "thr_root", [{ paneId: "missing", threadId: "thr_root" }])).toBeNull();
    expect(findSessionWindow(document, "thr_root", [{ paneId: "pane-a", threadId: "thr_root" }, { paneId: "pane-b", threadId: "thr_root" }])).toBeNull();
    pane("pane-a");
    expect(findSessionWindow(document, "thr_root", [{ paneId: "pane-a", threadId: "thr_root" }])).toBeNull();
  });

  it("does not guess between multiple primary windows on a non-split surface", () => {
    const original = chat(document.body, "root");
    expect(findSessionWindow(document, "thr_root", null)).toBe(original);
    chat(document.body, "unrelated");
    expect(findSessionWindow(document, "thr_root", null)).toBeNull();
  });
});

describe("native conversation overlay lifecycle", () => {
  it.each([
    { visibility: "", inert: false, aria: null, position: "static" },
    { visibility: "collapse", inert: true, aria: "false", position: "absolute" },
  ])("restores the original host state and releases listeners: %j", ({ visibility, inert, aria, position }) => {
    const parent = pane("root");
    const original = chat(parent, "root");
    parent.style.position = position;
    original.style.visibility = visibility;
    original.inert = inert;
    if (aria !== null) original.setAttribute("aria-hidden", aria);
    const originalRect = vi.spyOn(original, "getBoundingClientRect").mockReturnValue({ top: 30, left: 45, width: 300, height: 240 } as DOMRect);
    vi.spyOn(parent, "getBoundingClientRect").mockReturnValue({ top: 10, left: 15 } as DOMRect);
    parent.scrollTop = 7;
    parent.scrollLeft = 9;
    const observations: Element[] = [];
    const disconnect = vi.fn();
    const observe = vi.fn((element: Element) => { observations.push(element); });
    vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect = disconnect; });
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");

    const mounted = mountSessionWindow(original)!;
    expect(original.style.visibility).toBe("hidden");
    expect(original.inert).toBe(true);
    expect(original.getAttribute("aria-hidden")).toBe("true");
    expect(parent.style.position).toBe(position === "static" ? "relative" : position);
    expect(mounted.slot.style.top).toBe("27px");
    expect(mounted.slot.style.left).toBe("39px");
    expect(mounted.slot.style.width).toBe("300px");
    expect(mounted.slot.style.height).toBe("240px");
    expect(observations).toEqual([original, parent]);
    const resizeListener = addListener.mock.calls.find(([type]) => type === "resize")?.[1];
    expect(resizeListener).toBeTypeOf("function");
    expect(mountSessionWindow(original)).toBeNull();

    window.dispatchEvent(new Event("resize"));
    expect(originalRect).toHaveBeenCalledTimes(2);
    mounted.dispose();
    mounted.dispose();
    expect(original.style.visibility).toBe(visibility);
    expect(original.inert).toBe(inert);
    expect(original.getAttribute("aria-hidden")).toBe(aria);
    expect(parent.style.position).toBe(position);
    expect(document.querySelector("[data-nav-native-session]")).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith("resize", resizeListener);
    window.dispatchEvent(new Event("resize"));
    expect(originalRect).toHaveBeenCalledTimes(2);
  });

  it("declines a detached window without changing its accessibility or visibility", () => {
    const original = document.createElement("section");
    original.style.visibility = "visible";
    expect(mountSessionWindow(original)).toBeNull();
    expect(original.style.visibility).toBe("visible");
    expect(original.hasAttribute("aria-hidden")).toBe(false);
  });
});

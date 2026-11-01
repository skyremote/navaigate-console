import { useEffect, useRef } from "react";
import { experimental_useSidebarThreads as useSidebarThreads, useBbContext, useSidebarSplitLayout } from "@get-bb/plugin-sdk/app";
import { getComposerHandle } from "./composer-bridge";
import { droppedThreads } from "./context-workspace-model";

const DRAG_THREAD = "application/x-nav-thread";
const SHELL = "[data-promptbox-shell]";
const FALLBACK_SHELL = "[data-app-composer-role] form";
const OWN_TARGET = "[data-nav-thread-drop-target]";
const MARK = "data-nav-thread-drop";
export const DROP_STYLE = `[${MARK}] { outline: 2px dashed var(--ring, currentColor); outline-offset: 3px; border-radius: 14px; }`;

/**
 * Lets a chat dragged from the rail be dropped on the chat box to add it as a
 * context mention. The rail starts an ordinary browser drag, which bb's own
 * composer ignores, so this listens for that drag over the box and inserts the
 * mention through the composer's API.
 */
export function ComposerThreadDrop() {
  const { threadId: routeThreadId } = useBbContext();
  const layout = useSidebarSplitLayout();
  const { threads } = useSidebarThreads();
  const latest = useRef({ routeThreadId, layout, threads });
  latest.current = { routeThreadId: routeThreadId ?? null, layout, threads };

  useEffect(() => {
    const style = document.createElement("style");
    style.setAttribute("data-nav-thread-drop-style", "");
    style.textContent = DROP_STYLE;
    document.head.appendChild(style);
    let marked: Element | null = null;
    const unmark = () => { marked?.removeAttribute(MARK); marked = null; };
    const isThreadDrag = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes(DRAG_THREAD);
    const shellOf = (target: EventTarget | null) => (target instanceof Element && !target.closest(OWN_TARGET) ? target.closest(SHELL) ?? target.closest(FALLBACK_SHELL) : null);
    const ownerOf = (shell: Element): string | null | undefined => {
      const { routeThreadId: route, layout: split } = latest.current;
      const active = shell.closest<HTMLElement>("[data-native-active-thread]")?.dataset.nativeActiveThread;
      if (active) return active;
      const pane = shell.closest<HTMLElement>("[data-split-pane-id]");
      if (pane && split) return split.panes.find((item) => item.paneId === pane.dataset.splitPaneId)?.threadId ?? undefined;
      return window.location.pathname.includes("/threads/") ? route ?? undefined : null;
    };
    const handleFor = (shell: Element) => {
      const owner = ownerOf(shell);
      return owner === undefined ? null : { owner, handle: getComposerHandle(owner) };
    };
    const over = (event: DragEvent) => {
      if (!isThreadDrag(event)) return;
      const shell = shellOf(event.target);
      const found = shell ? handleFor(shell) : null;
      if (!shell || !found?.handle) { unmark(); return; }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (marked !== shell) { unmark(); shell.setAttribute(MARK, ""); marked = shell; }
    };
    const leave = (event: DragEvent) => {
      if (marked && !(event.relatedTarget instanceof Node && marked.contains(event.relatedTarget))) unmark();
    };
    const drop = (event: DragEvent) => {
      const shell = isThreadDrag(event) ? shellOf(event.target) : null;
      unmark();
      if (!shell) return;
      const found = handleFor(shell);
      if (!found?.handle) return;
      const titles = new Map(latest.current.threads.map((thread) => [thread.id, thread.displayTitle]));
      const mentions = droppedThreads(event.dataTransfer?.getData(DRAG_THREAD) ?? "", (id) => titles.get(id)).filter((mention) => mention.threadId !== found.owner);
      event.preventDefault();
      event.stopPropagation();
      if (mentions.length === 0) return;
      found.handle.api.insert(mentions, { at: "end", block: true });
      found.handle.api.focus();
    };
    const end = () => unmark();
    document.addEventListener("dragover", over, true);
    document.addEventListener("dragleave", leave, true);
    document.addEventListener("drop", drop, true);
    document.addEventListener("dragend", end, true);
    return () => {
      document.removeEventListener("dragover", over, true);
      document.removeEventListener("dragleave", leave, true);
      document.removeEventListener("drop", drop, true);
      document.removeEventListener("dragend", end, true);
      style.remove();
      unmark();
    };
  }, []);
  return null;
}

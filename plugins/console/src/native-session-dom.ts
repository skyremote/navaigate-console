export type SessionPane = { paneId: string; threadId: string | null };

/** Only the primary chat in the SDK-identified pane may be covered. */
export function findSessionWindow(document: Document, threadId: string, panes: readonly SessionPane[] | null): HTMLElement | null {
  let scope: ParentNode = document;
  if (panes) {
    const matching = panes.filter((pane) => pane.threadId === threadId);
    if (matching.length !== 1) return null;
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-split-pane-id]")).filter((element) => element.dataset.splitPaneId === matching[0].paneId);
    if (candidates.length !== 1) return null;
    scope = candidates[0];
  } else if (document.querySelectorAll("[data-split-pane-id]").length > 1) {
    return null;
  }
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>("[data-thread-window]")).filter((element) =>
    !element.closest("[data-nav-native-session]") && !!element.querySelector('[data-app-composer-role="primary"]'),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function mountSessionWindow(original: HTMLElement): { original: HTMLElement; slot: HTMLElement; dispose(): void } | null {
  const parent = original.parentElement;
  if (!parent || parent.querySelector(":scope > [data-nav-native-session]")) return null;
  const slot = original.ownerDocument.createElement("div");
  slot.dataset.navNativeSession = "";
  slot.dataset.bbPluginRoot = "";
  slot.dataset.bbPlugin = "navaigate-skin";
  slot.className = "absolute z-10 flex min-h-0 min-w-0 flex-col bg-background text-foreground";
  const position = parent.style.position;
  const visibility = original.style.visibility;
  const inert = original.inert;
  const ariaHidden = original.getAttribute("aria-hidden");
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  parent.appendChild(slot);
  const size = () => {
    const outer = parent.getBoundingClientRect();
    const rect = original.getBoundingClientRect();
    Object.assign(slot.style, {
      top: `${rect.top - outer.top + parent.scrollTop}px`, left: `${rect.left - outer.left + parent.scrollLeft}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
  };
  size();
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
  observer?.observe(original);
  observer?.observe(parent);
  window.addEventListener("resize", size);
  original.style.visibility = "hidden";
  original.inert = true;
  original.setAttribute("aria-hidden", "true");
  let disposed = false;
  return { original, slot, dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    window.removeEventListener("resize", size);
    original.style.visibility = visibility;
    original.inert = inert;
    if (ariaHidden === null) original.removeAttribute("aria-hidden"); else original.setAttribute("aria-hidden", ariaHidden);
    parent.style.position = position;
    slot.remove();
  } };
}

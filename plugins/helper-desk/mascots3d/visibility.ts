// One IntersectionObserver for every mascot on the page; it marks off-screen mascots with data-off so their
// animation pauses, and a hidden tab with data-hidden. No React state, no re-renders.
let observer: IntersectionObserver | null = null;
const watched = new Set<HTMLElement>();
const subscribers = new Map<Element, (visible: boolean) => void>();
let visHooked = false;

function setHidden() {
  const hidden = document.visibilityState === "hidden";
  for (const el of watched) el.toggleAttribute("data-hidden", hidden);
}

/** Marks `el` with data-off while it is off screen and data-hidden while the tab is hidden. `onChange` hears visibility changes. */
export function watch(el: HTMLElement, onChange?: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange?.(true);
    return () => undefined;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      (e.target as HTMLElement).toggleAttribute("data-off", !e.isIntersecting);
      subscribers.get(e.target)?.(e.isIntersecting);
    }
  });
  if (!visHooked) {
    document.addEventListener("visibilitychange", setHidden);
    visHooked = true;
  }
  watched.add(el);
  if (onChange) subscribers.set(el, onChange);
  observer.observe(el);
  return () => {
    observer?.unobserve(el);
    watched.delete(el);
    subscribers.delete(el);
  };
}

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

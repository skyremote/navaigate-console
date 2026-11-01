// The Md button's on/off switch for live preview. Everything the preview does is gated by the
// data-nm-md-live attribute on <html> in app.css, so flipping it never touches a draft.
const STORAGE_KEY = "nm-md-live";
export const LIVE_ATTRIBUTE = "data-nm-md-live";

type LiveStorage = Pick<Storage, "getItem" | "setItem">;
type LiveRoot = Pick<HTMLElement, "setAttribute" | "getAttribute">;

export function readLive(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function createLiveState(storage: LiveStorage | undefined, root: LiveRoot | undefined) {
  let on = readLive(storage);
  const listeners = new Set<() => void>();
  const apply = () => root?.setAttribute(LIVE_ATTRIBUTE, on ? "on" : "off");
  apply();
  return {
    get: () => on,
    set(next: boolean) {
      if (next === on) return;
      on = next;
      try {
        storage?.setItem(STORAGE_KEY, on ? "on" : "off");
      } catch {
        // Storage can be unavailable; the switch still works for this session.
      }
      apply();
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export const liveState = createLiveState(
  typeof localStorage === "undefined" ? undefined : localStorage,
  typeof document === "undefined" ? undefined : document.documentElement,
);

import { describe, expect, it, vi } from "vitest";
import { LIVE_ATTRIBUTE, createLiveState, readLive } from "./live-state";

function memory(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [["nm-md-live", initial]]);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

function root() {
  const attributes = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  };
}

describe("live preview switch", () => {
  it("is on by default and marks the page", () => {
    const html = root();
    const state = createLiveState(memory(), html);
    expect(state.get()).toBe(true);
    expect(html.getAttribute(LIVE_ATTRIBUTE)).toBe("on");
  });

  it("turns off, remembers it and tells subscribers", () => {
    const html = root();
    const storage = memory();
    const state = createLiveState(storage, html);
    const listener = vi.fn();
    state.subscribe(listener);
    state.set(false);
    expect(html.getAttribute(LIVE_ATTRIBUTE)).toBe("off");
    expect(storage.getItem("nm-md-live")).toBe("off");
    expect(listener).toHaveBeenCalledTimes(1);
    state.set(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createLiveState(storage, root()).get()).toBe(false);
  });

  it("starts on when storage fails", () => {
    expect(
      readLive({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(true);
  });
});

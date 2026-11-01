// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { sharedGl } from "../mascots3d/gl";

describe("the shared WebGL context", () => {
  it("is one object for everything, and makes no context until a mascot asks", () => {
    const get = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    expect(sharedGl()).toBe(sharedGl());
    expect(get).not.toHaveBeenCalled();
    expect(sharedGl().contexts).toBe(0);
    expect(sharedGl().available()).toBe(false);
    expect(sharedGl().draw("glass", { phase: 0, energy: 1, glow: 0, sat: 1, settle: 1 }, [1, 0, 0], 64)).toBe(false);
    get.mockRestore();
  });
});

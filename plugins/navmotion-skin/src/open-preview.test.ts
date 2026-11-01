import { describe, expect, it, vi } from "vitest";
import { openPreviewTab } from "./open-preview";

const tab = { id: "md-preview", context: { kind: "thread" }, availability: "action" };

describe("openPreviewTab", () => {
  it("opens the Preview tab with openTab where bb has it", () => {
    const openTab = vi.fn(() => true);
    expect(openPreviewTab({ openTab }, "md-preview")).toBe(true);
    expect(openTab).toHaveBeenCalledWith({ tab, title: "Preview" });
  });

  it("falls back to experimental_openTab on the current surface", () => {
    const experimental_openTab = vi.fn(() => true);
    expect(openPreviewTab({ experimental_openTab }, "md-preview")).toBe(true);
    expect(experimental_openTab).toHaveBeenCalledWith({ surface: { kind: "current" }, tab, title: "Preview" });
  });

  it("reports false when bb offers neither or declines", () => {
    expect(openPreviewTab({}, "md-preview")).toBe(false);
    expect(openPreviewTab({ openTab: () => false }, "md-preview")).toBe(false);
  });
});

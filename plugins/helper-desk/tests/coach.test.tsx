// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCoachState } from "../coachstate";

type Mode = "working" | "waiting" | "needs" | "still";

afterEach(() => vi.useRealTimers());

describe("the coach's mood follows the lead", () => {
  it("shows the badge when the chat needs you, live or still", () => {
    expect(renderHook(() => useCoachState("needs", true)).result.current).toBe("notify");
    expect(renderHook(() => useCoachState("needs", false)).result.current).toBe("notify");
  });

  it("still faces are the plain face, never the three dots", () => {
    expect(renderHook(() => useCoachState("working", false)).result.current).toBe("idle");
    expect(renderHook(() => useCoachState("still", false)).result.current).toBe("idle");
  });

  it("while working, alternates thinking with looking round as himself", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoachState("working", true));
    expect(result.current).toBe("thinking");
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current).toBe("idle");
    act(() => void vi.advanceTimersByTime(4500));
    expect(result.current).toBe("thinking");
  });

  it("winks when a turn finishes, then settles to idle", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ mode }: { mode: Mode }) => useCoachState(mode, true), { initialProps: { mode: "working" as Mode } });
    rerender({ mode: "waiting" });
    expect(result.current).toBe("wink");
    act(() => void vi.advanceTimersByTime(1600));
    expect(result.current).toBe("idle");
  });
});

// @vitest-environment jsdom
import React from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { AllowanceChip, allowanceSummary } from "../src/allowance";
import { resetRpcFlight } from "../src/rpc-flight";

afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
const HOUR = 3_600_000;
const soon = () => new Date(Date.now() + 2 * HOUR).toISOString();
const later = () => new Date(Date.now() + 30 * HOUR).toISOString();
const windows = () => [
  { label: "Session", kind: "five-hour", usedPercent: 34, resetsAt: soon() },
  { label: "Weekly", kind: "weekly", usedPercent: 71, resetsAt: later() },
  { label: "Weekly Sonnet", kind: "weekly", model: "sonnet", usedPercent: 12, resetsAt: later() },
];

describe("allowance summary", () => {
  it("states what is left and when it resets, session first, then the fullest other window", () => {
    const lines = allowanceSummary([
      { label: "Week", pct: 71, resetsAt: later() }, { label: "Session", pct: 34, resetsAt: soon() }, { label: "Week · Sonnet", pct: 12, resetsAt: later() },
    ]);
    expect(lines.map((line) => line.label)).toEqual(["Session", "Week"]);
    expect(lines[0]).toMatchObject({ left: 66, tone: "ok" });
    expect(lines[0].reset).toMatch(/^resets \d\d:\d\d$/);
    expect(lines[1]).toMatchObject({ left: 29, tone: "warn" });
  });
  it("marks a nearly spent window and clamps odd percentages", () => {
    const lines = allowanceSummary([{ label: "Session", pct: 96, resetsAt: null }, { label: "Week", pct: 140, resetsAt: null }]);
    expect(lines[0]).toMatchObject({ left: 4, tone: "danger", reset: "" });
    expect(lines[1]).toMatchObject({ left: 0, tone: "danger" });
  });
});

describe("allowance chip before a job starts", () => {
  it("shows the pooled account's remaining allowance and reset for the chosen provider", async () => {
    renderSlot({ component: () => <AllowanceChip providerId="claude-code" /> }, {}, {
      rpc: { pool_account: () => ({ accountId: "acc_1", activeAccountId: "acc_1" }) } as never,
      sdk: { plugins: { callRpc: async () => ({ usage: { status: "ok", accountEmail: "me@example.test", planLabel: "Max", windows: windows() } }) as never } },
    });
    const chip = await screen.findByTestId("allowance-chip");
    expect(chip.textContent).toContain("Claude Max");
    expect(chip.textContent).toContain("Session 66% left");
    expect(chip.textContent).toContain("Week 29% left");
    expect(chip.textContent).toMatch(/resets \d\d:\d\d/);
  });
  it("falls back to the provider's own login when no pooled account answers", async () => {
    const usageLimits = vi.fn(async () => ({ codex: { status: "ok", planLabel: "Pro", accountEmail: null, windows: [{ label: "Session", kind: "five-hour", usedPercent: 10, resetsAt: soon() }] } }) as never);
    renderSlot({ component: () => <AllowanceChip providerId="codex" /> }, {}, {
      rpc: { pool_account: () => ({ accountId: null, activeAccountId: null }) } as never,
      sdk: { plugins: { callRpc: async () => { throw new Error("no pool"); } }, system: { usageLimits } },
    });
    await waitFor(() => expect(screen.getByTestId("allowance-chip").textContent).toContain("Session 90% left"));
    expect(usageLimits).toHaveBeenCalledWith({ providerId: "codex" });
  });
  it("says nothing is known instead of inventing a figure", async () => {
    renderSlot({ component: () => <AllowanceChip providerId="cursor" /> }, {}, { sdk: { system: { usageLimits: async () => ({ cursor: { status: "error" } }) as never } } });
    await waitFor(() => expect(screen.getByTestId("allowance-chip").textContent).toContain("Allowance not reported"));
  });
  it("renders nothing without a provider", () => {
    renderSlot({ component: () => <AllowanceChip providerId={null} /> }, {}, {});
    expect(screen.queryByTestId("allowance-chip")).toBeNull();
  });
});

import { providerFromPicker, ComposerChips } from "../src/composer-chips";

describe("allowance chip on the new-chat composer", () => {
  it("reads the provider from the model picker text", () => {
    expect(providerFromPicker("Opus 4.5 Max")).toBe("claude-code");
    expect(providerFromPicker("GPT-5 Codex High")).toBe("codex");
    expect(providerFromPicker("Auto")).toBeNull();
  });
  it("mounts under the new-chat box before any chat exists", async () => {
    document.body.innerHTML = `<div data-app-composer-role="primary"><form>Opus 4.5 Max</form></div><div data-new-thread-footer><div class="left"></div></div>`;
    Object.defineProperty(document.querySelector("form")!, "innerText", { value: "Opus 4.5 Max" });
    renderSlot({ component: ComposerChips }, {}, {
      rpc: {
        m1_machine: () => ({ hostId: null, connected: false, sourcePath: null, suggestedPath: null, localHostId: null, localPath: null }),
        pool_list: () => ({ accounts: [] }), pool_account: () => ({ accountId: "acc_1", activeAccountId: "acc_1" }),
      } as never,
      sdk: { plugins: { callRpc: async () => ({ usage: { status: "ok", planLabel: "Max", windows: [{ label: "Session", kind: "five-hour", usedPercent: 40, resetsAt: soon() }] } }) as never } },
    });
    const chip = await screen.findByTestId("allowance-chip");
    expect(chip.closest("[data-nav-composer-chips]")).not.toBeNull();
    expect(chip.textContent).toContain("Session 60% left");
  });
});

describe("allowance chip after a provider switch", () => {
  it("keeps the new provider's allowance when the old provider's read answers late", async () => {
    let releaseClaude: () => void = () => undefined;
    const poolAccount = vi.fn(({ provider }: { provider: string }) =>
      provider === "claude"
        ? new Promise((resolve) => { releaseClaude = () => resolve({ accountId: null, activeAccountId: null }); })
        : { accountId: null, activeAccountId: null });
    const usageLimits = vi.fn(async ({ providerId }: { providerId: string }) => ({
      [providerId]: { status: "ok", planLabel: "Pro", windows: [{ label: "Session", kind: "five-hour", usedPercent: providerId === "codex" ? 10 : 50, resetsAt: soon() }] },
    }) as never);
    let choose: (providerId: string) => void = () => undefined;
    function Switcher() {
      const [providerId, setProviderId] = React.useState("claude-code");
      choose = setProviderId;
      return <AllowanceChip providerId={providerId} />;
    }
    renderSlot({ component: Switcher }, {}, { rpc: { pool_account: poolAccount } as never, sdk: { system: { usageLimits } } });
    await waitFor(() => expect(poolAccount).toHaveBeenCalledTimes(1));
    act(() => choose("codex"));
    await waitFor(() => expect(screen.getByTestId("allowance-chip").textContent).toContain("Session 90% left"));
    await act(async () => { releaseClaude(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByTestId("allowance-chip").textContent).toContain("Session 90% left");
  });
});

describe("allowance reads go through the shared poll helpers", () => {
  const visibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => { vi.useRealTimers(); Reflect.deleteProperty(document, "visibilityState"); });

  const mountChips = (count: number) => {
    const poolAccount = vi.fn(() => ({ accountId: "acc_1", activeAccountId: "acc_1" }));
    const callRpc = vi.fn(async () => ({ usage: { status: "ok", planLabel: "Max", windows: windows() } }) as never);
    renderSlot({ component: () => <>{Array.from({ length: count }, (_, index) => <AllowanceChip key={index} providerId="claude-code" />)}</> }, {}, {
      rpc: { pool_account: poolAccount } as never,
      sdk: { plugins: { callRpc } },
    });
    return { poolAccount, callRpc };
  };

  it("shares one read between every chip showing the same provider", async () => {
    const { poolAccount, callRpc } = mountChips(3);
    await waitFor(() => expect(screen.getAllByTestId("allowance-chip")[0].textContent).toContain("Session 66% left"));
    expect(poolAccount).toHaveBeenCalledTimes(1);
    expect(callRpc).toHaveBeenCalledTimes(1);
  });

  it("does not read while the window is hidden and reads once when it comes back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const { poolAccount } = mountChips(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(poolAccount).toHaveBeenCalledTimes(1);
    visibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(poolAccount).toHaveBeenCalledTimes(1);
    visibility("visible");
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(poolAccount).toHaveBeenCalledTimes(2);
  });

  it("polls again each minute while shown, without overlapping a read that is still running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    resetRpcFlight({ minGapMs: 0, hangMs: 600_000 });
    let release: () => void = () => undefined;
    const poolAccount = vi.fn(() => new Promise((resolve) => { release = () => resolve({ accountId: "acc_1", activeAccountId: "acc_1" }); }));
    renderSlot({ component: () => <AllowanceChip providerId="claude-code" /> }, {}, {
      rpc: { pool_account: poolAccount } as never,
      sdk: { plugins: { callRpc: async () => ({ usage: { status: "ok", planLabel: "Max", windows: windows() } }) as never } },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(poolAccount).toHaveBeenCalledTimes(1);
    release();
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(poolAccount.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { AccountTabs, Panel, tabLabel, UsageHover } from "../src/usage-card";
import { findUsageFooter, UsageDock } from "../src/usage-dock";
import { TooltipProvider } from "../components/ui/tooltip";
import type { Trend, TrendAccount, TrendWindow } from "../server-usage-trend";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
beforeEach(() => { window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never; });
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
function usageWindow(overrides: Partial<TrendWindow> = {}): TrendWindow {
  return { id: "session", label: "Session", span: "session", model: null, pct: 34, startsAt: NOW - 2 * HOUR, resetsAt: NOW + 3 * HOUR, idle: false, series: [[NOW - HOUR, 23], [NOW, 34]], rate: 11, rateBasis: "recent", samples: 3, forecastAtReset: 67, hits90At: NOW + 6 * HOUR, hits100At: NOW + 7 * HOUR, burn: 11, ...overrides };
}
function account(overrides: Partial<TrendAccount> = {}): TrendAccount {
  return { id: "local-pool", harness: "codex", email: "fixture@example.test", plan: "Pro", status: "ok", observedAt: NOW, windows: [usageWindow(), usageWindow({ id: "week", label: "Week", span: "long", startsAt: NOW - 3 * 24 * HOUR, resetsAt: NOW + 4 * 24 * HOUR })], burn: 11, busiest: { mode: "tokens", since: NOW - 2 * HOUR, sinceLabel: "since 09:00", rows: [{ threadId: "thr_busy", title: "Existing busiest chat", share: 1, tokens: 400, turns: 2 }] }, ...overrides };
}
const remote = () => account({ id: "fleet-usage:codex:owner:m1", email: null, source: { kind: "owner", provider: "codex", label: "Codex · Studio", machines: ["studio"], hostId: "host_m1", ownerServerId: "owner_m1", identity: "unknown", freshness: "fresh" }, busiest: { mode: "none", since: NOW, sinceLabel: "in the last 5 hours", rows: [] } });
function trend(): Trend { return { now: NOW, sampledFrom: NOW - HOUR, accounts: [account(), remote()], sources: [{ machine: "studio", ownerServerId: "owner_m1", hostId: "host_m1", state: "fresh", providers: { codex: "fresh" } }, { machine: "work", ownerServerId: null, hostId: null, state: "unavailable" }] }; }
function footer(parent: HTMLElement = document.body, role: "primary" | "secondary" = "primary") {
  const thread = document.createElement("div"); thread.dataset.threadWindow = "";
  thread.innerHTML = `<div data-app-composer-role="${role}"><div data-follow-up-composer-footer><button aria-label="Context window test">ring</button></div></div>`;
  parent.appendChild(thread);
  return { thread, footer: thread.querySelector<HTMLElement>("[data-follow-up-composer-footer]")!, ring: thread.querySelector<HTMLElement>("button")! };
}
const binding = { routeThreadId: "thr_root", activeThreadId: "thr_child", rootThreadId: "thr_root", known: true, panes: null };

describe("existing usage graph presentation", () => {
  it("opens by a click or tap and closes on a second click without requiring hover or a keyboard", async () => {
    renderSlot({ component: () => <UsageHover thisAccount="local-pool"><span>Usage line</span></UsageHover> }, {}, { rpc: { usage_trend: () => trend() } });
    const trigger = screen.getByRole("button", { name: "Usage details. Press Enter for the usage card." });
    const click = () => { fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 }); fireEvent.pointerUp(trigger, { pointerType: "mouse", button: 0 }); fireEvent.click(trigger); };
    click();
    await screen.findByRole("tab", { name: /ChatGPT/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await new Promise((resolve) => setTimeout(resolve, 0));
    click();
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
    click();
    await screen.findByRole("tab", { name: /ChatGPT/ });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  });
  it("keeps charts, forecast, reset windows, burn and busiest chats in the existing panel with quiet owner context", () => {
    renderSlot({ component: () => <TooltipProvider><Panel a={remote()} now={NOW} isThisChat={false} sampledFrom={NOW - HOUR} /></TooltipProvider> }, {}, {});
    expect(screen.getByText("Codex · Studio")).toBeTruthy();
    expect(screen.getByText("Burn rate")).toBeTruthy(); expect(screen.getByText("Time to limit")).toBeTruthy();
    expect(screen.getByText("This session")).toBeTruthy(); expect(screen.getByText("This week")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByText(/Studio owner usage/).textContent).toContain("separate owner account");
    expect(screen.queryByText("This chat")).toBeNull();
    expect(document.body.textContent).not.toMatch(/RPC|ssh|credential|broker|database/i);
  });
  it("retains local busiest chat navigation and labels only the actual pinned account This chat", () => {
    const view = renderSlot({ component: () => <TooltipProvider><Panel a={account()} now={NOW} isThisChat sampledFrom={NOW - HOUR} /></TooltipProvider> }, {}, {});
    fireEvent.click(screen.getByRole("button", { name: /Existing busiest chat/ }));
    expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_busy" }]);
    expect(screen.getByText("This chat")).toBeTruthy();
  });
  it("keeps attributed tabs reachable on compact widths without an extra banner", () => {
    const value = trend();
    renderSlot({ component: () => <TooltipProvider><AccountTabs trend={value} active={value.accounts[1].id} setActive={() => {}} thisChat={null} /></TooltipProvider> }, {}, {});
    const tabs = screen.getByRole("tablist");
    expect(tabs.className).toContain("overflow-x-auto"); expect(tabs.className).toContain("max-w-full");
    expect(screen.getByRole("tab", { name: "Codex · Studio" }).className).toContain("shrink-0");
    expect(screen.getByRole("tab", { name: /ChatGPT/ })).toBeTruthy();
    expect(screen.getByText("Studio current · Work unavailable")).toBeTruthy();
    expect(tabLabel(value.accounts[1], value.accounts)).toBe("Codex · Studio");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("shows retained history with plain source status instead of stale burn or forecasts", () => {
    const a = remote(); a.source!.freshness = "unavailable"; a.status = "error"; a.burn = null;
    a.windows = a.windows.map((window) => ({ ...window, rate: null, burn: null, forecastAtReset: null, hits90At: null, hits100At: null }));
    renderSlot({ component: () => <TooltipProvider><Panel a={a} now={NOW} isThisChat={false} sampledFrom={NOW - HOUR} /></TooltipProvider> }, {}, {});
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getByText(/owner unavailable; history kept/)).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("11% an hour");
  });
});

describe("visible physical composer usage placement", () => {
  it.each([
    { label: "a saved mirror selection", providerId: "fleet-mirror", environmentId: "env_root" },
    { label: "a different worktree", providerId: "claude-code", environmentId: "env_other" },
    { label: "an unprovisioned environment", providerId: "claude-code", environmentId: null },
  ])("keeps root usage visible for $label when the conversation does not overlay that member", async ({ providerId, environmentId }) => {
    const root = footer(); const calls: string[] = [];
    renderSlot({ component: UsageDock }, {}, { context: { threadId: "thr_root" }, rpc: {
      native_session_state: () => ({ rootThreadId: "thr_root", activeThreadId: "thr_child", members: [
        { id: "thr_root", providerId: "codex", status: "active", environmentId: "env_root" },
        { id: "thr_child", providerId, status: "idle", environmentId },
      ] }),
      pool_account: () => ({ accountId: null, activeAccountId: null }),
    }, sdk: { threads: { context: async ({ threadId }) => { calls.push(threadId); return { usage: null } as never; } }, system: { usageLimits: async () => ({}) } } });
    await waitFor(() => expect(root.footer.nextElementSibling?.getAttribute("data-nav-usage-thread")).toBe("thr_root"));
    await waitFor(() => expect(calls).toContain("thr_root"));
    expect(calls).not.toContain("thr_child");
  });
  it("uses a directly opened member's own context when a different model was selected elsewhere", async () => {
    const current = footer(); const calls: string[] = [];
    renderSlot({ component: UsageDock }, {}, { context: { threadId: "thr_child" }, rpc: {
      native_session_state: () => ({ rootThreadId: "thr_root", activeThreadId: "thr_root", members: [
        { id: "thr_root", providerId: "codex", status: "active", environmentId: "env_root" },
        { id: "thr_child", providerId: "claude-code", status: "idle", environmentId: "env_root" },
      ] }),
      pool_account: () => ({ accountId: null, activeAccountId: null }),
    }, sdk: { threads: { context: async ({ threadId }) => { calls.push(threadId); return { usage: null } as never; } }, system: { usageLimits: async () => ({}) } } });
    await waitFor(() => expect(current.footer.nextElementSibling?.getAttribute("data-nav-usage-thread")).toBe("thr_child"));
    await waitFor(() => expect(calls).toContain("thr_child"));
    expect(calls).not.toContain("thr_root");
  });
  it("chooses the visible session overlay footer and skips its hidden logical root", () => {
    const root = footer(); root.thread.style.visibility = "hidden"; root.thread.setAttribute("aria-hidden", "true");
    const overlay = document.createElement("div"); overlay.dataset.navNativeSession = "";
    const conversation = document.createElement("div"); conversation.dataset.nativeConversationRoot = "thr_root"; overlay.appendChild(conversation); document.body.appendChild(overlay);
    const active = footer(conversation, "secondary");
    expect(findUsageFooter(document, binding)).toBe(active.footer);
    expect(findUsageFooter(document, { ...binding, known: false })).toBeNull();
    expect(root.ring.style.display).toBe("");
  });
  it("binds to the overlay's embedded composer, which bb always marks secondary, and only inside the plugin's own overlay", () => {
    // Live bb 0.48: the page composer is role="primary" but hidden under the
    // overlay; the overlay's ThreadChat composer is role="secondary".
    const root = footer(); root.thread.style.visibility = "hidden"; root.thread.inert = true; root.thread.setAttribute("aria-hidden", "true");
    const overlay = document.createElement("div"); overlay.dataset.navNativeSession = ""; overlay.innerHTML = '<div data-native-conversation-root="thr_root"></div>'; document.body.appendChild(overlay);
    const active = footer(overlay.firstElementChild as HTMLElement, "secondary");
    expect(findUsageFooter(document, binding)).toBe(active.footer);
    expect(findUsageFooter(document, { ...binding, rootThreadId: "thr_other_root" })).toBeNull();
    // A conversation root that is not inside the plugin's overlay is not ours.
    delete overlay.dataset.navNativeSession;
    expect(findUsageFooter(document, binding)).toBeNull();
  });
  it("does not choose another split pane or a secondary composer", () => {
    const first = document.createElement("div"); first.dataset.splitPaneId = "pane-root"; document.body.appendChild(first);
    const second = document.createElement("div"); second.dataset.splitPaneId = "pane-other"; document.body.appendChild(second);
    const a = footer(first); const b = footer(second);
    const panes = [{ paneId: "pane-root", threadId: "thr_root" }, { paneId: "pane-other", threadId: "thr_other" }];
    expect(findUsageFooter(document, { ...binding, activeThreadId: "thr_root", panes })).toBe(a.footer);
    expect(findUsageFooter(document, { ...binding, routeThreadId: "thr_other", activeThreadId: "thr_other", panes })).toBe(b.footer);
    expect(findUsageFooter(document, { ...binding, activeThreadId: "thr_root", panes: null })).toBeNull();
    a.thread.querySelector<HTMLElement>("[data-app-composer-role]")!.dataset.appComposerRole = "secondary";
    expect(findUsageFooter(document, { ...binding, activeThreadId: "thr_root", panes })).toBeNull();
  });
  it("queries the active physical model context and pinned account while the route remains the logical root", async () => {
    const root = footer(); root.thread.style.visibility = "hidden"; root.thread.setAttribute("aria-hidden", "true");
    const overlay = document.createElement("div"); overlay.dataset.navNativeSession = ""; overlay.innerHTML = '<div data-native-conversation-root="thr_root"></div>'; document.body.appendChild(overlay);
    const active = footer(overlay.firstElementChild as HTMLElement, "secondary");
    const contextCalls: string[] = []; const poolCalls: unknown[] = [];
    renderSlot({ component: UsageDock }, {}, { context: { threadId: "thr_root" }, rpc: {
      native_session_state: () => ({ rootThreadId: "thr_root", activeThreadId: "thr_child", members: [{ id: "thr_root", providerId: "codex", status: "idle", environmentId: "env_root" }, { id: "thr_child", providerId: "claude-code", status: "idle", environmentId: "env_root" }] }),
      pool_account: (input) => { poolCalls.push(input); return { accountId: "pinned-child-account", activeAccountId: "local-default-must-not-win" }; },
    }, sdk: { threads: { context: async ({ threadId }) => { contextCalls.push(threadId); return { usage: { usedTokens: 500, modelContextWindow: 10000, snapshot: { providerSessionId: "native-child-session" } } } as never; } }, plugins: { callRpc: async () => ({ usage: { status: "ok", accountEmail: "child@example.test", planLabel: "Max", windows: [{ label: "Session", kind: "five-hour", usedPercent: 21, resetsAt: new Date(NOW + HOUR).toISOString() }] } }) as never } } });
    await waitFor(() => expect(active.footer.nextElementSibling?.hasAttribute("data-nav-usage-dock")).toBe(true));
    await waitFor(() => expect(contextCalls).toContain("thr_child"));
    expect(contextCalls).not.toContain("thr_root");
    await waitFor(() => expect(poolCalls).toContainEqual({ provider: "claude", sessionId: "native-child-session" }));
    expect(root.ring.style.display).toBe(""); expect(active.ring.style.display).toBe("none");
  });
  it("keeps the active physical model through a transient session read failure instead of falling back to the root", async () => {
    const root = footer(); root.thread.style.visibility = "hidden"; root.thread.setAttribute("aria-hidden", "true");
    const overlay = document.createElement("div"); overlay.dataset.navNativeSession = ""; overlay.innerHTML = '<div data-native-conversation-root="thr_root"></div>'; document.body.appendChild(overlay);
    const active = footer(overlay.firstElementChild as HTMLElement, "secondary");
    let failing = false;
    const view = renderSlot({ component: UsageDock }, {}, { context: { threadId: "thr_root" }, rpc: {
      native_session_state: () => {
        if (failing) throw Object.assign(new Error("Failed to fetch"), { code: "transport_error" });
        return { rootThreadId: "thr_root", activeThreadId: "thr_child", members: [{ id: "thr_root", providerId: "codex", status: "idle", environmentId: "env_root" }, { id: "thr_child", providerId: "claude-code", status: "idle", environmentId: "env_root" }] };
      },
      pool_account: () => ({ accountId: null, activeAccountId: null }),
    }, sdk: { threads: { context: async () => ({ usage: null }) as never }, plugins: { callRpc: async () => ({}) as never } } });
    await waitFor(() => expect(active.footer.nextElementSibling?.hasAttribute("data-nav-usage-dock")).toBe(true));
    failing = true;
    await view.behavior.emitRealtime("native-sessions", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(active.footer.nextElementSibling?.hasAttribute("data-nav-usage-dock")).toBe(true);
    expect(root.ring.style.display).toBe(""); expect(active.ring.style.display).toBe("none");
  });
  it("does not read local quota or claim a local This chat account for a Fleet mirror", async () => {
    footer(); const quota = vi.fn(async () => ({})); const pool = vi.fn(() => ({ accountId: "wrong-local", activeAccountId: "wrong-local" }));
    renderSlot({ component: UsageDock }, {}, { context: { threadId: "thr_mirror" }, rpc: { native_session_state: () => ({ rootThreadId: "thr_mirror", activeThreadId: "thr_mirror", members: [{ id: "thr_mirror", providerId: "fleet-mirror", status: "idle" }] }), pool_account: pool, usage_trend: () => trend() }, sdk: { threads: { context: async () => ({ usage: null }) as never }, system: { usageLimits: quota } } });
    await waitFor(() => expect(document.querySelector('[data-nav-usage-binding="native"]')).not.toBeNull());
    expect(document.querySelectorAll("[data-nav-usage-dock]")).toHaveLength(1);
    expect(quota).not.toHaveBeenCalled(); expect(pool).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Usage details. Press Enter for the usage card." }), { key: "Enter" });
    await screen.findByRole("tab", { name: "Codex · Studio" });
    expect(screen.queryByText("This chat")).toBeNull();
  });
});


describe("focused split usage owner", () => {
  it("keeps the visible root composer bound to its physical thread when the logical active member is already in another pane", async () => {
    const rootPane = document.createElement("div"); rootPane.dataset.splitPaneId = "pane-root"; document.body.appendChild(rootPane);
    const childPane = document.createElement("div"); childPane.dataset.splitPaneId = "pane-child"; document.body.appendChild(childPane);
    const root = footer(rootPane); const child = footer(childPane); const calls: string[] = [];
    renderSlot({ component: UsageDock }, {}, { context: { threadId: "thr_root" }, sidebarSplitLayout: { panes: [
      { paneId: "pane-root", threadId: "thr_root", isFocused: true, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { paneId: "pane-child", threadId: "thr_child", isFocused: false, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    ] }, rpc: { native_session_state: () => ({ rootThreadId: "thr_root", activeThreadId: "thr_child", members: [{ id: "thr_root", providerId: "codex", status: "idle", environmentId: "env_root" }, { id: "thr_child", providerId: "claude-code", status: "idle", environmentId: "env_root" }] }), pool_account: () => ({ accountId: null, activeAccountId: null }) }, sdk: { threads: { context: async ({ threadId }) => { calls.push(threadId); return { usage: null } as never; } }, system: { usageLimits: async () => ({}) } } });
    await waitFor(() => expect(root.footer.nextElementSibling?.hasAttribute("data-nav-usage-dock")).toBe(true));
    await waitFor(() => expect(calls).toContain("thr_root"));
    expect(calls).not.toContain("thr_child"); expect(child.ring.style.display).toBe("");
    expect(child.footer.nextElementSibling).toBeNull();
  });
});

// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ComposerChips } from "../src/composer-chips";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(() => "t") } }));

const accounts = {
  claude: [
    { id: "c1", email: "sam@example.com", short: "dw", priority: 1, enabled: true, status: "ok", weekPct: 50, sessionPct: 30 },
    { id: "c2", email: "someone@gmail.com", short: "gmail", priority: 2, enabled: true, status: "ok", weekPct: 10, sessionPct: 2 },
  ],
  codex: [
    { id: "x1", email: "pat@example.com", short: "sam", priority: 1, enabled: true, status: "ok", weekPct: 90, sessionPct: 60 },
    { id: "x2", email: "ops@example.com", short: "ops", priority: 2, enabled: true, status: "ok", weekPct: 42, sessionPct: 7 },
  ],
};

function thread(providerId: string) {
  return { id: "t1", projectId: "p1", title: "Chat", displayTitle: "Chat", status: "idle", runtimeStatus: "idle", queuedWork: "none", activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", isHidden: false, host: null, createdAt: 1, updatedAt: 1, lastActivityAt: 1, href: "/projects/p1/threads/t1", providerId } as unknown as PluginSidebarThread;
}

function mountInChat(providerId: string, rpc: Record<string, unknown> = {}) {
  document.body.innerHTML = `<div data-follow-up-composer-footer><div class="left"></div></div>`;
  window.history.pushState({}, "", "/projects/p1/threads/t1");
  const poolList = vi.fn((input: { provider: "claude" | "codex" }) => ({ accounts: accounts[input.provider], error: null }));
  const poolAccount = vi.fn((input: { provider: string }) => ({ accountId: input.provider === "codex" ? "x2" : "c1", activeAccountId: input.provider === "codex" ? "x1" : "c1" }));
  const poolPutFirst = vi.fn((input: { provider: "claude" | "codex"; accountId: string }) => ({ accounts: [...accounts[input.provider]].sort((a) => (a.id === input.accountId ? -1 : 1)), error: null }));
  renderSlot({ component: ComposerChips }, {}, {
    rpc: { pool_list: poolList, pool_account: poolAccount, pool_put_first: poolPutFirst, teleport_link: () => ({ from: null, to: null, via: null, branch: null, at: null, onM1: false, sha: null, verified: null }), ...rpc } as never,
    sdk: { threads: { context: async () => ({ usage: { snapshot: { providerSessionId: "sess-1" } } }) as never } } as never,
    sidebarThreads: { status: "ready", threads: [thread(providerId)], projects: [], sections: [] },
    context: { threadId: "t1", projectId: "p1" },
  });
  return { poolList, poolAccount, poolPutFirst };
}

const chip = () => screen.getByTitle(/This chat runs on|has not been pinned|New .* chats start/);
const open = (el: HTMLElement) => { fireEvent.pointerDown(el, { button: 0, ctrlKey: false }); };

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

describe("the account chip under the chat box", () => {
  it("is there for a Codex chat, named for the Codex account it runs on, listing Codex accounts with week and session use", async () => {
    const { poolList, poolAccount } = mountInChat("codex");
    await waitFor(() => expect(chip().textContent).toBe("Codex · ops"));
    expect(poolList).toHaveBeenCalledWith({ provider: "codex" });
    expect(poolList).not.toHaveBeenCalledWith({ provider: "claude" });
    expect(poolAccount).toHaveBeenCalledWith({ provider: "codex", sessionId: "sess-1" });
    expect(chip().getAttribute("title")).toContain("ops@example.com");
    open(chip());
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toContain("Codex accounts");
    expect(menu.textContent).toContain("pat@example.com");
    expect(menu.textContent).toContain("90% week");
    expect(menu.textContent).toContain("7% session");
    expect(menu.textContent).not.toContain("sam@example.com");
  });

  it("puts a Codex account first through the Codex failover order only", async () => {
    const { poolPutFirst } = mountInChat("codex");
    await waitFor(() => expect(chip().textContent).toBe("Codex · ops"));
    open(chip());
    fireEvent.click(await screen.findByText("Put ops first"));
    await waitFor(() => expect(poolPutFirst).toHaveBeenCalledWith({ provider: "codex", accountId: "x2" }));
  });

  it("keeps the Claude chip for a Claude chat, on the Claude pool", async () => {
    const { poolList, poolPutFirst } = mountInChat("claude-code");
    await waitFor(() => expect(chip().textContent).toBe("Claude · dw"));
    expect(poolList).toHaveBeenCalledWith({ provider: "claude" });
    expect(poolList).not.toHaveBeenCalledWith({ provider: "codex" });
    open(chip());
    fireEvent.click(await screen.findByText("Put gmail first"));
    await waitFor(() => expect(poolPutFirst).toHaveBeenCalledWith({ provider: "claude", accountId: "c2" }));
  });

  it("is absent for harnesses with no pool", async () => {
    mountInChat("cursor");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.body.textContent).not.toMatch(/Codex ·|Claude ·/);
  });

  it("shows on the new-chat screen when a Codex model is picked, on the Codex pool", async () => {
    document.body.innerHTML = `<div data-app-composer-role="primary"><form>GPT-5.5 Codex</form></div><div data-new-thread-footer><div class="left"></div></div>`;
    Object.defineProperty(document.querySelector("form")!, "innerText", { value: "GPT-5.5 Codex" });
    window.history.pushState({}, "", "/");
    const poolList = vi.fn((input: { provider: "claude" | "codex" }) => ({ accounts: accounts[input.provider], error: null }));
    renderSlot({ component: ComposerChips }, {}, {
      rpc: { pool_list: poolList, pool_account: () => ({ accountId: null, activeAccountId: "x1" }), m1_machine: () => ({ hostId: null }) } as never,
      sdk: { plugins: { callRpc: async () => ({ usage: { status: "error" } }) as never } } as never,
    });
    await waitFor(() => expect(screen.getByTitle(/New Codex chats start on pat@example.com/)).toBeTruthy());
    expect(poolList).toHaveBeenCalledWith({ provider: "codex" });
  });
});

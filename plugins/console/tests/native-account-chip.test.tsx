// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ComposerChips } from "../src/composer-chips";
import { MODEL_NOW_SETTLE_MS, THREAD_MARK_WAIT_MS, forgetModelsNow, forgetSessionProfiles, forgetThreadMarks, localNow, rememberSessionProfile } from "../src/session-profile-marks";
import { publishComposerHandle, unpublishComposerHandle } from "../src/composer-bridge";

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

function thread(providerId: string, updatedAt = 1) {
  return { id: "t1", projectId: "p1", title: "Chat", displayTitle: "Chat", status: "idle", runtimeStatus: "idle", queuedWork: "none", activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", isHidden: false, host: null, createdAt: 1, updatedAt, lastActivityAt: 1, href: "/projects/p1/threads/t1", providerId } as unknown as PluginSidebarThread;
}

function mountInChat(providerId: string, rpc: Record<string, unknown> = {}, updatedAt = 1) {
  document.body.innerHTML = `<div data-follow-up-composer-footer><div class="left"></div></div>`;
  window.history.pushState({}, "", "/projects/p1/threads/t1");
  const poolList = vi.fn((input: { provider: "claude" | "codex" }) => ({ accounts: accounts[input.provider], error: null }));
  const poolAccount = vi.fn((input: { provider: string }) => ({ accountId: input.provider === "codex" ? "x2" : "c1", activeAccountId: input.provider === "codex" ? "x1" : "c1" }));
  const poolPutFirst = vi.fn((input: { provider: "claude" | "codex"; accountId: string }) => ({ accounts: [...accounts[input.provider]].sort((a) => (a.id === input.accountId ? -1 : 1)), error: null }));
  renderSlot({ component: ComposerChips }, {}, {
    rpc: { pool_list: poolList, pool_account: poolAccount, pool_put_first: poolPutFirst, teleport_link: () => ({ from: null, to: null, via: null, branch: null, at: null, onM1: false, sha: null, verified: null }), ...rpc } as never,
    sdk: { threads: { context: async () => ({ usage: { snapshot: { providerSessionId: "sess-1" } } }) as never } } as never,
    sidebarThreads: { status: "ready", threads: [thread(providerId, updatedAt)], projects: [], sections: [] },
    context: { threadId: "t1", projectId: "p1" },
  });
  return { poolList, poolAccount, poolPutFirst };
}

const chip = () => screen.getByTitle(/This chat runs on|has not been pinned|New .* chats start/);
const open = (el: HTMLElement) => { fireEvent.pointerDown(el, { button: 0, ctrlKey: false }); };

beforeEach(() => { document.body.innerHTML = ""; forgetThreadMarks(); forgetSessionProfiles(); forgetModelsNow(); });
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

describe("a Local chat under its box", () => {
  it("says what it runs on, and offers no online account", async () => {
    const { poolList } = mountInChat("claude-code", { session_profiles: () => ({ t1: { profile: "local", model: "ollama/qwen3.8-64k:27b", v: 1 } }) });
    const local = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-nav-part="local-chip"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(local.textContent).toBe("Local · qwen3.8-64k:27b · runs on this Mac");
    expect(local.getAttribute("title")).toContain("does not use a Claude or Codex account");
    expect(screen.queryByText(/^Claude · /)).toBeNull();
    expect(poolList).not.toHaveBeenCalled();
  });
  it("leaves an Online Claude chat exactly as before", async () => {
    mountInChat("claude-code", { session_profiles: () => ({}) });
    await waitFor(() => expect(chip().textContent).toBe("Claude · dw"));
    expect(document.querySelector('[data-nav-part="local-chip"]')).toBeNull();
  });
  it("does not claim a chat on an Ollama cloud model runs on this Mac", async () => {
    mountInChat("acp-opencode", { session_profiles: () => ({ t1: { profile: "local", model: "ollama/glm-4.6:cloud", v: 1 } }) });
    const local = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-nav-part="local-chip"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(local.textContent).toBe("Local · glm-4.6:cloud · runs on Ollama's cloud, not this Mac");
    expect(local.textContent).not.toContain("runs on this Mac");
  });
});

describe("a Local chat in opencode, whose model can be switched inside the chat", () => {
  const marked = { session_profiles: () => ({ t1: { profile: "local", model: "ollama/qwen-27b", v: 1 } }) };
  const localChip = () =>
    waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-nav-part="local-chip"]');
      expect(el).not.toBeNull();
      return el!;
    });
  afterEach(() => unpublishComposerHandle("thread:t1"));

  it("says it runs on this Mac while its current model is a local one", async () => {
    const threadExec = vi.fn(() => ({ t1: { model: "ollama/qwen-27b", reasoningLevel: "medium" } }));
    mountInChat("acp-opencode", { ...marked, thread_exec: threadExec });
    const el = await localChip();
    expect(el.textContent).toBe("Local · qwen-27b · runs on this Mac");
    expect(el.dataset.now).toBe("here");
    expect(threadExec).toHaveBeenCalledWith({ ids: ["t1"] });
  });

  it("the audit's case: once switched to a model that is not on this Mac, it says it started Local and names the model it runs on now", async () => {
    mountInChat("acp-opencode", { ...marked, thread_exec: () => ({ t1: { model: "openrouter/some-cloud-model", reasoningLevel: "medium" } }) });
    const el = await localChip();
    expect(el.textContent).toBe("Started Local · now on openrouter/some-cloud-model");
    expect(el.textContent).not.toContain("runs on this Mac");
    expect(el.getAttribute("title")).not.toContain("does not use a Claude or Codex account");
    expect(el.dataset.now).toBe("moved");
  });

  it("an Ollama cloud model counts as not on this Mac", async () => {
    mountInChat("acp-opencode", { ...marked, thread_exec: () => ({ t1: { model: "ollama/glm-4.6:cloud", reasoningLevel: "medium" } }) });
    expect((await localChip()).textContent).toBe("Started Local · now on glm-4.6:cloud");
  });

  it("drops the claim as soon as a model that is not on this Mac is picked for the next reply, before it is sent", async () => {
    publishComposerHandle("thread:t1", { api: {} as never, view: { draft: {} as never, selection: { model: "openrouter/some-cloud-model" } as never } });
    mountInChat("acp-opencode", { ...marked, thread_exec: () => ({ t1: { model: "ollama/qwen-27b", reasoningLevel: "medium" } }) });
    const el = await localChip();
    expect(el.textContent).toBe("Started Local · next reply on openrouter/some-cloud-model");
    expect(el.dataset.now).toBe("next");
  });

  it("claims nothing when its current model cannot be read", async () => {
    mountInChat("acp-opencode", { ...marked, thread_exec: () => { throw new Error("down"); } });
    const el = await localChip();
    expect(el.textContent).toBe("Local · qwen-27b · started on this Mac");
    expect(el.textContent).not.toContain("runs on this Mac");
  });

  it("asks once per change of the chat, never per render, and shows the last answer at once while it asks again", async () => {
    let model = "ollama/qwen-27b";
    const threadExec = vi.fn(() => ({ t1: { model, reasoningLevel: "medium" } }));
    mountInChat("acp-opencode", { ...marked, thread_exec: threadExec }, 1);
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-chip"]')?.textContent).toBe("Local · qwen-27b · runs on this Mac"));
    await new Promise((r) => setTimeout(r, MODEL_NOW_SETTLE_MS * 2));
    expect(threadExec).toHaveBeenCalledTimes(1);
    // The same chat, unchanged, opened again: no question.
    cleanup();
    mountInChat("acp-opencode", { ...marked, thread_exec: threadExec }, 1);
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-chip"]')).not.toBeNull());
    await new Promise((r) => setTimeout(r, MODEL_NOW_SETTLE_MS * 2));
    expect(threadExec).toHaveBeenCalledTimes(1);
    // The chat changed (a turn on another model): the last answer shows at once, then one question corrects it.
    model = "openrouter/some-cloud-model";
    cleanup();
    mountInChat("acp-opencode", { ...marked, thread_exec: threadExec }, 2);
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-chip"]')?.textContent).toBe("Local · qwen-27b · runs on this Mac"));
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-chip"]')?.textContent).toBe("Started Local · now on openrouter/some-cloud-model"));
    expect(threadExec).toHaveBeenCalledTimes(2);
  });

  it("is not asked for a Local chat on Claude Code (held to its model) or for an ordinary chat", async () => {
    const threadExec = vi.fn(() => ({}));
    mountInChat("claude-code", { session_profiles: () => ({ t1: { profile: "local", model: "ollama/qwen-27b", v: 1 } }), thread_exec: threadExec });
    expect((await localChip()).textContent).toBe("Local · qwen-27b · runs on this Mac");
    cleanup();
    forgetThreadMarks();
    mountInChat("acp-opencode", { session_profiles: () => ({}), thread_exec: threadExec });
    await new Promise((r) => setTimeout(r, MODEL_NOW_SETTLE_MS * 2));
    expect(document.querySelector('[data-nav-part="local-chip"]')).toBeNull();
    expect(threadExec).not.toHaveBeenCalled();
  });

  it("v2 audit: makes no Local claim on another harness (a Codex chat made from a Local chat), and leaves its account chip", async () => {
    const sessionProfiles = vi.fn(() => ({ t1: { profile: "local", model: "ollama/qwen-27b", v: 1 } }));
    mountInChat("codex", { session_profiles: sessionProfiles });
    await waitFor(() => expect(chip().textContent).toBe("Codex · ops"));
    expect(document.querySelector('[data-nav-part="local-chip"]')).toBeNull();
    expect(sessionProfiles).not.toHaveBeenCalled();
  });

  it("works it out from the two models (pure)", () => {
    expect(localNow(undefined, null)).toBeUndefined();
    expect(localNow({ model: "ollama/a" }, "ollama/b")).toEqual({ state: "here", model: "ollama/a" });
    expect(localNow({ model: "lmstudio/a" }, null)).toEqual({ state: "here", model: "lmstudio/a" });
    expect(localNow({ model: "anthropic/x" }, "ollama/a")).toEqual({ state: "moved", model: "anthropic/x" });
    expect(localNow({ model: "ollama/a" }, "anthropic/x")).toEqual({ state: "next", model: "anthropic/x" });
    expect(localNow(undefined, "anthropic/x")).toEqual({ state: "next", model: "anthropic/x" });
    expect(localNow({ model: null }, null)).toEqual({ state: "unknown" });
  });
});

describe("the account chip on an ordinary chat, while the chat's mark is asked", () => {
  const never = () => new Promise<never>(() => {});
  it("shows at once, with no question of its own, when the rail already knows the chat is not Local", async () => {
    rememberSessionProfile("t1", null);
    const sessionProfiles = vi.fn(never);
    mountInChat("claude-code", { session_profiles: sessionProfiles });
    // Present from the first answer of the pool, never waiting on the mark.
    await waitFor(() => expect(chip().textContent).toBe("Claude · dw"), { timeout: THREAD_MARK_WAIT_MS / 2 });
    expect(sessionProfiles).not.toHaveBeenCalled();
    expect(document.querySelector('[data-nav-part="local-chip"]')).toBeNull();
  });
  it("shows at once for a chat the rail knows is Lean", async () => {
    rememberSessionProfile("t1", "lean");
    const sessionProfiles = vi.fn(never);
    mountInChat("claude-code", { session_profiles: sessionProfiles });
    await waitFor(() => expect(chip().textContent).toBe("Claude · dw"), { timeout: THREAD_MARK_WAIT_MS / 2 });
    expect(sessionProfiles).not.toHaveBeenCalled();
  });
  it("is never left missing when the question does not settle: it shows after a short wait", async () => {
    const sessionProfiles = vi.fn(never);
    const { poolList } = mountInChat("claude-code", { session_profiles: sessionProfiles });
    await new Promise((r) => setTimeout(r, THREAD_MARK_WAIT_MS / 3));
    expect(poolList).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/Claude · /);
    await waitFor(() => expect(chip().textContent).toBe("Claude · dw"), { timeout: THREAD_MARK_WAIT_MS * 3 });
    expect(sessionProfiles).toHaveBeenCalledTimes(1);
  });
  it("shows as soon as the rail's batch answer arrives, before the chat's own question settles", async () => {
    const sessionProfiles = vi.fn(never);
    mountInChat("claude-code", { session_profiles: sessionProfiles });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).not.toMatch(/Claude · /);
    act(() => rememberSessionProfile("t1", null));
    await waitFor(() => expect(chip().textContent).toBe("Claude · dw"), { timeout: THREAD_MARK_WAIT_MS / 2 });
  });
  it("stays away for a chat the rail knows is Local, even when the question does not settle", async () => {
    rememberSessionProfile("t1", "local");
    const { poolList } = mountInChat("claude-code", { session_profiles: vi.fn(never) });
    const local = await waitFor(
      () => {
        const el = document.querySelector<HTMLElement>('[data-nav-part="local-chip"]');
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: THREAD_MARK_WAIT_MS * 3 },
    );
    expect(local.textContent).toBe("Local · a local model · runs on this Mac");
    expect(screen.queryByText(/^Claude · /)).toBeNull();
    expect(poolList).not.toHaveBeenCalled();
  });
});

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

// @vitest-environment jsdom
import React from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { RailCommandEngine, registerRailCommands } from "../src/rail-commands";
import { SNOOZE_MS, snoozeWake } from "../src/rail-actions";
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
afterEach(() => {
  cleanup();
  toast.success.mockClear();
  toast.error.mockClear();
});
type Registered = {
  id: string;
  title: string;
  defaultShortcut?: { key: string; mod?: boolean; alt?: boolean; shift?: boolean };
  isAvailable?: (context: { threadId: string | null; projectId: string | null }) => boolean;
  run: (context: { threadId: string | null; projectId: string | null; experimental_panel: unknown }) => void | Promise<void>;
};
function collect() {
  const list: Registered[] = [];
  registerRailCommands({ commands: { register: (entry: Registered) => list.push(entry) } } as never);
  return list;
}
const ctx = (threadId: string | null, projectId: string | null = "p1") => ({ threadId, projectId, experimental_panel: {} });
const attentionOk = { receiptId: "r", results: [{ threadId: "t1", ok: true, error: null }] };
describe("rail actions as keyboard commands", () => {
  it("registers settle, snooze, pin and new chat so they can be rebound", () => {
    const list = collect();
    expect(list.map((entry) => entry.id)).toEqual(["settle-chat", "snooze-chat", "pin-chat", "new-chat"]);
    expect(list.map((entry) => entry.title)).toEqual([
      "Workspace: settle this chat",
      "Workspace: snooze this chat for one hour",
      "Workspace: pin or unpin this chat",
      "Workspace: new chat in this project",
    ]);
    for (const entry of list) expect(entry.defaultShortcut).toMatchObject({ mod: true, alt: true });
    expect(new Set(list.map((entry) => entry.defaultShortcut?.key)).size).toBe(4);
  });
  it("hides the chat commands when no chat is in view", () => {
    const [settle, snooze, pin, newChat] = collect();
    for (const entry of [settle, snooze, pin]) {
      expect(entry.isAvailable?.(ctx(null))).toBe(false);
      expect(entry.isAvailable?.(ctx("t1"))).toBe(true);
    }
    expect(newChat.isAvailable).toBeUndefined();
  });
  it("tells you when the Console is not loaded yet instead of doing nothing", async () => {
    const [settle] = collect();
    await settle.run(ctx("t1"));
    expect(toast.error).toHaveBeenCalledWith("The Console is still starting. Try again in a moment.");
  });
  it("settles and snoozes the chat in view through the same attention call as the rail menu", async () => {
    const applied: unknown[] = [];
    const list = collect();
    renderSlot({ component: RailCommandEngine }, {}, {
      rpc: {
        attention_apply: (input: unknown) => {
          applied.push(input);
          return attentionOk;
        },
      },
    });
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await act(async () => {
      await list[0].run(ctx("t1"));
      await list[1].run(ctx("t1"));
    });
    vi.restoreAllMocks();
    expect(applied).toEqual([
      { threadIds: ["t1"], action: "settle" },
      { threadIds: ["t1"], action: "snooze", wakeAt: now + SNOOZE_MS },
    ]);
    expect(snoozeWake(now)).toBe(now + 3_600_000);
  });
  it("sends one settle or snooze for a held or double-tapped key, and works again once it has answered", async () => {
    const list = collect();
    const applied: Array<{ threadIds: string[]; action: string }> = [];
    const waiting: Array<() => void> = [];
    const releaseAll = () => waiting.splice(0).forEach((resolve) => resolve());
    renderSlot({ component: RailCommandEngine }, {}, {
      rpc: {
        attention_apply: async (input: { threadIds: string[]; action: string }) => {
          applied.push(input);
          await new Promise<void>((resolve) => { waiting.push(resolve); });
          return attentionOk;
        },
      },
    });
    const [settle, snooze] = list;
    await act(async () => {
      const presses = [settle.run(ctx("t1")), settle.run(ctx("t1")), settle.run(ctx("t1")), snooze.run(ctx("t1")), snooze.run(ctx("t1")), settle.run(ctx("t2"))];
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(applied.map((call) => `${call.action}:${call.threadIds[0]}`)).toEqual(["settle:t1", "snooze:t1", "settle:t2"]);
      releaseAll();
      await Promise.all(presses);
    });
    expect(toast.success).toHaveBeenCalledTimes(3);
    const before = applied.length;
    await act(async () => {
      const again = settle.run(ctx("t1"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseAll();
      await again;
    });
    expect(applied.length).toBe(before + 1);
  });
  it("pins an unpinned chat and unpins a pinned one", async () => {
    const list = collect();
    const pinned = new Map([["t1", false], ["t2", true]]);
    const view = renderSlot({ component: RailCommandEngine }, {}, {
      sdk: {
        threads: {
          get: ({ threadId }: { threadId: string }) => ({ id: threadId, pinnedAt: pinned.get(threadId) ? 5 : null }),
          pin: () => ({}),
          unpin: () => ({}),
        },
      } as never,
    });
    await act(async () => {
      await list[2].run(ctx("t1"));
      await list[2].run(ctx("t2"));
    });
    const calls = view.inspection.sdkCalls.map((call) => `${call.method}:${(call.args as { threadId?: string }[])[0]?.threadId}`);
    expect(calls).toEqual(["threads.get:t1", "threads.pin:t1", "threads.get:t2", "threads.unpin:t2"]);
  });
  it("opens a new chat in the project in view", async () => {
    const list = collect();
    const view = renderSlot({ component: RailCommandEngine }, {});
    await act(async () => {
      await list[3].run(ctx("t1", "proj-7"));
    });
    expect(view.inspection.navigateCalls).toEqual([
      { method: "toCompose", options: { projectId: "proj-7", focusPrompt: true } },
    ]);
  });
  it("gives every Console command a different default shortcut", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const bound = (app.commandPaletteActions as { id: string; defaultShortcut: Record<string, unknown> | null }[]).filter((entry) => entry.defaultShortcut);
    const signature = (entry: (typeof bound)[number]) => {
      const key = entry.defaultShortcut ?? {};
      return [String(key.key).toLowerCase(), !!key.mod, !!key.meta, !!key.control, !!key.alt, !!key.shift].join("|");
    };
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const entry of bound) {
      const sig = signature(entry);
      const first = seen.get(sig);
      if (first) clashes.push(`${first} and ${entry.id} both use ${sig}`);
      else seen.set(sig, entry.id);
    }
    expect(clashes).toEqual([]);
    expect(bound.map((entry) => entry.id)).toEqual(expect.arrayContaining(["capture-window", "settle-chat", "context-shelf", "voice-toggle"]));
  }, 30_000);
  it("lets Undo reverse a settle started from the keyboard", async () => {
    const list = collect();
    const undone: unknown[] = [];
    renderSlot({ component: RailCommandEngine }, {}, {
      rpc: {
        attention_apply: () => attentionOk,
        attention_undo: (input: unknown) => (undone.push(input), { results: [{ threadId: "t1", ok: true, error: null }] }),
      },
    });
    await act(async () => {
      await list[0].run(ctx("t1"));
    });
    const [, options] = toast.success.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(options.action.label).toBe("Undo");
    await act(async () => {
      options.action.onClick();
    });
    expect(undone).toEqual([{ receiptId: "r" }]);
  });
  it("binds the Cmd+Shift+B the navigation fold advertises, and folds and unfolds with it", async () => {
    const { NAV_SHORTCUT, setNavMode, useNavMode } = await import("../src/nav-fold");
    const app = await loadPluginApp(() => import("../app"));
    const entry = (app.commandPaletteActions as Array<{ id: string; defaultShortcut: Record<string, unknown> | null; run: (context: unknown) => void }>).find((candidate) => candidate.id === "toggle-navigation");
    expect(entry?.defaultShortcut).toMatchObject({ key: "b", mod: true, shift: true });
    expect(NAV_SHORTCUT).toBe("⌘⇧B");
    const Mode = () => <p data-testid="nav-mode">{useNavMode()}</p>;
    const view = renderSlot({ component: Mode }, {});
    const shown = () => view.container.querySelector('[data-testid="nav-mode"]')?.textContent;
    act(() => setNavMode("open"));
    act(() => entry?.run(ctx(null)));
    expect(shown()).toBe("folded");
    act(() => entry?.run(ctx(null)));
    expect(shown()).toBe("open");
    act(() => setNavMode("hidden"));
    act(() => entry?.run(ctx(null)));
    expect(shown()).toBe("open");
  }, 30_000);
  it("is registered by the app itself", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const ids = app.commandPaletteActions.map((entry: { id: string }) => entry.id);
    for (const id of ["settle-chat", "snooze-chat", "pin-chat", "new-chat", "open-agents", "open-todo", "voice-toggle"]) expect(ids).toContain(id);
    expect(app.appOverlays.map((entry: { id: string }) => entry.id)).toContain("rail-commands");
  }, 30_000);
});

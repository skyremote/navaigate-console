import { useEffect } from "react";
import { toast } from "sonner";
import { useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginAppSetup, PluginCommandContext } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { applyAttention } from "./attention";
import { composeIn, setPinned, snoozeWake } from "./rail-actions";
import { registerAtLoad } from "./use-feature";

type RailBus = {
  settle(threadId: string): Promise<void>;
  snooze(threadId: string): Promise<void>;
  togglePin(threadId: string): Promise<void>;
  newChat(projectId: string | null): void;
};

let bus: RailBus | null = null;

/** A key held down, or tapped twice, repeats the command; only the first press of a chat's settle or snooze goes out until the server has answered it. */
const pending = new Set<string>();
function once(key: string, send: () => Promise<void>): Promise<void> {
  if (pending.has(key)) return Promise.resolve();
  pending.add(key);
  return send().finally(() => pending.delete(key));
}

const failure = (what: string) => (cause: unknown) =>
  toast.error(`${what} failed`, { description: cause instanceof Error ? cause.message : String(cause) });

/** Mounted once for the window: gives the rail commands the same rpc, sdk and navigation the right-click menu uses. */
export function RailCommandEngine() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const nav = useBbNavigate();
  useEffect(() => {
    const refresh = () => {};
    const mine: RailBus = {
      settle: (threadId) => once(`settle:${threadId}`, () => applyAttention(rpc, refresh, [threadId], "settle")),
      snooze: (threadId) => once(`snooze:${threadId}`, () => applyAttention(rpc, refresh, [threadId], "snooze", snoozeWake())),
      togglePin: async (threadId) => {
        try {
          const thread = await sdk.threads.get({ threadId });
          await setPinned(sdk, threadId, thread.pinnedAt !== null);
        } catch (cause) {
          failure("Pin")(cause);
        }
      },
      newChat: (projectId) => composeIn(nav, projectId),
    };
    bus = mine;
    return () => {
      if (bus === mine) bus = null;
    };
  }, [rpc, sdk, nav]);
  return null;
}

const needsChat = (context: PluginCommandContext) => !!context.threadId;

function viaBus(run: (railBus: RailBus, context: PluginCommandContext) => void | Promise<void>) {
  return async (context: PluginCommandContext) => {
    if (!bus) {
      toast.error("The Console is still starting. Try again in a moment.");
      return;
    }
    await run(bus, context);
  };
}

/**
 * Every rail action that used to live only in a right-click menu, as a
 * command: listed in the palette and rebindable in Settings, Keyboard.
 */
export function registerRailCommands(app: Parameters<PluginAppSetup>[0]) {
  // Keyboard commands are one feature (custom keyboard bindings): off at load, none are registered.
  if (!registerAtLoad("F72")) return;
  app.commands.register({
    id: "settle-chat",
    title: "Workspace: settle this chat",
    defaultShortcut: { key: "x", mod: true, alt: true },
    isAvailable: needsChat,
    run: viaBus((railBus, context) => (context.threadId ? railBus.settle(context.threadId) : undefined)),
  });
  app.commands.register({
    id: "snooze-chat",
    title: "Workspace: snooze this chat for one hour",
    defaultShortcut: { key: "z", mod: true, alt: true },
    isAvailable: needsChat,
    run: viaBus((railBus, context) => (context.threadId ? railBus.snooze(context.threadId) : undefined)),
  });
  app.commands.register({
    id: "pin-chat",
    title: "Workspace: pin or unpin this chat",
    defaultShortcut: { key: "p", mod: true, alt: true },
    isAvailable: needsChat,
    run: viaBus((railBus, context) => (context.threadId ? railBus.togglePin(context.threadId) : undefined)),
  });
  app.commands.register({
    id: "new-chat",
    title: "Workspace: new chat in this project",
    defaultShortcut: { key: "n", mod: true, alt: true },
    run: viaBus((railBus, context) => railBus.newChat(context.projectId)),
  });
}

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: [] as { command: string; args: string[]; env: NodeJS.ProcessEnv }[], make: null as null | (() => unknown) }));
vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    spawned.calls.push({ command, args, env: options.env });
    return spawned.make!();
  },
}));

import { claudeEnv, runClaude } from "../server-helper-models";

function fakeChild(onSpawn: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> }) => void) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  queueMicrotask(() => onSpawn(child));
  return child;
}
const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
beforeEach(() => {
  spawned.calls.length = 0;
});
afterEach(() => {
  for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_AUTH_TOKEN", saved.token]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("running claude for a title or commit message", () => {
  it("never passes an Anthropic API key or token, so the subscription is used", () => {
    const env = claudeEnv({ ANTHROPIC_API_KEY: "sk-live", ANTHROPIC_AUTH_TOKEN: "tok", HOME: "/home/x", PATH: "/usr/bin" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.HOME).toBe("/home/x");
    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain(".local/bin");
  });

  it("starts the process without the keys even when the server has them set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-live";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok";
    spawned.make = () =>
      fakeChild((child) => {
        child.stdout.end("A tidy title\n");
        child.emit("close", 0);
      });
    expect(await runClaude({ model: "claude-haiku-4-5", prompt: "p", signal: new AbortController().signal })).toBe("A tidy title");
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0].env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawned.calls[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("does not start claude when the request was already cancelled", async () => {
    spawned.make = () => fakeChild(() => undefined);
    const controller = new AbortController();
    controller.abort();
    await expect(runClaude({ model: "claude-haiku-4-5", prompt: "p", signal: controller.signal })).rejects.toThrow(/cancel/i);
    expect(spawned.calls).toHaveLength(0);
  });

  it("stops listening for cancellation when claude cannot start", async () => {
    spawned.make = () => fakeChild((child) => child.emit("error", new Error("spawn claude ENOENT")));
    const listeners = new Set<unknown>();
    const signal = {
      aborted: false,
      addEventListener: (_: string, listener: unknown) => listeners.add(listener),
      removeEventListener: (_: string, listener: unknown) => listeners.delete(listener),
    } as unknown as AbortSignal;
    await expect(runClaude({ model: "claude-haiku-4-5", prompt: "p", signal })).rejects.toThrow("Could not start claude");
    expect(listeners.size).toBe(0);
  });
});

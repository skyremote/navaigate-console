import { describe, expect, it, vi } from "vitest";
import { claudeArgs, createHelperModels, describeSelection, helperKind } from "../server-helper-models";

type Declared = {
  id: string;
  displayName: string;
  complete: (prompt: string, options: { signal: AbortSignal }) => Promise<string>;
  status: () => Promise<{ ready: true } | { ready: false; message: string }>;
};

function setup(options: { runner?: (input: { model: string; prompt: string; signal: AbortSignal }) => Promise<string>; withServices?: boolean } = {}) {
  const stored = new Map<string, unknown>();
  const declared: Declared[] = [];
  const bb = {
    storage: { kv: { get: vi.fn(async (key: string) => stored.get(key)), set: vi.fn(async (key: string, value: unknown) => void stored.set(key, value)) } },
    realtime: { publish: vi.fn() },
    log: { warn: vi.fn(), info: vi.fn() },
    ...(options.withServices === false ? {} : { experimental_aiServices: { register: (entry: Declared) => (declared.push(entry), { dispose() {} }) } }),
  };
  const engine = createHelperModels(bb as never, { run: options.runner ?? (async () => "A tidy title") });
  return { engine, declared, stored, bb };
}
const haiku = { providerId: "claude-code", model: "claude-haiku-4-5", reasoningLevel: "low" };
const codex = { providerId: "codex", model: "gpt-5.5", reasoningLevel: "low" };
const signal = new AbortController().signal;

describe("title and commit helper models", () => {
  it("classifies which models the Console can run itself", () => {
    expect(helperKind(haiku)).toBe("claude");
    expect(helperKind(codex)).toBe("codex");
    expect(helperKind({ providerId: "gemini", model: "x", reasoningLevel: "" })).toBeNull();
    expect(helperKind(null)).toBeNull();
  });
  it("runs Claude headless with no tools, no saved session and the chosen model", () => {
    expect(claudeArgs("claude-haiku-4-5")).toEqual(["-p", "--model", "claude-haiku-4-5", "--output-format", "text", "--no-session-persistence", "--tools", "", "--disable-slash-commands"]);
    expect(() => claudeArgs("--dangerously-skip-permissions")).toThrow("model name");
    expect(() => claudeArgs("bad model")).toThrow("model name");
  });
  it("registers a title and a commit service when the host offers AI services", () => {
    const { declared } = setup();
    expect(declared.map((entry) => entry.id)).toEqual(["title-model", "commit-model"]);
    expect(declared.map((entry) => entry.displayName)).toEqual(["Console: chosen title model", "Console: chosen commit model"]);
  });
  it("loads on a host without AI services and says so", async () => {
    const { engine } = setup({ withServices: false });
    expect((await engine.get()).serviceRegistered).toBe(false);
  });
  it("saves a choice per purpose and refuses models it cannot run", async () => {
    const { engine } = setup();
    const saved = await engine.set({ purpose: "title", choice: haiku });
    expect(saved.choices).toEqual({ title: haiku, commit: null });
    await expect(engine.set({ purpose: "commit", choice: { providerId: "gemini", model: "x", reasoningLevel: "" } })).rejects.toThrow("Claude");
    expect((await engine.set({ purpose: "title", choice: null })).choices.title).toBeNull();
  });
  it("answers with the chosen Claude model and records which model wrote it", async () => {
    const runner = vi.fn(async () => "Fix the login redirect");
    const { engine, declared, bb } = setup({ runner });
    await engine.set({ purpose: "title", choice: haiku });
    const text = await declared[0].complete("Title for: login bug", { signal });
    expect(text).toBe("Fix the login redirect");
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5", prompt: "Title for: login bug" }));
    const { runs } = await engine.get();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ purpose: "title", providerId: "claude-code", model: "claude-haiku-4-5", ok: true, preview: "Fix the login redirect", error: null });
    expect(runs[0].ms).toBeGreaterThanOrEqual(0);
    expect(bb.realtime.publish).toHaveBeenCalledWith("delivery-helper-models", {});
  });
  it("records a failure and rethrows so bb falls back", async () => {
    const { engine, declared } = setup({ runner: async () => { throw new Error("claude: not logged in"); } });
    await engine.set({ purpose: "commit", choice: haiku });
    await expect(declared[1].complete("msg", { signal })).rejects.toThrow("not logged in");
    expect((await engine.get()).runs[0]).toMatchObject({ purpose: "commit", ok: false, error: "claude: not logged in" });
  });
  it("is not ready until a Claude model is chosen", async () => {
    const { engine, declared } = setup();
    expect(await declared[0].status()).toEqual({ ready: false, message: "Choose a Claude model for titles in Delivery, Models by task." });
    await expect(declared[0].complete("x", { signal })).rejects.toThrow("Choose a Claude model");
    await engine.set({ purpose: "title", choice: haiku });
    expect(await declared[0].status()).toEqual({ ready: true });
  });
  it("keeps only the latest runs", async () => {
    const { engine, declared } = setup();
    await engine.set({ purpose: "title", choice: haiku });
    for (let i = 0; i < 30; i++) await declared[0].complete(`p${i}`, { signal });
    expect((await engine.get()).runs).toHaveLength(20);
  });
  it("describes who currently writes titles", () => {
    const services = [
      { id: "title-model", pluginId: "navaigate-skin", displayName: "Console: chosen title model", status: { ready: true as const } },
      { id: "title-model", pluginId: "provider-codex", displayName: "Codex: chosen title model", status: { ready: false as const, message: "Choose titleHelperModel in Codex plugin settings." } },
    ];
    expect(describeSelection({ mode: "automatic" }, services)).toBe("Automatic: bb picks the first ready service");
    expect(describeSelection({ mode: "off" }, services)).toBe("Off");
    expect(describeSelection({ mode: "service", pluginId: "navaigate-skin", serviceId: "title-model" }, services)).toBe("Console: chosen title model (ready)");
    expect(describeSelection({ mode: "service", pluginId: "provider-codex", serviceId: "title-model" }, services)).toBe("Codex: chosen title model (not ready: Choose titleHelperModel in Codex plugin settings.)");
    expect(describeSelection({ mode: "service", pluginId: "gone", serviceId: "x" }, services)).toBe("gone / x (not installed)");
  });
});

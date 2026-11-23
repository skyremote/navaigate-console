// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { NewThreadComposerProps, NewThreadRequest } from "@get-bb/plugin-sdk/app";

const composer = vi.hoisted(() => ({ props: null as NewThreadComposerProps | null }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    experimental_NewThreadComposer: (props: NewThreadComposerProps) => {
      composer.props = props;
      return <div data-testid="embedded-composer" data-provider={props.defaultProviderId} data-model={props.defaultModel ?? ""} data-permission={props.defaultPermissionMode ?? ""} />;
    },
  };
});
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { Hero, findHostComposer } from "../src/new-thread-hero";
import { OPENCODE_BASE_TOKENS, OPENCODE_TOKENS_PER_SKILL, SKILLS_SLOW_TOKENS, SKILLS_STALL_TOKENS, forgetLocalModels, forgetSkillCount, localModeNote, memoryStatus, offlineText, opencodeFirstPromptTokens, skillsNote, slotsNote } from "../src/session-orbs";
import { getProfile, setProfileState } from "../src/use-profile";
import { fixtureProfile } from "./setup-profile";
import {
  HOME_CHOICE_KEY,
  NO_UNLOCKED,
  hasUnlockedList,
  localClaudeRequest,
  isUnlockedModel,
  markForRequest,
  matchesProfile,
  parseHomeChoice,
  localChatTitle,
  parseUnlockedList,
  readSessionProfile,
  sessionProfileMetadata,
  type HomeChoice,
} from "../src/session-profile";

beforeEach(() => {
  forgetLocalModels();
  forgetSkillCount();
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, String(value)),
    removeItem: (name: string) => void items.delete(name),
    clear: () => items.clear(),
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size;
    },
  });
});
afterEach(() => {
  cleanup();
  composer.props = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("unlocked models", () => {
  it("treats no model as unlocked unless its owner lists it, whatever its name says", () => {
    for (const id of ["ollama/example/deepseek-r1-tuned:14b", "lmstudio/gemma4", "ollama/x"]) expect(isUnlockedModel({ id, name: "Any name" }), id).toBe(false);
    expect(isUnlockedModel({ id: "ollama/x" }, NO_UNLOCKED)).toBe(false);
    expect(hasUnlockedList(NO_UNLOCKED)).toBe(false);
  });
  it("opens for a model the owner listed, by id or by name", () => {
    const models = parseUnlockedList("lmstudio/gemma4\n# comment\n\n  Qwen Coder  \n");
    expect(models).toEqual(["lmstudio/gemma4", "Qwen Coder"]);
    const list = { models, words: [] };
    expect(hasUnlockedList(list)).toBe(true);
    expect(isUnlockedModel({ id: "lmstudio/gemma4" }, list)).toBe(true);
    expect(isUnlockedModel({ id: "lmstudio/qwen-coder", name: "qwen coder" }, list)).toBe(true);
    expect(isUnlockedModel({ id: "lmstudio/other" }, list)).toBe(false);
  });
  it("opens for a word from the owner's profile in the id or the name, in any case", () => {
    const list = { models: [], words: ["Tuned"] };
    expect(isUnlockedModel({ id: "ollama/example/deepseek-r1-tuned:14b" }, list)).toBe(true);
    expect(isUnlockedModel({ id: "ollama/x", name: "Qwen TUNED 27B" }, list)).toBe(true);
    expect(isUnlockedModel({ id: "lmstudio/gemma4", name: "Gemma 4 E4B" }, list)).toBe(false);
  });
});

describe("the profile mark", () => {
  it("round-trips through thread metadata", () => {
    for (const mark of [{ profile: "lean", v: 1 }, { profile: "local", model: "ollama/qwen", v: 1 }, { profile: "local-unlocked", model: "ollama/x-tuned", v: 1 }] as const) {
      const metadata = JSON.parse(JSON.stringify({ other: { keep: true }, ...sessionProfileMetadata(mark) }));
      expect(readSessionProfile(metadata)).toEqual(mark);
    }
  });
  it("counts a chat without a readable mark as Online", () => {
    expect(sessionProfileMetadata(null)).toBeUndefined();
    expect(readSessionProfile({})).toBeNull();
    expect(readSessionProfile(null)).toBeNull();
    expect(readSessionProfile({ sessionProfile: { profile: "lean", v: 2 } })).toBeNull();
    expect(readSessionProfile({ sessionProfile: { profile: "turbo", v: 1 } })).toBeNull();
  });
  it("is worked out from what was submitted, not from the orb alone", () => {
    const lean: HomeChoice = { where: "online", online: "lean", localModel: null, localHarness: "claude" };
    const local: HomeChoice = { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "opencode" };
    const full: HomeChoice = { where: "online", online: "full", localModel: null, localHarness: "claude" };
    expect(markForRequest(lean, { providerId: "claude-code", model: "opus" })).toEqual({ profile: "lean", v: 1 });
    expect(markForRequest(lean, { providerId: "codex", model: "gpt-6" })).toBeNull();
    expect(markForRequest(full, { providerId: "claude-code", model: "opus" })).toBeNull();
    expect(markForRequest(local, { providerId: "acp-opencode", model: "ollama/qwen" })).toEqual({ profile: "local", model: "ollama/qwen", v: 1 });
    expect(markForRequest(local, { providerId: "acp-opencode", model: "ollama/deepseek-r1-tuned:14b" })).toEqual({ profile: "local", model: "ollama/deepseek-r1-tuned:14b", v: 1 });
    expect(markForRequest(local, { providerId: "acp-opencode", model: "ollama/deepseek-r1-tuned:14b" }, { list: { models: [], words: ["tuned"] } })).toEqual({ profile: "local-unlocked", model: "ollama/deepseek-r1-tuned:14b", v: 1 });
    expect(markForRequest(local, { providerId: "acp-opencode", model: "opencode/big-pickle" })).toBeNull();
    expect(markForRequest(local, { providerId: "claude-code", model: "opus" })).toBeNull();
  });
  it("never marks a chat on a model Ollama serves from its cloud as Local", () => {
    const local: HomeChoice = { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "opencode" };
    expect(markForRequest(local, { providerId: "acp-opencode", model: "ollama/glm-4.6:cloud" })).toBeNull();
    expect(markForRequest(local, { providerId: "acp-opencode", model: "ollama/qwen3-coder:480b-cloud" })).toBeNull();
    // Named like a local model, but the server's list says Ollama serves it from its cloud.
    expect(markForRequest(local, { providerId: "acp-opencode", model: "ollama/my-alias" }, { remote: ["ollama/my-alias"] })).toBeNull();
    expect(markForRequest(local, { providerId: "acp-opencode", model: "ollama/qwen" }, { remote: ["ollama/my-alias"] })).toEqual({ profile: "local", model: "ollama/qwen", v: 1 });
  });
  it("filters Online as the chats with no mark", () => {
    expect(matchesProfile(null, "online")).toBe(true);
    expect(matchesProfile("lean", "online")).toBe(false);
    expect(matchesProfile("lean", "lean")).toBe(true);
    expect(matchesProfile("local", "local-unlocked")).toBe(false);
    expect(matchesProfile("local", null)).toBe(true);
  });
  it("reads a damaged saved choice as Online + Full", () => {
    expect(parseHomeChoice("not json")).toEqual({ where: "online", online: "full", localModel: null, localHarness: "claude" });
    expect(parseHomeChoice(JSON.stringify({ where: "mars", online: "lean" }))).toEqual({ where: "online", online: "lean", localModel: null, localHarness: "claude" });
    expect(parseHomeChoice(JSON.stringify({ where: "local", localHarness: "opencode" })).localHarness).toBe("opencode");
  });
});

/* ------------------------------ the hero ------------------------------ */

const LOCAL = [
  { id: "ollama/qwen", model: "ollama/qwen", displayName: "Qwen local", isDefault: false },
  { id: "ollama/deepseek-r1-tuned:14b", model: "ollama/deepseek-r1-tuned:14b", displayName: "deepseek-r1-tuned:14b", isDefault: false },
  { id: "opencode/big-pickle", model: "opencode/big-pickle", displayName: "Big Pickle", isDefault: false },
];

function mountHero(opts: { choice?: HomeChoice; models?: typeof LOCAL | "fail"; tools?: (model: string) => { tools: boolean | null; reason: string } | Promise<never>; remote?: string[]; words?: string[]; leanReady?: boolean; skills?: number | null | "fail" | { skills: number | null; capped: boolean; complete: boolean }; modelsDelay?: number; memory?: unknown } = {}) {
  if (opts.choice) localStorage.setItem(HOME_CHOICE_KEY, JSON.stringify(opts.choice));
  const host = document.createElement("div");
  host.setAttribute("data-app-composer-role", "primary");
  host.textContent = "bb typing box";
  document.body.appendChild(host);
  const spawn = vi.fn(async (_args: Record<string, unknown>) => makeThreadResponse({ id: "thr_new", projectId: "proj", environmentId: null }));
  const models = vi.fn(async () => {
    if (opts.modelsDelay) await new Promise((r) => setTimeout(r, opts.modelsDelay));
    if (opts.models === "fail") throw new Error("offline");
    return { models: opts.models ?? LOCAL, modelLoadError: null };
  });
  const view = renderSlot({ component: Hero }, { composer: host }, {
    rpc: {
      session_profile_config: () => ({ unlockedModels: [], unlockedWords: opts.words ?? [], leanReady: opts.leanReady ?? true }),
      nas_where: () => { throw new Error("no nas"); },
      // As the server reads Ollama: Qwen's template passes tools, DeepSeek R1's does not.
      local_models_remote: () => ({ remote: opts.remote ?? [] }),
      local_skills_count: () => {
        if (opts.skills === "fail") throw new Error("no count");
        if (typeof opts.skills === "object" && opts.skills !== null) return opts.skills;
        const skills = opts.skills === undefined ? 0 : opts.skills;
        return { skills, capped: skills === 200, complete: true };
      },
      ...(opts.memory ? { local_model_state: () => opts.memory } : {}),
      local_model_tools: ({ model }: { model: string }) => (opts.tools ?? ((m: string) => (/deepseek/.test(m) ? { tools: false, reason: "no tools" } : { tools: true, reason: "ok" })))(model),
    } as never,
    sdk: { threads: { spawn }, providers: { models } } as never,
  });
  return { view, host, spawn, models };
}
const orb = (kind: "online" | "local") => document.querySelector<HTMLButtonElement>(`[data-orb-kind="${kind}"]`)!;
const request = (over: Partial<NewThreadRequest>): NewThreadRequest => ({
  projectId: "proj", providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "full", executionInputSources: {},
  environment: { type: "personal" } as never, input: [{ type: "text", text: "hello", mentions: [] }], ...over,
});

describe("a Local chat's own title", () => {
  it("is the prompt, cut at a word near 60 characters, never empty", () => {
    expect(localChatTitle([{ type: "text", text: "  short   prompt\n" }])).toBe("short prompt");
    const t = localChatTitle([{ type: "text", text: "word ".repeat(30) }]);
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.endsWith("word…")).toBe(true);
    expect(localChatTitle([{ type: "image" }])).toBe("Local chat");
    expect(localChatTitle([{ type: "text", text: "x".repeat(80) }])).toBe("x".repeat(60) + "…");
  });
});

describe("a Local chat's permission mode on Claude Code", () => {
  // Auto ("Approve for me") checks each action with the chat's own local model, 60 s at a time:
  // one small file write took 16 minutes. The box is seeded with the profile's mode, and bb marks a
  // seeded mode "explicit" on every submit (NewThreadComposer seededExecutionInputSources).
  const sent = (permissionMode: NewThreadRequest["permissionMode"], marked: boolean) =>
    request({ permissionMode, executionInputSources: marked ? { providerId: "explicit", permissionMode: "explicit" } : { providerId: "explicit" } });
  it("replaces auto with the profile's mode, picked or not, and marks it explicit so bb keeps it", () => {
    const full = localClaudeRequest(sent("auto", true), "ollama/qwen", "full");
    expect(full.permissionMode).toBe("full");
    expect(full.executionInputSources).toEqual({ permissionMode: "explicit", providerId: "explicit", model: "explicit" });
    expect(localClaudeRequest(sent("auto", false), "ollama/qwen", "accept-edits").permissionMode).toBe("accept-edits");
  });
  it("keeps Accept Edits or Full Access the seeded picker showed", () => {
    expect(localClaudeRequest(sent("accept-edits", true), "ollama/qwen", "full").permissionMode).toBe("accept-edits");
    expect(localClaudeRequest(sent("full", true), "ollama/qwen", "accept-edits").permissionMode).toBe("full");
  });
  it("never takes a mode the box did not mark as shown: a project's remembered Full Access becomes the profile's mode", () => {
    // A bb that ignores the seed starts the picker from the project's remembered mode and sends it unmarked.
    const remembered = localClaudeRequest(sent("full", false), "lmstudio/qwen/qwen3.8-27b", "accept-edits");
    expect(remembered.permissionMode).toBe("accept-edits");
    expect(remembered.executionInputSources.permissionMode).toBe("explicit");
    expect(remembered.model).toBe("lmstudio/qwen/qwen3.8-27b");
    expect(localClaudeRequest(sent("accept-edits", false), "ollama/qwen", "full").permissionMode).toBe("full");
  });
  it("says which mode the box starts in, that Approve for me picked there starts as that mode, and that later changes are the user's", () => {
    expect(localModeNote("full")).toBe("The box below starts in Full Access. Approve for me picked here starts as Full Access: it would check each step with this model, which takes minutes. Changing the mode later in the chat is up to you.");
    expect(localModeNote("accept-edits")).toBe("The box below starts in Accept Edits. Approve for me picked here starts as Accept Edits: it would check each step with this model, which takes minutes. Changing the mode later in the chat is up to you.");
  });
});

/** The fixture profile with the Console's Local permission mode set (or removed, for the community default). */
function setLocalMode(mode: "full" | "accept-edits" | undefined) {
  const p = getProfile();
  const console = { ...((p.plugins.console as Record<string, unknown>) ?? {}) };
  if (mode) console.localPermissionMode = mode;
  else delete console.localPermissionMode;
  setProfileState({ profile: { ...p, plugins: { ...p.plugins, console } } });
}

describe("the hero", () => {
  it("Online + Full by default: bb's own box stays and nothing is embedded", async () => {
    const { host } = mountHero();
    await waitFor(() => expect(orb("local").disabled).toBe(false));
    expect(orb("online").getAttribute("aria-pressed")).toBe("true");
    expect(orb("local").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("embedded-composer")).toBeNull();
    expect(host.hasAttribute("data-nav-session-hidden")).toBe(false);
    expect(screen.getByText(/working right now|What are we building/)).toBeTruthy();
  });

  it("Lean hides bb's box, embeds a Claude box and creates the chat marked lean", async () => {
    const { host, spawn, view } = mountHero();
    fireEvent.click(await screen.findByRole("button", { name: "Lean" }));
    const box = await screen.findByTestId("embedded-composer");
    expect(box.dataset.provider).toBe("claude-code");
    expect(host.hasAttribute("data-nav-session-hidden")).toBe(true);
    expect(JSON.parse(localStorage.getItem(HOME_CHOICE_KEY)!)).toMatchObject({ where: "online", online: "lean" });
    await act(async () => { await composer.props!.onSubmit(request({})); });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ providerId: "claude-code", pluginMetadata: { sessionProfile: { profile: "lean", v: 1 } } }));
    expect(view.inspection.navigateCalls).toEqual([expect.objectContaining({ method: "toThread", threadId: "thr_new" })]);
    // Back to Full: bb's box returns.
    fireEvent.click(screen.getByRole("button", { name: "Full" }));
    await waitFor(() => expect(host.hasAttribute("data-nav-session-hidden")).toBe(false));
    expect(screen.queryByTestId("embedded-composer")).toBeNull();
  });

  it("an Online chat started from the embedded box on another provider carries no mark", async () => {
    const { spawn } = mountHero({ choice: { where: "online", online: "lean", localModel: null, localHarness: "claude" } });
    await screen.findByTestId("embedded-composer");
    await act(async () => { await composer.props!.onSubmit(request({ providerId: "codex", model: "gpt-6" })); });
    expect(spawn.mock.calls[0][0]).not.toHaveProperty("pluginMetadata");
    expect(toasts.message).toHaveBeenCalled();
  });

  it("Local on the Claude Code harness starts a Claude chat on Ollama's own model name, marked local", async () => {
    const { spawn } = mountHero();
    await waitFor(() => expect(orb("local").disabled).toBe(false));
    fireEvent.click(orb("local"));
    const box = await screen.findByTestId("embedded-composer");
    expect(box.dataset.provider).toBe("claude-code");
    expect(box.parentElement?.dataset.harness).toBe("claude");
    // Whatever the box shows, the Local orb decides: a Claude model picked there is never sent.
    await act(async () => { await composer.props!.onSubmit(request({ providerId: "claude-code", model: "claude-opus-5-5" })); });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "claude-code", model: "qwen", pluginMetadata: { sessionProfile: { profile: "local", model: "ollama/qwen", v: 1 } } }),
    );
  });

  it("Local on the Claude Code harness marks provider and model as chosen, so bb keeps the Ollama name", async () => {
    // bb's server drops a requested model that carries no source and runs the project's remembered
    // Claude model instead (16 Nov 2026: every Local chat ran as claude-opus-5-5). bb's own box marks
    // only what the user touched, so a box left on its default sends no source for the model.
    const { spawn } = mountHero();
    await waitFor(() => expect(orb("local").disabled).toBe(false));
    fireEvent.click(orb("local"));
    await screen.findByTestId("embedded-composer");
    await act(async () => {
      await composer.props!.onSubmit(request({ providerId: "claude-code", model: "claude-opus-5-5", executionInputSources: { permissionMode: "client-preference" } }));
    });
    const sent = spawn.mock.calls[0][0] as { model: string; providerId: string; executionInputSources: Record<string, string> };
    expect(sent.model).toBe("qwen");
    expect(sent.providerId).toBe("claude-code");
    expect(sent.executionInputSources).toEqual({ permissionMode: "explicit", providerId: "explicit", model: "explicit" });
  });

  it("seeds the box with the profile's mode for a Local chat on Claude Code only, and never starts it in auto", async () => {
    // As bb's seeded box submits: the seeded mode, or the one picked over it, always marked explicit.
    const shown = (permissionMode: NewThreadRequest["permissionMode"]) => request({ permissionMode, executionInputSources: { providerId: "explicit", permissionMode: "explicit" } });
    setLocalMode(undefined);
    const first = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="session-composer"]')?.getAttribute("data-harness")).toBe("claude"));
    expect(composer.props!.defaultPermissionMode).toBe("accept-edits");
    await act(async () => { await composer.props!.onSubmit(shown("accept-edits")); });
    expect(first.spawn.mock.calls[0][0]).toMatchObject({ permissionMode: "accept-edits", executionInputSources: { permissionMode: "explicit" } });
    // Approve for me picked over the seed runs as the profile's mode.
    await act(async () => { await composer.props!.onSubmit(shown("auto")); });
    expect(first.spawn.mock.calls[1][0]).toMatchObject({ permissionMode: "accept-edits" });
    cleanup();
    localStorage.clear();
    setLocalMode("full");
    const second = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="session-composer"]')?.getAttribute("data-harness")).toBe("claude"));
    expect(composer.props!.defaultPermissionMode).toBe("full");
    await act(async () => { await composer.props!.onSubmit(shown("full")); });
    expect(second.spawn.mock.calls[0][0]).toMatchObject({ permissionMode: "full", executionInputSources: { permissionMode: "explicit" } });
    // Accept Edits picked over the seed is what the picker showed, so it is kept.
    await act(async () => { await composer.props!.onSubmit(shown("accept-edits")); });
    expect(second.spawn.mock.calls[1][0]).toMatchObject({ permissionMode: "accept-edits" });
  });

  it("does not start in a project's remembered Full Access the picker never showed (default profile)", async () => {
    // A bb that ignores the seed starts the picker from the project's remembered mode and sends it
    // with no marker while the user has not touched the picker.
    setLocalMode(undefined);
    const { spawn } = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="session-composer"]')?.getAttribute("data-harness")).toBe("claude"));
    await act(async () => { await composer.props!.onSubmit(request({ permissionMode: "full", executionInputSources: { providerId: "explicit" } })); });
    expect(spawn.mock.calls[0][0]).toMatchObject({ permissionMode: "accept-edits", executionInputSources: { permissionMode: "explicit" } });
  });

  it("leaves the box and the permission mode of Lean chats and Local chats in opencode exactly as today", async () => {
    setLocalMode("full");
    // As the box sends an untouched picker in a project bb remembers as auto: no marker.
    const sentAs = { permissionMode: "auto", executionInputSources: { providerId: "explicit" } } as const;
    const lean = mountHero({ choice: { where: "online", online: "lean", localModel: null, localHarness: "claude" } });
    await screen.findByTestId("embedded-composer");
    expect(composer.props).not.toHaveProperty("defaultPermissionMode");
    await act(async () => { await composer.props!.onSubmit(request({ ...sentAs })); });
    expect(lean.spawn.mock.calls[0][0]).toMatchObject({ permissionMode: "auto" });
    expect((lean.spawn.mock.calls[0][0] as { executionInputSources: object }).executionInputSources).toEqual({ providerId: "explicit" });
    cleanup();
    localStorage.clear();
    const oc = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "opencode" } });
    await screen.findByTestId("embedded-composer");
    expect(composer.props).not.toHaveProperty("defaultPermissionMode");
    await act(async () => { await composer.props!.onSubmit(request({ ...sentAs, providerId: "acp-opencode", model: "ollama/qwen" })); });
    expect(oc.spawn.mock.calls[0][0]).toMatchObject({ permissionMode: "auto" });
    expect((oc.spawn.mock.calls[0][0] as { executionInputSources: object }).executionInputSources).toEqual({ providerId: "explicit" });
  });

  it("says under the harness switch which mode a Local chat on Claude Code starts in, and keeps the line's space for opencode", async () => {
    setLocalMode("full");
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" } });
    const note = await waitFor(() => {
      const n = document.querySelector<HTMLElement>('[data-nav-part="local-mode-note"]');
      expect(n).not.toBeNull();
      return n!;
    });
    expect(note.dataset.mode).toBe("full");
    expect(note.textContent).toBe(localModeNote("full"));
    expect(note.className).not.toMatch(/\binvisible\b/);
    expect(note.getAttribute("aria-hidden")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "opencode" }));
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-nav-part="local-mode-note"]')?.className).toMatch(/\binvisible\b/));
    expect(document.querySelector<HTMLElement>('[data-nav-part="local-mode-note"]')?.getAttribute("aria-hidden")).toBe("true");
    // Online shows no such line.
    fireEvent.click(orb("online"));
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-mode-note"]')).toBeNull());
  });

  it("a Local chat brings its own title, made here, on both harnesses; Online and Lean chats do not", async () => {
    const long = "Please count the files in the fixture folder and then tell me which one is the largest of them all";
    const claude = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="session-composer"]')?.getAttribute("data-harness")).toBe("claude"));
    await act(async () => { await composer.props!.onSubmit(request({ input: [{ type: "text", text: long, mentions: [] }] })); });
    expect(claude.spawn.mock.calls[0][0]).toMatchObject({ title: "Please count the files in the fixture folder and then tell…" });
    cleanup();
    localStorage.clear();
    const oc = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/deepseek-r1-tuned:14b", localHarness: "opencode" } });
    await screen.findByTestId("embedded-composer");
    await act(async () => { await composer.props!.onSubmit(request({ providerId: "acp-opencode", model: "ollama/deepseek-r1-tuned:14b", input: [{ type: "text", text: "hello there", mentions: [] }] })); });
    expect(oc.spawn.mock.calls[0][0]).toMatchObject({ title: "hello there" });
    cleanup();
    localStorage.clear();
    const lean = mountHero({ choice: { where: "online", online: "lean", localModel: null, localHarness: "claude" } });
    await screen.findByTestId("embedded-composer");
    await act(async () => { await composer.props!.onSubmit(request({})); });
    expect(lean.spawn.mock.calls[0][0]).not.toHaveProperty("title");
  });

  it("does not offer Claude Code for a model that cannot use tools, and starts it in opencode", async () => {
    const { spawn } = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/deepseek-r1-tuned:14b", localHarness: "claude" } });
    const note = await waitFor(() => {
      const n = document.querySelector<HTMLElement>('[data-nav-part="local-harness-note"]');
      expect(n?.dataset.tools).toBe("no");
      return n!;
    });
    expect(note.textContent).toMatch(/Chat only.*cannot use tools/);
    expect(document.querySelector('[data-nav-part="local-harness"]')).toBeNull();
    const box = await screen.findByTestId("embedded-composer");
    expect(box.dataset.provider).toBe("acp-opencode");
    await act(async () => { await composer.props!.onSubmit(request({ providerId: "acp-opencode", model: "ollama/deepseek-r1-tuned:14b" })); });
    expect(spawn.mock.calls[0][0]).toMatchObject({ providerId: "acp-opencode", model: "ollama/deepseek-r1-tuned:14b" });
  });

  it("asks again on a slow back-off after Ollama did not answer, and offers Claude Code once it does", async () => {
    // Plain fake timers: only this test moves the clock, so the result does not depend on how busy the machine is.
    vi.useFakeTimers();
    // Moves the fake clock in small steps, letting answers and renders land between them, until the check passes.
    const until = async (check: () => void) => {
      for (let i = 0; ; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10);
        });
        try {
          check();
          return;
        } catch (e) {
          if (i >= 100) throw e; // 1 s of fake time
        }
      }
    };
    try {
      let up = false;
      const asked = vi.fn((_m: string) => (up ? { tools: true, reason: "ok" } : { tools: null, reason: "Ollama did not answer" }));
      mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" }, tools: asked });
      await until(() => expect(document.querySelector<HTMLElement>('[data-nav-part="local-harness-note"]')?.dataset.tools).toBe("unknown"));
      expect(asked).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(asked).toHaveBeenCalledTimes(1); // not before 15 s
      up = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await until(() => expect(document.querySelector('[data-nav-part="local-harness"]')).not.toBeNull());
      expect(asked).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(asked).toHaveBeenCalledTimes(2); // a clear answer is not asked again
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the window when a model's window is too small for Claude Code, and says when a model is on Ollama's cloud", async () => {
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" }, tools: () => ({ tools: false, why: "window", window: 8192, need: 65536, reason: "small" }) as never });
    const note = await waitFor(() => {
      const n = document.querySelector<HTMLElement>('[data-nav-part="local-harness-note"]');
      expect(n?.dataset.tools).toBe("small");
      return n!;
    });
    expect(note.textContent).toContain("8,192 tokens and Claude Code needs 65,536");
    expect((await screen.findByTestId("embedded-composer")).dataset.provider).toBe("acp-opencode");
    cleanup();
    localStorage.clear();
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" }, tools: () => ({ tools: false, why: "remote", reason: "cloud" }) as never });
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-nav-part="local-harness-note"]')?.textContent).toMatch(/Ollama's cloud/));
  });

  it("names LM Studio, not Ollama, when LM Studio does not say whether its model can use tools", async () => {
    const lm = [...LOCAL, { id: "lmstudio/qwen/qwen3.8-27b", model: "lmstudio/qwen/qwen3.8-27b", displayName: "qwen/qwen3.8-27b", isDefault: false }];
    mountHero({ choice: { where: "local", online: "full", localModel: "lmstudio/qwen/qwen3.8-27b", localHarness: "claude" }, models: lm, tools: () => ({ tools: null, reason: "Not loaded in LM Studio yet" }) });
    const note = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-nav-part="local-harness-note"]');
      expect(el?.dataset.tools).toBe("unknown");
      return el!;
    });
    expect(note.textContent).toMatch(/^Runs in opencode: LM Studio did not say/);
    expect(note.textContent).not.toMatch(/Ollama/);
  });

  it("runs in opencode when Ollama does not say whether the model can use tools", async () => {
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" }, tools: () => ({ tools: null, reason: "Ollama did not answer" }) });
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-nav-part="local-harness-note"]')?.dataset.tools).toBe("unknown"));
    expect((await screen.findByTestId("embedded-composer")).dataset.provider).toBe("acp-opencode");
  });

  it("Local lists only models on this Mac and marks the chat local", async () => {
    const { spawn, host } = mountHero({ choice: { where: "online", online: "full", localModel: null, localHarness: "opencode" } });
    await waitFor(() => expect(orb("local").disabled).toBe(false));
    fireEvent.click(orb("local"));
    const select = await screen.findByRole("combobox", { name: "Local model" });
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual(["ollama/qwen", "ollama/deepseek-r1-tuned:14b"]);
    const box = await screen.findByTestId("embedded-composer");
    expect(box.dataset.provider).toBe("acp-opencode");
    expect(box.dataset.model).toBe("ollama/qwen");
    expect(orb("local").dataset.unlocked).toBe("false");
    expect(host.hasAttribute("data-nav-session-hidden")).toBe(true);
    await act(async () => { await composer.props!.onSubmit(request({ providerId: "acp-opencode", model: "ollama/qwen" })); });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ pluginMetadata: { sessionProfile: { profile: "local", model: "ollama/qwen", v: 1 } } }));
  });

  it("Local never lists a model Ollama serves from its cloud, by its tag or by the server's list", async () => {
    const cloud = [
      ...LOCAL,
      { id: "ollama/glm-4.6:cloud", model: "ollama/glm-4.6:cloud", displayName: "glm-4.6:cloud", isDefault: false },
      { id: "ollama/my-alias", model: "ollama/my-alias", displayName: "my-alias", isDefault: false },
    ];
    const { spawn } = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/my-alias", localHarness: "opencode" }, models: cloud, remote: ["ollama/my-alias"] });
    const select = await screen.findByRole("combobox", { name: "Local model" });
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual(["ollama/qwen", "ollama/deepseek-r1-tuned:14b"]);
    // The remembered cloud choice is gone: the box starts on the first model on this Mac.
    expect((await screen.findByTestId("embedded-composer")).dataset.model).toBe("ollama/qwen");
    // Even if bb's own box is switched to the cloud model, the chat is not marked Local.
    await act(async () => { await composer.props!.onSubmit(request({ providerId: "acp-opencode", model: "ollama/my-alias" })); });
    expect(spawn.mock.calls[0][0]).not.toHaveProperty("pluginMetadata");
  });

  it("the memory row asks the runtime the model needs: Ollama for ollama/, LM Studio for lmstudio/", () => {
    const onlyLm = { reachable: false, lmStudio: { reachable: true }, loaded: [], loading: [], failed: [] };
    expect(memoryStatus(onlyLm, "lmstudio/qwen/qwen3.8-27b")).toBe("empty");
    expect(memoryStatus(onlyLm, "ollama/qwen")).toBe("offline");
    const onlyOllama = { reachable: true, lmStudio: { reachable: false, reason: "LM Studio asks for an API token, and so on" }, loaded: [], loading: [], failed: [] };
    expect(memoryStatus(onlyOllama, "ollama/qwen")).toBe("empty");
    expect(memoryStatus(onlyOllama, "lmstudio/qwen/qwen3.8-27b")).toBe("offline");
    expect(offlineText(onlyOllama, "lmstudio/qwen/qwen3.8-27b")).toMatch(/API token/);
    expect(offlineText(onlyLm, "ollama/qwen")).toBe("Ollama is not running");
  });

  it("Local, unlocked: the padlock opens and the orb is relabelled, for a model the owner's profile names", async () => {
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/deepseek-r1-tuned:14b", localHarness: "opencode" }, words: ["tuned"] });
    await waitFor(() => expect(orb("local").dataset.unlocked).toBe("true"));
    expect(orb("local").textContent).toContain("Local, unlocked");
    expect(orb("local").getAttribute("aria-pressed")).toBe("true");
    expect((await screen.findByTestId("embedded-composer")).dataset.model).toBe("ollama/deepseek-r1-tuned:14b");
  });

  it("draws no padlock and unlocks nothing when the owner listed no model", async () => {
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/deepseek-r1-tuned:14b", localHarness: "opencode" } });
    await screen.findByTestId("embedded-composer");
    expect(orb("local").dataset.unlocked).toBe("false");
    expect(orb("local").textContent).not.toContain("unlocked");
    expect(orb("local").querySelector(".nav-so-shackle")).toBeNull();
    expect(orb("local").querySelector(".nav-so-spark")).toBeNull();
  });

  it("offers no Full / Lean switch when the lean folder is not ready, and a remembered Lean choice starts as Full", async () => {
    const { host } = mountHero({ choice: { where: "online", online: "lean", localModel: null, localHarness: "claude" }, leanReady: false });
    await waitFor(() => expect(orb("local").disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Lean" })).toBeNull();
    expect(screen.queryByTestId("embedded-composer")).toBeNull();
    expect(host.hasAttribute("data-nav-session-hidden")).toBe(false);
  });

  it("community edition: Claude Code is the harness chosen first for a capable Local model when Local chats on Claude Code are not picked either way (on by default)", async () => {
    const community = { ...fixtureProfile(), edition: "community" as const, features: { preset: "custom" as const, picks: { "EXTRA-AH": true } } };
    setProfileState({ profile: community, source: "file", errors: [], path: "fixture", stamp: "d1" });
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="session-composer"]')?.getAttribute("data-harness")).toBe("claude"));
    expect(document.querySelector('[data-nav-part="local-claude-off"]')).toBeNull();
    // opencode stays one click away, and a remembered opencode choice wins.
    expect(screen.getByRole("button", { name: "opencode" })).toBeTruthy();
    cleanup();
    localStorage.clear();
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "opencode" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="session-composer"]')?.getAttribute("data-harness")).toBe("opencode"));
  });

  it("community edition: no Lean switch even with a lean folder, and Local stays in opencode when Claude Code is unticked", async () => {
    const community = { ...fixtureProfile(), edition: "community" as const, features: { preset: "custom" as const, picks: { "EXTRA-AH": true, "EXTRA-AM": false } } };
    setProfileState({ profile: community, source: "file", errors: [], path: "fixture", stamp: "c1" });
    const { spawn } = mountHero({ choice: { where: "local", online: "lean", localModel: "ollama/qwen", localHarness: "claude" } });
    const box = await screen.findByTestId("embedded-composer");
    expect(screen.queryByRole("button", { name: "Lean" })).toBeNull();
    expect(document.querySelector('[data-nav-part="local-harness"]')).toBeNull();
    expect(document.querySelector('[data-nav-part="local-harness-note"]')).toBeNull();
    // No start mode is seeded and no mode note is shown while Local on Claude Code is not ticked.
    expect(document.querySelector('[data-nav-part="local-mode-note"]')).toBeNull();
    expect(composer.props).not.toHaveProperty("defaultPermissionMode");
    expect(box.dataset.provider).toBe("acp-opencode");
    // Off by a saved pick: the orb says so in one plain line, with a way to Setup; nothing switches it on.
    expect(document.querySelector('[data-nav-part="local-claude-off"]')?.textContent).toBe("Local chats on Claude Code are off in Setup. Open Setup");
    await act(async () => { await composer.props!.onSubmit(request({ providerId: "acp-opencode", model: "ollama/qwen" })); });
    expect(spawn.mock.calls[0][0]).toMatchObject({ providerId: "acp-opencode", model: "ollama/qwen", pluginMetadata: { sessionProfile: { profile: "local", model: "ollama/qwen", v: 1 } } });
    cleanup();
    localStorage.clear();
    // Ticked in Setup: the switch appears and the chat runs on Claude Code.
    setProfileState({ profile: { ...community, features: { preset: "custom", picks: { "EXTRA-AH": true, "EXTRA-AM": true } } }, source: "file", errors: [], path: "fixture", stamp: "c2" });
    mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-harness"]')).not.toBeNull());
    expect(document.querySelector('[data-nav-part="session-composer"]')?.getAttribute("data-harness")).toBe("claude");
    // Ticked: the community default start mode is Accept Edits, seeded in the box and named in the note.
    expect(composer.props!.defaultPermissionMode).toBe("accept-edits");
    expect(document.querySelector<HTMLElement>('[data-nav-part="local-mode-note"]')?.dataset.mode).toBe("accept-edits");
  });

  it("with no local model, the Local orb is disabled, says so, and a remembered Local choice falls back to Online", async () => {
    const { host } = mountHero({ choice: { where: "local", online: "full", localModel: "ollama/qwen" }, models: "fail" });
    await waitFor(() => expect(orb("local").disabled).toBe(true));
    expect(orb("local").textContent).toContain("No local model found");
    expect(orb("online").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("embedded-composer")).toBeNull();
    expect(host.hasAttribute("data-nav-session-hidden")).toBe(false);
  });

  it("never mistakes the embedded box for bb's own", () => {
    const hero = document.createElement("div");
    hero.dataset.navHero = "1";
    const embedded = document.createElement("div");
    embedded.setAttribute("data-app-composer-role", "primary");
    hero.appendChild(embedded);
    const host = document.createElement("div");
    host.setAttribute("data-app-composer-role", "primary");
    document.body.append(hero, host);
    expect(findHostComposer()).toBe(host);
  });
});

/* ------------------------- opencode's skill list ------------------------- */

describe("the skill-list note on the Local orb", () => {
  const ON_CLAUDE = { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" } as const;
  const ON_OPENCODE = { ...ON_CLAUDE, localHarness: "opencode" } as const;
  const skillsNoteEl = () => document.querySelector<HTMLElement>('[data-nav-part="local-skills-note"]');
  const full = (skills: number) => ({ skills, capped: skills >= 200, complete: true });
  const ADVICE = "To shorten it, move skills you do not use out of ~/.claude/skills and ~/.agents/skills; your other Claude Code and agent chats stop seeing them too.";
  const STALL = "On our 48 GB test Mac, busy with other work, chats with 200 skills (about 48,000 tokens) gave no answer in 12 minutes.";

  it("estimates a floor from what was measured: 11,000 tokens plus 155 for each skill", () => {
    expect(OPENCODE_BASE_TOKENS).toBe(11_000);
    expect(OPENCODE_TOKENS_PER_SKILL).toBe(155);
    expect(opencodeFirstPromptTokens(0)).toBe(11_000);
    expect(opencodeFirstPromptTokens(200)).toBe(42_000);
    expect(SKILLS_SLOW_TOKENS).toBe(25_000);
    expect(SKILLS_STALL_TOKENS).toBe(40_000);
  });

  it("says nothing up to 25,000 tokens (90 skills), warns of a slow reply above it, and names the 200-skill test above 40,000 (188 skills)", () => {
    for (const c of [null, undefined, full(0), full(10), full(90), { skills: null, capped: false, complete: false }, { skills: Number.NaN, capped: false, complete: true }]) expect(skillsNote(c)).toBeNull();
    expect(skillsNote(full(91))).toBe(`opencode sends your whole skill list to the model: 91 skills, about 25,000 tokens before your first word. Expect a slow first reply. ${ADVICE}`);
    expect(skillsNote(full(95))).toBe(`opencode sends your whole skill list to the model: 95 skills, about 25,000 tokens before your first word. Expect a slow first reply. ${ADVICE}`);
    expect(skillsNote(full(150))).toBe(`opencode sends your whole skill list to the model: 150 skills, about 34,000 tokens before your first word. Expect a slow first reply. ${ADVICE}`);
    expect(skillsNote(full(187))).toMatch(/187 skills, about 39,000 tokens before your first word\. Expect a slow first reply\./);
    expect(skillsNote(full(188))).toBe(`opencode sends your whole skill list to the model: 188 skills, about 40,000 tokens before your first word. ${STALL} ${ADVICE}`);
    expect(skillsNote(full(190))).toBe(`opencode sends your whole skill list to the model: 190 skills, about 40,000 tokens before your first word. ${STALL} ${ADVICE}`);
  });

  it("at opencode's limit says so and not 'your whole skill list'; a count that stopped early says 'at least'", () => {
    expect(skillsNote({ skills: 200, capped: true, complete: true })).toBe(`opencode sends your skills to the model: 200 skills, opencode's limit, about 42,000 tokens before your first word. ${STALL} ${ADVICE}`);
    expect(skillsNote({ skills: 200, capped: true, complete: true })).not.toMatch(/whole skill list/);
    expect(skillsNote({ skills: 120, capped: false, complete: false })).toBe(`opencode sends your whole skill list to the model: at least 120 skills, about 29,000 tokens or more before your first word. Expect a slow first reply. ${ADVICE}`);
    // An early stop below the threshold is still too small to say anything.
    expect(skillsNote({ skills: 40, capped: false, complete: false })).toBeNull();
    // Claude Code is never named as the way out.
    expect(skillsNote(full(150))).not.toMatch(/Claude Code, which|pick Claude Code/);
  });

  it("shows on opencode where Claude Code is offered, and is not drawn at all for Claude Code", async () => {
    mountHero({ choice: ON_OPENCODE, skills: full(200) });
    await waitFor(() => expect(skillsNoteEl()).not.toBeNull());
    expect(skillsNoteEl()!.textContent).toBe(skillsNote(full(200)));
    expect(skillsNoteEl()!.dataset.level).toBe("stall");
    expect(skillsNoteEl()!.className).not.toMatch(/\binvisible\b/);
    expect(document.querySelector('[data-nav-part="local-harness"]')?.contains(skillsNoteEl())).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    await waitFor(() => expect(skillsNoteEl()).toBeNull());
    expect(document.querySelector<HTMLElement>('[data-nav-part="local-mode-note"]')!.className).not.toMatch(/\binvisible\b/);
    fireEvent.click(screen.getByRole("button", { name: "opencode" }));
    await waitFor(() => expect(skillsNoteEl()).not.toBeNull());
  });

  it("shows nothing for a chat that starts on Claude Code, or for Online", async () => {
    mountHero({ choice: ON_CLAUDE, skills: full(200) });
    await waitFor(() => expect(document.querySelector('[data-nav-part="session-composer"]')?.getAttribute("data-harness")).toBe("claude"));
    expect(skillsNoteEl()).toBeNull();
    fireEvent.click(orb("online"));
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-model"]')).toBeNull());
    expect(skillsNoteEl()).toBeNull();
  });

  it("shows for a model that cannot use tools (opencode), and nothing while the tool check decides", async () => {
    mountHero({ choice: { ...ON_CLAUDE, localModel: "ollama/deepseek-r1-tuned:14b" }, skills: full(120) });
    await waitFor(() => expect(skillsNoteEl()).not.toBeNull());
    expect(skillsNoteEl()!.textContent).toBe(skillsNote(full(120)));
    expect(skillsNoteEl()!.dataset.level).toBe("slow");
    cleanup();
    localStorage.clear();
    mountHero({ choice: ON_CLAUDE, skills: full(200), tools: () => new Promise<never>(() => {}) });
    await screen.findByText(/Checking whether Qwen local can use tools/);
    expect(skillsNoteEl()).toBeNull();
  });

  it("community edition without Claude Code for Local chats: the note shows with the same words", async () => {
    const community = { ...fixtureProfile(), edition: "community" as const, features: { preset: "custom" as const, picks: { "EXTRA-AH": true, "EXTRA-AM": false } } };
    setProfileState({ profile: community, source: "file", errors: [], path: "fixture", stamp: "skills-c1" });
    mountHero({ choice: ON_CLAUDE, skills: { skills: 130, capped: false, complete: false } });
    await waitFor(() => expect(skillsNoteEl()).not.toBeNull());
    expect(document.querySelector('[data-nav-part="local-harness"]')).toBeNull();
    expect(skillsNoteEl()!.textContent).toMatch(/^opencode sends your whole skill list to the model: at least 130 skills/);
  });

  it("is in place in the same render as the model list when the count answers first, so it does not push the box down later", async () => {
    // The count is asked when the screen opens; the model list (opencode) takes longer.
    const seen: Array<{ composer: boolean; note: boolean }> = [];
    const observer = new MutationObserver(() => {
      seen.push({ composer: !!document.querySelector('[data-testid="embedded-composer"]'), note: !!skillsNoteEl() });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      const community = { ...fixtureProfile(), edition: "community" as const, features: { preset: "custom" as const, picks: { "EXTRA-AH": true, "EXTRA-AM": false } } };
      setProfileState({ profile: community, source: "file", errors: [], path: "fixture", stamp: "skills-c2" });
      mountHero({ choice: ON_CLAUDE, skills: full(150), modelsDelay: 50 });
      await screen.findByTestId("embedded-composer");
      await waitFor(() => expect(skillsNoteEl()).not.toBeNull());
    } finally {
      observer.disconnect();
    }
    expect(seen.some((s) => s.composer && !s.note)).toBe(false);
  });

  it("shows nothing when the count is small or not known", async () => {
    for (const skills of [30, null, "fail"] as const) {
      mountHero({ choice: ON_OPENCODE, skills });
      await screen.findByTestId("embedded-composer");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(skillsNoteEl()).toBeNull();
      cleanup();
      localStorage.clear();
      forgetSkillCount();
    }
  });
});

describe("the memory row for an LM Studio model", () => {
  const LM = "lmstudio/qwen/qwen3.8-27b";
  const models = [...LOCAL, { id: LM, model: LM, displayName: "Qwen3.8 27B", isDefault: false }];
  const memory = (slots?: number) => ({ reachable: false, lmStudio: { reachable: true }, loaded: [{ model: LM, bytes: 17_742_039_110, until: null, ...(slots ? { slots } : {}) }], loading: [], failed: [] });
  const slotsEl = () => document.querySelector<HTMLElement>('[data-nav-part="local-memory-slots"]');
  it("says when LM Studio holds the model with several slots, and how to fix it, without reloading it", async () => {
    const { models: list } = mountHero({ choice: { where: "local", online: "full", localModel: LM, localHarness: "claude" }, models, memory: memory(4) });
    await waitFor(() => expect(slotsEl()).not.toBeNull());
    expect(slotsEl()!.textContent).toBe(slotsNote(4));
    expect(slotsNote(4)).toMatch(/4 slots.*Unload, then Load \(Load asks for one slot\)/);
    expect(document.querySelector('[data-nav-part="local-memory"]')!.textContent).toContain("In memory · 18 GB · 4 slots");
    expect(list).toHaveBeenCalled();
  });
  it("says nothing more for one slot, or when LM Studio does not say", async () => {
    for (const slots of [1, undefined]) {
      mountHero({ choice: { where: "local", online: "full", localModel: LM, localHarness: "claude" }, models, memory: memory(slots) });
      await waitFor(() => expect(document.querySelector('[data-nav-part="local-memory"]')?.getAttribute("data-memory")).toBe("loaded"));
      expect(slotsEl()).toBeNull();
      expect(document.querySelector('[data-nav-part="local-memory"]')!.textContent).not.toContain("slots");
      cleanup();
      localStorage.clear();
      forgetLocalModels();
    }
  });
});

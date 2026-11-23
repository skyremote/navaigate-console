// @vitest-environment jsdom
// The Local loadout on screen: the line under the Local orb (asked for only while Claude Code is the harness,
// its height kept while it loads), the panel (bar, quick choices, search, lists, options, save), "Think less"
// seeding bb's own effort picker, the note for a model family that failed our tool tests, and Setup's entry.
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { NewThreadComposerProps } from "@get-bb/plugin-sdk/app";

const composer = vi.hoisted(() => ({ props: null as NewThreadComposerProps | null }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    experimental_NewThreadComposer: (props: NewThreadComposerProps) => {
      composer.props = props;
      return <div data-testid="embedded-composer" data-provider={props.defaultProviderId} data-reasoning={props.defaultReasoningLevel ?? ""} />;
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }));

import { Hero } from "../src/new-thread-hero";
import { forgetLocalModels, forgetSkillCount } from "../src/session-orbs";
import { forgetLoadout, savedText } from "../src/local-loadout-panel";
import { HOME_CHOICE_KEY, type HomeChoice } from "../src/session-profile";

const LOCAL = [
  { id: "ollama/qwen", model: "ollama/qwen", displayName: "Qwen local", isDefault: false },
  { id: "ollama/deepseek-r1:14b", model: "ollama/deepseek-r1:14b", displayName: "deepseek-r1:14b", isDefault: false },
];
const LISTING = {
  skills: [
    { name: "draft-notes", descChars: 300, bodyChars: 6_000 },
    { name: "huge-manual", descChars: 300, bodyChars: 200_000 },
    { name: "tidy-files", descChars: 200, bodyChars: 2_000 },
  ],
  agents: [
    { name: "code-checker", listChars: 500 },
    { name: "planner", listChars: 400 },
  ],
  complete: true,
  others: { skills: 0, agents: 0 },
};
const DEFAULT = { skills: ["draft-notes", "tidy-files"], agents: [], descriptions: false, allTools: false, thinkLess: false };

beforeEach(() => {
  forgetLocalModels();
  forgetSkillCount();
  forgetLoadout();
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, String(v)),
    removeItem: (k: string) => void items.delete(k),
    clear: () => items.clear(),
    key: (i: number) => [...items.keys()][i] ?? null,
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

function mount(opts: { choice?: HomeChoice; choiceState?: typeof DEFAULT; saved?: boolean; tools?: (m: string) => unknown; linked?: { skills: string[]; agents: string[] }; problem?: string | null; use?: unknown; measured?: unknown } = {}) {
  localStorage.setItem(HOME_CHOICE_KEY, JSON.stringify(opts.choice ?? { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "claude" }));
  const host = document.createElement("div");
  host.setAttribute("data-app-composer-role", "primary");
  document.body.appendChild(host);
  const c = opts.choiceState ?? DEFAULT;
  const loadout = vi.fn(() => ({ known: true, listing: LISTING, choice: c, saved: opts.saved ?? false, on: true, linked: opts.linked ?? { skills: c.skills, agents: c.agents }, problem: opts.problem ?? null, measured: opts.measured ?? null }));
  const save = vi.fn((c: typeof DEFAULT) => ({ ok: true, linked: { skills: c.skills.length, agents: c.agents.length }, skipped: [] }));
  renderSlot({ component: Hero }, { composer: host }, {
    rpc: {
      session_profile_config: () => ({ unlockedModels: [], unlockedWords: [], leanReady: true }),
      nas_where: () => {
        throw new Error("no nas");
      },
      local_models_remote: () => ({ remote: [] }),
      local_skills_count: () => ({ skills: 0, capped: false, complete: true }),
      local_model_tools: ({ model }: { model: string }) =>
        (opts.tools ?? ((m: string) => (/deepseek-r1/.test(m) ? { tools: false, why: "family", reason: "x" } : { tools: true, reason: "ok", window: 65_536, need: 65_536 })))(model),
      local_loadout: loadout,
      local_loadout_save: save,
      local_loadout_use: () => opts.use ?? { known: true, counts: {}, partial: false, days: 30 },
    } as never,
    sdk: { threads: { spawn: vi.fn(async () => makeThreadResponse({ id: "t", projectId: "p", environmentId: null })) }, providers: { models: vi.fn(async () => ({ models: LOCAL, modelLoadError: null })) } } as never,
  });
  return { loadout, save };
}
const line = () => document.querySelector<HTMLElement>('[data-nav-part="local-loadout-line"]');

describe("the line under the Local orb", () => {
  it("shows the loadout on the Claude Code harness, telling there are agents to tick", async () => {
    const { loadout } = mount();
    await waitFor(() => expect(line()?.textContent).toBe("2 skills, no agents (2 to tick) · at least about 15,200 tokens before your first word, until a Local chat measures bb's part · Change"));
    expect(loadout).toHaveBeenCalledTimes(1);
    expect(line()?.className).toContain("min-h-[46px]"); // its height is kept while it loads: no shift
  });

  it("uses bb's share measured on this Mac, and says so", async () => {
    mount({ measured: { bb: 9_020, at: Date.UTC(2026, 10, 22, 12), tools: 17, trimmed: true } });
    await waitFor(() => expect(line()?.textContent).toBe("2 skills, no agents (2 to tick) · about 17,500 tokens before your first word, with bb's part measured on this Mac · Change"));
  });

  it("counts what is really linked, and says how many ticked items are not linked yet", async () => {
    mount({ linked: { skills: ["draft-notes"], agents: [] }, problem: "the Local settings folder is missing or is a link, so the loadout is not applied" });
    await waitFor(() => expect(line()?.textContent).toBe("1 skill, no agents (2 to tick) · at least about 15,200 tokens before your first word, until a Local chat measures bb's part · 1 ticked, not linked yet · Change"));
    fireEvent.click(within(line()!).getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Local loadout" });
    await waitFor(() => expect(dialog.querySelector('[data-nav-part="local-loadout-pending"]')?.textContent).toBe("1 ticked item is not given to chats yet: the Local settings folder is missing or is a link, so the loadout is not applied. Save loadout gives them."));
    expect((within(dialog).getByRole("button", { name: "Save loadout" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks nothing while Online is chosen, or while opencode runs the chat (its space is kept, hidden)", async () => {
    const online = mount({ choice: { where: "online", online: "full", localModel: "ollama/qwen", localHarness: "claude" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(online.loadout).not.toHaveBeenCalled();
    cleanup();
    document.body.innerHTML = "";
    const oc = mount({ choice: { where: "local", online: "full", localModel: "ollama/qwen", localHarness: "opencode" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-harness"]')).not.toBeNull());
    expect(line()?.getAttribute("aria-hidden")).toBe("true");
    expect(line()?.className).toContain("invisible");
    expect(oc.loadout).not.toHaveBeenCalled();
  });

  it("for a model family that failed our tool tests: no Claude Code, the plain note, and no loadout line", async () => {
    const { loadout } = mount({ choice: { where: "local", online: "full", localModel: "ollama/deepseek-r1:14b", localHarness: "claude" } });
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-harness-note"]')?.textContent).toBe("Claude Code is not offered for DeepSeek R1 models: two 14B versions did not use tools dependably in our tests, and other versions were not tried. This one runs as a chat model in opencode."));
    expect(document.querySelector('[data-nav-part="local-harness"]')).toBeNull();
    expect(line()).toBeNull();
    expect(loadout).not.toHaveBeenCalled();
  });
});

describe("the Local orb with no model on this Mac", () => {
  it("names the two models we test with and points to the install guide", async () => {
    localStorage.setItem(HOME_CHOICE_KEY, JSON.stringify({ where: "online", online: "full", localModel: null, localHarness: "claude" }));
    const host = document.createElement("div");
    host.setAttribute("data-app-composer-role", "primary");
    document.body.appendChild(host);
    renderSlot({ component: Hero }, { composer: host }, {
      rpc: { session_profile_config: () => ({ unlockedModels: [], unlockedWords: [], leanReady: false }), nas_where: () => { throw new Error("x"); }, local_models_remote: () => ({ remote: [] }), local_skills_count: () => ({ skills: 0, capped: false, complete: true }) } as never,
      sdk: { threads: { spawn: vi.fn() }, providers: { models: vi.fn(async () => ({ models: [], modelLoadError: null })) } } as never,
    });
    await waitFor(() => expect(document.querySelector('[data-nav-part="local-empty-note"]')?.textContent).toBe("The two models we test with are Qwen3.8 27B abliterated (we run it in Claude Code) and DeepSeek R1 14B abliterated (chat in opencode), both on Ollama. How to get them: Main models in the install guide."));
  });
});

describe("the Local loadout panel", () => {
  const open = async () => {
    mount();
    await waitFor(() => expect(line()?.textContent).toContain("2 skills"));
    fireEvent.click(within(line()!).getByRole("button", { name: "Change" }));
    return screen.findByRole("dialog", { name: "Local loadout" });
  };

  it("opens from Change with the bar, the options off, the oversized skill marked and left unticked", async () => {
    const dialog = await open();
    expect(within(dialog).getByRole("status").textContent).toBe("Plenty of room: at most about 29,200 tokens left before Claude Code starts to shorten the chat.");
    expect(dialog.textContent).toContain("Claude Code starts to shorten the chat at 44,344 of a 65,536-token window");
    expect(dialog.textContent).toContain("bb's part at least about 6,700, an estimate");
    expect(dialog.textContent).toContain("bb's part is not measured on this Mac yet, so at least about 6,700 (a clean bb's) is used; connectors add more. The first Local chat on Claude Code measures it, if its runner reports how many tokens it read.");
    expect(dialog.textContent).toContain("nearly free (about 6 tokens)");
    for (const name of [/Show skill descriptions/, /Keep every Claude Code tool/, /Think less/]) expect((within(dialog).getByLabelText(name) as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByLabelText("Keep every Claude Code tool (adds about 10,000 tokens to every first prompt; brings back scheduling and loops)")).toBeTruthy();
    const huge = within(dialog).getByLabelText("huge-manual") as HTMLInputElement;
    expect(huge.checked).toBe(false);
    expect(huge.closest("li")?.getAttribute("data-oversized")).toBe("true");
    expect(huge.closest("li")?.textContent).toContain("too large: over a third of the room");
    expect((within(dialog).getByLabelText("draft-notes") as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText("code-checker") as HTMLInputElement).checked).toBe(false);
  });

  it("with bb's share measured on this Mac: the bar, its words and its state use that figure, and say where it came from", async () => {
    mount({ measured: { bb: 9_020, at: Date.UTC(2026, 10, 22, 12), tools: 17, trimmed: true } });
    await waitFor(() => expect(line()?.textContent).toContain("2 skills"));
    fireEvent.click(within(line()!).getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog", { name: "Local loadout" });
    expect(within(dialog).getByRole("status").textContent).toBe("Plenty of room: about 26,800 tokens left before Claude Code starts to shorten the chat.");
    expect(dialog.textContent).toContain("bb's part about 9,000, measured on this Mac");
    expect(dialog.textContent).toContain("bb's part was measured at the first request of a Local chat on Claude Code on this Mac on 22 November, and is used with your tools and loadout as they are now. It changes when bb or its connectors change, and with the memory notes of the chat's project; a later Local chat can measure it again.");
    expect(dialog.textContent).not.toContain("an estimate");
    expect(dialog.querySelector('[data-nav-part="local-loadout-bar"]')?.getAttribute("data-room")).toBe("plenty");
  });

  it("moves the bar with each tick and option, and the quick choices set the lists", async () => {
    const dialog = await open();
    const status = () => within(dialog).getByRole("status").textContent;
    fireEvent.click(within(dialog).getByLabelText("huge-manual"));
    expect(status()).toMatch(/^Plenty of room/);
    fireEvent.click(within(dialog).getByLabelText(/Keep every Claude Code tool/));
    expect(status()).toMatch(/about 18,800 tokens left/);
    fireEvent.click(within(dialog).getByRole("button", { name: "All skills and agents" }));
    expect((within(dialog).getByLabelText("planner") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "None" }));
    expect((within(dialog).getByLabelText("draft-notes") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to what I had" }));
    expect((within(dialog).getByLabelText("draft-notes") as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText("planner") as HTMLInputElement).checked).toBe(false);
  });

  it("searches both lists by name", async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("Search skills and agents"), { target: { value: "plan" } });
    expect(within(dialog).queryByLabelText("draft-notes")).toBeNull();
    expect(within(dialog).getByLabelText("planner")).toBeTruthy();
  });

  it("saves the choice by itself and says what open chats see; the line follows", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByLabelText("planner"));
    fireEvent.click(within(dialog).getByLabelText(/Think less/));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save loadout" }));
    });
    await waitFor(() => expect(dialog.querySelector('[data-nav-part="local-loadout-result"]')?.textContent).toBe("Saved: 2 skills and 1 agent given to Local chats on Claude Code. Chats already open get newly ticked skills and agents the next time bb starts Claude Code for them. Skills and agents you untick stay named in what those chats have already read, and changing an option makes their next reply read the whole chat again."));
    expect(line()?.textContent).toContain("2 skills, 1 agent");
    // Think less: the box's own effort picker starts at low, for a Local chat on Claude Code.
    await waitFor(() => expect(screen.getByTestId("embedded-composer").dataset.reasoning).toBe("low"));
  });

  it("is keyboard usable: focus starts inside it, and Escape closes it", async () => {
    const dialog = await open();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says how many of the ticked skills would get a description", async () => {
    const dialog = await open();
    expect(dialog.textContent).toContain("All 2 of your ticked skills fit (the list has room for about 13,300 characters).");
  });
});

describe("Most used", () => {
  const openWith = async (use: unknown) => {
    mount({ use });
    await waitFor(() => expect(line()?.textContent).toContain("2 skills"));
    fireEvent.click(within(line()!).getByRole("button", { name: "Change" }));
    return screen.findByRole("dialog", { name: "Local loadout" });
  };

  it("ticks the most used skills, never a too-large one, leaves agents as they are, and shows each count", async () => {
    const dialog = await openWith({ known: true, counts: { "tidy-files": 14, "huge-manual": 50, "draft-notes": 1 }, partial: false, days: 30 });
    await waitFor(() => expect(dialog.querySelector('[data-nav-part="local-loadout-use-source"]')?.textContent).toBe("Counted from Claude Code chats on this Mac that changed in the last 30 days, including their older messages."));
    const used = [...dialog.querySelectorAll('[data-nav-part="local-loadout-used"]')].map((e) => e.textContent);
    expect(used).toEqual(["found once in the chats read", "found 50 times in the chats read", "found 14 times in the chats read"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "None" }));
    fireEvent.click(within(dialog).getByLabelText(/^planner/));
    fireEvent.click(within(dialog).getByRole("button", { name: "Most used" }));
    expect((within(dialog).getByLabelText(/^tidy-files/) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(/^draft-notes/) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(/^huge-manual/) as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByLabelText(/^planner/) as HTMLInputElement).checked).toBe(true);
  });

  it("says when the count is partial", async () => {
    const dialog = await openWith({ known: true, counts: { "tidy-files": 2 }, partial: true, days: 30 });
    await waitFor(() => expect(dialog.querySelector('[data-nav-part="local-loadout-use-source"]')?.textContent).toBe("Counted from Claude Code chats on this Mac that changed in the last 30 days, including their older messages. Partial: the count stopped before it had read every chat."));
  });

  it("is disabled with a plain reason when no use was found", async () => {
    const dialog = await openWith({ known: true, counts: {}, partial: false, days: 30 });
    await waitFor(() => expect(dialog.querySelector('[data-nav-part="local-loadout-most-used-why"]')?.textContent).toBe("Most used: no use of these skills was found in the chats read."));
    expect((within(dialog).getByRole("button", { name: "Most used" }) as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.querySelector('[data-nav-part="local-loadout-used"]')).toBeNull();
  });
});

describe("what a save says", () => {
  it("names what was left out and why", () => {
    expect(savedText({ ok: true, linked: { skills: 1, agents: 0 }, skipped: [{ kind: "skill", name: "a", why: "taken" }, { kind: "agent", name: "b", why: "failed" }] })).toBe(
      "Saved: 1 skill and 0 agents given to Local chats on Claude Code. Chats already open get newly ticked skills and agents the next time bb starts Claude Code for them. Skills and agents you untick stay named in what those chats have already read, and changing an option makes their next reply read the whole chat again. Left out, because something of yours already has the name in the Local settings folder: a. Left out, because this system refused the link (nothing was copied): b.",
    );
    expect(savedText({ ok: false, reason: "Local chats on Claude Code are off in Setup, so the loadout is not saved.", linked: { skills: 0, agents: 0 }, skipped: [] })).toMatch(/are off in Setup/);
  });
});

describe("Think less is off by default", () => {
  it("leaves bb's effort picker as it is", async () => {
    mount();
    await waitFor(() => expect(line()?.textContent).toContain("2 skills"));
    expect(screen.getByTestId("embedded-composer").dataset.reasoning).toBe("");
  });
});

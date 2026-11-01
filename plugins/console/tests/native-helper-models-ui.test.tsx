// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { HelperModels } from "../src/delivery-helpers";
import { resetRpcFlight } from "../src/rpc-flight";

afterEach(cleanup);
const haiku = { providerId: "claude-code", model: "claude-haiku-4-5", reasoningLevel: "low" };
const codex = { providerId: "codex", model: "gpt-5.5", reasoningLevel: "low" };
const empty = { choices: { title: null, commit: null }, runs: [], serviceRegistered: true };
const services = {
  selections: { "thread-title": { mode: "automatic" }, "commit-message": { mode: "automatic" }, voice: { mode: "automatic" } },
  services: [
    { id: "title-model", pluginId: "test-plugin", displayName: "Console: chosen title model", automaticRank: null, status: { ready: true } },
    { id: "title-model", pluginId: "provider-codex", displayName: "Codex: chosen title model", automaticRank: null, status: { ready: false, message: "Choose titleHelperModel in Codex plugin settings." } },
  ],
};
const selections: unknown[] = [];
function show(choice: typeof haiku | typeof codex | null, purpose: "title" | "commit" | "review", extra: { sdk?: object; rpc?: object } = {}) {
  selections.length = 0;
  const saved: unknown[] = [];
  const view = renderSlot(
    { component: HelperModels },
    { choice: choice ?? { providerId: "", model: "", reasoningLevel: "medium" }, purpose },
    {
      pluginId: "test-plugin",
      rpc: {
        delivery_helper_models: () => empty,
        delivery_helper_models_set: (input: unknown) => (saved.push(input), { ...empty, choices: { title: haiku, commit: null } }),
        ...(extra.rpc ?? {}),
      },
      sdk: {
        system: {
          aiServices: async () => services,
          setAiServiceSelection: async (input: unknown) => (selections.push(input), services),
          testAiService: async () => ({ ok: true, displayName: "Console: chosen title model", durationMs: 812, pluginId: "test-plugin", serviceId: "title-model", text: "Fix login redirect" }),
        },
        plugins: { updateSettings: vi.fn(async () => ({})) },
        ...(extra.sdk ?? {}),
      } as never,
    } as never,
  );
  return { view, selections, saved };
}
describe("who writes titles and commit messages", () => {
  it("shows which service each task uses now", async () => {
    show(null, "review");
    await screen.findByText("Titles");
    expect(await screen.findAllByText(/Automatic: bb picks the first ready service/)).toHaveLength(2);
  });
  it("tests a helper and shows the service, time and the text it wrote", async () => {
    show(haiku, "title");
    fireEvent.click(await screen.findByRole("button", { name: "Test the title helper" }));
    expect(await screen.findByText(/Console: chosen title model answered in 812 ms: .Fix login redirect./)).toBeTruthy();
  });
  it("lets a Claude model write titles and selects the Console service for it", async () => {
    const { saved, selections } = show(haiku, "title");
    const apply = await screen.findByRole("button", { name: "Use chosen model for automatic title helper" });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(selections).toHaveLength(1));
    expect(saved).toEqual([{ purpose: "title", choice: haiku }]);
    expect(selections[0]).toEqual({ task: "thread-title", selection: { mode: "service", pluginId: "test-plugin", serviceId: "title-model" } });
    expect(await screen.findByText(/Automatic title helper now uses claude-haiku-4-5/)).toBeTruthy();
  });
  it("sends a Codex model through Codex's own helper as before", async () => {
    const update = vi.fn(async () => ({}));
    const { selections, saved } = show(codex, "commit", { sdk: { plugins: { updateSettings: update } } });
    fireEvent.click(await screen.findByRole("button", { name: "Use chosen model for automatic commit helper" }));
    await waitFor(() => expect(selections).toHaveLength(1));
    expect(update).toHaveBeenCalledWith({ pluginId: "provider-codex", values: { commitHelperModel: "gpt-5.5" } });
    expect(selections[0]).toEqual({ task: "commit-message", selection: { mode: "service", pluginId: "provider-codex", serviceId: "commit-model" } });
    expect(saved).toEqual([]);
  });
  it("refuses other providers instead of failing quietly", async () => {
    show({ providerId: "gemini", model: "gemini-3", reasoningLevel: "" } as never, "title");
    const apply = (await screen.findByRole("button", { name: "Use chosen model for automatic title helper" })) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.getByText("Titles and commit messages can use a Codex or a Claude model.")).toBeTruthy();
  });
  it("lists the latest runs with the model that wrote each", async () => {
    show(haiku, "title", {
      rpc: {
        delivery_helper_models: () => ({
          ...empty,
          runs: [
            { at: 1_800_000_000_000, purpose: "title", providerId: "claude-code", model: "claude-haiku-4-5", ok: true, ms: 640, preview: "Fix login redirect", error: null },
            { at: 1_799_999_000_000, purpose: "commit", providerId: "claude-code", model: "claude-haiku-4-5", ok: false, ms: 90, preview: "", error: "claude exited 1: not logged in" },
          ],
        }),
      },
    });
    expect(await screen.findByText(/title.*claude-haiku-4-5.*640 ms.*Fix login redirect/)).toBeTruthy();
    expect(await screen.findByText(/commit.*claude-haiku-4-5.*failed.*not logged in/)).toBeTruthy();
  });
  it("can hand a task back to automatic", async () => {
    const own = { ...services, selections: { ...services.selections, "thread-title": { mode: "service", pluginId: "test-plugin", serviceId: "title-model" } } };
    const { selections } = show(haiku, "title", { sdk: { system: { aiServices: async () => own, setAiServiceSelection: async (input: unknown) => (selections.push(input), own), testAiService: async () => ({}) } } });
    await screen.findByText(/Console: chosen title model \(ready\)/);
    fireEvent.click(screen.getByRole("button", { name: "Return titles to automatic" }));
    await waitFor(() => expect(selections).toEqual([{ task: "thread-title", selection: { mode: "automatic" } }]));
  });
  it("forgets the saved Claude model when a task goes back to automatic, so automatic cannot pick it again", async () => {
    const own = { ...services, selections: { ...services.selections, "thread-title": { mode: "service", pluginId: "test-plugin", serviceId: "title-model" } } };
    const { selections, saved } = show(haiku, "title", { sdk: { system: { aiServices: async () => own, setAiServiceSelection: async (input: unknown) => (selections.push(input), own), testAiService: async () => ({}) } } });
    await screen.findByText(/Console: chosen title model \(ready\)/);
    fireEvent.click(screen.getByRole("button", { name: "Return titles to automatic" }));
    await waitFor(() => expect(selections).toEqual([{ task: "thread-title", selection: { mode: "automatic" } }]));
    expect(saved).toEqual([{ purpose: "title", choice: null }]);
  });
  it("switches the task to automatic before clearing the saved model, so a failed clear never leaves it on a service that is not ready", async () => {
    const own = { ...services, selections: { ...services.selections, "thread-title": { mode: "service", pluginId: "test-plugin", serviceId: "title-model" } } };
    const { selections, saved } = show(haiku, "title", {
      rpc: { delivery_helper_models_set: async () => { throw new Error("save failed"); } },
      sdk: { system: { aiServices: async () => own, setAiServiceSelection: async (input: unknown) => (selections.push(input), own), testAiService: async () => ({}) } },
    });
    await screen.findByText(/Console: chosen title model \(ready\)/);
    fireEvent.click(screen.getByRole("button", { name: "Return titles to automatic" }));
    await screen.findByText(/save failed/);
    expect(selections).toEqual([{ task: "thread-title", selection: { mode: "automatic" } }]);
    expect(saved).toEqual([]);
  });
  it("still says the host offers no AI services when the button is pressed before the panel has loaded", async () => {
    const { saved, selections } = show(haiku, "title", {
      rpc: { delivery_helper_models: async () => (await new Promise((resolve) => setTimeout(resolve, 30)), { ...empty, serviceRegistered: false }) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Use chosen model for automatic title helper" }));
    expect(await screen.findByText(/does not offer AI services/)).toBeTruthy();
    expect(saved).toEqual([]);
    expect(selections).toEqual([]);
  });
  it("coalesces a burst of helper events into a few reads, and holds them while the document is hidden", async () => {
    resetRpcFlight();
    let reads = 0;
    const { view } = show(haiku, "title", { rpc: { delivery_helper_models: async () => (reads++, await new Promise((resolve) => setTimeout(resolve, 20)), empty) } });
    await waitFor(() => expect(reads).toBe(1));
    await act(async () => {
      for (let wave = 0; wave < 5; wave++) {
        await Promise.all(Array.from({ length: 10 }, () => view.behavior.emitRealtime("delivery-helper-models", {})));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(reads).toBeLessThanOrEqual(3);
    const before = reads;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => {
      await Promise.all(Array.from({ length: 50 }, () => view.behavior.emitRealtime("delivery-helper-models", {})));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(reads).toBe(before);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
});

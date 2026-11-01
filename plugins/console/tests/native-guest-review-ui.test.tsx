// @vitest-environment jsdom
import React from "react";
import { cleanup, configure, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ContextWorkspacePopup } from "../src/context-workspace";

configure({ asyncUtilTimeout: 5000 });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function mount() {
  const created: unknown[] = [];
  const view = renderSlot({ component: ContextWorkspacePopup }, {}, {
    context: { projectId: "proj_test", threadId: null },
    composer: { text: "Draft", scope: { kind: "new-thread" } },
    rpc: {
      context_drafts_list: () => [], context_reviews_list: () => [],
      context_review_create: (input: unknown) => { created.push(input); return { id: "rev_1", url: "https://example.test/review/abc", expiresAt: Date.now() + 86_400_000 }; },
    } as never,
    sdk: { projects: { get: async () => ({ id: "proj_test", name: "Atlas" }) } } as never,
  });
  return { view, created };
}
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("guest review links offer one hour or 24 hours", () => {
  it("lists both lifetimes, defaulting to one hour", async () => {
    mount();
    openTab("Reviews");
    const select = (await screen.findByLabelText("Guest link expiry")) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["1 hour", "24 hours"]);
    expect(select.value).toBe("60");
  });

  it("creates a link that lasts the chosen time", async () => {
    const { created } = mount();
    openTab("Context");
    fireEvent.change(await screen.findByLabelText("Exact quoted text"), { target: { value: "The plan is to ship on Friday." } });
    fireEvent.click(screen.getByRole("button", { name: "Add excerpt to review selection" }));
    openTab("Reviews");
    fireEvent.change(screen.getByLabelText("Review title"), { target: { value: "Release plan" } });
    fireEvent.change(screen.getByLabelText("Guest link expiry"), { target: { value: "1440" } });
    fireEvent.click(screen.getByRole("button", { name: "Create guest link for these excerpts" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ title: "Release plan", expiresInMinutes: 1440 });
  });

  it("keeps one hour when the picker is left alone", async () => {
    const { created } = mount();
    openTab("Context");
    fireEvent.change(await screen.findByLabelText("Exact quoted text"), { target: { value: "Keep it short." } });
    fireEvent.click(screen.getByRole("button", { name: "Add excerpt to review selection" }));
    openTab("Reviews");
    fireEvent.change(screen.getByLabelText("Review title"), { target: { value: "Short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create guest link for these excerpts" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ expiresInMinutes: 60 });
  });
});

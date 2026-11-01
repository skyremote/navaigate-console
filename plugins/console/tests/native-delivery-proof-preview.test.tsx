// @vitest-environment jsdom
// Writes static preview pages of the Attach proof to PR flow from the real rendered markup when VIS_NONE_OUT is set.
import React from "react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DeliveryDetail } from "../src/delivery";
import { HomePage } from "../src/home";
import type { PullRequest } from "../delivery-contract";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const out = process.env.VIS_NONE_OUT;
const fixture = out ? readFileSync(join(out, "fixture-console.png")) : Buffer.alloc(0);
const dataUrl = `data:image/png;base64,${fixture.toString("base64")}`;
const pr: PullRequest = {
  number: 214, title: "Console: Stash view for quiet chats", state: "open", url: "https://github.com/example/console/pull/214", baseRefName: "main", headRefName: "navaigate/stash", updatedAt: "2026-11-01T09:30:00Z",
  autoMerge: false, inMergeQueue: false,
  checks: { state: "passing", totalCount: 6, passedCount: 6, failedCount: 0, pendingCount: 0 },
  review: { state: "approved", reviewRequestCount: 0 },
  mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, attention: "ready_to_merge",
};
const environment = { id: "e1", projectId: "p1", hostId: "laptop", name: "stash-view", path: "/work/stash-view", status: "ready" };
const receipt = {
  uploaded: true as const, repo: "example/console", pr: 214, prUrl: pr.url, branch: "delivery-proof", commit: "9f2c1d7a4be03a6c58d1e0f7b2a94c3d5e6f7a8b", uploadedAt: "2026-11-01T09:41:07Z",
  accessPolicy: "Private repository: visible only to people with read access to example/console.", expiry: "None: kept until the delivery-proof branch is deleted.",
  files: [{ name: "stash-view.png", bytes: fixture.length, mime: "image/png", sha256: "a".repeat(64), path: "pr-214/20261101T094107Z/aaaaaaaaaaaa-stash-view.png", url: "https://github.com/example/console/blob/9f2c1d7/pr-214/stash-view.png?raw=true", verified: true }],
  comment: { id: 4, url: "https://github.com/example/console/pull/214#issuecomment-4401", verified: true },
};

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  URL.createObjectURL = () => dataUrl;
  URL.revokeObjectURL = () => {};
});
afterEach(() => cleanup());

function save(name: string, mode: "light" | "dark" = "light") {
  for (const box of document.body.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) box.toggleAttribute("checked", box.checked);
  mkdirSync(join(out!, "pages"), { recursive: true });
  const css = ["host-abs.css", "plugin-app.css"].map((f) => readFileSync(join(out!, f), "utf8")).join("\n");
  const theme = readFileSync(join(__dirname, "..", "themes", "navaigate.css"), "utf8");
  const styles = [...document.head.querySelectorAll("style")].map((s) => s.textContent).join("\n");
  const page = `<!doctype html><html lang="en-GB" class="${mode}"><head><meta charset="utf-8"><title>${name}</title><style>${css}</style><style>${styles}</style><style>${theme}</style>`
    + `<style>body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--font-sans)} .wrap{max-width:760px;margin:0 auto;padding:24px}</style></head>`
    + `<body><div class="wrap" data-bb-plugin="navaigate-skin">${document.body.innerHTML}</div></body></html>`;
  writeFileSync(join(out!, "pages", `${name}.html`), page);
}

describe.skipIf(!out)("Attach proof to PR preview pages", () => {
  it("writes the PR section, the filled form, the receipt and the Home entry", async () => {
    const handler = vi.fn(async () => receipt);
    renderSlot(
      { component: () => <DeliveryDetail environment={environment} result={{ outcome: "available", pullRequest: pr } as never} /> },
      {},
      { rpc: { delivery_attach_proof: handler } as never, sdk: { plugins: { callRpc: async () => ({ ok: true }) } as never } },
    );
    save("f83-1-pr-section");
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    const input = screen.getByLabelText("Choose proof files") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([fixture], "stash-view.png", { type: "image/png" })] } });
    await screen.findByText("stash-view.png");
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    fireEvent.change(within(form).getByLabelText(/Note above the media/), { target: { value: "Stash view with three quiet chats, checked on Laptop build." } });
    fireEvent.click(within(form).getByRole("checkbox"));
    save("f83-2-form-ready");
    fireEvent.click(within(form).getByRole("button", { name: /Upload and comment/ }));
    await screen.findByRole("status", { name: "Proof receipt" });
    save("f83-3-receipt");
    expect(handler).toHaveBeenCalled();
    cleanup();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    renderSlot({ component: HomePage }, {}, { rpc: { home_accounts: () => ({ accounts: [] }), usage_trend: () => ({ now: Date.now(), sampledFrom: null, accounts: [] }), home_brief: () => ({ headline: "Three PRs waiting on proof", date: "1 Nov" }), home_agenda: () => ({ configured: true, error: null, reconnect: [], events: [] }), ask_log: () => ({ recent: [], jevDecisions: 0, overrides: 0 }), fleet_board: () => ({ available: false, board: null, error: "offline" }) } as never });
    save("f83-4-home-entry");
    vi.unstubAllGlobals();
  });
});

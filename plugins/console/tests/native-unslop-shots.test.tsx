// @vitest-environment jsdom
// Writes static preview pages of the Ask and Tell dialog, the account chips and
// the Delivery model settings from fixture data when UNSLOP_OUT is set.
import React from "react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, configure, fireEvent, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { RemoteThread } from "../src/machines";
import { RemoteList } from "../src/machine-row";
import { ComposerChips } from "../src/composer-chips";
import { DeliverySettings } from "../src/delivery";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() } }));
configure({ asyncUtilTimeout: 5000 });

const OUT = process.env.UNSLOP_OUT;
const CSS = (process.env.UNSLOP_CSS ?? "").split(",").filter(Boolean).map((file) => readFileSync(file, "utf8")).join("\n");
const THEME = process.env.UNSLOP_THEME ? readFileSync(process.env.UNSLOP_THEME, "utf8") : "";
const NOW = 1_800_000_000_000;

function page(name: string, html: string, width = 360) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const head = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  for (const mode of ["light", "dark"] as const) {
    writeFileSync(join(OUT, `${name}-${mode}.html`), `<!doctype html><html lang="en-GB" class="${mode}"><head><meta charset="utf-8"><title>${name}</title><style>${CSS}</style><style>${head}</style><style>${THEME}</style><style>body{margin:0;padding:24px;background:var(--background);color:var(--foreground);font-family:var(--font-sans, system-ui)} .pv-col{width:${width}px;background:var(--sidebar, var(--background));border:1px solid var(--border);border-radius:8px;padding:8px}</style></head><body data-bb-plugin="navaigate-skin"><div class="pv-col">${html}</div></body></html>`);
  }
}

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

const remote: RemoteThread = { id: "thr_a", machine: "studio", title: "Fix the invoice export", via: "srv-studio", url: "https://studio.example.test/threads/thr_a", state: "idle", projectName: "Atlas", providerId: "codex", updatedAt: NOW - 3_600_000 } as RemoteThread;

describe.skipIf(!OUT)("unslop preview pages", () => {
  it("the remote row with Ask and Tell", async () => {
    const view = renderSlot({ component: () => <RemoteList sections={[{ name: "Atlas", threads: [remote, { ...remote, id: "thr_b", title: "Nightly render", state: "running" } as RemoteThread] }]} now={NOW} onOpen={() => {}} /> }, {}, { rpc: { fleet_tell: () => ({ offered: true, requestId: "r", delivered: true, delivery: "delivered", url: remote.url }) } as never });
    page("remote-row", view.container.innerHTML);
    fireEvent.click(screen.getAllByRole("button", { name: /Ask or tell Studio about Fix the invoice export/ })[0]);
    await screen.findByText("Tell Studio about Fix the invoice export");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Use the new schema for the export" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send to Studio/ }));
    await screen.findByRole("status");
    page("remote-tell", document.body.innerHTML, 420);
  });

  it("the account chips for Claude and Codex", async () => {
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
    const thread = (providerId: string) => ({ id: "t1", projectId: "p1", title: "Chat", displayTitle: "Chat", status: "idle", runtimeStatus: "idle", queuedWork: "none", activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", isHidden: false, providerId, href: "/projects/p1/threads/t1" }) as unknown as PluginSidebarThread;
    for (const [name, provider] of [["chips-claude", "claude-code"], ["chips-codex", "codex"]] as const) {
      document.body.innerHTML = `<div data-follow-up-composer-footer><div class="left"></div></div>`;
      window.history.pushState({}, "", "/projects/p1/threads/t1");
      renderSlot({ component: ComposerChips }, {}, {
        rpc: { pool_list: (input: { provider: "claude" | "codex" }) => ({ accounts: accounts[input.provider], error: null }), pool_account: (input: { provider: string }) => ({ accountId: input.provider === "codex" ? "x2" : "c1", activeAccountId: input.provider === "codex" ? "x1" : "c1" }), teleport_link: () => ({ from: null, to: null, via: null, branch: null, at: null, onM1: false, sha: null, verified: null }) } as never,
        sdk: { threads: { context: async () => ({ usage: { snapshot: { providerSessionId: "sess-1" } } }) as never } } as never,
        sidebarThreads: { status: "ready", threads: [thread(provider)], projects: [], sections: [] },
        context: { threadId: "t1", projectId: "p1" },
      });
      const chip = await waitFor(() => screen.getByTitle(/This chat runs on|has not been pinned|New .* chats start/));
      fireEvent.pointerDown(chip, { button: 0, ctrlKey: false });
      await screen.findByRole("menu");
      page(name, document.body.innerHTML, 480);
      cleanup(); document.body.innerHTML = "";
    }
  });

  it("the Delivery model settings", async () => {
    const choice = { providerId: "codex", model: "gpt-5.5", reasoningLevel: "medium" };
    const purposes = ["title", "commit", "pull-request", "review", "research"] as const;
    const cells = (state: string) => purposes.map((purpose) => ({ purpose, choice: state === "unset" ? null : choice, source: state === "unset" ? null : { projectId: "p", hostId: null }, state, reason: `${state} reason` }));
    const services = { selections: { "thread-title": { mode: "automatic" }, "commit-message": { mode: "automatic" }, voice: { mode: "automatic" } }, services: [{ id: "title-model", pluginId: "test-plugin", displayName: "Console: chosen title model", automaticRank: null, status: { ready: true } }] };
    const view = renderSlot({ component: DeliverySettings }, {}, {
      context: { projectId: "proj-1", threadId: null },
      rpc: {
        delivery_settings: () => ({ revision: 1, entries: [], resolved: purposes.map((purpose) => ({ purpose, choice, source: { projectId: "proj-1", hostId: null } })), appliedTo: "delivery-tasks", remoteApplied: false }),
        delivery_matrix: () => ({ revision: 1, readAt: NOW, hosts: [{ hostId: "m1", name: "Studio", connected: true, cells: cells("applied") }, { hostId: "m5", name: "Laptop", connected: true, cells: cells("unset") }, { hostId: "m4", name: "Work", connected: false, cells: cells("unverified") }] }),
        delivery_helper_models: () => ({ choices: { title: { providerId: "claude-code", model: "claude-haiku-4-5", reasoningLevel: "low" }, commit: null }, runs: [], serviceRegistered: true }),
      },
      sdk: { system: { aiServices: async () => services } } as never,
    } as never);
    await waitFor(() => { if (!view.container.querySelector("table")) throw new Error("waiting"); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    page("delivery-models", view.container.innerHTML, 900);
  });
});

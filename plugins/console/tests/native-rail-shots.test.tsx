// @vitest-environment jsdom
// Renders the changed rail surfaces from fixture data. With VIS_RAIL_OUT set it
// also writes one static page per surface, for screenshots outside the live app.
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rail } from "../src/rail";
import { AttentionPage } from "../src/attention";
import { StashPage } from "../src/stash";
import type { FleetBoard } from "../src/machines";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(() => 1), error: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn() }) }));

const ROOT = join(__dirname, "..");
const OUT = process.env.VIS_RAIL_OUT;
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const svg = (bg: string, fg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${bg}"/><path d="Work 12V4l8 8V4" stroke="${fg}" stroke-width="1.6" fill="none"/></svg>`)}`;

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, String(value)); },
    removeItem: (name: string) => { items.delete(name); }, clear: () => items.clear(), key: (index: number) => [...items.keys()][index] ?? null,
    get length() { return items.size; },
  });
  window.matchMedia = vi.fn((query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} })) as never;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function thread(id: string, title: string, projectId: string, over: Record<string, unknown> = {}): PluginSidebarThread {
  return {
    id, projectId, title, titleFallback: null, displayTitle: title, parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
    sectionId: null, originKind: null, originPluginId: null, providerId: "claude-code", status: "idle", runtimeStatus: "idle", queuedWork: "none",
    hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", indicatorLabel: null,
    isUnread: false, isPinned: false, pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/${projectId}/threads/${id}`,
    isHidden: false, environment: null, host: null, createdAt: NOW - 5 * HOUR, updatedAt: NOW - HOUR, lastActivityAt: NOW - HOUR,
    ...over,
  } as unknown as PluginSidebarThread;
}
const threads = [
  thread("t1", "Release dry run", "p1", { status: "active", runtimeStatus: "active", updatedAt: NOW - 60_000 }),
  thread("t2", "Ember theme polish", "p1", { providerId: "codex", updatedAt: NOW - 20 * 60_000 }),
  thread("t3", "Invoice INV-041", "p2", { updatedAt: NOW - 2 * HOUR }),
  thread("t4", "Course lesson cover", "p2", { updatedAt: NOW - 5 * HOUR }),
  thread("t5", "Survey export", "p3", { updatedAt: NOW - 7 * HOUR }),
  thread("old1", "Pricing page idea", "p2", { updatedAt: NOW - 9 * DAY }),
  thread("old2", "Old Zoom notes", "p3", { updatedAt: NOW - 12 * DAY }),
];
const projects = [
  { id: "p1", name: "Atlas", isPersonal: false, href: "/p1", settingsHref: "/s/p1", experimental_icon: { imageUrl: svg("#2f6fed", "#fff"), monogram: "N", hue: 260 } },
  { id: "p2", name: "Admin", isPersonal: false, href: "/p2", settingsHref: "/s/p2", experimental_icon: { imageUrl: null, monogram: "AD", hue: 150 } },
  { id: "p3", name: "Survey app", isPersonal: false, href: "/p3", settingsHref: "/s/p3", experimental_icon: { imageUrl: null, monogram: "B", hue: 25 } },
];
const policy = { autoMerge: false, requiredPrUrls: [], requiredPrEnvironments: {}, acceptancePending: true, inactiveAfterMs: null };
const rec = (threadId: string) => ({ threadId, mode: "stashed", wakeAt: null, changedAt: NOW, revision: null, policy });
const row = (threadId: string, title: string, status: string, over: Record<string, unknown> = {}) => ({ threadId, title, hostId: "h", environmentId: null, status, question: null, updatedAt: NOW - HOUR, pinned: false, wakeAt: null, ...over });
const pr = (number: number, checks: string, failedCount = 0) => ({ number, url: `https://github.com/example/x/pull/${number}`, state: "open", checks, failedCount });
const board: FleetBoard = {
  serverId: "srv-laptop", serverKey: "laptop",
  columns: [
    { key: "laptop", label: "laptop", serverId: "srv-laptop", online: true, lastSeenAt: NOW, threads: [], resources: { observedAt: NOW, cpuCount: 12, cpuUtilization: 0.18, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 14 * 1024 ** 3 } },
    { key: "studio", label: "studio", serverId: "srv-studio", online: true, lastSeenAt: NOW, mirror: true, threads: [
      { id: "r1", title: "Nightly render", state: "idle", machine: "studio", projectName: "Atlas", providerId: "claude-code", updatedAt: NOW - HOUR, url: "https://m1/threads/r1", via: "srv-studio" },
      { id: "r2", title: "Course upload retry", state: "needs-you", machine: "studio", projectName: "Admin", providerId: "codex", updatedAt: NOW - 2 * HOUR, url: "https://m1/threads/r2", via: "srv-studio" },
      { id: "r3", title: "Podcast cut", state: "idle", machine: "studio", projectName: "Admin", providerId: "claude-code", updatedAt: NOW - 3 * HOUR, url: "https://m1/threads/r3", via: "srv-studio" },
    ] },
    { key: "work", label: "work", serverId: "srv-work", online: false, lastSeenAt: NOW - 2 * HOUR, threads: [] },
  ],
};

function mount(component: () => React.ReactElement, o: { rpc?: Record<string, unknown>; styles?: Record<string, unknown>; sdk?: Record<string, unknown> } = {}) {
  const callRpc = async ({ method }: { method: string }) => {
    if (method === "list") return { folders: [
      { id: "f1", projectId: "p2", hostId: "h", parentId: null, name: "Clients", path: "/p2/Clients" },
      { id: "f2", projectId: "p2", hostId: "h", parentId: null, name: "Invoices", path: "/p2/Invoices" },
    ], roots: [{ id: "root:p2", projectId: "p2", hostId: "h", parentId: null, name: "Admin", path: "/p2" }], bindings: {}, places: { t3: "f2", t4: "f1" } };
    if (method === "prefs_get") return { prefs: {}, items: o.styles ?? {}, stored: true };
    throw new Error(`no ${method}`);
  };
  return renderSlot({ component }, {}, {
    sidebarThreads: { status: "ready", threads, projects: projects as never, sections: [] },
    rpc: { attention_state: () => ({ records: [rec("old1"), rec("old2")], foldWorking: false }), thread_accounts: () => ({ threads: {} }), ...(o.rpc ?? {}) } as never,
    context: { projectId: "p1", threadId: "t1" },
    sdk: { plugins: { callRpc }, projects: { get: async () => ({ icon: null }), iconCandidates: async () => ({ candidates: ["public/logo.svg", "assets/icon.png"] }), update: async () => ({}) }, ...(o.sdk ?? {}) } as never,
  });
}

const parts = new Map<string, string>();
function save(name: string, html: string, mode: "light" | "dark" = "light", width = 320, height?: number) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const css = (process.env.VIS_RAIL_CSS ?? "").split(",").filter(Boolean).map((f) => readFileSync(f, "utf8")).join("\n");
  const theme = readFileSync(join(ROOT, "themes/navaigate.css"), "utf8");
  const heads = [...document.head.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
  parts.set(name, html);
  writeFileSync(join(OUT, `${name}-${mode}.html`), `<!doctype html><html lang="en-GB" class="${mode}"><head><meta charset="utf-8"><title>${name}</title><style>${css}</style><style>${heads}</style><style>${theme}</style><style>body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--font-sans, system-ui)} .pv{display:flex;${height ? `height:${height}px` : "min-height:100vh"}} .pv-side{width:${width}px;flex:none;background:${width > 400 ? "var(--background)" : "var(--sidebar, var(--background))"};border-right:1px solid var(--border);${height ? "overflow:hidden;" : ""}} .pv-main{flex:1;min-width:0}</style></head><body><div class="pv" data-bb-plugin="navaigate-skin"><aside class="pv-side">${html}</aside></div></body></html>`);
}
function savePage(name: string, html: string, mode: "light" | "dark" = "light", height?: number) {
  if (!OUT) return;
  save(name, html, mode, 900, height);
}
const sidebar = () => document.querySelector('[data-nav-part="rail"]') as HTMLElement;

const accounts = {
  t1: { accountId: "a1", label: "dw", email: "sam@example.com", harness: "claude" },
  t2: { accountId: "a2", label: "sam", email: "pat@example.com", harness: "codex" },
  t3: { accountId: "a1", label: "dw", email: "sam@example.com", harness: "claude" },
  t4: { accountId: "a3", label: "gmail", email: "x@gmail.com", harness: "claude" },
  t5: { accountId: "a1", label: "dw", email: "sam@example.com", harness: "claude" },
};
const railRows = [row("t1", "Release dry run", "running"), row("t3", "Invoice INV-041", "failed"), row("t4", "Course lesson cover", "needs-you"), row("old1", "Pricing page idea", "stashed", { updatedAt: NOW - 9 * DAY }), row("old2", "Old Zoom notes", "stashed", { updatedAt: NOW - 12 * DAY })];

describe("rail screenshots from fixture data", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`the Console rail with logos, accounts, links and the Stash open (${mode})`, async () => {
      localStorage.setItem("nav-skin:stash-open", "true");
      mount(() => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} />, {
        styles: { "p:p3": { icon: "emoji:📊" }, "f:f1": { icon: "emoji:🤝" }, "f:f2": { icon: "emoji:🧾" } },
        rpc: { thread_accounts: () => ({ threads: accounts }), attention_fleet_inbox: () => ({ rows: railRows, truncated: false, notices: [] }), fleet_board: () => ({ available: true, board, error: null }) },
      });
      await waitFor(() => expect(sidebar().querySelectorAll('[data-nav-part="account"]').length).toBeGreaterThan(3));
      await waitFor(() => expect(sidebar().querySelector('[data-nav-part="stash-list"]')).toBeTruthy());
      await waitFor(() => expect(sidebar().querySelector('[data-nav-part="folder-icon"]')).toBeTruthy());
      save("rail-main", document.body.innerHTML, mode);
    });
  }

  it("another Mac's chats with the pull request its owner sees", async () => {
    localStorage.setItem("nav-skin:machine", JSON.stringify("studio"));
    mount(() => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} />, {
      rpc: { attention_fleet_inbox: () => ({ rows: [
        row("r1", "Nightly render", "reviewable", { remote: true, machine: "studio", ownerServerId: "srv-studio", ownerHostId: "h1", pr: pr(41, "failing", 2) }),
        row("r2", "Course upload retry", "needs-you", { remote: true, machine: "studio", ownerServerId: "srv-studio", ownerHostId: "h1", pr: pr(42, "pending") }),
        row("r3", "Podcast cut", "reviewable", { remote: true, machine: "studio", ownerServerId: "srv-studio", ownerHostId: "h1", pr: pr(40, "passing") }),
      ], truncated: false, notices: [] }), fleet_board: () => ({ available: true, board, error: null }) },
    });
    await waitFor(() => expect(sidebar().querySelectorAll('[data-nav-part="pr-badge"]')).toHaveLength(3));
    save("rail-m1-prs", document.body.innerHTML, "light");
  });

  it("the project right-click menu offers Change icon", async () => {
    mount(() => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} />);
    const head = await waitFor(() => {
      const el = [...sidebar().querySelectorAll('[data-nav-part="section-head"]')].find((h) => h.textContent?.includes("Atlas")) as HTMLElement | undefined;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(head);
    await screen.findByText("Change icon…");
    save("rail-project-menu", document.body.innerHTML, "light");
  });

  it("the project icon chooser", async () => {
    mount(() => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} />);
    const head = await waitFor(() => {
      const el = [...sidebar().querySelectorAll('[data-nav-part="section-head"]')].find((h) => h.textContent?.includes("Atlas")) as HTMLElement | undefined;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(head);
    fireEvent.click(await screen.findByText("Change icon…"));
    await screen.findByText("public/logo.svg");
    await act(async () => {});
    save("icon-dialog", document.body.innerHTML, "light");
  });

  it("the Stash page", async () => {
    const view = mount(() => <StashPage />, { rpc: { attention_fleet_inbox: () => ({ rows: railRows, truncated: false, notices: [] }) } });
    await screen.findByText("Pricing page idea");
    savePage("stash-page", view.container.innerHTML, "light");
  });

  const STASH_TITLES = ["Pricing page idea", "Old Zoom notes", "Invoice INV-040", "Course lesson cover v2", "Portal landing page copy", "Survey export", "Podcast cut for the client", "Receipts for October", "Clientco workshop agenda", "Ember theme spacing", "Travel plan for the offsite", "Offer notes", "Acme contract check", "Onboarding checklist", "Archive tidy", "Video thumbnails round two", "Sales call recap", "Dashboard colours", "Search index tidy", "Insurance renewal letter", "Landing page headline test", "Studio backup schedule", "NAS share permissions", "Hooks review", "Template registry cleanup", "Weekly course post", "Notes sync check", "Quote for new customer", "Logo choice", "Folder logos"];
  const stash30 = STASH_TITLES.map((title, i) => row(`s${i}`, title, "stashed", {
    updatedAt: NOW - (i < 4 ? 2 + i : 7 + i * 2) * DAY - i * HOUR,
    ...(i % 5 === 1 ? { remote: true, machine: "studio", ownerServerId: "srv-studio", ownerHostId: "h1" } : i % 7 === 3 ? { remote: true, machine: "work", ownerServerId: "srv-work", ownerHostId: "h4" } : {}),
  }));
  const stashRpc = { attention_state: () => ({ records: stash30.map((r) => rec(r.threadId)), foldWorking: false, stashAfterDays: 7 }), attention_fleet_inbox: () => ({ rows: stash30, truncated: false, notices: [] }) };

  for (const mode of ["light", "dark"] as const) {
    it(`the Stash page with 30 chats, tall and short (${mode})`, async () => {
      const view = mount(() => <StashPage />, { rpc: stashRpc });
      await screen.findByText("Pricing page idea");
      await screen.findByLabelText("Search stashed chats");
      await screen.findByText(/move here, to keep your sidebar clear/);
      savePage("stash-page-30", view.container.innerHTML, mode, 760);
      savePage("stash-page-30-short", view.container.innerHTML, mode, 300);
    });

    it(`the Stash page asking before Delete (${mode})`, async () => {
      const view = mount(() => <StashPage />, { rpc: stashRpc });
      fireEvent.click(await screen.findByLabelText("Delete Pricing page idea"));
      await screen.findByText("Delete this chat? This cannot be undone.");
      savePage("stash-page-confirm", view.container.innerHTML, mode, 560);
    });

    it(`the inline Stash list with 30 chats under the sidebar link (${mode})`, async () => {
      localStorage.setItem("nav-skin:stash-open", "true");
      mount(() => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} />, { rpc: { ...stashRpc, thread_accounts: () => ({ threads: accounts }), fleet_board: () => ({ available: true, board, error: null }) } });
      await waitFor(() => expect(sidebar().querySelector('[data-nav-part="stash-list"] [data-nav-part="stash-row"]')).toBeTruthy());
      save("stash-inline-30", document.body.innerHTML, mode, 320, 760);
      save("stash-inline-30-short", document.body.innerHTML, mode, 320, 360);
    });
  }

  it("Work needs you grouped into failed, questions, review and working", async () => {
    const rows = [
      row("a", "Invoice INV-041", "failed"), row("b", "Course lesson cover", "needs-you", { question: "Which cover do you want, A or B?" }),
      row("c", "Ember theme polish", "reviewable"), row("d", "Nightly render", "reviewable", { remote: true, machine: "studio", ownerServerId: "m", ownerHostId: "h" }),
      row("e", "Release dry run", "running"),
    ];
    const view = mount(() => <AttentionPage />, { rpc: { attention_fleet_inbox: () => ({ rows, truncated: false, notices: [] }) } });
    await screen.findByText("Invoice INV-041");
    savePage("work-needs-you", view.container.innerHTML, "light");
  });
});

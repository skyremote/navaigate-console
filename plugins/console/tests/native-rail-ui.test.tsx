// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Rail } from "../src/rail";
import { attentionVisible } from "../src/attention";
import { prTitle, stashLinkTitle } from "../src/rail-extras";
import type { FleetBoard } from "../src/machines";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(() => 1), error: vi.fn(), loading: vi.fn(() => 1), dismiss: vi.fn() }) }));

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, String(value)); },
    removeItem: (name: string) => { items.delete(name); }, clear: () => items.clear(), key: (index: number) => [...items.keys()][index] ?? null,
    get length() { return items.size; },
  });
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
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
  thread("t1", "Release dry run", "p1"),
  thread("t2", "Invoice INV-041", "p2", { updatedAt: NOW - 2 * HOUR }),
  thread("t3", "Old idea", "p2", { updatedAt: NOW - 9 * DAY }),
  thread("t3kid", "Old idea helper", "p2", { updatedAt: NOW - 9 * DAY, parentThreadId: "t3" }),
];
const projects = [
  { id: "p1", name: "Atlas", isPersonal: false, href: "/p1", settingsHref: "/s/p1", experimental_icon: { imageUrl: "/api/v1/projects/p1/files/logo.svg", monogram: "N", hue: 260 } },
  { id: "p2", name: "Admin", isPersonal: false, href: "/p2", settingsHref: "/s/p2", experimental_icon: { imageUrl: null, monogram: "AD", hue: 150 } },
];
const policy = { autoMerge: false, requiredPrUrls: [], requiredPrEnvironments: {}, acceptancePending: true, inactiveAfterMs: null };
const record = (threadId: string, mode: string) => ({ threadId, mode, wakeAt: null, changedAt: NOW, revision: null, policy });
const row = (threadId: string, status: string, over: Record<string, unknown> = {}) => ({ threadId, title: threadId, hostId: "h", environmentId: null, status, question: null, updatedAt: NOW - 9 * DAY, pinned: false, wakeAt: null, ...over });

type Opts = {
  attentionRecords?: unknown[];
  rows?: unknown[];
  accounts?: Record<string, unknown>;
  styles?: Record<string, unknown>;
  board?: FleetBoard;
  extraRpc?: Record<string, (input: never) => unknown>;
  sdk?: Record<string, unknown>;
  active?: string;
};
function renderRail(o: Opts = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const callRpc = vi.fn(async ({ method, input }: { method: string; input: unknown }) => {
    calls.push({ method, input });
    if (method === "list") return { folders: [{ id: "f1", projectId: "p2", hostId: "h", parentId: null, name: "Clients", path: "/p2/Clients" }], roots: [{ id: "root:p2", projectId: "p2", hostId: "h", parentId: null, name: "Admin", path: "/p2" }], bindings: {}, places: { t2: "f1" } };
    if (method === "prefs_get") return { prefs: {}, items: o.styles ?? {}, stored: true };
    if (method === "item_style_save") return { ok: true };
    throw new Error(`no ${method}`);
  });
  const rpc = {
    attention_state: () => ({ records: o.attentionRecords ?? [], foldWorking: false }),
    attention_fleet_inbox: () => ({ rows: o.rows ?? [], truncated: false, notices: [] }),
    thread_accounts: () => ({ threads: o.accounts ?? {} }),
    fleet_board: () => ({ available: Boolean(o.board), board: o.board ?? null, error: null }),
    attention_apply: () => ({ receiptId: "r1", results: [{ threadId: "t3", ok: true, error: null }] }),
    ...(o.extraRpc ?? {}),
  };
  const view = renderSlot(
    { component: () => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} /> },
    {},
    {
      sidebarThreads: { status: "ready", threads, projects: projects as never, sections: [] },
      rpc: rpc as never,
      context: { projectId: "p1", threadId: "t1" },
      sdk: { plugins: { callRpc }, ...(o.sdk ?? {}) } as never,
    },
  );
  return { view, calls, callRpc };
}
const sidebar = () => document.querySelector('[data-nav-part="rail"]') as HTMLElement;

describe("F03 the account a chat runs on shows on its rail row", () => {
  it("tags each chat that has a known account, and only those", async () => {
    renderRail({ accounts: { t1: { accountId: "a1", label: "dw", email: "sam@example.com", harness: "claude" }, t2: { accountId: "a2", label: "gmail", email: "x@gmail.com", harness: "codex" } } });
    await waitFor(() => expect(sidebar().querySelectorAll('[data-nav-part="account"]')).toHaveLength(2));
    const tags = [...sidebar().querySelectorAll('[data-nav-part="account"]')];
    expect(tags.map((t) => t.textContent).sort()).toEqual(["dw", "gmail"]);
    expect(tags[0]?.getAttribute("title")).toContain("account");
    const t1 = sidebar().querySelector('[data-sidebar-thread-id="t1"]') as HTMLElement;
    expect(within(t1).getByText("dw")).toBeTruthy();
    const t3 = sidebar().querySelector('[data-sidebar-thread-id="t3"]');
    expect(t3 && within(t3 as HTMLElement).queryByText("dw")).toBeFalsy();
  });

  it("also tags rows in compact mode", async () => {
    localStorage.setItem("nav-skin:compact-rows", "true");
    renderRail({ accounts: { t1: { accountId: "a1", label: "dw", email: null, harness: "claude" } } });
    await waitFor(() => expect(sidebar().querySelectorAll('[data-nav-part="account"]')).toHaveLength(1));
  });
});

describe("F30 the rail links to Work needs you", () => {
  it("counts failed and waiting-on-you chats and opens the page", async () => {
    const { view } = renderRail({ rows: [row("t1", "failed"), row("t2", "needs-you"), row("t3", "reviewable")] });
    const link = await waitFor(() => {
      const el = [...sidebar().querySelectorAll('[data-nav-part="rail-link"]')].find((b) => b.textContent?.includes("Work needs you"));
      expect(el?.querySelector('[data-nav-part="link-count"]')?.textContent).toBe("2");
      return el as HTMLElement;
    });
    fireEvent.click(link);
    expect(view.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-needs-you" });
  });

  it("makes the Now card's 'need you' count a link to the same page", async () => {
    const needsYou = [thread("n1", "Question", "p1", { hasPendingInteraction: true, indicator: "waiting-for-input" })];
    const view = renderSlot(
      { component: () => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} /> },
      {},
      { sidebarThreads: { status: "ready", threads: [...threads, ...needsYou], projects: projects as never, sections: [] }, rpc: { attention_state: () => ({ records: [], foldWorking: false }), attention_fleet_inbox: () => ({ rows: [], truncated: false }) } as never, sdk: { plugins: { callRpc: async () => { throw new Error("x"); } } } as never },
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector('button[data-nav-part="now-needs"]') as HTMLElement | null;
      expect(el?.textContent).toBe("1 need you");
      return el as HTMLElement;
    });
    fireEvent.click(link);
    expect(view.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-needs-you" });
  });
});

describe("F38 the pull request the owning Mac sees shows on its remote row", () => {
  const board: FleetBoard = {
    serverId: "sky", serverKey: "laptop",
    columns: [
      { key: "laptop", label: "laptop", serverId: "sky", online: true, lastSeenAt: NOW, threads: [] },
      { key: "studio", label: "studio", serverId: "srv-studio", online: true, lastSeenAt: NOW, mirror: true, threads: [
        { id: "r1", title: "Nightly render", state: "idle", machine: "studio", projectName: "Admin", providerId: "claude-code", updatedAt: NOW - HOUR, url: "https://m1/threads/r1", via: "srv-studio" },
        { id: "r2", title: "No PR here", state: "idle", machine: "studio", projectName: "Admin", providerId: "claude-code", updatedAt: NOW - HOUR, url: "https://m1/threads/r2", via: "srv-studio" },
      ] },
    ],
  };
  const pr = { number: 41, url: "https://github.com/example/x/pull/41", state: "open", checks: "failing", failedCount: 2 };

  it("draws the badge with its number and failing checks on Studio row, not on a row without a PR", async () => {
    localStorage.setItem("nav-skin:machine", JSON.stringify("studio"));
    renderRail({ board, rows: [row("r1", "reviewable", { remote: true, machine: "studio", ownerServerId: "srv-studio", ownerHostId: "h1", pr })] });
    const badge = await waitFor(() => {
      const el = sidebar().querySelector('[data-nav-part="pr-badge"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain("41");
    expect(badge.getAttribute("data-checks")).toBe("failing");
    expect(badge.getAttribute("title")).toBe("PR #41 on Studio: open, checks failing (2)");
    expect(sidebar().querySelectorAll('[data-nav-part="pr-badge"]')).toHaveLength(1);
  });

  it("words the tooltip for each check state", () => {
    expect(prTitle({ ...pr, checks: "pending", failedCount: 0 } as never)).toBe("PR #41: open, checks running");
    expect(prTitle({ ...pr, checks: "passing", failedCount: 0, state: "merged" } as never, "work")).toBe("PR #41 on Work: merged, checks passing");
  });
});

describe("EXTRA-A the Stash", () => {
  it("keeps stashed chats and their sub-agents out of the sidebar", async () => {
    renderRail({ attentionRecords: [record("t3", "stashed")], rows: [row("t3", "stashed")] });
    await waitFor(() => expect(sidebar().querySelector('[data-sidebar-thread-id="t3"]')).toBeNull());
    expect(sidebar().querySelector('[data-sidebar-thread-id="t3kid"]')).toBeNull();
    expect(sidebar().querySelector('[data-sidebar-thread-id="t1"]')).toBeTruthy();
    expect(sidebar().querySelector('[data-sidebar-thread-id="t2"]')).toBeTruthy();
  });

  it("hides a stashed chat in attentionVisible unless it is working again", () => {
    const records = [record("t3", "stashed")] as never;
    expect(attentionVisible({ id: "t3", isPinned: false }, "idle", records, false)).toBe(false);
    expect(attentionVisible({ id: "t3", isPinned: false }, "failed", records, false)).toBe(false);
    expect(attentionVisible({ id: "t3", isPinned: false }, "running", records, false)).toBe(true);
    expect(attentionVisible({ id: "t3", isPinned: false }, "needs", records, false)).toBe(true);
  });

  it("shows the Stash count, lists the stashed chats, and Back to sidebar sends restore for that chat", async () => {
    const { view } = renderRail({ attentionRecords: [record("t3", "stashed")], rows: [row("t3", "stashed", { title: "Old idea" })], extraRpc: { attention_apply: (i: never) => ({ receiptId: "r1", results: [{ threadId: (i as { threadIds: string[] }).threadIds[0], ok: true, error: null }] }) } });
    const stashLink = await waitFor(() => {
      const el = [...sidebar().querySelectorAll('[data-nav-part="rail-link"]')].find((b) => b.textContent?.includes("Stash")) as HTMLElement;
      expect(el.querySelector('[data-nav-part="link-count"]')?.textContent).toBe("1");
      return el;
    });
    fireEvent.click(screen.getByLabelText("Show stashed chats"));
    const list = await waitFor(() => {
      const el = sidebar().querySelector('[data-nav-part="stash-list"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(within(list).getByText("Old idea")).toBeTruthy();
    fireEvent.click(within(list).getByLabelText("Back to sidebar: Old idea"));
    await waitFor(() => expect(view.inspection.rpcCalls.some((c) => c.method === "attention_apply" && (c.input as { action: string }).action === "restore")).toBe(true));
    fireEvent.click(stashLink);
    expect(view.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "stash" });
  });

  it("bounds the inline list so it scrolls instead of pushing the sidebar down", async () => {
    renderRail({ attentionRecords: [record("t3", "stashed")], rows: [row("t3", "stashed", { title: "Old idea" })] });
    await waitFor(() => screen.getByLabelText("Show stashed chats"));
    fireEvent.click(screen.getByLabelText("Show stashed chats"));
    const list = await waitFor(() => sidebar().querySelector('[data-nav-part="stash-list"]') as HTMLElement);
    expect(list.className).toMatch(/max-h-\[min\(18rem,45vh\)\]/);
    expect(list.className).toContain("overflow-y-auto");
  });

  it("deletes only after a short confirmation, through threads.delete", async () => {
    const del = vi.fn(async () => ({ ok: true as const }));
    renderRail({ attentionRecords: [record("t3", "stashed")], rows: [row("t3", "stashed", { title: "Old idea" })], sdk: { threads: { delete: del } } });
    await waitFor(() => screen.getByLabelText("Show stashed chats"));
    fireEvent.click(screen.getByLabelText("Show stashed chats"));
    const list = await waitFor(() => sidebar().querySelector('[data-nav-part="stash-list"]') as HTMLElement);
    fireEvent.click(within(list).getByLabelText("Delete Old idea"));
    expect(del).not.toHaveBeenCalled();
    expect(within(list).getByText("Delete this chat? This cannot be undone.")).toBeTruthy();
    fireEvent.click(within(list).getByText("Cancel"));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(list).getByLabelText("Delete Old idea"));
    await act(async () => { fireEvent.click(within(within(list).getByRole("group", { name: "Delete Old idea?" })).getByText("Delete")); });
    expect(del).toHaveBeenCalledWith({ threadId: "t3", childThreadsConfirmed: true });
  });

  it("says in the link's title how long a chat must be untouched, and when the Stash is off", () => {
    expect(stashLinkTitle(7)).toBe("Open the Stash: chats you have not touched for 7 days. Open one and carry on, and it moves back to your list");
    expect(stashLinkTitle(0)).toContain("switched off");
  });
});

describe("F74 and EX-b logos for projects and folders", () => {
  it("draws the project's image icon, falling back to its monogram", async () => {
    renderRail();
    await waitFor(() => expect(sidebar().querySelectorAll('[data-nav-part="project-icon"]')).toHaveLength(2));
    const heads = [...sidebar().querySelectorAll('[data-nav-part="section-head"]')];
    const nav = heads.find((h) => h.textContent?.includes("Atlas")) as HTMLElement;
    const admin = heads.find((h) => h.textContent?.includes("Admin")) as HTMLElement;
    const img = nav.querySelector('img[data-project-icon="image"]') as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/v1/projects/p1/files/logo.svg");
    fireEvent.error(img);
    expect(nav.querySelector('[data-project-icon="monogram"]')?.textContent).toBe("N");
    expect(admin.querySelector('[data-project-icon="monogram"]')?.textContent).toBe("AD");
    expect(nav.querySelector('[data-nav-part="status-dot"]')).toBeNull();
  });

  it("lets an emoji chosen in project-folders win on a project, and shows a folder's chosen emoji", async () => {
    renderRail({ styles: { "p:p1": { icon: "emoji:🚀" }, "f:f1": { icon: "emoji:💼" } } });
    await waitFor(() => expect(sidebar().querySelector('[data-project-icon="emoji"]')).toBeTruthy());
    const heads = [...sidebar().querySelectorAll('[data-nav-part="section-head"]')];
    const nav = heads.find((h) => h.textContent?.includes("Atlas")) as HTMLElement;
    expect(nav.querySelector('[data-project-icon="emoji"]')?.textContent).toBe("🚀");
    expect(nav.querySelector('img')).toBeNull();
    const folder = await waitFor(() => {
      const el = sidebar().querySelector('[data-nav-part="folder-icon"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(folder.textContent).toBe("💼");
  });

  it("changes a project's icon from its right-click menu with the icon files bb finds", async () => {
    const update = vi.fn(async () => ({}));
    const sdk = { projects: { get: vi.fn(async () => ({ icon: null })), iconCandidates: vi.fn(async () => ({ candidates: ["public/logo.svg", "favicon.ico"] })), update } };
    renderRail({ sdk });
    const head = await waitFor(() => {
      const el = [...sidebar().querySelectorAll('[data-nav-part="section-head"]')].find((h) => h.textContent?.includes("Atlas")) as HTMLElement | undefined;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(head);
    fireEvent.click(await screen.findByText("Change icon…"));
    expect(await screen.findByText("Project icon")).toBeTruthy();
    const candidate = await screen.findByText("public/logo.svg");
    expect(sdk.projects.iconCandidates).toHaveBeenCalledWith({ projectId: "p1" });
    await act(async () => { fireEvent.click(candidate); });
    expect(update).toHaveBeenCalledWith({ projectId: "p1", icon: { kind: "file", path: "public/logo.svg" } });
  });

  it("saves a generated monogram and an emoji for a project", async () => {
    const update = vi.fn(async () => ({}));
    const sdk = { projects: { get: vi.fn(async () => ({ icon: null })), iconCandidates: vi.fn(async () => ({ candidates: [] })), update } };
    const { callRpc } = renderRail({ sdk });
    const head = await waitFor(() => {
      const el = [...sidebar().querySelectorAll('[data-nav-part="section-head"]')].find((h) => h.textContent?.includes("Atlas")) as HTMLElement | undefined;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(head);
    fireEvent.click(await screen.findByText("Change icon…"));
    await screen.findByText("No icon files found.");
    fireEvent.change(screen.getByLabelText("Monogram"), { target: { value: "NV" } });
    fireEvent.click(screen.getByLabelText("violet"));
    await act(async () => { fireEvent.click(screen.getByText("Use generated icon")); });
    expect(update).toHaveBeenCalledWith({ projectId: "p1", icon: { kind: "monogram", text: "NV", color: "violet" } });
    fireEvent.contextMenu(head);
    fireEvent.click(await screen.findByText("Change icon…"));
    await screen.findByText("No icon files found.");
    await act(async () => { fireEvent.click(screen.getByLabelText("🚀")); });
    const save = callRpc.mock.calls.map((c) => c[0]).find((c) => c.method === "item_style_save");
    expect(save?.input).toEqual({ key: "p:p1", style: { icon: "emoji:🚀" } });
  });

  it("chooses an icon for a folder from its menu and keeps its other look", async () => {
    const { callRpc } = renderRail({ styles: { "f:f1": { color: "red" } } });
    const folder = await waitFor(() => {
      const el = sidebar().querySelector('[title="/p2/Clients"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(folder);
    fireEvent.click(await screen.findByText("Choose icon…"));
    expect(await screen.findByText("Folder icon")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByLabelText("🧾")); });
    const save = callRpc.mock.calls.map((c) => c[0]).find((c) => c.method === "item_style_save");
    expect(save?.input).toEqual({ key: "f:f1", style: { color: "red", icon: "emoji:🧾" } });
  });
});

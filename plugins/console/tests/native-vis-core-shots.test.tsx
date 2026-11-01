// @vitest-environment jsdom
// Writes static preview pages of Studio service card and the source notices
// from the real rendered markup, for screenshots outside the live app. Runs
// only when VIS_SHOTS_OUT is set (with VIS_SHOTS_CSS for the shared stylesheets).
import React from "react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Rail } from "../src/rail";
import { M1ServiceCard } from "../src/m1-service";
import { CoreEntries } from "../src/delivery";
import type { FleetBoard } from "../src/machines";
import type { M1ServiceState } from "../server-m1-service";

const OUT = process.env.VIS_SHOTS_OUT;
const ROOT = join(__dirname, "..");
const NOW = 1_800_000_000_000;
const BOOT = Math.floor(NOW / 1000) - 3 * 3600 - 12 * 60;
const HOUR = 3_600_000;

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

const probe = (over: Partial<NonNullable<M1ServiceState["probe"]>> = {}): M1ServiceState => ({
  reachable: true, checkedAt: NOW, error: null,
  probe: { bootAt: BOOT * 1000, probedAt: NOW, bbRunning: true, bbVersion: "0.48.1", bbStartedAt: (BOOT + 94) * 1000, gui: "present", app: "absent", loginItem: "unknown", launchAgent: "running", awakeHeld: true, awakeSetting: { enabled: true, scope: "all hosts" }, ...over },
});
const variants: Array<[string, M1ServiceState]> = [
  ["headless", probe()],
  ["app-open", probe({ app: "present" })],
  ["down", probe({ bbRunning: false, bbStartedAt: null, launchAgent: "stopped", awakeHeld: false, awakeSetting: { enabled: false, scope: "all hosts" } })],
  ["unreachable", { reachable: false, probe: null, checkedAt: NOW, error: "ssh: connect to host m1 port 22: Operation timed out" }],
];

const thread = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, projectId: "p1", title, titleFallback: null, displayTitle: title, parentThreadId: null, providerId: "claude-code", status: "idle", runtimeStatus: "idle", queuedWork: "none",
  hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", isUnread: false, isPinned: false, isArchived: false,
  href: `/projects/p1/threads/${id}`, isHidden: false, environment: null, host: null, createdAt: NOW - 5 * HOUR, updatedAt: NOW - HOUR, lastActivityAt: NOW - HOUR, ...over,
}) as unknown as PluginSidebarThread;
const board: FleetBoard = {
  serverId: "sky", serverKey: "laptop",
  columns: [
    { key: "laptop", label: "laptop home", serverId: "sky", online: true, lastSeenAt: NOW, threads: [], resources: { observedAt: NOW, cpuCount: 12, cpuUtilization: 0.18, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 14 * 1024 ** 3 } },
    { key: "studio", label: "Studio home", serverId: "macbookm1", online: true, lastSeenAt: NOW, threads: [{ id: "r1", title: "Nightly render", state: "running", machine: "studio", projectName: null, providerId: "claude-code", updatedAt: NOW, url: "", via: "macbookm1" }], resources: { observedAt: NOW, cpuCount: 8, cpuUtilization: 0.31, totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 9 * 1024 ** 3 } },
    { key: "work", label: "work Client", serverId: "sky-m4", online: false, lastSeenAt: NOW - 2 * HOUR, threads: [] },
  ],
};

function page(mode: "dark" | "light", themeCss: string, sharedCss: string, styles: string, body: string) {
  return `<!doctype html><html lang="en-GB" class="${mode}"><head><meta charset="utf-8"><title>vis-core ${mode}</title><style>${sharedCss}</style><style>${styles}</style><style>${themeCss}</style>`
    + `<style>body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--font-sans)} .pv{display:grid;grid-template-columns:304px 1fr;min-height:100vh} .pv-side{background:var(--sidebar);border-right:1px solid var(--sidebar-border);padding-top:8px} .pv-main{padding:24px;display:flex;flex-direction:column;gap:20px;align-items:flex-start} .pv-col{width:304px} .pv-wide{width:640px} h2.pv-t{font-size:12px;color:var(--muted-foreground);margin:0 0 4px}</style>`
    + `</head><body>${body}</body></html>`;
}

describe.skipIf(!OUT)("vis-core preview pages", () => {
  it("writes Studio service card in every state, the rail with Studio picked, and the source notices", async () => {
    const styles = new Map<string, string>();
    const collect = () => { for (const style of document.head.querySelectorAll("style")) if (style.id) styles.set(style.id, style.textContent ?? ""); };

    const cards: string[] = [];
    for (const [name, state] of variants) {
      const view = renderSlot({ component: () => <M1ServiceCard /> }, {}, { rpc: { m1_service: () => state } as never });
      await waitFor(() => { if (!view.container.querySelector('[data-nav-role="headline"]') || view.container.textContent?.includes("Checking Studio")) throw new Error("waiting"); });
      collect();
      cards.push(`<div><h2 class="pv-t">${name}</h2><div class="pv-col">${view.container.innerHTML}</div></div>`);
      cleanup();
    }

    const rail = renderSlot(
      { component: () => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} /> },
      {},
      {
        sidebarThreads: { status: "ready", threads: [thread("t1", "Portal judging dry run", { status: "active", runtimeStatus: "active" }), thread("t2", "Invoice NAVAI-041")], projects: [{ id: "p1", name: "NavAIgate", isPersonal: false }] as never, sections: [] },
        rpc: { fleet_board: () => ({ available: true, board, error: null }), m1_service: () => probe() } as never,
        context: { projectId: "p1", threadId: "t1" },
      },
    );
    await waitFor(() => { if (rail.container.querySelectorAll('[data-nav-part="machine-tile"]').length !== 3) throw new Error("waiting"); });
    fireEvent.click([...rail.container.querySelectorAll('[data-nav-part="machine-tile"]')].find((tile) => tile.textContent?.startsWith("studio"))!);
    await waitFor(() => { if (!rail.container.textContent?.includes("Running headless")) throw new Error("waiting"); });
    collect();
    const railHtml = rail.container.innerHTML;
    cleanup();

    const entries = renderSlot({ component: () => <CoreEntries projectId={null} /> }, {}, {});
    entries.container.querySelector("details")!.open = true;
    collect();
    const entriesHtml = entries.container.innerHTML;

    mkdirSync(OUT!, { recursive: true });
    const shared = (process.env.VIS_SHOTS_CSS ?? "").split(",").filter(Boolean).map((f) => readFileSync(f, "utf8")).join("\n");
    const theme = readFileSync(join(ROOT, "themes", "navaigate.css"), "utf8");
    for (const mode of ["dark", "light"] as const) {
      const css = [...styles.values()].join("\n");
      writeFileSync(join(OUT!, `m1-service-states-${mode}.html`), page(mode, theme, shared, css, `<div class="pv-main" data-bb-plugin="navaigate-skin" style="flex-direction:row;flex-wrap:wrap;gap:24px">${cards.join("")}</div>`));
      writeFileSync(join(OUT!, `m1-service-rail-${mode}.html`), page(mode, theme, shared, css, `<div class="pv" data-bb-plugin="navaigate-skin"><aside class="pv-side" aria-label="Sidebar">${railHtml}</aside><main class="pv-main"></main></div>`));
      writeFileSync(join(OUT!, `source-notices-${mode}.html`), page(mode, theme, shared, css, `<div class="pv-main" data-bb-plugin="navaigate-skin"><div class="pv-wide">${entriesHtml}</div></div>`));
    }
  });
});

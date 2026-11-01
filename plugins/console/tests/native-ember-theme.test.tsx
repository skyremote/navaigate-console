// @vitest-environment jsdom
// Ember surface polish: the skin renders data-nav-part hooks, Ember styles
// them, and the NavAIgate theme stays untouched. With EMBER_PREVIEW_OUT set
// this file also writes a static preview page per theme and mode from the real
// rendered markup, for screenshots outside the live app.
import React from "react";
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Rail } from "../src/rail";
import { Panel } from "../src/usage-card";
import { TodoHeaderButton } from "../src/todo";
import { NowHeadline } from "../src/shared";
import { TooltipProvider } from "../components/ui/tooltip";
import type { FleetBoard } from "../src/machines";
import type { TrendAccount, TrendWindow } from "../server-usage-trend";

const ROOT = join(__dirname, "..");
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

function thread(id: string, title: string, projectId: string, over: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
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
  thread("t1", "Release dry run", "p1", { status: "active", runtimeStatus: "active", updatedAt: NOW - 60_000 } as Partial<PluginSidebarThread>),
  thread("t2", "Ember theme polish", "p1", { status: "active", runtimeStatus: "active", providerId: "codex", updatedAt: NOW - 120_000 } as Partial<PluginSidebarThread>),
  thread("t3", "Invoice INV-041", "p2", { hasPendingInteraction: true, indicator: "waiting-for-input", updatedAt: NOW - 30 * 60_000 }),
  thread("t4", "Course lesson cover", "p2", { updatedAt: NOW - 2 * HOUR }),
  thread("t5", "Survey export", "p3", { isUnread: true, updatedAt: NOW - 3 * HOUR }),
];
const projects = [
  { id: "p1", name: "Atlas", isPersonal: false },
  { id: "p2", name: "Admin", isPersonal: false },
  { id: "p3", name: "Survey app", isPersonal: false },
];
const board: FleetBoard = {
  serverId: "sky", serverKey: "laptop",
  columns: [
    { key: "laptop", label: "laptop home", serverId: "sky", online: true, lastSeenAt: NOW, threads: [], resources: { observedAt: NOW, cpuCount: 12, cpuUtilization: 0.18, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 14 * 1024 ** 3 } },
    { key: "studio", label: "Studio home", serverId: "srv-studio", online: true, lastSeenAt: NOW, threads: [{ id: "r1", title: "Nightly render", state: "running", machine: "studio", projectName: null, providerId: "claude-code", updatedAt: NOW, url: "", via: "srv-studio" }] },
    { key: "work", label: "work Client", serverId: "sky-m4", online: false, lastSeenAt: NOW - 2 * HOUR, threads: [] },
  ],
};

function renderRail() {
  return renderSlot(
    { component: () => <Rail activeThreadId="t2" activeProjectId="p1" onNavigate={() => {}} /> },
    {},
    {
      sidebarThreads: { status: "ready", threads, projects: projects as never, sections: [] },
      rpc: { fleet_board: () => ({ available: true, board, error: null }) } as never,
      context: { projectId: "p1", threadId: "t2" },
    },
  );
}

function usageWindow(over: Partial<TrendWindow> = {}): TrendWindow {
  return { id: "session", label: "Session", span: "session", model: null, pct: 34, startsAt: NOW - 2 * HOUR, resetsAt: NOW + 3 * HOUR, idle: false, series: [[NOW - 2 * HOUR, 8], [NOW - HOUR, 23], [NOW, 34]], rate: 11, rateBasis: "recent", samples: 3, forecastAtReset: 67, hits90At: null, hits100At: null, burn: 11, ...over };
}
const usageAccount: TrendAccount = {
  id: "local-pool", harness: "claude", email: "pat@example.com", plan: "Max", status: "ok", observedAt: NOW, burn: 11,
  windows: [usageWindow(), usageWindow({ id: "week", label: "Week", span: "long", pct: 41, startsAt: NOW - 3 * 24 * HOUR, resetsAt: NOW + 4 * 24 * HOUR, series: [[NOW - 3 * 24 * HOUR, 0], [NOW - 24 * HOUR, 30], [NOW, 41]] })],
  busiest: { mode: "tokens", since: NOW - 2 * HOUR, sinceLabel: "since 09:00", rows: [{ threadId: "t1", title: "Release dry run", share: 0.62, tokens: 400, turns: 4 }, { threadId: "t2", title: "Ember theme polish", share: 0.38, tokens: 250, turns: 2 }] },
} as TrendAccount;

function renderUsage() {
  return renderSlot({
    component: () => (
      <TooltipProvider>
        <div data-nav-part="usage-card" className="nuc-card z-50 w-[392px] rounded-lg border border-border bg-popover p-3.5 text-popover-foreground shadow-md">
          <Panel a={usageAccount} now={NOW} isThisChat sampledFrom={NOW - 2 * HOUR} />
        </div>
      </TooltipProvider>
    ),
  }, {}, {});
}

function hooksIn(css: string): string[] {
  return [...new Set([...css.matchAll(/data-nav-part="([a-z-]+)"/g)].map((m) => m[1]))];
}
function hooksInSource(): Set<string> {
  const files = ["src", "components"].flatMap((dir) => readdirSync(join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f)).map((f) => join(ROOT, dir, f)));
  const out = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/data-nav-part="([a-z-]+)"/g)) out.add(m[1]);
  return out;
}

// WCAG 2.2 relative luminance and contrast for #rrggbb values.
function lum(hex: string): number {
  const v = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function tokens(css: string, block: ":root" | ".dark"): Record<string, string> {
  const out: Record<string, string> = {};
  const re = block === ".dark" ? /\n\.dark\s*\{([^}]*)\}/g : /:root,\s*\n\.light\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(re)) for (const d of m[1].matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) out[d[1]] = d[2].toLowerCase();
  return out;
}

describe("Ember surface polish", () => {
  it("keeps the Now headline text identical while splitting it into styleable parts", () => {
    const view = renderSlot({ component: () => <p><NowHeadline prefix="Now" count={3} word="cooking" /> | <NowHeadline prefix="studio" count={0} word="quiet" /></p> }, {}, {});
    expect(view.container.textContent).toBe("Now · 3 cooking | studio · quiet");
    expect(view.container.querySelector('[data-nav-part="now-count"]')?.textContent).toBe("3");
  });

  it("renders the rail, Now card, harness filter, active pill and machine tiles with Ember hooks", async () => {
    const view = renderRail();
    await waitFor(() => expect(view.container.querySelector('[aria-label="Machines"]')).toBeTruthy());
    writePreviewPart("rail", view.container.innerHTML);
    const q = (s: string) => view.container.querySelectorAll(`[data-nav-part="${s}"]`);
    expect(q("rail")).toHaveLength(1);
    expect(q("now-card")).toHaveLength(1);
    expect(view.container.querySelector('[data-nav-part="now-headline"]')?.textContent).toBe("Now · 2 cooking");
    expect(q("segmented")).toHaveLength(1);
    expect(view.container.querySelector('[data-nav-part="row"][aria-current="page"] [data-nav-part="row-fill"]')).toBeTruthy();
    expect(q("machine-tile")).toHaveLength(3);
    const online = [...q("machine-tile")].map((tile) => tile.querySelector('[data-nav-part="status-dot"]')?.getAttribute("data-online"));
    expect(online).toEqual(["true", "true", "false"]);
    expect(q("section-head").length).toBeGreaterThan(0);
  });

  it("renders the usage card with a lead numeral, muted units and monospace metrics, text unchanged", async () => {
    const view = renderUsage();
    await new Promise((r) => setTimeout(r, 700));
    writePreviewPart("usage", view.container.innerHTML);
    const lead = view.container.querySelector('[data-nav-part="stat-value"][data-size="lead"]');
    expect(lead).toBeTruthy();
    const burn = [...view.container.querySelectorAll('[data-nav-part="stat-tile"] [data-nav-part="stat-value"]')][0];
    expect(burn.textContent).toBe("11% an hour");
    expect(burn.querySelector('[data-nav-part="unit"]')?.textContent).toBe("an hour");
    expect(view.container.querySelectorAll('[data-nav-part="metric"]').length).toBeGreaterThan(2);
  });

  it("tags the header action", () => {
    const view = renderSlot({ component: () => <TodoHeaderButton threadId="t2" /> }, {}, { rpc: { todo_list: () => ({ items: [] }) } as never });
    writePreviewPart("header", view.container.innerHTML);
    expect(view.container.querySelector('[data-nav-part="header-action"]')?.textContent).toContain("To-do");
  });

  it("styles only hooks the skin renders, and leaves the NavAIgate theme and theme order alone", () => {
    const ember = readFileSync(join(ROOT, "themes/ember.css"), "utf8");
    const navaigate = readFileSync(join(ROOT, "themes/navaigate.css"), "utf8");
    const rendered = hooksInSource();
    const used = hooksIn(ember);
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((h) => h !== "delta" && !rendered.has(h))).toEqual([]);
    expect(navaigate).not.toContain("data-nav-part");
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { bb: { themes: Array<{ id: string; css: string }> } };
    expect(manifest.bb.themes.map((t) => t.id)).toEqual(["navaigate", "ember"]);
    expect(manifest.bb.themes[1].css).toBe("./themes/ember.css");
  });

  it("keeps WCAG AA contrast for Ember text tokens on every surface they sit on", () => {
    const css = readFileSync(join(ROOT, "themes/ember.css"), "utf8");
    for (const block of [":root", ".dark"] as const) {
      const t = tokens(css, block);
      const grounds = ["--canvas", "--card", "--sidebar", "--ember-card-top", "--ember-pill", "--surface-raised", "--surface-recessed", "--popover"].map((k) => [k, t[k]] as const);
      const inks = ["--ink", "--muted-foreground", "--ember-label", "--ember-metric", "--ember-numeral", "--ember-positive", "--ember-alert"].map((k) => [k, t[k] ?? t["--ink"]] as const);
      for (const [g, gv] of grounds) {
        expect(gv, `${block} ${g}`).toMatch(/^#/);
        for (const [i, iv] of inks) expect(contrast(iv, gv), `${block} ${i} on ${g}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

/* ------------------------------ preview pages ------------------------------ */

const parts = new Map<string, string>();
const headStyles = new Map<string, string>();
function writePreviewPart(name: string, html: string) {
  const out = process.env.EMBER_PREVIEW_OUT;
  if (!out) return;
  parts.set(name, html);
  for (const style of document.head.querySelectorAll("style")) if (style.id) headStyles.set(style.id, style.textContent ?? "");
  if (!["rail", "usage", "header"].every((p) => parts.has(p))) return;
  mkdirSync(out, { recursive: true });
  const shared = (process.env.EMBER_PREVIEW_CSS ?? "").split(",").filter(Boolean).map((f) => readFileSync(f, "utf8")).join("\n");
  const themes = (process.env.EMBER_PREVIEW_THEMES ?? `ember=${join(ROOT, "themes/ember.css")},navaigate=${join(ROOT, "themes/navaigate.css")}`).split(",").map((x) => x.split("="));
  const composer = `<div class="flex items-center gap-1 rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground"><span class="mr-auto">Ask the agent to do something…</span>`
    + `<button type="button" data-nav-part="composer-chip" class="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs leading-tight text-muted-foreground">Run on Studio</button>`
    + `<button type="button" data-nav-part="composer-chip" data-state="open" class="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs leading-tight text-muted-foreground data-[state=open]:bg-state-hover data-[state=open]:text-foreground">Claude · Max</button></div>`;
  for (const [id, file] of themes) {
    const theme = readFileSync(file, "utf8");
    for (const mode of ["dark", "light"]) {
      const page = `<!doctype html><html lang="en-GB" class="${mode}"><head><meta charset="utf-8"><title>Ember preview (${id}, ${mode})</title>`
        + `<style>${shared}</style><style>${[...headStyles.values()].join("\n")}</style><style>${theme}</style>`
        + `<style>body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--font-sans)} .pv{display:grid;grid-template-columns:288px 1fr;min-height:100vh} .pv-side{background:var(--sidebar);border-right:1px solid var(--sidebar-border)} .pv-main{padding:24px;display:flex;flex-direction:column;gap:20px;align-items:flex-start} .pv-h{display:flex;gap:8px}</style>`
        + `</head><body><div class="pv" data-bb-plugin="navaigate-skin"><aside class="pv-side" aria-label="Sidebar">${parts.get("rail")}</aside><main class="pv-main"><h1 class="sr-only">Ember preview</h1><div class="pv-h">${parts.get("header")}</div>${parts.get("usage")}<div style="width:520px">${composer}</div></main></div></body></html>`;
      writeFileSync(join(out, `${id}-${mode}.html`), page);
    }
  }
}

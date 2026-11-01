// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Rail } from "../src/rail";
import type { FleetBoard } from "../src/machines";
import type { M1ServiceState } from "../server-m1-service";

const NOW = 1_800_000_000_000;
const BOOT = 1_793_000_000;

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

const board: FleetBoard = {
  serverId: "srv-laptop", serverKey: "laptop",
  columns: [
    { key: "laptop", label: "laptop home", serverId: "srv-laptop", online: true, lastSeenAt: NOW, threads: [] },
    { key: "studio", label: "Studio home", serverId: "srv-studio", online: true, lastSeenAt: NOW, threads: [] },
    { key: "work", label: "work Client", serverId: "srv-work", online: false, lastSeenAt: NOW, threads: [] },
  ],
};
const service: M1ServiceState = {
  reachable: true, checkedAt: NOW, error: null,
  probe: { bootAt: BOOT * 1000, probedAt: (BOOT + 7200) * 1000, bbRunning: true, bbVersion: "0.48.1", bbStartedAt: (BOOT + 60) * 1000, gui: "present", app: "absent", loginItem: "unknown", launchAgent: "running", awakeHeld: true, awakeSetting: { enabled: true, scope: "all hosts" } },
};

function renderRail(calls: { n: number }) {
  const thread = { id: "t1", projectId: "p1", title: "Local", displayTitle: "Local", status: "idle", runtimeStatus: "idle", queuedWork: "none", activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 }, indicator: "none", isHidden: false, host: null, createdAt: NOW, updatedAt: NOW, lastActivityAt: NOW, href: "/projects/p1/threads/t1", providerId: "claude-code" } as unknown as PluginSidebarThread;
  return renderSlot(
    { component: () => <Rail activeThreadId="t1" activeProjectId="p1" onNavigate={() => {}} /> },
    {},
    {
      sidebarThreads: { status: "ready", threads: [thread], projects: [{ id: "p1", name: "Atlas", isPersonal: false }] as never, sections: [] },
      rpc: { fleet_board: () => ({ available: true, board, error: null }), m1_service: () => { calls.n++; return service; } } as never,
      context: { projectId: "p1", threadId: "t1" },
    },
  );
}

describe("Studio service card in the rail", () => {
  it("appears when Studio is picked, and not for the Mac the rail runs on", async () => {
    const calls = { n: 0 };
    renderRail(calls);
    await waitFor(() => expect(document.querySelectorAll('[data-nav-part="machine-tile"]')).toHaveLength(3));
    expect(document.querySelector('[data-nav-part="m1-service"]')).toBeNull();
    expect(calls.n).toBe(0);
    const m1 = [...document.querySelectorAll('[data-nav-part="machine-tile"]')].find((tile) => tile.textContent?.startsWith("Studio"))!;
    fireEvent.click(m1);
    await waitFor(() => expect(document.querySelector('[data-nav-part="m1-service"]')).not.toBeNull());
    await waitFor(() => expect(document.body.textContent).toContain("Running headless"));
    const m4 = [...document.querySelectorAll('[data-nav-part="machine-tile"]')].find((tile) => tile.textContent?.startsWith("Work"))!;
    fireEvent.click(m4);
    await waitFor(() => expect(document.querySelector('[data-nav-part="m1-service"]')).toBeNull());
  });
});

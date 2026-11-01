// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { NewThreadComposerProps, NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { RoutePreview } from "../server-route-preview";

const composer = vi.hoisted(() => ({ props: null as NewThreadComposerProps | null }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...actual, experimental_NewThreadComposer: (props: NewThreadComposerProps) => { composer.props = props; return <div data-testid="native-composer" />; } };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { buildNativeWorkInput, buildRoutePreviewInput, NativeWorkComposer } from "../src/native-work-composer";
import { clock } from "../src/route-preview";

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, String(value)); }, removeItem: (name: string) => { items.delete(name); }, clear: () => items.clear(), key: () => null, get length() { return items.size; } });
});
afterEach(() => { cleanup(); composer.props = null; vi.unstubAllGlobals(); vi.clearAllMocks(); });

const OBSERVED = Date.UTC(2026, 10, 1, 13, 59);
const CHECKED = Date.UTC(2026, 10, 1, 14, 5);
function preview(over: Partial<RoutePreview> = {}): RoutePreview {
  return {
    route: { machine: "studio", serverId: "srv_m1", hostId: "host_m1", mode: "auto", reason: "Selected Studio's independent owner from fresh eligible CPU/RAM capacity", warnings: [], candidates: [] },
    refusal: null, checkedAt: CHECKED,
    machines: [
      { machine: "studio", chosen: true, eligible: true, reasons: [], score: 7.4, xcode: { verified: true, version: "26.1" }, providers: [
        { id: "codex", name: "Codex", available: true, auth: "ready", observedAt: OBSERVED, planLabel: "Pro" },
        { id: "cursor", name: "Cursor", available: false, auth: "unauthenticated", observedAt: OBSERVED, planLabel: null },
      ] },
      { machine: "laptop", chosen: false, eligible: false, reasons: ["The host has insufficient available CPU or RAM"], score: null, xcode: { verified: false, version: null }, providers: null },
    ],
    ...over,
  };
}
const project = { id: "proj_test", name: "NavAIgate", kind: "standard", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, sources: [] };
function mount(rpc: Record<string, (input: unknown) => unknown> = {}, props: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const view = renderSlot({ component: NativeWorkComposer }, { rootThreadId: "thr_root", sourceThreadId: "thr_source", projectId: "proj_test", defaultSelection: { providerId: "codex", model: "gpt-5", reasoningLevel: "high" }, ...props }, {
    rpc: { native_route_preview: (input: unknown) => { calls.push(input); return preview(); }, native_session_adopt: () => ({}), ...rpc } as never,
    sdk: { threads: { spawn: async () => makeThreadResponse({ id: "thr_child", projectId: "proj_test", environmentId: null }) }, projects: { get: async () => project }, plugins: { callRpc: async () => { throw new Error("none"); } }, system: { usageLimits: async () => ({ codex: { status: "ok", planLabel: "Pro", windows: [{ label: "Session", kind: "five-hour", usedPercent: 25, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] } }) as never } } as never,
  });
  return { view, calls };
}
const choose = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));

describe("route preview in the New work dialog", () => {
  it("shows nothing and asks nothing while the job stays on this Mac", async () => {
    const { calls } = mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    expect(screen.queryByTestId("route-preview")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("previews the chosen Mac, each provider's availability and when it was observed, before anything is sent", async () => {
    const { calls } = mount();
    choose("Auto");
    const panel = await screen.findByTestId("route-preview");
    await waitFor(() => expect(panel.textContent).toContain("Auto would start on Studio"));
    expect(calls[0]).toMatchObject({ machine: "Auto", providerId: "codex", model: "gpt-5", reasoningLevel: "high", destinationProjectName: "NavAIgate", routing: { workload: "general" } });
    expect(panel.textContent).toContain("Selected Studio's independent owner");
    const m1 = within(panel).getByTestId("route-preview-studio");
    expect(m1.textContent).toContain("Chosen");
    expect(m1.textContent).toContain(`Codex available, observed ${clock(OBSERVED)}`);
    expect(m1.textContent).toContain(`Cursor unavailable (not signed in), observed ${clock(OBSERVED)}`);
    expect(m1.textContent).toContain("Xcode 26.1");
    const m5 = within(panel).getByTestId("route-preview-laptop");
    expect(m5.textContent).toContain("Not eligible: The host has insufficient available CPU or RAM");
    expect(m5.textContent).toContain("Providers not reported");
    expect(panel.textContent).toContain(`Checked ${clock(CHECKED)}`);
  });

  it("shows why a start would be refused instead of letting the error arrive after sending", async () => {
    mount({ native_route_preview: () => preview({ route: null, refusal: "Work requires an explicitly Clientco workload", machines: [] }) });
    choose("Work");
    const panel = await screen.findByTestId("route-preview");
    await waitFor(() => expect(panel.textContent).toContain("Would not start: Work requires an explicitly Clientco workload"));
  });

  it("says the preview is unavailable when Fleet cannot be asked", async () => {
    mount({ native_route_preview: () => { throw new Error("Fleet is not running"); } });
    choose("Studio");
    await waitFor(() => expect(screen.getByTestId("route-preview").textContent).toContain("Could not preview the route: Fleet is not running"));
  });

  it("asks again when a routing choice changes", async () => {
    const { calls } = mount();
    choose("Auto");
    await screen.findByTestId("route-preview");
    fireEvent.click(screen.getByLabelText("Can run unattended"));
    await waitFor(() => expect(calls.some((call) => (call as { routing?: { unattended?: boolean } }).routing?.unattended === true)).toBe(true));
  });
});

describe("route preview reads go through rpcFlight", () => {
  it("reuses the answer when a choice is switched back, and asks again only on Refresh", async () => {
    const { calls } = mount();
    const asked = (machine: string) => calls.filter((call) => (call as { machine?: string }).machine === machine).length;
    choose("Studio");
    await waitFor(() => expect(asked("studio")).toBe(1));
    choose("Auto");
    await waitFor(() => expect(asked("Auto")).toBe(1));
    choose("Studio");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(asked("studio")).toBe(1);
    await waitFor(() => expect(screen.getByTestId("route-preview").textContent).toContain("Checked"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await waitFor(() => expect(asked("studio")).toBe(2));
  });
});

describe("a Mac with Xcode as a placement choice", () => {
  it("offers Needs Xcode and previews, then sends, the xcode requirement", async () => {
    const { calls, view } = mount({ native_work_start: (input) => ({ outcome: "started", requestId: (input as { requestId: string }).requestId, threadId: "thr_r", localThreadId: "thr_l", commandId: null, url: null, route: preview().route, warning: null }) });
    choose("Studio");
    await screen.findByTestId("route-preview");
    fireEvent.click(screen.getByLabelText("Needs Xcode"));
    await waitFor(() => expect(calls.some((call) => (call as { routing?: { requiredCapabilities?: string[] } }).routing?.requiredCapabilities?.[0] === "xcode")).toBe(true));
    const request: NewThreadRequest = {
      projectId: "proj_test", providerId: "codex", model: "gpt-5", reasoningLevel: "high", permissionMode: "full", executionInputSources: {},
      environment: { type: "host", hostId: "host_local", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
      input: [{ type: "text", text: "Build the iOS target", mentions: [] }],
    };
    await act(async () => { await composer.props!.onSubmit(request); });
    const sent = view.inspection.rpcCalls.find((call) => call.method === "native_work_start")!.input as { routing: { requiredCapabilities?: string[] } };
    expect(sent.routing.requiredCapabilities).toEqual(["xcode"]);
  });

  it("maps the choice into the routed payload only when ticked", () => {
    const base = { machine: "studio" as const, includeContext: false, routing: { workload: "general" as const, needsNas: false, unattended: false } };
    const request: NewThreadRequest = { projectId: "p", providerId: "codex", model: "m", reasoningLevel: "high", permissionMode: "full", executionInputSources: {}, environment: { type: "project-default" }, input: [{ type: "text", text: "x", mentions: [] }] };
    const off = buildNativeWorkInput(request, base);
    expect(off.ok && off.input.routing).toEqual({ workload: "general" });
    const on = buildNativeWorkInput(request, { ...base, routing: { ...base.routing, needsXcode: true } });
    expect(on.ok && on.input.routing).toEqual({ workload: "general", requiredCapabilities: ["xcode"] });
  });

  it("builds the preview request from the same choices", () => {
    expect(buildRoutePreviewInput({ machine: "Auto", selection: { providerId: "codex", model: "gpt-5", reasoningLevel: "high" }, destination: "NavAIgate", routing: { workload: "client", needsNas: true, unattended: false, needsXcode: true }, environment: { type: "host", hostId: "h", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } } } })).toEqual({
      machine: "Auto", providerId: "codex", model: "gpt-5", reasoningLevel: "high", destinationProjectName: "NavAIgate",
      routing: { workload: "client", needsNas: true, requiredCapabilities: ["xcode"] }, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
    });
    expect(buildRoutePreviewInput({ machine: "studio", routing: { workload: "general", needsNas: false, unattended: false }, destination: "" })).toEqual({ machine: "studio", routing: { workload: "general" } });
  });
});

describe("allowance when starting a job", () => {
  it("shows the plan allowance of the chosen provider on this Mac, and says the other Mac uses its own sign-in", async () => {
    mount();
    const chip = await screen.findByTestId("allowance-chip");
    await waitFor(() => expect(chip.textContent).toContain("Session 75% left"));
    expect(screen.getByTestId("allowance-note").textContent).toContain("This Mac");
    choose("Studio");
    expect(screen.getByTestId("allowance-note").textContent).toContain("Studio uses its own sign-in");
  });
});

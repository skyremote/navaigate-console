// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { NewThreadComposerProps, NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { NativeContextPreview, NativeWorkReceipt } from "../server-native-work";

const composer = vi.hoisted(() => ({ props: null as NewThreadComposerProps | null }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...actual, experimental_NewThreadComposer: (props: NewThreadComposerProps) => { composer.props = props; return <div data-testid="native-composer" />; } };
});
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { NativeWorkComposer } from "../src/native-work-composer";
import { parseContextFilePaths } from "../src/context-bundle-controls";

const COMMIT = "5dc2c537ad2762caa162adb34aff7d1e9cecc081";
const downloads: { name: string; text: string }[] = [];
beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, String(value)); }, removeItem: (name: string) => { items.delete(name); }, clear: () => items.clear(), key: () => null, get length() { return items.size; } });
  downloads.length = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => { const index = downloads.push({ name: "", text: "" }) - 1; void (blob as Blob).text().then((text) => { downloads[index]!.text = text; }); return `blob:fixture-${index}`; });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { const last = downloads.at(-1); if (last) last.name = this.download; });
});
afterEach(() => { cleanup(); composer.props = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const summary = (over: Partial<NativeContextPreview> = {}): NativeContextPreview => ({
  format: "portable-v1", createdAt: 1_800_000_000_000, sourceMachine: "laptop", sourceThreadId: "thr_source", commit: COMMIT, repository: "verified",
  decisions: 3, decisionTexts: ["DECISION_A ship on Friday", "DECISION_B keep the text fallback"], messages: 40, omittedMessages: 12, omittedAttachments: 2,
  files: [{ path: "README.md", sha256: "a".repeat(64), sizeBytes: 9 }], ...over,
});
const bundle = { schema: "navaigate.portable-context", version: 1, createdAt: 1_800_000_000_000, narrative: { brief: {}, decisions: [], messages: [], omitted: { messageIds: [], attachmentIds: [] }, provenance: "caller-supplied" }, source: { owner: { serverId: "s", machineKey: "laptop", hostId: "h", environmentId: "e", projectId: "p" }, workspace: {}, repository: { verification: "unknown", reason: "x" } }, files: [] };
const request: NewThreadRequest = { projectId: "proj_test", providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "full", executionInputSources: {}, environment: { type: "project-default" }, input: [{ type: "text", text: "Carry on", mentions: [] }] };
const project = { id: "proj_test", name: "Atlas", kind: "standard", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, sources: [] };
function receipt(over: Partial<NativeWorkReceipt> = {}): NativeWorkReceipt {
  return { outcome: "started", requestId: "00000000-0000-4000-8000-000000000000", threadId: "thr_remote", localThreadId: "thr_mirror", commandId: null, url: null, route: { machine: "studio", serverId: "srv", hostId: null, mode: "manual", reason: "Chosen", warnings: [], candidates: [] }, warning: null, ...over };
}
function mount(rpc: Record<string, (input: unknown) => unknown> = {}, props: Record<string, unknown> = {}) {
  const view = renderSlot({ component: NativeWorkComposer }, { rootThreadId: "thr_root", sourceThreadId: "thr_source", projectId: "proj_test", ...props }, {
    rpc: { native_session_adopt: () => ({}), native_route_preview: () => ({ route: null, refusal: null, machines: [], checkedAt: 1 }), ...rpc } as never,
    sdk: { threads: { spawn: async () => makeThreadResponse({ id: "thr_child", projectId: "proj_test", environmentId: null }) }, projects: { get: async () => project } } as never,
  });
  return view;
}
const choose = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const startCall = (view: ReturnType<typeof mount>) => view.inspection.rpcCalls.find((call) => call.method === "native_work_start")?.input as Record<string, unknown>;
const send = () => act(async () => { await composer.props!.onSubmit(request); });
const okStart = { native_work_start: (input: unknown) => receipt({ requestId: (input as { requestId: string }).requestId }) };

describe("choosing the files a context bundle carries", () => {
  it("reads one project-relative path per line and refuses anything else", () => {
    expect(parseContextFilePaths(" README.md \n\ndocs/a.md\n")).toEqual({ ok: true, files: [{ path: "README.md" }, { path: "docs/a.md" }] });
    expect(parseContextFilePaths("")).toEqual({ ok: true, files: [] });
    for (const bad of ["/etc/passwd", "../secret", "a/../b", "C:\\x", "a\\b", "./a"]) expect(parseContextFilePaths(bad)).toMatchObject({ ok: false });
    expect(parseContextFilePaths("a\na")).toMatchObject({ ok: false, error: expect.stringMatching(/once/) });
    expect(parseContextFilePaths(Array.from({ length: 21 }, (_, index) => `f${index}`).join("\n"))).toMatchObject({ ok: false, error: expect.stringMatching(/20/) });
  });

  it("sends the chosen files with the structured context", async () => {
    const view = mount(okStart);
    choose("Studio");
    fireEvent.click(screen.getByLabelText("Send structured context"));
    fireEvent.change(screen.getByLabelText("Files to carry"), { target: { value: "README.md\ndocs/plan.md" } });
    await send();
    expect(startCall(view)).toMatchObject({ structuredContext: { selectedFiles: [{ path: "README.md" }, { path: "docs/plan.md" }] } });
  });

  it("refuses an unsafe path before anything is sent and keeps the draft", async () => {
    const view = mount(okStart);
    choose("Studio");
    fireEvent.click(screen.getByLabelText("Send structured context"));
    fireEvent.change(screen.getByLabelText("Files to carry"), { target: { value: "/etc/passwd" } });
    await expect(send()).rejects.toThrow(/project-relative/);
    expect(startCall(view)).toBeUndefined();
  });
});

describe("exporting a context bundle", () => {
  it("downloads the bundle as a file and says what it holds", async () => {
    const calls: unknown[] = [];
    mount({ native_context_export: (input) => { calls.push(input); return { filename: "context-bundle-thr_source-2026-11-01-14-05.json", summary: summary(), bundle }; } });
    choose("Studio");
    fireEvent.change(screen.getByLabelText("Files to carry"), { target: { value: "README.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Download context bundle" }));
    const shown = await screen.findByTestId("context-summary");
    expect(calls[0]).toEqual({ sourceThreadId: "thr_source", structuredContext: { selectedFiles: [{ path: "README.md" }] } });
    expect(downloads[0]!.name).toBe("context-bundle-thr_source-2026-11-01-14-05.json");
    await waitFor(() => expect(JSON.parse(downloads[0]!.text)).toEqual(bundle));
    expect(shown.textContent).toContain("3 decisions");
    expect(shown.textContent).toContain("40 messages");
    expect(shown.textContent).toContain("left out 12 messages and 2 attachments");
    expect(shown.textContent).toContain(`commit ${COMMIT.slice(0, 7)}`);
    expect(shown.textContent).toContain("README.md");
  });

  it("reports a failed export instead of saving an empty file", async () => {
    mount({ native_context_export: () => { throw new Error("The source repository commit changed during export."); } });
    choose("Studio");
    fireEvent.click(screen.getByRole("button", { name: "Download context bundle" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("commit changed during export"));
    expect(downloads).toHaveLength(0);
  });
});

describe("importing a saved context bundle", () => {
  const pick = (name: string, text: string) => fireEvent.change(screen.getByLabelText("Use a saved context bundle"), { target: { files: [new File([text], name, { type: "application/json" })] } });

  it("checks the file, shows what it holds, and sends it instead of building one from the conversation", async () => {
    const inspected: unknown[] = [];
    const view = mount({ ...okStart, native_context_inspect: (input) => { inspected.push(input); return summary(); } });
    choose("Studio");
    pick("saved.json", JSON.stringify(bundle));
    const shown = await screen.findByTestId("context-summary");
    expect(inspected[0]).toEqual({ bundle });
    expect(shown.textContent).toContain("saved.json");
    expect(shown.textContent).toContain("DECISION_A ship on Friday");
    expect((screen.getByLabelText("Send structured context") as HTMLInputElement).disabled).toBe(true);
    await send();
    const sent = startCall(view);
    expect(sent.contextBundle).toEqual(bundle);
    expect("structuredContext" in sent).toBe(false);
  });

  it("refuses a file that is not a context bundle and attaches nothing", async () => {
    const view = mount({ ...okStart, native_context_inspect: () => { throw new Error("Invalid input"); } });
    choose("Studio");
    pick("notes.txt", "hello");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not a context bundle"));
    pick("bad.json", JSON.stringify({ not: "a bundle" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Invalid input"));
    expect(screen.queryByTestId("context-summary")).toBeNull();
    await send();
    expect("contextBundle" in startCall(view)).toBe(false);
  });

  it("says the source commit is the bundle's own claim and that it replaces this conversation's context", async () => {
    mount({ native_context_inspect: () => summary() });
    choose("Studio");
    pick("saved.json", JSON.stringify(bundle));
    const shown = await screen.findByTestId("context-summary");
    expect(shown.textContent).toContain(`Source commit ${COMMIT.slice(0, 7)}, stated by the bundle and not checked by Fleet`);
    expect(screen.getByTestId("context-replaces-note").textContent).toContain("replaces this conversation's own context");
  });

  it("describes the saved bundle in the context hint instead of a text snapshot of this conversation", async () => {
    mount({ native_context_inspect: () => summary() });
    choose("Studio");
    expect(screen.getByTestId("native-work-context-hint").textContent).toContain("text snapshot of this conversation");
    pick("saved.json", JSON.stringify(bundle));
    await screen.findByTestId("context-summary");
    const hint = screen.getByTestId("native-work-context-hint").textContent ?? "";
    expect(hint).not.toContain("text snapshot");
    expect(hint).toContain("saved context bundle");
  });

  it("lets the bundle be removed again", async () => {
    mount({ native_context_inspect: () => summary() });
    choose("Studio");
    pick("saved.json", JSON.stringify(bundle));
    await screen.findByTestId("context-summary");
    fireEvent.click(screen.getByRole("button", { name: "Remove saved bundle" }));
    expect(screen.queryByTestId("context-summary")).toBeNull();
    expect((screen.getByLabelText("Send structured context") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("what the receipt shows when the context arrives", () => {
  const key = "navaigate:native-work:native-work:thr_root";
  const arrived = (context: NonNullable<NativeWorkReceipt["context"]>) => {
    const value = receipt({ context });
    localStorage.setItem(key, JSON.stringify({ requestId: value.requestId, payloadHash: "h", machine: "studio", receipt: value, notified: true, savedAt: 1 }));
    return mount({ native_work_receipt: () => value });
  };
  const base = { format: "portable-v1" as const, manifestPath: ".bb/fleet-context/0000/context.json", manifestSha256: "c".repeat(64), commit: COMMIT, decisions: 3, messages: 40, omittedMessages: 12, omittedAttachments: 2, files: [{ path: "README.md", sha256: "a".repeat(64) }] };

  it("lists the decisions, the commit, what was left out and where the manifest landed", async () => {
    arrived({ ...base, state: "delivered" });
    const block = await screen.findByTestId("context-arrival");
    expect(block.textContent).toContain("Context arrived on Studio");
    expect(block.textContent).toContain("3 decisions");
    expect(block.textContent).toContain("40 messages");
    expect(block.textContent).toContain("left out 12 messages and 2 attachments");
    expect(block.textContent).toContain(`Source commit ${COMMIT.slice(0, 7)}`);
    expect(block.textContent).toContain(".bb/fleet-context/0000/context.json");
    expect(block.textContent).toContain("README.md");
  });
  it("says so when the source commit is unknown or the context has not arrived", async () => {
    arrived({ ...base, state: "failed", commit: null, manifestSha256: null });
    const block = await screen.findByTestId("context-arrival");
    expect(block.textContent).toContain("Context did not arrive on Studio");
    expect(block.textContent).toContain("Source commit unknown");
  });
  it("marks an imported bundle's commit as the bundle's own claim", async () => {
    arrived({ ...base, state: "delivered", commitClaimed: true });
    expect((await screen.findByTestId("context-arrival")).textContent).toContain(`Source commit ${COMMIT.slice(0, 7)}, stated by the bundle and not checked by Fleet`);
  });
  it("shows a waiting state before delivery", async () => {
    arrived({ ...base, state: "pending", manifestSha256: null });
    expect((await screen.findByTestId("context-arrival")).textContent).toContain("Context is being delivered to Studio");
  });
});

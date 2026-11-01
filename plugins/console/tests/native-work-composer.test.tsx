// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { NewThreadComposerProps, NewThreadRequest } from "@get-bb/plugin-sdk/app";
import type { NativeWorkReceipt } from "../server-native-work";

// The SDK test composer calls `void onSubmit(...)`, so a refusal would become an
// unhandled rejection. Capture the host composer's props instead and drive
// onSubmit directly, which is exactly what the native composer does.
const composer = vi.hoisted(() => ({ props: null as NewThreadComposerProps | null, renders: [] as NewThreadComposerProps[], byId: new Map<string, NewThreadComposerProps>() }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...actual, experimental_NewThreadComposer: (props: NewThreadComposerProps) => {
    const id = React.useId();
    composer.byId.set(id, props);
    composer.props = props;
    composer.renders.push(props);
    return <div data-testid="native-composer" data-composer-id={id} />;
  } };
});
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { buildNativeWorkInput, nativeDestinationProjectName, nativeWorkPayloadKey, NativeWorkComposer, readNativeWorkPending } from "../src/native-work-composer";
import type { NativeWorkComposerProps, NativeWorkOptions } from "../src/native-work-composer";

// Node's own experimental localStorage shadows jsdom's; use a plain in-memory Storage.
beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, String(value)); },
    removeItem: (name: string) => { items.delete(name); }, clear: () => items.clear(), key: (index: number) => [...items.keys()][index] ?? null,
    get length() { return items.size; },
  });
});
afterEach(() => {
  cleanup();
  composer.props = null;
  composer.renders = [];
  composer.byId.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function request(over: Partial<NewThreadRequest> = {}): NewThreadRequest {
  return {
    projectId: "proj_test", providerId: "claude-code", model: "opus", reasoningLevel: "high", permissionMode: "full",
    executionInputSources: {},
    environment: { type: "host", hostId: "host_local", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } } },
    input: [{ type: "text", text: "Review the release notes", mentions: [] }],
    ...over,
  };
}
const options = (over: Partial<NativeWorkOptions> = {}): NativeWorkOptions => ({
  machine: "studio", sourceThreadId: "thr_source", rootThreadId: "thr_root", destinationProjectName: "Shared",
  includeContext: true, routing: { workload: "general", needsNas: false, unattended: false }, ...over,
});
function refused(over: Partial<NewThreadRequest>, opts: Partial<NativeWorkOptions> = {}) {
  const result = buildNativeWorkInput(request(over), options(opts));
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}
function receipt(over: Partial<NativeWorkReceipt> = {}): NativeWorkReceipt {
  return {
    outcome: "started", requestId: "00000000-0000-4000-8000-000000000000", threadId: "thr_remote", localThreadId: "thr_mirror",
    commandId: null, url: "https://m1.example/thread/thr_remote",
    route: { machine: "studio", serverId: "srv_m1", hostId: null, mode: "manual", reason: "Studio was chosen explicitly.", warnings: [], candidates: [] },
    warning: null, ...over,
  };
}
const verifiedAttachments: NonNullable<NativeWorkReceipt["attachments"]> = [
  { name: "Empty.txt", sizeBytes: 0, sha256: "a".repeat(64), verified: true },
  { name: "Notes.txt", sizeBytes: 42, sha256: "b".repeat(64), verified: true },
  { name: "Sales brief.pdf", sizeBytes: 1536, sha256: "c".repeat(64), verified: true },
  { name: "Preview.png", sizeBytes: 1572864, sha256: "d".repeat(64), verified: true },
];
const project = (name: string, kind: "standard" | "personal" = "standard") => ({ id: "proj_test", name, kind, createdAt: 1, updatedAt: 1, gitRemoteUrl: null, sources: [] });

function mount(props: Partial<NativeWorkComposerProps> = {}, setup: { rpc?: Record<string, (input: unknown) => unknown>; sdk?: Record<string, unknown>; projectName?: string } = {}) {
  const spawn = vi.fn(async (args: { visibility?: string }) => makeThreadResponse({ id: "thr_child", projectId: "proj_test", environmentId: null }));
  const update = vi.fn(async () => makeThreadResponse({ id: "thr_child", projectId: "proj_test", environmentId: null }));
  const onStarted = vi.fn();
  const view = renderSlot({ component: NativeWorkComposer }, { rootThreadId: "thr_root", sourceThreadId: "thr_source", projectId: "proj_test", onStarted, ...props }, {
    rpc: { native_session_adopt: () => ({}), ...setup.rpc } as never,
    sdk: {
      threads: { spawn, update },
      projects: { get: async () => project(setup.projectName ?? "Shared (away)") },
      ...setup.sdk,
    } as never,
  });
  return { view, spawn, update, onStarted };
}
const submit = (value: NewThreadRequest) => {
  const props = composer.props;
  if (!props) throw new Error("composer not mounted");
  return act(async () => { await props.onSubmit(value); });
};
const choose = (machine: string) => fireEvent.click(screen.getByRole("radio", { name: machine }));
const startCalls = (view: ReturnType<typeof mount>["view"]) => view.inspection.rpcCalls.filter((call) => call.method === "native_work_start");

describe("routed request mapping refuses what another Mac cannot honour", () => {
  it.each([
    ["a permission mode other than full", { permissionMode: "auto" as const }, /full permissions/],
    ["agent options", { sessionOptions: { plan: "on" } }, /Agent options/],
    ["a scheduled send", { sendAt: 1 }, /Scheduled sends/],
    ["a host image", { input: [{ type: "localImage" as const, hostId: "host_local", path: "/tmp/a.png" }] }, /Upload it with the attachment button/],
    ["an image URL", { input: [{ type: "image" as const, url: "https://example.test/image.png" }] }, /Attach the image file/],
    ["an agent-only image", { input: [{ type: "localImage" as const, sourceProjectId: "proj_test", path: "image.png", visibility: "agent-only" as const }] }, /agent-only/],
    ["agent-only text", { input: [{ type: "text" as const, text: "x", mentions: [], visibility: "agent-only" as const }] }, /agent-only/],
    ["a local file mention", { input: [{ type: "text" as const, text: "see a.md", mentions: [{ start: 4, end: 8, resource: { kind: "path" as const, label: "a.md", path: "a.md", entryKind: "file" as const, source: "workspace" as const } }] }] }, /file on this Mac/],
    ["another conversation", { input: [{ type: "text" as const, text: "@thread:thr_other", mentions: [{ start: 0, end: 17, resource: { kind: "thread" as const, label: "Other", threadId: "thr_other" } }] }] }, /another conversation/],
    ["a reused workspace", { environment: { type: "reuse" as const, environmentId: "env_1" } }, /existing workspace/],
    ["a local folder path", { environment: { type: "host" as const, workspace: { type: "unmanaged" as const, path: "/Users/sam/x" } } }, /folder path/],
    ["no project", { environment: { type: "host" as const, workspace: { type: "personal" as const } } }, /Choose a project/],
    ["a custom environment provider", { environment: { type: "provider" as const, environmentProviderId: "p", inputs: null } }, /custom environment/],
  ])("refuses %s and keeps the draft", (_name, over, message) => {
    const error = refused(over as Partial<NewThreadRequest>);
    expect(error).toMatch(message);
    expect(error).toMatch(/draft is kept/);
  });

  it("refuses a source reference when context is switched off", () => {
    const text = "Use this conversation as context: @thread:thr_source\n\nGo";
    const error = refused({ input: [{ type: "text", text, mentions: [{ start: 34, end: 52, resource: { kind: "thread", label: "Source", threadId: "thr_source" } }] }] }, { includeContext: false });
    expect(error).toMatch(/context" is off/);
  });

  it("sends structured context only when opted in with a source and context on", () => {
    expect(buildNativeWorkInput(request(), options({ structuredContext: true }))).toMatchObject({ ok: true, input: { includeContext: true, structuredContext: {} } });
    const off = buildNativeWorkInput(request(), options());
    expect(off.ok && "structuredContext" in off.input).toBe(false);
    const noContext = buildNativeWorkInput(request(), options({ structuredContext: true, includeContext: false }));
    expect(noContext.ok && "structuredContext" in noContext.input).toBe(false);
    const standalone = buildNativeWorkInput(request(), options({ structuredContext: true, sourceThreadId: undefined, rootThreadId: undefined }));
    expect(standalone.ok && "structuredContext" in standalone.input).toBe(false);
  });

  it("copies exactly the supported fields and drops the local host", () => {
    const named = buildNativeWorkInput(request({ serviceTier: "priority" }), options({ routing: { workload: "client", needsNas: true, unattended: false } }));
    expect(named).toEqual({ ok: true, input: {
      machine: "studio", prompt: "Review the release notes", sourceThreadId: "thr_source", rootThreadId: "thr_root", destinationProjectName: "Shared",
      includeContext: true, providerId: "claude-code", model: "opus", reasoningLevel: "high", serviceTier: "priority",
      routing: { workload: "client", needsNas: true }, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
    } });
    const checkout = buildNativeWorkInput(request({ environment: { type: "host", hostId: "host_local", workspace: { type: "unmanaged", path: null, branch: { kind: "new", baseBranch: "develop" } } } }), options());
    expect(checkout.ok && checkout.input.workspace).toEqual({ type: "unmanaged", path: null, branch: { kind: "new", baseBranch: "develop" } });
    const fallback = buildNativeWorkInput(request({ environment: { type: "project-default" } }), options());
    expect(fallback.ok && "workspace" in fallback.input).toBe(false);
  });

  it("maps the real native checkout and worktree provider requests to destination workspace intent", () => {
    const native = (environment: NewThreadRequest["environment"]) => buildNativeWorkInput(request({ environment }), options());
    expect(native({ type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host_local" }, inputs: {} })).toMatchObject({ ok: true, input: { workspace: { type: "unmanaged", path: null } } });
    expect(native({ type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host_local" }, inputs: { branch: { kind: "existing", name: "main" } } })).toMatchObject({ ok: true, input: { workspace: { type: "unmanaged", path: null, branch: { kind: "existing", name: "main" } } } });
    expect(native({ type: "provider", environmentProviderId: "project-checkout", inputs: { branch: { kind: "new", baseBranch: "main" } } })).toMatchObject({ ok: true, input: { workspace: { type: "unmanaged", path: null, branch: { kind: "new", baseBranch: "main" } } } });
    expect(native({ type: "provider", environmentProviderId: "git-worktree", machine: { type: "existing", hostId: "host_local" }, inputs: { branch: { kind: "named", name: "release" } } })).toMatchObject({ ok: true, input: { workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "release" } } } });
    expect(native({ type: "provider", environmentProviderId: "git-worktree", inputs: {} })).toMatchObject({ ok: true, input: { workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } } });
  });

  it.each([
    { environmentProviderId: "project-checkout", inputs: { path: "/Users/sam/custom" } },
    { environmentProviderId: "project-checkout", inputs: { branch: { kind: "new", baseBranch: "main", name: "silently-dropped" } } },
    { environmentProviderId: "git-worktree", inputs: { kind: "existing", path: "/Users/sam/old-worktree" } },
    { environmentProviderId: "git-worktree", inputs: { branch: { kind: "named", name: "main" }, path: "/Users/sam/old-worktree" } },
    { environmentProviderId: "project-checkout", inputs: {}, machine: { type: "new" as const, machineProviderId: "cloud", inputs: null } },
  ])("refuses native options that cannot be preserved on the destination", (selection) => {
    expect(buildNativeWorkInput(request({ environment: { type: "provider", ...selection } }), options()).ok).toBe(false);
  });

  it("keeps source thread tokens for the backend to resolve as a snapshot", () => {
    const text = "Use this conversation as context: @thread:thr_source\n\nGo";
    const result = buildNativeWorkInput(request({ input: [{ type: "text", text, mentions: [{ start: 34, end: 52, resource: { kind: "thread", label: "Source", threadId: "thr_source" } }] }] }), options());
    expect(result.ok && result.input.prompt).toBe(text);
  });

  it("maps only the away mirror alias to the NAS project name", () => {
    expect(nativeDestinationProjectName("Shared (away)")).toBe("Shared");
    expect(nativeDestinationProjectName("Shared")).toBe("Shared");
    expect(nativeDestinationProjectName("atlas (away)")).toBe("atlas (away)");
    expect(nativeDestinationProjectName("Survey app (away)")).toBe("Survey app (away)");
  });

  it("copies native project uploads exactly, including another source project and the composer's file name", () => {
    const result = buildNativeWorkInput(request({ input: [
      { type: "text", text: "Read both attachments", mentions: [] },
      { type: "localImage", sourceProjectId: "proj_images", path: "image-upload.png" },
      { type: "localFile", path: "file-upload.pdf", name: "Sales brief.pdf", mimeType: "application/pdf", sizeBytes: 42 },
    ] }), options());
    expect(result.ok && result.input.attachments).toEqual([
      { type: "localImage", sourceProjectId: "proj_images", path: "image-upload.png", name: "image-upload.png", mimeType: null },
      { type: "localFile", sourceProjectId: "proj_test", path: "file-upload.pdf", name: "Sales brief.pdf", mimeType: "application/pdf" },
    ]);
    expect(result.ok && result.input.prompt).toBe("Read both attachments");
  });

  it("refuses an excessive attachment count or known total size before dispatch", () => {
    const text = { type: "text" as const, text: "Read the files", mentions: [] };
    expect(refused({ input: [text, ...Array.from({ length: 11 }, (_, i) => ({ type: "localFile" as const, path: `${i}.txt` }))] })).toMatch(/10 attachments/);
    expect(refused({ input: [text, { type: "localFile", path: "huge.txt", sizeBytes: 8 * 1024 * 1024 + 1 }] })).toMatch(/8 MiB/);
  });
});

describe("NativeWorkComposer routed placement", () => {
  it("shows a submission refusal inside the native dialog when the host keeps only the draft", async () => {
    mount();
    choose("Studio");
    await act(async () => { await expect(composer.props!.onSubmit(request({ permissionMode: "auto" }))).rejects.toThrow(/full permissions/); });
    expect(screen.getByRole("alert").textContent).toMatch(/full permissions.*draft is kept/);
  });
  it("keeps a refused attachment draft and permits a deliberate retry with a fresh request ID", async () => {
    const detail = { reason: "rejected" as const, message: "Attachment upload could not be verified" };
    const { view, onStarted } = mount({}, { rpc: { native_work_start: (input) => receipt({ requestId: (input as { requestId: string }).requestId, outcome: "unknown", notStarted: detail, threadId: null, localThreadId: null, url: null }) } });
    choose("Studio");
    const draft = request({ input: [{ type: "text", text: "Review this file" }, { type: "localFile", path: "brief.txt", name: "brief.txt", sizeBytes: 10 }] });
    await expect(composer.props!.onSubmit(draft)).rejects.toThrow(/Nothing was started.*draft is kept/);
    expect(readNativeWorkPending("native-work:thr_root")).toBeNull();
    await expect(composer.props!.onSubmit(draft)).rejects.toThrow(/Nothing was started/);
    const calls = startCalls(view).map((call) => call.input as { requestId: string; attachments: unknown[] });
    expect(calls).toHaveLength(2);
    expect(calls[1].requestId).not.toBe(calls[0].requestId);
    expect(calls[0].attachments).toEqual([{ type: "localFile", sourceProjectId: "proj_test", path: "brief.txt", name: "brief.txt", mimeType: null }]);
    expect(onStarted).not.toHaveBeenCalled();
    expect(screen.queryByText(/Files verified on/)).toBeNull();
  });

  it("recovers a confirmed not-started result after reload using only a receipt read", async () => {
    mount({}, { rpc: { native_work_start: () => { throw new Error("Lost response"); }, native_work_receipt: () => { throw new Error("Offline"); } } });
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/not confirmed/);
    const saved = readNativeWorkPending("native-work:thr_root")!;
    cleanup();
    const next = mount({}, { rpc: { native_work_receipt: () => receipt({ requestId: saved.requestId, outcome: "unknown", threadId: null, localThreadId: null, url: null, notStarted: { reason: "unavailable", message: "Studio was unreachable before dispatch" } }) } });
    await waitFor(() => expect(readNativeWorkPending("native-work:thr_root")).toBeNull());
    expect(next.view.inspection.rpcCalls.map((call) => call.method)).toEqual(["native_work_receipt"]);
    expect(next.onStarted).not.toHaveBeenCalled();
  });

  it("does not adopt or release another request's receipt", async () => {
    const { onStarted } = mount({}, { rpc: { native_work_start: () => receipt(), native_work_receipt: () => receipt() } });
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/different request.*remains unconfirmed/);
    expect(readNativeWorkPending("native-work:thr_root")?.receipt).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("starts on the chosen Mac with the inferred destination and shows the accepted receipt", async () => {
    const { view, onStarted } = mount({}, { rpc: { native_work_start: (input) => receipt({ requestId: (input as { requestId: string }).requestId }) } });
    choose("Studio");
    await waitFor(() => expect(screen.getByLabelText("Destination project name")).toHaveProperty("value", "Shared"));
    expect(composer.props?.defaultPermissionMode).toBe("full");
    await submit(request());
    const [call] = startCalls(view);
    const input = call.input as Record<string, unknown>;
    expect(input.requestId).toMatch(UUID);
    expect(input).toMatchObject({ machine: "studio", destinationProjectName: "Shared", includeContext: true, sourceThreadId: "thr_source", rootThreadId: "thr_root", routing: { workload: "general" } });
    expect(screen.getByText("Started on Studio")).toBeTruthy();
    expect(screen.getByText("Route: Studio was chosen explicitly.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(view.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_mirror" }]);
    expect(onStarted).toHaveBeenCalledWith({ kind: "routed", receipt: expect.objectContaining({ outcome: "started", localThreadId: "thr_mirror" }) });
  });

  it.each(["started", "sent"] as const)("shows verified files and readable sizes on the resolved Mac for a %s receipt", async (outcome) => {
    const resolved = { ...receipt().route!, machine: "laptop", reason: "Fleet selected Laptop." };
    const { view } = mount({}, { rpc: { native_work_start: (input) => receipt({
      requestId: (input as { requestId: string }).requestId, outcome, route: resolved, attachments: verifiedAttachments,
    }) } });
    choose("Auto");
    await submit(request());

    const card = screen.getByRole("status");
    expect(within(card).getByText("Files verified on Laptop (destination Mac)")).toBeTruthy();
    expect(within(card).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Empty.txt · 0 B", "Notes.txt · 42 B", "Sales brief.pdf · 1.5 KiB", "Preview.png · 1.5 MiB",
    ]);
    for (const file of verifiedAttachments) expect(card.textContent).not.toContain(file.sha256);
    expect(card.textContent).toContain(`Request ${(startCalls(view)[0].input as { requestId: string }).requestId}`);
  });

  it("does not claim file verification for an unconfirmed receipt even when it contains file metadata", async () => {
    const { onStarted } = mount({}, { rpc: { native_work_start: (input) => receipt({
      requestId: (input as { requestId: string }).requestId, outcome: "unknown", attachments: verifiedAttachments,
      threadId: null, localThreadId: null, url: null,
    }) } });
    choose("Studio");
    await act(async () => { await expect(composer.props!.onSubmit(request())).rejects.toThrow(/not confirmed/); });

    const card = screen.getByRole("status");
    expect(within(card).getByText("Not confirmed on Studio")).toBeTruthy();
    expect(card.textContent).not.toMatch(/Files verified on/);
    expect(within(card).queryByRole("list")).toBeNull();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("does not attribute file verification to the requested Mac without a resolved route", async () => {
    mount({}, { rpc: { native_work_start: (input) => receipt({
      requestId: (input as { requestId: string }).requestId, route: null, attachments: verifiedAttachments,
    }) } });
    choose("Studio");
    await submit(request());
    expect(screen.getByRole("status").textContent).not.toMatch(/Files verified on/);
  });

  it("infers Clientco work from the project name", async () => {
    const { view } = mount({}, { projectName: "Clientco Portal", rpc: { native_work_start: (input) => receipt({ requestId: (input as { requestId: string }).requestId }) } });
    choose("Auto");
    await waitFor(() => expect(screen.getByLabelText("Destination project name")).toHaveProperty("value", "Clientco Portal"));
    expect(screen.getByLabelText("Work type")).toHaveProperty("value", "client");
    await submit(request());
    expect(startCalls(view)[0].input).toMatchObject({ machine: "Auto", routing: { workload: "client" } });
  });

  it("refuses unsupported drafts before any request leaves this Mac", async () => {
    const { view, onStarted } = mount({}, { rpc: { native_work_start: () => receipt() } });
    choose("Laptop");
    await expect(composer.props!.onSubmit(request({ permissionMode: "accept-edits" }))).rejects.toThrow(/full permissions/);
    await expect(composer.props!.onSubmit(request({ environment: { type: "reuse", environmentId: "env_1" } }))).rejects.toThrow(/existing workspace/);
    expect(startCalls(view)).toHaveLength(0);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("reuses one request ID for a retried identical payload and never resends on its own", async () => {
    let attempts = 0;
    const { view, onStarted } = mount({}, { rpc: { native_work_start: (input) => {
      attempts++;
      if (attempts === 1) throw new Error("Request timed out");
      return receipt({ requestId: (input as { requestId: string }).requestId });
    } } });
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/timed out.*not confirmed.*reuses this request/s);
    await expect(composer.props!.onSubmit(request({ model: "sonnet" }))).rejects.toThrow(/is not resolved yet/);
    expect(onStarted).not.toHaveBeenCalled();
    expect(startCalls(view)).toHaveLength(1);
    await submit(request());
    const [first, second] = startCalls(view).map((call) => (call.input as { requestId: string }).requestId);
    expect(second).toBe(first);
    expect(onStarted).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Start other work" }));
    await submit(request({ input: [{ type: "text", text: "A different task", mentions: [] }] }));
    expect((startCalls(view)[2].input as { requestId: string }).requestId).not.toBe(first);
  });

  it("releases a refused request and gives a changed payload a new request ID", async () => {
    const { view } = mount({}, { rpc: {
      native_work_start: () => { throw new Error("No eligible machine can run this task."); },
      native_work_receipt: () => { throw new Error("No native work receipt exists for this request ID."); },
    } });
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/Nothing was started/);
    expect(readNativeWorkPending("native-work:thr_root")).toBeNull();
    await expect(composer.props!.onSubmit(request({ model: "sonnet" }))).rejects.toThrow(/Nothing was started/);
    const [a, b] = startCalls(view).map((call) => (call.input as { requestId: string }).requestId);
    expect(a).not.toBe(b);
  });

  it("keeps an unconfirmed receipt, blocks a second start and checks it only on request", async () => {
    const pending = receipt({ outcome: "unknown", threadId: null, localThreadId: null, url: null, warning: "No confirmed start receipt was received." });
    const { view, onStarted } = mount({}, { rpc: {
      native_work_start: (input) => ({ ...pending, requestId: (input as { requestId: string }).requestId }),
      native_work_receipt: (input) => receipt({ requestId: (input as { requestId: string }).requestId }),
    } });
    choose("Studio");
    // Rejecting keeps the native draft reviewable; the receipt is still recorded.
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/not confirmed.*draft is kept for review/);
    expect(onStarted).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Not confirmed on Studio")).toBeTruthy());
    await expect(composer.props!.onSubmit(request({ model: "sonnet" }))).rejects.toThrow(/Review the receipt/);
    expect(startCalls(view)).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check again" })); });
    await waitFor(() => expect(screen.getByText("Started on Studio")).toBeTruthy());
    expect(view.inspection.rpcCalls.map((call) => call.method).filter((method) => method !== "native_route_preview")).toEqual(["native_work_start", "native_work_receipt"]);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost accepted response after a reload by reading the receipt, never starting again", async () => {
    const started: string[] = [];
    const first = mount({}, { rpc: {
      native_work_start: (input) => { started.push((input as { requestId: string }).requestId); throw new Error("Request timed out"); },
      native_work_receipt: () => { throw new Error("fetch failed"); },
    } });
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/not confirmed/);
    expect(first.onStarted).not.toHaveBeenCalled();
    const saved = readNativeWorkPending("native-work:thr_root");
    expect(saved).toMatchObject({ requestId: started[0], receipt: null, machine: "studio" });
    cleanup();

    // Reload: same draft key, the original job was in fact accepted on Studio.
    const second = mount({}, { rpc: {
      native_work_start: () => { throw new Error("a second start must never be sent"); },
      native_work_receipt: (input) => receipt({ requestId: (input as { requestId: string }).requestId }),
    } });
    await waitFor(() => expect(screen.getByText("Started on Studio")).toBeTruthy());
    expect(second.view.inspection.rpcCalls).toEqual([expect.objectContaining({ method: "native_work_receipt", input: { requestId: started[0] } })]);
    expect(second.onStarted).toHaveBeenCalledTimes(1);
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/Review the receipt/);
    expect(startCalls(second.view)).toHaveLength(0);
    expect(started).toHaveLength(1);
  });

  it("keeps the same request ID for the same draft across a reload while unresolved", async () => {
    const ids: string[] = [];
    const handlers = { rpc: {
      native_work_start: (input: unknown) => { ids.push((input as { requestId: string }).requestId); throw new Error("Request timed out"); },
      native_work_receipt: () => { throw new Error("fetch failed"); },
    } };
    mount({}, handlers);
    choose("Studio");
    // The payload includes the inferred destination, so wait for it as a user would.
    await waitFor(() => expect(screen.getByLabelText("Destination project name")).toHaveProperty("value", "Shared"));
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/not confirmed/);
    cleanup();
    mount({}, handlers);
    await waitFor(() => expect(screen.getByText(/Could not check the receipt: fetch failed/)).toBeTruthy());
    choose("Studio");
    await waitFor(() => expect(screen.getByLabelText("Destination project name")).toHaveProperty("value", "Shared"));
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/not confirmed/);
    // A changed draft cannot jump the queue while the first request is unresolved.
    await expect(composer.props!.onSubmit(request({ model: "sonnet" }))).rejects.toThrow(/is not resolved yet/);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it("reuses the original request ID when an identical draft is sent after its receipt was dismissed", async () => {
    const ids: string[] = [];
    const { onStarted } = mount({}, { rpc: { native_work_start: (input) => { const requestId = (input as { requestId: string }).requestId; ids.push(requestId); return receipt({ requestId }); } } });
    choose("Studio");
    await submit(request());
    fireEvent.click(screen.getByRole("button", { name: "Start other work" }));
    cleanup();
    const again = mount({}, { rpc: { native_work_start: (input) => { const requestId = (input as { requestId: string }).requestId; ids.push(requestId); return receipt({ requestId }); } } });
    choose("Studio");
    await submit(request());
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(again.onStarted).not.toHaveBeenCalled();
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringMatching(/already started/));
  });

  it("fails closed before starting when the request ID cannot be saved", async () => {
    const { view, onStarted } = mount({}, { rpc: { native_work_start: () => receipt() } });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/cannot save the request ID.*Nothing was sent.*draft is kept/s);
    expect(startCalls(view)).toHaveLength(0);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("refreshes a stored accepted receipt on mount without notifying again", async () => {
    const stored = receipt({ requestId: "11111111-1111-4111-8111-111111111111" });
    localStorage.setItem("navaigate:native-work:native-work:thr_root", JSON.stringify({ requestId: stored.requestId, payloadHash: "h", machine: "studio", receipt: stored, notified: true, savedAt: 1 }));
    const { view, onStarted } = mount({}, { rpc: { native_work_receipt: () => stored } });
    await waitFor(() => expect(screen.getByText("Started on Studio")).toBeTruthy());
    expect(view.inspection.rpcCalls.map((call) => call.method)).toEqual(["native_work_receipt"]);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("never adopts another task's receipt when the backend rejects a reused ID", async () => {
    const { view } = mount({}, { rpc: {
      native_work_start: () => { throw new Error("This request ID already belongs to a different task. Inspect its original receipt before creating new work."); },
      native_work_receipt: () => receipt(),
    } });
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/send it again for a new request/);
    expect(view.inspection.rpcCalls.map((call) => call.method)).toEqual(["native_work_start"]);
    expect(readNativeWorkPending("native-work:thr_root")).toBeNull();
  });

  it("releases an unconfirmed request only after a visible warning", async () => {
    mount({}, { rpc: { native_work_start: (input) => receipt({ outcome: "unknown", requestId: (input as { requestId: string }).requestId, threadId: null, localThreadId: null, url: null }) } });
    choose("Studio");
    await expect(composer.props!.onSubmit(request())).rejects.toThrow(/not confirmed/);
    await waitFor(() => expect(screen.getByText("Not confirmed on Studio")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Start other work" }));
    expect(readNativeWorkPending("native-work:thr_root")).not.toBeNull();
    expect(screen.getByText(/may still start on Studio\. If you release it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release request" }));
    expect(readNativeWorkPending("native-work:thr_root")).toBeNull();
    expect(screen.queryByText("Not confirmed on Studio")).toBeNull();
  });

  it("shows an accepted job whose local session is unavailable without offering a new start", async () => {
    const { onStarted } = mount({}, { rpc: { native_work_start: (input) => receipt({
      requestId: (input as { requestId: string }).requestId, localThreadId: null,
      warning: "The work was accepted, but could not be added to this view: mirror offline. Open its original session; do not start another copy.",
    }) } });
    choose("Studio");
    await submit(request());
    expect(screen.getByText(/could not be added to this view/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open on Studio" }).getAttribute("href")).toBe("https://m1.example/thread/thr_remote");
    expect(onStarted).toHaveBeenCalledWith({ kind: "routed", receipt: expect.objectContaining({ localThreadId: null }) });
  });

  it("re-seeds a reused non-git workspace to the project checkout once, and not between Macs", async () => {
    const get = vi.fn(async () => ({ hostId: "host_local", isGitRepo: false, branchName: null }));
    mount({ defaultEnvironment: { type: "reuse", environmentId: "env_1" } }, { sdk: { environments: { get } } });
    expect(composer.props?.defaultEnvironment).toEqual({ type: "reuse", environmentId: "env_1" });
    choose("Studio");
    await waitFor(() => expect(composer.props?.defaultEnvironment).toEqual({ type: "host", hostId: "host_local", workspace: { type: "unmanaged", path: null } }));
    const seeded = composer.props!.defaultEnvironment;
    choose("Laptop");
    expect(composer.props!.defaultEnvironment).toBe(seeded);
    expect(composer.props!.defaultModel).toBe(composer.renders[0].defaultModel);
    expect(screen.getByText(/Workspace: the project checkout on the destination Mac/)).toBeTruthy();
  });
});

describe("NativeWorkComposer on this Mac", () => {
  it("spawns a hidden, metadata-grouped session with the native request unchanged and no core parent", async () => {
    const { view, spawn, onStarted } = mount();
    const value = request({ permissionMode: "auto", sessionOptions: { plan: "on" } });
    await submit(value);
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toEqual({ ...value, pluginMetadata: { nativeConversation: { rootThreadId: "thr_root", sourceThreadId: "thr_source", kind: "parallel" } } });
    expect("parentThreadId" in args).toBe(false);
    expect("parentNotifications" in args).toBe(false);
    expect("visibility" in args).toBe(false);
    expect(view.inspection.rpcCalls).toEqual([expect.objectContaining({ method: "native_session_adopt", input: { rootThreadId: "thr_root", threadId: "thr_child", kind: "parallel" } })]);
    expect(onStarted).toHaveBeenCalledWith({ kind: "local", threadId: "thr_child", grouped: true });
  });

  it("reports success and reveals the real session when grouping fails after the start", async () => {
    const { spawn, update, onStarted } = mount({}, { rpc: { native_session_adopt: () => { throw new Error("Grouping store unavailable"); } } });
    await submit(request());
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ threadId: "thr_child", visibility: "visible" });
    expect(toasts.warning).toHaveBeenCalledWith("The model started in a separate native session", expect.objectContaining({ action: expect.objectContaining({ label: "Open real thread" }) }));
    expect(onStarted).toHaveBeenCalledWith({ kind: "local", threadId: "thr_child", grouped: false });
  });

  it("refuses a different project before spawning", async () => {
    const { spawn } = mount();
    await expect(composer.props!.onSubmit(request({ projectId: "proj_other" }))).rejects.toThrow(/this conversation's project/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("payload keys are canonical for identical payloads", () => {
    const a = buildNativeWorkInput(request(), options());
    const b = buildNativeWorkInput(request(), options());
    expect(a.ok && b.ok && nativeWorkPayloadKey(a.input) === nativeWorkPayloadKey(b.input)).toBe(true);
  });
});


describe("receipt settlement keeps the current draft ledger", () => {
  const owner = "native-work:thr_root";
  function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
  const root = (index: number) => screen.getAllByTestId("native-composer")[index]!.closest("[data-native-work-composer]")! as HTMLElement;
  const propsOf = (element: HTMLElement) => composer.byId.get(within(element).getByTestId("native-composer").getAttribute("data-composer-id")!)!;
  const unknown = (id: string) => receipt({ requestId: id, outcome: "unknown", threadId: null, localThreadId: null, url: null });
  const releaseIn = (element: HTMLElement) => { fireEvent.click(within(element).getByRole("button", { name: "Start other work" })); fireEvent.click(within(element).getByRole("button", { name: "Release request" })); };

  it("keeps a newer lost-response request through an old negative check, two views and reload", async () => {
    const oldRead = deferred<NativeWorkReceipt>();
    const first = mount({}, { rpc: { native_work_start: (value) => unknown((value as { requestId: string }).requestId), native_work_receipt: () => oldRead.promise } });
    const firstRoot = root(0); fireEvent.click(within(firstRoot).getByRole("radio", { name: "Studio" }));
    await expect(propsOf(firstRoot).onSubmit(request())).rejects.toThrow(/not confirmed/);
    const older = readNativeWorkPending(owner)!;
    await waitFor(() => expect(within(firstRoot).getByRole("button", { name: "Check again" })).toBeTruthy());
    fireEvent.click(within(firstRoot).getByRole("button", { name: "Check again" }));
    const newStart = deferred<NativeWorkReceipt>(); let newerId = "";
    const second = mount({}, { rpc: {
      native_work_start: (value) => { newerId = (value as { requestId: string }).requestId; return newStart.promise; },
      native_work_receipt: (value) => { const id = (value as { requestId: string }).requestId; if (id === older.requestId) return unknown(id); throw new Error("New start response remains unavailable"); },
    } });
    const secondRoot = root(1);
    await waitFor(() => expect(within(secondRoot).getByRole("button", { name: "Start other work" })).not.toHaveProperty("disabled", true));
    fireEvent.click(within(secondRoot).getByRole("radio", { name: "Studio" })); releaseIn(secondRoot);
    let pendingStart!: Promise<void>;
    await act(async () => { pendingStart = Promise.resolve(propsOf(secondRoot).onSubmit(request({ input: [{ type: "text", text: "Second task awaiting its lost response", mentions: [] }] }))); await Promise.resolve(); });
    await waitFor(() => expect(newerId).not.toBe(""));
    expect(newerId).not.toBe(older.requestId);
    const newer = readNativeWorkPending(owner)!;
    await act(async () => { oldRead.resolve({ ...unknown(older.requestId), notStarted: { reason: "unavailable", message: "The old request was never sent" } }); await Promise.resolve(); });
    expect(readNativeWorkPending(owner)).toEqual(newer);
    await act(async () => { newStart.reject(new Error("Response lost after the new owner accepted")); await expect(pendingStart).rejects.toThrow(/not confirmed/); });
    expect(readNativeWorkPending(owner)?.requestId).toBe(newerId);
    expect(first.onStarted).not.toHaveBeenCalled(); expect(second.onStarted).not.toHaveBeenCalled();
    cleanup();
    const reloaded = mount({}, { rpc: { native_work_receipt: (value) => receipt({ requestId: (value as { requestId: string }).requestId }) } });
    await waitFor(() => expect(reloaded.onStarted).toHaveBeenCalledTimes(1));
    expect(readNativeWorkPending(owner)?.requestId).toBe(newerId);
    expect(reloaded.view.inspection.rpcCalls).toEqual([expect.objectContaining({ method: "native_work_receipt", input: { requestId: newerId } })]);
  });

  it.each(["accepted", "negative", "collision"])("ignores a stale %s start settlement after another view starts work", async (outcome) => {
    const response = deferred<NativeWorkReceipt>(); let oldId = "";
    const first = mount({}, { rpc: { native_work_start: (value) => { oldId = (value as { requestId: string }).requestId; return response.promise; } } });
    const firstRoot = root(0); fireEvent.click(within(firstRoot).getByRole("radio", { name: "Studio" }));
    let oldSubmit!: Promise<void>;
    await act(async () => { oldSubmit = Promise.resolve(propsOf(firstRoot).onSubmit(request())); await Promise.resolve(); });
    await waitFor(() => expect(oldId).not.toBe(""));
    const second = mount({}, { rpc: { native_work_receipt: (value) => unknown((value as { requestId: string }).requestId), native_work_start: (value) => unknown((value as { requestId: string }).requestId) } });
    const secondRoot = root(1);
    await waitFor(() => expect(within(secondRoot).getByRole("button", { name: "Start other work" })).not.toHaveProperty("disabled", true));
    fireEvent.click(within(secondRoot).getByRole("radio", { name: "Studio" })); releaseIn(secondRoot);
    await expect(propsOf(secondRoot).onSubmit(request({ input: [{ type: "text", text: "Newer unrelated task", mentions: [] }] }))).rejects.toThrow(/not confirmed/);
    const newer = readNativeWorkPending(owner)!;
    await act(async () => {
      if (outcome === "collision") response.reject(new Error("Request ID already belongs to a different task"));
      else response.resolve(outcome === "accepted" ? receipt({ requestId: oldId }) : { ...unknown(oldId), notStarted: { reason: "rejected", message: "Old request refused" } });
      await expect(oldSubmit).rejects.toThrow(/earlier draft or view/);
    });
    expect(readNativeWorkPending(owner)).toEqual(newer);
    expect(first.onStarted).not.toHaveBeenCalled(); expect(second.onStarted).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("does not let a stale explicit Release clear another view's ledger", async () => {
    const first = mount({}, { rpc: { native_work_start: (value) => unknown((value as { requestId: string }).requestId) } });
    const firstRoot = root(0); fireEvent.click(within(firstRoot).getByRole("radio", { name: "Studio" }));
    await expect(propsOf(firstRoot).onSubmit(request())).rejects.toThrow(/not confirmed/);
    await waitFor(() => expect(within(firstRoot).getByRole("button", { name: "Start other work" })).toBeTruthy());
    fireEvent.click(within(firstRoot).getByRole("button", { name: "Start other work" }));
    mount({}, { rpc: { native_work_receipt: (value) => unknown((value as { requestId: string }).requestId), native_work_start: (value) => unknown((value as { requestId: string }).requestId) } });
    const secondRoot = root(1); await waitFor(() => expect(within(secondRoot).getByRole("button", { name: "Start other work" })).not.toHaveProperty("disabled", true));
    fireEvent.click(within(secondRoot).getByRole("radio", { name: "Studio" })); releaseIn(secondRoot);
    await expect(propsOf(secondRoot).onSubmit(request({ model: "another-model" }))).rejects.toThrow(/not confirmed/);
    const newer = readNativeWorkPending(owner)!;
    fireEvent.click(within(firstRoot).getByRole("button", { name: "Release request" }));
    expect(readNativeWorkPending(owner)).toEqual(newer); expect(first.onStarted).not.toHaveBeenCalled();
  });
  it("does not let an old key's receipt notify or clear a newer key's checking state", async () => {
    const oldRead = deferred<NativeWorkReceipt>(); const newRead = deferred<NativeWorkReceipt>();
    let oldId = ""; const nextStarted = vi.fn();
    const f = mount({}, { rpc: { native_work_start: (value) => { oldId = (value as { requestId: string }).requestId; return unknown(oldId); }, native_work_receipt: (value) => (value as { requestId: string }).requestId === oldId ? oldRead.promise : newRead.promise } });
    const element = root(0); fireEvent.click(within(element).getByRole("radio", { name: "Studio" }));
    await expect(propsOf(element).onSubmit(request())).rejects.toThrow(/not confirmed/);
    const older = readNativeWorkPending(owner)!;
    await waitFor(() => expect(within(element).getByRole("button", { name: "Check again" })).toBeTruthy());
    fireEvent.click(within(element).getByRole("button", { name: "Check again" }));
    const newKey = "native-work:new-key";
    const newer = { ...older, requestId: "11111111-1111-4111-8111-111111111111", payloadHash: "new-draft-payload" };
    localStorage.setItem("navaigate:native-work:" + newKey, JSON.stringify(newer));
    f.view.lifecycle.rerender(<NativeWorkComposer rootThreadId="thr_new" sourceThreadId="thr_new" projectId="proj_test" draftKey={newKey} initialMachine="studio" onStarted={nextStarted} />);
    await waitFor(() => expect(f.view.inspection.rpcCalls.filter((call) => call.method === "native_work_receipt")).toHaveLength(2));
    await act(async () => { oldRead.resolve(receipt({ requestId: oldId })); await Promise.resolve(); });
    await expect(propsOf(root(0)).onSubmit(request())).rejects.toThrow(/Checking an earlier request/);
    expect(readNativeWorkPending(newKey)).toEqual(newer); expect(readNativeWorkPending(owner)).toEqual(older);
    expect(f.onStarted).not.toHaveBeenCalled(); expect(nextStarted).not.toHaveBeenCalled();
    await act(async () => { newRead.resolve(unknown(newer.requestId)); await Promise.resolve(); });
  });

  it("requires the pending payload hash as well as its request ID before clearing", async () => {
    const oldRead = deferred<NativeWorkReceipt>();
    mount({}, { rpc: { native_work_start: (value) => unknown((value as { requestId: string }).requestId), native_work_receipt: () => oldRead.promise } });
    const element = root(0); fireEvent.click(within(element).getByRole("radio", { name: "Studio" }));
    await expect(propsOf(element).onSubmit(request())).rejects.toThrow(/not confirmed/);
    const older = readNativeWorkPending(owner)!;
    await waitFor(() => expect(within(element).getByRole("button", { name: "Check again" })).toBeTruthy());
    fireEvent.click(within(element).getByRole("button", { name: "Check again" }));
    const newer = { ...older, payloadHash: "changed-current-payload" };
    localStorage.setItem("navaigate:native-work:" + owner, JSON.stringify(newer));
    await act(async () => { oldRead.resolve({ ...unknown(older.requestId), notStarted: { reason: "rejected", message: "Older payload refused" } }); await Promise.resolve(); });
    expect(readNativeWorkPending(owner)).toEqual(newer);
  });

  it.each(["unknown", "negative"])("keeps another view's accepted same-ID receipt when a late %s start response arrives", async (outcome) => {
    const response = deferred<NativeWorkReceipt>(); let requestId = "";
    const first = mount({}, { rpc: { native_work_start: (value) => { requestId = (value as { requestId: string }).requestId; return response.promise; } } });
    const firstRoot = root(0); fireEvent.click(within(firstRoot).getByRole("radio", { name: "Studio" }));
    let submission!: Promise<void>;
    await act(async () => { submission = Promise.resolve(propsOf(firstRoot).onSubmit(request())); await Promise.resolve(); });
    await waitFor(() => expect(requestId).not.toBe(""));
    const second = mount({}, { rpc: { native_work_receipt: () => receipt({ requestId }) } });
    await waitFor(() => expect(second.onStarted).toHaveBeenCalledTimes(1));
    const accepted = readNativeWorkPending(owner)!;
    expect(accepted.receipt?.outcome).toBe("started");
    await act(async () => {
      response.resolve(outcome === "unknown" ? unknown(requestId) : { ...unknown(requestId), notStarted: { reason: "unavailable", message: "Earlier request attempt was unavailable" } });
      await submission;
    });
    expect(readNativeWorkPending(owner)).toEqual(accepted);
    expect(first.onStarted).not.toHaveBeenCalled(); expect(second.onStarted).toHaveBeenCalledTimes(1);
    expect(toasts.success).not.toHaveBeenCalled();
  });

});

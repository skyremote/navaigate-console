import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createNativeWork, nativeWorkStartInput, nativeWorkStartOutput, type NativeWorkDependencies } from "../server-native-work";
import { createNativeSessions, type NativeSessionState } from "../server-native-sessions";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
const request = () => ({ requestId: randomUUID(), machine: "Auto" as const, prompt: "Use this conversation as context: @thread:thr_root\n\nCompare the source evidence.", sourceThreadId: "thr_root", rootThreadId: "thr_root", includeContext: true, providerId: "claude-code", model: "claude-test", reasoningLevel: "high", serviceTier: "default" });
function route(machine = "studio", serverId = machine === "laptop" ? "local-owner" : "remote-owner") {
  return { machine, serverId, hostId: `host-${machine}`, mode: "auto" as const, reason: "Eligible owner", warnings: [], candidates: [{ machine, serverId, hostId: `host-${machine}`, eligible: true, reasons: [], score: 1 }] };
}
function state(): NativeSessionState {
  return { rootThreadId: "thr_root", title: "Conversation", projectId: "proj_test", activeThreadId: "thr_root", version: 1, pending: null, warning: null, members: [{ id: "thr_root", sourceThreadId: null, kind: "root", providerId: "codex", environmentId: null, model: "codex-test", reasoningLevel: "high", serviceTier: "default", title: "Conversation", status: "idle", createdAt: 1 }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>([
    ["thr_root", makeThreadResponse({ id: "thr_root", projectId: "proj_test", visibility: "visible", providerId: "codex" })],
    ["thr_actual", makeThreadResponse({ id: "thr_actual", projectId: "proj_test", visibility: "visible", providerId: "claude-code", originPluginId: "fleet" })],
    ["thr_mirror", makeThreadResponse({ id: "thr_mirror", projectId: "proj_test", visibility: "hidden", providerId: "fleet-mirror", originPluginId: "fleet" })],
  ]);
  const project = { id: "proj_test", name: "Ventures", kind: "standard" as "standard" | "personal", sources: [], createdAt: 1, updatedAt: 1, gitRemoteUrl: null };
  const metadata = new Map<string, Record<string, unknown>>();
  const mutations: Array<{ threadId: string; visibility?: "visible" | "hidden"; parentThreadId?: string | null }> = [];
  const host = createFakePluginHost({ pluginId: "navaigate-skin", sdk: {
    threads: {
      get: async ({ threadId }) => {
        const thread = threads.get(threadId);
        if (!thread) throw new Error("404 thread not found");
        return { ...thread };
      },
      update: async ({ threadId, ...changes }) => {
        mutations.push({ threadId, ...changes });
        const thread = threads.get(threadId)!;
        Object.assign(thread, changes);
        return { ...thread };
      },
      defaultExecutionOptions: async () => ({ model: "test-model", reasoningLevel: "high", serviceTier: "default", permissionMode: "full", source: "client/thread/start" }),
      getPluginMetadata: async ({ threadId, pluginId }) => metadata.get(`${pluginId}:${threadId}`) ?? {},
      updatePluginMetadata: async ({ threadId, pluginId, set }) => {
        const key = `${pluginId}:${threadId}`;
        const next = { ...metadata.get(key), ...set };
        metadata.set(key, next);
        return next as never;
      },
    }, projects: { get: async () => ({ ...project }) },
  } });
  hosts.push(host);
  const fleet: NativeWorkDependencies["fleet"] = {
    route: vi.fn(async () => route()),
    start: vi.fn(async () => ({ outcome: "started" as const, threadId: "thr_actual", url: "https://owner.example/session", route: route() })),
    board: vi.fn(async () => ({ available: true, board: { serverId: "local-owner", serverKey: "laptop" } })),
    mirrorOpen: vi.fn(async () => ({ localThreadId: "thr_mirror" })),
  };
  const sessions: NativeWorkDependencies["sessions"] = { state: vi.fn(async () => state()), adoptStarted: vi.fn(async () => undefined) };
  const readTranscript = vi.fn(async () => "USER: Read /Users/example/only-on-source.txt.\nASSISTANT: See @project:proj_old and @thread:thr_old.");
  const dependencies: NativeWorkDependencies = { sessions, fleet, transcript: readTranscript };
  let service = createNativeWork(host.bb, dependencies);
  return { ...host, project, threads, metadata, mutations, fleet, sessions, readTranscript, dependencies, get service() { return service; }, reload() { service = createNativeWork(host.bb, dependencies); } };
}

describe("native routed work validation and context", () => {
  it("validates UTF-8 size and transferable workspace before any provider or route call", async () => {
    const f = fixture();
    for (const input of [
      { ...request(), prompt: "😀".repeat(70_000) },
      { ...request(), workspace: { type: "unmanaged", path: "/Users/example/private-checkout" } },
      { ...request(), workspace: { type: "reuse", environmentId: "env_source" } },
      { ...request(), attachments: [{ path: "/tmp/attachment" }] },
    ]) await expect(f.service.start(input as never)).rejects.toThrow();
    expect(f.fleet.route).not.toHaveBeenCalled();
    expect(f.fleet.start).not.toHaveBeenCalled();
    expect(f.mutations).toEqual([]);
    expect(f.sessions.state).not.toHaveBeenCalled();
  });

  it("rejects unresolved local resource references and wrong conversation roots before dispatch", async () => {
    const f = fixture();
    for (const input of [
      { ...request(), prompt: "Use @thread:thr_unrelated" },
      { ...request(), prompt: "Use @project:proj_secret" },
      { ...request(), prompt: "Use @section:sec_secret" },
      { ...request(), includeContext: false },
      { ...request(), rootThreadId: "thr_other" },
    ]) await expect(f.service.start(input)).rejects.toThrow(/reference|conversation/);
    expect(f.fleet.start).not.toHaveBeenCalled();
    expect(f.fleet.route).not.toHaveBeenCalled();
    expect(f.mutations).toEqual([]);
  });

  it("infers Clientco from the server project and sends a bounded explicit snapshot without copying paths", async () => {
    const f = fixture();
    f.project.name = "Clientco_Portal";
    vi.mocked(f.fleet.route).mockImplementation(async (input) => route(input.routing?.workload === "client" ? "work" : "studio"));
    f.readTranscript.mockResolvedValue(`SOURCE-START /Users/example/only-on-source.txt @project:proj_old\n${"Evidence. 😀".repeat(30_000)}\nSOURCE-END @thread:thr_old`);
    const input = { ...request(), routing: { workload: "general" as const, unattended: true }, workspace: { type: "managed-worktree" as const, baseBranch: { kind: "named" as const, name: "main" } } };
    await f.service.start(input);
    const start = vi.mocked(f.fleet.start).mock.calls[0][0];
    expect(start.routing).toEqual({ workload: "client", unattended: true });
    expect(start.projectName).toBe("Clientco_Portal");
    expect(start.workspace).toEqual(input.workspace);
    expect(start.requestId).toBe(input.requestId);
    expect(start.providerId).toBe(input.providerId);
    expect(start.serviceTier).toBe(input.serviceTier);
    expect(start.prompt).toContain("Compare the source evidence.");
    expect(start.prompt).toContain("SOURCE-START");
    expect(start.prompt).toContain("SOURCE-END");
    expect(start.prompt).toContain("Historic source files, uploads and attachments were not copied");
    expect(start.prompt).toContain("Source context truncated");
    expect(start.prompt).toContain("/Users/example/only-on-source.txt");
    expect(start.prompt).not.toMatch(/@(thread|project|section):/);
    expect(Buffer.byteLength(start.prompt, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(start.prompt, "utf8")).toBeLessThan(62_000);
    // The strict SDK fake has no filesystem/attachment APIs: any copy would fail.
    expect(f.harness.inspection.sdk.calls.some((call) => /file|attachment|upload/i.test(call.path))).toBe(false);
  });

  it("never trims the current task to make room for a source snapshot", async () => {
    const f = fixture();
    const prompt = "A".repeat(256 * 1024);
    expect(nativeWorkStartInput.parse({ ...request(), prompt }).prompt).toBe(prompt);
    await expect(f.service.start({ ...request(), prompt })).rejects.toThrow(/room|exceeds/);
    expect(f.fleet.start).not.toHaveBeenCalled();
    await f.service.start({ ...request(), prompt, sourceThreadId: undefined, rootThreadId: undefined, includeContext: false });
    expect(vi.mocked(f.fleet.start).mock.calls[0][0].prompt).toBe(prompt);
  });

  it("refuses a route with no eligible owner before starting any job", async () => {
    const f = fixture();
    vi.mocked(f.fleet.route).mockResolvedValue({ ...route(), machine: null, serverId: null, reason: "No verified Clientco owner" });
    await expect(f.service.start(request())).rejects.toThrow("No verified Clientco owner");
    expect(f.fleet.start).not.toHaveBeenCalled();
  });

  it("carries uploaded native attachments through the route, start and verified receipt", async () => {
    const f = fixture();
    const attachments = [
      { type: "localImage" as const, sourceProjectId: "proj_images", path: "image-upload.png", name: "image-upload.png", mimeType: null },
      { type: "localFile" as const, sourceProjectId: "proj_test", path: "file-upload.pdf", name: "Brief.pdf", mimeType: "application/pdf" },
    ];
    const verified = [{ name: "Brief.pdf", sha256: "a".repeat(64), sizeBytes: 128, verified: true as const }];
    vi.mocked(f.fleet.start).mockResolvedValue({ outcome: "started", threadId: "thr_actual", route: route(), attachments: verified });
    const input = { ...request(), attachments };
    const result = await f.service.start(input);
    expect(f.fleet.route).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
    expect(f.fleet.start).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
    expect(result.attachments).toEqual(verified);
    f.reload();
    expect((await f.service.receipt({ requestId: input.requestId })).attachments).toEqual(verified);
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
  });
});

describe("stable native work receipts", () => {
  it("starts exactly once across concurrent requests and reload, rejecting changed payloads under the same ID", async () => {
    const f = fixture();
    const gate = deferred<Awaited<ReturnType<typeof f.fleet.start>>>();
    vi.mocked(f.fleet.start).mockReturnValue(gate.promise);
    const input = request();
    const first = f.service.start(input);
    const second = f.service.start(input);
    await vi.waitFor(() => expect(f.fleet.start).toHaveBeenCalledTimes(1));
    gate.resolve({ outcome: "started", threadId: "thr_actual", route: route(), requestId: input.requestId });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(f.fleet.mirrorOpen).toHaveBeenCalledTimes(1);
    expect(f.readTranscript).toHaveBeenCalledTimes(1);
    f.reload();
    expect(await f.service.start(input)).toEqual(a);
    await expect(f.service.start({ ...input, prompt: "Different task" })).rejects.toThrow(/different task/);
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
    expect(f.fleet.mirrorOpen).toHaveBeenCalledTimes(1);
  });

  it("retains an unknown remote outcome without blindly issuing another start", async () => {
    const f = fixture();
    vi.mocked(f.fleet.start).mockRejectedValue(new Error("Connection dropped after submission"));
    const input = request();
    const first = await f.service.start(input);
    expect(first.outcome).toBe("unknown");
    expect(first.requestId).toBe(input.requestId);
    expect(first.warning).toContain("do not submit a new request");
    f.reload();
    expect(await f.service.start(input)).toEqual(first);
    expect((await f.service.receipt({ requestId: input.requestId })).outcome).toBe("unknown");
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
    expect(f.fleet.mirrorOpen).not.toHaveBeenCalled();
  });

  it("releases only a positive not-started receipt and leaves that request terminal across reload", async () => {
    const f = fixture();
    const detail = { reason: "rejected" as const, message: "Attachment could not be read" };
    vi.mocked(f.fleet.start).mockRejectedValue(new Error("fleet-rejected: Attachment could not be read"));
    f.fleet.workReceipt = vi.fn(async () => ({ state: "missing", result: null, notStarted: detail }));
    const input = request();
    const first = await f.service.start(input);
    expect(first).toMatchObject({ outcome: "unknown", notStarted: detail, threadId: null });
    expect(first.warning).toContain("Nothing was started");
    f.reload();
    expect(await f.service.start(input)).toEqual(first);
    expect(await f.service.receipt({ requestId: input.requestId })).toEqual(first);
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
    expect(f.fleet.mirrorOpen).not.toHaveBeenCalled();
    vi.mocked(f.fleet.start).mockResolvedValue({ outcome: "started", threadId: "thr_actual", route: route() });
    expect((await f.service.start({ ...input, requestId: randomUUID() })).outcome).toBe("started");
  });

  it.each(["missing", "unavailable"])("does not treat a %s receipt lookup as proof that an uncertain start never ran", async (lookup) => {
    const f = fixture();
    vi.mocked(f.fleet.start).mockRejectedValue(new Error("Lost upload or start response"));
    f.fleet.workReceipt = vi.fn(async () => {
      if (lookup === "unavailable") throw new Error("Owner offline");
      return { state: "missing", result: null };
    });
    const input = request();
    expect((await f.service.start(input)).notStarted).toBeUndefined();
    f.reload();
    expect((await f.service.receipt({ requestId: input.requestId })).outcome).toBe("unknown");
    await f.service.start(input);
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
  });

  it("recovers a positive pre-connect failure on a later read without resending", async () => {
    const f = fixture();
    vi.mocked(f.fleet.start).mockRejectedValue(new Error("SSH connection was refused"));
    f.fleet.workReceipt = vi.fn().mockRejectedValueOnce(new Error("Receipt unavailable")).mockResolvedValue({
      state: "missing", result: null, notStarted: { reason: "unavailable", message: "Studio is unreachable; nothing was sent" },
    });
    const input = request();
    expect((await f.service.start(input)).outcome).toBe("unknown");
    f.reload();
    expect((await f.service.receipt({ requestId: input.requestId })).notStarted).toEqual({ reason: "unavailable", message: "Studio is unreachable; nothing was sent" });
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
  });

  it("requires the durable request claim before crossing the start boundary", async () => {
    const f = fixture();
    vi.spyOn(f.bb.storage.kv, "set").mockRejectedValue(new Error("Disk unavailable"));
    await expect(f.service.start(request())).rejects.toThrow("Disk unavailable");
    expect(f.fleet.start).not.toHaveBeenCalled();
  });

  it("returns the actual accepted receipt when mirroring fails", async () => {
    const f = fixture();
    vi.mocked(f.fleet.mirrorOpen).mockRejectedValue(new Error("Owner has not published its mirror yet"));
    const input = request();
    const result = nativeWorkStartOutput.parse(await f.service.start(input));
    expect(result.outcome).toBe("started");
    expect(result.threadId).toBe("thr_actual");
    expect(result.localThreadId).toBeNull();
    expect(result.url).toBe("https://owner.example/session");
    expect(result.warning).toContain("work was accepted");
    expect(result.warning).toContain("do not start another copy");
    await f.service.start(input);
    await f.service.receipt({ requestId: input.requestId });
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
    expect(f.fleet.mirrorOpen).toHaveBeenCalledTimes(1);
  });

  it("returns a started receipt and reveals the child when adoption fails", async () => {
    const f = fixture();
    vi.mocked(f.sessions.adoptStarted).mockRejectedValue(new Error("Conversation index could not be saved"));
    const result = await f.service.start(request());
    expect(result.outcome).toBe("started");
    expect(result.localThreadId).toBe("thr_mirror");
    expect(result.warning).toContain("index could not be saved");
    expect(f.threads.get("thr_mirror")?.visibility).toBe("visible");
    expect(f.fleet.mirrorOpen).toHaveBeenCalledWith({ machine: "studio", threadId: "thr_actual", localProjectId: "proj_test" });
  });

  it("keeps an accepted receipt even if later local persistence is unavailable", async () => {
    const f = fixture();
    const set = f.bb.storage.kv.set.bind(f.bb.storage.kv);
    let writes = 0;
    vi.spyOn(f.bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (++writes > 1) throw new Error("Disk filled after remote acceptance");
      await set(key, value);
    });
    const input = request();
    const result = await f.service.start(input);
    expect(result.outcome).toBe("started");
    expect(result.threadId).toBe("thr_actual");
    expect(result.warning).toContain("receipt could not be saved");
    expect((await f.service.start(input)).outcome).toBe("started");
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
  });

  it("uses the actual local thread for own-machine work without creating a mirror, including standalone starts", async () => {
    const f = fixture();
    vi.mocked(f.fleet.route).mockResolvedValue(route("laptop"));
    vi.mocked(f.fleet.start).mockResolvedValue({ outcome: "started", threadId: "thr_actual", route: route("laptop") });
    const result = await f.service.start(request());
    expect(result.localThreadId).toBe("thr_actual");
    expect(f.fleet.mirrorOpen).not.toHaveBeenCalled();
    expect(f.sessions.adoptStarted).toHaveBeenCalledWith({ rootThreadId: "thr_root", threadId: "thr_actual", sourceThreadId: "thr_root" });
    vi.mocked(f.sessions.adoptStarted).mockClear();
    const standalone = await f.service.start({ ...request(), sourceThreadId: undefined, rootThreadId: undefined, includeContext: false, prompt: "A standalone task" });
    expect(standalone.localThreadId).toBe("thr_actual");
    expect(f.sessions.adoptStarted).not.toHaveBeenCalled();
  });

  it("resolves an accepted broker command read-only and mirrors/adopts its actual owner thread once", async () => {
    const f = fixture();
    vi.mocked(f.fleet.start).mockResolvedValue({ outcome: "sent", threadId: null, commandId: "cmd_accepted", route: route() });
    f.fleet.commandGet = vi.fn().mockResolvedValueOnce({ status: "pending", threadId: null }).mockResolvedValue({ status: "started", machine: "studio", threadId: "thr_actual", url: "https://owner.example/actual" });
    const input = request();
    const pending = await f.service.start(input);
    expect(pending.outcome).toBe("sent");
    expect(pending.commandId).toBe("cmd_accepted");
    expect(f.fleet.mirrorOpen).not.toHaveBeenCalled();
    expect((await f.service.receipt({ requestId: input.requestId })).outcome).toBe("sent");
    const started = await f.service.receipt({ requestId: input.requestId });
    expect(started.outcome).toBe("started");
    expect(started.threadId).toBe("thr_actual");
    expect(started.localThreadId).toBe("thr_mirror");
    expect(started.url).toBe("https://owner.example/actual");
    await f.service.receipt({ requestId: input.requestId });
    f.reload();
    await f.service.receipt({ requestId: input.requestId });
    expect(f.fleet.commandGet).toHaveBeenCalledTimes(2);
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
    expect(f.fleet.mirrorOpen).toHaveBeenCalledTimes(1);
    expect(f.sessions.adoptStarted).toHaveBeenCalledTimes(1);
  });

  it("recovers an unknown start from the original Fleet receipt without resending", async () => {
    const f = fixture();
    vi.mocked(f.fleet.start).mockRejectedValue(new Error("Reply lost"));
    const input = request();
    await f.service.start(input);
    f.reload();
    f.fleet.workReceipt = vi.fn(async () => ({ state: "completed" as const, result: { outcome: "started" as const, threadId: "thr_actual", requestId: input.requestId, route: route() } }));
    expect((await f.service.receipt({ requestId: input.requestId })).localThreadId).toBe("thr_mirror");
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
    expect(f.fleet.workReceipt).toHaveBeenCalledWith({ requestId: input.requestId });
  });

  it.each(["failed", "unknown"])("keeps a %s broker command receipt without creating a replacement", async (status) => {
    const f = fixture();
    vi.mocked(f.fleet.start).mockResolvedValue({ outcome: "sent", threadId: null, commandId: "cmd_accepted", route: route() });
    f.fleet.commandGet = vi.fn(async () => ({ status, machine: "studio", threadId: null, error: "Owner outcome detail" }));
    const input = request();
    await f.service.start(input);
    const result = await f.service.receipt({ requestId: input.requestId });
    expect(result.outcome).toBe("sent");
    expect(result.warning).toContain(`command is ${status}`);
    await f.service.start(input);
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
    expect(f.fleet.mirrorOpen).not.toHaveBeenCalled();
  });

  it("does not open a returned thread against the wrong machine when a command receipt disagrees with its route", async () => {
    const f = fixture();
    vi.mocked(f.fleet.start).mockResolvedValue({ outcome: "sent", threadId: null, commandId: "cmd_accepted", route: route() });
    f.fleet.commandGet = vi.fn(async () => ({ status: "started", machine: "work", threadId: "thr_actual" }));
    const input = request();
    await f.service.start(input);
    const result = await f.service.receipt({ requestId: input.requestId });
    expect(result.threadId).toBeNull();
    expect(result.warning).toContain("machine does not match");
    expect(f.fleet.mirrorOpen).not.toHaveBeenCalled();
    expect(f.sessions.adoptStarted).not.toHaveBeenCalled();
  });
});

describe("internal Fleet-start association", () => {
  it("rejects a spoofed public adoption but accepts the confirmed Fleet path without changing Fleet ownership", async () => {
    const f = fixture();
    const sessions = createNativeSessions(f.bb);
    await sessions.state({ threadId: "thr_root" });
    Object.assign(f.threads.get("thr_mirror")!, { parentThreadId: "thr_root" });
    f.metadata.set("navaigate-skin:thr_mirror", { nativeConversation: { rootThreadId: "thr_root", sourceThreadId: "thr_root", kind: "parallel" } });
    f.metadata.set("fleet:thr_mirror", { machine: "studio", serverId: "remote-owner", remoteThreadId: "thr_actual" });
    await expect(sessions.adopt({ rootThreadId: "thr_root", threadId: "thr_mirror", kind: "parallel" })).rejects.toThrow(/Only a model/);
    f.threads.get("thr_mirror")!.visibility = "visible";
    const result = await sessions.adoptStarted({ rootThreadId: "thr_root", threadId: "thr_mirror", sourceThreadId: "thr_root" });
    expect(result.members.map((member) => member.id)).toEqual(["thr_root", "thr_mirror"]);
    expect(f.threads.get("thr_mirror")?.originPluginId).toBe("fleet");
    expect(f.threads.get("thr_mirror")?.visibility).toBe("hidden");
    expect(f.metadata.get("fleet:thr_mirror")).toEqual({ machine: "studio", serverId: "remote-owner", remoteThreadId: "thr_actual" });
  });

  it("rejects wrong-project, unrelated-parent or non-Fleet threads even on the internal path", async () => {
    const f = fixture();
    const sessions = createNativeSessions(f.bb);
    await sessions.state({ threadId: "thr_root" });
    for (const changes of [{ projectId: "proj_other" }, { parentThreadId: "thr_unrelated" }, { originPluginId: "another-plugin" }]) {
      Object.assign(f.threads.get("thr_mirror")!, { projectId: "proj_test", parentThreadId: null, originPluginId: "fleet", ...changes });
      await expect(sessions.adoptStarted({ rootThreadId: "thr_root", threadId: "thr_mirror" })).rejects.toThrow(/confirmed Fleet start/);
    }
    expect((await sessions.state({ threadId: "thr_root" })).members).toHaveLength(1);
    expect(f.mutations).toEqual([]);
  });
});

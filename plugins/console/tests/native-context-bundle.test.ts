import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createNativeWork, type NativeWorkDependencies } from "../server-native-work";
import type { NativeSessionState } from "../server-native-sessions";
import {
  ContextIntegrityError, assertBundleCommit, buildNarrative, contextManifestPath, deriveDecisions, sourceAttachmentIds, sourceEntries,
  type ContextBundleLink, type Narrative, type OwnerTarget, type PortableBundle, type ProjectVerify,
} from "../server-context-bundle";
import type { Event } from "../server-native-context";

const COMMIT = "5dc2c537ad2762caa162adb34aff7d1e9cecc081";
const OTHER = "1111111111111111111111111111111111111111";
const SOURCE = { serverId: "srv-laptop", threadId: "thr_root", machine: "laptop" };
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function events(): Event[] {
  return [
    { type: "client/turn/requested", threadId: "thr_root", seq: 2, data: { initiator: "user", requestId: "req_1", input: [{ type: "text", text: "Kick-off: plan the release." }] } },
    { type: "item/completed", threadId: "thr_root", seq: 4, data: { item: { type: "agentMessage", id: "a1", text: "Noted. Which options?" } } },
    { type: "client/turn/requested", threadId: "thr_root", seq: 6, data: { initiator: "user", requestId: "req_2", input: [
      { type: "text", text: "Please record these two decisions and reply.\n- DECISION_A_x9 ship on Friday\n- DECISION_B_x9 keep the text fallback\nShould we decide later?" },
      { type: "localFile", path: "attachments/notes.pdf", name: "notes.pdf" },
    ] } },
    { type: "item/completed", threadId: "thr_root", seq: 8, data: { item: { type: "agentMessage", id: "a2", text: "Agreed. DECISION_A_x9 ship on Friday" } } },
  ];
}

describe("structured context narrative", () => {
  it("derives decisions anchored to message IDs and sequences, including DECISION_<tag> markers", () => {
    const entries = sourceEntries(events(), "thr_root");
    expect(entries.map((entry) => [entry.id, entry.seq])).toEqual([["request:req_1", 2], ["item:a1", 4], ["request:req_2", 6], ["item:a2", 8]]);
    const decisions = deriveDecisions(entries, SOURCE);
    expect(decisions.map((decision) => decision.text)).toEqual(["DECISION_A_x9 ship on Friday", "DECISION_B_x9 keep the text fallback", "Agreed. DECISION_A_x9 ship on Friday"]);
    expect(decisions[0]!.sourceRefs).toEqual([{ serverId: "srv-laptop", threadId: "thr_root", messageId: "request:req_2", messageSeq: 6 }]);
    expect(decisions.every((decision) => decision.sourceRefs.every((ref) => ref.messageId && ref.messageSeq))).toBe(true);
    const phrased = deriveDecisions([{ id: "item:p", seq: 3, role: "assistant", text: "Decision: use Fleet.\nWe decided to keep Studio.\nNo decisions were made about Work.\nWhich decision?" }], SOURCE);
    expect(phrased.map((decision) => decision.text)).toEqual(["Decision: use Fleet.", "We decided to keep Studio."]);
  });

  it("rejects decisions without a source message reference, or citing an unknown message", () => {
    const entries = sourceEntries(events(), "thr_root");
    const base = { source: SOURCE, task: "Continue", entries, attachmentIds: [] };
    expect(() => buildNarrative({ ...base, decisions: [{ text: "DECISION_C no refs", sourceRefs: [] }] })).toThrow(ContextIntegrityError);
    expect(() => buildNarrative({ ...base, decisions: [{ text: "DECISION_C attachment only", sourceRefs: [{ serverId: "srv-laptop", threadId: "thr_root", attachmentId: "attachments/notes.pdf" }] }] })).toThrow(/no source message reference/);
    expect(() => buildNarrative({ ...base, decisions: [{ text: "DECISION_C stray", sourceRefs: [{ serverId: "srv-laptop", threadId: "thr_root", messageId: "item:missing" }] }] })).toThrow(/not in the source conversation/);
    expect(() => buildNarrative({ ...base, decisions: [{ text: "DECISION_C ok", sourceRefs: [{ serverId: "srv-laptop", threadId: "thr_root", messageSeq: 6 }] }] })).not.toThrow();
  });

  it("lists every message it leaves out and every source attachment as omitted, keeping caller order", () => {
    const all = events();
    const narrative = buildNarrative({ source: SOURCE, task: "Continue", entries: sourceEntries(all, "thr_root"), attachmentIds: sourceAttachmentIds(all, "thr_root"), maxMessages: 2 });
    expect(narrative.messages.map((message) => message.id)).toEqual(["request:req_2", "item:a2"]);
    expect(narrative.omitted).toEqual({ messageIds: ["request:req_1", "item:a1"], attachmentIds: ["attachments/notes.pdf"] });
    expect(narrative.decisions).toHaveLength(3);
    expect(narrative.brief.sourceRefs).toEqual([{ serverId: "srv-laptop", threadId: "thr_root", messageId: "request:req_2", messageSeq: 6 }]);
    // Messages past the 64 KiB narrative limit are omitted, never silently dropped.
    const big = sourceEntries(all, "thr_root").map((entry) => ({ ...entry, text: entry.text + "x".repeat(30_000) }));
    const bounded = buildNarrative({ source: SOURCE, task: "Continue", entries: big, attachmentIds: [] });
    expect(bounded.messages.length + bounded.omitted.messageIds.length).toBe(4);
    expect(bounded.omitted.messageIds.length).toBeGreaterThan(0);
  });
});

function narrativeOf(input: { brief: unknown; decisions: unknown; messages: unknown; omitted: unknown }) {
  return { brief: input.brief, decisions: input.decisions, messages: input.messages, omitted: input.omitted } as Narrative;
}
function verified(commit: string | null = COMMIT): ProjectVerify {
  return { owner: { serverId: "srv-laptop", machineKey: "laptop", hostId: "host_m5", projectId: "proj_test", environmentId: "env_m5" }, available: true, verified: true, repository: { rootPath: "/work/repo", remoteUrl: null, branch: "main", commit, dirty: false }, message: null, observedAt: 1 };
}
function bundleFor(input: Narrative & { selectedFiles: { path: string }[]; target: OwnerTarget }, commit = COMMIT): PortableBundle {
  const content = Buffer.from("# Readme\n");
  return {
    schema: "navaigate.portable-context", version: 1, createdAt: 1,
    narrative: { ...narrativeOf(input), provenance: "caller-supplied" },
    source: { owner: input.target, workspace: { verification: "verified", path: "/work/repo" }, repository: { verification: "verified", rootPath: "/work/repo", remoteUrl: null, branch: "main", commit, dirty: false, observedAt: 1 } },
    files: input.selectedFiles.map((file) => ({ path: file.path, name: file.path, mimeType: "text/markdown", sizeBytes: content.length, sha256: sha(content), contentBase64: content.toString("base64") })),
  } as PortableBundle;
}

describe("structured context commit verification", () => {
  it("refuses a bundle whose commit differs from project_verify", () => {
    const target = { serverId: "srv-laptop", machineKey: "laptop" as const, hostId: "host_m5", environmentId: "env_m5", projectId: "proj_test" };
    const bundle = bundleFor({ ...buildNarrative({ source: SOURCE, task: "t", entries: [], attachmentIds: [] }), selectedFiles: [], target }, OTHER);
    expect(() => assertBundleCommit(verified(COMMIT), bundle)).toThrow(/commit changed during export/);
    expect(assertBundleCommit(verified(OTHER), bundle)).toBe(OTHER);
  });
});

function state(): NativeSessionState {
  return { rootThreadId: "thr_root", title: "Conversation", projectId: "proj_test", activeThreadId: "thr_root", version: 1, pending: null, warning: null, members: [{ id: "thr_root", sourceThreadId: null, kind: "root", providerId: "codex", environmentId: null, model: "codex-test", reasoningLevel: "high", serviceTier: "default", title: "Conversation", status: "idle", createdAt: 1 }] };
}
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});
function fixture(options: { exportCommit?: string; exportError?: Error; importOutcome?: "applied" | "unknown" } = {}) {
  const threads = new Map([
    ["thr_root", makeThreadResponse({ id: "thr_root", projectId: "proj_test", visibility: "visible", providerId: "codex" })],
    ["thr_mirror", makeThreadResponse({ id: "thr_mirror", projectId: "proj_test", visibility: "hidden", providerId: "fleet-mirror", originPluginId: "fleet" })],
  ]);
  const host = createFakePluginHost({ pluginId: "navaigate-skin", sdk: {
    threads: {
      get: async ({ threadId }) => ({ ...threads.get(threadId)! }),
      update: async ({ threadId, ...changes }) => ({ ...threads.get(threadId)!, ...changes }),
    },
    projects: { get: async () => ({ id: "proj_test", name: "Native acceptance", kind: "standard" as const, sources: [], createdAt: 1, updatedAt: 1, gitRemoteUrl: null }) },
  } });
  hosts.push(host);
  const route = { machine: "studio", serverId: "srv-studio", hostId: "host_m1", mode: "manual" as const, reason: "Chosen", warnings: [], candidates: [] };
  const fleet: NativeWorkDependencies["fleet"] = {
    route: vi.fn(async () => route),
    start: vi.fn(async () => ({ outcome: "started" as const, threadId: "thr_m1", url: null, route })),
    board: vi.fn(async () => ({ available: true, board: { serverId: "srv-laptop", serverKey: "laptop" } })),
    mirrorOpen: vi.fn(async () => ({ localThreadId: "thr_mirror" })),
  };
  const sourceTarget: OwnerTarget = { serverId: "srv-laptop", machineKey: "laptop", hostId: "host_m5", environmentId: "env_m5", projectId: "proj_test", threadId: "thr_root" };
  const ownerTarget: OwnerTarget = { serverId: "srv-studio", machineKey: "studio", hostId: "host_m1", environmentId: "env_m1", projectId: "proj_m1", threadId: "thr_m1" };
  let exported: PortableBundle | null = null;
  const link: ContextBundleLink = {
    events: vi.fn(async () => ({ events: events(), complete: true })),
    sourceTarget: vi.fn(async () => sourceTarget),
    verify: vi.fn(async () => verified(COMMIT)),
    exportBundle: vi.fn(async (input) => {
      if (options.exportError) throw options.exportError;
      exported = bundleFor(input, options.exportCommit ?? COMMIT);
      return exported;
    }),
    ownerTarget: vi.fn(async () => ownerTarget),
    importBundle: vi.fn(async ({ requestId, bundle }) => ({
      owner: ownerTarget, requestId, method: "context_bundle_import", outcome: options.importOutcome ?? "applied", message: null,
      result: options.importOutcome === "unknown" ? null : { contextFormat: "portable-v1", manifestPath: contextManifestPath(requestId), manifestSha256: "a".repeat(64), runtimeFiles: bundle.files.map((file, index) => ({ name: file.name, path: `.bb/fleet-context/${requestId}/${index}-${file.name}`, sha256: file.sha256, sizeBytes: file.sizeBytes })) },
    })),
  };
  const transcript = vi.fn(async () => "USER: DECISION_A_x9 ship on Friday");
  const sessions: NativeWorkDependencies["sessions"] = { state: vi.fn(async () => state()), adoptStarted: vi.fn(async () => undefined) };
  const service = createNativeWork(host.bb, { sessions, fleet, transcript, contextBundle: link });
  return { service, fleet, link, transcript, ownerTarget, get exported() { return exported; } };
}
const request = (over: Record<string, unknown> = {}) => ({
  requestId: randomUUID(), machine: "studio" as const, prompt: "List the decisions from @thread:thr_root", sourceThreadId: "thr_root", rootThreadId: "thr_root",
  includeContext: true, providerId: "claude-code", model: "opus", reasoningLevel: "high", structuredContext: { selectedFiles: [{ path: "README.md" }], maxMessages: 2 }, ...over,
});

describe("routed work with structured context", () => {
  it("exports on the source, starts with a pointer only, then imports the bundle on the destination session", async () => {
    const f = fixture();
    const input = request();
    const receipt = await f.service.start(input);
    const prompt = vi.mocked(f.fleet.start).mock.calls[0]![0].prompt;
    expect(prompt).toContain(`.bb/fleet-context/${input.requestId}/context.json`);
    expect(prompt).toContain("[structured source context below]");
    expect(prompt).not.toContain("DECISION_A_x9");
    expect(prompt).not.toContain(COMMIT);
    expect(prompt).not.toContain("SOURCE CONVERSATION SNAPSHOT");
    expect(f.transcript).not.toHaveBeenCalled();
    expect(f.link.ownerTarget).toHaveBeenCalledWith({ machine: "studio", threadId: "thr_m1" });
    expect(f.link.importBundle).toHaveBeenCalledWith({ target: f.ownerTarget, requestId: input.requestId, bundle: f.exported });
    expect(receipt.context).toMatchObject({ format: "portable-v1", state: "delivered", commit: COMMIT, decisions: 3, messages: 2, omittedMessages: 2, omittedAttachments: 1, manifestSha256: "a".repeat(64) });
    expect(receipt.context!.files).toEqual([{ path: "README.md", sha256: sha("# Readme\n") }]);
    expect(f.exported!.narrative.omitted).toEqual({ messageIds: ["request:req_1", "item:a1"], attachmentIds: ["attachments/notes.pdf"] });
  });

  it("refuses to start when the exported commit does not match project_verify", async () => {
    const f = fixture({ exportCommit: OTHER });
    await expect(f.service.start(request())).rejects.toThrow(/commit changed during export/);
    expect(f.fleet.route).not.toHaveBeenCalled();
    expect(f.fleet.start).not.toHaveBeenCalled();
    expect(f.link.importBundle).not.toHaveBeenCalled();
  });

  it("falls back to the text snapshot when Fleet cannot export structured context", async () => {
    const f = fixture({ exportError: new Error("unknown RPC method context_bundle_export.") });
    const receipt = await f.service.start(request());
    const prompt = vi.mocked(f.fleet.start).mock.calls[0]![0].prompt;
    expect(prompt).toContain("SOURCE CONVERSATION SNAPSHOT");
    expect(prompt).not.toContain(".bb/fleet-context/");
    expect(receipt.context).toBeUndefined();
    expect(receipt.warning).toContain("Structured context is not available here");
    expect(f.link.importBundle).not.toHaveBeenCalled();
  });

  it("keeps an undelivered bundle for a retry through the receipt and never starts a second copy", async () => {
    const f = fixture({ importOutcome: "unknown" });
    const input = request();
    const first = await f.service.start(input);
    expect(first.context?.state).toBe("failed");
    expect(first.warning).toContain("structured context could not be delivered yet");
    vi.mocked(f.link.importBundle).mockImplementation(async ({ requestId, bundle }) => ({ owner: f.ownerTarget, requestId, method: "context_bundle_import", outcome: "applied", message: null, result: { contextFormat: "portable-v1", manifestPath: contextManifestPath(requestId), manifestSha256: "b".repeat(64), runtimeFiles: bundle.files.map((file) => ({ name: file.name, path: "x", sha256: file.sha256, sizeBytes: file.sizeBytes })) } }));
    const second = await f.service.receipt({ requestId: input.requestId });
    expect(second.context).toMatchObject({ state: "delivered", manifestSha256: "b".repeat(64) });
    expect(f.fleet.start).toHaveBeenCalledTimes(1);
  });

  it("requires a source conversation with context on", async () => {
    const f = fixture();
    await expect(f.service.start(request({ includeContext: false, prompt: "Plain task" }))).rejects.toThrow(/needs a source conversation/);
    expect(f.fleet.start).not.toHaveBeenCalled();
  });
});

describe("exporting and importing a saved context bundle", () => {
  it("exports a bundle from a conversation with a summary of what it holds and a file name", async () => {
    const f = fixture();
    const out = await f.service.exportContext({ sourceThreadId: "thr_root", structuredContext: { selectedFiles: [{ path: "README.md" }], maxMessages: 2 } });
    expect(out.filename).toMatch(/^context-bundle-thr_root-\d{4}-\d\d-\d\d-\d\d-\d\d\.json$/);
    expect(out.summary).toMatchObject({ format: "portable-v1", sourceMachine: "laptop", sourceThreadId: "thr_root", commit: COMMIT, repository: "verified", decisions: 3, messages: 2, omittedMessages: 2, omittedAttachments: 1 });
    expect(out.summary.decisionTexts).toContain("DECISION_A_x9 ship on Friday");
    expect(out.summary.files).toEqual([{ path: "README.md", sha256: sha("# Readme\n"), sizeBytes: 9 }]);
    expect(out.bundle).toBe(f.exported);
    expect(f.fleet.start).not.toHaveBeenCalled();
    expect(f.link.importBundle).not.toHaveBeenCalled();
  });

  it("says plainly when the exported commit does not match the verified one", async () => {
    const f = fixture({ exportCommit: OTHER });
    await expect(f.service.exportContext({ sourceThreadId: "thr_root" })).rejects.toThrow(/commit changed during export/);
  });

  it("describes a saved bundle without sending it, and refuses one whose file bytes were altered", async () => {
    const f = fixture();
    const { bundle, summary } = await f.service.exportContext({ sourceThreadId: "thr_root", structuredContext: { selectedFiles: [{ path: "README.md" }] } });
    expect(await f.service.inspectContext({ bundle })).toEqual(summary);
    const altered = { ...bundle, files: [{ ...bundle.files[0]!, contentBase64: Buffer.from("tampered").toString("base64") }] };
    await expect(f.service.inspectContext({ bundle: altered })).rejects.toThrow(/failed byte verification/);
    expect(f.fleet.start).not.toHaveBeenCalled();
  });

  it("starts work with a saved bundle and no source conversation, delivering that bundle to the new session", async () => {
    const f = fixture();
    const { bundle } = await f.service.exportContext({ sourceThreadId: "thr_root", structuredContext: { selectedFiles: [{ path: "README.md" }], maxMessages: 2 } });
    vi.mocked(f.link.events).mockClear();
    const input = { requestId: randomUUID(), machine: "studio" as const, prompt: "Continue from the saved context", includeContext: false, providerId: "claude-code", model: "opus", reasoningLevel: "high", contextBundle: bundle };
    const receipt = await f.service.start(input);
    const prompt = vi.mocked(f.fleet.start).mock.calls[0]![0].prompt;
    expect(prompt).toContain(`.bb/fleet-context/${input.requestId}/context.json`);
    expect(prompt).toContain("Source session: thr_root on laptop");
    expect(prompt).not.toContain("DECISION_A_x9");
    expect(f.link.events).not.toHaveBeenCalled();
    expect(f.link.importBundle).toHaveBeenCalledWith({ target: f.ownerTarget, requestId: input.requestId, bundle });
    expect(receipt.context).toMatchObject({ state: "delivered", commit: COMMIT, decisions: 3, messages: 2, omittedMessages: 2, omittedAttachments: 1, commitClaimed: true });
    expect(receipt.warning).toContain("as stated by the bundle");
  });

  it("does not call a commit Fleet verified itself a claim", async () => {
    const f = fixture();
    const receipt = await f.service.start(request());
    expect(receipt.context!.commitClaimed).toBeUndefined();
  });

  it("refuses a saved bundle with altered file bytes before choosing a Mac", async () => {
    const f = fixture();
    const { bundle } = await f.service.exportContext({ sourceThreadId: "thr_root", structuredContext: { selectedFiles: [{ path: "README.md" }] } });
    const altered = { ...bundle, files: [{ ...bundle.files[0]!, contentBase64: Buffer.from("tampered").toString("base64") }] };
    await expect(f.service.start({ requestId: randomUUID(), machine: "studio", prompt: "Go", includeContext: false, providerId: "claude-code", model: "opus", reasoningLevel: "high", contextBundle: altered })).rejects.toThrow(/failed byte verification/);
    expect(f.fleet.route).not.toHaveBeenCalled();
  });

  it("refuses a request that sends both this conversation's context and a saved bundle", async () => {
    const f = fixture();
    const { bundle } = await f.service.exportContext({ sourceThreadId: "thr_root" });
    await expect(f.service.start(request({ contextBundle: bundle }))).rejects.toThrow(/not both/);
    expect(f.fleet.start).not.toHaveBeenCalled();
  });
});

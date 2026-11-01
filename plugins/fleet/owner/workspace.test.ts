import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerWorkspacePanel, OwnerMediaPreview, ownerFilePreviewUrl, ownerFileForDisplay, ownerPendingReceiptId, ownerReadPreservingDraft } from "../components/owner-workspace";
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call: vi.fn() }), experimental_FileLink: () => null }));
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createOwnerWorkspace, ownerInteractionFingerprint } from "./workspace";
import { MAX_OWNER_FILE_BYTES, ownerWorkspaceContract, ownerPathSchema, type OwnerWorkspaceTarget } from "./workspace-contract";

type Interaction = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["interactions"]["get"]>>;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const target: OwnerWorkspaceTarget = { serverId: "owner-laptop", machineKey: "laptop", hostId: "host_laptop", environmentId: "env_fixture", projectId: "proj_fixture", threadId: "thr_fixture" };
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); vi.unstubAllGlobals(); });
function question(overrides: Partial<Interaction> = {}): Interaction {
  return { id: "int_question", threadId: target.threadId!, turnId: "turn_fixture", createdAt: 1234, status: "pending", payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Which fixture?", shortLabel: "Fixture", multiSelect: false, allowFreeText: true, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] }] }, ...overrides } as Interaction;
}
async function fixture(owner: OwnerWorkspaceTarget = target, loopbackBaseUrl = "http://127.0.0.1:22599") {
  const target = owner;
  const root = await mkdtemp(path.join(tmpdir(), "fleet-owner-workspace-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "hello.txt"), "original fixture\n");
  const uploads = new Map<string, Uint8Array>();
  let interaction = question();
  let loseWriteReply = false;
  let loseQuestionReply = false;
  let rejectHostCopy = false;
  let wrongUploadBytes = false;
  let nextUpload = 0;
  let previewLease: { baseUrl: string; expiresAtMs: number } | null = null;
  const fileWrites: unknown[] = [];
  const resolutions: unknown[] = [];
  const uploadCalls: unknown[] = [];
  const calls = { files: 0, directories: 0 };
  const inside = (base: string, full: string) => full === base || full.startsWith(base + path.sep);
  async function realFile(rootPath: string, full: string, writing = false) {
    const resolvedRoot = await realpath(rootPath);
    let resolved: string;
    try { resolved = await realpath(full); }
    catch (cause) {
      if (!writing || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      let parent = path.dirname(full);
      while (true) {
        try { resolved = path.resolve(await realpath(parent), path.relative(parent, full)); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const next = path.dirname(parent); if (next === parent) throw error; parent = next; }
      }
    }
    if (!inside(resolvedRoot, resolved!)) throw new Error("Host root containment: symlink escapes root");
    return resolved!;
  }
  const host = createFakePluginHost({
    pluginId: `fleet-owner-${randomUUID()}`,
    loopbackBaseUrl,
    sdk: {
      environments: { get: async () => ({ id: target.environmentId, hostId: target.hostId, projectId: target.projectId, status: "ready", path: workspace }) as never },
      projects: {
        get: async () => ({ id: target.projectId }) as never,
        attachments: {
          upload: async (args) => { if (!(args.clientFile instanceof Uint8Array)) throw new Error("Fixture expects real byte input"); uploadCalls.push(args); const hostedPath = `.bb/attachments/${++nextUpload}/${args.filename}`; uploads.set(hostedPath, new Uint8Array(args.clientFile)); return { path: hostedPath, name: args.filename, type: args.mimeType, size: args.clientFile.length } as never; },
          read: async ({ path: hostedPath }) => { const bytes = uploads.get(hostedPath)!; return { bytes: wrongUploadBytes ? new Uint8Array([9]) : bytes, mimeType: "application/octet-stream", sizeBytes: bytes.length }; },
        },
      },
      hosts: {
        directory: async ({ path: full }) => { calls.directories++; const directory = await realpath(full!); const entries = await readdir(directory, { withFileTypes: true }); return { directory, entries: entries.map((entry) => ({ name: entry.name, path: path.join(directory, entry.name), kind: entry.isDirectory() ? "directory" : "file" })), parent: path.dirname(directory), roots: [] } as never; },
        pathsExist: async ({ paths }) => ({ existence: Object.fromEntries(await Promise.all(paths.map(async (full) => { try { await stat(full); return [full, true]; } catch { return [full, false]; } }))) }),
      },
      files: {
        read: async ({ path: full, rootPath }) => { calls.files++; const file = await realFile(rootPath!, full); const info = await stat(file); if (!info.isFile()) throw new Error("Not a regular file"); const bytes = await readFile(file); return { content: bytes.toString("base64"), contentEncoding: "base64", sizeBytes: bytes.length, sha256: hash(bytes), mimeType: "application/octet-stream" }; },
        write: async (args) => {
          fileWrites.push(args);
          const full = await realFile(args.rootPath!, args.path, true);
          if (rejectHostCopy) throw new Error("Synthetic host interrupted");
          let before: Buffer | null = null;
          try { before = await readFile(full); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
          if (args.expectedSha256 === null ? before !== null : before === null || hash(before) !== args.expectedSha256) throw new Error("SHA256 compare-and-swap conflict");
          if (args.createParents) await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, Buffer.from(args.content, args.contentEncoding === "base64" ? "base64" : "utf8"));
          if (loseWriteReply) throw new Error("Synthetic reply lost after file write");
          return { ok: true } as never;
        },
        createPreview: async () => previewLease ?? ({ baseUrl: "/api/v1/file-previews/synthetic-token", expiresAtMs: Date.now() + 300_000 }),
      },
      threads: {
        get: async () => makeThreadResponse({ id: target.threadId, projectId: target.projectId, environmentId: target.environmentId, providerId: "codex", deletedAt: null }),
        interactions: {
          list: async () => [interaction], get: async () => interaction,
          resolve: async (args) => { resolutions.push(args); interaction = { ...interaction, status: "resolved" }; if (loseQuestionReply) throw new Error("Synthetic reply lost after resolving"); return interaction; },
          respond: async (args) => { resolutions.push(args); interaction = { ...interaction, status: "resolved" }; return interaction; },
        },
      },
    },
  });
  disposals.push(async () => { await host.harness.lifecycle.dispose(); await rm(root, { recursive: true, force: true }); });
  const callOwner = vi.fn<import("./workspace").OwnerWorkspaceOptions["callOwner"]>(async () => ({ ok: false as const, kind: "unavailable" as const, message: "no-authenticated-owner-route" }));
  const options = { identity: async () => ({ serverId: target.serverId, machineKey: target.machineKey }), callOwner, restricted: (machineKey: string) => machineKey === "work" };
  const service = createOwnerWorkspace(host.bb, options);
  const inputWrite = (value = "new bytes\n") => ({ target, requestId: randomUUID(), path: "hello.txt", contentBase64: Buffer.from(value).toString("base64"), sha256: hash(value), expectedSha256: hash("original fixture\n") });
  const inputBundle = () => ({ target, requestId: randomUUID(), files: [{ name: "fixture.bin", mimeType: "application/octet-stream", contentBase64: Buffer.from([0, 255, 13, 10, 128]).toString("base64"), sha256: hash(new Uint8Array([0, 255, 13, 10, 128])) }], context: { text: "Exact fixture context", source: { serverId: "source-laptop", threadId: "thr_source", messageSeq: 8 } } });
  return { ...host, service, options, callOwner, root, workspace, realFile, uploads, fileWrites, resolutions, uploadCalls, calls, inputWrite, inputBundle, setPreviewLease(value: { baseUrl: string; expiresAtMs: number }) { previewLease = value; }, setInteraction(value: Interaction) { interaction = value; }, setLoseWriteReply() { loseWriteReply = true; }, setLoseQuestionReply() { loseQuestionReply = true; }, setRejectHostCopy() { rejectHostCopy = true; }, setWrongUploadBytes() { wrongUploadBytes = true; } };
}
const asJson = (receipt: { result: unknown }) => receipt.result as Record<string, any>;

describe("finite owner workspace routing", () => {
  it("routes exact studio identity through the injected owner callback without touching local files", async () => {
    const f = await fixture();
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const, hostId: "host_studio" };
    f.callOwner.mockImplementation(async () => ({ ok: true, result: { owner: remote, rootPath: "/fixture/remote", path: ".", entries: [], nextAfter: null } }) as never);
    const result = await f.service.handlers.owner_file_list({ target: remote, path: ".", limit: 100 });
    expect(result).toMatchObject({ owner: remote });
    expect(f.callOwner).toHaveBeenCalledWith({ serverId: "owner-studio", machineKey: "studio" }, "owner_file_list", { target: remote, path: ".", limit: 100 }, false);
    expect(f.calls).toEqual({ files: 0, directories: 0 });
  });
  it("refuses wrong same-server machine and never invokes a callback for unauthenticated work", async () => {
    const f = await fixture();
    await expect(f.service.handlers.owner_file_list({ target: { ...target, machineKey: "studio" }, path: ".", limit: 100 })).rejects.toThrow("machine");
    await expect(f.service.handlers.owner_file_list({ target: { ...target, serverId: "work", machineKey: "work" }, path: ".", limit: 100 })).rejects.toThrow("no-authenticated-owner-route");
    expect(f.callOwner).not.toHaveBeenCalled();
  });
  it("rejects a remote response belonging to another host and marks a mutation reply unknown", async () => {
    const f = await fixture();
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const };
    f.callOwner.mockImplementation(async () => ({ ok: true, result: { owner: { ...remote, hostId: "host_wrong" }, rootPath: "/fixture", path: ".", entries: [], nextAfter: null } }) as never);
    await expect(f.service.handlers.owner_file_list({ target: remote, path: ".", limit: 100 })).rejects.toThrow("owner identity");
    const input = { ...f.inputWrite(), target: remote };
    f.callOwner.mockImplementation(async () => { throw new Error("Connection lost"); });
    const receipt = await f.service.handlers.owner_file_write(input);
    expect(receipt).toMatchObject({ outcome: "unknown", requestId: input.requestId, owner: remote });
    expect(f.fileWrites).toHaveLength(0);
  });
});

describe("owner scoped files and atomic writes", () => {
  it.each(["../outside", "/etc/passwd", "a/../../outside", "a\\b", "C:/outside", "a//b", "a/./b", "bad\0name"])("rejects unsafe path %j", (value) => { expect(ownerPathSchema.safeParse(value).success).toBe(false); });
  it("binds native environment, host, project and thread before any file access", async () => {
    const f = await fixture();
    for (const change of [{ hostId: "host_other" }, { projectId: "proj_other" }, { environmentId: "env_other" }, { threadId: "thr_other" }]) {
      await expect(f.service.handlers.owner_file_read({ target: { ...target, ...change }, path: "hello.txt", offset: 0, length: 20, preview: false })).rejects.toThrow(/environment|Thread/);
    }
    expect(f.calls.files).toBe(0);
  });
  it("reads binary bytes in pinned chunks, lists real directories and returns an actual preview lease", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(300_000, 255);
    await writeFile(path.join(f.workspace, "binary.bin"), bytes);
    const listing = await f.service.handlers.owner_file_list({ target, path: ".", limit: 1 });
    expect(listing).toMatchObject({ entries: [{ name: "binary.bin", path: "binary.bin", kind: "file" }], nextAfter: "binary.bin" });
    const first = await f.service.handlers.owner_file_read({ target, path: "binary.bin", offset: 0, length: 256 * 1024, preview: true });
    const second = await f.service.handlers.owner_file_read({ target, path: "binary.bin", offset: (first as any).nextOffset, length: 256 * 1024, expectedSha256: hash(bytes), preview: false });
    expect(Buffer.concat([Buffer.from((first as any).contentBase64, "base64"), Buffer.from((second as any).contentBase64, "base64")])).toEqual(bytes);
    expect(first).toMatchObject({ sha256: hash(bytes), preview: { baseUrl: "/api/v1/file-previews/synthetic-token" } });
    await writeFile(path.join(f.workspace, "binary.bin"), "changed");
    await expect(f.service.handlers.owner_file_read({ target, path: "binary.bin", offset: 0, length: 50, expectedSha256: hash(bytes), preview: false })).rejects.toThrow("changed");
  });
  it("allows contained symlinks while refusing escaped file, directory and write targets", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "private.txt"), "outside fixture");
    await symlink(path.join(f.root, "private.txt"), path.join(f.workspace, "outside.txt"));
    await symlink(f.root, path.join(f.workspace, "outside-dir"));
    await symlink(path.join(f.workspace, "hello.txt"), path.join(f.workspace, "inside.txt"));
    await expect(f.service.handlers.owner_file_read({ target, path: "outside.txt", offset: 0, length: 50, preview: false })).rejects.toThrow("symlink");
    await expect(f.service.handlers.owner_file_list({ target, path: "outside-dir", limit: 100 })).rejects.toThrow("symlink");
    const inside = await f.service.handlers.owner_file_stat({ target, path: "inside.txt", preview: false });
    expect(inside).toMatchObject({ kind: "file", sha256: hash("original fixture\n") });
    const write = await f.service.handlers.owner_file_write({ ...f.inputWrite(), path: "outside.txt", expectedSha256: hash("outside fixture") });
    expect(write).toMatchObject({ outcome: "refused" });
    expect(f.fileWrites).toHaveLength(0);
    expect(await readFile(path.join(f.root, "private.txt"), "utf8")).toBe("outside fixture");
  });
  it("uses real CAS, rejects stale edits before dispatch and deduplicates same request after factory reload", async () => {
    const f = await fixture();
    const stale = await f.service.handlers.owner_file_write({ ...f.inputWrite(), expectedSha256: hash("stale") });
    expect(stale).toMatchObject({ outcome: "refused" });
    const input = f.inputWrite();
    const first = await f.service.handlers.owner_file_write(input);
    expect(first).toMatchObject({ outcome: "applied", result: { sha256: input.sha256, hostId: target.hostId } });
    const reloaded = createOwnerWorkspace(f.bb, f.options);
    expect(await reloaded.handlers.owner_file_write(input)).toEqual(first);
    expect(await reloaded.handlers.owner_workspace_receipt({ target, requestId: input.requestId })).toEqual(first);
    expect(f.fileWrites).toHaveLength(1);
    expect(await readFile(path.join(f.workspace, "hello.txt"), "utf8")).toBe("new bytes\n");
    await expect(reloaded.handlers.owner_file_write({ ...input, path: "different.txt" })).rejects.toThrow("different owner operation");
  });
  it("retains unknown after a lost write reply, never retries, and guards receipt owner identity", async () => {
    const f = await fixture(); f.setLoseWriteReply();
    const input = f.inputWrite();
    const receipt = await f.service.handlers.owner_file_write(input);
    expect(receipt).toMatchObject({ outcome: "unknown" });
    expect(await f.service.handlers.owner_file_write(input)).toEqual(receipt);
    expect(f.fileWrites).toHaveLength(1);
    expect(await readFile(path.join(f.workspace, "hello.txt"), "utf8")).toBe("new bytes\n");
    await expect(f.service.handlers.owner_workspace_receipt({ target: { ...target, environmentId: "env_other" }, requestId: input.requestId })).rejects.toThrow("does not belong");
  });
  it("creates only absent files and verifies caller supplied bytes before writing", async () => {
    const f = await fixture();
    expect(await f.service.handlers.owner_file_write({ ...f.inputWrite(), expectedSha256: null })).toMatchObject({ outcome: "refused" });
    expect(await f.service.handlers.owner_file_write({ ...f.inputWrite(), sha256: hash("wrong") })).toMatchObject({ outcome: "refused" });
    expect(f.fileWrites).toHaveLength(0);
    expect(await f.service.handlers.owner_file_write({ ...f.inputWrite(), path: "created.txt", expectedSha256: null })).toMatchObject({ outcome: "applied" });
  });
});

describe("destination attachment and context import", () => {
  it("uploads verified binary project bytes and separately copies actual bytes to the exact host environment", async () => {
    const f = await fixture(); const input = f.inputBundle();
    const receipt = await f.service.handlers.context_bundle_import(input);
    expect(receipt).toMatchObject({ outcome: "applied" });
    const result = asJson(receipt);
    expect(f.uploadCalls).toMatchObject([{ projectId: target.projectId, filename: "fixture.bin", clientFile: Buffer.from([0, 255, 13, 10, 128]) }]);
    expect(result.attachments[0]).toMatchObject({ sourceProjectId: target.projectId, sha256: input.files[0]!.sha256 });
    expect(result.runtimeFiles[0]).toMatchObject({ hostId: target.hostId, environmentId: target.environmentId, sha256: input.files[0]!.sha256 });
    expect(result.attachments[0].path).not.toBe(result.runtimeFiles[0].path);
    expect(await readFile(path.join(f.workspace, result.runtimeFiles[0].path))).toEqual(Buffer.from([0, 255, 13, 10, 128]));
    const manifest = JSON.parse(await readFile(path.join(f.workspace, result.manifestPath), "utf8"));
    expect(manifest).toMatchObject({ owner: target, context: input.context });
    expect(await f.service.handlers.context_bundle_import(input)).toEqual(receipt);
    expect(f.uploadCalls).toHaveLength(1); expect(f.fileWrites).toHaveLength(2);
  });
  it("refuses bad hash before uploads and treats failed verification after upload as unknown", async () => {
    const f = await fixture(); const input = f.inputBundle();
    const refused = await f.service.handlers.context_bundle_import({ ...input, files: [{ ...input.files[0]!, sha256: hash("wrong") }] });
    expect(refused).toMatchObject({ outcome: "refused" }); expect(f.uploadCalls).toHaveLength(0);
    f.setWrongUploadBytes();
    const failed = await f.service.handlers.context_bundle_import({ ...input, requestId: randomUUID() });
    expect(failed).toMatchObject({ outcome: "unknown" }); expect(f.fileWrites).toHaveLength(0);
  });
  it("retains partial hosted-attachment evidence when host copy is interrupted and refuses resubmission", async () => {
    const f = await fixture(); f.setRejectHostCopy(); const input = f.inputBundle();
    const receipt = await f.service.handlers.context_bundle_import(input);
    expect(receipt).toMatchObject({ outcome: "unknown", result: { attachments: [{ sourceProjectId: target.projectId }], runtimeFiles: [] } });
    expect(await createOwnerWorkspace(f.bb, f.options).handlers.context_bundle_import(input)).toEqual(receipt);
    expect(f.uploadCalls).toHaveLength(1);
  });
});

describe("native interaction stale guards and durable response receipts", () => {
  it("lists actual pending questions then answers through the native interaction resolver exactly once", async () => {
    const f = await fixture();
    const result = await f.service.handlers.interaction_list({ target });
    const item = (result as { interactions: { fingerprint: string }[] }).interactions[0]!;
    expect(item).toMatchObject({ id: "int_question", kind: "user_question", fingerprint: ownerInteractionFingerprint(question()) });
    const input = { target, requestId: randomUUID(), interactionId: "int_question", expectedFingerprint: item.fingerprint, response: { kind: "user_answer" as const, answers: { q1: { selected: ["b"], freeText: "Fixture only" } } } };
    const receipt = await f.service.handlers.interaction_respond(input);
    expect(receipt).toMatchObject({ outcome: "applied" });
    expect(f.resolutions).toMatchObject([{ threadId: target.threadId, interactionId: "int_question", resolution: { kind: "user_answer", answers: input.response.answers } }]);
    expect(await createOwnerWorkspace(f.bb, f.options).handlers.interaction_respond(input)).toEqual(receipt);
    expect(f.resolutions).toHaveLength(1);
    expect(await f.service.handlers.interaction_list({ target })).toMatchObject({ interactions: [] });
  });
  it("refuses changed, expired and invalid option answers before resolving anything", async () => {
    const f = await fixture();
    const input = { target, requestId: randomUUID(), interactionId: "int_question", expectedFingerprint: ownerInteractionFingerprint(question()), response: { kind: "user_answer" as const, answers: { q1: { selected: ["not-an-option"] } } } };
    expect(await f.service.handlers.interaction_respond(input)).toMatchObject({ outcome: "refused" });
    f.setInteraction(question({ createdAt: 5678 }));
    expect(await f.service.handlers.interaction_respond({ ...input, requestId: randomUUID() })).toMatchObject({ outcome: "refused" });
    f.setInteraction(question({ expiresAt: Date.now() - 1 }));
    expect(await f.service.handlers.interaction_respond({ ...input, requestId: randomUUID() })).toMatchObject({ outcome: "refused" });
    expect(await f.service.handlers.interaction_list({ target })).toMatchObject({ interactions: [] });
    expect(f.resolutions).toHaveLength(0);
  });
  it("does not repeat a native answer after a lost resolve reply", async () => {
    const f = await fixture(); f.setLoseQuestionReply();
    const input = { target, requestId: randomUUID(), interactionId: "int_question", expectedFingerprint: ownerInteractionFingerprint(question()), response: { kind: "user_answer" as const, answers: { q1: { selected: ["a"] } } } };
    const receipt = await f.service.handlers.interaction_respond(input);
    expect(receipt).toMatchObject({ outcome: "unknown" });
    expect(await f.service.handlers.interaction_respond(input)).toEqual(receipt);
    expect(f.resolutions).toHaveLength(1);
  });
  it("bounds question previews and rejects unscoped or non-finite contract inputs", async () => {
    const f = await fixture();
    f.setInteraction(question({ payload: { kind: "user_question", questions: [{ id: "q", prompt: "x".repeat(65_000), multiSelect: false, allowFreeText: true }] } }));
    expect(await f.service.handlers.interaction_list({ target })).toMatchObject({ interactions: [], truncated: true });
    expect(ownerWorkspaceContract.interaction_list.input.safeParse({ target: { ...target, threadId: undefined } }).success).toBe(false);
    expect(ownerWorkspaceContract.owner_file_read.input.safeParse({ target, path: "hello.txt", method: "exec" }).success).toBe(false);
  });
});


describe("synthetic laptop to studio owner operation", () => {
  it("routes project upload and actual host copies to the destination factory without changing source files", async () => {
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const, hostId: "host_studio", environmentId: "env_studio" };
    const source = await fixture();
    const destination = await fixture(remote);
    source.callOwner.mockImplementation(async (identity, method, input, mutation) => {
      expect(identity).toEqual({ serverId: remote.serverId, machineKey: "studio" });
      expect(mutation).toBe(true);
      const handle = destination.service.handlers[method] as (input: unknown) => Promise<unknown>;
      return { ok: true, result: await handle(input) };
    });
    const receipt = await source.service.handlers.context_bundle_import({ ...source.inputBundle(), target: remote });
    expect(receipt).toMatchObject({ outcome: "applied", owner: remote });
    const result = asJson(receipt);
    expect(await readFile(path.join(destination.workspace, result.runtimeFiles[0].path))).toEqual(Buffer.from([0, 255, 13, 10, 128]));
    expect(source.uploadCalls).toHaveLength(0);
    expect(source.fileWrites).toHaveLength(0);
    expect(destination.uploadCalls).toHaveLength(1);
    expect(destination.fileWrites).toHaveLength(2);
  });
});

describe("native owner workspace presentation", () => {
  it("renders the exact supplied owner thread for native terminal access and refuses foreign origin links", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const };
    const props = { target: remote, localServerId: "owner-laptop", localMachineKey: "laptop", ownerUrl: "https://studio.example.test", ownerThreadUrl: "https://studio.example.test/projects/proj_fixture/threads/thr_fixture" };
    const html = renderToStaticMarkup(createElement(OwnerWorkspacePanel, props));
    expect(html).toContain("studio owner workspace");
    expect(html).toContain('href="https://studio.example.test/projects/proj_fixture/threads/thr_fixture"');
    expect(html).toContain("native files and terminal");
    expect(html).toContain("Refresh native questions");
    expect(renderToStaticMarkup(createElement(OwnerWorkspacePanel, { ...props, ownerThreadUrl: "https://foreign.invalid/thread" }))).not.toContain("foreign.invalid");
  });
  it("forms a real expiring owner-hosted preview URL and rejects expired, traversal and unsafe URLs", () => {
    const preview = { baseUrl: "/api/v1/file-previews/synthetic-token", expiresAtMs: Date.now() + 100_000 };
    expect(ownerFilePreviewUrl("https://studio.example.test", { path: "folder/a #.txt", preview })).toBe("https://studio.example.test/api/v1/file-previews/synthetic-token/folder/a%20%23.txt");
    expect(ownerFilePreviewUrl("javascript:alert(1)", { path: "safe.txt", preview })).toBeNull();
    expect(ownerFilePreviewUrl("https://studio.example.test", { path: "../outside", preview })).toBeNull();
    expect(ownerFilePreviewUrl("https://studio.example.test", { path: "safe.txt", preview: { ...preview, expiresAtMs: 1 } })).toBeNull();
    expect(ownerFilePreviewUrl("https://studio.example.test", { path: "safe.txt", preview: { ...preview, baseUrl: "https://foreign.invalid/api/v1/file-previews/token" } })).toBeNull();
    expect(ownerFilePreviewUrl("https://studio.example.test", { path: "safe.txt", preview: { ...preview, baseUrl: "/api/v1/file-previews/../other" } })).toBeNull();
  });
});


describe("bounded empty files and native approval/plugin resolution", () => {
  it("retains a zero-byte attachment and a context-only manifest", async () => {
    const f = await fixture();
    const empty = await f.service.handlers.context_bundle_import({ target, requestId: randomUUID(), files: [{ name: "empty.txt", mimeType: "text/plain", contentBase64: "", sha256: hash("") }], context: null });
    expect(empty).toMatchObject({ outcome: "applied", result: { attachments: [{ size: 0, verified: true }], runtimeFiles: [{ sizeBytes: 0, sha256: hash("") }] } });
    const context = await f.service.handlers.context_bundle_import({ target, requestId: randomUUID(), files: [], context: { text: "literal context", source: { serverId: "source", threadId: "thr_source" } } });
    expect(context).toMatchObject({ outcome: "applied", result: { contextSourceVerification: "caller-supplied", attachments: [], runtimeFiles: [] } });
  });
  it("passes an explicit available native approval and plugin JSON response through their actual SDK methods", async () => {
    const f = await fixture();
    const approval = question({ payload: { kind: "approval", availableDecisions: ["deny", "allow_once"], reason: "Synthetic test only", subject: { kind: "command", itemId: "tool_fixture", command: "echo fixture", cwd: "/fixture", actions: [], sessionGrant: null } } });
    f.setInteraction(approval);
    expect(await f.service.handlers.interaction_respond({ target, requestId: randomUUID(), interactionId: approval.id, expectedFingerprint: ownerInteractionFingerprint(approval), response: { kind: "approval", decision: "allow_for_session" } })).toMatchObject({ outcome: "refused" });
    expect(await f.service.handlers.interaction_respond({ target, requestId: randomUUID(), interactionId: approval.id, expectedFingerprint: ownerInteractionFingerprint(approval), response: { kind: "approval", decision: "allow_once" } })).toMatchObject({ outcome: "applied" });
    expect(f.resolutions[0]).toMatchObject({ resolution: { decision: "allow_once", grantedPermissions: null } });
    const plugin = question({ origin: { kind: "plugin", pluginId: "fixture", rendererId: "question" }, payload: { kind: "plugin", title: "Synthetic plugin question", data: { synthetic: true } } });
    f.setInteraction(plugin);
    expect(await f.service.handlers.interaction_respond({ target, requestId: randomUUID(), interactionId: plugin.id, expectedFingerprint: ownerInteractionFingerprint(plugin), response: { kind: "plugin", value: { answer: "fixture" } } })).toMatchObject({ outcome: "applied" });
    expect(f.resolutions[1]).toMatchObject({ value: { answer: "fixture" } });
  });
});


describe("bundle byte bounds", () => {
  it("accepts the exact 8 MiB base64 boundary and rejects aggregate excess before any owner side effect", () => {
    const bytes = Buffer.alloc(MAX_OWNER_FILE_BYTES);
    const file = { name: "bounded.bin", mimeType: "application/octet-stream", contentBase64: bytes.toString("base64"), sha256: hash(bytes) };
    const input = { target, requestId: randomUUID(), files: [file], context: null };
    expect(ownerWorkspaceContract.context_bundle_import.input.safeParse(input).success).toBe(true);
    expect(ownerWorkspaceContract.context_bundle_import.input.safeParse({ ...input, files: [file, file] }).success).toBe(false);
    expect(ownerWorkspaceContract.owner_file_write.input.safeParse({ target, requestId: randomUUID(), path: "invalid.txt", contentBase64: "====", sha256: hash(""), expectedSha256: null }).success).toBe(false);
  });
});


describe("unresolved owner receipt recovery", () => {
  it("retains the original UUID after a lost mutation reply and offline receipt check, then clears only on exact owner recovery", async () => {
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const, hostId: "host_studio", environmentId: "env_studio" };
    const source = await fixture();
    const destination = await fixture(remote);
    const input = { ...source.inputWrite(), target: remote };
    source.callOwner.mockImplementation(async (_owner, _method, raw) => {
      await destination.service.handlers.owner_file_write(raw as typeof input);
      return { ok: false, kind: "unknown", message: "Synthetic mutation reply lost" };
    });
    const lost = await source.service.handlers.owner_file_write(input);
    expect(ownerPendingReceiptId(input.requestId, remote, lost, "submission")).toBe(input.requestId);
    source.callOwner.mockResolvedValue({ ok: false, kind: "unavailable", message: "Synthetic route offline during receipt read" });
    const offline = await source.service.handlers.owner_workspace_receipt({ target: remote, requestId: input.requestId });
    expect(offline).toMatchObject({ outcome: "unavailable", method: "owner_workspace_receipt" });
    expect(ownerPendingReceiptId(input.requestId, remote, offline, "reconciliation")).toBe(input.requestId);
    source.callOwner.mockImplementation(async (_owner, _method, raw) => ({ ok: true, result: await destination.service.handlers.owner_workspace_receipt(raw as { target: OwnerWorkspaceTarget; requestId: string }) }));
    const recovered = await source.service.handlers.owner_workspace_receipt({ target: remote, requestId: input.requestId });
    expect(recovered).toMatchObject({ outcome: "applied", method: "owner_file_write", requestId: input.requestId });
    expect(ownerPendingReceiptId(input.requestId, remote, recovered, "reconciliation")).toBeNull();
    expect(destination.fileWrites).toHaveLength(1);
    expect(source.fileWrites).toHaveLength(0);
  });
  it("distinguishes a known not-delivered submission from an unavailable/refused receipt lookup and mismatched receipt", async () => {
    const f = await fixture();
    const input = f.inputWrite();
    const applied = await f.service.handlers.owner_file_write(input);
    expect(ownerPendingReceiptId(input.requestId, target, { ...applied, outcome: "unavailable" }, "submission")).toBeNull();
    expect(ownerPendingReceiptId(input.requestId, target, { ...applied, outcome: "unavailable" }, "reconciliation")).toBe(input.requestId);
    expect(ownerPendingReceiptId(input.requestId, target, { ...applied, outcome: "refused", method: "owner_workspace_receipt" }, "reconciliation")).toBe(input.requestId);
    expect(ownerPendingReceiptId(input.requestId, target, { ...applied, requestId: randomUUID() }, "reconciliation")).toBe(input.requestId);
    expect(ownerPendingReceiptId(input.requestId, target, { ...applied, owner: { ...target, hostId: "wrong" } }, "reconciliation")).toBe(input.requestId);
    expect(ownerPendingReceiptId(input.requestId, target, { ...applied, outcome: "refused" }, "reconciliation")).toBeNull();
  });
  it("rejects a successful remote receipt with the wrong UUID or operation", async () => {
    const f = await fixture();
    const input = f.inputWrite();
    const localReceipt = await f.service.handlers.owner_file_write(input);
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const };
    f.callOwner.mockResolvedValue({ ok: true, result: { ...localReceipt, owner: remote, requestId: randomUUID() } });
    expect(await f.service.handlers.owner_workspace_receipt({ target: remote, requestId: input.requestId })).toMatchObject({ outcome: "unknown", requestId: input.requestId });
    f.callOwner.mockResolvedValue({ ok: true, result: { ...localReceipt, owner: remote, method: "interaction_respond" } });
    expect(await f.service.handlers.owner_file_write({ ...input, target: remote })).toMatchObject({ outcome: "unknown", requestId: input.requestId });
  });
});


describe("delayed native file navigation", () => {
  it("retains text typed into the old editor while a new file read is outstanding", async () => {
    let editRevision = 4;
    let draft = "original unsent edit";
    let resolve!: (value: { path: string; text: string }) => void;
    const delayedRead = new Promise<{ path: string; text: string }>((done) => { resolve = done; });
    const navigation = ownerReadPreservingDraft(() => delayedRead, () => editRevision);
    draft = "the user typed this while the native read was pending";
    editRevision++;
    resolve({ path: "next.txt", text: "other file contents" });
    const loaded = await navigation;
    if (loaded) draft = loaded.text;
    expect(loaded).toBeNull();
    expect(draft).toBe("the user typed this while the native read was pending");
    expect(await ownerReadPreservingDraft(async () => ({ path: "next.txt", text: "safe to load" }), () => editRevision)).toEqual({ path: "next.txt", text: "safe to load" });
  });
});


describe("native large owner media previews", () => {
  function headRoute(f: Awaited<ReturnType<typeof fixture>>, overrides: { status?: number; headers?: Record<string, string> } = {}) {
    const head = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(raw));
      expect(url.origin).toBe(new URL(f.bb.server.loopbackBaseUrl).origin);
      expect(init).toMatchObject({ method: "HEAD", redirect: "error" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(url.pathname).toMatch(/^\/api\/v1\/file-previews\/synthetic-token\//);
      const relative = url.pathname.split("/").slice(5).map(decodeURIComponent).join("/");
      try {
        const full = await f.realFile(f.workspace, path.join(f.workspace, relative));
        const info = await stat(full);
        if (!info.isFile()) return new Response(null, { status: 400 });
        return new Response(null, { status: overrides.status ?? 200, headers: { "content-length": String(info.size), "content-type": relative.endsWith(".mp4") ? "video/mp4" : "image/png", "accept-ranges": "bytes", etag: `W/"file-fixture-${info.size}"`, ...overrides.headers } });
      } catch { return new Response(null, { status: 403 }); }
    });
    vi.stubGlobal("fetch", head);
    return head;
  }
  it("validates a >8 MiB MP4 using HEAD metadata only and retains the editor/transfer byte cap", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, "render.mp4"), "");
    await truncate(path.join(f.workspace, "render.mp4"), MAX_OWNER_FILE_BYTES * 8 + 37);
    const head = headRoute(f);
    const result = await f.service.handlers.owner_file_preview({ target, path: "render.mp4" });
    expect(result).toMatchObject({ owner: target, rootPath: await realpath(f.workspace), path: "render.mp4", sizeBytes: MAX_OWNER_FILE_BYTES * 8 + 37, mimeType: "video/mp4", rangeSupported: true, etag: `W/"file-fixture-${MAX_OWNER_FILE_BYTES * 8 + 37}"`, preview: { baseUrl: "/api/v1/file-previews/synthetic-token" } });
    expect(head).toHaveBeenCalledTimes(1);
    expect(f.calls.files).toBe(0);
    expect(f.fileWrites).toHaveLength(0);
    expect(f.uploadCalls).toHaveLength(0);
    expect(ownerWorkspaceContract.owner_file_write.input.safeParse({ ...f.inputWrite(), contentBase64: Buffer.alloc(MAX_OWNER_FILE_BYTES + 3).toString("base64") }).success).toBe(false);
  });
  it("authoritatively refuses escaping symlinks, missing leaves and directories without reading bytes", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "outside.mp4"), "outside");
    await symlink(path.join(f.root, "outside.mp4"), path.join(f.workspace, "escape.mp4"));
    await mkdir(path.join(f.workspace, "folder.mp4"));
    headRoute(f);
    for (const relative of ["escape.mp4", "missing.mp4", "folder.mp4"]) await expect(f.service.handlers.owner_file_preview({ target, path: relative })).rejects.toThrow("preview validation failed");
    expect(f.calls.files).toBe(0);
  });
  it("allows a contained symlink only after native root validation and encodes exact special path segments", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, "a #?.mp4"), "fixture");
    await symlink(path.join(f.workspace, "a #?.mp4"), path.join(f.workspace, "inside.mp4"));
    const head = headRoute(f);
    await expect(f.service.handlers.owner_file_preview({ target, path: "inside.mp4" })).resolves.toMatchObject({ sizeBytes: 7 });
    await f.service.handlers.owner_file_preview({ target, path: "a #?.mp4" });
    expect(String(head.mock.calls[1]![0])).toContain("a%20%23%3F.mp4");
    expect(f.calls.files).toBe(0);
  });
  it.each(["../outside.mp4", "/outside.mp4", "a/../b.mp4", ".", "a\\b.mp4"])("refuses unsafe preview path %j before any network call", async (relative) => {
    const f = await fixture();
    const head = headRoute(f);
    await expect(f.service.handlers.owner_file_preview({ target, path: relative })).rejects.toThrow();
    expect(head).not.toHaveBeenCalled();
    expect(f.calls.files).toBe(0);
  });
  it.each([
    { baseUrl: "https://elsewhere.test/media", expiresAtMs: Date.now() + 300000 },
    { baseUrl: "/api/v1/file-previews/token/../escape", expiresAtMs: Date.now() + 300000 },
    { baseUrl: "/api/v1/file-previews/token", expiresAtMs: 1 },
  ])("refuses malformed or expired leases before HEAD: %j", async (lease) => {
    const f = await fixture();
    f.setPreviewLease(lease);
    const head = headRoute(f);
    await expect(f.service.handlers.owner_file_preview({ target, path: "hello.txt" })).rejects.toThrow("lease is invalid or expired");
    expect(head).not.toHaveBeenCalled();
  });
  it("does not relay a preview HEAD to a non-loopback SDK URL", async () => {
    const f = await fixture(target, "https://untrusted.test");
    const head = headRoute(f);
    await expect(f.service.handlers.owner_file_preview({ target, path: "hello.txt" })).rejects.toThrow("loopback route");
    expect(head).not.toHaveBeenCalled();
  });
  it.each([
    { status: 302 }, { status: 410 },
    { headers: { "content-length": "-1" } }, { headers: { "content-length": "9007199254740992" } },
    { headers: { "accept-ranges": "none" } },
  ])("fails closed on unavailable or unbounded native range metadata: %j", async (overrides) => {
    const f = await fixture();
    headRoute(f, overrides);
    await expect(f.service.handlers.owner_file_preview({ target, path: "hello.txt" })).rejects.toThrow(/preview validation failed|range preview metadata/);
    expect(f.calls.files).toBe(0);
  });
  it("refuses a remote preview response with the wrong exact file while retaining native owner dispatch", async () => {
    const f = await fixture();
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const, hostId: "host_studio" };
    const result = { owner: remote, rootPath: "/fixture", path: "other.mp4", sizeBytes: 90_000_000, mimeType: "video/mp4", etag: null, rangeSupported: true, preview: { baseUrl: "/api/v1/file-previews/remote-token", expiresAtMs: Date.now() + 300000 } };
    f.callOwner.mockResolvedValue({ ok: true, result });
    await expect(f.service.handlers.owner_file_preview({ target: remote, path: "render.mp4" })).rejects.toThrow("Preview response path");
    f.callOwner.mockResolvedValue({ ok: true, result: { ...result, path: "render.mp4" } });
    await expect(f.service.handlers.owner_file_preview({ target: remote, path: "render.mp4" })).resolves.toMatchObject({ owner: remote, sizeBytes: 90_000_000 });
    expect(f.callOwner).toHaveBeenLastCalledWith({ serverId: "owner-studio", machineKey: "studio" }, "owner_file_preview", { target: remote, path: "render.mp4" }, false);
    expect(f.calls.files).toBe(0);
  });
  it("renders native seekable video and image controls at the actual remote owner URL, never a local path", () => {
    const file = { owner: target, rootPath: "/private/fixture", path: "render #1.mp4", sizeBytes: 90_000_000, mimeType: "video/mp4", etag: null, rangeSupported: true as const, preview: { baseUrl: "/api/v1/file-previews/remote-token", expiresAtMs: Date.now() + 300000 } };
    const markup = renderToStaticMarkup(createElement(OwnerMediaPreview, { file, ownerUrl: "https://studio.example.invalid", machineKey: "studio", onRefresh() {} }));
    expect(markup).toContain('<video');
    expect(markup).toContain('src="https://studio.example.invalid/api/v1/file-previews/remote-token/render%20%231.mp4"');
    expect(markup).toContain('controls=""');
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain("8 MiB editor and attachment transfer limit");
    expect(markup).not.toMatch(/localhost|127\.0\.0\.1|private\/fixture|autoplay/);
    expect(renderToStaticMarkup(createElement(OwnerMediaPreview, { file: { ...file, path: "image.png", mimeType: "image/png" }, ownerUrl: "https://studio.example.invalid", machineKey: "studio", onRefresh() {} }))).toContain('<img');
    const expired = renderToStaticMarkup(createElement(OwnerMediaPreview, { file: { ...file, preview: { ...file.preview, expiresAtMs: 1 } }, ownerUrl: "https://studio.example.invalid", machineKey: "studio", onRefresh() {} }));
    expect(expired).toContain("expired");
    expect(expired).not.toContain('<video');
    expect(expired).toContain("Refresh owner preview");
    for (const ownerUrl of ["file:///private/fixture", "javascript:alert(1)", "https://user:password@owner.test"]) expect(ownerFilePreviewUrl(ownerUrl, file)).toBeNull();
  });
});


describe("media display loading preserves byte bounds and edits", () => {
  const preview = { owner: target, rootPath: "/fixture", path: "fixture.mp4", sizeBytes: MAX_OWNER_FILE_BYTES + 1, mimeType: "video/mp4", etag: null, rangeSupported: true as const, preview: { baseUrl: "/api/v1/file-previews/token", expiresAtMs: Date.now() + 300000 } };
  const read = { owner: target, rootPath: "/fixture", path: "fixture.txt", sizeBytes: 3, mimeType: "text/plain", sha256: hash("abc"), sourceEncoding: "utf8" as const, offset: 0, nextOffset: null, contentBase64: "YWJj", preview: null };
  it.each([
    { sizeBytes: MAX_OWNER_FILE_BYTES + 1, mimeType: "video/mp4" },
    { sizeBytes: 3, mimeType: "image/png" },
    { sizeBytes: 3, mimeType: "audio/mp3" },
    { sizeBytes: MAX_OWNER_FILE_BYTES + 1, mimeType: "application/octet-stream" },
  ])("never calls full-byte read for streaming media or large opaque files: %j", async (overrides) => {
    const loadRead = vi.fn(async () => read);
    const result = await ownerFileForDisplay(async () => ({ ...preview, ...overrides }), loadRead);
    expect(result).toEqual({ preview: { ...preview, ...overrides }, read: null });
    expect(loadRead).not.toHaveBeenCalled();
  });
  it("keeps the existing bounded read/editor for small text files", async () => {
    const loadRead = vi.fn(async () => read);
    expect(await ownerFileForDisplay(async () => ({ ...preview, sizeBytes: 3, mimeType: "text/plain" }), loadRead)).toEqual({ preview: null, read });
    expect(loadRead).toHaveBeenCalledTimes(1);
  });
  it("retains an edit made during the delayed preview validation without starting a full media read", async () => {
    let revision = 1;
    let resolve!: (value: typeof preview) => void;
    const pending = new Promise<typeof preview>((done) => { resolve = done; });
    const loadRead = vi.fn(async () => read);
    const navigation = ownerReadPreservingDraft(() => ownerFileForDisplay(() => pending, loadRead), () => revision);
    revision++;
    resolve(preview);
    expect(await navigation).toBeNull();
    expect(loadRead).not.toHaveBeenCalled();
  });
});


describe("versioned portable owner export/import path", () => {
  const reference = { serverId: target.serverId, threadId: target.threadId!, messageSeq: 5 };
  const selection = { brief: { text: "Synthetic handoff brief", sourceRefs: [reference] }, decisions: [{ text: "Explicit caller decision", sourceRefs: [reference] }], messages: [{ id: "message5", role: "user" as const, text: "Exact selected text", sourceRef: reference }], omitted: { messageIds: ["message4"], attachmentIds: ["attachment_not_selected"] }, selectedFiles: [{ path: "hello.txt" }] };
  it("exports actual selected source bytes and imports them into a distinct native owner's verified project/host receipts", async () => {
    const source = await fixture();
    const bundle = await source.service.handlers.context_bundle_export({ target, ...selection });
    expect(bundle.source).toMatchObject({ owner: target, workspace: { verification: "verified", path: await realpath(source.workspace) }, repository: { verification: "unknown" } });
    expect(bundle.files[0]).toMatchObject({ path: "hello.txt", sha256: hash("original fixture\n"), sizeBytes: 17 });
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const, hostId: "host_studio", environmentId: "env_studio" };
    const destination = await fixture(remote);
    const input = { target: remote, requestId: randomUUID(), bundle, files: [], context: null };
    const receipt = await destination.service.handlers.context_bundle_import(input);
    expect(receipt).toMatchObject({ outcome: "applied", owner: remote, method: "context_bundle_import" });
    const result = asJson(receipt);
    expect(result.contextFormat).toBe("portable-v1");
    expect(result.portableContext).toMatchObject({ version: 1, narrative: { provenance: "caller-supplied", messages: selection.messages, omitted: selection.omitted }, source: { owner: target }, sourceVerificationAtDestination: "exporter-asserted-not-reverified" });
    expect(result.runtimeFiles[0]).toMatchObject({ sha256: bundle.files[0]!.sha256, hostId: remote.hostId, environmentId: remote.environmentId });
    expect(await readFile(path.join(destination.workspace, result.runtimeFiles[0].path), "utf8")).toBe("original fixture\n");
    expect(result.attachments[0]).toMatchObject({ sourceProjectId: remote.projectId, verified: true, sha256: bundle.files[0]!.sha256 });
    expect(destination.uploadCalls).toHaveLength(1);
    expect(await destination.service.handlers.context_bundle_import(input)).toEqual(receipt);
    expect(destination.uploadCalls).toHaveLength(1);
    expect(source.fileWrites).toHaveLength(0);
  });
  it("rejects corrupt portable bytes before destination upload/write effects and retains a refused receipt", async () => {
    const f = await fixture(); const bundle = await f.service.handlers.context_bundle_export({ target, ...selection });
    const input = { target, requestId: randomUUID(), bundle: { ...bundle, files: [{ ...bundle.files[0]!, contentBase64: Buffer.from("changed").toString("base64") }] }, files: [], context: null };
    const result = await f.service.handlers.context_bundle_import(input);
    expect(result).toMatchObject({ outcome: "refused", requestId: input.requestId });
    expect(f.uploadCalls).toHaveLength(0); expect(f.fileWrites).toHaveLength(0);
  });
  it("round-trips context-only bundles without inventing decisions or exporting omitted files", async () => {
    const f = await fixture();
    const bundle = await f.service.handlers.context_bundle_export({ target, ...selection, decisions: [], selectedFiles: [] });
    expect(bundle.files).toEqual([]); expect(bundle.narrative.decisions).toEqual([]);
    const receipt = await f.service.handlers.context_bundle_import({ target, requestId: randomUUID(), bundle, files: [], context: null });
    expect(receipt.outcome).toBe("applied"); expect(f.uploadCalls).toHaveLength(0);
    expect(f.fileWrites).toHaveLength(1);
  });
  it("routes export through only the exact native owner and refuses foreign source identities", async () => {
    const f = await fixture();
    const bundle = await f.service.handlers.context_bundle_export({ target, ...selection });
    const remote = { ...target, serverId: "owner-studio", machineKey: "studio" as const };
    f.callOwner.mockResolvedValue({ ok: true, result: bundle });
    await expect(f.service.handlers.context_bundle_export({ target: remote, ...selection })).rejects.toThrow("Portable source owner");
    f.callOwner.mockResolvedValue({ ok: true, result: { ...bundle, source: { ...bundle.source, owner: remote } } });
    await expect(f.service.handlers.context_bundle_export({ target: remote, ...selection })).resolves.toMatchObject({ source: { owner: remote } });
    expect(f.callOwner).toHaveBeenLastCalledWith({ serverId: remote.serverId, machineKey: remote.machineKey }, "context_bundle_export", { target: remote, ...selection }, false);
    f.callOwner.mockResolvedValue({ ok: true, result: { ...bundle, source: { ...bundle.source, owner: remote }, files: [] } });
    await expect(f.service.handlers.context_bundle_export({ target: remote, ...selection })).rejects.toThrow("requested narrative and selected files");
  });
});

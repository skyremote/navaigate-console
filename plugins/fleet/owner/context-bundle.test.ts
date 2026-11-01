import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { decodePortableContextBundle, exportPortableContextBundle, portableContextManifest } from "./context-bundle";
import { MAX_CONTEXT_NARRATIVE_BYTES, contextExportSelectionSchema, portableContextBundleSchema } from "./context-bundle-contract";
import { ownerWorkspaceContract } from "./workspace-contract";
const target = { serverId: "owner-fixture", machineKey: "laptop" as const, hostId: "host_fixture", projectId: "proj_fixture", environmentId: "env_fixture", threadId: "thr_fixture" };
const ref = { serverId: target.serverId, threadId: target.threadId, messageSeq: 8 };
const narrative = { brief: { text: "Explicit synthetic brief", sourceRefs: [ref] }, decisions: [{ text: "Caller selected this option", sourceRefs: [ref] }], messages: [{ id: "msg8", role: "user" as const, text: "Synthetic selected message", sourceRef: ref }], omitted: { messageIds: ["msg7"], attachmentIds: ["attachment_omitted"] } };
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
function fixture(repo: "verified" | "missing" | "foreign" = "verified") {
  const nativeTarget = { serverId: target.serverId, machineKey: target.machineKey, hostId: target.hostId, projectId: target.projectId, environmentId: target.environmentId };
  const calls: unknown[] = [];
  const host = createFakePluginHost({ pluginId: `context-${randomUUID()}`, sdk: { plugins: { callRpc: async (input) => {
    calls.push(input);
    if (repo === "missing") throw new Error("Synthetic Git capability unavailable");
    return { owner: repo === "foreign" ? { ...nativeTarget, hostId: "foreign" } : nativeTarget, available: true, verified: true, repository: { rootPath: "/fixture", remoteUrl: "https://github.com/synthetic/fixture.git", branch: "synthetic-branch", commit: "a".repeat(40), dirty: true }, mismatches: [], message: null, observedAt: 1234 } as never;
  } } } });
  disposals.push(() => host.harness.lifecycle.dispose());
  const sourceBytes = new Uint8Array([0, 255, 13, 10, 128]);
  let reads = 0;
  const exportBundle = (selection = { ...narrative, selectedFiles: [{ path: "fixtures/binary.bin" }] }) => exportPortableContextBundle(host.bb, { target, rootPath: "/fixture", selection, readFile: async () => { reads++; return { bytes: sourceBytes, sha256: digest(sourceBytes), sizeBytes: sourceBytes.length, mimeType: "application/octet-stream" }; } });
  return { ...host, exportBundle, sourceBytes, calls, reads: () => reads };
}
describe("portable context v1 export and provenance", () => {
  it("exports actual bytes/hashes/workspace and native verified repository state, preserving supplied narrative and explicit omissions", async () => {
    const f = fixture();
    const bundle = await f.exportBundle();
    expect(bundle).toMatchObject({ schema: "navaigate.portable-context", version: 1, narrative: { ...narrative, provenance: "caller-supplied" }, source: { owner: target, workspace: { verification: "verified", path: "/fixture" }, repository: { verification: "verified", rootPath: "/fixture", branch: "synthetic-branch", commit: "a".repeat(40), dirty: true, observedAt: 1234 } }, files: [{ path: "fixtures/binary.bin", sha256: digest(f.sourceBytes), sizeBytes: 5 }] });
    expect(decodePortableContextBundle(bundle).files[0]?.bytes).toEqual(Buffer.from(f.sourceBytes));
    expect(f.calls[0]).toMatchObject({ pluginId: "fleet", method: "project_verify", input: { target: { hostId: target.hostId, environmentId: target.environmentId }, expected: {} } });
    expect(f.reads()).toBe(1);
  });
  it.each(["missing", "foreign"] as const)("marks repository %s as explicit unknown without fabricating branch/commit or exposing raw errors", async (mode) => {
    const f = fixture(mode);
    const bundle = await f.exportBundle();
    expect(bundle.source.repository).toEqual({ verification: "unknown", reason: "Native owner repository verification is unavailable" });
    expect(JSON.stringify(bundle.source.repository)).not.toMatch(/synthetic-branch|aaaaaaaa|capability/);
  });
  it("retains explicit caller message order and never extracts decisions from text", async () => {
    const f = fixture();
    const messages = [{ ...narrative.messages[0]!, id: "msg-first", sourceRef: { ...ref, messageSeq: 10 } }, { ...narrative.messages[0]!, id: "msg-second", sourceRef: { ...ref, messageSeq: 2 } }];
    const result = await f.exportBundle({ ...narrative, decisions: [], messages, selectedFiles: [] });
    expect(result.narrative.messages.map((item) => item.id)).toEqual(["msg-first", "msg-second"]);
    expect(result.narrative.decisions).toEqual([]);
    expect(f.reads()).toBe(0);
  });
  it.each([".env", ".ssh/id_ed25519", ".git/config", "private-token.json"])("refuses selecting credential/runtime path %j before reading files", async (path) => {
    const f = fixture();
    await expect(f.exportBundle({ ...narrative, selectedFiles: [{ path }] })).rejects.toThrow("credential or private runtime");
    expect(f.reads()).toBe(0);
  });
  it("refuses duplicate selected paths before I/O and corrupt source read metadata", async () => {
    const f = fixture();
    await expect(f.exportBundle({ ...narrative, selectedFiles: [{ path: "a" }, { path: "a" }] })).rejects.toThrow("once");
    expect(f.reads()).toBe(0);
    await expect(exportPortableContextBundle(f.bb, { target, rootPath: "/fixture", selection: { ...narrative, selectedFiles: [{ path: "a" }] }, readFile: async () => ({ bytes: new Uint8Array([1]), sizeBytes: 2, sha256: "a".repeat(64), mimeType: null }) })).rejects.toThrow("byte verification");
  });
});
describe("strict versioned portable import", () => {
  it("validates a real v1 import RPC and excludes embedded bytes from its durable destination manifest", async () => {
    const f = fixture();
    const bundle = await f.exportBundle();
    const input = ownerWorkspaceContract.context_bundle_import.input.parse({ target, requestId: randomUUID(), bundle });
    expect(input.files).toEqual([]); expect(input.context).toBeNull();
    const manifest = portableContextManifest(bundle);
    expect(manifest.selectedFiles[0]?.sha256).toBe(digest(f.sourceBytes));
    expect(manifest.sourceVerificationAtDestination).toBe("exporter-asserted-not-reverified");
    expect(JSON.stringify(manifest)).not.toContain("contentBase64");
    expect(manifest.narrative.omitted).toEqual(narrative.omitted);
  });
  it("refuses unsupported versions and mixed legacy/portable input", async () => {
    const f = fixture(); const bundle = await f.exportBundle();
    expect(ownerWorkspaceContract.context_bundle_import.input.safeParse({ target, requestId: randomUUID(), bundle: { ...bundle, version: 2 } }).success).toBe(false);
    expect(ownerWorkspaceContract.context_bundle_import.input.safeParse({ target, requestId: randomUUID(), bundle, context: { text: "legacy", source: { serverId: "owner", threadId: "thread" } } }).success).toBe(false);
    expect(portableContextBundleSchema.safeParse({ ...bundle, narrative: { ...bundle.narrative, provenance: "automatically-verified" } }).success).toBe(false);
  });
  it.each([
    {}, { serverId: "owner", threadId: "thread" }, { ...ref, messageSeq: -1 }, { ...ref, messageSeq: 1.5 }, { ...ref, secret: "extra" }, { ...ref, serverId: "bad\\nowner" },
  ])("refuses malformed decision source reference %j", (sourceRef) => {
    expect(contextExportSelectionSchema.safeParse({ ...narrative, decisions: [{ text: "Decision", sourceRefs: [sourceRef] }], selectedFiles: [] }).success).toBe(false);
  });
  it("refuses decisions without references, attachment-only transcript refs, duplicate IDs and contradictory omissions", () => {
    for (const changed of [
      { decisions: [{ text: "Unsupported", sourceRefs: [] }] },
      { messages: [{ ...narrative.messages[0]!, sourceRef: { serverId: "owner", threadId: "thread", attachmentId: "attachment" } }] },
      { messages: [narrative.messages[0], narrative.messages[0]] },
      { omitted: { messageIds: ["msg8"], attachmentIds: [] } },
      { omitted: { messageIds: ["msg7", "msg7"], attachmentIds: [] } },
    ]) expect(contextExportSelectionSchema.safeParse({ ...narrative, ...changed, selectedFiles: [] }).success).toBe(false);
  });
  it("enforces narrative UTF8 bytes rather than character count", () => {
    expect(contextExportSelectionSchema.safeParse({ ...narrative, brief: { text: "字".repeat(Math.floor(MAX_CONTEXT_NARRATIVE_BYTES / 2)), sourceRefs: [] }, selectedFiles: [] }).success).toBe(false);
  });
  it("refuses malformed base64, wrong decoded sizes/hashes, credential remote URLs and oversized encoded bundles", async () => {
    const f = fixture(); const bundle = await f.exportBundle(); const file = bundle.files[0]!;
    for (const changed of [{ contentBase64: "%%%%" }, { sizeBytes: 1 }, { sha256: "b".repeat(64) }]) expect(() => decodePortableContextBundle({ ...bundle, files: [{ ...file, ...changed }] })).toThrow(/bytes, size or SHA256/);
    expect(portableContextBundleSchema.safeParse({ ...bundle, source: { ...bundle.source, repository: { verification: "verified", rootPath: "/fixture", remoteUrl: "https://user:secret@example.test/repo", branch: null, commit: null, dirty: false, observedAt: 1 } } }).success).toBe(false);
    const bigFile = { ...file, contentBase64: "A".repeat(7 * 1024 * 1024), sizeBytes: 1 };
    expect(portableContextBundleSchema.safeParse({ ...bundle, files: [bigFile, { ...bigFile, path: "other" }] }).success).toBe(false);
  });
});

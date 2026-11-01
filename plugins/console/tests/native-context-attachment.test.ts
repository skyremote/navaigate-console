import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createNativeContext, MAX_NATIVE_CONTEXT_FILE_BYTES } from "../server-native-context";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
function fixture() {
  const source = makeThreadResponse({ id: "thr_source", projectId: "proj_fixture", providerId: "codex", deletedAt: null });
  const threads = new Map([[source.id, source]]);
  const events: any[] = [{ seq: 1, threadId: source.id, type: "client/turn/requested", data: { requestId: "user1", initiator: "user", systemMessageKind: "unlabeled", input: [{ type: "text", text: `Remember synthetic nonce4816. ${"Earlier visible facts. ".repeat(900)}` }] } }, { seq: 2, threadId: source.id, type: "item/completed", data: { item: { id: "assistant1", type: "agentMessage", text: "Remembered synthetic facts." } } }];
  const hosted = new Map<string, Uint8Array>();
  const uploads: any[] = [];
  let corrupt = false;
  const host = createFakePluginHost({ pluginId: "navaigate-skin", sdk: {
    threads: { get: async ({ threadId }) => { const result = threads.get(threadId); if (!result) throw new Error("404"); return result; }, events: { list: async ({ threadId }) => events.filter((item) => item.threadId === threadId).sort((a, b) => b.seq - a.seq) } },
    projects: { attachments: { upload: async (args) => { uploads.push(args); const path = `.bb/attachments/fixture-${uploads.length}/${args.filename}`; hosted.set(path, new Uint8Array(args.clientFile as Uint8Array)); return { path, name: args.filename, type: args.mimeType, size: (args.clientFile as Uint8Array).length } as never; }, read: async ({ path }) => { const bytes = hosted.get(path); if (!bytes) throw new Error("missing attachment"); return { bytes: corrupt ? new Uint8Array([9]) : bytes, sizeBytes: bytes.length, mimeType: "text/plain" }; } } },
  } });
  hosts.push(host); const context = createNativeContext(host.bb);
  const input = { sourceThreadId: source.id, rootThreadId: source.id, projectId: source.projectId };
  return { ...host, source, threads, events, hosted, uploads, context, input, corrupt() { corrupt = true; } };
}
describe("real uploaded bounded continuation context", () => {
  it("uploads and verifies a real project attachment containing facts beyond the vendor inline cap", async () => {
    const f = fixture();
    const result = await f.harness.behavior.callRpc("native_context_attachment", f.input) as Awaited<ReturnType<typeof f.context.attachment>>;
    expect(result).toMatchObject({ delivery: "uploaded-context-file", messageCount: 2, truncated: false, attachment: { type: "localFile", sourceProjectId: f.source.projectId, mimeType: "text/plain" } });
    const bytes = f.hosted.get(result.attachment.path)!;
    expect(bytes.length).toBeGreaterThan(4096); expect(bytes.length).toBeLessThanOrEqual(MAX_NATIVE_CONTEXT_FILE_BYTES);
    expect(Buffer.from(bytes).toString("utf8")).toContain("nonce4816");
    expect(f.uploads[0].clientFile).toBeInstanceOf(Uint8Array);
    expect(result.attachment.path).toMatch(/^\.bb\/attachments\//); expect("hostId" in result.attachment).toBe(false);
    expect(await f.harness.behavior.callRpc("native_context_capabilities", null)).toEqual({ agentContext: false, contextFileMaxBytes: 60000, inlineMaxChars: 4096 });
  });
  it("deduplicates concurrent and durable retries by verified scoped content and regenerates changed history", async () => {
    const f = fixture();
    const results = await Promise.all([f.context.attachment(f.input), f.context.attachment(f.input)]);
    expect(results[0]).toEqual(results[1]); expect(f.uploads).toHaveLength(1);
    expect(await f.context.attachment(f.input)).toEqual(results[0]); expect(f.uploads).toHaveLength(1);
    f.events.push({ seq: 3, threadId: f.source.id, type: "item/completed", data: { item: { id: "assistant2", type: "agentMessage", text: "A newer fact." } } });
    expect((await f.context.attachment(f.input)).sha256).not.toBe(results[0]!.sha256); expect(f.uploads).toHaveLength(2);
  });
  it("bounds multibyte history and excludes tools, reasoning, agent-only and foreign-project content", async () => {
    const f = fixture();
    f.events[0].data.input[0].text = "字".repeat(60000);
    f.events.push({ seq: 3, threadId: f.source.id, type: "item/completed", data: { item: { id: "tool1", type: "toolCall", text: "SYNTHETIC_TOOL_SECRET" } } }, { seq: 4, threadId: f.source.id, type: "client/turn/requested", data: { requestId: "sys", initiator: "system", input: [{ type: "text", text: "SYNTHETIC_SYSTEM_SECRET" }] } });
    const result = await f.context.attachment(f.input); const text = Buffer.from(f.hosted.get(result.attachment.path)!).toString("utf8");
    expect(result.truncated).toBe(true); expect(result.attachment.sizeBytes).toBeLessThanOrEqual(60000); expect(text).not.toMatch(/SYNTHETIC_TOOL_SECRET|SYNTHETIC_SYSTEM_SECRET/);
    await expect(f.context.attachment({ ...f.input, projectId: "proj_other" })).rejects.toThrow("project");
    expect(f.uploads).toHaveLength(1);
  });
  it("requires a verified logical membership for a different source and refuses corrupt hosted bytes", async () => {
    const f = fixture(); const child = { ...f.source, id: "thr_child" }; f.threads.set(child.id, child);
    await expect(f.context.attachment({ ...f.input, sourceThreadId: child.id })).rejects.toThrow("member");
    f.corrupt(); await expect(f.context.attachment(f.input)).rejects.toThrow("byte verification");
  });
});

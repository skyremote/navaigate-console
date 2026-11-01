// @vitest-environment jsdom
import React from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useComposer } from "@get-bb/plugin-sdk/app";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { NativeConversationComposerScope } from "../src/native-sessions";
import { appendNativeContextAttachment, hasNativeContinuationIntent, type NativeContinuationIntent } from "../src/native-continuation";
import type { z } from "zod";
import type { nativeSessionStateSchema } from "../server-native-sessions";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => cleanup());
const generation = "11111111-1111-4111-8111-111111111111";
const contextFile = { type: "localFile" as const, path: ".bb/attachments/context.txt", name: "context.txt", sourceProjectId: "proj_test", sizeBytes: 12000 };
function state(): z.infer<typeof nativeSessionStateSchema> { return { rootThreadId: "thr_root", activeThreadId: "thr_root", projectId: "proj_test", title: "Synthetic conversation", version: 1, pending: null, warning: null, members: [{ id: "thr_root", sourceThreadId: null, kind: "root", providerId: "codex", environmentId: "env_test", model: "synthetic-sol", reasoningLevel: "high", serviceTier: "default", title: "Synthetic root", status: "idle", createdAt: 1 }] }; }
function fixture(agentContext = false, deferredArm?: Promise<ReturnType<typeof state>>) {
  let intent: NativeContinuationIntent | null = null;
  let handle!: PluginComposerApi;
  const setter = vi.fn((value: NativeContinuationIntent | null) => { intent = value; return true; });
  function Bridge() { handle = useComposer(); Object.assign(handle, { experimental_setContinuationIntent: setter }); return <NativeConversationComposerScope />; }
  const armed = () => ({ ...state(), pending: { sourceThreadId: "thr_root", providerId: "claude-code", model: "synthetic-opus", reasoningLevel: "high", generation, selectionVersion: 1, createdAt: 1, expiresAt: Date.now() + 300000, proofRequired: true, continuationComposerKey: handle.key } });
  const view = renderSlot({ component: Bridge }, {}, { composer: { scope: { kind: "thread", threadId: "thr_root" }, text: "Current real draft", attachments: [{ type: "localFile", path: ".bb/attachments/user.txt", name: "user.txt", sourceProjectId: "proj_test" }] }, rpc: {
    native_session_state: state,
    native_context_capabilities: () => ({ agentContext, contextFileMaxBytes: 60000, inlineMaxChars: 4096 }),
    native_context_attachment: () => ({ attachment: contextFile, sha256: "a".repeat(64), truncated: false, messageCount: 2, delivery: "uploaded-context-file" }),
    native_session_arm: () => deferredArm ?? armed(),
    native_session_prepare_cancel: state,
  } });
  return { ...view, setter, get handle() { return handle; }, get intent() { return intent; }, armed };
}
const selection = { providerId: "claude-code", model: "synthetic-opus", reasoningLevel: "high" as const };
describe("scoped native-picker continuation bridge", () => {
  it("registers without arming or editing the draft, then prepares the actual native selection through one owned callback", async () => {
    const f = fixture(); await waitFor(() => expect(f.intent).not.toBeNull());
    const original = structuredClone(f.composer.draft);
    expect(hasNativeContinuationIntent(f.handle)).toBe(true);
    expect(f.inspection.rpcCalls.some((call) => call.method === "native_session_arm")).toBe(false);
    const signal = new AbortController();
    const result = await f.intent!.prepare({ sourceThreadId: "thr_root", selection, draft: f.handle.draft, signal: signal.signal });
    expect(result).toEqual({ data: { kind: "logical-continuation-v1", rootThreadId: "thr_root", sourceThreadId: "thr_root", generation, composerKey: f.handle.key }, attachments: [contextFile] });
    expect(f.inspection.rpcCalls.find((call) => call.method === "native_session_arm")?.input).toEqual({ threadId: "thr_root", selection, proofRequired: true, expectedVersion: 1, continuationComposerKey: f.handle.key });
    expect(f.composer.draft).toEqual(original); expect(f.composer.submits).toEqual([]); expect(f.composer.selections).toEqual([]);
    const key = f.handle.key; f.lifecycle.unmount(); expect(f.setter).toHaveBeenLastCalledWith(null); expect(hasNativeContinuationIntent({ key } as PluginComposerApi)).toBe(false);
  });
  it("marks an explicit standalone handoff without context reads, uploads or logical arming", async () => {
    const f = fixture(); await waitFor(() => expect(f.intent).not.toBeNull());
    const result = await f.intent!.standalone!({ sourceThreadId: "thr_root", selection, draft: f.handle.draft, signal: new AbortController().signal });
    expect(result).toEqual({ data: { kind: "standalone-handoff-v1", sourceThreadId: "thr_root", composerKey: f.handle.key } });
    expect(f.inspection.rpcCalls.some((call) => ["native_context_capabilities", "native_context_attachment", "native_session_arm"].includes(call.method))).toBe(false);
    expect(f.composer.submits).toEqual([]);
  });
  it("uses full agent context on a capable core without adding a file or changing native selection", async () => {
    const f = fixture(true); await waitFor(() => expect(f.intent).not.toBeNull());
    const result = await f.intent!.prepare({ sourceThreadId: "thr_root", selection, draft: f.handle.draft, signal: new AbortController().signal });
    expect(result.attachments).toEqual([]);
    expect(f.inspection.rpcCalls.some((call) => call.method === "native_context_attachment")).toBe(false);
    expect(f.composer.selections).toEqual([]);
  });
  it("cancels only its returned generation when cancellation happens while arm acknowledgement is outstanding", async () => {
    let resolve!: (value: ReturnType<typeof state>) => void; const waiting = new Promise<ReturnType<typeof state>>((done) => { resolve = done; });
    const f = fixture(false, waiting); await waitFor(() => expect(f.intent).not.toBeNull());
    const controller = new AbortController();
    const pending = f.intent!.prepare({ sourceThreadId: "thr_root", selection, draft: f.handle.draft, signal: controller.signal });
    await waitFor(() => expect(f.inspection.rpcCalls.some((call) => call.method === "native_session_arm")).toBe(true));
    controller.abort(); resolve(f.armed());
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.inspection.rpcCalls.find((call) => call.method === "native_session_prepare_cancel")?.input).toEqual({ threadId: "thr_root", generation });
    expect(f.composer.submits).toEqual([]);
  });
  it("atomically appends a genuine legacy attachment while retaining later text, mentions and uploaded user files", async () => {
    const f = fixture(); await waitFor(() => expect(f.intent).not.toBeNull());
    await act(async () => { await f.behavior.setComposerText("A later user edit"); });
    const before = f.handle.draft;
    appendNativeContextAttachment(f.handle, contextFile);
    expect(f.handle.draft.text).toBe("A later user edit"); expect(f.handle.draft.mentions).toEqual(before.mentions); expect(f.handle.draft.attachments).toEqual([...before.attachments, contextFile]);
    appendNativeContextAttachment(f.handle, contextFile); expect(f.handle.draft.attachments).toHaveLength(2);
  });
});

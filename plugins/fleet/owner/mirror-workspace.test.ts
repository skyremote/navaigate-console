import { describe, expect, it } from "vitest";
import { createMirrorWorkspace, mirrorWorkspaceContract, type MirrorCopyOwner } from "./mirror-workspace";

const copy: MirrorCopyOwner = { machine: "studio", serverId: "studio-srv", remoteThreadId: "thr_owned" };
const target = { serverId: "studio-srv", machineKey: "studio" as const, hostId: "host_studio", environmentId: "env_studio", projectId: "proj_studio", threadId: "thr_owned" };

function make(options: { copy?: MirrorCopyOwner | null; target?: typeof target | Error; editor?: { path: string; url: string } | { reason: string } | Error } = {}) {
  const asked: MirrorCopyOwner[] = [];
  const workspace = createMirrorWorkspace({
    copyOwner: async (threadId) => (threadId === "thr_copy" ? (options.copy === undefined ? copy : options.copy) : null),
    local: async () => ({ serverId: "laptop-srv", machineKey: "laptop" }),
    ownerTarget: async (owner) => { asked.push(owner); if (options.target instanceof Error) throw options.target; return options.target ?? target; },
    ownerEditor: async () => { if (options.editor instanceof Error) throw options.editor; return options.editor === undefined ? { path: "/Users/tester/Repo", url: "vscode://vscode-remote/ssh-remote+studio/Users/tester/Repo" } : options.editor; },
    ownerLinks: async () => ({ ownerUrl: "https://studio.example.test", ownerThreadUrl: "https://studio.example.test/t/thr_owned" }),
  });
  return { handlers: workspace.handlers, asked };
}

describe("mirror owner workspace", () => {
  it("resolves a mirror copy to its exact owner thread target only from saved copy state", async () => {
    const { handlers, asked } = make();
    expect(await handlers.mirror_copy_owner({ threadId: "thr_copy" })).toEqual(copy);
    expect(await handlers.mirror_owner_workspace({ threadId: "thr_copy" })).toEqual({ available: true, copy, target, localServerId: "laptop-srv", localMachineKey: "laptop", ownerUrl: "https://studio.example.test", ownerThreadUrl: "https://studio.example.test/t/thr_owned" });
    expect(asked).toEqual([copy]);
  });

  it("shows nothing for an ordinary thread and never asks an owner", async () => {
    const { handlers, asked } = make();
    expect(await handlers.mirror_copy_owner({ threadId: "thr_plain" })).toBeNull();
    expect(await handlers.mirror_owner_workspace({ threadId: "thr_plain" })).toMatchObject({ available: false, copy: null });
    expect(asked).toEqual([]);
  });

  it("reports an unreachable owner instead of falling back to this Mac", async () => {
    const { handlers } = make({ target: new Error("no-authenticated-owner-route") });
    expect(await handlers.mirror_owner_workspace({ threadId: "thr_copy" })).toMatchObject({ available: false, copy, reason: expect.stringContaining("no-authenticated-owner-route") });
  });

  it("refuses an owner answer for another server or thread", async () => {
    expect(await make({ target: { ...target, threadId: "thr_other" } }).handlers.mirror_owner_workspace({ threadId: "thr_copy" })).toMatchObject({ available: false, reason: expect.stringContaining("another server or thread") });
    expect(await make({ target: { ...target, serverId: "elsewhere" } }).handlers.mirror_owner_workspace({ threadId: "thr_copy" })).toMatchObject({ available: false });
  });

  it("opens the owner thread's real project folder in the editor from saved copy state", async () => {
    const { handlers, asked } = make();
    expect(await handlers.mirror_owner_editor({ threadId: "thr_copy" })).toEqual({ available: true, machine: "studio", path: "/Users/tester/Repo", url: "vscode://vscode-remote/ssh-remote+studio/Users/tester/Repo" });
    expect(asked).toEqual([copy]);
  });

  it("offers no editor for an ordinary thread and never asks an owner", async () => {
    const { handlers, asked } = make();
    expect(await handlers.mirror_owner_editor({ threadId: "thr_plain" })).toMatchObject({ available: false });
    expect(asked).toEqual([]);
  });

  it("explains an unreachable owner, a missing editor route and an unreadable folder", async () => {
    expect(await make({ target: new Error("no-authenticated-owner-route") }).handlers.mirror_owner_editor({ threadId: "thr_copy" })).toMatchObject({ available: false, reason: expect.stringContaining("no-authenticated-owner-route") });
    expect(await make({ editor: { reason: "This Mac has no studio SSH alias" } }).handlers.mirror_owner_editor({ threadId: "thr_copy" })).toEqual({ available: false, reason: "No editor route to studio: This Mac has no studio SSH alias" });
    expect(await make({ editor: { reason: "The folder /a/../b cannot be opened as an editor link" } }).handlers.mirror_owner_editor({ threadId: "thr_copy" })).toEqual({ available: false, reason: "No editor route to studio: The folder /a/../b cannot be opened as an editor link" });
    expect(await make({ editor: new Error("env not ready") }).handlers.mirror_owner_editor({ threadId: "thr_copy" })).toMatchObject({ available: false, reason: expect.stringContaining("env not ready") });
  });

  it("refuses an editor link when the owner answers for another thread", async () => {
    expect(await make({ target: { ...target, threadId: "thr_other" } }).handlers.mirror_owner_editor({ threadId: "thr_copy" })).toMatchObject({ available: false, reason: expect.stringContaining("another server or thread") });
  });

  it("accepts only a real thread id", () => {
    expect(mirrorWorkspaceContract.mirror_owner_workspace.input.safeParse({ threadId: "thr_copy" }).success).toBe(true);
    expect(mirrorWorkspaceContract.mirror_owner_workspace.input.safeParse({ threadId: "../x" }).success).toBe(false);
    expect(mirrorWorkspaceContract.mirror_owner_workspace.input.safeParse({ threadId: "thr_copy", serverId: "x" }).success).toBe(false);
  });
});

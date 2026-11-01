// The owner workspace of a mirror copy: a local copy thread resolves to the
// exact owner thread it mirrors, read from the mirror's own saved copy state
// (never from caller input), then to that thread's workspace target on the
// owner (this server, or the always-on Mac over its authenticated route). There is no
// server or thread selector and no local fallback.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ownerTargetSchema, type OwnerWorkspaceTarget } from "./workspace-contract";

const threadId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/);
const copyOwnerSchema = z.object({ machine: z.string().min(1).max(40), serverId: z.string(), remoteThreadId: z.string() }).strict();
export type MirrorCopyOwner = z.infer<typeof copyOwnerSchema>;

export const mirrorWorkspaceContract = defineRpcContract({
  mirror_owner_editor: {
    input: z.object({ threadId }).strict(),
    output: z.discriminatedUnion("available", [
      z.object({ available: z.literal(true), machine: z.string().min(1).max(40), path: z.string(), url: z.string() }).strict(),
      z.object({ available: z.literal(false), reason: z.string() }).strict(),
    ]),
  },
  mirror_copy_owner: { input: z.object({ threadId }).strict(), output: copyOwnerSchema.nullable() },
  mirror_owner_workspace: {
    input: z.object({ threadId }).strict(),
    output: z.discriminatedUnion("available", [
      z.object({ available: z.literal(true), copy: copyOwnerSchema, target: ownerTargetSchema, localServerId: z.string(), localMachineKey: z.string(), ownerUrl: z.string().nullable(), ownerThreadUrl: z.string().nullable() }).strict(),
      z.object({ available: z.literal(false), copy: copyOwnerSchema.nullable(), reason: z.string() }).strict(),
    ]),
  },
});

export interface MirrorWorkspaceDeps {
  /** The mirror's saved owner for one local copy thread, or null when it is not a Fleet mirror copy. */
  copyOwner(localThreadId: string): Promise<MirrorCopyOwner | null>;
  local(): Promise<{ serverId: string; machineKey: string }>;
  /** The exact owner thread target, resolved on the owner; throws when no authenticated route exists. */
  ownerTarget(copy: MirrorCopyOwner): Promise<OwnerWorkspaceTarget>;
  /** The owner thread's real project folder as an editor link, or the reason this Mac cannot offer one. */
  ownerEditor(copy: MirrorCopyOwner, target: OwnerWorkspaceTarget): Promise<{ path: string; url: string } | { reason: string }>;
  ownerLinks(copy: MirrorCopyOwner, target: OwnerWorkspaceTarget): Promise<{ ownerUrl: string | null; ownerThreadUrl: string | null }>;
}

export function createMirrorWorkspace(deps: MirrorWorkspaceDeps) {
  return {
    handlers: {
      mirror_copy_owner: async ({ threadId: id }: { threadId: string }) => deps.copyOwner(id),
      mirror_owner_editor: async ({ threadId: id }: { threadId: string }) => {
        const copy = await deps.copyOwner(id);
        if (copy === null) return { available: false as const, reason: "This thread is not a Fleet mirror copy" };
        let target: OwnerWorkspaceTarget;
        try { target = ownerTargetSchema.parse(await deps.ownerTarget(copy)); }
        catch (cause) { return { available: false as const, reason: `The ${copy.machine} owner cannot be reached: ${cause instanceof Error ? cause.message : String(cause)}` }; }
        if (target.serverId !== copy.serverId || target.threadId !== copy.remoteThreadId) return { available: false as const, reason: "The owner answered for another server or thread; nothing is opened" };
        let link: { path: string; url: string } | { reason: string };
        try { link = await deps.ownerEditor(copy, target); }
        catch (cause) { return { available: false as const, reason: `The ${copy.machine} project folder could not be read: ${cause instanceof Error ? cause.message : String(cause)}` }; }
        if ("reason" in link) return { available: false as const, reason: `No editor route to ${copy.machine}: ${link.reason}` };
        return { available: true as const, machine: copy.machine, path: link.path, url: link.url };
      },
      mirror_owner_workspace: async ({ threadId: id }: { threadId: string }) => {
        const copy = await deps.copyOwner(id);
        if (copy === null) return { available: false as const, copy: null, reason: "This thread is not a Fleet mirror copy" };
        let target: OwnerWorkspaceTarget;
        try { target = ownerTargetSchema.parse(await deps.ownerTarget(copy)); }
        catch (cause) { return { available: false as const, copy, reason: `The ${copy.machine} owner cannot be reached: ${cause instanceof Error ? cause.message : String(cause)}` }; }
        if (target.serverId !== copy.serverId || target.threadId !== copy.remoteThreadId) return { available: false as const, copy, reason: "The owner answered for another server or thread; nothing is shown" };
        const local = await deps.local();
        const links = await deps.ownerLinks(copy, target);
        return { available: true as const, copy, target, localServerId: local.serverId, localMachineKey: local.machineKey, ...links };
      },
    },
  };
}

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const TRANSFER_FILE_BYTES = 1024 * 1024;
export const TRANSFER_TOTAL_BYTES = 8 * TRANSFER_FILE_BYTES;
const id = z.string().min(1).max(250);
export const projectOwnerTargetSchema = z.object({
  serverId: id, machineKey: z.string().min(1).max(40), hostId: id,
  projectId: id.nullable(), environmentId: id.nullable(),
}).strict();
export type ProjectOwnerTarget = z.infer<typeof projectOwnerTargetSchema>;
const selectedEnvironment = projectOwnerTargetSchema.refine((value) => value.projectId !== null && value.environmentId !== null, "Select the exact owner project and environment");
export const transferPathSchema = z.string().min(1).max(1000).refine((value) => !value.startsWith("/") && !/[\\\0\x00-\x1f\x7f]/.test(value) && !/^[A-Za-z]:/.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Use a relative selected file path without traversal");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().min(2).max(2000).refine((value) => value.startsWith("/") && !/[\\\0\x00-\x1f\x7f]/.test(value) && value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== ".."), "Use an explicit absolute owner path without traversal");
export const projectRemoteSchema = z.string().min(1).max(1000).refine((value) => {
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value)) return !value.includes("/../") && !value.includes("/./");
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "ssh:") && !url.password && (url.protocol === "ssh:" ? url.username === "git" : !url.username) && !url.search && !url.hash && url.pathname.length > 1; } catch { return false; }
}, "Use a credential-free HTTPS or SSH Git remote");
export const ownerProjectMethods = ["project_verify", "project_prepare", "transfer_manifest_apply", "transfer_receipt"] as const;
export type OwnerProjectMethod = typeof ownerProjectMethods[number];
export const ownerProjectReceiptSchema = z.object({
  owner: projectOwnerTargetSchema, requestId: z.string().uuid(), method: z.enum(["project_prepare", "transfer_manifest_apply"]).nullable(),
  fingerprint: sha.nullable(), outcome: z.enum(["applied", "refused", "unknown", "unavailable"]),
  result: z.json().nullable(), message: z.string().max(1800).nullable(), updatedAt: z.number(),
}).strict();
export type OwnerProjectReceipt = z.infer<typeof ownerProjectReceiptSchema>;
const prepare = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("clone_source"), destinationPath: absolutePath, remoteUrl: projectRemoteSchema }).strict(),
  z.object({ mode: z.literal("register_checkout"), path: absolutePath, expectedRemoteUrl: projectRemoteSchema.nullable() }).strict(),
  z.object({ mode: z.literal("create_project"), path: absolutePath, name: z.string().trim().min(1).max(150), expectedRemoteUrl: projectRemoteSchema.nullable() }).strict(),
]);
const repo = z.object({ rootPath: absolutePath, remoteUrl: projectRemoteSchema.nullable(), branch: z.string().nullable(), commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), dirty: z.boolean() }).strict();
export const ownerProjectContract = defineRpcContract({
  project_verify: {
    input: z.object({ target: selectedEnvironment, expected: z.object({ remoteUrl: projectRemoteSchema.nullable().optional(), branch: z.string().max(500).nullable().optional(), commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable().optional(), dirty: z.boolean().optional() }).strict().default({}) }).strict(),
    output: z.object({ owner: projectOwnerTargetSchema, available: z.boolean(), verified: z.boolean(), repository: repo.nullable(), mismatches: z.array(z.enum(["remoteUrl", "branch", "commit", "dirty"])), message: z.string().max(1800).nullable(), observedAt: z.number() }).strict(),
  },
  project_prepare: {
    input: z.object({ target: projectOwnerTargetSchema, requestId: z.string().uuid(), prepare }).strict().refine((value) => value.target.environmentId === null && (value.prepare.mode === "create_project" ? value.target.projectId === null : value.target.projectId !== null), "Prepare a new source without an environment; existing project ID is required except for create_project"),
    output: ownerProjectReceiptSchema,
  },
  transfer_manifest_apply: {
    input: z.object({ target: selectedEnvironment, requestId: z.string().uuid(), files: z.array(z.object({
      path: transferPathSchema, sizeBytes: z.number().int().min(0).max(TRANSFER_FILE_BYTES), sha256: sha,
      contentBase64: z.string().max(Math.ceil(TRANSFER_FILE_BYTES / 3) * 4).refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "Use canonical base64 bytes"),
    }).strict()).min(1).max(256) }).strict().refine((value) => value.files.reduce((sum, file) => sum + file.sizeBytes, 0) <= TRANSFER_TOTAL_BYTES, "Selected files exceed 8 MiB total").refine((value) => value.files.reduce((sum, file) => sum + file.contentBase64.length, 0) <= Math.ceil(TRANSFER_TOTAL_BYTES / 3) * 4 + 4 * value.files.length, "Encoded selected bytes exceed the total limit").refine((value) => { const paths = value.files.map((file) => file.path.toLowerCase()); return new Set(paths).size === paths.length && paths.every((p) => !paths.some((other) => other !== p && other.startsWith(p + "/"))); }, "Select each destination once without file/directory conflicts"),
    output: ownerProjectReceiptSchema,
  },
  transfer_receipt: { input: z.object({ target: projectOwnerTargetSchema, requestId: z.string().uuid() }).strict(), output: ownerProjectReceiptSchema },
});

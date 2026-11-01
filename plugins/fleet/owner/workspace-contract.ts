import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { contextExportSelectionSchema, portableContextBundleSchema } from "./context-bundle-contract";

export const MAX_OWNER_FILE_BYTES = 8 * 1024 * 1024;
export const OWNER_READ_CHUNK_BYTES = 256 * 1024;
const id = z.string().min(1).max(250);
export const ownerTargetSchema = z.object({
  serverId: id, machineKey: z.string().min(1).max(40), hostId: id,
  environmentId: id, projectId: id, threadId: id.optional(),
}).strict();
export type OwnerWorkspaceTarget = z.infer<typeof ownerTargetSchema>;
export const ownerPathSchema = z.string().min(1).max(2000).refine((value) => value === "." || (
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !/^[A-Za-z]:/.test(value)
  && value.split("/").every((part) => part !== ".." && part !== "." && part !== "")
), "Use an environment-relative path without traversal");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const base64 = z.string().max(Math.ceil(MAX_OWNER_FILE_BYTES / 3) * 4).refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "Use canonical base64 bytes");
const preview = z.object({ baseUrl: z.string(), expiresAtMs: z.number() }).nullable();
const baseOutput = { owner: ownerTargetSchema, rootPath: z.string(), path: ownerPathSchema };
export const ownerWorkspaceMethods = ["owner_file_stat", "owner_file_list", "owner_file_read", "owner_file_preview", "owner_file_write", "context_bundle_import", "context_bundle_export", "interaction_list", "interaction_respond", "owner_workspace_receipt"] as const;
export type OwnerWorkspaceMethod = typeof ownerWorkspaceMethods[number];
export const ownerWorkspaceReceiptSchema = z.object({
  owner: ownerTargetSchema, requestId: z.string().uuid(), method: z.enum(ownerWorkspaceMethods).nullable(),
  outcome: z.enum(["applied", "refused", "unknown", "unavailable"]), result: z.json().nullable(),
  message: z.string().max(2000).nullable(), updatedAt: z.number(),
});
export type OwnerWorkspaceReceipt = z.infer<typeof ownerWorkspaceReceiptSchema>;
export const ownerInteractionResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_answer"), answers: z.record(id, z.object({ selected: z.array(id).max(100), freeText: z.string().trim().min(1).max(20_000).optional() }).strict()) }).strict(),
  z.object({ kind: z.literal("approval"), decision: z.enum(["deny", "allow_once", "allow_for_session"]) }).strict(),
  z.object({ kind: z.literal("plugin"), value: z.json() }).strict(),
]);
export const ownerPendingInteractionSchema = z.object({
  id, threadId: id, turnId: id.nullable(), kind: id, createdAt: z.number(), expiresAt: z.number().nullable(),
  fingerprint: sha, payload: z.json(),
});
export type OwnerPendingInteraction = z.infer<typeof ownerPendingInteractionSchema>;
const threadTarget = ownerTargetSchema.refine((value) => !!value.threadId, "Select an owner thread");
const request = { target: ownerTargetSchema, requestId: z.string().uuid() };
export const ownerWorkspaceContract = defineRpcContract({
  owner_file_stat: {
    input: z.object({ target: ownerTargetSchema, path: ownerPathSchema, preview: z.boolean().default(false) }).strict(),
    output: z.object({ ...baseOutput, kind: z.enum(["file", "directory", "missing"]), sizeBytes: z.number().nullable(), sha256: sha.nullable(), preview }),
  },
  owner_file_list: {
    input: z.object({ target: ownerTargetSchema, path: ownerPathSchema.default("."), limit: z.number().int().min(1).max(200).default(100), after: z.string().max(240).optional() }).strict(),
    output: z.object({ ...baseOutput, entries: z.array(z.object({ name: z.string(), path: ownerPathSchema, kind: z.enum(["file", "directory"]) })).max(200), nextAfter: z.string().nullable() }),
  },
  owner_file_read: {
    input: z.object({ target: ownerTargetSchema, path: ownerPathSchema.refine((value) => value !== "."), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(OWNER_READ_CHUNK_BYTES).default(OWNER_READ_CHUNK_BYTES), expectedSha256: sha.optional(), preview: z.boolean().default(false) }).strict(),
    output: z.object({ ...baseOutput, contentBase64: z.string().max(Math.ceil(OWNER_READ_CHUNK_BYTES / 3) * 4), sha256: sha, sizeBytes: z.number(), mimeType: z.string().nullable(), sourceEncoding: z.enum(["utf8", "base64"]), offset: z.number(), nextOffset: z.number().nullable(), preview }),
  },
  owner_file_preview: {
    input: z.object({ target: ownerTargetSchema, path: ownerPathSchema.refine((value) => value !== ".") }).strict(),
    output: z.object({ ...baseOutput, sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), mimeType: z.string().max(250).nullable(), etag: z.string().max(500).nullable(), rangeSupported: z.literal(true), preview: z.object({ baseUrl: z.string().regex(/^\/api\/v1\/file-previews\/[A-Za-z0-9_-]+$/), expiresAtMs: z.number().finite() }) }),
  },
  owner_file_write: {
    input: z.object({ ...request, path: ownerPathSchema.refine((value) => value !== "."), contentBase64: base64, sha256: sha, expectedSha256: sha.nullable() }).strict(),
    output: ownerWorkspaceReceiptSchema,
  },
  context_bundle_export: {
    input: contextExportSelectionSchema.safeExtend({ target: ownerTargetSchema }), output: portableContextBundleSchema,
  },
  context_bundle_import: {
    input: z.object({ ...request,
      files: z.array(z.object({ name: z.string().min(1).max(240).refine((value) => !/[\\/\0]/.test(value)), mimeType: z.string().min(1).max(200), contentBase64: base64, sha256: sha }).strict()).max(20).default([]),
      bundle: portableContextBundleSchema.optional(),
      context: z.object({ text: z.string().max(64_000), source: z.object({ serverId: id, threadId: id, messageSeq: z.number().int().positive().optional() }).strict() }).strict().nullable().default(null),
    }).strict().refine((value) => value.bundle !== undefined || value.files.length > 0 || value.context !== null, "Supply files or context").refine((value) => value.bundle === undefined || (value.files.length === 0 && value.context === null), "Use either a portable bundle or legacy files/context").refine((value) => value.files.reduce((sum, file) => sum + file.contentBase64.length, 0) <= Math.ceil(MAX_OWNER_FILE_BYTES / 3) * 4 + 80, "Context bundle exceeds the total byte limit"),
    output: ownerWorkspaceReceiptSchema,
  },
  interaction_list: {
    input: z.object({ target: threadTarget }).strict(),
    output: z.object({ owner: ownerTargetSchema, interactions: z.array(ownerPendingInteractionSchema).max(20), truncated: z.boolean() }),
  },
  interaction_respond: {
    input: z.object({ target: threadTarget, requestId: z.string().uuid(), interactionId: id, expectedFingerprint: sha, response: ownerInteractionResponseSchema }).strict(),
    output: ownerWorkspaceReceiptSchema,
  },
  owner_workspace_receipt: {
    input: z.object(request).strict(), output: ownerWorkspaceReceiptSchema,
  },
});

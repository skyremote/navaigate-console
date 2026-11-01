import { z } from "zod";
import { projectRemoteSchema } from "./project-contract";

export const PORTABLE_CONTEXT_VERSION = 1;
export const MAX_CONTEXT_NARRATIVE_BYTES = 64 * 1024;
export const MAX_CONTEXT_BUNDLE_BYTES = 12 * 1024 * 1024;
const id = z.string().min(1).max(250).refine((value) => !/[\x00-\x1f\x7f\\]/.test(value) && value.trim() === value && value.length > 0);
const relativePath = z.string().min(1).max(2000).refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !/^[A-Za-z]:/.test(value) && value.split("/").every((part) => part !== ".." && part !== "." && part !== ""));
export const contextSourceRefSchema = z.object({
  serverId: id, threadId: id, messageId: id.optional(), messageSeq: z.number().int().positive().optional(), attachmentId: id.optional(),
}).strict().refine((ref) => ref.messageId !== undefined || ref.messageSeq !== undefined || ref.attachmentId !== undefined, "Name a source message or attachment");
const sourceRefs = z.array(contextSourceRefSchema).max(200);
const brief = z.object({ text: z.string().max(MAX_CONTEXT_NARRATIVE_BYTES), sourceRefs }).strict();
const decision = z.object({ text: z.string().min(1).max(8000), sourceRefs: sourceRefs.min(1) }).strict();
const message = z.object({ id, role: z.enum(["user", "assistant"]), text: z.string().max(MAX_CONTEXT_NARRATIVE_BYTES), sourceRef: contextSourceRefSchema.refine((ref) => ref.messageId !== undefined || ref.messageSeq !== undefined, "A transcript message needs a message source reference") }).strict();
const omitted = z.object({ messageIds: z.array(id).max(5000), attachmentIds: z.array(id).max(5000) }).strict();
export const contextNarrativeSchema = z.object({ brief, decisions: z.array(decision).max(100), messages: z.array(message).max(200), omitted }).strict().superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify({ brief: value.brief, decisions: value.decisions, messages: value.messages, omitted: value.omitted })).byteLength > MAX_CONTEXT_NARRATIVE_BYTES) ctx.addIssue({ code: "custom", message: "Context narrative exceeds 64 KiB of UTF8 JSON" });
  if (new Set(value.messages.map((item) => item.id)).size !== value.messages.length) ctx.addIssue({ code: "custom", message: "Context message IDs must be unique and retain caller order" });
  for (const list of [value.omitted.messageIds, value.omitted.attachmentIds]) if (new Set(list).size !== list.length) ctx.addIssue({ code: "custom", message: "Omission IDs must be unique" });
  if (value.messages.some((item) => value.omitted.messageIds.includes(item.id))) ctx.addIssue({ code: "custom", message: "A message cannot be both included and omitted" });
});
const repository = z.discriminatedUnion("verification", [
  z.object({ verification: z.literal("verified"), rootPath: z.string().min(1).max(4000), remoteUrl: projectRemoteSchema.nullable(), branch: z.string().max(500).nullable(), commit: z.string().regex(/^[a-fA-F0-9]{40,64}$/).nullable(), dirty: z.boolean(), observedAt: z.number().finite() }).strict(),
  z.object({ verification: z.literal("unknown"), reason: z.string().min(1).max(500) }).strict(),
]);
export const portableContextBundleSchema = z.object({
  schema: z.literal("navaigate.portable-context"), version: z.literal(PORTABLE_CONTEXT_VERSION), createdAt: z.number().finite(),
  narrative: contextNarrativeSchema.safeExtend({ provenance: z.literal("caller-supplied") }),
  source: z.object({ owner: z.object({ serverId: id, machineKey: z.string().min(1).max(40), hostId: id, environmentId: id, projectId: id, threadId: id.optional() }).strict(), workspace: z.discriminatedUnion("verification", [z.object({ verification: z.literal("verified"), path: z.string().min(1).max(4000) }).strict(), z.object({ verification: z.literal("unknown"), reason: z.string().min(1).max(500) }).strict()]), repository }).strict(),
  files: z.array(z.object({ path: relativePath, name: z.string().min(1).max(240).refine((value) => !/[\\/\0]/.test(value)), mimeType: z.string().min(1).max(200), sizeBytes: z.number().int().min(0).max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentBase64: z.string().max(Math.ceil(8 * 1024 * 1024 / 3) * 4) }).strict()).max(20),
}).strict().superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_CONTEXT_BUNDLE_BYTES) ctx.addIssue({ code: "custom", message: "Portable context bundle exceeds 12 MiB" });
  if (value.files.reduce((sum, file) => sum + file.sizeBytes, 0) > 8 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Portable file bytes exceed 8 MiB" });
  if (new Set(value.files.map((file) => file.path)).size !== value.files.length) ctx.addIssue({ code: "custom", message: "Selected source file paths must be unique" });
});
export type PortableContextBundle = z.infer<typeof portableContextBundleSchema>;
export const contextExportSelectionSchema = contextNarrativeSchema.safeExtend({ selectedFiles: z.array(z.object({ path: relativePath, mimeType: z.string().min(1).max(200).optional() }).strict()).max(20) }).strict();

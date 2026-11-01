import path from "node:path";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { ownerProjectContract } from "./project-contract";
import { transferPathAllowed } from "./project";
import { contextExportSelectionSchema, portableContextBundleSchema, type PortableContextBundle } from "./context-bundle-contract";
import type { OwnerWorkspaceTarget } from "./workspace-contract";
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
export function decodePortableContextBundle(raw: unknown) {
  const bundle = portableContextBundleSchema.parse(raw);
  const files = bundle.files.map((file) => {
    if (!transferPathAllowed(file.path) || !transferPathAllowed(file.name)) throw new Error("Portable context cannot include credential or private runtime paths");
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (bytes.toString("base64") !== file.contentBase64 || bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256) throw new Error("Portable context file bytes, size or SHA256 do not match");
    return { ...file, bytes };
  });
  if (files.reduce((sum, file) => sum + file.bytes.length, 0) > 8 * 1024 * 1024) throw new Error("Portable file bytes exceed 8 MiB");
  return { bundle, files };
}
export function portableContextManifest(bundle: PortableContextBundle) {
  return {
    schema: bundle.schema, version: bundle.version, createdAt: bundle.createdAt,
    narrative: bundle.narrative, source: bundle.source,
    sourceVerificationAtDestination: "exporter-asserted-not-reverified" as const,
    selectedFiles: bundle.files.map(({ contentBase64: _bytes, ...file }) => file),
  };
}
export async function exportPortableContextBundle(bb: BbPluginApi, args: {
  target: OwnerWorkspaceTarget; rootPath: string; selection: z.infer<typeof contextExportSelectionSchema>;
  readFile(relative: string): Promise<{ bytes: Uint8Array; sha256: string; sizeBytes: number; mimeType: string | null }>;
}): Promise<PortableContextBundle> {
  const selection = contextExportSelectionSchema.parse(args.selection);
  if (new Set(selection.selectedFiles.map((file) => file.path)).size !== selection.selectedFiles.length) throw new Error("Select each source file once");
  for (const file of selection.selectedFiles) if (!transferPathAllowed(file.path)) throw new Error("Portable context cannot include credential or private runtime paths");
  let repository: PortableContextBundle["source"]["repository"] = { verification: "unknown", reason: "Native owner repository verification is unavailable" };
  try {
    const { serverId, machineKey, hostId, environmentId, projectId } = args.target;
    const result = await bb.sdk.plugins.callRpc({ pluginId: "fleet", method: "project_verify", input: { target: { serverId, machineKey, hostId, environmentId, projectId }, expected: {} }, outputSchema: ownerProjectContract.project_verify.output });
    if (result.available && result.verified && result.repository && result.repository.rootPath === args.rootPath && (["serverId", "machineKey", "hostId", "projectId", "environmentId"] as const).every((key) => result.owner[key] === args.target[key])) repository = { verification: "verified", ...result.repository, observedAt: result.observedAt };
  } catch { /* The bundle retains an explicit unknown instead of guessing source state. */ }
  const files: PortableContextBundle["files"] = [];
  let size = 0;
  for (const selected of selection.selectedFiles) {
    const file = await args.readFile(selected.path);
    size += file.sizeBytes;
    if (size > 8 * 1024 * 1024) throw new Error("Portable file bytes exceed 8 MiB");
    if (file.bytes.length !== file.sizeBytes || hash(file.bytes) !== file.sha256) throw new Error("Selected source file failed byte verification");
    files.push({ path: selected.path, name: path.basename(selected.path), mimeType: file.mimeType ?? selected.mimeType ?? "application/octet-stream", sizeBytes: file.sizeBytes, sha256: file.sha256, contentBase64: Buffer.from(file.bytes).toString("base64") });
  }
  const { selectedFiles: _selection, ...narrative } = selection;
  return portableContextBundleSchema.parse({ schema: "navaigate.portable-context", version: 1, createdAt: Date.now(), narrative: { ...narrative, provenance: "caller-supplied" }, source: { owner: args.target, workspace: { verification: "verified", path: args.rootPath }, repository }, files });
}

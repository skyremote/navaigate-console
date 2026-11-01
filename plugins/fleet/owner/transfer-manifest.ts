// Source side of F29: build an explicit manifest of selected files (often
// git-ignored ones, such as a config template) from a checkout on this Mac.
// Every path must be relative, resolve inside the root without symlinks, be a
// regular file of at most 1 MiB and pass the owner's secret, key and
// credential path policy; 8 MiB in total. Nothing is sent from here.
// listTransferCandidates shows the checkout's git-ignored entries so the user
// can select them, with the reason any of them cannot be copied.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { transferPathAllowed } from "./project";
import { TRANSFER_FILE_BYTES, TRANSFER_TOTAL_BYTES, transferPathSchema } from "./project-contract";

export interface TransferManifest {
  root: string;
  files: { path: string; sizeBytes: number; sha256: string; contentBase64: string }[];
  refused: { path: string; reason: string }[];
  totalBytes: number;
}

export const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/;
export const TRANSFER_CANDIDATE_LIMIT = 500;
const PROTECTED_REASON = "Secrets, keys, credentials and .env files are never copied; set them on the destination Mac";

export function buildTransferManifest(root: string, paths: string[]): TransferManifest {
  const realRoot = realpathSync(root);
  const files: TransferManifest["files"] = [];
  const refused: TransferManifest["refused"] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const path of paths) {
    if (!transferPathSchema.safeParse(path).success) { refused.push({ path, reason: "Use a relative path without traversal" }); continue; }
    if (!transferPathAllowed(path)) { refused.push({ path, reason: PROTECTED_REASON }); continue; }
    const key = path.toLowerCase();
    if (seen.has(key)) { refused.push({ path, reason: "Already selected (paths are compared without case)" }); continue; }
    const conflict = [...seen].find((other) => other.startsWith(key + "/") || key.startsWith(other + "/"));
    if (conflict) { refused.push({ path, reason: `Conflicts with the selected path ${conflict}: a file cannot also be a directory` }); continue; }
    const full = resolve(realRoot, path);
    if (!full.startsWith(realRoot + sep) || relative(realRoot, full) !== path) { refused.push({ path, reason: "Path is outside the checkout" }); continue; }
    let stat;
    try { stat = lstatSync(full); } catch { refused.push({ path, reason: "No such file" }); continue; }
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(full) !== full) { refused.push({ path, reason: "Only regular files (no symlinks) can be transferred" }); continue; }
    if (stat.size > TRANSFER_FILE_BYTES) { refused.push({ path, reason: "Larger than 1 MiB" }); continue; }
    if (total + stat.size > TRANSFER_TOTAL_BYTES) { refused.push({ path, reason: "The manifest would exceed 8 MiB" }); continue; }
    const bytes = readFileSync(full);
    // The file can change between lstat and read; the caps apply to the bytes actually read.
    if (bytes.length > TRANSFER_FILE_BYTES) { refused.push({ path, reason: "Larger than 1 MiB" }); continue; }
    if (total + bytes.length > TRANSFER_TOTAL_BYTES) { refused.push({ path, reason: "The manifest would exceed 8 MiB" }); continue; }
    if (PRIVATE_KEY_PATTERN.test(bytes.toString("utf8"))) { refused.push({ path, reason: "Contains private key material; set it on the destination Mac" }); continue; }
    seen.add(key);
    total += bytes.length;
    files.push({ path, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64") });
  }
  return { root: realRoot, files, refused, totalBytes: total };
}

export interface TransferCandidate { path: string; kind: "file" | "directory" | "other"; sizeBytes: number | null; selectable: boolean; reason: string | null }
export interface TransferCandidates { root: string; candidates: TransferCandidate[]; truncated: boolean }

function gitIgnoredEntries(root: string): Promise<string[]> {
  // Same hygiene as the owner's Git reads: no inherited GIT_*/BB_* state, no
  // optional locks. "matching" ignored mode collapses a directory ignored by a
  // directory pattern (such as node_modules/) to one entry, yet lists each
  // ignored file individually, including inside directories that hold only
  // ignored files (which "traditional" mode and `ls-files --directory` hide).
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_") && !key.startsWith("BB_"))) as Record<string, string>;
  return new Promise((resolveEntries, reject) => execFile("git", ["--no-optional-locks", "-C", root, "status", "--porcelain=v1", "--ignored=matching", "--untracked-files=normal", "-z"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout) => {
    if (error) { reject(new Error("Git could not list ignored files in this checkout")); return; }
    const tokens = String(stdout).split("\0");
    const ignored: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.startsWith("!! ")) ignored.push(token.slice(3));
      else if (/^[RC]/.test(token)) index++; // a rename/copy record carries its source path as the next token
    }
    resolveEntries(ignored);
  }));
}

/** Lists git-ignored entries in a checkout so the user can pick which to copy. Reads metadata only. */
export async function listTransferCandidates(root: string, limit = TRANSFER_CANDIDATE_LIMIT): Promise<TransferCandidates> {
  const realRoot = realpathSync(root);
  const entries = (await gitIgnoredEntries(realRoot)).sort((a, b) => a.localeCompare(b));
  const candidates: TransferCandidate[] = [];
  for (const entry of entries.slice(0, limit)) {
    const directory = entry.endsWith("/");
    const path = directory ? entry.slice(0, -1) : entry;
    if (directory) { candidates.push({ path, kind: "directory", sizeBytes: null, selectable: false, reason: "Ignored directory: name the files inside it individually" }); continue; }
    if (!transferPathSchema.safeParse(path).success) { candidates.push({ path, kind: "other", sizeBytes: null, selectable: false, reason: "Unsupported path" }); continue; }
    if (!transferPathAllowed(path)) { candidates.push({ path, kind: "file", sizeBytes: null, selectable: false, reason: PROTECTED_REASON }); continue; }
    let stat;
    try { stat = lstatSync(resolve(realRoot, path)); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) { candidates.push({ path, kind: "other", sizeBytes: null, selectable: false, reason: "Only regular files (no symlinks) can be transferred" }); continue; }
    if (stat.size > TRANSFER_FILE_BYTES) { candidates.push({ path, kind: "file", sizeBytes: stat.size, selectable: false, reason: "Larger than 1 MiB" }); continue; }
    candidates.push({ path, kind: "file", sizeBytes: stat.size, selectable: true, reason: null });
  }
  return { root: realRoot, candidates, truncated: entries.length > limit };
}

export const transferRpcContract = defineRpcContract({
  transfer_candidates: {
    input: z.object({ projectId: z.string().min(1).max(250) }).strict(),
    output: z.object({ root: z.string(), candidates: z.array(z.object({ path: z.string(), kind: z.enum(["file", "directory", "other"]), sizeBytes: z.number().nullable(), selectable: z.boolean(), reason: z.string().nullable() })), truncated: z.boolean() }),
  },
  transfer_manifest_build: {
    input: z.object({ projectId: z.string().min(1).max(250), paths: z.array(z.string().min(1).max(1000)).min(1).max(100) }).strict(),
    output: z.object({ root: z.string(), files: z.array(z.object({ path: z.string(), sizeBytes: z.number(), sha256: z.string(), contentBase64: z.string() })), refused: z.array(z.object({ path: z.string(), reason: z.string() })), totalBytes: z.number() }),
  },
  owner_thread_target: {
    input: z.object({ machine: z.string().min(1).max(40), threadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/) }).strict(),
    output: z.object({ serverId: z.string(), machineKey: z.string().min(1).max(40), hostId: z.string(), environmentId: z.string(), projectId: z.string(), threadId: z.string() }),
  },
});

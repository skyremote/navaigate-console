export const PROOF_BRANCH = "delivery-proof";
export const PROOF_MAX_FILES = 6;
export const PROOF_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const PROOF_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PROOF_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.webm";
export type ProofMedia = { mime: string; inline: boolean; sniff: (head: Uint8Array) => boolean };
const starts = (head: Uint8Array, bytes: number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const MEDIA: Record<string, ProofMedia> = {
  ".png": { mime: "image/png", inline: true, sniff: (h) => starts(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  ".jpg": { mime: "image/jpeg", inline: true, sniff: (h) => starts(h, [0xff, 0xd8, 0xff]) },
  ".jpeg": { mime: "image/jpeg", inline: true, sniff: (h) => starts(h, [0xff, 0xd8, 0xff]) },
  ".gif": { mime: "image/gif", inline: true, sniff: (h) => starts(h, ascii("GIF87a")) || starts(h, ascii("GIF89a")) },
  ".webp": { mime: "image/webp", inline: true, sniff: (h) => starts(h, ascii("RIFF")) && starts(h, ascii("WEBP"), 8) },
  ".mp4": { mime: "video/mp4", inline: false, sniff: (h) => starts(h, ascii("ftyp"), 4) },
  ".mov": {
    mime: "video/quicktime",
    inline: false,
    sniff: (h) => ["ftyp", "moov", "wide", "mdat"].some((tag) => starts(h, ascii(tag), 4)),
  },
  ".webm": { mime: "video/webm", inline: false, sniff: (h) => starts(h, [0x1a, 0x45, 0xdf, 0xa3]) },
};
export function proofExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}
export function proofMedia(name: string): ProofMedia | null {
  return MEDIA[proofExtension(name)] ?? null;
}
export function proofName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return clean || `proof${proofExtension(base)}`;
}
export const PROOF_BRANCH_MESSAGE = `The proof branch must be a dedicated branch named ${PROOF_BRANCH} or starting with ${PROOF_BRANCH}/ or ${PROOF_BRANCH}-.`;
export function validProofBranch(branch: string): boolean {
  return (
    (branch === PROOF_BRANCH || branch.startsWith(`${PROOF_BRANCH}/`) || branch.startsWith(`${PROOF_BRANCH}-`)) &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !/\.lock(\/|$)/.test(branch)
  );
}
export function proofBranchConflict(
  branch: string,
  refs: { defaultBranch?: string | null; headRef?: string | null; baseRef?: string | null },
): string | null {
  if (branch === refs.defaultBranch) return `${branch} is the default branch; proof is never stored on it.`;
  if (branch === refs.headRef) return `${branch} is the head branch of this pull request; proof is never stored in the code under review.`;
  if (branch === refs.baseRef) return `${branch} is the base branch of this pull request; proof is never stored on it.`;
  return null;
}
export function parseGithubPr(url: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(url);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}
export type ProofCommentFile = { name: string; url: string; inline: boolean; bytes: number; sha256: string };
export function proofCommentBody(
  files: ProofCommentFile[],
  note: string,
  branch: string,
  commit: string,
  policy: string,
): string {
  const lines = ["<!-- delivery-proof -->", "### Delivery proof"];
  if (note.trim()) lines.push("", note.trim());
  for (const item of files) lines.push("", `${item.inline ? "!" : ""}[${item.name}](${item.url})`);
  lines.push("", "| File | Bytes | SHA-256 |", "| --- | --- | --- |");
  for (const item of files) lines.push(`| ${item.name} | ${item.bytes} | \`${item.sha256}\` |`);
  lines.push("", `Stored on branch \`${branch}\` at commit \`${commit}\`. ${policy}`);
  return lines.join("\n");
}
export function proofPolicy(repo: string, isPrivate: boolean): string {
  return isPrivate
    ? `Private repository: visible only to people with read access to ${repo}.`
    : "Public repository: anyone can view this media.";
}
export function proofUrl(repo: string, commit: string, path: string): string {
  return `https://github.com/${repo}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}?raw=true`;
}
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

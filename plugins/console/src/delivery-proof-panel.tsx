import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { deliveryRpcContract, type PullRequest, type proofReceiptSchema } from "../delivery-contract";
import {
  PROOF_ACCEPT,
  PROOF_BRANCH,
  PROOF_BRANCH_MESSAGE,
  PROOF_MAX_FILES,
  PROOF_MAX_FILE_BYTES,
  PROOF_MAX_TOTAL_BYTES,
  parseGithubPr,
  proofBranchConflict,
  proofCommentBody,
  proofMedia,
  proofName,
  validProofBranch,
} from "./delivery-proof";
import { outlineButton, field, fieldArea } from "./controls";
const button = outlineButton;
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
type Receipt = z.infer<typeof proofReceiptSchema>;
type Picked = {
  key: string;
  name: string;
  bytes: number;
  mime: string;
  inline: boolean;
  sha256: string;
  dataBase64: string;
  preview: string | null;
};
export const megabytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}
function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}
async function digest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return "";
  const hash = new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function pick(file: File): Promise<Picked> {
  const media = proofMedia(file.name);
  if (!media) throw new Error(`${file.name} is not a screenshot or video the PR can show (png, jpg, gif, webp, mp4, mov, webm).`);
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  if (file.size > PROOF_MAX_FILE_BYTES)
    throw new Error(`${file.name} is ${megabytes(file.size)}; each file can be up to ${megabytes(PROOF_MAX_FILE_BYTES)}. Use the delivery-proof skill for larger videos.`);
  const bytes = await readBytes(file);
  if (!media.sniff(bytes.subarray(0, 16))) throw new Error(`${file.name} does not look like ${media.mime} data.`);
  const canPreview = media.inline && typeof URL.createObjectURL === "function";
  return {
    key: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`,
    name: proofName(file.name),
    bytes: bytes.length,
    mime: media.mime,
    inline: media.inline,
    sha256: await digest(bytes),
    dataBase64: toBase64(bytes),
    preview: canPreview ? URL.createObjectURL(file) : null,
  };
}
export function ProofAttach({
  environmentId,
  pr,
  onAttached,
}: {
  environmentId: string;
  pr: PullRequest;
  onAttached?: (receipt: Receipt) => void | Promise<void>;
}) {
  const rpc = useRpc<typeof deliveryRpcContract>();
  const [files, setFiles] = useState<Picked[]>([]),
    [problems, setProblems] = useState<string[]>([]),
    [note, setNote] = useState(""),
    [branch, setBranch] = useState(PROOF_BRANCH),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [receipt, setReceipt] = useState<Receipt | null>(null);
  const previews = useRef<string[]>([]);
  useEffect(() => {
    previews.current = files.flatMap((file) => (file.preview ? [file.preview] : []));
  }, [files]);
  useEffect(
    () => () => {
      for (const url of previews.current) if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
    },
    [],
  );
  const target = parseGithubPr(pr.url);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const branchProblem = !validProofBranch(branch)
    ? PROOF_BRANCH_MESSAGE
    : proofBranchConflict(branch, { headRef: pr.headRefName, baseRef: pr.baseRefName });
  const branchOk = !branchProblem;
  const tooMany = files.length > PROOF_MAX_FILES;
  const tooBig = total > PROOF_MAX_TOTAL_BYTES;
  const ready = !!target && files.length > 0 && !tooMany && !tooBig && branchOk && confirmed && !busy;
  const choose = async (list: FileList | null) => {
    if (!list?.length) return;
    const next: Picked[] = [];
    const bad: string[] = [];
    for (const file of Array.from(list)) {
      try {
        next.push(await pick(file));
      } catch (cause) {
        bad.push(errorText(cause));
      }
    }
    setProblems(bad);
    setReceipt(null);
    setFiles((current) => [...current, ...next]);
  };
  const release = (list: Picked[]) => {
    if (typeof URL.revokeObjectURL !== "function") return;
    for (const file of list) if (file.preview) URL.revokeObjectURL(file.preview);
  };
  const remove = (key: string) => {
    release(files.filter((file) => file.key === key));
    setFiles((current) => current.filter((file) => file.key !== key));
  };
  const preview = target
    ? proofCommentBody(
        files.map((file) => ({ ...file, url: "(link added after upload)" })),
        note,
        branch,
        "(commit added after upload)",
        "Access follows the repository.",
      )
    : "";
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("delivery_attach_proof", {
        environmentId,
        intent: "explicit-user-action",
        confirmRedacted: true,
        expectedUrl: pr.url,
        expectedUpdatedAt: pr.updatedAt,
        note: note.trim(),
        branch,
        files: files.map((file) => ({ name: file.name, dataBase64: file.dataBase64 })),
      });
      setReceipt(result);
      release(files);
      setFiles([]);
      setConfirmed(false);
      setNote("");
      await onAttached?.(result);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-border p-4 space-y-3" role="group" aria-label="Attach proof to PR">
      <div>
        <h3 className="font-medium">Attach proof to #{pr.number}</h3>
        <p className="text-xs text-muted-foreground">
          Screenshots and short videos are stored on the {branch} branch of {target?.repo ?? "this repository"} and
          posted as one comment on the pull request. Images show inline; a video is a link. Access follows the
          repository.
        </p>
      </div>
      {receipt && (
        <div className="rounded-lg border border-border p-4 space-y-2" role="status" aria-label="Proof receipt">
          <p className="font-medium">
            {receipt.comment ? `Proof attached to #${receipt.pr}` : `Proof stored for #${receipt.pr}; the comment did not post`}
          </p>
          {receipt.comment && (
            <p className="text-[13px]">
              <a className="underline" href={receipt.comment.url} target="_blank" rel="noreferrer">
                Open the comment on GitHub
              </a>
              {receipt.comment.verified ? " (re-read and confirmed)" : " (could not be confirmed on re-read)"}
            </p>
          )}
          <ul className="text-[13px] space-y-1">
            {receipt.files.map((file) => (
              <li key={file.path} className="break-all">
                <a className="underline" href={file.url} target="_blank" rel="noreferrer">
                  {file.name}
                </a>{" "}
                <span className="text-xs text-muted-foreground">
                  {megabytes(file.bytes)} {file.verified ? "stored and verified" : "stored, not verified"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground break-all">
            Commit {receipt.commit.slice(0, 12)} on {receipt.branch}. {receipt.accessPolicy} {receipt.expiry}
          </p>
          {receipt.error && <p role="alert" className="text-[13px]">{receipt.error}</p>}
        </div>
      )}
      <label className="block text-[13px]">
        <span className="block font-medium">Screenshots or videos</span>
        <input
          type="file"
          multiple
          accept={PROOF_ACCEPT}
          aria-label="Choose proof files"
          className="mt-1 block w-full text-[13px]"
          disabled={busy}
          onChange={(event) => {
            const input = event.currentTarget;
            void choose(input.files).finally(() => {
              input.value = "";
            });
          }}
        />
      </label>
      {problems.map((problem) => (
        <p key={problem} role="alert" className="text-[13px]">
          {problem}
        </p>
      ))}
      {files.length > 0 && (
        <ul className="space-y-2" aria-label="Files to attach">
          {files.map((file) => (
            <li key={file.key} className="flex items-center gap-3 rounded-md border border-border p-3">
              {file.preview ? (
                <img src={file.preview} alt="" className="h-12 w-16 shrink-0 rounded object-cover" />
              ) : (
                <span aria-hidden className="grid h-12 w-16 shrink-0 place-items-center rounded-lg border border-border text-xs">
                  {file.inline ? "IMG" : "VIDEO"}
                </span>
              )}
              <span className="min-w-0 flex-1 text-[13px]">
                <span className="block truncate font-medium">{file.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {megabytes(file.bytes)} · {file.mime}
                  {file.sha256 ? ` · sha256 ${file.sha256.slice(0, 12)}` : ""}
                </span>
              </span>
              <button type="button" className={button} onClick={() => remove(file.key)} aria-label={`Remove ${file.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {tooMany && <p role="alert" className="text-[13px]">Attach at most {PROOF_MAX_FILES} files at a time.</p>}
      {tooBig && (
        <p role="alert" className="text-[13px]">
          These files add up to {megabytes(total)}; the limit is {megabytes(PROOF_MAX_TOTAL_BYTES)} at once.
        </p>
      )}
      <label className="block text-[13px]">
        <span className="block font-medium">Note above the media (optional)</span>
        <textarea
          className={`${fieldArea} mt-1 w-full`}
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What this shows, for example: fix verified on the release build"
        />
      </label>
      <label className="block text-[13px]">
        <span className="block font-medium">Proof branch</span>
        <input
          className={`${field} mt-1 w-full`}
          value={branch}
          onChange={(event) => setBranch(event.target.value.trim())}
          aria-invalid={!branchOk}
        />
        {branchProblem && <span role="alert" className="block text-xs">{branchProblem}</span>}
      </label>
      {files.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[13px]">Comment that will be posted</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-xs">{preview}</pre>
        </details>
      )}
      <label className="flex items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>I have looked at these files and covered anything private: addresses, credentials, customer data.</span>
      </label>
      {error && <p role="alert" className="text-[13px]">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={!ready} onClick={() => void send()}>
          {busy ? "Uploading…" : `Upload and comment on #${pr.number}`}
        </button>
      </div>
    </div>
  );
}

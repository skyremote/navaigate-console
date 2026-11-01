import { useEffect, useRef, useState } from "react";
import { experimental_FileLink as FileLink, useRpc } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { MAX_OWNER_FILE_BYTES, ownerPathSchema, ownerWorkspaceContract, type OwnerPendingInteraction, type OwnerWorkspaceReceipt, type OwnerWorkspaceTarget } from "../owner/workspace-contract";

export interface OwnerWorkspacePanelProps {
  target: OwnerWorkspaceTarget;
  localServerId: string;
  localMachineKey: string;
  ownerUrl: string | null;
  ownerThreadUrl?: string | null;
}
type Listing = z.infer<typeof ownerWorkspaceContract.owner_file_list.output>;
type Preview = z.infer<typeof ownerWorkspaceContract.owner_file_preview.output>;
type Read = z.infer<typeof ownerWorkspaceContract.owner_file_read.output>;
type Answer = { selected: string[]; freeText?: string };
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
async function sha256(bytes: Uint8Array) { return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)); }
function base64(bytes: Uint8Array) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
function safeUrl(value: string | null | undefined) {
  try { const url = new URL(value ?? ""); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url : null; } catch { return null; }
}
export function ownerFilePreviewUrl(ownerUrl: string | null, read: { path: string; preview: { baseUrl: string; expiresAtMs: number } | null }): string | null {
  const owner = safeUrl(ownerUrl);
  if (!owner || !read.preview || read.preview.expiresAtMs <= Date.now() || !/^\/api\/v1\/file-previews\/[A-Za-z0-9_-]+$/.test(read.preview.baseUrl) || !ownerPathSchema.safeParse(read.path).success || read.path === ".") return null;
  const preview = new URL(read.preview.baseUrl.endsWith("/") ? read.preview.baseUrl : read.preview.baseUrl + "/", owner);
  if (preview.origin !== owner.origin) return null;
  try { return preview.href + read.path.split("/").map(encodeURIComponent).join("/"); } catch { return null; }
}
export function OwnerMediaPreview({ file, ownerUrl, machineKey, onRefresh, busy = false }: { file: Preview; ownerUrl: string | null; machineKey: string; onRefresh(): void; busy?: boolean }) {
  const [now, setNow] = useState(Date.now);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false); setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, file.preview.expiresAtMs - Date.now() + 1)));
    return () => clearTimeout(timer);
  }, [file]);
  const url = now < file.preview.expiresAtMs ? ownerFilePreviewUrl(ownerUrl, file) : null;
  const mime = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
    <strong style={{ overflowWrap: "anywhere" }}>{file.path}</strong><small>{file.sizeBytes} bytes · {machineKey}</small>
    {url && !failed ? <>
      {mime.startsWith("video/") ? <video aria-label={`Preview ${file.path}`} src={url} controls playsInline preload="metadata" onError={() => setFailed(true)} style={{ maxWidth: "100%", maxHeight: "60vh" }} />
        : mime.startsWith("image/") ? <img alt={file.path} src={url} onError={() => setFailed(true)} style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }} />
        : mime.startsWith("audio/") ? <audio aria-label={`Preview ${file.path}`} src={url} controls preload="metadata" onError={() => setFailed(true)} style={{ maxWidth: "100%" }} /> : null}
      <a href={url} target="_blank" rel="noreferrer">Open file on {machineKey}</a>
    </> : <p>{file.preview.expiresAtMs <= Date.now() ? "The owner preview has expired." : "The owner preview is unavailable. Refresh it or open the owner thread."}</p>}
    {file.sizeBytes > MAX_OWNER_FILE_BYTES && <small>This file exceeds the 8 MiB editor and attachment transfer limit. Preview streams directly from its owner.</small>}
    <button disabled={busy} onClick={onRefresh}>Refresh owner preview</button>
  </div>;
}
export function ownerPendingReceiptId(requestId: string, target: OwnerWorkspaceTarget, result: OwnerWorkspaceReceipt, phase: "submission" | "reconciliation"): string | null {
  if (result.requestId !== requestId || (["serverId", "machineKey", "hostId", "environmentId", "projectId", "threadId"] as const).some((key) => result.owner[key] !== target[key])) return requestId;
  if (result.method !== "owner_file_write" && result.method !== "context_bundle_import" && result.method !== "interaction_respond") return requestId;
  if (result.outcome === "applied" || result.outcome === "refused") return null;
  return phase === "submission" && result.outcome === "unavailable" ? null : requestId;
}
export async function ownerReadPreservingDraft<T>(load: () => Promise<T>, editRevision: () => number): Promise<T | null> {
  const startedAtRevision = editRevision();
  const result = await load();
  return editRevision() === startedAtRevision ? result : null;
}
export async function ownerFileForDisplay(loadPreview: () => Promise<Preview>, loadRead: () => Promise<Read>): Promise<{ preview: Preview | null; read: Read | null }> {
  const preview = await loadPreview();
  if (/^(video|image|audio)\//i.test(preview.mimeType ?? "") || preview.sizeBytes > MAX_OWNER_FILE_BYTES) return { preview, read: null };
  return { preview: null, read: await loadRead() };
}
export function OwnerWorkspacePanel(props: OwnerWorkspacePanelProps) {
  return <OwnerWorkspaceBody key={JSON.stringify(props.target)} {...props} />;
}
function OwnerWorkspaceBody({ target, localServerId, localMachineKey, ownerUrl, ownerThreadUrl }: OwnerWorkspacePanelProps) {
  const rpc = useRpc<typeof ownerWorkspaceContract>();
  const isLocalOwner = target.serverId === localServerId && target.machineKey === localMachineKey;
  const receiptKey = `fleet-owner-pending-v1:${JSON.stringify(target)}`;
  const [pendingId, setPendingId] = useState<string | null>(() => { try { return localStorage.getItem(receiptKey); } catch { return null; } });
  const [receipt, setReceipt] = useState<OwnerWorkspaceReceipt | null>(null);
  const [directory, setDirectory] = useState(".");
  const [listing, setListing] = useState<Listing | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [media, setMedia] = useState<Preview | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const editRevision = useRef(0);
  const operationInFlight = useRef(false);
  const [questions, setQuestions] = useState<OwnerPendingInteraction[]>([]);
  const [answers, setAnswers] = useState<Record<string, Record<string, Answer>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  function showError(cause: unknown) { setError(cause instanceof Error ? cause.message : String(cause)); }
  async function list(path: string, after?: string) {
    try {
      const result = await rpc.call("owner_file_list", { target, path, limit: 100, ...(after ? { after } : {}) });
      setDirectory(path);
      setListing((previous) => after && previous?.path === path ? { ...result, entries: [...previous.entries, ...result.entries] } : result);
      setError(null);
    } catch (cause) { showError(cause); }
  }
  async function loadQuestions() {
    if (!target.threadId) return;
    try { const result = await rpc.call("interaction_list", { target }); setQuestions(result.interactions); setTruncated(result.truncated); }
    catch (cause) { showError(cause); }
  }
  function acceptReceipt(result: OwnerWorkspaceReceipt, requestId: string, phase: "submission" | "reconciliation") {
    setReceipt(result);
    if (ownerPendingReceiptId(requestId, target, result, phase) === null) {
      setPendingId(null);
      try { localStorage.removeItem(receiptKey); } catch { /* The server receipt remains authoritative. */ }
    }
  }
  async function reconcile(id: string) {
    setBusy(true);
    try { acceptReceipt(await rpc.call("owner_workspace_receipt", { target, requestId: id }), id, "reconciliation"); }
    catch (cause) { showError(cause); }
    finally { setBusy(false); }
  }
  useEffect(() => { void list("."); void loadQuestions(); if (pendingId) void reconcile(pendingId); }, []);
  async function mutation(action: (requestId: string) => Promise<OwnerWorkspaceReceipt>) {
    if (busy || pendingId || operationInFlight.current) return;
    operationInFlight.current = true;
    const requestId = crypto.randomUUID();
    setPendingId(requestId);
    try { localStorage.setItem(receiptKey, requestId); } catch { /* Mutations are still deduplicated durably by the owner. */ }
    setBusy(true); setError(null);
    try { const result = await action(requestId); acceptReceipt(result, requestId, "submission"); if (result.outcome === "applied") { await list(directory); await loadQuestions(); } }
    catch (cause) { showError(cause); setReceipt(null); }
    finally { operationInFlight.current = false; setBusy(false); }
  }
  async function openFile(relative: string) {
    if (dirty) { setError("Save the current edits before opening another file, or use Discard edits."); return; }
    setBusy(true);
    try {
      const result = await ownerReadPreservingDraft(() => ownerFileForDisplay(
        () => rpc.call("owner_file_preview", { target, path: relative }),
        () => rpc.call("owner_file_read", { target, path: relative, offset: 0, length: 256 * 1024, preview: !isLocalOwner }),
      ), () => editRevision.current);
      if (!result) { setError("The current file was edited while loading. Your edits were kept; save or discard them before opening another file."); return; }
      setMedia(result.preview); setRead(result.read); setDirty(false);
      if (!result.read) { setText(null); setError(null); return; }
      const bytes = Uint8Array.from(atob(result.read.contentBase64), (char) => char.charCodeAt(0));
      try { setText(result.read.nextOffset === null && !bytes.includes(0) ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null); }
      catch { setText(null); }
      setError(null);
    } catch (cause) { showError(cause); }
    finally { setBusy(false); }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || busy || pendingId) return;
    if (files.length > 20 || Array.from(files).reduce((sum, file) => sum + file.size, 0) > MAX_OWNER_FILE_BYTES) { setError("Choose up to 20 files totalling at most 8 MiB."); return; }
    setBusy(true);
    try {
      const bundle = await Promise.all(Array.from(files).map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return { name: file.name, mimeType: file.type || "application/octet-stream", contentBase64: base64(bytes), sha256: await sha256(bytes) };
      }));
      setBusy(false);
      await mutation((requestId) => rpc.call("context_bundle_import", { target, requestId, files: bundle, context: null }));
    } catch (cause) { setBusy(false); showError(cause); }
  }
  const link = read ? ownerFilePreviewUrl(ownerUrl, read) : null;
  const threadLink = safeUrl(ownerThreadUrl);
  const selectedOwnerUrl = safeUrl(ownerUrl);
  const validThreadLink = threadLink && selectedOwnerUrl && threadLink.origin === selectedOwnerUrl.origin ? threadLink.href : null;
  return <section aria-label="Owner workspace" style={{ padding: 16, display: "grid", gap: 12 }}>
    <div><strong>{target.machineKey} owner workspace</strong><div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{target.serverId} · {target.hostId} · {target.environmentId}</div></div>
    {validThreadLink && <a href={validThreadLink} target="_blank" rel="noreferrer">Open owner thread for its native files and terminal</a>}
    {error && <p role="alert">{error}</p>}
    {pendingId && <div role="status">Request {pendingId} needs an owner receipt. Further changes are paused. <button disabled={busy} onClick={() => void reconcile(pendingId)}>Check owner receipt</button></div>}
    {receipt && <details open={receipt.outcome !== "applied"}><summary>{receipt.outcome} · {receipt.method}</summary>{receipt.message && <p>{receipt.message}</p>}<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(receipt.result, null, 2)}</pre></details>}
    <form onSubmit={(event) => { event.preventDefault(); const value = new FormData(event.currentTarget).get("directory"); if (typeof value === "string") void list(value); }}>
      <label>Environment-relative folder <input name="directory" key={directory} defaultValue={directory} /></label> <button disabled={busy}>Browse</button>
    </form>
    <ul style={{ maxHeight: 260, overflow: "auto" }}>
      {listing?.entries.map((entry) => <li key={entry.path}><button disabled={busy} onClick={() => void (entry.kind === "directory" ? list(entry.path) : openFile(entry.path))}>{entry.name}{entry.kind === "directory" ? "/" : ""}</button></li>)}
    </ul>
    {listing?.nextAfter && <button disabled={busy} onClick={() => void list(directory, listing.nextAfter!)}>Load more files</button>}
    {media && <div><OwnerMediaPreview file={media} ownerUrl={ownerUrl} machineKey={target.machineKey} busy={busy} onRefresh={() => void openFile(media.path)} />{isLocalOwner && <FileLink target={{ kind: "workspace", environmentId: target.environmentId, path: media.path }}>Open native file</FileLink>}</div>}
    {read && <div style={{ display: "grid", gap: 8 }}>
      <strong>{read.path}</strong><small>{read.sizeBytes} bytes · SHA256 {read.sha256}</small>
      {isLocalOwner ? <FileLink target={{ kind: "workspace", environmentId: target.environmentId, path: read.path }}>Open native file</FileLink> : link && <a href={link} target="_blank" rel="noreferrer">Preview bytes on {target.machineKey}</a>}
      {read.nextOffset !== null && <p>The file exceeds the 256 KiB editor limit. Open the owner file to read it in full.</p>}
      {text !== null && <><textarea aria-label={`Edit ${read.path}`} value={text} rows={12} onChange={(event) => { editRevision.current++; setText(event.target.value); setDirty(true); }} style={{ width: "100%", fontFamily: "monospace" }} />
        <div><button disabled={busy || !!pendingId || !dirty} onClick={() => { const snapshot = text; const original = read; const revision = editRevision.current; void mutation(async (requestId) => { const bytes = new TextEncoder().encode(snapshot); const result = await rpc.call("owner_file_write", { target, requestId, path: original.path, contentBase64: base64(bytes), sha256: await sha256(bytes), expectedSha256: original.sha256 }); if (result.outcome === "applied") { if (editRevision.current === revision) { setRead(null); setText(null); setDirty(false); } else { setRead({ ...original, sha256: await sha256(bytes), sizeBytes: bytes.length }); } } return result; }); }}>Save if unchanged</button> <button disabled={busy} onClick={() => { setDirty(false); setRead(null); setText(null); }}>Discard edits</button></div></>}
    </div>}
    <label>Copy attachments to this owner (8 MiB total) <input type="file" multiple disabled={busy || !!pendingId} onChange={(event) => { void upload(event.target.files); event.target.value = ""; }} /></label>
    {target.threadId && <div><button disabled={busy} onClick={() => void loadQuestions()}>Refresh native questions</button>{truncated && <p>Some pending interactions exceed the bounded preview. Open the owner thread.</p>}
      {questions.map((item) => <Question key={`${item.id}:${item.fingerprint}`} item={item} answers={answers[`${item.id}:${item.fingerprint}`] ?? {}} disabled={busy || !!pendingId} onChange={(value) => setAnswers((current) => ({ ...current, [`${item.id}:${item.fingerprint}`]: value }))} onSubmit={(response) => void mutation((requestId) => rpc.call("interaction_respond", { target, requestId, interactionId: item.id, expectedFingerprint: item.fingerprint, response }))} />)}
    </div>}
  </section>;
}
const questionPayload = z.object({ kind: z.literal("user_question"), questions: z.array(z.object({ id: z.string(), prompt: z.string(), multiSelect: z.boolean(), allowFreeText: z.boolean(), options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).optional() })).max(30) });
type Response = z.infer<typeof ownerWorkspaceContract.interaction_respond.input>["response"];
function Question({ item, answers, disabled, onChange, onSubmit }: { item: OwnerPendingInteraction; answers: Record<string, Answer>; disabled: boolean; onChange(value: Record<string, Answer>): void; onSubmit(value: Response): void }) {
  const parsed = questionPayload.safeParse(item.payload);
  if (!parsed.success) return <p>{item.kind} interaction: open the owner thread to respond with its native controls.</p>;
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit({ kind: "user_answer", answers: Object.fromEntries(parsed.data.questions.map((question) => { const answer = answers[question.id] ?? { selected: [] }; return [question.id, { selected: answer.selected, ...(answer.freeText?.trim() ? { freeText: answer.freeText.trim() } : {}) }]; })) }); }}>
    {parsed.data.questions.map((question) => <fieldset key={question.id} disabled={disabled}><legend>{question.prompt}</legend>
      {question.options?.map((option) => <label key={option.value} style={{ display: "block" }}><input type={question.multiSelect ? "checkbox" : "radio"} name={`${item.id}:${question.id}`} checked={(answers[question.id]?.selected ?? []).includes(option.value)} onChange={(event) => { const old = answers[question.id] ?? { selected: [] }; onChange({ ...answers, [question.id]: { ...old, selected: question.multiSelect ? event.target.checked ? [...old.selected, option.value] : old.selected.filter((value) => value !== option.value) : [option.value] } }); }} />{option.label}{option.description && <small> · {option.description}</small>}</label>)}
      {question.allowFreeText && <textarea aria-label={question.prompt} maxLength={20_000} value={answers[question.id]?.freeText ?? ""} onChange={(event) => onChange({ ...answers, [question.id]: { selected: answers[question.id]?.selected ?? [], freeText: event.target.value } })} />}
    </fieldset>)}<button disabled={disabled}>Answer on owner</button>
  </form>;
}

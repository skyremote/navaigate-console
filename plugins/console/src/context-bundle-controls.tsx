import { useRef, useState } from "react";
import { useFeature } from "./use-feature";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { NativeContextPreview, NativeWorkReceipt } from "../server-native-work";
import type { PortableBundle } from "../server-context-bundle";
import { ghostButton, field } from "./controls";

const MAX_FILES = 20;
const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;
const button = ghostButton;
const explain = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const short = (commit: string) => commit.slice(0, 7);

export type ImportedBundle = { name: string; bundle: PortableBundle; summary: NativeContextPreview };

/** One project-relative path per line, at most 20, each once; the server applies the same rules. */
export function parseContextFilePaths(text: string): { ok: true; files: { path: string }[] } | { ok: false; error: string } {
  const paths = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (paths.length > MAX_FILES) return { ok: false, error: `Carry at most ${MAX_FILES} files.` };
  for (const path of paths) {
    if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) || path.length > 2000 || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
      return { ok: false, error: `"${path}" is not a project-relative file path. Use a path like docs/plan.md, without a leading slash or "..".` };
    }
  }
  if (new Set(paths).size !== paths.length) return { ok: false, error: "Choose each file once." };
  return { ok: true, files: paths.map((path) => ({ path })) };
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Counts({ decisions, messages, omittedMessages, omittedAttachments }: { decisions: number; messages: number; omittedMessages: number; omittedAttachments: number }) {
  return <>{plural(decisions, "decision")} · {plural(messages, "message")} · left out {plural(omittedMessages, "message")} and {plural(omittedAttachments, "attachment")}</>;
}

const CLAIMED = ", stated by the bundle and not checked by Fleet";
const commitLine = (commit: string | null, claimed: boolean) => (commit ? `Source commit ${short(commit)}${claimed ? CLAIMED : ""}` : "Source commit unknown");

export function ContextSummary({ summary, name, onRemove, replacesConversation = false }: { summary: NativeContextPreview; name?: string; onRemove?: () => void; replacesConversation?: boolean }) {
  return <div data-testid="context-summary" className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
    <div className="flex items-start justify-between gap-2">
      <p className="font-medium text-foreground">{name ? `${name}: ` : ""}context from {summary.sourceMachine}{summary.sourceThreadId ? `, ${summary.sourceThreadId}` : ""}</p>
      {onRemove ? <button type="button" className={button} onClick={onRemove}>Remove saved bundle</button> : null}
    </div>
    <p><Counts {...summary} /></p>
    <p>{commitLine(summary.commit, !!onRemove)}</p>
    {replacesConversation ? <p data-testid="context-replaces-note">Sending this bundle replaces this conversation's own context.</p> : null}
    {summary.decisionTexts.length ? <ul className="mt-1 list-disc pl-4">{summary.decisionTexts.map((text) => <li key={text} className="break-words">{text}</li>)}</ul> : null}
    {summary.files.length ? <ul className="mt-1">{summary.files.map((file) => <li key={file.path} className="break-all">{file.path} · {file.sizeBytes} B · sha256 {file.sha256.slice(0, 8)}</li>)}</ul> : null}
  </div>;
}

/** On the receipt: whether the bundle reached the new session, and what it carried. */
export function ContextArrival({ context, where }: { context: NonNullable<NativeWorkReceipt["context"]>; where: string }) {
  const headline = context.state === "delivered" ? `Context arrived on ${where}` : context.state === "failed" ? `Context did not arrive on ${where}` : `Context is being delivered to ${where}`;
  return <div data-testid="context-arrival" data-context-state={context.state} className="mt-1 text-muted-foreground">
    <p className="font-medium text-foreground">{headline}</p>
    <p><Counts {...context} /></p>
    <p>{commitLine(context.commit, context.commitClaimed === true)}</p>
    <p className="break-all">{context.manifestPath}{context.manifestSha256 ? ` · sha256 ${context.manifestSha256.slice(0, 8)}` : ""}</p>
    {context.files.length ? <ul>{context.files.map((file) => <li key={file.path} className="break-all">{file.path} · sha256 {file.sha256.slice(0, 8)}</li>)}</ul> : null}
  </div>;
}

export function ContextControls(props: Parameters<typeof ContextControlsBody>[0]) {
  return useFeature("S03") ? <ContextControlsBody {...props} /> : null;
}
function ContextControlsBody({ sourceThreadId, filesText, onFilesText, imported, onImported, disabled }: {
  sourceThreadId: string | undefined; filesText: string; onFilesText: (text: string) => void;
  imported: ImportedBundle | null; onImported: (value: ImportedBundle | null) => void; disabled?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<NativeContextPreview | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const exportBundle = async () => {
    if (!sourceThreadId) return;
    const files = parseContextFilePaths(filesText);
    if (!files.ok) { setError(files.error); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await rpc.call("native_context_export", { sourceThreadId, ...(files.files.length ? { structuredContext: { selectedFiles: files.files } } : {}) });
      download(out.filename, JSON.stringify(out.bundle, null, 2));
      setExported(out.summary);
    } catch (cause) { setError(`Could not export the context bundle: ${explain(cause)}`); }
    finally { setBusy(false); }
  };

  const importFile = async (file: File | undefined) => {
    if (picker.current) picker.current.value = "";
    if (!file) return;
    setError(null);
    if (file.size > MAX_BUNDLE_BYTES) { setError("That file is larger than 12 MiB, so it is not a context bundle."); return; }
    setBusy(true);
    try {
      let bundle: PortableBundle;
      try { bundle = JSON.parse(await readText(file)) as PortableBundle; }
      catch { setError(`${file.name} is not a context bundle: it is not valid JSON.`); return; }
      const summary = await rpc.call("native_context_inspect", { bundle });
      onImported({ name: file.name, bundle, summary });
      setExported(null);
    } catch (cause) { setError(`${file.name} was not attached: ${explain(cause)}`); }
    finally { setBusy(false); }
  };

  return <div className="flex flex-col gap-2" data-context-controls>
    {error ? <p role="alert" className="text-destructive-text">{error}</p> : null}
    {imported ? <ContextSummary summary={imported.summary} name={imported.name} onRemove={() => onImported(null)} replacesConversation={!!sourceThreadId} /> : <>
      {sourceThreadId ? <label className="flex flex-col gap-1">Files to carry
        <textarea className={`${field} h-14 font-mono`} value={filesText} disabled={disabled} placeholder={"README.md\ndocs/plan.md"} aria-label="Files to carry" onChange={(event) => onFilesText(event.target.value)} />
        <span className="text-muted-foreground">Optional. Project-relative paths, one per line, up to 20. Used with structured context and Download.</span>
      </label> : null}
      {exported ? <ContextSummary summary={exported} /> : null}
    </>}
    <div className="flex flex-wrap items-center gap-2">
      {sourceThreadId && !imported ? <button type="button" className={`${button} border border-border`} disabled={busy || disabled} onClick={() => void exportBundle()}>Download context bundle</button> : null}
      <label className={`${button} cursor-pointer border border-border`}>Use a saved context bundle
        <input ref={picker} type="file" accept="application/json,.json" className="sr-only" disabled={busy || disabled} aria-label="Use a saved context bundle" onChange={(event) => void importFile(event.target.files?.[0])} />
      </label>
    </div>
  </div>;
}

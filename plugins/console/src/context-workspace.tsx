import { NativeOfflineTextDrafts } from "./context-workspace-device-text";
import { registerAtLoad, useFeature } from "./use-feature";
import { NativeHistoryImport } from "./context-workspace-native-history";
import { useEffect, useRef, useState } from "react";
import {
  experimental_copyToClipboard,
  experimental_usePluginId,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposers,
  useRpc,
  useSdk,
  type PluginComposerApi,
  type PluginAppSetup,
  type ComposerDraftReplacement,
  type ComposerAttachment,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { contextWorkspaceContract } from "../server-context-workspace";
import {
  contextDraftSchema,
  droppedThread,
  parseNativeTranscript,
  quoteContext,
  sameDraft,
  MAX_FILE_BYTES,
  GUEST_REVIEW_EXPIRY_OPTIONS,
  type GuestReviewExpiryMinutes,
  type ContextSave,
  type ContextDraftSummary,
  type ImportedMessage,
} from "./context-workspace-model";
import {
  localDrafts,
  putLocalDraft,
  removeLocalDraft,
  type LocalContextDraft,
  nativeStorageFor,
  attachmentOwner,
} from "./context-workspace-offline";
import { captureDisplayFrame } from "./context-workspace-capture";
import { outlineButton, field, fieldArea } from "./controls";

const POPUP = "context-workspace";
const captureCommands = new Map<string, () => Promise<void>>();
const captureBusy = new Set<string>();
type Quote = { quote: string; source: string; role: "user" | "assistant" };
const quotes = new Map<string, Quote>();
const quoteListeners = new Set<(key: string) => void>();
function stageQuote(composer: PluginComposerApi, quote: Quote) {
  quotes.set(composer.key, quote);
  if (quotes.size > 200) quotes.delete(quotes.keys().next().value!);
  for (const listener of quoteListeners) listener(composer.key);
  composer.experimental_openPopup(POPUP);
}
const sourceFor = (threadId: string, seq: number) =>
  `@thread:${threadId}#msg=${seq}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const button = outlineButton;

/**
 * Puts the source, exact quote and comment in the message box for the owner to edit and send.
 * It never submits: the popup closes and the message box takes focus so the text is in front of him.
 */
export function placeQuoteInComposer(
  composer: PluginComposerApi,
  quote: { source: string; quote: string; comment: string },
): string {
  composer.insert(quoteContext(quote), { at: "end", block: true });
  composer.focus();
  composer.experimental_closePopup();
  return "Placed the source, exact quote and comment in the message box. Edit it, then send.";
}
export async function saveComposerSnapshot(
  composer: PluginComposerApi,
  save: (snapshot: ContextSave) => Promise<unknown>,
  payload: ContextSave,
  clear: boolean,
): Promise<boolean> {
  const before = payload.draft;
  await save(payload);
  let cleared = false;
  if (clear)
    composer.replace((current) => {
      if (!sameDraft(current, before)) return current;
      cleared = true;
      return { text: "", mentions: [], attachments: [] };
    });
  return cleared;
}
export async function restoreComposerSnapshot(
  composer: PluginComposerApi,
  restore: () => Promise<{ draft: ContextSave["draft"] }>,
  allowReplace: boolean,
): Promise<void> {
  const before = composer.draft;
  if (!allowReplace && !composer.isEmpty)
    throw new Error(
      "The composer contains a draft. Choose Replace explicitly or save it first.",
    );
  const restored = await restore();
  composer.replace((current) => {
    if (!sameDraft(current, before))
      throw new Error(
        "The composer changed while files were restored. Your edits are kept; try restoring again.",
      );
    return restored.draft as ComposerDraftReplacement;
  });
  composer.focus();
}

export function ContextWorkspacePopup() {
  const stashClearOn = useFeature("F56");
  const composer = useComposer(),
    rpc = useRpc<typeof contextWorkspaceContract>(),
    sdk = useSdk(),
    context = useBbContext(),
    pluginId = experimental_usePluginId(),
    navigate = useBbNavigate();
  const [tab, setTab] = useState("Drafts"),
    [drafts, setDrafts] = useState<ContextDraftSummary[]>([]),
    [local, setLocal] = useState<LocalContextDraft[]>([]),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [replaceId, setReplaceId] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote>(
      () =>
        quotes.get(composer.key) ?? {
          quote: "",
          source: "",
          role: "assistant",
        },
    ),
    [comment, setComment] = useState("");
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<
      Array<{ id: string; title: string; projectId: string }>
    >([]),
    [imported, setImported] = useState<{
      messages: ImportedMessage[];
      omitted: number;
      provider: string;
    } | null>(null);
  const [reviewMessages, setReviewMessages] = useState<Quote[]>([]),
    [reviews, setReviews] = useState<
      Array<{ id: string; title: string; expiresAt: number; revoked: boolean }>
    >([]),
    [reviewUrl, setReviewUrl] = useState(""),
    [reviewExpiry, setReviewExpiry] = useState<GuestReviewExpiryMinutes>(60);
  useEffect(() => {
    const listener = (key: string) => { if (key === composer.key) { setQuote(quotes.get(key)!); setTab("Context"); } };
    quoteListeners.add(listener);
    if (quotes.has(composer.key)) listener(composer.key);
    return () => { quoteListeners.delete(listener); };
  }, [composer.key]);
  const projectId = composer.selection?.projectId ?? context.projectId;
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setStatus("");
    try {
      await fn();
    } catch (e) {
      setStatus(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const [remote, device] = await Promise.allSettled([
      rpc.call("context_drafts_list", null),
      localDrafts(pluginId, nativeStorageFor(composer)),
    ]);
    if (remote.status === "fulfilled") setDrafts(remote.value);
    if (device.status === "fulfilled") setLocal(device.value);
    if (remote.status === "rejected")
      setStatus(
        `Server shelf unavailable. Device copies remain available: ${errorText(remote.reason)}`,
      );
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function payload(): Promise<ContextSave> {
    if (!projectId)
      throw new Error("Choose a project before saving files and destination.");
    if (
      composer.isSubmitting ||
      (composer.isSubmittingBlocked &&
        /upload|attach|recording|transcrib|voice/i.test(
          composer.submittingBlockedReason ?? "",
        ))
    )
      throw new Error(
        composer.submittingBlockedReason ??
          "Finish the current upload or voice input before saving the complete draft.",
      );
    const draft = contextDraftSchema.parse(composer.draft);
    const selection = composer.selection ? { ...composer.selection } : null;
    let hostId: string | null = null;
    let label = projectId;
    try {
      const project = await sdk.projects.get({ projectId });
      label = project.name;
      const env = selection?.environment;
      if (env?.type === "host") hostId = env.hostId ?? null;
      if (env?.type === "reuse")
        hostId = (
          await sdk.environments.get({ environmentId: env.environmentId })
        ).hostId;
      if (composer.scope.kind === "thread") {
        const thread = await sdk.threads.get({
          threadId: composer.scope.threadId,
        });
        if (thread.environmentId)
          hostId = (
            await sdk.environments.get({ environmentId: thread.environmentId })
          ).hostId;
      }
    } catch {
      /* Offline copies retain the native selection and unresolved host explicitly. */
    }
    return {
      requestId: crypto.randomUUID(),
      title: title.trim() || draft.text.slice(0, 70).trim() || "Saved files",
      draft,
      destination: {
        projectId,
        composerKey: composer.key,
        threadId:
          composer.scope.kind === "thread" ? composer.scope.threadId : null,
        hostId,
        label: `${label} · ${hostId ?? "host from native selection"} · ${composer.scope.kind}`,
      },
      selection,
    };
  }
  async function deviceCopy(input: ContextSave): Promise<LocalContextDraft> {
    const files: LocalContextDraft["files"] = [];
    for (const a of input.draft.attachments) {
      const owner = attachmentOwner(a, input.destination.projectId);
      const cached = local
        .flatMap((d) => d.files)
        .find((f) => f.path === a.path && f.owner === owner);
      if (cached) {
        files.push(cached);
        continue;
      }
      if (a.hostId) {
        const file = await sdk.files.read({ hostId: a.hostId, path: a.path });
        const bytes =
          file.contentEncoding === "base64"
            ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(file.content);
        files.push({ path: a.path, owner, bytes });
      } else {
        const file = await sdk.projects.attachments.read({
          projectId: a.sourceProjectId ?? input.destination.projectId,
          path: a.path,
        });
        files.push({ path: a.path, owner, bytes: file.bytes });
      }
      if (files.at(-1)!.bytes.byteLength > MAX_FILE_BYTES)
        throw new Error("A file exceeds the 20 MB device copy limit.");
    }
    return {
      id: input.requestId,
      payload: input,
      savedAt: Date.now(),
      kind: "outbox",
      complete: true,
      files,
    };
  }
  async function uploadLocal(d: LocalContextDraft) {
    if (!d.complete)
      throw new Error(
        "This checkpoint lacks some file bytes. Reconnect to its source before uploading it.",
      );
    let input = d.staged;
    if (!input) {
      const paths = new Map<string, string>(),
        attachments = [];
      for (const a of d.payload.draft.attachments) {
        const file = d.files.find(
          (f) =>
            f.path === a.path &&
            f.owner === attachmentOwner(a, d.payload.destination.projectId),
        );
        if (!file) throw new Error(`Missing retained bytes for ${a.name}`);
        const uploaded = await sdk.projects.attachments.upload({
          projectId: d.payload.destination.projectId,
          filename: a.name,
          mimeType: a.mimeType,
          clientFile: file.bytes,
        });
        attachments.push({
          ...uploaded,
          sourceProjectId: d.payload.destination.projectId,
        });
        paths.set(a.path, uploaded.path);
      }
      input = {
        ...d.payload,
        draft: {
          ...d.payload.draft,
          attachments,
          mentions: d.payload.draft.mentions.map((m) =>
            m.kind === "attachment" && paths.has(m.path)
              ? { ...m, path: paths.get(m.path)! }
              : m,
          ),
        },
      };
      await putLocalDraft(
        pluginId,
        { ...d, staged: input },
        nativeStorageFor(composer),
      );
    }
    await rpc.call("context_draft_save", input);
    await removeLocalDraft(pluginId, d.id, nativeStorageFor(composer));
    await refresh();
    setStatus(
      "Uploaded to the server shelf. Nothing has been sent to an agent.",
    );
  }
  return (
    <div className="max-h-[75vh] w-full max-w-xl space-y-3 overflow-auto p-3 text-[13px]">
      <div
        className="flex flex-wrap gap-1"
        role="tablist"
        aria-label="Context workspace"
      >
        {["Drafts", "Context", "History", "Device", "Reviews"].map((t) => (
          <button
            key={t}
            className={button}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Destination: {projectId ?? "Choose a project"} · {composer.scope.kind}.
        Restoring a saved draft keeps the current destination and model
        selections.
      </p>
      {status && (
        <p role="status" className="whitespace-pre-wrap text-xs">
          {status}
        </p>
      )}
      {tab === "Drafts" && (
        <>
          <label className="block">
            Draft name
            <input
              className={`${field} mt-1 w-full`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={150}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              disabled={busy || composer.isEmpty || composer.isSubmitting}
              onClick={() =>
                void run(async () => {
                  await saveComposerSnapshot(
                    composer,
                    (p) => rpc.call("context_draft_save", p),
                    await payload(),
                    false,
                  );
                  await refresh();
                  setStatus(
                    "Saved with verified file bytes. Your composer is unchanged.",
                  );
                })
              }
            >
              Save a copy
            </button>
            {stashClearOn && <button
              className={button}
              disabled={busy || composer.isEmpty || composer.isSubmitting}
              onClick={() =>
                void run(async () => {
                  const cleared = await saveComposerSnapshot(
                    composer,
                    (p) => rpc.call("context_draft_save", p),
                    await payload(),
                    true,
                  );
                  await refresh();
                  setStatus(
                    cleared
                      ? "Stashed durably. The composer is ready for another idea."
                      : "Saved. Newer composer edits were kept.",
                  );
                })
              }
            >
              Stash and clear
            </button>}
            <button
              className={button}
              disabled={busy || composer.isEmpty}
              onClick={() =>
                void run(async () => {
                  await putLocalDraft(
                    pluginId,
                    await deviceCopy(await payload()),
                    nativeStorageFor(composer),
                  );
                  await refresh();
                  setStatus(
                    "Saved on this device, including file bytes. Upload it explicitly when connected.",
                  );
                })
              }
            >
              Keep on this device
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Server shelf: available to signed-in clients on this BB server.
            Files: 20 MB each, 50 MB per draft. No agent starts when a draft is
            saved.
          </p>
          {drafts.map((d) => (
            <article
              key={d.id}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <strong>{d.title}</strong>
              <p className="text-xs text-muted-foreground">
                {d.destination.label} · {d.attachmentCount} files ·{" "}
                {d.bytes.toLocaleString()} bytes
              </p>
              <p className="line-clamp-2 whitespace-pre-wrap text-xs">
                {d.textPreview}
              </p>
              <div className="flex gap-2">
                <button
                  className={button}
                  disabled={busy || !projectId}
                  onClick={() => {
                    if (!composer.isEmpty) {
                      setReplaceId(d.id);
                      return;
                    }
                    void run(async () => {
                      await restoreComposerSnapshot(
                        composer,
                        () =>
                          rpc.call("context_draft_restore", {
                            id: d.id,
                            projectId: projectId!,
                          }),
                        false,
                      );
                      setStatus(
                        "Restored into the native composer. Review before sending.",
                      );
                    });
                  }}
                >
                  Restore
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await rpc.call("context_draft_delete", { id: d.id });
                      await refresh();
                    })
                  }
                >
                  Delete saved copy
                </button>
              </div>
              {replaceId === d.id && (
                <div className="space-y-2">
                  <p>
                    Your composer contains unsent work. Save it first, or
                    explicitly replace it.
                  </p>
                  <button
                    className={button}
                    disabled={busy || !projectId}
                    onClick={() =>
                      void run(async () => {
                        await restoreComposerSnapshot(
                          composer,
                          () =>
                            rpc.call("context_draft_restore", {
                              id: d.id,
                              projectId: projectId!,
                            }),
                          true,
                        );
                        setReplaceId(null);
                        setStatus(
                          "Replaced explicitly. Review before sending.",
                        );
                      })
                    }
                  >
                    Replace current draft
                  </button>
                  <button className={button} onClick={() => setReplaceId(null)}>
                    Keep current draft
                  </button>
                </div>
              )}
            </article>
          ))}
          {!drafts.length && (
            <p className="text-muted-foreground">No saved server drafts</p>
          )}
        </>
      )}
      {tab === "Context" && (
        <>
          <div
            data-nav-thread-drop-target=""
            className="rounded-lg border border-dashed border-border p-4"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-nav-thread")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(e) => {
              const mention = droppedThread(
                e.dataTransfer.getData("application/x-nav-thread"),
              );
              if (!mention) return;
              e.preventDefault();
              composer.insert(mention, { at: "end", block: true });
              setStatus(
                "Added a native thread reference. Its history is resolved on demand.",
              );
            }}
          >
            Drag a sidebar thread here to add its native context reference.
          </div>
          <label className="block">
            Source location
            <input
              className={`${field} w-full`}
              value={quote.source}
              onChange={(e) => setQuote({ ...quote, source: e.target.value })}
            />
          </label>
          <label className="block">
            Exact quoted text
            <textarea
              className={`${fieldArea} h-28 w-full`}
              value={quote.quote}
              onChange={(e) => setQuote({ ...quote, quote: e.target.value })}
            />
          </label>
          <label className="block">
            Your comment
            <textarea
              className={`${fieldArea} h-20 w-full`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          <button
            className={button}
            disabled={!quote.quote}
            onClick={() => {
              setStatus(
                placeQuoteInComposer(composer, {
                  source: quote.source,
                  quote: quote.quote,
                  comment,
                }),
              );
            }}
          >
            Insert annotated quote
          </button>
          <button
            className={button}
            disabled={!quote.quote}
            onClick={() => {
              setReviewMessages([...reviewMessages, quote]);
              setTab("Reviews");
            }}
          >
            Add excerpt to review selection
          </button>
          <p className="text-xs text-muted-foreground">
            Use a message’s “Quote and annotate” action to retain the exact
            selected text and message link. For preview elements, use the
            existing Agent Annotations or Browser context controls.
          </p>
        </>
      )}
      {tab === "History" && (
        <>
          <NativeHistoryImport />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const found = await sdk.threads.search({
                  query,
                  limitPerGroup: "15",
                });
                setResults(
                  [...found.active.results, ...found.archived.results].map(
                    (r) => ({
                      id: r.thread.id,
                      title: r.thread.title || r.thread.id,
                      projectId: r.thread.projectId,
                    }),
                  ),
                );
              });
            }}
          >
            <label>
              Search BB conversation history
              <input
                className={`${field} w-full`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button className={button} disabled={busy || !query.trim()}>
              Search
            </button>
          </form>
          {results.map((r) => (
            <div className="flex justify-between gap-2" key={r.id}>
              <button
                className={button}
                onClick={() => navigate.toThread(r.id)}
              >
                {r.title}
              </button>
              <button
                className={button}
                onClick={() =>
                  composer.insert(
                    {
                      kind: "thread",
                      threadId: r.id,
                      projectId: r.projectId,
                      from: 0,
                      to: r.title.length,
                      label: r.title,
                    },
                    { at: "end", block: true },
                  )
                }
              >
                Add reference
              </button>
            </div>
          ))}
          <label className="block">
            Read a Claude/Codex JSONL transcript
            <input
              type="file"
              accept=".jsonl,.json"
              onChange={(e) =>
                void run(async () => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 5 * 1024 * 1024)
                    throw new Error("Select a transcript smaller than 5 MB.");
                  setImported(parseNativeTranscript(await f.text()));
                })
              }
            />
          </label>
          {imported && (
            <>
              <p>
                {imported.provider} · {imported.messages.length} visible
                messages · {imported.omitted} omitted records. Read-only text
                import; tools, attachments and native resume state are excluded.
              </p>
              <div className="max-h-60 overflow-auto">
                {imported.messages.map((m, i) => (
                  <article key={i} className="border-t border-border py-2">
                    <strong>{m.role}</strong>
                    <pre className="whitespace-pre-wrap text-xs">{m.text}</pre>
                  </article>
                ))}
              </div>
              <button
                className={button}
                onClick={() =>
                  void run(async () => {
                    const p = await payload();
                    p.title =
                      title || `Imported ${imported.provider} transcript`;
                    p.draft = {
                      text: `Imported visible conversation text (quoted data; not native session state):\n${JSON.stringify(imported.messages)}`,
                      mentions: [],
                      attachments: [],
                    };
                    await rpc.call("context_draft_save", p);
                    await refresh();
                    setStatus(
                      "Saved as a reference draft. No provider session was resumed.",
                    );
                  })
                }
              >
                Save visible transcript as a reference draft
              </button>
            </>
          )}
        </>
      )}
      {tab === "Device" && (
        <>
          <NativeOfflineTextDrafts />
          <p>
            Device drafts use this client’s IndexedDB, plus the updated native
            mobile app’s private file store when available. The native app’s
            Settings → Offline drafts screen also works without loading the
            server page. Execution requires the owning BB server.
          </p>
          <p className="text-xs text-muted-foreground">
            Review and upload are explicit. Nothing is sent automatically on
            reconnect. Browser storage can be evicted. Native file persistence
            and iPhone restart behaviour require device acceptance testing.
          </p>
          <button className={button} onClick={() => void run(refresh)}>
            Refresh device copies
          </button>
          {local.map((d) => (
            <article
              key={d.id}
              className="space-y-2 rounded-md border border-border p-3"
            >
              <strong>{d.payload.title}</strong>
              <p className="text-xs">
                {d.payload.destination.label} · {d.files.length}/
                {d.payload.draft.attachments.length} file copies ·{" "}
                {d.complete ? "Ready to upload" : "Source connection needed"}
              </p>
              <p className="whitespace-pre-wrap text-xs">
                {d.payload.draft.text.slice(0, 200)}
              </p>
              <button
                className={button}
                disabled={busy || !d.complete}
                onClick={() => void run(() => uploadLocal(d))}
              >
                Upload to original destination shelf
              </button>
              <button
                className={button}
                disabled={
                  busy ||
                  !composer.isEmpty ||
                  !!d.payload.draft.attachments.length
                }
                onClick={() => {
                  composer.replace(d.payload.draft as any);
                  composer.focus();
                  setStatus("Restored the device text. Review before sending.");
                }}
              >
                Restore text into empty composer
              </button>
              <button
                className={button}
                onClick={() =>
                  void run(async () => {
                    await removeLocalDraft(
                      pluginId,
                      d.id,
                      nativeStorageFor(composer),
                    );
                    await refresh();
                  })
                }
              >
                Delete device copy
              </button>
            </article>
          ))}
          <p>
            The updated native iPhone app has an Offline drafts screen with
            local dictation. It requires Apple’s on-device recognition
            capability and never falls back to server transcription. Review the
            text before restoring or sending it. BB’s ordinary voice control
            still uses its configured service.
          </p>
          <a
            className="underline"
            href={sdk.system.mobileAppDownloads().ios}
            target="_blank"
            rel="noreferrer"
          >
            BB’s official iOS app
          </a>
        </>
      )}
      {tab === "Reviews" && (
        <>
          <p>
            Guest links reveal only the selected text snapshot. Files, tools,
            private history and workstation controls are excluded. Links expire
            after the time you choose (1 hour or 24 hours) and can be revoked.
          </p>
          {reviewMessages.map((m, i) => (
            <article key={i} className="rounded-md border border-border p-3">
              <small>{m.source}</small>
              <pre className="whitespace-pre-wrap text-xs">{m.quote}</pre>
              <button
                className={button}
                onClick={() =>
                  setReviewMessages(reviewMessages.filter((_, j) => i !== j))
                }
              >
                Remove excerpt
              </button>
            </article>
          ))}
          <label>
            Review title
            <input
              className={`${field} w-full`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={150}
            />
          </label>
          <label>
            Link expires after
            <select
              aria-label="Guest link expiry"
              className={`${field} w-full`}
              value={reviewExpiry}
              onChange={(e) =>
                setReviewExpiry(
                  Number(e.target.value) as GuestReviewExpiryMinutes,
                )
              }
            >
              {GUEST_REVIEW_EXPIRY_OPTIONS.map((option) => (
                <option key={option.minutes} value={option.minutes}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className={button}
            disabled={busy || !reviewMessages.length || !title.trim()}
            onClick={() =>
              void run(async () => {
                const created = await rpc.call("context_review_create", {
                  title,
                  messages: reviewMessages.map((m) => ({
                    source: m.source,
                    text: m.quote,
                    role: m.role,
                  })),
                  expiresInMinutes: reviewExpiry,
                });
                setReviewUrl(created.url);
                setReviews(await rpc.call("context_reviews_list", null));
              })
            }
          >
            Create guest link for these excerpts
          </button>
          {reviewUrl && (
            <div className="space-y-2">
              <input
                aria-label="Guest review link"
                className={`${field} w-full`}
                readOnly
                value={reviewUrl}
              />
              <button
                className={button}
                onClick={() =>
                  void run(async () => {
                    if (
                      !(await experimental_copyToClipboard({ text: reviewUrl }))
                    )
                      throw new Error("The link could not be copied.");
                    setStatus(
                      "Copied. Anyone with this link can read the selected snapshot until expiry or revocation.",
                    );
                  })
                }
              >
                Copy guest link
              </button>
            </div>
          )}
          <button
            className={button}
            onClick={() =>
              void run(async () =>
                setReviews(await rpc.call("context_reviews_list", null)),
              )
            }
          >
            Load existing reviews
          </button>
          {reviews.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2">
              <span>
                {r.title} ·{" "}
                {r.revoked ? "Revoked" : new Date(r.expiresAt).toLocaleString()}
              </span>
              <button
                className={button}
                disabled={r.revoked || busy}
                onClick={() =>
                  void run(async () => {
                    await rpc.call("context_review_revoke", { id: r.id });
                    setReviews(await rpc.call("context_reviews_list", null));
                    setReviewUrl("");
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function ContextDraftCheckpoint() {
  const composer = useComposer(),
    context = useBbContext(),
    pluginId = experimental_usePluginId(),
    sdk = useSdk();
  const projectId = composer.selection?.projectId ?? context.projectId;
  const generation = useRef(0);
  useEffect(() => {
    const run = async () => {
      if (!projectId)
        throw new Error("Choose a project before capturing a window.");
      if (captureBusy.has(composer.key))
        throw new Error("A window capture is already in progress.");
      captureBusy.add(composer.key);
      try {
        const frame = await captureDisplayFrame();
        const result = await attachCapturedFrame(composer, frame, (bytes) =>
          sdk.projects.attachments
            .upload({
              projectId,
              filename: `window-${Date.now()}.png`,
              mimeType: frame.mimeType,
              clientFile: bytes,
            })
            .then((file) => ({ ...file, sourceProjectId: projectId })),
        );
        toast.success(result);
      } finally {
        captureBusy.delete(composer.key);
      }
    };
    captureCommands.set(composer.key, run);
    return () => {
      if (captureCommands.get(composer.key) === run)
        captureCommands.delete(composer.key);
    };
  }, [composer, composer.key, projectId, sdk]);
  useEffect(() => composer.onSubmitted(() => {
    generation.current++;
    void removeLocalDraft(pluginId, `checkpoint:${composer.key}`, nativeStorageFor(composer)).catch(() => undefined);
  }), [composer, pluginId]);
  useEffect(() => {
    if (composer.isEmpty) {
      void removeLocalDraft(pluginId, `checkpoint:${composer.key}`, nativeStorageFor(composer)).catch(() => undefined);
      return;
    }
    if (!projectId || composer.isSubmitting) return;
    const now = ++generation.current,
      draft = composer.draft,
      savedAt = Date.now();
    const timer = setTimeout(() => {
      void (async () => {
        const rows = await localDrafts(pluginId, nativeStorageFor(composer)),
          old = rows.find((d) => d.id === `checkpoint:${composer.key}`);
        if (generation.current !== now) return;
        const files = draft.attachments.flatMap(
          (a) =>
            old?.files.filter(
              (f) =>
                f.path === a.path && f.owner === attachmentOwner(a, projectId),
            ) ?? [],
        );
        await putLocalDraft(
          pluginId,
          {
            id: `checkpoint:${composer.key}`,
            savedAt,
            kind: "checkpoint",
            payload: {
              requestId: crypto.randomUUID(),
              title: draft.text.slice(0, 70).trim() || "Composer checkpoint",
              draft: contextDraftSchema.parse(draft),
              destination: {
                projectId,
                composerKey: composer.key,
                threadId:
                  composer.scope.kind === "thread"
                    ? composer.scope.threadId
                    : null,
                hostId: null,
                label: `${projectId} · ${composer.scope.kind}`,
              },
              selection: composer.selection ? { ...composer.selection } : null,
            },
            files,
            complete: files.length === draft.attachments.length,
          },
          nativeStorageFor(composer),
        );
      })().catch(() => {
        /* Explicit device save surfaces storage failures; autosave never blocks typing. */
      });
    }, 800);
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [
    composer.draft,
    projectId,
    composer.key,
    composer.isSubmitting,
    pluginId,
  ]);
  return null;
}

export function registerContextWorkspace(app: Parameters<PluginAppSetup>[0]) {
  // Each group is registered only when its feature is on at load (the picker, see
  // use-feature.ts); a change made in setup reaches these menus after a reload.
  const open = ({ composer }: { composer: PluginComposerApi }) => {
    composer.experimental_openPopup(POPUP);
  };
  if (registerAtLoad("F55")) {
    app.composer.customize({
      id: "context-workspace",
      scopes: ["thread", "new-thread"],
      experimental_popups: [
        {
          id: POPUP,
          label: "Drafts and context",
          component: ContextWorkspacePopup,
        },
      ],
      banners: [
        { id: "checkpoint", chrome: "bare", component: ContextDraftCheckpoint },
      ],
      plusMenu: [
        {
          id: "context-shelf",
          label: "Drafts, context and review links",
          run: open,
        },
      ],
    });
    if (registerAtLoad("F72")) app.composer.experimental_registerCommand({
      id: "context-shelf",
      title: "Workspace: drafts and context",
      defaultShortcut: { key: "s", mod: true, shift: true },
      run: open,
    });
  }
  if (registerAtLoad("F62")) {
    if (registerAtLoad("F72")) app.composer.experimental_registerCommand({
      id: "capture-window",
      title: "Workspace: capture a selected window",
      defaultShortcut: { key: "g", mod: true, alt: true },
      run: async ({ composer }) => {
        try {
          const capture = captureCommands.get(composer.key);
          if (capture) await capture();
          else composer.experimental_openPopup("context-capture");
        } catch (e) {
          toast.error(errorText(e));
        }
      },
    });
    app.composer.customize({
      id: "context-capture",
      scopes: ["thread", "new-thread"],
      experimental_popups: [
        {
          id: "context-capture",
          label: "Capture window",
          component: CaptureWindowPopup,
        },
      ],
      plusMenu: [
        {
          id: "capture-window",
          label: "Capture a selected window",
          run: ({ composer }) => {
            composer.experimental_openPopup("context-capture");
          },
        },
      ],
    });
  }
  if (registerAtLoad("F58")) {
    app.slots.messageAction({
      id: "quote-context",
      title: "Quote and annotate",
      icon: "Quote",
      run: (ctx) => {
        if (!ctx.composer) return;
        stageQuote(ctx.composer, {
          quote: ctx.selectedText ?? ctx.message.text,
          source: sourceFor(ctx.threadId, ctx.message.experimental_messageSeq),
          role: ctx.message.role,
        });
      },
    });
  }
  const sendModes = [
    registerAtLoad("F45") && {
      id: "context-steer",
      label: "Steer the current turn",
      description: "Add this clarification to the running turn without stopping it.",
      disabled: (composer: PluginComposerApi) => !composer.isRunning,
      run: ({ composer }: { composer: PluginComposerApi }) => composer.submit({ experimental_mode: "steer-if-active" }),
    },
    registerAtLoad("F46") && {
      id: "context-queue",
      label: "Queue this follow-up",
      description: "Wait behind the current turn; starts immediately when the thread is idle.",
      run: ({ composer }: { composer: PluginComposerApi }) => composer.submit({ experimental_mode: "queue-if-active" }),
    },
  ].filter((x): x is Exclude<typeof x, false> => x !== false);
  if (sendModes.length > 0) app.composer.customize({ id: "context-send-modes", scopes: ["thread"], sendMenu: sendModes });
  if (registerAtLoad("F37")) {
    if (registerAtLoad("F72")) app.composer.experimental_registerCommand({
      id: "start-and-compose",
      title: "Workspace: start task and keep composing",
      defaultShortcut: { key: "Enter", mod: true, shift: true },
      run: async ({ composer }) => {
        const native = composer as PluginComposerApi & {
          experimental_submitInBackground?: () => Promise<void>;
        };
        if (!native.experimental_submitInBackground)
          throw new Error(
            "This BB build needs the native background-submit core extension. Your draft is kept.",
          );
        await native.experimental_submitInBackground();
      },
    });
    app.composer.customize({
      id: "submit-background",
      scopes: ["new-thread"],
      sendMenu: [
        {
          id: "background-task",
          label: "Start task and keep composing",
          description:
            "BB accepts this draft, then returns to the new task composer.",
          run: async ({ composer }) => {
            const native = composer as PluginComposerApi & {
              experimental_submitInBackground?: () => Promise<void>;
            };
            if (!native.experimental_submitInBackground)
              throw new Error(
                "This BB build needs the native background-submit core extension. Your draft is kept.",
              );
            await native.experimental_submitInBackground();
          },
        },
      ],
    });
  }
}
export function CaptureWindowPopup() {
  const composer = useComposer(),
    sdk = useSdk(),
    context = useBbContext();
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  async function capture() {
    setBusy(true);
    setStatus("");
    try {
      const projectId = composer.selection?.projectId ?? context.projectId;
      if (!projectId) throw new Error("Choose a project first.");
      const frame = await captureDisplayFrame();
      setStatus(
        await attachCapturedFrame(composer, frame, (bytes) =>
          sdk.projects.attachments
            .upload({
              projectId,
              filename: `window-${Date.now()}.png`,
              mimeType: frame.mimeType,
              clientFile: bytes,
            })
            .then((file) => ({ ...file, sourceProjectId: projectId })),
        ),
      );
    } catch (e) {
      setStatus(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 p-3">
      <p>
        Capture a window from this device. Choose the window in the browser or
        desktop picker. Capture includes pixels; accessibility text is
        unavailable through this SDK.
      </p>
      <button
        className={button}
        disabled={busy || !navigator.mediaDevices?.getDisplayMedia}
        onClick={() => void capture()}
      >
        Choose window and attach screenshot
      </button>
      {!navigator.mediaDevices?.getDisplayMedia && (
        <p>
          Capture is unavailable on this device. Use BB’s attachment control to
          add a screenshot.
        </p>
      )}
      {status && <p role="status">{status}</p>}
    </div>
  );
}

export function useConversationContextActions(
  targetThreadId: string,
): import("@get-bb/plugin-sdk/app").ThreadChatMessageAction[] {
  const composers = useComposers();
  return conversationContextActions(targetThreadId, composers);
}

export function conversationContextActions(
  targetThreadId: string,
  composers: readonly PluginComposerApi[],
): import("@get-bb/plugin-sdk/app").ThreadChatMessageAction[] {
  return [
    {
      id: "quote-context",
      title: "Quote and annotate",
      icon: "Quote",
      run: (message) => {
        const composer = composers.find(
          (c) =>
            c.scope.kind === "thread" && c.scope.threadId === targetThreadId,
        );
        if (!composer) {
          toast.error(
            "Open this conversation’s composer to annotate a message.",
          );
          return;
        }
        stageQuote(composer, {
          quote: message.text,
          source: sourceFor(message.threadId, message.experimental_messageSeq),
          role: message.role,
        });
        composer.experimental_openPopup(POPUP);
      },
    },
  ];
}

export async function attachCapturedFrame(
  composer: PluginComposerApi,
  frame: { bytes: Uint8Array; label: string; mimeType: string },
  upload: (bytes: Uint8Array) => Promise<ComposerAttachment>,
): Promise<string> {
  if (!frame.bytes.byteLength)
    throw new Error("The capture contains no image bytes.");
  const file = await upload(frame.bytes);
  composer.replace((current) => ({
    ...current,
    attachments: [...current.attachments, file],
  }));
  composer.insert(
    `Screenshot source: ${frame.label}. Captured on this client at ${new Date().toISOString()}.`,
    { at: "end", block: true },
  );
  return `Attached ${frame.bytes.byteLength.toLocaleString()} PNG bytes from ${frame.label}. Review before sending.`;
}

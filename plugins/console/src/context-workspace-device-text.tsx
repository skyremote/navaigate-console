import { useEffect, useState } from "react";
import { useComposer, useSdk, useBbContext } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { sameDraft } from "./context-workspace-model";
import { nativeStorageFor } from "./context-workspace-offline";
const fileSchema = z.object({
  name: z.string().max(500),
  mimeType: z.string().max(200),
  sizeBytes: z
    .number()
    .nonnegative()
    .max(20 * 1024 * 1024),
  base64: z
    .string()
    .max(28 * 1024 * 1024)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
const valueSchema = z
  .object({
    text: z.string().max(200_000),
    attachments: z.array(fileSchema).max(30),
  })
  .passthrough();
export function NativeOfflineTextDrafts() {
  const composer = useComposer(),
    sdk = useSdk(),
    context = useBbContext(),
    storage = nativeStorageFor(composer);
  const [rows, setRows] = useState<
      Array<{ key: string; text: string; files: z.infer<typeof fileSchema>[] }>
    >([]),
    [status, setStatus] = useState("");
  async function refresh() {
    if (!storage) return;
    try {
      const list = await storage({ operation: "list" });
      if (!list.supported) return;
      const found = [];
      for (const entry of list.entries ?? [])
        if (entry.key.startsWith("offline:")) {
          const read = await storage({ operation: "read", key: entry.key });
          if (!read.value) continue;
          const value = valueSchema.safeParse(JSON.parse(read.value));
          if (value.success)
            found.push({
              key: entry.key,
              text: value.data.text,
              files: value.data.attachments,
            });
        }
      setRows(found);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, [composer]);
  if (!rows.length && !status) return null;
  async function restore(row: (typeof rows)[number]) {
    try {
      if (!composer.isEmpty)
        throw new Error("Keep or save the current draft first.");
      const projectId = composer.selection?.projectId ?? context.projectId;
      if (!projectId && row.files.length)
        throw new Error(
          "Choose the destination project before restoring files.",
        );
      const before = composer.draft;
      const attachments: import("@get-bb/plugin-sdk/app").ComposerAttachment[] =
        [];
      let total = 0;
      for (const file of row.files) {
        const bytes = Uint8Array.from(atob(file.base64), (char) =>
          char.charCodeAt(0),
        );
        total += bytes.byteLength;
        if (bytes.byteLength !== file.sizeBytes || total > 50 * 1024 * 1024)
          throw new Error("A device file copy failed its byte count check.");
        const uploaded = await sdk.projects.attachments.upload({
          projectId: projectId!,
          filename: file.name,
          mimeType: file.mimeType,
          clientFile: bytes,
        });
        attachments.push({ ...uploaded, sourceProjectId: projectId! });
      }
      composer.replace((current) => {
        if (!sameDraft(current, before))
          throw new Error(
            "Your composer changed while files were uploaded. Your edits are kept.",
          );
        return { text: row.text, mentions: [], attachments };
      });
      composer.focus();
      setStatus(
        "Restored into the empty native composer with real uploaded files. Review before sending.",
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <section className="space-y-2">
      <strong>Drafts written in the native offline screen</strong>
      {status && <p role="status">{status}</p>}
      {rows.map((row) => (
        <article
          key={row.key}
          className="space-y-2 rounded-md border border-border p-3"
        >
          <p className="whitespace-pre-wrap text-xs">
            {row.text.slice(0, 250)} · {row.files.length} retained files
          </p>
          <button
            className="rounded-md border border-border px-2 py-1 text-xs"
            disabled={!composer.isEmpty}
            onClick={() => void restore(row)}
          >
            Restore into empty composer
          </button>
          <button
            className="rounded-md border border-border px-2 py-1 text-xs"
            onClick={() => {
              void storage?.({ operation: "remove", key: row.key })
                .then(refresh)
                .catch((e) => setStatus(String(e)));
            }}
          >
            Delete device copy
          </button>
        </article>
      ))}
    </section>
  );
}

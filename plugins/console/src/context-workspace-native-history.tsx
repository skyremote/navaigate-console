import { useState } from "react";
import { useFeature } from "./use-feature";
import {
  useBbContext,
  useBbNavigate,
  useComposer,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { outlineButton, field } from "./controls";
const entrySchema = z.object({
  providerId: z.enum(["codex", "claude-code"]),
  sessionId: z.string().uuid(),
  workspacePath: z.string(),
  modifiedAt: z.number(),
  sizeBytes: z.number(),
});
const readSchema = entrySchema.extend({
  messages: z.array(
    z.object({ role: z.enum(["user", "assistant"]), text: z.string() }),
  ),
  omittedRecords: z.number(),
  sha256: z.string(),
});
type Entry = z.infer<typeof entrySchema>;
const canonicalPath = (value: string) =>
  value.replace(/\/+$/, "").replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, "") || "/";
/** Same workspace despite a trailing slash or a macOS /private alias. The core import still verifies the owning workspace. */
export function sameWorkspacePath(a: string, b: string | null): boolean {
  return b !== null && canonicalPath(a) === canonicalPath(b);
}
type Read = z.infer<typeof readSchema>;
type NativeHistoryApi = {
  list(input: {
    providerId: "codex" | "claude-code";
    hostId: string;
  }): Promise<{ entries: Entry[]; truncated: boolean }>;
  read(input: {
    providerId: "codex" | "claude-code";
    hostId: string;
    sessionId: string;
  }): Promise<Read>;
  import(input: {
    providerId: "codex" | "claude-code";
    projectId: string;
    environmentId: string;
    sessionId: string;
    sha256: string;
    title: string;
  }): Promise<{ threadId: string; reused: boolean }>;
};
const button = outlineButton;
export function NativeHistoryImport() {
  return useFeature("F08") ? <NativeHistoryImportBody /> : null;
}
function NativeHistoryImportBody() {
  const sdk = useSdk(),
    context = useBbContext(),
    composer = useComposer(),
    navigate = useBbNavigate();
  const api = (
    sdk as typeof sdk & { experimental_nativeHistory?: NativeHistoryApi }
  ).experimental_nativeHistory;
  const projectId = composer.selection?.projectId ?? context.projectId;
  const [environments, setEnvironments] = useState<
      Array<{ id: string; hostId: string; path: string | null }>
    >([]),
    [environmentId, setEnvironmentId] = useState(""),
    [providerId, setProviderId] = useState<"codex" | "claude-code">("codex"),
    [entries, setEntries] = useState<Entry[]>([]),
    [selected, setSelected] = useState<Read | null>(null),
    [title, setTitle] = useState("Imported native session"),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const environment = environments.find((e) => e.id === environmentId);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setStatus("");
    try {
      await fn();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-2 rounded-md border border-border p-3">
      <strong>Native provider history</strong>
      <p className="text-xs text-muted-foreground">
        Discover one session on its owning machine, preview it, then import into
        the same ready workspace. Its native provider identity is retained for
        the next send; importing starts no turn. Tools and attachments are
        excluded from the visible excerpt. Default Claude/Codex history roots
        only.
      </p>
      {!api ? (
        <p className="text-xs">
          This BB build needs the native-history core extension for discovery
          and resumable import. The file reader below remains a read-only
          reference importer.
        </p>
      ) : (
        <>
          <button
            className={button}
            disabled={busy || !projectId}
            onClick={() =>
              void run(async () => {
                const rows = await sdk.environments.list({
                  projectId: projectId!,
                  status: "ready",
                  limit: 100,
                });
                setEnvironments(
                  rows.map((e) => ({
                    id: e.id,
                    hostId: e.hostId,
                    path: e.path,
                  })),
                );
                setSelected(null);
                setEntries([]);
              })
            }
          >
            Load ready workspaces
          </button>
          <select
            aria-label="Native history workspace"
            className={`${field} w-full`}
            value={environmentId}
            onChange={(e) => {
              setEnvironmentId(e.target.value);
              setSelected(null);
              setEntries([]);
            }}
          >
            <option value="">Choose the original workspace</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.hostId} · {e.path ?? e.id}
              </option>
            ))}
          </select>
          <select
            aria-label="Native history provider"
            className={`${field}`}
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value as "codex" | "claude-code");
              setEntries([]);
              setSelected(null);
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
          </select>
          <button
            className={button}
            disabled={busy || !environment}
            onClick={() =>
              void run(async () => {
                const found = await api.list({
                  hostId: environment!.hostId,
                  providerId,
                });
                setEntries(
                  z
                    .array(entrySchema)
                    .parse(found.entries)
                    .filter((e) => sameWorkspacePath(e.workspacePath, environment!.path)),
                );
                setStatus(
                  found.truncated
                    ? "Discovery reached its bounded scan limit. Only matching workspaces are shown."
                    : "Select one session to preview.",
                );
              })
            }
          >
            Discover sessions on this workspace’s machine
          </button>
          {entries.map((e) => (
            <button
              className={`${button} block w-full text-left`}
              key={e.sessionId}
              onClick={() =>
                void run(async () =>
                  setSelected(
                    readSchema.parse(
                      await api.read({
                        hostId: environment!.hostId,
                        providerId,
                        sessionId: e.sessionId,
                      }),
                    ),
                  ),
                )
              }
            >
              {new Date(e.modifiedAt).toLocaleString()} · {e.sessionId}
            </button>
          ))}
          {selected && (
            <>
              <p className="text-xs">
                {selected.messages.length} visible messages ·{" "}
                {selected.omittedRecords} omitted records · source hash{" "}
                {selected.sha256.slice(0, 16)}
              </p>
              <div className="max-h-48 overflow-auto">
                {selected.messages.map((m, i) => (
                  <pre
                    className="whitespace-pre-wrap border-t border-border p-1 text-xs"
                    key={i}
                  >
                    {m.role}: {m.text}
                  </pre>
                ))}
              </div>
              <input
                aria-label="Imported thread title"
                className={`${field} w-full`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <button
                className={button}
                disabled={busy || !title.trim()}
                onClick={() =>
                  void run(async () => {
                    const result = await api.import({
                      providerId,
                      projectId: projectId!,
                      environmentId,
                      sessionId: selected.sessionId,
                      sha256: selected.sha256,
                      title,
                    });
                    navigate.toThread(result.threadId);
                  })
                }
              >
                Import this selected native session
              </button>
            </>
          )}
        </>
      )}
      {status && (
        <p role="status" className="text-xs">
          {status}
        </p>
      )}
    </section>
  );
}

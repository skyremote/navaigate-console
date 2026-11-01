import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { deliveryRpcContract, prResultSchema, worktreeViewSchema } from "../delivery-contract";
import { readiness } from "./delivery-model";
import { button, errorText, TaskDraft } from "./delivery-shared";
import { rpcFlight } from "./rpc-flight";

type View = z.infer<typeof worktreeViewSchema>;
type Row = View["rows"][number];
type Result = z.infer<typeof prResultSchema>;
const short = (sha: string) => sha.slice(0, 7);
const READ_TTL_MS = 60_000;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function mergeState(row: Row, base: string): { label: string; canMerge: boolean } {
  if (row.ahead === 0) return { label: "Nothing committed to merge", canMerge: false };
  if (!row.mergeBase) return { label: `No shared history with ${base} on that machine`, canMerge: false };
  if (row.conflicts && row.conflicts.length)
    return { label: `Conflicts with ${base}: ${row.conflicts.join(", ")}`, canMerge: false };
  if (row.conflicts === null)
    return { label: "Ready to merge once checked: git could not pre-check conflicts, the merge checks again and stops if any", canMerge: true };
  return { label: "Ready to merge", canMerge: true };
}

export function conflictContext(row: Row, view: View): string {
  return `Resolve the merge conflict between branch ${row.branch} (worktree ${row.path} on ${row.hostName}) and ${view.base.ref} at ${view.base.sha}.\nConflicting files:\n${(row.conflicts ?? []).map((file) => `- ${file}`).join("\n")}`;
}

export function WorktreesPanel({
  environmentId,
  threadId,
  results,
}: {
  environmentId: string | null;
  threadId?: string;
  results: Record<string, Result | undefined>;
}) {
  const rpc = useRpc<typeof deliveryRpcContract>();
  const [view, setView] = useState<View | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [confirming, setConfirming] = useState<string | null>(null),
    [drafting, setDrafting] = useState<string | null>(null),
    [open, setOpen] = useState<string | null>(null);
  const serial = useRef(0);
  const load = useCallback(
    (fresh: boolean) => {
      if (!environmentId) return;
      const seq = ++serial.current;
      setLoading(true);
      void rpcFlight()
        .call(`delivery_worktrees:${environmentId}`, () => rpc.call("delivery_worktrees", { environmentId }), { fresh, ttlMs: READ_TTL_MS, slowStrikes: false })
        .then(
          (value) => {
            if (seq !== serial.current) return;
            setView(value);
            setError("");
            setLoading(false);
          },
          (cause) => {
            if (seq !== serial.current) return;
            setError(errorText(cause));
            setLoading(false);
          },
        );
    },
    [rpc, environmentId],
  );
  const refresh = useCallback(() => load(true), [load]);
  useEffect(() => {
    setView(null);
    load(false);
    return () => {
      serial.current++;
    };
  }, [load]);
  const matrix = useMemo(() => {
    if (!view) return [];
    const overlapping = new Set(view.overlaps.map((entry) => entry.path));
    const paths = [...new Set(view.rows.flatMap((row) => row.files.map((file) => file.path)))];
    return paths
      .sort((a, b) => Number(overlapping.has(b)) - Number(overlapping.has(a)) || a.localeCompare(b))
      .slice(0, 40)
      .map((path) => ({ path, overlap: overlapping.has(path) }));
  }, [view]);
  if (!environmentId)
    return (
      <section className="rounded-lg border border-border p-4" aria-label="Worktrees">
        <h2 className="font-medium">Worktrees</h2>
        <p className="text-[13px]">Open a chat that runs in a Git workspace to see its worktrees.</p>
      </section>
    );
  const merge = async (row: Row) => {
    if (!view || !row.branch) return;
    setBusy(true);
    setError("");
    try {
      const response = await rpc.call("delivery_worktree_merge", {
        environmentId: view.environmentId,
        sourceEnvironmentId: row.environmentId,
        branch: row.branch,
        expectedHead: row.head,
        expectedBaseHead: view.base.sha,
        expectedBaseRef: view.base.ref,
        intent: "explicit-user-action",
      });
      setNotice(response.message);
      setConfirming(null);
      refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3" aria-label="Worktrees">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">Worktrees</h2>
          <p className="text-xs text-muted-foreground">
            Parallel work from one base, on this machine and the others. Review what each one changed, then merge it back here.
          </p>
        </div>
        <button className={button} onClick={refresh} disabled={loading}>
          {loading ? "Reading worktrees…" : "Refresh worktrees"}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {view?.warnings.map((warning) => (
        <p key={warning} className="text-[13px]">
          {warning}
        </p>
      ))}
      {view && (
        <p className="rounded-md border border-border p-3 text-[13px]" aria-label="Shared base">
          Shared base <code>{view.base.ref}</code> at <code>{short(view.base.sha)}</code> on {view.hostName}. Merge-back lands here.
        </p>
      )}
      {view && !view.rows.length && <p className="text-[13px]">No other worktrees branch from this base yet. Start one from Models, Add a model alongside, with a new worktree.</p>}
      {view && view.overlaps.length > 0 && (
        <div className="rounded-lg border border-foreground/30 p-2 text-[13px]" aria-label="Overlapping edits">
          <p className="font-medium">Edited in more than one worktree</p>
          <ul className="list-disc pl-5">
            {view.overlaps.map((entry) => (
              <li key={entry.path}>
                <code>{entry.path}</code>: {entry.branches.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="space-y-2">
        {view?.rows.map((row) => {
          const state = mergeState(row, view.base.ref);
          const key = row.environmentId ?? row.path;
          const result = row.environmentId ? results[row.environmentId] : undefined;
          return (
            <li key={key} aria-label={row.branch ?? row.path} className="rounded-lg border border-border p-4 space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{row.branch ?? "(detached)"}</span>
                <span className="text-xs text-muted-foreground">
                  {row.hostName} · {plural(row.ahead, "commit")} ahead{row.behind ? `, ${row.behind} behind` : ""} · +{row.additions} −{row.deletions} in {plural(row.files.length, "file")}
                  {row.filesTruncated ? "+" : ""}
                </span>
              </div>
              <p className="text-[13px]">{state.label}</p>
              {row.dirty && <p className="text-xs">Uncommitted changes stay in that worktree and are not merged.</p>}
              {result?.outcome === "available" && (
                <p className="text-xs">
                  <a className="underline" href={result.pullRequest.url} target="_blank" rel="noreferrer">
                    #{result.pullRequest.number} {result.pullRequest.title}
                  </a>{" "}
                  · {readiness(result).label}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button className={button} onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                  {open === key ? "Hide changes" : "Review changes"}
                </button>
                {state.canMerge && (
                  <button className={button} disabled={busy} onClick={() => setConfirming(key)}>
                    Merge into {view.base.ref}…
                  </button>
                )}
                {row.conflicts && row.conflicts.length > 0 && row.sameHost && (
                  <button className={button} onClick={() => setDrafting(drafting === key ? null : key)}>
                    Draft conflict resolution
                  </button>
                )}
              </div>
              {row.conflicts && row.conflicts.length > 0 && !row.sameHost && (
                <p className="text-xs">
                  Resolve this in a chat that runs in that worktree on {row.hostName}; a task drafted here would run on this machine, where the worktree is not.
                </p>
              )}
              {open === key && (
                <ul className="text-xs font-mono space-y-0.5">
                  {row.files.map((file) => (
                    <li key={file.path}>
                      +{file.additions} −{file.deletions} {file.path}
                    </li>
                  ))}
                  {row.filesTruncated && <li>More files changed than are listed here.</li>}
                </ul>
              )}
              {confirming === key && (
                <div className="rounded-lg border border-border p-4 space-y-2" role="group" aria-label="Confirm merge back">
                  <p className="text-[13px]">
                    Merge <code>{row.branch}</code> ({plural(row.ahead, "commit")}, +{row.additions} −{row.deletions}) from {row.hostName} into {view.base.ref} at{" "}
                    {short(view.base.sha)} with a merge commit? {row.sameHost ? "" : `The branch is pushed from ${row.hostName} first. `}
                    Nothing else is pushed and the worktree is kept.
                  </p>
                  <div className="flex gap-2">
                    <button className={button} disabled={busy} onClick={() => void merge(row)}>
                      Confirm merge
                    </button>
                    <button className={button} onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {drafting === key && (
                <TaskDraft purpose="conflicts" threadId={threadId} projectId={null} hostId={row.hostId} context={conflictContext(row, view)} />
              )}
            </li>
          );
        })}
      </ul>
      {view && view.rows.length > 1 && matrix.length > 0 && (
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full text-xs" aria-label="Files by worktree">
            <thead>
              <tr>
                <th className="p-2 text-left">File</th>
                {view.rows.map((row) => (
                  <th key={row.environmentId ?? row.path} className="p-2 text-left">
                    {row.branch}
                    <span className="block font-normal text-muted-foreground">{row.hostName}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((entry) => (
                <tr key={entry.path} className={entry.overlap ? "bg-muted" : ""}>
                  <td className="p-2 font-mono">{entry.path}</td>
                  {view.rows.map((row) => {
                    const file = row.files.find((item) => item.path === entry.path);
                    return (
                      <td key={row.environmentId ?? row.path} className="p-2 font-mono">
                        {file ? `+${file.additions} −${file.deletions}` : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

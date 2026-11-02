// The Stash: chats you have not touched for a while (7 days unless Settings says
// otherwise) leave the sidebar and wait here, to keep the sidebar clear. Chats in a
// folder stay in their folder: the sweep only takes loose chats. Stash is
// not archive: nothing is moved or deleted. Open a stashed chat and send a
// message and it is back in the sidebar by itself; "Back to sidebar" does the
// same without working in it. Only Delete removes a chat, after a confirmation.
import { useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { overlayRows, rowKey, useAttention, useOpenRow, type Row } from "./attention";
import { tnum } from "./shared";
import { machineName } from "./words";

export const DAY_MS = 86_400_000;
export const SEARCH_ABOVE = 10;

export function stashedRows(rows: Row[], overlay: Parameters<typeof overlayRows>[1]): Row[] {
  return overlayRows(rows, overlay)
    .filter((row) => row.status === "stashed")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** "Untouched for 9 days", counted from the chat's last activity. */
export function untouchedLabel(updatedAt: number, now: number): string {
  const days = Math.max(0, Math.floor((now - updatedAt) / DAY_MS));
  if (days === 0) return "Untouched today";
  if (days < 60) return `Untouched for ${days} day${days === 1 ? "" : "s"}`;
  return `Untouched for ${Math.floor(days / 30)} months`;
}

export function groupByAge(rows: Row[], now: number): { label: string; rows: Row[] }[] {
  const week = rows.filter((row) => now - row.updatedAt < 7 * DAY_MS);
  const earlier = rows.filter((row) => now - row.updatedAt >= 7 * DAY_MS);
  return [
    { label: "This week", rows: week },
    { label: "Earlier", rows: earlier },
  ].filter((group) => group.rows.length > 0);
}

export function stashIntro(days: number): string {
  const keep = "They are not archived. Open one and carry on, and it moves back to your list as soon as you send a message.";
  if (days > 0)
    return `Chats you have not touched for ${days} day${days === 1 ? "" : "s"} move here, to keep your sidebar clear. Chats in a folder stay in their folder. ${keep}`;
  return `The Stash is switched off, so chats stay in your sidebar however long they sit. Any chat already here is not archived: open it and carry on, and it moves back to your list as soon as you send a message. Switch the Stash on in this plugin's Settings.`;
}

const glyph = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "size-3.5" } as const;
const BackGlyph = () => (
  <svg {...glyph}>
    <path d="M13 8H6M9 4.5 5.5 8 9 11.5M2.5 3v10" />
  </svg>
);
const DeleteGlyph = () => (
  <svg {...glyph}>
    <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v3.5M9 7v3.5" />
  </svg>
);

const action =
  "inline-flex min-h-7 items-center rounded-md px-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

function StashRow({
  row,
  attention,
  now,
  dense,
}: {
  row: Row;
  attention: ReturnType<typeof useAttention>;
  now: number;
  dense: boolean;
}) {
  const sdk = useSdk();
  const openRow = useOpenRow();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const deletable = !row.remote;
  const remove = async () => {
    setBusy(true);
    try {
      await sdk.threads.delete({ threadId: row.threadId, childThreadsConfirmed: true });
      toast.success(`Deleted ${row.title}`);
      await attention.refresh();
    } catch (e) {
      toast.error("Could not delete the chat", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const backToSidebar = () => void attention.applyRows([row], "restore");
  return (
    <li data-nav-part="stash-row" className={cn("min-w-0", dense ? "px-1 py-1" : "px-2 py-2")}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block w-full truncate text-left text-[13px] text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title={row.title}
            onClick={() => openRow(row)}
          >
            {row.title}
          </button>
          <p data-nav-part="stash-meta" className="truncate text-[12px] text-muted-foreground" style={tnum}>
            {untouchedLabel(row.updatedAt, now)}
            {row.machine ? ` · ${machineName(row.machine)}` : ""}
          </p>
        </div>
        <div data-nav-part="stash-actions" className="flex shrink-0 items-center gap-0.5 self-stretch border-l border-border pl-1.5">
          <button type="button" className={cn(action, "text-[12px] text-foreground")} aria-label={`Open ${row.title}`} onClick={() => openRow(row)}>
            Open
          </button>
          {dense ? (
            <button
              type="button"
              className={cn(action, "w-7 justify-center px-0 text-muted-foreground hover:text-foreground")}
              aria-label={`Back to sidebar: ${row.title}`}
              title="Back to sidebar"
              onClick={backToSidebar}
            >
              <BackGlyph />
            </button>
          ) : (
            <button type="button" className={cn(action, "text-[11px] text-muted-foreground hover:text-foreground")} aria-label={`Back to sidebar: ${row.title}`} onClick={backToSidebar}>
              Back to sidebar
            </button>
          )}
          {deletable ? (
            dense ? (
              <button
                type="button"
                className={cn(action, "w-7 justify-center px-0 text-muted-foreground hover:text-[var(--destructive-text,var(--destructive))]")}
                aria-label={`Delete ${row.title}`}
                title="Delete"
                aria-expanded={confirming}
                onClick={() => setConfirming(true)}
              >
                <DeleteGlyph />
              </button>
            ) : (
              <button
                type="button"
                className={cn(action, "text-[11px] text-muted-foreground hover:bg-transparent hover:text-[var(--destructive-text,var(--destructive))] hover:underline")}
                aria-label={`Delete ${row.title}`}
                aria-expanded={confirming}
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            )
          ) : (
            <span aria-hidden className={dense ? "inline-block w-7" : "inline-block min-w-[3.1rem]"} />
          )}
        </div>
      </div>
      {confirming ? (
        <div role="group" aria-label={`Delete ${row.title}?`} className="mt-1 flex flex-wrap items-center gap-1 text-[12px]">
          <span className="mr-auto text-[var(--destructive-text,var(--destructive))]">Delete this chat? This cannot be undone.</span>
          <button type="button" className={cn(action, "text-[var(--destructive-text,var(--destructive))] hover:bg-transparent hover:underline")} disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
          <button type="button" className={cn(action, "text-foreground")} disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function StashList({
  attention,
  now = Date.now(),
  dense = false,
}: {
  attention: ReturnType<typeof useAttention>;
  now?: number;
  dense?: boolean;
}) {
  const [query, setQuery] = useState("");
  const all = stashedRows(attention.rows, attention.overlay);
  if (all.length === 0)
    return <p className="px-1 py-2 text-[12px] text-muted-foreground">Nothing in the Stash.</p>;
  const needle = query.trim().toLowerCase();
  const shown = needle ? all.filter((row) => `${row.title} ${row.machine ?? ""}`.toLowerCase().includes(needle)) : all;
  return (
    <div data-nav-part="stash-body">
      {all.length > SEARCH_ABOVE ? (
        <div className={cn("pb-1", !dense && "sticky top-0 z-10 bg-background pb-2")}>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search stashed chats"
            placeholder="Search stashed chats"
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className="px-1 py-2 text-[12px] text-muted-foreground">No stashed chat matches.</p>
      ) : (
        groupByAge(shown, now).map((group) => (
          <section key={group.label} data-nav-part="stash-group" aria-label={group.label}>
            <h2 className={cn("font-medium text-muted-foreground", dense ? "px-1 pb-0.5 pt-2 text-[11px]" : "px-2 pb-1 pt-4 text-[12px]")}>{group.label}</h2>
            <ul className="divide-y divide-border">
              {group.rows.map((row) => (
                <StashRow key={rowKey(row)} row={row} attention={attention} now={now} dense={dense} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export function StashPage() {
  const attention = useAttention(true);
  const count = stashedRows(attention.rows, attention.overlay).length;
  const days = attention.stashAfterDays;
  return (
    <section data-nav-part="stash-page" className="h-full min-h-0 overflow-y-auto text-foreground">
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-medium">Stash</h1>
          {count > 0 ? (
            <span className="text-[12px] text-muted-foreground" style={tnum}>
              {count} {count === 1 ? "chat" : "chats"}
            </span>
          ) : null}
        </div>
        {days !== null ? <p className="max-w-[60ch] text-sm text-muted-foreground">{stashIntro(days)}</p> : null}
        <StashList attention={attention} />
      </div>
    </section>
  );
}

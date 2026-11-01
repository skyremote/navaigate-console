import { useAttention } from "./attention";
// Multi-select: ⌘-click (Ctrl on Windows) toggles a chat, ⇧-click selects a
// range, or switch on Select mode for checkboxes. The bar pins to the bottom of
// the rail with bulk actions. Delete asks once for the whole batch.
import { useState } from "react";
import { experimental_Icon as Icon, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { tnum } from "./shared";
import { Dropdown, DropItem, DropLabel, DropSeparator } from "./menu";
import { LATER_LABEL, StatusMark } from "./status-mark";
import { TAG_CSS, type RailOps } from "./rail-state";
import { useFeature } from "./use-feature";

export function BulkBar({
  ids,
  pinnedAll,
  ops,
  onClear,
  onNewTag,
}: {
  ids: string[];
  pinnedAll: boolean;
  ops: RailOps;
  onClear: () => void;
  onNewTag: () => void;
}) {
  const sdk = useSdk();
  const tagsOn = useFeature("EXTRA-Y");
  const attention = useAttention();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = ids.length;

  const run = async (verb: string, fn: (id: string) => Promise<unknown>, after?: () => Promise<unknown> | void) => {
    setBusy(true);
    const results = await Promise.allSettled(ids.map(fn));
    const failed = results.filter((r) => r.status === "rejected").length;
    await after?.();
    setBusy(false);
    if (failed) toast.error(`${verb}: ${failed} of ${n} failed`);
    else toast.success(`${verb} ${n} chat${n === 1 ? "" : "s"}`);
    onClear();
  };

  if (confirming) {
    return (
      <div className="sticky bottom-2 z-10 mx-1 mt-2 rounded-lg border border-destructive/50 bg-card p-3 shadow-lg">
        <p className="text-[13px] text-foreground">
          Delete {n} chat{n === 1 ? "" : "s"}? Any sub-agent threads under them go too. This cannot be undone.
        </p>
        <div className="mt-2.5 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirming(false)} className="h-7 rounded-md px-2.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run("Deleted", (id) => sdk.threads.delete({ threadId: id, childThreadsConfirmed: true }), () => ops.forget(ids))}
            className="h-7 rounded-md bg-destructive px-3 text-[12px] font-medium text-[var(--destructive-foreground)] disabled:opacity-50"
          >
            {busy ? "Deleting…" : `Delete ${n}`}
          </button>
        </div>
      </div>
    );
  }

  const btn = "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-foreground hover:bg-accent disabled:opacity-50 data-[state=open]:bg-accent";

  return (
    <div className="sticky bottom-2 z-10 mx-1 mt-2 flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card p-1.5 shadow-lg">
      <span className="flex items-center gap-1.5 px-1.5 text-[12px] font-medium text-foreground" style={tnum}>
        <span className="inline-flex size-4 items-center justify-center rounded-[4px] bg-foreground text-[11px] text-background">{n}</span>
        selected
      </span>
      <span className="flex-1" />
      <button type="button" className={btn} disabled={busy} onClick={() => void attention.apply(ids, "settle")}>Settle</button>
      <button type="button" className={btn} disabled={busy} onClick={() => void attention.apply(ids, "snooze", Date.now() + 3600_000)}>Snooze 1h</button>
      <Dropdown trigger={<button type="button" className={btn} disabled={busy}><Icon name="Clock" className="size-3.5" />Later</button>}>
        <DropLabel>Come back later</DropLabel>
        {(["revisit", "done", "mistake"] as const).map((r) => (
          <DropItem key={r} lead={<StatusMark reason={r} size={14} />} label={LATER_LABEL[r]} onSelect={() => { void ops.setLater(ids, r); onClear(); }} />
        ))}
        <DropSeparator />
        <DropItem icon="X" label="Clear the flag" onSelect={() => { void ops.setLater(ids, null); onClear(); }} />
      </Dropdown>
      {tagsOn ? <Dropdown trigger={<button type="button" className={btn} disabled={busy}><span aria-hidden className="inline-block size-2 rounded-[2px] bg-foreground" />Tag</button>}>
        <DropLabel>Add tag</DropLabel>
        {ops.state.tags.length === 0 ? <DropItem label="No tags yet" onSelect={() => undefined} /> : null}
        {ops.state.tags.map((t) => {
          const all = ids.every((id) => ops.state.assign[id]?.includes(t.id));
          return <DropItem key={t.id} swatch={TAG_CSS[t.color]} label={t.name} checked={all} onSelect={() => void ops.applyTag(ids, t.id, !all)} />;
        })}
        <DropSeparator />
        <DropItem icon="Plus" label="New tag…" onSelect={onNewTag} />
      </Dropdown> : null}
      <button type="button" className={btn} disabled={busy} onClick={() => run(pinnedAll ? "Unpinned" : "Pinned", (id) => (pinnedAll ? sdk.threads.unpin({ threadId: id }) : sdk.threads.pin({ threadId: id })))}>
        <Icon name="Pin" className="size-3.5" />
        {pinnedAll ? "Unpin" : "Pin"}
      </button>
      <button type="button" className={btn} disabled={busy} onClick={() => run("Archived", (id) => sdk.threads.archive({ threadId: id }), () => ops.forget(ids))}>
        <Icon name="Archive" className="size-3.5" />
        Archive
      </button>
      <button type="button" className={cn(btn, "text-destructive-text")} disabled={busy} onClick={() => setConfirming(true)}>
        <Icon name="Trash2" className="size-3.5" />
        Delete
      </button>
      <button type="button" aria-label="Clear selection" title="Clear selection (Esc)" className={btn} onClick={onClear}>
        <Icon name="X" className="size-3.5" />
      </button>
    </div>
  );
}

export { StatusMark };

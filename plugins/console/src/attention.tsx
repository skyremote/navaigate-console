import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { z } from "zod";
import type { attentionRecord, attentionRow, attentionPolicy } from "../server-attention";
import { rpcFlight } from "./rpc-flight";
import { keepIfSame } from "./stable";
import { useVisiblePoll, useVisibleRealtime } from "./visible-poll";
import { cn } from "@/lib/utils";
import { display } from "./shared";
import { useFeature } from "./use-feature";
import { ghostButton, field, pageShell, pageTitle, pageLede } from "./controls";

type Record = z.infer<typeof attentionRecord>;
export type Row = z.infer<typeof attentionRow>;
export const rowKey = (row: Row) => `${row.ownerServerId ?? "local"}/${row.threadId}`;
const ownerTarget = (row: Row) =>
  row.ownerServerId && row.ownerHostId
    ? {
        ownerServerId: row.ownerServerId,
        hostId: row.ownerHostId,
        threadId: row.threadId,
        ...(row.machine ? { machine: row.machine } : {}),
      }
    : null;
const btn = ghostButton;
const STATUS_LABEL: { [status: string]: string } = { "needs-you": "Needs you", reviewable: "Ready to review", running: "Running", waiting: "Waiting", failed: "Failed", snoozed: "Snoozed", accepted: "Accepted", stashed: "Stashed" };
const error = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));
type Action = "settle" | "snooze" | "restore" | "retitle" | "stash";
type View = { mode: Record["mode"]; wakeAt: number | null };
type Outcome = {
  receiptId: string;
  results: { ok: boolean; error: string | null }[];
};
const inflight = new Set<string>();
export const UNDO_TOAST_MS = 10_000;
const LABELS: { [A in Action]: string } = {
  settle: "Settled",
  snooze: "Snoozed",
  restore: "Back in the sidebar",
  retitle: "Renamed",
  stash: "Stashed",
};
const viewFor = (action: Action, wakeAt?: number): View | null =>
  action === "settle"
    ? { mode: "settled", wakeAt: null }
    : action === "snooze"
      ? { mode: "snoozed", wakeAt: wakeAt ?? null }
      : action === "restore"
        ? { mode: "open", wakeAt: null }
        : action === "stash"
          ? { mode: "stashed", wakeAt: null }
          : null;
const OPEN_POLICY = {
  autoMerge: false,
  requiredPrUrls: [],
  requiredPrEnvironments: {},
  acceptancePending: true,
  inactiveAfterMs: null,
};
export function overlayRecords(records: Record[], overlay: ReadonlyMap<string, View>): Record[] {
  if (!overlay.size) return records;
  const seen = new Set<string>();
  const next = records.map((r) => {
    const v = overlay.get(`local/${r.threadId}`);
    seen.add(r.threadId);
    return v ? { ...r, ...v } : r;
  });
  for (const [key, v] of overlay)
    if (key.startsWith("local/") && v.mode !== "open" && !seen.has(key.slice(6)))
      next.push({
        threadId: key.slice(6),
        ...v,
        changedAt: Date.now(),
        revision: null,
        policy: OPEN_POLICY,
      });
  return next;
}
const statusFor = (row: Row, v: View): Row["status"] =>
  v.mode === "stashed"
    ? ["accepted", "snoozed", "reviewable", "stashed"].includes(row.status)
      ? "stashed"
      : row.status
    : v.mode === "settled"
      ? ["accepted", "snoozed", "reviewable", "stashed"].includes(row.status)
        ? "accepted"
        : row.status
      : v.mode === "snoozed"
        ? ["accepted", "snoozed", "reviewable", "stashed"].includes(row.status)
          ? "snoozed"
          : row.status
        : ["accepted", "snoozed", "stashed"].includes(row.status)
          ? "reviewable"
          : row.status;
export function overlayRows(rows: Row[], overlay: ReadonlyMap<string, View>): Row[] {
  if (!overlay.size) return rows;
  return rows.map((row) => {
    const v =
      overlay.get(rowKey(row)) ?? (row.remote ? undefined : overlay.get(`local/${row.threadId}`));
    return v ? { ...row, status: statusFor(row, v), wakeAt: v.wakeAt } : row;
  });
}
export async function applyAttention(
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>,
  refresh: () => void,
  threadIds: string[],
  action: "settle" | "snooze" | "restore" | "retitle",
  wakeAt?: number,
  title?: string,
) {
  try {
    const r = await rpc.call("attention_apply", {
      threadIds,
      action,
      ...(wakeAt ? { wakeAt } : {}),
      ...(title ? { title } : {}),
    });
    const failed = r.results.filter((x) => !x.ok);
    refresh();
    if (failed.length)
      toast.error(`${failed.length} of ${r.results.length} changes failed`, {
        description: failed
          .map((x) => x.error)
          .join("; ")
          .slice(0, 500),
      });
    if (r.results.some((x) => x.ok))
      toast.success(LABELS[action], {
        duration: UNDO_TOAST_MS,
        action: {
          label: "Undo",
          onClick: () => {
            rpc.call("attention_undo", { receiptId: r.receiptId }).then((u) => {
              refresh();
              if (u.results.some((x) => !x.ok))
                toast.error("Some items changed since this receipt and could not be undone.");
            }, error);
          },
        },
      });
  } catch (e) {
    error(e);
  }
}
export function useAttention(loadRows = false, alsoRefresh?: () => unknown) {
  const rpc = useRpc<typeof rpcContract>();
  const [rawRecords, setRecords] = useState<Record[]>([]);
  const [foldWorking, setFold] = useState(false);
  const [stashAfterDays, setStashAfterDays] = useState<number | null>(null);
  const [rawRows, setRows] = useState<Row[]>([]);
  const [overlay, setOverlay] = useState<ReadonlyMap<string, View>>(new Map());
  const overlayRef = useRef(overlay);
  const records = useMemo(() => overlayRecords(rawRecords, overlay), [rawRecords, overlay]);
  const rows = useMemo(() => overlayRows(rawRows, overlay), [rawRows, overlay]);
  const live = useRef({ records, rows });
  live.current = { records, rows };
  const also = useRef(alsoRefresh);
  also.current = alsoRefresh;
  const show = (entries: [string, View][]) => {
    const next = new Map(overlayRef.current);
    for (const [key, view] of entries) next.set(key, view);
    overlayRef.current = next;
    setOverlay(next);
  };
  const hide = (keys: string[]) => {
    const next = new Map(overlayRef.current);
    for (const key of keys) next.delete(key);
    overlayRef.current = next;
    setOverlay(next);
  };
  const load = useCallback(
    (fresh: boolean): Promise<unknown> => {
      const flight = rpcFlight();
      const jobs: Promise<unknown>[] = [
        flight.call("attention_state", () => rpc.call("attention_state"), { fresh }).then(
          (s) => {
            setRecords((prev) => keepIfSame(prev, s.records));
            setFold(s.foldWorking);
            setStashAfterDays(s.stashAfterDays ?? 7);
          },
          () => {},
        ),
      ];
      if (loadRows)
        jobs.push(
          flight.call("attention_fleet_inbox", () => rpc.call("attention_fleet_inbox"), { fresh }).then(
            (s) => setRows((prev) => keepIfSame(prev, s.rows)),
            () => {},
          ),
        );
      return Promise.all(jobs);
    },
    [rpc, loadRows],
  );
  const refresh = useCallback(() => load(true), [load]);
  const poll = useCallback(() => void load(false), [load]);
  const reload = async () => {
    await Promise.all([refresh(), Promise.resolve(also.current?.()).catch(() => {})]);
  };
  useEffect(poll, [poll]);
  useVisibleRealtime("attention", () => void refresh());
  useVisiblePoll(poll, 15_000);
  const currentView = (key: string): View => {
    if (key.startsWith("local/")) {
      const r = live.current.records.find((x) => x.threadId === key.slice(6));
      if (r) return { mode: r.mode, wakeAt: r.wakeAt };
    }
    const row = live.current.rows.find(
      (x) => rowKey(x) === key || (!x.remote && `local/${x.threadId}` === key),
    );
    return row?.status === "accepted"
      ? { mode: "settled", wakeAt: null }
      : row?.status === "stashed"
        ? { mode: "stashed", wakeAt: null }
        : row?.status === "snoozed"
          ? { mode: "snoozed", wakeAt: row.wakeAt }
          : { mode: "open", wakeAt: null };
  };
  const optimistic = async (job: {
    keys: string[];
    action: Action;
    wakeAt?: number;
    send(): Promise<Outcome>;
    undo(receiptId: string): Promise<Outcome>;
    failed(failed: number, total: number): string;
    unconfirmed(e: unknown): void;
    undoFailed: string;
  }) => {
    const { keys, action } = job;
    const flight = keys.map((k) => `${action}:${k}`);
    for (const f of flight) inflight.add(f);
    const view = viewFor(action, job.wakeAt);
    const before = keys.map((k): [string, View] => [k, currentView(k)]);
    if (view) show(keys.map((k): [string, View] => [k, view]));
    let receiptId: string | null = null;
    let undoRequested = false;
    const undoNow = async () => {
      try {
        const u = await job.undo(receiptId!);
        if (u.results.some((x) => !x.ok)) toast.error(job.undoFailed);
      } catch (e) {
        error(e);
      }
    };
    const toastId = toast.success(LABELS[action], {
      duration: UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (undoRequested) return;
          undoRequested = true;
          if (view) show(before);
          if (receiptId)
            void undoNow()
              .then(() => reload())
              .then(() => hide(keys));
        },
      },
    });
    try {
      const r = await job.send();
      receiptId = r.receiptId;
      const failures = r.results.filter((x) => !x.ok);
      const anyOk = r.results.some((x) => x.ok);
      if (undoRequested && anyOk) await undoNow();
      await reload();
      hide(keys);
      if (failures.length)
        toast.error(job.failed(failures.length, r.results.length), {
          description: failures
            .map((x) => x.error)
            .join("; ")
            .slice(0, 600),
        });
      if (!anyOk) toast.dismiss(toastId);
    } catch (e) {
      toast.dismiss(toastId);
      await reload();
      hide(keys);
      job.unconfirmed(e);
    } finally {
      for (const f of flight) inflight.delete(f);
    }
  };
  const apply = async (threadIds: string[], action: Action, wakeAt?: number, title?: string) => {
    const ids = [...new Set(threadIds)].filter((id) => !inflight.has(`${action}:local/${id}`));
    if (!ids.length) return;
    await optimistic({
      keys: ids.map((id) => `local/${id}`),
      action,
      ...(wakeAt ? { wakeAt } : {}),
      send: () =>
        rpc.call("attention_apply", {
          threadIds: ids,
          action,
          ...(wakeAt ? { wakeAt } : {}),
          ...(title ? { title } : {}),
        }),
      undo: (receiptId) => rpc.call("attention_undo", { receiptId }),
      failed: (n, total) => `${n} of ${total} changes failed`,
      unconfirmed: error,
      undoFailed: "Some items changed since this receipt and could not be undone.",
    });
  };
  const applyRows = async (scope: Row[], action: Action, wakeAt?: number, title?: string) => {
    if (scope.every((row) => !row.remote && !ownerTarget(row)))
      return apply(
        scope.map((row) => row.threadId),
        action,
        wakeAt,
        title,
      );
    const fresh = scope.filter((row) => !inflight.has(`${action}:${rowKey(row)}`));
    if (!fresh.length) return;
    const targets = fresh.map(ownerTarget);
    if (targets.some((target) => !target)) {
      toast.error("An attention owner is unresolved; refresh before applying this scope.");
      return;
    }
    const requestId = crypto.randomUUID();
    await optimistic({
      keys: fresh.map(rowKey),
      action,
      ...(wakeAt === undefined ? {} : { wakeAt }),
      send: () =>
        rpc.call("attention_fleet_apply", {
          requestId,
          targets: targets.filter((t): t is NonNullable<typeof t> => t !== null),
          action,
          ...(wakeAt === undefined ? {} : { wakeAt }),
          ...(title ? { title } : {}),
        }),
      undo: (receiptId) =>
        rpc.call("attention_fleet_undo", {
          receiptId,
          requestId: crypto.randomUUID(),
        }),
      failed: (n, total) => `${n} of ${total} owner actions failed`,
      undoFailed: "Some owner Undo actions could not be confirmed.",
      unconfirmed: (e) =>
        toast.error("Attention outcome needs a receipt check", {
          description: `Request ${requestId}: ${String(e)}`,
          action: {
            label: "Check receipt",
            onClick: () => {
              rpc
                .call("attention_fleet_receipt", { requestId })
                .then(
                  (r) =>
                    toast.success(
                      r.results.every((x) => x.ok)
                        ? "Owner action confirmed"
                        : "Some owner effects are still unconfirmed",
                    ),
                  error,
                );
            },
          },
        }),
    });
  };
  return {
    records,
    rows,
    overlay,
    foldWorking,
    stashAfterDays,
    refresh: reload,
    apply,
    applyRows,
    async fold(value: boolean) {
      try {
        const s = await rpc.call("attention_fold", { value });
        setFold(s.foldWorking);
      } catch (e) {
        error(e);
      }
    },
  };
}
export function attentionVisible(
  thread: { id: string; isPinned: boolean },
  status: string,
  records: Record[],
  foldWorking: boolean,
  now = Date.now(),
) {
  const r = records.find((r) => r.threadId === thread.id);
  if (r?.mode === "stashed" && status !== "running" && status !== "needs") return false;
  if (status === "needs" || status === "error" || status === "failed") return true;
  if (r?.mode === "settled" || (r?.mode === "snoozed" && (r.wakeAt ?? 0) > now)) return false;
  return !foldWorking || status !== "running" || thread.isPinned;
}
export function AttentionRailControl({
  attention,
  running,
}: {
  attention: ReturnType<typeof useAttention>;
  running: number;
}) {
  return (
    <div className="mx-1 flex items-center justify-between text-muted-foreground">
      <span className="text-[11px]">{running} working</span>
      <button
        className={btn}
        type="button"
        aria-pressed={attention.foldWorking}
        onClick={() => void attention.fold(!attention.foldWorking)}
      >
        {attention.foldWorking ? "Show working" : "Fold working"}
      </button>
    </div>
  );
}
/** Mobile gesture is scoped to this plugin-owned row. Native thread rows remain host-owned. */
export function AttentionSwipeRow({
  row,
  children,
  onSettle,
  onSnooze,
}: {
  row: Row;
  children: React.ReactNode;
  onSettle(): void;
  onSnooze(): void;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const swipeOn = useFeature("F41");
  const down = (e: TouchEvent) => {
    start.current = null;
    if (!swipeOn) return;
    const t = e.touches[0];
    if (e.touches.length === 1 && t && !(e.target as HTMLElement).closest("button,a,input,select"))
      start.current = { x: t.clientX, y: t.clientY };
  };
  const up = (e: TouchEvent) => {
    const t = e.changedTouches[0],
      s = start.current;
    start.current = null;
    if (!t || !s || e.touches.length > 0 || Math.abs(t.clientY - s.y) > 35) return;
    const dx = t.clientX - s.x;
    if (dx < -90) onSnooze();
    if (dx > 90 && !["running", "waiting", "needs-you"].includes(row.status)) onSettle();
  };
  return (
    <li
      onTouchStart={down}
      onTouchEnd={up}
      onTouchCancel={() => {
        start.current = null;
      }}
      className="rounded-md border border-border p-3"
      style={{ touchAction: "pan-y" }}
    >
      {children}
    </li>
  );
}
const inboxGroups: { key: string; label: string; statuses: Row["status"][] }[] = [
  { key: "failed", label: "Failed", statuses: ["failed"] },
  { key: "question", label: "Questions", statuses: ["needs-you"] },
  { key: "review", label: "Ready to review", statuses: ["reviewable"] },
  { key: "working", label: "Working", statuses: ["running", "waiting"] },
];
export function groupInboxRows(rows: Row[]) {
  return inboxGroups
    .map((g) => ({
      ...g,
      rows: rows.filter((r) => g.statuses.includes(r.status)),
    }))
    .filter((g) => g.rows.length > 0);
}
/** Opens an attention row's chat: the local thread, or the local copy of one that runs on another Mac. */
export function useOpenRow() {
  const rpc = useRpc<typeof rpcContract>(),
    nav = useBbNavigate();
  return (row: Row) => {
    if (row.remote) {
      if (!row.machine) return error("Owner machine is unresolved.");
      rpc
        .call("fleet_mirror_open", { machine: row.machine, threadId: row.threadId })
        .then((r) => nav.toThread(r.localThreadId), error);
    } else nav.toThread(row.threadId);
  };
}
export function AttentionPage() {
  const rpc = useRpc<typeof rpcContract>(),
    openRow = useOpenRow();
  const [rows, setRows] = useState<Row[]>([]),
    [err, setErr] = useState<string | null>(null),
    [view, setView] = useState("inbox"),
    [selected, setSelected] = useState<string[]>([]),
    [title, setTitle] = useState(""),
    [wake, setWake] = useState("");
  const load = useCallback(
    (fresh: boolean) =>
      rpcFlight()
        .call("attention_fleet_inbox", () => rpc.call("attention_fleet_inbox"), { fresh })
        .then(
          (r) => {
            setRows(r.rows);
            setErr(
              [
                ...(r.truncated ? ["Showing the first 2,000 local owning threads."] : []),
                ...(r.notices ?? []),
              ].join("; ") || null,
            );
          },
          (e) => setErr(String(e)),
        ),
    [rpc],
  );
  const refresh = useCallback(() => load(true), [load]);
  const poll = useCallback(() => void load(false), [load]);
  const attention = useAttention(false, refresh);
  useEffect(poll, [poll]);
  useVisibleRealtime("attention", () => void refresh());
  useVisiblePoll(poll, 15_000);
  const shown = overlayRows(rows, attention.overlay).filter((r) =>
    view === "all" || view === "accepted" || view === "stashed"
      ? view === "all" || r.status === (view === "stashed" ? "stashed" : "accepted")
      : view === "snoozed"
        ? r.status === "snoozed"
        : !["accepted", "snoozed", "stashed"].includes(r.status) &&
          (!attention.foldWorking || r.status !== "running" || r.pinned),
  );
  const selectedRows = overlayRows(rows, attention.overlay).filter((row) =>
    selected.includes(rowKey(row)),
  );
  const snooze = (scope: Row[]) =>
    void attention.applyRows(
      scope,
      "snooze",
      wake ? new Date(wake).getTime() : Date.now() + 3600_000,
    );
  const renderRows = (items: Row[], labelledBy?: string) => (
    <ul className="space-y-2" aria-labelledby={labelledBy}>
      {items.map((row) => (
        <AttentionSwipeRow
          key={rowKey(row)}
          row={row}
          onSettle={() => void attention.applyRows([row], "settle")}
          onSnooze={() => snooze([row])}
        >
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label={`Select ${row.title}`}
              checked={selected.includes(rowKey(row))}
              onChange={(e) =>
                setSelected((s) =>
                  e.target.checked ? [...s, rowKey(row)] : s.filter((id) => id !== rowKey(row)),
                )
              }
            />
            <button
              className={`${btn} text-left font-medium text-foreground`}
              onClick={() => openRow(row)}
            >
              {row.title}
            </button>
            <span className={cn("ml-auto text-xs", row.status === "running" ? "text-attention" : row.status === "failed" ? "text-destructive-text" : "text-muted-foreground")}>{STATUS_LABEL[row.status] ?? row.status}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Owner: {row.machine ?? "this server"} · Host: {row.hostId ?? "not set"}
            {row.wakeAt ? ` · Returns ${new Date(row.wakeAt).toLocaleString()}` : ""}
          </p>
          {row.question && <p className="mt-2 whitespace-pre-wrap text-sm">{row.question}</p>}
          <div className="mt-2 flex flex-wrap gap-1">
            <button
              className={btn}
              disabled={["running", "waiting", "needs-you"].includes(row.status)}
              onClick={() => void attention.applyRows([row], "settle")}
            >
              Settle
            </button>
            <button className={btn} onClick={() => snooze([row])}>
              Snooze
            </button>
            {!["running", "waiting", "needs-you", "stashed"].includes(row.status) && (
              <button className={btn} onClick={() => void attention.applyRows([row], "stash")}>
                Stash
              </button>
            )}
            {["accepted", "snoozed", "stashed"].includes(row.status) && (
              <button className={btn} onClick={() => void attention.applyRows([row], "restore")}>
                {row.status === "stashed" ? "Back to sidebar" : "Restore"}
              </button>
            )}
            <AttentionPolicy
              threadId={row.threadId}
              row={row}
              record={attention.records.find((r) => r.threadId === row.threadId)}
            />
          </div>
        </AttentionSwipeRow>
      ))}
    </ul>
  );
  return (
    <div data-nav-part="work-needs-you-scroll" className="h-full min-h-0 overflow-y-auto">
      <section data-nav-part="work-needs-you-page" className={pageShell}>
        <h1 className={pageTitle} style={display}>Work needs you</h1>
        <p className={pageLede}>
          Questions, failures and work ready to review, from the server that owns each chat. You decide
          when work is done.
        </p>
        <AttentionRailControl
          attention={attention}
          running={rows.filter((r) => r.status === "running").length}
        />
        <div className="flex flex-wrap gap-2">
          <select
            className={field}
            aria-label="Attention view"
            value={view}
            onChange={(e) => {
              setView(e.target.value);
              setSelected([]);
            }}
          >
            {["inbox", "snoozed", "accepted", "stashed", "all"].map((v) => (
              <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            Snooze until
            <input
              className={field}
              type="datetime-local"
              value={wake}
              onChange={(e) => setWake(e.target.value)}
            />
          </label>
          <button className={btn} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {selected.length > 0 && (
          <div className="rounded-md border border-border p-2">
            <p className="text-xs">
              Apply to {selected.length} selected owning threads. Each result is reported separately.
            </p>
            <button className={btn} onClick={() => void attention.applyRows(selectedRows, "settle")}>
              Settle selected
            </button>
            <button className={btn} onClick={() => snooze(selectedRows)}>
              Snooze selected
            </button>
            <input
              className={field}
              aria-label="New title for selected threads"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button
              className={btn}
              disabled={!title.trim()}
              onClick={() => void attention.applyRows(selectedRows, "retitle", undefined, title)}
            >
              Retitle selected
            </button>
            <button className={btn} onClick={() => setSelected([])}>
              Clear selection
            </button>
          </div>
        )}
        {err && (
          <p role="alert" className="text-sm">
            {err}
          </p>
        )}
        {view === "inbox"
          ? groupInboxRows(shown).map((g) => (
              <div key={g.key} className="space-y-2">
                <h2 id={`attention-group-${g.key}`} className="text-sm font-medium">
                  {g.label} ({g.rows.length})
                </h2>
                {renderRows(g.rows, `attention-group-${g.key}`)}
              </div>
            ))
          : renderRows(shown)}
        {shown.length === 0 && <p className="text-sm text-muted-foreground">No work in this view</p>}
        <AutomationAttention />
      </section>
    </div>
  );
}
function AttentionPolicy(props: { threadId: string; record?: Record; row?: Row }) {
  return useFeature("F40") ? <AttentionPolicyBody {...props} /> : null;
}
function AttentionPolicyBody({
  threadId,
  record,
  row,
}: {
  threadId: string;
  record?: Record;
  row?: Row;
}) {
  const mergeOn = useFeature("F39");
  const inactivityOn = useFeature("F43");
  const rpc = useRpc<typeof rpcContract>();
  const current = row?.policy ??
    record?.policy ?? {
      autoMerge: false,
      requiredPrUrls: [],
      requiredPrEnvironments: {},
      acceptancePending: true,
      inactiveAfterMs: null,
    };
  const [open, setOpen] = useState(false),
    [policy, setPolicy] = useState<z.infer<typeof attentionPolicy>>(current);
  return (
    <>
      <button
        className={btn}
        onClick={() => {
          setPolicy(current);
          setOpen(!open);
        }}
      >
        Automatic settlement
      </button>
      {open && (
        <fieldset className="w-full space-y-2 rounded-md border border-border p-3 text-xs">
          <legend>Settlement choices for this thread</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={policy.acceptancePending}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  acceptancePending: e.target.checked,
                }))
              }
            />
            Delivery checks are still outstanding — keep this thread open
          </label>
          {mergeOn && <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={policy.autoMerge}
              onChange={(e) => setPolicy((p) => ({ ...p, autoMerge: e.target.checked }))}
            />
            Settle after every required pull request merges
          </label>}
          {mergeOn && policy.autoMerge && (
            <div className="space-y-2">
              <label className="block">
                Required PR URLs, one per line
                <textarea
                  className={`${field} mt-1 min-h-16 w-full`}
                  value={policy.requiredPrUrls.join("\n")}
                  onChange={(e) =>
                    setPolicy((p) => ({
                      ...p,
                      requiredPrUrls: e.target.value.split("\n").filter(Boolean).slice(0, 20),
                    }))
                  }
                />
              </label>
              {policy.requiredPrUrls.length > 1 &&
                policy.requiredPrUrls.map((url) => (
                  <label className="block" key={url}>
                    Workspace ID for {url}
                    <input
                      className={`${field} mt-1 w-full`}
                      value={policy.requiredPrEnvironments[url] ?? ""}
                      onChange={(e) =>
                        setPolicy((p) => ({
                          ...p,
                          requiredPrEnvironments: {
                            ...p.requiredPrEnvironments,
                            [url]: e.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                ))}
            </div>
          )}
          {inactivityOn && <label className="block">
            Settle after inactivity
            <select
              className={`${field} ml-2`}
              value={policy.inactiveAfterMs ?? "off"}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  inactiveAfterMs: e.target.value === "off" ? null : Number(e.target.value),
                }))
              }
            >
              <option value="off">Disabled</option>
              {policy.inactiveAfterMs !== null &&
                ![86400_000, 3 * 86400_000, 7 * 86400_000, 30 * 86400_000].includes(
                  policy.inactiveAfterMs,
                ) && (
                  <option value={policy.inactiveAfterMs}>
                    {Math.round(policy.inactiveAfterMs / 3600_000)} hours (custom)
                  </option>
                )}
              <option value={86400_000}>One day</option>
              <option value={3 * 86400_000}>Three days</option>
              <option value={7 * 86400_000}>One week</option>
              <option value={30 * 86400_000}>Thirty days</option>
            </select>
          </label>}
          <p className="text-muted-foreground">
            Active work, waiting jobs, pending decisions and pinned threads stay open. Restore and
            Undo remain available.
          </p>
          <button
            className={btn}
            onClick={() =>
              (() => {
                const target = row ? ownerTarget(row) : null;
                if (row?.remote && (!target || !row.policy))
                  return error("Current owner policy is unavailable; refresh before editing it.");
                if (target)
                  rpc
                    .call("attention_fleet_policy", {
                      requestId: crypto.randomUUID(),
                      target,
                      policy,
                    })
                    .then((r) => {
                      if (r.results.some((x) => !x.ok))
                        return error(r.results.map((x) => x.error).join("; "));
                      toast.success("Settlement choices saved by owner");
                      setOpen(false);
                    }, error);
                else
                  rpc.call("attention_policy", { threadId, policy }).then(() => {
                    toast.success("Settlement choices saved");
                    setOpen(false);
                  }, error);
              })()
            }
          >
            Save choices
          </button>
        </fieldset>
      )}
    </>
  );
}
export function AttentionUsage() {
  const rpc = useRpc<typeof rpcContract>();
  const [summary, setSummary] = useState("");
  const [scope, setScope] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const read = useCallback(
    () =>
      rpcFlight().call("attention_usage", () => rpc.call("attention_usage")).then(
        (r) => {
          if (alive.current) {
            setScope(r.scope);
            setSummary(
              r.subscriptions
                .filter((s) => s.remainingPercent !== null)
                .map(
                  (s) =>
                    `${s.label} ${s.window}: ${Math.round(s.remainingPercent!)}% remaining${s.resetsAt ? ` · resets ${new Date(s.resetsAt).toLocaleString()}` : ""}`,
                )
                .join(" | "),
            );
          }
        },
        () => {
          if (alive.current)
            setScope("Usage refresh unavailable; the previous observation may be stale.");
        },
      ),
    [rpc],
  );
  useEffect(() => {
    void read();
  }, [read]);
  useVisiblePoll(() => void read(), 60_000);
  return summary ? (
    <p className="px-2 text-[11px] text-muted-foreground" title={scope}>
      {summary}
      <span className="block text-muted-foreground">{scope}</span>
    </p>
  ) : null;
}
const RETRY_REASON: { [reason: string]: string } = {
  "not-retryable": "the error was not a usage limit or a temporary provider error",
  "attempts-exhausted": "it had already retried as many times as it is allowed",
  "beyond-maximum-wait": "the limit resets later than BB is willing to wait",
  "no-rate-limit-state": "the provider did not say when the limit resets",
  "not-resettable": "this limit does not reset by itself",
  "pool-unavailable": "the account pool could not say when an account is free",
  "source-unavailable": "the account pool could not be reached",
};
const retryReason = (reason: string) => RETRY_REASON[reason] ?? reason.replace(/-/g, " ");
type RetryDecisionView = { kind: "retry" | "decline"; reason: string; observedAt: number; sendAt: number | null };
export function RetryAttention({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<{ id: string; threadId: string; sendAt: number | null }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [decision, setDecision] = useState<RetryDecisionView | null>(null);
  useEffect(() => {
    setRows(null);
    setFailed(false);
    setDecision(null);
  }, [threadId]);
  const load = useCallback(
    (fresh: boolean) => {
      rpcFlight().call(`attention_retries:${threadId}`, () => rpc.call("attention_retries", { threadId }), { fresh }).then(
        (r) => {
          setRows(r.retries);
          setFailed(false);
        },
        () => setFailed(true),
      );
      rpcFlight().call(`attention_retry_decision:${threadId}`, () => rpc.call("attention_retry_decision", { threadId }), { fresh }).then(
        (r) => setDecision(r.decision),
        () => {},
      );
    },
    [rpc, threadId],
  );
  const read = useCallback(() => load(false), [load]);
  const readFresh = useCallback(() => load(true), [load]);
  useEffect(read, [read]);
  useVisiblePoll(read, 15_000);
  return (
    <div className="grid gap-2 p-3 text-xs">
      {failed ? <p className="text-muted-foreground">Could not read the retries for this chat. It tries again in 15 seconds.</p> : rows === null ? <p className="text-muted-foreground">Reading retries for this chat</p> : null}
      {rows?.map((r) => (
        <p key={r.id}>
          Provider Retry: {r.sendAt ? new Date(r.sendAt).toLocaleString() : "waiting"}
          <button
            className={btn}
            onClick={() =>
              rpc.call("attention_retry_cancel", { threadId, id: r.id }).then(readFresh, error)
            }
          >
            Cancel retry
          </button>
        </p>
      ))}
      {!failed && rows?.length === 0 ? (
        <>
          <p className="text-foreground">No retry is waiting for this chat.</p>
          <p className="text-muted-foreground">
            If this chat stops at a usage limit or a temporary provider error, BB keeps your message and sends it again when it can. The retry and its send time show here, with a button to cancel it.
          </p>
        </>
      ) : null}
      {decision ? (
        <p className="text-muted-foreground" data-nav-part="retry-last-decision">
          Last check, {new Date(decision.observedAt).toLocaleString()}:{" "}
          {decision.kind === "retry"
            ? `retry planned${decision.sendAt ? ` for ${new Date(decision.sendAt).toLocaleString()}` : ""}`
            : `no retry, because ${retryReason(decision.reason)}`}
          .
        </p>
      ) : null}
    </div>
  );
}
function AutomationAttention() {
  return useFeature("F44") ? <AutomationAttentionBody /> : null;
}
function AutomationAttentionBody() {
  const nav = useBbNavigate(),
    rpc = useRpc<typeof rpcContract>();
  const [tasks, setTasks] = useState<
    Awaited<ReturnType<typeof rpc.call<"attention_automations">>>["automations"]
  >([]);
  const [events, setEvents] = useState<Awaited<
    ReturnType<typeof rpc.call<"attention_events">>
  > | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const run = async (projectId: string, automationId: string) => {
    const idempotencyKey = keys.current.get(automationId) ?? crypto.randomUUID();
    keys.current.set(automationId, idempotencyKey);
    setBusy(automationId);
    try {
      const result = await rpc.call("attention_automation_run", {
        projectId,
        automationId,
        idempotencyKey,
      });
      toast.success(`Automation accepted: ${result.run.id}`);
      keys.current.delete(automationId);
    } catch (e) {
      error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm">Recurring tasks and webhook receipts</summary>
      <p className="my-2 text-xs text-muted-foreground">
        Create recurring tasks with an explicit host, timezone and result destination. Webhooks run
        a preconfigured task.
      </p>
      <button
        className={btn}
        onClick={() =>
          nav.toCompose({
            initialPrompt:
              "Create a recurring agent task using BB Automations. Ask me for the owning host, timezone, schedule, scoped task and result destination before creating it.",
          })
        }
      >
        Create recurring task
      </button>
      <button
        className={btn}
        onClick={() =>
          rpc.call("attention_automations").then((r) => setTasks(r.automations), error)
        }
      >
        Refresh tasks
      </button>
      <button className={btn} onClick={() => rpc.call("attention_events").then(setEvents, error)}>
        Refresh webhook receipts
      </button>
      <ul className="space-y-2">
        {tasks.map(({ automation: task, project }) => (
          <li key={task.id} className="rounded-md border border-border p-3 text-xs">
            <strong>{task.name}</strong>
            <span>
              {" "}
              · {project.name} · {task.enabled ? "scheduled" : "paused"}
            </span>
            <p>
              {task.nextRunAt
                ? `Next run ${new Date(task.nextRunAt).toLocaleString()}`
                : "No next scheduled run"}{" "}
              · Last result: {task.lastRunStatus ?? "none"}
            </p>
            <button
              className={btn}
              disabled={busy !== null}
              onClick={() => void run(project.id, task.id)}
            >
              Run now
            </button>
            {task.lastRunThreadId && (
              <button className={btn} onClick={() => nav.toThread(task.lastRunThreadId!)}>
                Open result
              </button>
            )}
          </li>
        ))}
      </ul>
      {events && (
        <div className="mt-3 space-y-2 text-xs">
          <p>
            Webhook ingress: {events.enabled ? "enabled" : "disabled"}
            {events.endpoint ? ` · ${events.endpoint}` : " · public origin unconfigured"}
          </p>
          {events.hooks.map((h) => (
            <p key={h.id}>
              {h.id} · {h.ownerServerId}/{h.hostId} · {h.enabled ? "enabled" : "disabled"} · offline
              holding {h.holdOffline ? "on" : "off"}
            </p>
          ))}
          <ul>
            {events.receipts.map((r) => (
              <li className="border-t border-border py-2" key={r.id}>
                {r.hookId}: {r.state} · {r.count} event(s) ·{" "}
                {new Date(r.receivedAt).toLocaleString()}
                {r.runId ? ` · owner run ${r.runId}` : ""}
                {r.error && <p>{r.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Create webhook tasks, generate the signing secret and send a test event from the
        Automation webhooks section of this plugin's settings.
      </p>
    </details>
  );
}

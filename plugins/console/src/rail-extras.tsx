// Small rail pieces that read from the Console server: the account a chat runs
// on, an owner-sourced pull-request badge, and the two links to Work needs you
// and the Stash.
import { useCallback, useEffect, useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { AttentionPr } from "../server-attention";
import type { ThreadAccounts } from "../server-usage-trend";
import type { Row } from "./attention";
import { rpcFlight } from "./rpc-flight";
import { tnum } from "./shared";
import { useFeature } from "./use-feature";
import { useVisiblePoll } from "./visible-poll";
import { machineName } from "./words";

export type ThreadAccount = ThreadAccounts["threads"][string];

const sameAccounts = (prev: ReadonlyMap<string, ThreadAccount>, next: ThreadAccounts["threads"]) =>
  prev.size === Object.keys(next).length && JSON.stringify([...prev]) === JSON.stringify(Object.entries(next));

/** The account each recent chat ran its last turn on. Chats with no turn in the last day have none. */
export function useThreadAccounts(): ReadonlyMap<string, ThreadAccount> {
  const rpc = useRpc<typeof rpcContract>();
  const [accounts, setAccounts] = useState<ReadonlyMap<string, ThreadAccount>>(() => new Map());
  const load = useCallback(() => {
    void rpcFlight()
      .call("thread_accounts", () => rpc.call("thread_accounts"))
      .then(
        (r) => setAccounts((prev) => (sameAccounts(prev, r.threads) ? prev : new Map(Object.entries(r.threads)))),
        () => {},
      );
  }, [rpc]);
  useEffect(load, [load]);
  useVisiblePoll(load, 60_000);
  return accounts;
}

export function AccountTag({ account }: { account: ThreadAccount }) {
  return (
    <span
      data-nav-part="account"
      data-harness={account.harness}
      title={`Runs on the ${account.email ?? account.label} account`}
      aria-label={`Account ${account.label}`}
      className="shrink-0 rounded-[4px] border border-border px-1 text-[11px] font-normal leading-4 text-muted-foreground"
    >
      {account.label}
    </span>
  );
}

const CHECKS_WORD: Record<AttentionPr["checks"], string> = {
  passing: "checks passing",
  failing: "checks failing",
  pending: "checks running",
  none: "no checks",
};

export function prTitle(pr: AttentionPr, machine?: string): string {
  const where = machine ? ` on ${machineName(machine)}` : "";
  const failed = pr.checks === "failing" && pr.failedCount > 0 ? ` (${pr.failedCount})` : "";
  return `PR #${pr.number}${where}: ${pr.state}, ${CHECKS_WORD[pr.checks]}${failed}`;
}

const glyph = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** The pull request the owning Mac sees for this chat: number, then a cross, dot or tick for its checks. */
export function PrBadge({ pr, machine }: { pr: AttentionPr; machine?: string }) {
  return (
    <span
      data-nav-part="pr-badge"
      data-checks={pr.checks}
      title={prTitle(pr, machine)}
      aria-label={prTitle(pr, machine)}
      className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded-[4px] border border-border px-1 font-mono text-[11px] font-normal leading-none text-muted-foreground"
      style={tnum}
    >
      <svg {...glyph} className="size-2.5">
        {pr.state === "merged" ? (
          <path d="M4 3v10M4 8c0-3 8-1 8 3" />
        ) : (
          <path d="M4 3v10M12 13V7a3 3 0 0 0-3-3H7M9 2 7 4l2 2" />
        )}
      </svg>
      {pr.number}
      {pr.checks === "failing" ? (
        <svg {...glyph} className="size-2.5 text-destructive-text">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      ) : null}
      {pr.checks === "pending" ? <span aria-hidden className="size-[5px] rounded-full bg-muted-foreground" /> : null}
      {pr.checks === "passing" ? (
        <svg {...glyph} className="size-2.5" style={{ color: "var(--success)" }}>
          <path d="m3 8.5 3.2 3L13 4.5" />
        </svg>
      ) : null}
    </span>
  );
}

/** PR by owner machine and owner thread id, from the attention rows the owners publish. */
export function prByOwnerThread(rows: readonly Row[]): ReadonlyMap<string, AttentionPr> {
  const out = new Map<string, AttentionPr>();
  for (const row of rows) if (row.pr && row.remote && row.machine) out.set(`${row.machine}:${row.threadId}`, row.pr);
  return out;
}

export function stashLinkTitle(days: number | null): string {
  if (days === 0) return "Open the Stash. It is switched off in Settings, so no chat moves here by itself";
  const age = days === null ? "a while" : `${days} day${days === 1 ? "" : "s"}`;
  return `Open the Stash: chats outside folders that you have not touched for ${age}. Open one and carry on, and it moves back to your list`;
}

export function RailLinks({ rows, stashOpen, stashDays = null, onToggleStash }: { rows: readonly Row[]; stashOpen: boolean; stashDays?: number | null; onToggleStash: () => void }) {
  const nav = useBbNavigate();
  const showNeeds = useFeature("F30");
  const showStash = useFeature("EXTRA-A");
  const needs = rows.filter((r) => r.status === "failed" || r.status === "needs-you").length;
  const stashed = rows.filter((r) => r.status === "stashed").length;
  const link =
    "group/link relative isolate flex h-8 w-full items-center gap-2.5 rounded-md pr-2 text-left text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";
  return (
    <div data-nav-part="rail-links" className="mx-0 mb-2 mt-1">
      {showNeeds ? <button type="button" data-nav-part="rail-link" className={link} style={{ paddingLeft: 9 }} onClick={() => nav.toPluginPanel("work-needs-you")} title="Failed, questions, ready to review and working, grouped">
        <span aria-hidden className="nav-fade pointer-events-none absolute inset-0 -z-10 rounded-md bg-[var(--state-hover)] opacity-0 group-hover/link:opacity-100" />
        <Icon name="Inbox" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Work needs you</span>
        {needs > 0 ? (
          <span data-nav-part="link-count" className={cn("shrink-0 text-[11px] font-medium text-destructive-text")} style={tnum}>
            {needs}
          </span>
        ) : null}
      </button> : null}
      {showStash ? <div className="flex items-center">
        <button type="button" data-nav-part="rail-link" className={link} style={{ paddingLeft: 9 }} onClick={() => nav.toPluginPanel("stash")} title={stashLinkTitle(stashDays)}>
          <span aria-hidden className="nav-fade pointer-events-none absolute inset-0 -z-10 rounded-md bg-[var(--state-hover)] opacity-0 group-hover/link:opacity-100" />
          <Icon name="Archive" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Stash</span>
          {stashed > 0 ? (
            <span data-nav-part="link-count" className="shrink-0 text-[11px] text-muted-foreground" style={tnum}>
              {stashed}
            </span>
          ) : null}
        </button>
        {stashed > 0 ? (
          <button
            type="button"
            aria-expanded={stashOpen}
            aria-label={stashOpen ? "Hide stashed chats" : "Show stashed chats"}
            onClick={onToggleStash}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="ChevronRight" className={cn("size-3.5 transition-transform", stashOpen && "rotate-90")} />
          </button>
        ) : null}
      </div> : null}
    </div>
  );
}

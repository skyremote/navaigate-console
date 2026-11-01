import type { Command, SentReceipt } from "../server";

export type BoardCommand = Command;

export interface SentRow {
  key: string;
  kind: "ask" | "tell" | "start";
  machine: string;
  title: string | null;
  threadId: string | null;
  url: string | null;
  at: number;
  status: string;
  canRead: boolean;
  readId: string;
}

const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;

export function isReceiptId(value: string): boolean {
  return RECEIPT_ID.test(value.trim());
}

export function statusLabel(row: { kind: "ask" | "tell"; status: string; delivery: string | null }): string {
  if (row.status === "dispatching" || row.status === "unknown") return "result not known: check before sending again";
  if (row.status === "unavailable") return "not sent";
  if (row.status === "rejected") return "refused";
  if (row.kind === "tell") return row.delivery === "queued" ? "queued on the machine" : "delivered";
  return row.delivery === "started" ? "started" : "sent, waiting for the machine";
}

/** Receipts of what this Mac sent, with older brain commands that have no receipt of their own, newest first. */
export function mergeSent(commands: BoardCommand[], receipts: SentReceipt[]): SentRow[] {
  const covered = new Set(receipts.map((receipt) => receipt.commandId).filter((id): id is string => id !== null));
  const fromReceipts: SentRow[] = receipts.map((receipt) => ({
    key: `receipt:${receipt.id}`, kind: receipt.kind, machine: receipt.machine ?? "?", title: null, threadId: receipt.threadId, url: receipt.url, at: receipt.updatedAt,
    status: statusLabel(receipt), canRead: receipt.kind === "ask" && receipt.status === "completed", readId: receipt.id,
  }));
  const fromCommands: SentRow[] = commands.filter((command) => !covered.has(command.id)).map((command) => ({
    key: `command:${command.id}`, kind: "start" as const, machine: command.targetMachine, title: command.title, threadId: null, url: command.threadUrl, at: command.createdAt,
    status: command.status === "pending" ? "waiting for machine" : command.status, canRead: command.status === "started", readId: command.id,
  }));
  return [...fromReceipts, ...fromCommands].sort((a, b) => b.at - a.at);
}

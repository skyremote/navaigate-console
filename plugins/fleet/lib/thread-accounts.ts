import { z } from "zod";
import { threadAccountSchema, type ThreadAccount } from "../model";

const answerSchema = z.object({ threads: z.record(z.string(), z.unknown()) });

export const THREAD_ACCOUNTS_TTL_MS = 60_000;

export interface ThreadAccountsOptions {
  read: () => Promise<unknown>;
  ttlMs?: number;
  now?: () => number;
}

/** The account per chat from the Console, read at most once a window and never fatal to a snapshot. */
export function createThreadAccounts({ read, ttlMs = THREAD_ACCOUNTS_TTL_MS, now = Date.now }: ThreadAccountsOptions) {
  let held: { at: number; accounts: ReadonlyMap<string, ThreadAccount> } | null = null;
  let inflight: Promise<ReadonlyMap<string, ThreadAccount>> | null = null;

  const refresh = async (): Promise<ReadonlyMap<string, ThreadAccount>> => {
    const accounts = new Map<string, ThreadAccount>(held?.accounts);
    try {
      const answer = answerSchema.safeParse(await read());
      if (answer.success) {
        accounts.clear();
        for (const [threadId, entry] of Object.entries(answer.data.threads)) {
          const account = threadAccountSchema.safeParse(entry);
          if (account.success) accounts.set(threadId, account.data);
        }
      }
    } catch {
      // The Console may not be installed here; chats are published without an account.
    }
    held = { at: now(), accounts };
    return accounts;
  };

  const get = (): Promise<ReadonlyMap<string, ThreadAccount>> => {
    if (held !== null && now() - held.at < ttlMs) return Promise.resolve(held.accounts);
    inflight ??= refresh().finally(() => { inflight = null; });
    return inflight;
  };

  const mark = async <T extends { id: string }>(threads: T[]): Promise<(T & { account?: ThreadAccount })[]> => {
    const accounts = await get();
    return threads.map((thread) => {
      const account = accounts.get(thread.id);
      return account === undefined ? thread : { ...thread, account };
    });
  };

  return { get, mark };
}

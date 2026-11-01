import type { ThreadAccount, ThreadState } from "../model";

export const STATE_LABEL: Record<ThreadState, string> = {
  running: "running",
  "needs-you": "needs you",
  queued: "queued",
  error: "error",
  idle: "finished",
};

export interface CardThread {
  id: string;
  title: string;
  state: ThreadState;
  projectName: string | null;
  account?: ThreadAccount | undefined;
}

export function accountTitle(account: ThreadAccount): string {
  return `Runs on the ${account.email ?? account.label} account`;
}

export function AccountTag({ account }: { account: ThreadAccount }) {
  return (
    <span data-nav-part="account" data-harness={account.harness} className="fleet-acct" title={accountTitle(account)} aria-label={`Account ${account.label}`}>
      {account.label}
    </span>
  );
}

export function ThreadCard<T extends CardThread>({ thread, via, age, onOpen }: { thread: T; via: string | null; age: string; onOpen: (thread: T) => void }) {
  return (
    <button type="button" className="fleet-card" onClick={() => onOpen(thread)} title={thread.title}>
      {thread.projectName ? (
        <div className="fleet-proj">
          <i />
          {thread.projectName}
        </div>
      ) : null}
      <div className="fleet-tt">{thread.title}</div>
      <div className="fleet-row">
        <span className="fleet-row-start">
          <span className={`fleet-st ${thread.state}`}>
            <b />
            {STATE_LABEL[thread.state]}
          </span>
          {thread.account ? <AccountTag account={thread.account} /> : null}
        </span>
        <span className="fleet-meta">
          {via !== null ? `via ${via} · ` : ""}
          {age}
        </span>
      </div>
    </button>
  );
}

import { describe, expect, it, vi } from "vitest";
import { createThreadAccounts } from "./thread-accounts";

const claude = { accountId: "pool-1", label: "sam", email: "sam@example.com", harness: "claude" };
const codex = { accountId: "pool-2", label: "NavAIgate", email: null, harness: "codex" };

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe("createThreadAccounts", () => {
  it("returns the label, email and harness per chat and drops the internal pool id", async () => {
    const accounts = createThreadAccounts({ read: async () => ({ threads: { a: claude, b: codex } }) });
    expect((await accounts.get()).get("a")).toEqual({ label: "sam", email: "sam@example.com", harness: "claude" });
    expect((await accounts.get()).get("b")).toEqual({ label: "NavAIgate", email: null, harness: "codex" });
  });

  it("skips an entry it cannot read and keeps the rest", async () => {
    const accounts = createThreadAccounts({ read: async () => ({ threads: { good: claude, bad: { label: 4 }, worse: null } }) });
    expect([...(await accounts.get()).keys()]).toEqual(["good"]);
  });

  it("gives no accounts when the Console is not installed or answers with something else", async () => {
    expect((await createThreadAccounts({ read: async () => { throw new Error("plugin navaigate-skin is not installed"); } }).get()).size).toBe(0);
    expect((await createThreadAccounts({ read: async () => ({ unexpected: true }) }).get()).size).toBe(0);
  });

  it("reads once per window, so a 30 s snapshot never asks the Console twice a minute", async () => {
    const time = clock();
    const read = vi.fn(async () => ({ threads: { a: claude } }));
    const accounts = createThreadAccounts({ read, ttlMs: 60_000, now: time.now });
    await accounts.get();
    time.advance(30_000);
    await accounts.get();
    expect(read).toHaveBeenCalledTimes(1);
    time.advance(31_000);
    await accounts.get();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one read between concurrent snapshots", async () => {
    const read = vi.fn(async () => ({ threads: { a: claude } }));
    const accounts = createThreadAccounts({ read });
    await Promise.all([accounts.get(), accounts.get(), accounts.get()]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good answer when a later read fails, and does not retry until the window ends", async () => {
    const time = clock();
    const read = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce({ threads: { a: claude } }).mockRejectedValue(new Error("busy"));
    const accounts = createThreadAccounts({ read, ttlMs: 60_000, now: time.now });
    await accounts.get();
    time.advance(61_000);
    expect((await accounts.get()).get("a")?.label).toBe("sam");
    await accounts.get();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("marks a chat with the account that is current when its entry is looked up", async () => {
    const accounts = createThreadAccounts({ read: async () => ({ threads: { a: claude } }) });
    const marked = await accounts.mark([{ id: "a", title: "x" }, { id: "z", title: "y" }]);
    expect(marked[0]).toEqual({ id: "a", title: "x", account: { label: "sam", email: "sam@example.com", harness: "claude" } });
    expect("account" in marked[1]!).toBe(false);
  });
});

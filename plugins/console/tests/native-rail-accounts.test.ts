import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createUsageTrend } from "../server-usage-trend";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
});

async function fixture(turns: Array<[number, string, string, number]>) {
  const host = createFakePluginHost({ sdk: { threads: { list: async () => [] } } });
  hosts.push(host);
  const stored = (harness: string, email: string | null) => ({ v: 1, first: 1, lastObservedAt: 1, harness, email, plan: null, status: "ok", meta: {}, rings: {} });
  await host.bb.storage.kv.set("usage-trend:v1:accounts", ["claude-dw", "claude-gmail", "codex-1", "cursor"]);
  await host.bb.storage.kv.set("usage-trend:v1:claude-dw", stored("claude", "sam@example.com"));
  await host.bb.storage.kv.set("usage-trend:v1:claude-gmail", stored("claude", "someone@gmail.com"));
  await host.bb.storage.kv.set("usage-trend:v1:codex-1", stored("codex", "pat@example.com"));
  await host.bb.storage.kv.set("usage-trend:v1:cursor", stored("cursor", null));
  await host.bb.storage.kv.set("usage-turns:v1", { v: 1, seen: {}, scannedAt: 0, turns });
  return createUsageTrend(host.bb, { cursorUsage: async () => null, planLabel: async (_h, raw) => raw, accountFor: () => null });
}

describe("which account each chat ran on", () => {
  it("names the account of the latest turn of each chat, Claude and Codex alike", async () => {
    const trend = await fixture([
      [1, "t1", "claude-gmail", 10],
      [5, "t1", "claude-dw", 10],
      [2, "t2", "codex-1", 10],
      [3, "t3", "cursor", 0],
    ]);
    const { threads } = await trend.threadAccounts();
    expect(threads.t1).toMatchObject({ accountId: "claude-dw", label: "sam", harness: "claude" });
    expect(threads.t2).toMatchObject({ accountId: "codex-1", label: "pat", harness: "codex" });
    expect(threads.t3).toMatchObject({ label: "Cursor", harness: "cursor" });
  });

  it("calls any gmail address gmail and leaves out chats whose account is not tracked", async () => {
    const trend = await fixture([
      [1, "t1", "claude-gmail", 1],
      [2, "t2", "gone-account", 1],
    ]);
    const { threads } = await trend.threadAccounts();
    expect(threads.t1?.label).toBe("gmail");
    expect(threads.t2).toBeUndefined();
  });

  it("is empty before any turn has been seen", async () => {
    const trend = await fixture([]);
    expect(await trend.threadAccounts()).toEqual({ threads: {} });
  });
});

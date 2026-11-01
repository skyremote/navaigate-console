import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poolList, poolPutFirst } from "../server-pool";

const CLAUDE_A = "11111111-1111-4111-8111-111111111111";
const CLAUDE_B = "22222222-2222-4222-8222-222222222222";
const CODEX_A = "33333333-3333-4333-8333-333333333333";
const CODEX_B = "44444444-4444-4444-8444-444444444444";
const CODEX_OFF = "55555555-5555-4555-8555-555555555555";

const listing = {
  accounts: [
    { id: CLAUDE_B, provider: "claude", email: "someone@gmail.com", priority: 2, enabled: true, status: "ok", sevenDayUtilization: 0.1, fiveHourUtilization: 0.02 },
    { id: CODEX_B, provider: "codex", email: "ops@example.com", priority: 2, enabled: true, status: "ok", sevenDayUtilization: 0.42, fiveHourUtilization: 0.07 },
    { id: CLAUDE_A, provider: "claude", email: "sam@example.com", priority: 1, enabled: true, status: "ok", sevenDayUtilization: 0.5, fiveHourUtilization: 0.3 },
    { id: CODEX_A, provider: "codex", email: "pat@example.com", priority: 1, enabled: true, status: "ok", sevenDayUtilization: 0.9, fiveHourUtilization: 0.6 },
    { id: CODEX_OFF, provider: "codex", email: "old@example.com", priority: 3, enabled: false, status: "ok", sevenDayUtilization: null, fiveHourUtilization: null },
  ],
};

let dir = "";
let argsFile = "";
let previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-bb-"));
  argsFile = join(dir, "args.log");
  const cli = join(dir, "bb");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argsFile}'\nif [ "$3" = "list" ]; then cat '${join(dir, "list.json")}'; else echo '{"ok":true}'; fi\n`);
  writeFileSync(join(dir, "list.json"), JSON.stringify(listing));
  chmodSync(cli, 0o755);
  previous = process.env.BB_CLI;
  process.env.BB_CLI = cli;
});
afterEach(() => {
  if (previous === undefined) delete process.env.BB_CLI;
  else process.env.BB_CLI = previous;
  rmSync(dir, { recursive: true, force: true });
});
const calls = () => readFileSync(argsFile, "utf8").trim().split("\n");

describe("pooled accounts for the account chip", () => {
  it("lists only the Claude accounts, in failover order, when asked for Claude", async () => {
    const claude = await poolList("claude");
    expect(claude.error).toBeNull();
    expect(claude.accounts.map((a) => [a.short, a.priority, a.weekPct, a.sessionPct])).toEqual([["sam", 1, 50, 30], ["gmail", 2, 10, 2]]);
  });

  it("lists the Codex accounts with their week and session use, disabled ones included and marked", async () => {
    const codex = await poolList("codex");
    expect(codex.accounts.map((a) => [a.id, a.short, a.enabled, a.weekPct, a.sessionPct])).toEqual([
      [CODEX_A, "pat", true, 90, 60],
      [CODEX_B, "ops", true, 42, 7],
      [CODEX_OFF, "old", false, null, null],
    ]);
  });

  it("puts a Codex account first with every other Codex account kept in order, and never touches Claude's order", async () => {
    const res = await poolPutFirst("codex", CODEX_B);
    expect(calls().filter((line) => line.includes("reorder"))).toEqual([`pool account reorder codex ${CODEX_B} ${CODEX_A} ${CODEX_OFF} --json`]);
    expect(res.accounts.length).toBe(3);
  });

  it("refuses an account that belongs to the other provider", async () => {
    await expect(poolPutFirst("codex", CLAUDE_A)).rejects.toThrow("That account is not in the pool.");
    expect(calls().some((line) => line.includes("reorder"))).toBe(false);
  });

  it("still reorders Claude accounts as before", async () => {
    await poolPutFirst("claude", CLAUDE_B);
    expect(calls().filter((line) => line.includes("reorder"))).toEqual([`pool account reorder claude ${CLAUDE_B} ${CLAUDE_A} --json`]);
  });
});

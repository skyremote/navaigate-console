// Claude and Codex accounts in bb's Account Pooler, for the account chip under the chat box.
//
// Read: `bb pool account list --json` (emails, priority, observed quota; never tokens).
// Write: one lever only, `bb pool account reorder <provider> <ids…>`, which sets that
// provider's failover order. The pooler has no per-thread pin and keeps its current
// account for new chats until that account is unavailable, so this never moves a chat.
// Routing on or off and `bb pool bypass` are deliberately not touched here.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { z } from "zod";

const KNOWN_CLI = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb";
const BB_APP_BIN = "/Applications/bb.app/Contents/MacOS/bb";
const BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";

export const poolProviderSchema = z.enum(["claude", "codex"]);
export type PoolProvider = z.infer<typeof poolProviderSchema>;
export const poolAccountSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  short: z.string(),
  priority: z.number(),
  enabled: z.boolean(),
  status: z.string().nullable(),
  weekPct: z.number().nullable(),
  sessionPct: z.number().nullable(),
});
export const poolListSchema = z.object({ accounts: z.array(poolAccountSchema), error: z.string().nullable() });
export type PoolList = z.infer<typeof poolListSchema>;

/** "sam" for sam@example.com, "gmail" for any gmail address. */
export function shortName(email: string | null, label: string | null): string {
  if (!email) return label ?? "account";
  const [local, domain] = email.split("@");
  if (/^(gmail|googlemail)\.com$/i.test(domain ?? "")) return "gmail";
  return local || email;
}

function findCli(): string {
  const candidates = [process.env.BB_CLI, path.join(os.homedir(), ".local", "bin", "bb")];
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir) candidates.push(path.join(dir, "bb"));
  candidates.push(KNOWN_CLI);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error("Could not find the bb command line tool.");
}

/** Runs `bb …`. The bundled CLI is a Node script, so it runs under bb's own Electron as Node. */
function bbCli(args: string[], timeout = 30_000): Promise<string> {
  const cli = findCli();
  let head = "";
  try {
    head = fs.readFileSync(cli, { encoding: "utf8" }).slice(0, 40);
  } catch {
    /* binary or unreadable: run directly */
  }
  const viaNode = head.startsWith("#!") && head.includes("node");
  const cmd = viaNode ? (fs.existsSync(BB_APP_BIN) ? BB_APP_BIN : process.execPath) : cli;
  const argv = viaNode ? [cli, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      argv,
      { env: { ...process.env, PATH: `${process.env.PATH ?? ""}:${BASE_PATH}`, ...(viaNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }, timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-2).join(" ")));
        else resolve(stdout);
      },
    );
  });
}

type RawAccount = {
  id: string;
  provider: string;
  email?: string | null;
  label?: string | null;
  priority?: number;
  enabled?: boolean;
  status?: string | null;
  sevenDayUtilization?: number | null;
  fiveHourUtilization?: number | null;
};

const pct = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null);

async function rawAccounts(provider: PoolProvider): Promise<RawAccount[]> {
  const out = await bbCli(["pool", "account", "list", "--json"]);
  const parsed = JSON.parse(out) as { accounts?: RawAccount[] };
  return (parsed.accounts ?? []).filter((a) => a.provider === provider).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

export async function poolList(provider: PoolProvider): Promise<PoolList> {
  try {
    const accounts = (await rawAccounts(provider)).map((a) => ({
      id: a.id,
      email: a.email ?? null,
      short: shortName(a.email ?? null, a.label ?? null),
      priority: a.priority ?? 0,
      enabled: a.enabled !== false,
      status: a.status ?? null,
      weekPct: pct(a.sevenDayUtilization),
      sessionPct: pct(a.fiveHourUtilization),
    }));
    return { accounts, error: null };
  } catch (e) {
    return { accounts: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Puts one account first in its provider's failover order, keeps the rest in their order, then re-reads. */
export async function poolPutFirst(provider: PoolProvider, accountId: string): Promise<PoolList> {
  const all = await rawAccounts(provider);
  if (!all.some((a) => a.id === accountId)) throw new Error("That account is not in the pool.");
  const order = [accountId, ...all.filter((a) => a.id !== accountId).map((a) => a.id)];
  await bbCli(["pool", "account", "reorder", provider, ...order, "--json"]);
  return poolList(provider);
}

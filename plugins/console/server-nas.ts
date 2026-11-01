// Home or away, for the chip on the new-thread screen: the hand-over helper's
// `where` says whether the NAS is on the local network, and an SSH ping says
// whether the always-on Mac can be reached. With no helper or alias in the
// profile the answer is "home" and not reachable.
import { execFile } from "node:child_process";
import { z } from "zod";
import { alwaysOnSsh, handoffScriptPath } from "./server-words";

const BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";

export const nasWhereSchema = z.object({ mode: z.enum(["home", "away"]), m1: z.boolean() });

function run(cmd: string, args: string[], opts: { timeout?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { env: { ...process.env, PATH: BASE_PATH }, timeout: opts.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-2).join(" ")));
      else resolve(stdout);
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** Without a helper script there is no way to tell, so the NAS counts as near (nothing is held back). */
async function rawMode(): Promise<"home" | "away"> {
  const script = handoffScriptPath();
  if (!script) return "home";
  return (await run("/bin/bash", [script, "where"], { timeout: 15_000 }).catch(() => "away")).trim() === "home" ? "home" : "away";
}

let cached: { at: number; value: z.infer<typeof nasWhereSchema> } | null = null;

/** Home or away (cached a minute). Shared by everything that must not touch the NAS when away. */
export async function whereNow(): Promise<z.infer<typeof nasWhereSchema>> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const mode = await rawMode();
  const alias = alwaysOnSsh();
  const m1 = alias ? await run("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", alias, "true"], { timeout: 12_000 }).then(() => true, () => false) : false;
  cached = { at: Date.now(), value: { mode, m1 } };
  return cached.value;
}

let cachedMode: { at: number; value: "home" | "away" } | null = null;

/** Home or away alone (cached a minute), without the always-on Mac ping: for callers that only need to know whether the NAS is near. */
export async function modeNow(): Promise<{ mode: "home" | "away" }> {
  if (cached && Date.now() - cached.at < 60_000) return { mode: cached.value.mode };
  if (cachedMode && Date.now() - cachedMode.at < 60_000) return { mode: cachedMode.value };
  const value = await rawMode();
  cachedMode = { at: Date.now(), value };
  return { mode: value };
}

/** Runs a short Python program on the always-on Mac (stdin = first line `arg`, then the program) and returns stdout. */
export function onM1(program: string, arg: string, timeout = 20_000): Promise<string> {
  return run(
    "/usr/bin/ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", alwaysOnSsh(), "python3 -c 'import sys; arg=sys.stdin.readline().strip(); exec(sys.stdin.read())'"],
    { timeout, input: `${arg}\n${program}` },
  );
}

export function createNas() {
  return { where: whereNow };
}

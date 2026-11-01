// The always-on Mac at home: which chats were handed over to it, and how they are doing there.
// `m1 send` (navaigate-local-skills/skills/m1) records <laptop thread> -> <the always-on Mac thread>
// in ~/.m1/handoffs.json. We watch that file and poll the always-on Mac's own bb over SSH
// (host alias `m1`) for each handed-over thread's status.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { loadProfile } from "./profile/load";
import { consoleSection, expandProfilePath, nasPair } from "./lib/profile-console";
import { Mac, alwaysOnSsh, owner, mac, requireHandoff, trustedHandoffScript } from "./server-words";

export const m1ItemSchema = z.object({
  m1Thread: z.string(),
  url: z.string(),
  title: z.string(),
  provider: z.string(),
  sentAt: z.number(),
  /** The always-on Mac thread's bb status (active, idle, error, ...) or "unknown" while the always-on Mac can't be reached. */
  status: z.string(),
  updatedAt: z.number().nullable(),
});
export const m1StateSchema = z.object({
  /** null until the first poll; false when SSH to the always-on Mac failed last time. */
  reachable: z.boolean().nullable(),
  items: z.record(z.string(), m1ItemSchema),
});
export type M1State = z.infer<typeof m1StateSchema>;

const sec = () => consoleSection(loadProfile().profile);
/** The file the hand-over helper records handed-over chats in. */
const handoffFile = () => expandProfilePath(loadProfile().profile, sec().handoffFile, os.homedir()) ?? "";

const POLL_MS = 30_000;
const REMOTE =
  'export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"; export NVM_DIR="$HOME/.nvm"; ' +
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null; ' +
  "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb thread list --json";

type Handoff = { m1Thread: string; url: string; title: string; provider: string; sentAt: number };

function readHandoffs(): Record<string, Handoff> {
  try {
    const raw = JSON.parse(fs.readFileSync(handoffFile(), "utf8")) as Record<string, Partial<Handoff>>;
    const out: Record<string, Handoff> = {};
    for (const [local, h] of Object.entries(raw)) {
      if (h && typeof h.m1Thread === "string") {
        out[local] = { m1Thread: h.m1Thread, url: h.url ?? "", title: h.title ?? "", provider: h.provider ?? "", sentAt: Number(h.sentAt) || 0 };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function remoteThreads(signal?: AbortSignal): Promise<Map<string, { status: string; updatedAt: number | null }> | null> {
  return new Promise((resolve) => {
    if (alwaysOnSsh() === "") return resolve(null); // no always-on Mac to ask
    // The signal kills ssh when the plugin reloads, so the service stops at once.
    execFile(
      "/usr/bin/ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alwaysOnSsh(), REMOTE],
      { timeout: 25_000, maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const list = JSON.parse(stdout) as Array<{ id: string; status?: string; updatedAt?: number }>;
          resolve(new Map(list.map((t) => [t.id, { status: t.status ?? "unknown", updatedAt: t.updatedAt ?? null }])));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// ---- Handing a chat over: done here, not by the chat's own agent ----
// A chat bound to the NAS can't even start its agent from a hotel (thread/resume times
// out), so the plugin reads the conversation itself and sends the brief with `m1 send`.

const m1Script = trustedHandoffScript;
const BB_APP_BIN = "/Applications/bb.app/Contents/MacOS/bb";
const BB_CLI = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb";
const BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";
const MAX_FILE = 50 * 1024 * 1024;

export const m1HandoffInput = z.object({ threadId: z.string().min(1), title: z.string().max(200), providerId: z.string().max(60) });
export const m1HandoffOutput = z.object({ m1Thread: z.string(), url: z.string(), notes: z.array(z.string()) });

function run(cmd: string, args: string[], env: Record<string, string>, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, PATH: BASE_PATH, ...env }, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ")));
      else resolve(stdout);
    });
  });
}

const m1 = (args: string[], env: Record<string, string> = {}, timeout = 120_000) => run("/bin/bash", [m1Script(), ...args], env, timeout);

export async function transcript(threadId: string): Promise<string> {
  const bin = fs.existsSync(BB_APP_BIN) ? BB_APP_BIN : process.execPath;
  const out = await run(bin, [BB_CLI, "thread", "log", threadId, "--format", "minimal", "--limit", "30"], { ELECTRON_RUN_AS_NODE: "1" }, 60_000);
  const max = 60_000;
  return out.length <= max ? out : `${out.slice(0, 8_000)}\n\n[... middle of the conversation trimmed ...]\n\n${out.slice(-50_000)}`;
}

/** Files the chat mentions that only exist on this laptop: put them on the NAS and point the brief there. */
async function carryFiles(text: string, notes: string[]): Promise<string> {
  const home = os.homedir();
  const prof = loadProfile().profile;
  const nas = prof.paths.nas?.replace(/\/+$/, "") ?? null;
  const nasLocal = expandProfilePath(prof, prof.paths.nasLocal, home)?.replace(/\/+$/, "") ?? null;
  const re = new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s"'\`)<>\\]]+\\.[A-Za-z0-9]{2,5}`, "g");
  // Files already under the shared NAS folder (as this Mac links it, when the profile says) are not carried again.
  const shared = nasPair(prof, home)?.link ?? null;
  const found = [...new Set(text.match(re) ?? [])].filter(
    (p) => !(shared && p.startsWith(`${shared}/`)) && !p.startsWith(`${home}/Documents/GitHub/`) && !p.includes("/.claude/") && !p.includes("/.bb/"),
  );
  let out = text;
  for (const p of found.slice(0, 15)) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const local = nasLocal ? nasLocal + "/" : null;
      if (local && nas && p.startsWith(local)) {
        const res = await m1(["push", p]).catch((e: unknown) => `failed: ${String(e)}`);
        const nasPath = `${nas}/${p.slice(local.length)}`;
        if (String(res).startsWith("failed")) notes.push(`Not pushed (the NAS copy changed): ${p.slice(local.length)}`);
        out = out.split(p).join(nasPath);
      } else {
        const res = await m1(["put", p]);
        const nasPath = res.match(/on the NAS: (.+)/)?.[1]?.trim();
        if (nasPath) {
          out = out.split(p).join(nasPath);
          notes.push(`Copied to the NAS: ${path.basename(p)}`);
        }
      }
    } catch {
      /* missing or unreadable: the always-on Mac just won't have it */
    }
  }
  return out;
}

export async function handOff(input: z.infer<typeof m1HandoffInput>): Promise<z.infer<typeof m1HandoffOutput>> {
  requireHandoff();
  trustedHandoffScript();
  const notes: string[] = [];
  const convo = await carryFiles(await transcript(input.threadId), notes);
  const share = nasPair(loadProfile().profile, os.homedir());
  const brief = [
    `# ${input.title || "Handed-over chat"}`,
    "",
    `This chat was started on ${owner()}'s laptop and is being handed to ${mac()} part-way through.`,
    "Below is the conversation so far. Work out what was being done and what is still open, then carry on",
    "from exactly where it stopped. Act on the most recent clear request; don't redo finished steps.",
    ...(share ? [`Paths under ${share.link}/ are the same files under ${share.nas}/ here.`] : []),
    "",
    "## Conversation so far",
    "",
    convo,
  ].join("\n");
  const file = path.join(os.tmpdir(), `m1-handoff-${input.threadId}.md`);
  fs.writeFileSync(file, brief);
  const provider = ["claude-code", "codex", "acp-cursor", "pi"].includes(input.providerId) ? input.providerId : "claude-code";
  try {
    const out = await m1(["send", "--provider", provider, "--title", input.title.slice(0, 80) || "Handed-over chat", "-f", file], { BB_THREAD_ID: input.threadId }, 180_000);
    const m1Thread = out.match(/sent: (\S+)/)?.[1] ?? "";
    const url = out.match(/watch: (https?:\S+)/)?.[1] ?? "";
    if (!m1Thread) throw new Error(out.trim().split("\n").slice(-2).join(" "));
    return { m1Thread, url, notes };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ---- Watching a handed-over chat from inside the laptop's chat ----

export const m1LogOutput = z.object({
  mapped: z.boolean(),
  m1Thread: z.string(),
  url: z.string(),
  log: z.string(),
  error: z.string().nullable(),
});

/** The always-on Mac side of a handed-over chat: its recent turns, as `bb thread log` prints them. */
export async function m1Log(threadId: string): Promise<z.infer<typeof m1LogOutput>> {
  requireHandoff();
  const h = readHandoffs()[threadId];
  if (!h) return { mapped: false, m1Thread: "", url: "", log: "", error: null };
  const cmd = REMOTE.replace("thread list --json", `thread log ${h.m1Thread} --format minimal --limit 6`);
  return new Promise((resolve) => {
    execFile("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alwaysOnSsh(), cmd], { timeout: 25_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const log = stdout.length > 12_000 ? stdout.slice(-12_000) : stdout;
      resolve({ mapped: true, m1Thread: h.m1Thread, url: h.url, log, error: err && !stdout ? `${Mac()} can't be reached right now.` : null });
    });
  });
}

/** Sends a follow-up to the always-on Mac chat. */
export async function m1Tell(threadId: string, text: string): Promise<{ ok: boolean }> {
  requireHandoff();
  const h = readHandoffs()[threadId];
  if (!h) throw new Error(`This chat hasn't been sent to ${mac()}.`);
  const file = path.join(os.tmpdir(), `m1-tell-${threadId}.txt`);
  fs.writeFileSync(file, text);
  try {
    await m1(["tell", h.m1Thread, "-f", file]);
    return { ok: true };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function createM1(bb: BbPluginApi) {
  let state: M1State = { reachable: null, items: {} };
  let last = "";

  const refresh = async (signal?: AbortSignal) => {
    const handoffs = readHandoffs();
    const remote = Object.keys(handoffs).length ? await remoteThreads(signal) : null;
    if (signal?.aborted) return state;
    const items: M1State["items"] = {};
    for (const [local, h] of Object.entries(handoffs)) {
      const r = remote?.get(h.m1Thread);
      items[local] = { ...h, status: r?.status ?? "unknown", updatedAt: r?.updatedAt ?? null };
    }
    state = { reachable: Object.keys(handoffs).length ? remote !== null : state.reachable, items };
    const sig = JSON.stringify(state);
    if (sig !== last) {
      last = sig;
      bb.realtime.publish("m1-handoffs", { at: Date.now() });
    }
    return state;
  };

  // A new handoff should show up straight away, not on the next poll.
  let watcher: fs.FSWatcher | null = null;
  const watchFile = () => {
    try {
      const file = handoffFile();
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      watcher = fs.watch(path.dirname(file), (_e, name) => {
        if (name === path.basename(file)) void refresh().catch(() => undefined);
      });
    } catch (e) {
      bb.log.warn(`hand-over: cannot watch the hand-over file: ${String(e)}`);
    }
  };
  watchFile();
  bb.onDispose(() => watcher?.close());

  bb.background.service("m1-status", {
    async start(signal) {
      while (!signal.aborted) {
        await refresh(signal).catch((e) => bb.log.warn(`m1 status: ${String(e)}`));
        if (signal.aborted) break;
        await new Promise((r) => {
          const t = setTimeout(r, POLL_MS);
          signal.addEventListener("abort", () => { clearTimeout(t); r(null); }, { once: true });
        });
      }
    },
  });

  return { get: () => state, refresh };
}

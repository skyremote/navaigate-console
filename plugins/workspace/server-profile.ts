// The member's own setup, written by onboarding and read by every part of the
// plugin: their name, the areas of their work (inbox sorting and routing), an
// optional always-on machine, optional storage at home, and their API keys.
//
//   ~/.config/navaigate-workspace/profile.json   name, areas, machine, storage
//   ~/.config/navaigate-workspace/keys.env       KEY=value lines, mode 600
//
// The always-on skill script reads the same two files.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "navaigate-workspace");
const PROFILE_FILE = path.join(CONFIG_DIR, "profile.json");
const KEYS_FILE = path.join(CONFIG_DIR, "keys.env");

export const areaSchema = z.object({ name: z.string().trim().min(1).max(40), what: z.string().trim().max(300) });
export const machineSchema = z.object({
  label: z.string().trim().min(1).max(40),
  sshHost: z.string().trim().min(1).max(120),
});
export const storageSchema = z.object({
  label: z.string().trim().min(1).max(40),
  /** Where the share is mounted on this computer and on the always-on machine, e.g. /Volumes/Studio. */
  path: z.string().trim().min(1).max(300),
  /** Local copies of files fetched while away. */
  localCopy: z.string().trim().min(1).max(300),
  /** host:port that only answers on the home network, e.g. nas.local:445. */
  homeCheck: z.string().trim().max(120),
  /** BB project on the share (home) and on the local copy (away). */
  homeProject: z.string().trim().max(80),
  awayProject: z.string().trim().max(80),
});
export const profileSchema = z.object({
  name: z.string().trim().max(40),
  areas: z.array(areaSchema).max(8),
  machine: machineSchema.nullable(),
  storage: storageSchema.nullable(),
  onboarded: z.boolean(),
});
export type Profile = z.infer<typeof profileSchema>;
export type Area = z.infer<typeof areaSchema>;

export const KEY_NAMES = ["COMPOSIO_API_KEY", "TYPESAFE_API_KEY", "CALENDLY_API_TOKEN", "BLOTATO_API_KEY", "ELEVENLABS_API_KEY"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export const DEFAULT_AREAS: Area[] = [
  { name: "Work", what: "Clients, customers, partners, projects and the business itself" },
  { name: "Community", what: "Online communities, members, events and content" },
  { name: "Personal", what: "Family, friends, home, personal bills, health, holidays and personal travel" },
];

const EMPTY: Profile = { name: "", areas: DEFAULT_AREAS, machine: null, storage: null, onboarded: false };

let cached: { mtime: number; value: Profile } | null = null;

export function profile(): Profile {
  try {
    const st = fs.statSync(PROFILE_FILE);
    if (cached && cached.mtime === st.mtimeMs) return cached.value;
    const parsed = profileSchema.safeParse({ ...EMPTY, ...JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8")) });
    const value = parsed.success ? parsed.data : EMPTY;
    cached = { mtime: st.mtimeMs, value };
    return value;
  } catch {
    return EMPTY;
  }
}

export function saveProfile(p: Profile): Profile {
  const value = profileSchema.parse(p);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = PROFILE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, PROFILE_FILE);
  cached = null;
  return value;
}

/** The member's first name for prompts and greetings; "the user" until onboarding sets it. */
export const me = () => profile().name || "the user";

/** Areas of work as a Jev choice: each area, plus Other. */
export function areaChoices(): Record<string, { what: string }> {
  const out: Record<string, { what: string }> = {};
  for (const a of profile().areas.length ? profile().areas : DEFAULT_AREAS) out[a.name] = { what: a.what || a.name };
  out.Other = { what: "Anything that fits none of the other options, such as vendors, tools and general enquiries" };
  return out;
}

function readKeysFile(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(KEYS_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

/** A key from the environment first, then keys.env. */
export function readKey(name: KeyName): string | null {
  const v = process.env[name] || readKeysFile()[name];
  return v && v.trim() ? v.trim() : null;
}

/** Which keys are set, without revealing them. */
export function keyStatus(): Record<KeyName, boolean> {
  return Object.fromEntries(KEY_NAMES.map((k) => [k, !!readKey(k)])) as Record<KeyName, boolean>;
}

/** Set or clear keys. An empty string removes the key. */
export function saveKeys(next: Partial<Record<KeyName, string>>): Record<KeyName, boolean> {
  const cur = readKeysFile();
  for (const [k, v] of Object.entries(next)) {
    if (!(KEY_NAMES as readonly string[]).includes(k) || v === undefined) continue;
    if (v.trim()) cur[k] = v.trim();
    else delete cur[k];
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const body = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const tmp = KEYS_FILE + ".tmp";
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, KEYS_FILE);
  fs.chmodSync(KEYS_FILE, 0o600);
  return keyStatus();
}

/** Check a key against its service without storing it. */
export async function testKey(name: KeyName, value: string): Promise<{ ok: boolean; message: string }> {
  const v = value.trim() || readKey(name) || "";
  if (!v) return { ok: false, message: "No key entered." };
  const t = AbortSignal.timeout(15_000);
  try {
    let r: Response;
    switch (name) {
      case "COMPOSIO_API_KEY":
        r = await fetch("https://backend.composio.dev/api/v3/connected_accounts?limit=50", { headers: { "x-api-key": v }, signal: t });
        if (r.ok) {
          const d = (await r.json()) as { items?: Array<{ toolkit?: { slug?: string }; status?: string }> };
          const active = (d.items ?? []).filter((a) => a.status === "ACTIVE").map((a) => a.toolkit?.slug ?? "?");
          const gmail = active.filter((s) => s === "gmail").length;
          const cal = active.includes("googlecalendar");
          return { ok: true, message: `Connected. ${gmail} Gmail account${gmail === 1 ? "" : "s"}${cal ? ", Google Calendar" : ", no Google Calendar yet"}.` };
        }
        break;
      case "TYPESAFE_API_KEY":
        r = await fetch("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          headers: { Authorization: `Bearer ${v}`, "Content-Type": "application/json" },
          signal: t,
          body: JSON.stringify({ model: "jev-latest", state: { x: "hello" }, questions: { q: { type: "noul", instructions: "Is `x` a greeting?" } } }),
        });
        if (r.ok) return { ok: true, message: "Jev answered." };
        break;
      case "CALENDLY_API_TOKEN":
        r = await fetch("https://api.calendly.com/users/me", { headers: { Authorization: `Bearer ${v}` }, signal: t });
        if (r.ok) return { ok: true, message: "Calendly connected." };
        break;
      case "BLOTATO_API_KEY":
        r = await fetch("https://backend.blotato.com/v2/users/me/accounts", { headers: { "blotato-api-key": v }, signal: t });
        if (r.ok) return { ok: true, message: "Blotato connected." };
        break;
      case "ELEVENLABS_API_KEY":
        r = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": v }, signal: t });
        if (r.ok) return { ok: true, message: "ElevenLabs connected." };
        break;
    }
    return { ok: false, message: r.status === 401 || r.status === 403 ? "The service rejected that key." : `The service answered ${r.status}.` };
  } catch (e) {
    return { ok: false, message: `Could not reach the service: ${String(e instanceof Error ? e.message : e)}` };
  }
}

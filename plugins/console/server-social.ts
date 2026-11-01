// Social on Home: the owner's Blotato accounts, the queue, recent posts and their
// analytics. Read-only: only GET requests, nothing is ever published from here.
// The API key is read at runtime from the Blotato MCP entry in ~/.claude.json
// (or BLOTATO_API_KEY), never copied anywhere.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const metricsSchema = z.object({ views: z.number().nullable(), likes: z.number().nullable(), comments: z.number().nullable(), shares: z.number().nullable(), reach: z.number().nullable() });
const postSchema = z.object({
  id: z.string(),
  platform: z.string(),
  account: z.string(),
  firstLine: z.string(),
  at: z.string(),
  url: z.string().nullable(),
  metrics: metricsSchema.nullable(),
});
export const socialSchema = z.object({
  configured: z.boolean(),
  error: z.string().nullable(),
  accounts: z.array(z.object({ id: z.string(), platform: z.string(), name: z.string() })),
  queue: z.array(postSchema),
  recent: z.array(postSchema),
});
export type Social = z.infer<typeof socialSchema>;

const BASE = "https://backend.blotato.com/v2";
const CACHE_MS = 10 * 60_000;

export function blotatoKey(): string | null {
  if (process.env.BLOTATO_API_KEY) return process.env.BLOTATO_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")) as { mcpServers?: Record<string, { headers?: Record<string, string> }> };
    return cfg.mcpServers?.blotato?.headers?.["blotato-api-key"] ?? null;
  } catch {
    return null;
  }
}

export async function blotatoGet<T>(key: string, p: string): Promise<T> {
  const r = await fetch(`${BASE}${p}`, { headers: { "blotato-api-key": key }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`Blotato ${r.status}`);
  return r.json() as Promise<T>;
}

type RawPost = {
  id: string;
  platform: string;
  text?: string;
  postTime: string;
  account?: { name?: string };
  state: { type: string; postUrl?: string | null; analytics?: { latest?: { metrics?: Record<string, string | number> } } | null };
};

const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const firstLine = (t: string | undefined) => (t ?? "").split(/\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 140) ?? "(no text)";
function toPost(p: RawPost): z.infer<typeof postSchema> {
  const m = p.state.analytics?.latest?.metrics;
  return {
    id: p.id,
    platform: p.platform,
    account: p.account?.name ?? "",
    firstLine: firstLine(p.text),
    at: p.postTime,
    url: p.state.postUrl ?? null,
    metrics: m ? { views: num(m.viewsCount), likes: num(m.likesCount), comments: num(m.commentsCount), shares: num(m.sharesCount), reach: num(m.reachCount) } : null,
  };
}

export function createSocial(_bb: BbPluginApi) {
  let cache: { at: number; value: Social } | null = null;

  async function build(): Promise<Social> {
    const key = blotatoKey();
    if (!key) return { configured: false, error: null, accounts: [], queue: [], recent: [] };
    try {
      const iso = (ms: number) => new Date(ms).toISOString();
      const now = Date.now();
      const [acc, queued, published] = await Promise.all([
        blotatoGet<{ items: Array<{ id: string; platform: string; fullname?: string; username?: string }> }>(key, "/users/me/accounts"),
        blotatoGet<{ items: RawPost[] }>(key, `/posts?status=scheduled&since=${iso(now)}&until=${iso(now + 60 * 86_400_000)}&limit=50`),
        blotatoGet<{ items: RawPost[] }>(key, `/posts?status=published&since=${iso(now - 30 * 86_400_000)}&until=${iso(now)}&limit=8`),
      ]);
      return {
        configured: true,
        error: null,
        accounts: acc.items.map((a) => ({ id: a.id, platform: a.platform, name: a.username || a.fullname || a.platform })),
        queue: queued.items.map(toPost).sort((a, b) => a.at.localeCompare(b.at)).slice(0, 10),
        recent: published.items.map(toPost).slice(0, 8),
      };
    } catch (e) {
      return { configured: true, error: String(e instanceof Error ? e.message : e), accounts: [], queue: [], recent: [] };
    }
  }

  async function social(): Promise<Social> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    const value = await build();
    if (!value.error) cache = { at: Date.now(), value };
    return value;
  }

  return { social };
}

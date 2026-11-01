// Audience on Home: followers per platform. Real numbers only where a source we
// can reach gives one (the public YouTube channel page; public Instagram and
// TikTok profile pages when they expose a count). Otherwise the card says so
// and offers a "Link profile" setting. A daily snapshot in kv gives a 7-day change.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { blotatoGet, blotatoKey } from "./server-social";
import { instagramFollowers, linkedinFollowers, xFollowers } from "./server-browser";

// Platforms a profile can be linked for; TikTok keeps its code path but is not shown on the row.
export const AUDIENCE_PLATFORMS = ["youtube", "instagram", "x", "linkedin", "tiktok"] as const;
type Platform = (typeof AUDIENCE_PLATFORMS)[number];
const SHOWN: Platform[] = ["youtube", "instagram", "x", "linkedin"];
export const audienceSchema = z.object({
  platforms: z.array(
    z.object({
      platform: z.enum(AUDIENCE_PLATFORMS),
      label: z.string(),
      profileUrl: z.string().nullable(),
      count: z.number().nullable(),
      change7d: z.number().nullable(),
      source: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
});
type Audience = z.infer<typeof audienceSchema>;
type Settings = { get(): Promise<Record<string, unknown>>; experimental_set(v: Record<string, unknown>): Promise<unknown> };
type History = Record<string, Record<string, number>>;

const LABEL: Record<Platform, string> = { youtube: "YouTube subscribers", instagram: "Instagram followers", tiktok: "TikTok followers", x: "X followers", linkedin: "LinkedIn followers" };
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  Cookie: "SOCS=CAI; CONSENT=YES+1",
};
const CACHE_MS = 6 * 60 * 60_000; // six hours: the LinkedIn and Instagram routes rate-limit
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

function parseCount(s: string): number | null {
  const m = s.trim().match(/^([\d.,]+)\s*([KkMm])?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1));
}
async function page(url: string): Promise<string> {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
  return r.text();
}

export function createAudience(bb: BbPluginApi, settings: Settings) {
  let cache: { at: number; value: Audience } | null = null;
  let inflight: Promise<Audience> | null = null;
  let lastBuildFailed = false;

  async function links(): Promise<Partial<Record<Platform, string>>> {
    const s = await settings.get();
    const out: Partial<Record<Platform, string>> = {};
    for (const line of String(s.audienceProfiles ?? "").split(/\n|;/)) {
      const [p, url] = line.split("|").map((x) => x?.trim());
      if (p && url && (AUDIENCE_PLATFORMS as readonly string[]).includes(p.toLowerCase()) && /^https:\/\//.test(url)) out[p.toLowerCase() as Platform] = url;
    }
    return out;
  }

  // The YouTube channel behind the owner's Blotato YouTube account, found once from a published video.
  async function youtubeChannel(): Promise<string | null> {
    const known = await bb.storage.kv.get<string>("audience-youtube-channel");
    if (known) return known;
    const key = blotatoKey();
    if (!key) return null;
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const r = await blotatoGet<{ items: Array<{ state: { postUrl?: string | null } }> }>(key, `/posts?status=published&platform=youtube&since=${since}&limit=1`);
    const url = r.items[0]?.state.postUrl;
    if (!url) return null;
    const id = (await page(url)).match(/"channelId":"(UC[\w-]{22})"/)?.[1];
    if (!id) return null;
    const channel = `https://www.youtube.com/channel/${id}`;
    await bb.storage.kv.set("audience-youtube-channel", channel);
    return channel;
  }

  async function count(p: Platform, url: string | null): Promise<{ count: number | null; source: string | null; note: string | null }> {
    try {
      if (p === "youtube") {
        const u = url ?? (await youtubeChannel());
        if (!u) return { count: null, source: null, note: "No channel found yet." };
        const m = (await page(u)).match(/"content":"([\d.,]+[KM]?) subscribers?"/);
        return m ? { count: parseCount(m[1]), source: "Public channel page", note: null } : { count: null, source: null, note: "The channel page did not show a count." };
      }
      if (!url) return { count: null, source: null, note: "Link the profile and we try its public page." };
      if (p === "linkedin") {
        // LinkedIn's API only gives follower counts to partner apps; its public profile renders in a real browser.
        try {
          const r = await linkedinFollowers(url);
          return { count: r.count, source: r.exact ? "Public profile" : "Public profile (rounded)", note: null };
        } catch (e) {
          return { count: null, source: null, note: `LinkedIn did not show the public profile (${String(e instanceof Error ? e.message : e)}), so there is no live number right now.` };
        }
      }
      if (p === "x") {
        // X's public follow-button JSON is gone and its syndication timeline rate-limits (429);
        // the logged-out profile page shows the count in a real browser.
        try {
          const r = await xFollowers(url);
          return { count: r.count, source: r.exact ? "Public profile" : "Public profile (rounded)", note: null };
        } catch (e) {
          return { count: null, source: null, note: `X did not show the count without a login (${String(e instanceof Error ? e.message : e)}), so there is no live number right now.` };
        }
      }
      if (p === "instagram") {
        const user = url.match(/instagram\.com\/([\w.]+)/)?.[1];
        // 1. Instagram's own web profile JSON (often asks for a login from servers).
        if (user) {
          try {
            const r = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(user)}`, {
              headers: { ...HEADERS, "x-ig-app-id": "936619743392459", Accept: "*/*" },
              signal: AbortSignal.timeout(15_000),
            });
            if (r.ok) {
              const n = ((await r.json()) as { data?: { user?: { edge_followed_by?: { count?: number } } } }).data?.user?.edge_followed_by?.count;
              if (typeof n === "number") return { count: n, source: "Instagram profile data", note: null };
            }
          } catch {
            /* fall through to the public page */
          }
        }
        // 2. The public profile page in a throwaway headless browser.
        try {
          const r = await instagramFollowers(url);
          return { count: r.count, source: r.exact ? "Public profile" : "Public profile (rounded)", note: null };
        } catch (e) {
          return { count: null, source: null, note: `Instagram did not show the count without a login (${String(e instanceof Error ? e.message : e)}), so there is no live number right now.` };
        }
      }
      const html = await page(url);
      const m = p === "tiktok" ? html.match(/"followerCount":(\d+)/) : html.match(/([\d.,]+[KM]?) Followers/);
      return m ? { count: parseCount(m[1]), source: "Public profile page", note: null } : { count: null, source: null, note: "The public page hides the count without a login, so there is no live number yet." };
    } catch (e) {
      return { count: null, source: null, note: `Could not read it (${String(e instanceof Error ? e.message : e)}).` };
    }
  }

  async function build(): Promise<Audience> {
    const l = await links();
    // One platform at a time: two of them start a headless browser.
    const results: Array<{ p: Platform; count: number | null; source: string | null; note: string | null; stale?: boolean }> = [];
    for (const p of SHOWN) results.push({ p, ...(await count(p, l[p] ?? null)) });
    const h = ((await bb.storage.kv.get<History>("audience-history")) ?? {}) as History;
    const today = day();
    // A route that fails today (a login wall, a rate limit) shows the last reading
    // from the past 3 days, labelled with its date, rather than nothing.
    lastBuildFailed = false;
    for (const r of results) {
      if (r.count !== null || !l[r.p]) continue;
      lastBuildFailed = true;
      const recent = Object.keys(h[r.p] ?? {}).filter((d) => d >= day(Date.now() - 3 * 86_400_000)).sort().at(-1);
      if (recent) {
        const when = recent === today ? "earlier today" : new Date(`${recent}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        Object.assign(r, { count: h[r.p][recent], source: `Last read ${when}; live read failed just now`, note: null, stale: true });
      }
    }
    for (const r of results) {
      if (r.count === null || r.stale) continue;
      const days = (h[r.p] ??= {});
      days[today] = r.count;
      const keep = Object.keys(days).sort().slice(-120);
      h[r.p] = Object.fromEntries(keep.map((k) => [k, days[k]]));
    }
    await bb.storage.kv.set("audience-history", h);
    const weekAgo = day(Date.now() - 7 * 86_400_000);
    return {
      platforms: results.map((r) => {
        // Change against the oldest snapshot within the last 7 days (null until we have one).
        const days = Object.keys(h[r.p] ?? {}).filter((d) => d >= weekAgo && d < today).sort();
        const base = days.length ? h[r.p][days[0]] : null;
        return {
          platform: r.p,
          label: LABEL[r.p],
          profileUrl: l[r.p] ?? null,
          count: r.count,
          change7d: r.count !== null && base !== null ? r.count - base : null,
          source: r.source,
          note: r.note,
        };
      }),
    };
  }

  async function audience(): Promise<Audience> {
    // A failed live read is retried after an hour rather than six.
    if (cache && Date.now() - cache.at < (lastBuildFailed ? 60 * 60_000 : CACHE_MS)) return cache.value;
    // One build at a time: the page loads start headless browsers.
    inflight ??= build()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function link(platform: Platform, url: string | null): Promise<Audience> {
    const l = await links();
    if (url) l[platform] = url;
    else delete l[platform];
    await settings.experimental_set({ audienceProfiles: Object.entries(l).map(([p, u]) => `${p}|${u}`).join("\n") });
    // A build that started before the change would return the old links: let it finish first.
    if (inflight) await inflight.catch(() => undefined);
    cache = null;
    return audience();
  }

  return { audience, link };
}

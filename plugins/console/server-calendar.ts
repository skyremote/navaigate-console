// Calendar page: events for a date range from both Composio Google Calendars
// (the Home agenda logic with a range), and Calendly booking links when a
// Calendly connection exists. Read-only; never creates connections.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { agendaSchema } from "./server-home";

export const calendarInput = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) });
export const calendlySchema = z.object({
  connected: z.boolean(),
  via: z.string().nullable(),
  error: z.string().nullable(),
  schedulingUrl: z.string().nullable(),
  eventTypes: z.array(z.object({ name: z.string(), url: z.string(), minutes: z.number().nullable() })),
});
type Calendly = z.infer<typeof calendlySchema>;
type Agenda = z.infer<typeof agendaSchema>;

type Home = { events(start: Date, end: Date, perCalendar?: number): Promise<Agenda>; composioKey(): string | null };

function calendlyToken(): string | null {
  if (process.env.CALENDLY_API_TOKEN) return process.env.CALENDLY_API_TOKEN;
  try {
    const m = fs.readFileSync(path.join(os.homedir(), ".config", "navaigate", "calendly.env"), "utf8").match(/^CALENDLY_API_TOKEN=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

type RawType = { name?: string; scheduling_url?: string; duration?: number; active?: boolean };
const toTypes = (xs: RawType[]) =>
  xs.filter((t) => t.active !== false && t.scheduling_url).map((t) => ({ name: String(t.name ?? "Meeting").slice(0, 80), url: String(t.scheduling_url), minutes: typeof t.duration === "number" ? t.duration : null }));

export function createCalendar(_bb: BbPluginApi, home: Home) {
  const cache = new Map<string, { at: number; value: Agenda }>();
  let calendlyCache: { at: number; value: Calendly } | null = null;

  async function range(from: string, to: string): Promise<Agenda> {
    const start = new Date(from);
    let end = new Date(to);
    if (end.getTime() - start.getTime() > 62 * 86_400_000) end = new Date(start.getTime() + 62 * 86_400_000);
    const k = `${start.toISOString()}|${end.toISOString()}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
    const value = await home.events(start, end);
    if (!value.error) {
      cache.set(k, { at: Date.now(), value });
      if (cache.size > 12) cache.delete(cache.keys().next().value as string);
    }
    return value;
  }

  async function calendly(): Promise<Calendly> {
    if (calendlyCache && Date.now() - calendlyCache.at < 30 * 60_000) return calendlyCache.value;
    const none: Calendly = { connected: false, via: null, error: null, schedulingUrl: null, eventTypes: [] };
    let value = none;
    try {
      const token = calendlyToken();
      if (token) {
        const get = async (p: string) => {
          const r = await fetch(`https://api.calendly.com${p}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
          if (!r.ok) throw new Error(`Calendly ${r.status}`);
          return r.json() as Promise<Record<string, unknown>>;
        };
        const me = (await get("/users/me")) as { resource: { uri: string; scheduling_url?: string } };
        const types = (await get(`/event_types?user=${encodeURIComponent(me.resource.uri)}&active=true&count=50`)) as { collection: RawType[] };
        value = { connected: true, via: "API token", error: null, schedulingUrl: me.resource.scheduling_url ?? null, eventTypes: toTypes(types.collection) };
      } else {
        const key = home.composioKey();
        if (key) {
          const api = async (p: string, init?: RequestInit) => {
            const r = await fetch(`https://backend.composio.dev/api/v3${p}`, { ...init, headers: { "x-api-key": key, "Content-Type": "application/json" }, signal: AbortSignal.timeout(25_000) });
            if (!r.ok) throw new Error(`Composio ${r.status}`);
            return r.json() as Promise<Record<string, unknown>>;
          };
          const list = (await api("/connected_accounts?toolkit_slugs=calendly&limit=20")) as { items?: Array<{ id: string; status: string; user_id: string; toolkit?: { slug?: string } }> };
          const acc = (list.items ?? []).find((a) => (a.toolkit?.slug ?? "calendly") === "calendly" && a.status === "ACTIVE");
          if (acc) {
            const exec = async (slug: string, args: Record<string, unknown>) =>
              ((await api(`/tools/execute/${slug}`, { method: "POST", body: JSON.stringify({ connected_account_id: acc.id, user_id: acc.user_id, arguments: args }) })) as { data?: Record<string, unknown> }).data ?? {};
            const me = (await exec("CALENDLY_GET_CURRENT_USER", {})) as { resource?: { uri?: string; scheduling_url?: string } };
            const uri = me.resource?.uri;
            const types = uri ? ((await exec("CALENDLY_LIST_USER_S_EVENT_TYPES", { user: uri, active: true })) as { collection?: RawType[] }) : {};
            value = { connected: true, via: "Composio", error: null, schedulingUrl: me.resource?.scheduling_url ?? null, eventTypes: toTypes(types.collection ?? []) };
          }
        }
      }
    } catch (e) {
      value = { ...none, connected: true, error: String(e instanceof Error ? e.message : e) };
    }
    calendlyCache = { at: Date.now(), value };
    return value;
  }

  return { range, calendly };
}

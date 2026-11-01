// Inbox page: every email from the last 7 (or 30) days across the owner's Gmail
// accounts, through Composio v3, read-only. "Sort with Jev" asks Jev one Choice
// (which pile) plus the needs-reply Noul, the from-a-person Noul and the urgency
// Score per email, 8 at a time. Code owns the "Reply today" rule. Each email's
// answers are kept in kv for 14 days, so a re-sort only sends new mail to Jev.
// Each run records its real wall time and cost (input tokens x Jev's price).
//
// Read-only always: list, read one message. Never send, label, archive, move,
// mark read or delete.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { addr, age, pool, readKey } from "./server-inbox";
import { owner, ownerHello } from "./server-words";
import { PRICE_PER_TOKEN } from "./server-ask";
import { PILE_IDS, REPLY_RULE, URGENCY_LEVELS, type PileId } from "./src/piles";

const jevSchema = z.object({
  /** Probability per pile option from the Choice (other folded into fyi). */
  probs: z.record(z.string(), z.number()),
  choice: z.string(),
  conf: z.number(),
  needsReply: z.number(),
  fromPerson: z.number(),
  urgency: z.number(),
  urgencyProbs: z.array(z.number()),
});
export const pageItemSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  account: z.string(),
  folder: z.enum(["inbox", "sent", "starred"]),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  snippet: z.string(),
  receivedAt: z.string(),
  unread: z.boolean(),
  starred: z.boolean(),
  category: z.string().nullable(),
  link: z.string(),
  pile: z.enum(PILE_IDS).nullable(),
  /** How sure Jev is of the final pile, 0..1. */
  sure: z.number().nullable(),
  /** True when the pile came from the Reply-today rule rather than the Choice alone. */
  byRule: z.boolean(),
  jev: jevSchema.nullable(),
});
export const runSchema = z.object({
  at: z.number(),
  days: z.number(),
  count: z.number(),
  fresh: z.number(),
  remembered: z.number(),
  failed: z.number(),
  wallMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  model: z.string().nullable(),
});
export const pageSchema = z.object({
  configured: z.boolean(),
  error: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  days: z.number(),
  accounts: z.array(z.object({ email: z.string(), inbox: z.number() })),
  items: z.array(pageItemSchema),
  lastRun: runSchema.nullable(),
});
export const sortStatusSchema = z.object({
  running: z.boolean(),
  done: z.number(),
  total: z.number(),
  remembered: z.number(),
  count: z.number(),
  startedAt: z.number(),
  error: z.string().nullable(),
  run: runSchema.nullable(),
  /** The most recent answers (id and pile), so the app can show Jev touching each email. */
  recent: z.array(z.object({ id: z.string(), pile: z.enum(PILE_IDS) })),
});
export const messageSchema = z.object({
  from: z.string(),
  to: z.string(),
  date: z.string(),
  subject: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});
type Page = z.infer<typeof pageSchema>;
type PageItem = z.infer<typeof pageItemSchema>;
type Run = z.infer<typeof runSchema>;
export type InboxPageData = Page;
export type InboxPageItem = PageItem;
export type InboxRun = Run;
export type InboxMessage = z.infer<typeof messageSchema>;
type SortStatus = z.infer<typeof sortStatusSchema>;

type Stored = { p: Record<string, number>; c: string; cf: number; nr: number; fp: number; u: number; up: number[]; at: number };
type Msg = Omit<PageItem, "pile" | "sure" | "byRule" | "jev">;
type Conn = { id: string; user_id: string };

const LIST_MS = 5 * 60_000;
const KEEP_MS = 14 * 86_400_000;
const STORE = "inbox-piles-v1";
const RUNS = "inbox-page-runs";
const CONCURRENCY = 8;
const BODY_MAX = 40_000;

const pileCriteria = (): Record<string, unknown> => ({
  reply_today: {
    what: `A person writes to ${owner()} personally and asks him to answer, decide or act, and needs it soon`,
    not_for: "Automated messages, newsletters and cold sales pitches",
    examples: ["Can you confirm the numbers by end of day?", "We are blocked until you approve this"],
  },
  clients: {
    what: "A client, prospect or lead writes about paid work: a project, a proposal, a workshop, a build, a booking or a sales enquiry",
    not_for: `Automated booking notifications from a scheduling tool, and unsolicited pitches selling to ${owner()}`,
    examples: ["Following up on the proposal you sent last week", "We would like to book an AI workshop for our team"],
  },
  partners: {
    what: "A partner, collaborator, sponsor, investor or co-founder writes about working together, a sponsorship, a deal or a joint venture",
    examples: ["Would you be open to a sponsorship on your channel?", "Notes from the investor call, next steps attached"],
  },
  billing: {
    what: "Money admin: receipts, invoices, payments, subscriptions, payouts, bank and tax notices, failed charges",
    examples: ["Your receipt from Anthropic", "Invoice INV-2041 is due on Friday", "Payment failed for your Vercel plan"],
  },
  community: {
    what: `${owner()}'s Skool community: new members, posts, comments, likes and messages sent through Skool`,
    examples: ["New member joined your community", "Someone commented on your post"],
  },
  social: {
    what: "Automated notifications from social networks, apps and tools: likes, follows, mentions, calendar invites and updates, code and deploy alerts, sign-in alerts and verification codes",
    not_for: "Skool community notifications",
    examples: ["You appeared in 12 searches this week", "Invitation: Weekly sync, Tuesday 10am", "Your deployment is ready", "Your verification code is 182688"],
  },
  newsletters: {
    what: `Newsletters, digests, product announcements, webinars, and promotions or offers from brands, shops and services ${owner()} has signed up to`,
    examples: ["This week in AI: five things to know", "Introducing our new pricing plans", "Half-price first month for members"],
  },
  fyi: {
    what: `Information for ${owner()}, from a person or a service, that asks nothing of him and fits no other pile`,
    examples: ["Thanks, all sorted!", "A document has been shared with you"],
  },
  spam: {
    what: "Unsolicited cold outreach from strangers, scams, phishing and junk: mass sales pitches, fake invoices, link-building and lead-list offers",
    not_for: `Marketing and promotions from a brand, shop or service ${owner()} has signed up to`,
    examples: ["I can get your website to page one of Google", "Your mailbox is full, click here to verify"],
  },
  other: "Anything that fits none of the other piles",
});
const URGENCY_CRITERIA = [
  "No reply is expected by any particular time, or the email is for information only",
  "The sender expects a reply at some point in the coming week",
  "The sender asks for a reply or action within a day or two, or mentions a date that is close",
  "The sender needs a reply today, or says something is blocked, failing, overdue or at risk",
];
const CATEGORY: Record<string, string> = {
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
  CATEGORY_PERSONAL: "primary",
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The final pile, decided in code from Jev's answers. */
export function decide(s: Stored): { pile: PileId; sure: number; byRule: boolean } {
  const ruled = s.nr >= REPLY_RULE.needsReply && s.fp >= REPLY_RULE.fromPerson && s.u >= REPLY_RULE.urgency;
  const machine = ["spam", "newsletters", "social", "community"].includes(s.c) && (s.p[s.c] ?? 0) >= 0.6;
  if (ruled && !machine) return { pile: "reply_today", sure: r3(Math.min(s.nr, s.fp)), byRule: true };
  // Reply today without the rule's backing falls to Jev's next-best pile.
  const ranked = Object.entries(s.p)
    .filter(([k]) => k !== "reply_today")
    .sort((a, b) => b[1] - a[1]);
  const top = (s.c !== "reply_today" ? s.c : ranked[0]?.[0]) ?? "fyi";
  const pile = (PILE_IDS as readonly string[]).includes(top) ? (top as PileId) : "fyi";
  const mass = Object.entries(s.p).filter(([k]) => k !== "reply_today").reduce((a, [, v]) => a + v, 0) || 1;
  const sure = s.c === "reply_today" ? (s.p[pile] ?? 0) / mass : s.p[pile] ?? s.cf;
  return { pile, sure: r3(sure), byRule: false };
}

function decodeB64(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Array<{ name: string; value: string }> };
function findPart(p: Part | undefined, mime: string): string | null {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data) return decodeB64(p.body.data);
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return null;
}
/** HTML to readable plain text. The app renders the result as text, never as HTML. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const t = label.replace(/<[^>]+>/g, "").trim();
      return t && !href.includes(t) ? `${t} (${href.length > 90 ? `${href.slice(0, 90)}…` : href})` : t || href;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
}
/** Gmail previews arrive HTML-escaped ("Here&#39;s"); the app shows plain text. */
const unescape = (t: string) =>
  t
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
const tidy = (t: string) =>
  t
    .replace(/[\u200B-\u200D\u2060\uFEFF\u034F\u00AD]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export function createInboxPage(bb: BbPluginApi, composioKey: () => string | null) {
  const lists = new Map<number, { at: number; msgs: Msg[]; accounts: string[]; conns: Conn[] }>();
  const inflight = new Map<number, Promise<{ msgs: Msg[]; accounts: string[]; conns: Conn[] }>>();
  let status: SortStatus = { running: false, done: 0, total: 0, remembered: 0, count: 0, startedAt: 0, error: null, run: null, recent: [] };

  const api = async (key: string, p: string, init?: RequestInit) => {
    const r = await fetch(`https://backend.composio.dev/api/v3${p}`, {
      ...init,
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) throw new Error(`Composio ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  };

  async function activeConns(key: string): Promise<Conn[]> {
    const list = (await api(key, "/connected_accounts?toolkit_slugs=gmail&limit=50")) as { items?: Array<{ id: string; status: string; user_id: string; toolkit?: { slug?: string } }> };
    const seen = new Set<string>();
    return (list.items ?? []).filter((a) => (a.toolkit?.slug ?? "gmail") === "gmail" && a.status === "ACTIVE" && !seen.has(a.user_id) && seen.add(a.user_id));
  }

  async function fetchAll(key: string, days: number) {
    const conns = await activeConns(key);
    // Composio spends about 180 ms per message and pages run in series, so the
    // range is split into half-day windows fetched in parallel (7 days in a few
    // seconds, not ~35 s). Each window still pages until complete or capped.
    const span = (days > 7 ? 1 : 0.5) * 86_400;
    const now = Math.floor(Date.now() / 1000);
    const windows = Array.from({ length: Math.ceil((days * 86_400) / span) }, (_x, i) => ({ after: now - (i + 1) * span, before: i === 0 ? null : now - i * span }));
    const jobs = conns.flatMap((a) => windows.map((w) => ({ a, w })));
    const got = await pool(jobs, 24, async ({ a, w }) => {
      const out: Array<Record<string, unknown>> = [];
      let page: string | undefined;
      const query = `after:${w.after}${w.before ? ` before:${w.before}` : ""} (in:inbox OR in:sent OR is:starred)`;
      do {
        // Read-only listing: metadata and a short preview, no payloads.
        const r = (await api(key, "/tools/execute/GMAIL_FETCH_EMAILS", {
          method: "POST",
          body: JSON.stringify({
            connected_account_id: a.id,
            user_id: a.user_id,
            arguments: { query, max_results: 50, include_payload: false, verbose: false, ...(page ? { page_token: page } : {}) },
          }),
        })) as { successful?: boolean; error?: string | null; data?: { messages?: Array<Record<string, unknown>>; nextPageToken?: string } };
        if (r.successful === false) throw new Error(`Gmail ${a.user_id}: ${String(r.error ?? "failed").slice(0, 120)}`);
        out.push(...(r.data?.messages ?? []));
        page = r.data?.nextPageToken || undefined;
      } while (page && out.length < 150);
      return out.map((m) => toMsg(m, a.user_id));
    });
    const byId = new Map<string, Msg>();
    for (const m of got.flat()) if (m.id) byId.set(`${m.account}:${m.id}`, m);
    return { msgs: [...byId.values()], accounts: conns.map((c) => c.user_id), conns };
  }

  function toMsg(m: Record<string, unknown>, account: string): Msg {
    const preview = (m.preview ?? {}) as { body?: string; subject?: string };
    const labels = (m.labelIds ?? []) as string[];
    const threadId = String(m.threadId ?? m.messageId ?? "");
    const cat = labels.map((l) => CATEGORY[l]).find(Boolean) ?? null;
    return {
      id: String(m.messageId ?? ""),
      threadId,
      account,
      folder: labels.includes("INBOX") ? "inbox" : labels.includes("SENT") ? "sent" : "starred",
      from: String(m.sender ?? "").slice(0, 160),
      to: String(m.to ?? "").slice(0, 200),
      subject: unescape(String(m.subject ?? preview.subject ?? "(no subject)")).slice(0, 200),
      snippet: unescape(String(preview.body ?? "")).replace(/[\u200B-\u200D\u2060\uFEFF\u034F\u00AD]/g, "").replace(/\s+/g, " ").trim().slice(0, 240),
      receivedAt: String(m.messageTimestamp ?? ""),
      unread: labels.includes("UNREAD"),
      starred: labels.includes("STARRED"),
      category: cat,
      link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${threadId}`,
    };
  }

  async function mail(days: number, refresh: boolean) {
    const hit = lists.get(days);
    if (hit && !refresh && Date.now() - hit.at < LIST_MS) return hit;
    let p = inflight.get(days);
    if (!p) {
      const key = composioKey();
      if (!key) throw new Error("not-configured");
      p = fetchAll(key, days).finally(() => inflight.delete(days));
      inflight.set(days, p);
    }
    const v = await p;
    // One row per thread and folder: the newest message, like Gmail's list.
    v.msgs.sort((x, y) => y.receivedAt.localeCompare(x.receivedAt));
    const seen = new Set<string>();
    const own = new Set(v.accounts.map((x) => x.toLowerCase()));
    const msgs = v.msgs.filter((m) => {
      if (!m.id) return false;
      // Inbox rows are the newest message someone else sent; the owner's own replies live under Sent.
      if (m.folder === "inbox" && own.has(addr(m.from))) return false;
      const k = `${m.folder}:${m.account}:${m.threadId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const entry = { at: Date.now(), msgs, accounts: v.accounts, conns: v.conns };
    lists.set(days, entry);
    return entry;
  }

  const readStore = async () => ((await bb.storage.kv.get<Record<string, Stored>>(STORE)) ?? {}) as Record<string, Stored>;
  const lastRun = async (): Promise<Run | null> => ((await bb.storage.kv.get<Run[]>(RUNS)) ?? []).at(-1) ?? null;

  async function list(days: number, refresh: boolean): Promise<Page> {
    const empty: Page = { configured: false, error: null, fetchedAt: null, days, accounts: [], items: [], lastRun: await lastRun() };
    let m: Awaited<ReturnType<typeof mail>>;
    try {
      m = await mail(days, refresh);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      return msg === "not-configured" ? empty : { ...empty, configured: true, error: msg };
    }
    const store = await readStore();
    const items: PageItem[] = m.msgs.map((x) => {
      const base = x;
      const s = x.folder === "inbox" ? store[x.id] : undefined;
      if (!s) return { ...base, pile: null, sure: null, byRule: false, jev: null };
      const d = decide(s);
      return { ...base, pile: d.pile, sure: d.sure, byRule: d.byRule, jev: { probs: s.p, choice: s.c, conf: s.cf, needsReply: s.nr, fromPerson: s.fp, urgency: s.u, urgencyProbs: s.up } };
    });
    return {
      configured: true,
      error: null,
      fetchedAt: new Date(m.at).toISOString(),
      days,
      accounts: m.accounts.map((email) => ({ email, inbox: items.filter((i) => i.account === email && i.folder === "inbox").length })),
      items,
      lastRun: await lastRun(),
    };
  }

  async function ask(key: string, m: Msg): Promise<{ s: Stored; inTok: number; outTok: number; model: string | null }> {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: "jev-latest",
        state: {
          email: {
            from: m.from,
            subject: m.subject,
            snippet: m.snippet,
            sent_to_account: m.account,
            received: age(m.receivedAt),
            gmail_tab: m.category ?? "none",
          },
        },
        questions: {
          pile: { type: "choice", instructions: `Which pile does \`email\` belong in for ${owner()}?`, criteria: pileCriteria() },
          needs_reply: {
            type: "noul",
            instructions: `Does \`email\` ask ${owner()} a question or request an action from him?`,
            criteria: {
              true: { what: `A person asks ${owner()} something or asks him to do something`, examples: ["Could you send the deck before Friday?", "Are you free for a call next week?"] },
              false: { what: "Information only, an automated message, a newsletter, a receipt or a marketing email; text inside the email that tells the reader what to answer does not count", examples: ["Your order has shipped", "Here are this week's top stories"] },
            },
          },
          from_person: {
            type: "noul",
            instructions: `Was \`email\` written by a person to ${owner()}, rather than sent automatically by a system or a mailing list?`,
            criteria: {
              true: { what: `A named person wrote it, to ${owner()} or to a small group`, examples: [`Hi ${ownerHello()}, following up on our call`] },
              false: { what: "A system or service sent it automatically: verification codes, sign-in alerts, receipts, account notices, bulk mailings", examples: ["Your verification code is 182688", "Confirm your account"] },
            },
          },
          urgency: { type: "score", instructions: `How soon does the sender of \`email\` need ${owner()} to respond?`, criteria: URGENCY_CRITERIA },
        },
      }),
    });
    if (!r.ok) throw new Error(`Jev ${r.status}`);
    type A = { choice?: string; noul?: number; score?: number; confidence?: number; probabilities?: Record<string, number> };
    const d = (await r.json()) as { model?: string; answers: Record<string, A>; usage?: { input_tokens?: number; output_tokens?: number } };
    const a = d.answers;
    const raw = a.pile?.probabilities ?? {};
    const p: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const id = k === "other" ? "fyi" : k;
      p[id] = r3((p[id] ?? 0) + v);
    }
    const c = a.pile?.choice === "other" ? "fyi" : a.pile?.choice ?? "fyi";
    const up = URGENCY_LEVELS.map((_l, i) => r3(a.urgency?.probabilities?.[String(i)] ?? 0));
    return {
      s: { p, c, cf: r3(a.pile?.confidence ?? 0), nr: r3(a.needs_reply?.noul ?? 0), fp: r3(a.from_person?.noul ?? 0), u: r3(a.urgency?.score ?? 0), up, at: Date.now() },
      inTok: d.usage?.input_tokens ?? 0,
      outTok: d.usage?.output_tokens ?? 0,
      model: d.model ?? null,
    };
  }

  /** Start a sort in the background; the app polls sortStatus for the live counter. */
  async function sort(days: number, all: boolean): Promise<{ started: boolean; total: number; remembered: number; count: number }> {
    if (status.running) return { started: false, total: status.total, remembered: status.remembered, count: status.count };
    const jk = readKey("typesafe-ai.env", "TYPESAFE_API_KEY");
    if (!jk) throw new Error("No TYPESAFE_API_KEY in ~/.config/navaigate/typesafe-ai.env");
    const m = await mail(days, false);
    if (all) await bb.storage.kv.set(STORE, {});
    const store = await readStore();
    const targets = m.msgs.filter((x) => x.folder === "inbox");
    const fresh = targets.filter((x) => !store[x.id]);
    const remembered = targets.length - fresh.length;
    status = { running: true, done: 0, total: fresh.length, remembered, count: targets.length, startedAt: Date.now(), error: null, run: null, recent: [] };

    void (async () => {
      let inTok = 0;
      let outTok = 0;
      let failed = 0;
      let model: string | null = null;
      let fatal: string | null = null;
      const t0 = performance.now();
      await pool(fresh, CONCURRENCY, async (x) => {
        try {
          if (fatal) return void failed++;
          const r = await ask(jk, x);
          store[x.id] = r.s;
          status.recent = [...status.recent.slice(-63), { id: x.id, pile: decide(r.s).pile }];
          inTok += r.inTok;
          outTok += r.outTok;
          model = r.model ?? model;
        } catch (e) {
          failed++;
          const msg = String(e instanceof Error ? e.message : e);
          if (/401|403/.test(msg)) fatal = msg;
          status.error = msg;
        } finally {
          status.done++;
        }
      });
      const wallMs = Math.round(performance.now() - t0);
      try {
        const keep = Date.now() - KEEP_MS;
        for (const [k, v] of Object.entries(store)) if (v.at < keep) delete store[k];
        await bb.storage.kv.set(STORE, store);
        const run: Run = { at: Date.now(), days, count: targets.length, fresh: fresh.length - failed, remembered, failed, wallMs, inputTokens: inTok, outputTokens: outTok, costUsd: inTok * PRICE_PER_TOKEN, model };
        const runs = ((await bb.storage.kv.get<Run[]>(RUNS)) ?? []).slice(-19);
        await bb.storage.kv.set(RUNS, [...runs, run]);
        status = { ...status, running: false, run };
      } catch (e) {
        status = { ...status, running: false, error: String(e) };
      }
    })().catch((e) => {
      bb.log.warn(`inbox sort: ${String(e)}`);
      status = { ...status, running: false, error: String(e) };
    });
    return { started: true, total: fresh.length, remembered, count: targets.length };
  }

  /** The full body of one message, as plain text. Read-only. */
  async function message(account: string, id: string): Promise<z.infer<typeof messageSchema>> {
    const key = composioKey();
    if (!key) throw new Error("Composio is not configured");
    const conn = [...lists.values()].flatMap((l) => l.conns).find((c) => c.user_id === account) ?? (await activeConns(key)).find((c) => c.user_id === account);
    if (!conn) throw new Error("That account is not connected");
    const r = (await api(key, "/tools/execute/GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
      method: "POST",
      body: JSON.stringify({ connected_account_id: conn.id, user_id: conn.user_id, arguments: { message_id: id, format: "full" } }),
    })) as { successful?: boolean; error?: string | null; data?: Record<string, unknown> };
    if (r.successful === false || !r.data) throw new Error(`Gmail: ${String(r.error ?? "failed").slice(0, 120)}`);
    const d = r.data;
    const payload = d.payload as Part | undefined;
    const header = (n: string) => payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const plain = findPart(payload, "text/plain");
    const html = plain ? null : findPart(payload, "text/html");
    const fallback = String(d.messageText ?? "");
    let text = tidy(plain ?? (html ? htmlToText(html) : /<\w+[^>]*>/.test(fallback) ? htmlToText(fallback) : fallback));
    const truncated = text.length > BODY_MAX;
    if (truncated) text = text.slice(0, BODY_MAX);
    return {
      from: String(d.sender ?? header("from")).slice(0, 200),
      to: String(d.to ?? header("to")).slice(0, 400),
      date: String(d.messageTimestamp ?? header("date")),
      subject: String(d.subject ?? header("subject")).slice(0, 300),
      text,
      truncated,
    };
  }

  return { list, sort, status: () => status, message };
}

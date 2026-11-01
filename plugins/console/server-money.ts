// Money on Home: Qonto balances and this month's in and out, read-only, for
// several Qonto organisations. The first is the existing Qonto login and
// secret key (NavAIgate GmbH & Co. KG); more come from the secret setting
// qontoMore, one per line as Label|login|secret. Accounts connected inside
// Qonto (such as Revolut) are included. A combined total is given in EUR.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Settings = { get(): Promise<Record<string, unknown>> };

const txSchema = z.object({ label: z.string(), amount: z.number(), side: z.string(), currency: z.string(), date: z.string() });
export const moneySchema = z.object({
  configured: z.boolean(),
  error: z.string().nullable(),
  orgs: z.array(
    z.object({
      label: z.string(),
      error: z.string().nullable(),
      accounts: z.array(z.object({ name: z.string(), balance: z.number(), currency: z.string(), external: z.boolean() })),
      monthIn: z.number(),
      monthOut: z.number(),
      recent: z.array(txSchema),
    }),
  ),
  totalEur: z.number().nullable(),
  totalNote: z.string().nullable(),
});
type Money = z.infer<typeof moneySchema>;
type Org = Money["orgs"][number];

export const FIRST_ORG = "NavAIgate GmbH & Co. KG";

export function parseMore(raw: unknown): Array<{ label: string; login: string; secret: string }> {
  return String(raw ?? "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("|").map((x) => x.trim()))
    .filter((p) => p.length >= 3 && p[0] && p[1] && p[2])
    .map(([label, login, ...rest]) => ({ label: label.slice(0, 60), login, secret: rest.join("|") }))
    .slice(0, 6);
}

async function org(label: string, login: string, secret: string): Promise<Org> {
  const q = async (p: string) => {
    const r = await fetch(`https://thirdparty.qonto.com/v2${p}`, { headers: { Authorization: `${login}:${secret}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`Qonto ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  };
  try {
    const o = (await q("/organization?include_external_accounts=true")) as {
      organization?: { bank_accounts?: Array<{ id: string; name: string; balance?: number; balance_cents?: number; currency: string; is_external_account?: boolean; status?: string }> };
    };
    const banks = (o.organization?.bank_accounts ?? [])
      .filter((b) => b.status !== "closed")
      .map((b) => ({ id: b.id, name: b.is_external_account ? `${b.name} · via Qonto` : b.name, balance: typeof b.balance === "number" ? b.balance : (b.balance_cents ?? 0) / 100, currency: b.currency, external: !!b.is_external_account }));
    const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    let monthIn = 0;
    let monthOut = 0;
    const recent: z.infer<typeof txSchema>[] = [];
    for (const b of banks.slice(0, 4)) {
      const tx = (await q(`/transactions?bank_account_id=${encodeURIComponent(b.id)}&settled_at_from=${encodeURIComponent(since)}&per_page=100&sort_by=settled_at:desc`)) as {
        transactions?: Array<{ label: string; amount: number; side: string; currency: string; settled_at: string | null; emitted_at: string }>;
      };
      for (const t of tx.transactions ?? []) {
        if (t.side === "credit") monthIn += t.amount;
        else monthOut += t.amount;
        recent.push({ label: t.label, amount: t.amount, side: t.side, currency: t.currency, date: t.settled_at ?? t.emitted_at });
      }
    }
    recent.sort((a, b) => b.date.localeCompare(a.date));
    return { label, error: null, accounts: banks.map(({ id: _id, ...rest }) => rest), monthIn, monthOut, recent: recent.slice(0, 6) };
  } catch (e) {
    return { label, error: String(e instanceof Error ? e.message : e), accounts: [], monthIn: 0, monthOut: 0, recent: [] };
  }
}

export function createMoney(_bb: BbPluginApi, settings: Settings) {
  let rates: { at: number; eur: Record<string, number> } | null = null;
  // EUR per unit of another currency, from the ECB reference rates (public, read-only).
  async function toEur(currency: string): Promise<number | null> {
    if (currency === "EUR") return 1;
    try {
      if (!rates || Date.now() - rates.at > 12 * 3_600_000) {
        const r = await fetch("https://api.frankfurter.app/latest?from=EUR", { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(String(r.status));
        rates = { at: Date.now(), eur: ((await r.json()) as { rates: Record<string, number> }).rates };
      }
      const per = rates.eur[currency];
      return per ? 1 / per : null;
    } catch {
      return null;
    }
  }

  async function money(): Promise<Money> {
    const s = await settings.get();
    const list = [
      ...(String(s.qontoLogin ?? "").trim() && String(s.qontoSecretKey ?? "").trim() ? [{ label: FIRST_ORG, login: String(s.qontoLogin).trim(), secret: String(s.qontoSecretKey).trim() }] : []),
      ...parseMore(s.qontoMore),
    ];
    if (!list.length) return { configured: false, error: null, orgs: [], totalEur: null, totalNote: null };
    const orgs = await Promise.all(list.map((o) => org(o.label, o.login, o.secret)));
    let total = 0;
    const missing = new Set<string>();
    for (const o of orgs)
      for (const a of o.accounts) {
        const f = await toEur(a.currency);
        if (f === null) missing.add(a.currency);
        else total += a.balance * f;
      }
    const failed = orgs.filter((o) => o.error).map((o) => o.label);
    const notes = [missing.size ? `${[...missing].join(", ")} left out (no rate)` : null, failed.length ? `${failed.join(", ")} could not be read` : null].filter(Boolean);
    return {
      configured: true,
      error: failed.length === orgs.length ? orgs[0].error : null,
      orgs,
      totalEur: failed.length === orgs.length ? null : Math.round(total * 100) / 100,
      totalNote: notes.length ? notes.join("; ") : null,
    };
  }

  return { money };
}

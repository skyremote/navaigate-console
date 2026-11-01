// Money card on Home: each Qonto organisation's accounts grouped under its
// label (external accounts such as Revolut included), this month's in and out
// per organisation, and a combined total in EUR. Read-only.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { moneySchema } from "../server-money";
import type { z } from "zod";
import { caps, tnum } from "./shared";

type Money = z.infer<typeof moneySchema>;
const fmt = (n: number, c: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency: c || "EUR", maximumFractionDigits: 0 }).format(n);

export function MoneyCard() {
  const rpc = useRpc<typeof rpcContract>();
  const [money, setMoney] = useState<Money | null>(null);
  const load = useCallback(() => {
    rpc.call("home_money").then((v) => setMoney(v as Money), () => {});
  }, [rpc]);
  useEffect(() => {
    load();
    const id = window.setInterval(() => document.visibilityState === "visible" && load(), 10 * 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <section className="rounded-[14px] border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline gap-2">
        <span className={caps}>Money · Qonto</span>
        {money?.totalEur !== null && money?.totalEur !== undefined ? (
          <span className="ml-auto text-right">
            <span className="text-[11px] text-muted-foreground">Combined </span>
            <span className="text-[18px] font-medium text-foreground" style={tnum}>
              {fmt(money.totalEur, "EUR")}
            </span>
            {money.totalNote ? <span className="block text-[11px] text-muted-foreground">{money.totalNote}</span> : null}
          </span>
        ) : null}
      </div>
      {!money ? (
        <div className="text-[12px] text-muted-foreground">Loading…</div>
      ) : !money.configured ? (
        <div className="text-[13px] leading-relaxed text-muted-foreground">
          Connect Qonto read-only: in the Qonto app open <b>Settings</b>, <b>Integrations &amp; partnerships</b>, <b>API key</b>, then paste the login and secret key into Settings, Plugins, NavAIgate Workspace (<b>Qonto login</b> and <b>Qonto secret key</b>). Further companies go in <b>More Qonto organisations</b> as Label|login|secret. Keys stay on this Mac.
        </div>
      ) : money.error ? (
        <div className="text-[13px] text-destructive-text">{money.error}</div>
      ) : (
        <div className="flex flex-col gap-4">
          {money.orgs.map((o, i) => {
            const cur = o.accounts[0]?.currency ?? "EUR";
            return (
              <div key={o.label} className={cn(i > 0 && "border-t border-border pt-4")}>
                <div className="mb-2 text-[13px] font-medium text-foreground">{o.label}</div>
                {o.error ? (
                  <div className="text-[12px] text-destructive-text">{o.error}</div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-6">
                      {o.accounts.map((a) => (
                        <div key={a.name}>
                          <div className="text-[11px] text-muted-foreground">{a.name}</div>
                          <div className="text-[22px] font-medium text-foreground" style={tnum}>
                            {fmt(a.balance, a.currency)}
                          </div>
                        </div>
                      ))}
                      <div>
                        <div className="text-[11px] text-muted-foreground">This month</div>
                        <div className="text-[13px]" style={tnum}>
                          <span className="text-success">+{fmt(o.monthIn, cur)}</span>
                          <span className="text-muted-foreground"> · </span>
                          <span className="text-destructive-text">−{fmt(o.monthOut, cur)}</span>
                        </div>
                      </div>
                    </div>
                    {o.recent.length ? (
                      <div className="mt-3 border-t border-border pt-2">
                        {o.recent.map((t, j) => (
                          <div key={j} className="grid grid-cols-[1fr_auto] gap-3 py-0.5 text-[12px]">
                            <span className="truncate text-foreground">{t.label}</span>
                            <span style={{ ...tnum, color: t.side === "credit" ? "var(--success)" : undefined }}>
                              {t.side === "credit" ? "+" : "−"}
                              {fmt(t.amount, t.currency)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

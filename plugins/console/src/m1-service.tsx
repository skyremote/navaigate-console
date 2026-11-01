// The always-on Mac as a background service, shown where you pick it in
// the rail. It reads the always-on Mac only (see server-m1-service.ts) and turns the
// reading into the three things a reboot check needs: bb running, no desktop
// session, keep-awake held, plus when the Mac last booted.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { M1ServiceState } from "../server-m1-service";
import { serviceView, type Tone } from "./m1-service-model";
import { caps, tnum } from "./shared";
import { rpcFlight } from "./rpc-flight";
import { useVisiblePoll } from "./visible-poll";
import { mac, macLabel } from "./words";
import { useProfile } from "./use-profile";

const REFRESH_MS = 30_000;

const TONE: Record<Tone, string> = {
  ok: "var(--success)",
  warn: "var(--attention)",
  bad: "var(--destructive)",
  muted: "var(--muted-foreground)",
};

export function useM1Service() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<M1ServiceState | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback((fresh: boolean) => {
    setChecking(true);
    rpcFlight()
      .call("m1_service", () => rpc.call("m1_service", null), { fresh, ttlMs: REFRESH_MS / 2, slowStrikes: false })
      .then(setState, () => setState((old) => old ?? { reachable: false, probe: null, checkedAt: Date.now(), error: `The plugin could not ask ${mac()}` }))
      .finally(() => setChecking(false));
  }, [rpc]);
  const poll = useCallback(() => load(false), [load]);
  const reload = useCallback(() => load(true), [load]);
  useEffect(poll, [poll]);
  useVisiblePoll(poll, REFRESH_MS);
  return { state, checking, reload };
}

export function M1ServiceCard() {
  useProfile();
  const { state, checking, reload } = useM1Service();
  const view = serviceView({ reachable: state ? state.reachable : null, probe: state?.probe ?? null });
  const check = view.reboot;
  return (
    <section data-nav-part="m1-service" aria-label={`${macLabel()} service`} className="mx-1 mb-4 rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className={cn(caps, "text-foreground")}>{macLabel()} service</span>
        <button type="button" onClick={reload} disabled={checking} className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground outline-none hover:bg-[var(--state-hover)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
          Check now
        </button>
      </div>
      <p data-nav-role="headline" data-tone={view.tone} className="mt-1 flex items-center gap-2 text-[14px] font-medium leading-6 text-foreground">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: TONE[view.tone] }} />
        {view.headline}
      </p>
      {view.rows.length > 0 ? (
        <dl className={cn("mt-2 space-y-1.5 text-[12px]", view.stale && "text-muted-foreground")}>
          {view.rows.map((row) => (
            <div key={row.key} data-nav-role="row" data-key={row.key} className="flex items-baseline gap-3">
              <dt className="shrink-0 text-muted-foreground" style={{ width: 76 }}>{row.label}</dt>
              <dd className="min-w-0 text-foreground" style={tnum}>
                <span style={{ color: row.tone === "muted" ? undefined : TONE[row.tone] }}>{row.value}</span>
                {row.detail ? <span className="block text-[11px] text-muted-foreground">{row.detail}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p data-nav-role="reboot-check" data-state={check.state} className="mt-2.5 border-t border-border pt-2 text-[12px] leading-snug text-muted-foreground">
        <span className="font-medium" style={{ color: check.state === "passed" ? TONE.ok : check.state === "failed" ? TONE.bad : undefined }}>
          Reboot check: {check.state === "passed" ? "passed so far" : check.state === "failed" ? "failing" : "not shown yet"}.
        </span>{" "}
        {check.text}
      </p>
      {state?.error ? <p className="mt-1 text-[11px] text-destructive-text">{state.error}</p> : null}
    </section>
  );
}

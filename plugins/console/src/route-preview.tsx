import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../server";
import { rpcFlight } from "./rpc-flight";
import type { RoutePreview, RoutePreviewMachine, RoutePreviewProvider, routePreviewInput } from "../server-route-preview";
import { machineName } from "./words";

const PREVIEW_TTL_MS = 5_000;

export type RoutePreviewRequest = z.input<typeof routePreviewInput>;
type State = { key: string; preview: RoutePreview | null; error: string | null };

export const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const explain = (error: unknown) => (error instanceof Error ? error.message : String(error));
const AUTH: Record<string, string> = { not_installed: "not installed", unauthenticated: "not signed in", expired: "sign-in expired", unsupported_version: "version not supported", unknown: "sign-in unknown" };

/** Asks Fleet, read-only, where this work would run. Settles a moment after the last change; an older answer never replaces a newer one. */
export function useRoutePreview(request: RoutePreviewRequest | null, delayMs = 350) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<State | null>(null);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const forceFresh = useRef(false);
  const key = request ? JSON.stringify(request) : null;
  useEffect(() => {
    if (!key) return;
    const ticket = ++latest.current;
    const timer = window.setTimeout(() => {
      const fresh = forceFresh.current;
      forceFresh.current = false;
      rpcFlight().call(`route_preview:${key}`, () => rpc.call("native_route_preview", JSON.parse(key) as RoutePreviewRequest), { ttlMs: PREVIEW_TTL_MS, fresh }).then(
        (preview) => { if (latest.current === ticket) setState({ key, preview, error: null }); },
        (cause: unknown) => { if (latest.current === ticket) setState({ key, preview: null, error: explain(cause) }); },
      );
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [rpc, key, tick, delayMs]);
  const refresh = useCallback(() => {
    forceFresh.current = true;
    setTick((value) => value + 1);
  }, []);
  return { state: key && state?.key === key ? state : null, refresh };
}

function providerLine(provider: RoutePreviewProvider, highlight: boolean) {
  const why = provider.available ? "" : provider.auth && AUTH[provider.auth] ? ` (${AUTH[provider.auth]})` : "";
  return <li key={provider.id} className={highlight ? "text-foreground" : undefined} data-provider={provider.id}>
    {provider.name} {provider.available ? "available" : "unavailable"}{why}, observed {clock(provider.observedAt)}
  </li>;
}

function MachineRow({ machine, providerId }: { machine: RoutePreviewMachine; providerId?: string }) {
  const verdict = machine.chosen ? "Chosen" : machine.eligible === false ? `Not eligible: ${machine.reasons.join("; ") || "no reason given"}` : machine.eligible ? "Eligible" : "No current report from this Mac";
  return <li data-testid={`route-preview-${machine.machine}`} className="rounded-md border border-border px-2 py-1.5">
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium text-foreground">{machineName(machine.machine)}</span>
      <span className={machine.chosen ? "text-foreground" : undefined}>{verdict}</span>
      {machine.xcode ? <span>{machine.xcode.verified ? `Xcode ${machine.xcode.version ?? "present"}` : "no Xcode"}</span> : null}
    </div>
    {machine.providers
      ? <ul className="mt-0.5 flex flex-col gap-0.5">{machine.providers.map((provider) => providerLine(provider, provider.id === providerId))}</ul>
      : <p className="mt-0.5">Providers not reported</p>}
  </li>;
}

export function RoutePreviewPanel({ request, providerId, label }: { request: RoutePreviewRequest | null; providerId?: string; label: string }) {
  const { state, refresh } = useRoutePreview(request);
  if (!request) return null;
  const preview = state?.preview ?? null;
  const headline = !state ? "Checking where this would run…"
    : state.error ? `Could not preview the route: ${state.error}`
    : preview?.refusal ? `Would not start: ${preview.refusal}`
    : preview?.route?.machine ? `${label} would start on ${machineName(preview.route.machine)}${preview.route.mode === "auto" ? "" : ", as chosen"}`
    : `Would not start: ${preview?.route?.reason ?? "no eligible Mac"}`;
  return <section data-testid="route-preview" aria-label="Route preview" className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
    <div className="flex items-center justify-between gap-2">
      <p className="font-medium text-foreground">{headline}</p>
      <button type="button" className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={refresh}>Refresh preview</button>
    </div>
    {preview?.route?.machine && preview.route.reason ? <p>{preview.route.reason}</p> : null}
    {preview?.route?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
    {preview && preview.machines.length > 0 ? <ul className="flex flex-col gap-1">{preview.machines.map((machine) => <MachineRow key={machine.machine} machine={machine} providerId={providerId} />)}</ul> : null}
    {preview ? <p>Checked {clock(preview.checkedAt)} from the model this dialog starts with; the final check runs when you send.</p> : null}
  </section>;
}

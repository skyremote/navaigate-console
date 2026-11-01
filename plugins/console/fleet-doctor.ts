import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import os from "node:os";
import { loadProfile } from "./profile/load";
import { machineOrder, thisMachine } from "./profile/schema";
import { macLabel, machineName } from "./server-words";

const FLEET = "fleet";
export const boardSchema = z
  .object({
    me: z.object({ serverId: z.string(), machineKey: z.string().optional() }).passthrough(),
    error: z.string().nullable().optional(),
    transport: z
      .object({
        broker: z.string(),
        lastSuccessfulSyncAt: z.number().nullable().optional(),
        directM1: z.string().optional(),
        directM1Error: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const detailSchema = z
  .object({
    machine: z.string(),
    owner: z.object({ appVersion: z.string().nullable().optional() }).passthrough().nullable(),
    routes: z.array(z.object({ kind: z.string(), state: z.string(), detail: z.string().nullable() }).passthrough()),
    activeRoute: z.string(),
    // Fleet sends null here when there is nothing to say (a verified Mac has no reason, an unreachable one no host id).
    binding: z.object({ verified: z.boolean(), enrolledHostId: z.string().nullish(), reason: z.string().nullish() }).passthrough(),
  })
  .passthrough();
type Board = z.infer<typeof boardSchema>;
type Detail = z.infer<typeof detailSchema>;
export type DoctorMachine = {
  machine: string;
  ok: boolean;
  activeRoute: string | null;
  appVersion: string | null;
  routes: { kind: string; state: string; detail: string | null }[];
  binding: string;
  error: string | null;
};
export type DoctorReport = {
  createdAt: number;
  self: { machine: string; appVersion: string | null };
  broker: { state: string; lastSyncAt: number | null; error: string | null; directM1: string | null; directM1Error: string | null };
  machines: DoctorMachine[];
  text: string;
};
export type DoctorSources = {
  machines?: readonly string[];
  board: () => Promise<Board>;
  ownerDetail: (machine: string) => Promise<Detail>;
  appVersion?: () => Promise<string | null>;
  timeoutMs?: number;
};
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The broker's own words stay; only credentials are removed. */
export function scrubCredentials(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, "[credential]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[credential]");
}

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`}`)),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function formatFleetDoctor(report: Omit<DoctorReport, "text">): string {
  const lines = [
    `This bb: ${machineName(report.self.machine)} · bb ${report.self.appVersion ?? "unknown"}`,
    `Broker: ${report.broker.state}${report.broker.lastSyncAt ? ` · last sync ${new Date(report.broker.lastSyncAt).toISOString()}` : ""}`,
    `Broker error: ${report.broker.error ?? "none"}`,
    `Direct ${macLabel()} link: ${report.broker.directM1 ?? "unknown"}${report.broker.directM1Error ? ` (${report.broker.directM1Error})` : ""}`,
  ];
  for (const machine of report.machines) {
    lines.push("");
    if (machine.error) {
      lines.push(`${machineName(machine.machine)}: unreadable (${machine.error})`);
      continue;
    }
    lines.push(
      `${machineName(machine.machine)}: ${machine.ok ? "OK" : "NO ROUTE"} · route ${machine.activeRoute}${machine.appVersion ? ` · bb ${machine.appVersion}` : ""}`,
    );
    for (const route of machine.routes) lines.push(`  ${route.kind} ${route.state}${route.detail ? ` (${route.detail})` : ""}`);
    lines.push(`  binding: ${machine.binding}`);
  }
  return lines.join("\n");
}

/** Gathers every machine in parallel; one failing or hanging machine is reported on its own row and never drops the rest. */
export async function collectFleetDoctor(sources: DoctorSources): Promise<DoctorReport> {
  const ms = sources.timeoutMs ?? 30_000;
  const machines = sources.machines ?? machineOrder(loadProfile().profile);
  const [board, appVersion, rows] = await Promise.all([
    bounded(sources.board(), ms, "broker status").then(
      (value) => ({ value, error: null as string | null }),
      (cause) => ({ value: null as Board | null, error: describe(cause) }),
    ),
    bounded((sources.appVersion ?? (async () => null))(), ms, "version lookup").catch(() => null),
    Promise.all(
      machines.map(async (machine): Promise<DoctorMachine> => {
        try {
          const detail = await bounded(sources.ownerDetail(machine), ms, `${machine} owner lookup`);
          return {
            machine,
            ok: detail.activeRoute !== "none",
            activeRoute: detail.activeRoute,
            appVersion: detail.owner?.appVersion ?? null,
            routes: detail.routes.map((route) => ({
              kind: route.kind,
              state: route.state,
              detail: route.detail ? scrubCredentials(route.detail) : null,
            })),
            binding: detail.binding.verified
              ? `verified enrolled host ${detail.binding.enrolledHostId || "?"}`
              : `not proven (${detail.binding.reason || "no reason given"})`,
            error: null,
          };
        } catch (cause) {
          return {
            machine,
            ok: false,
            activeRoute: null,
            appVersion: null,
            routes: [],
            binding: "unknown",
            error: scrubCredentials(describe(cause)),
          };
        }
      }),
    ),
  ]);
  const transport = board.value?.transport;
  const error = board.value?.error ?? board.error;
  const report = {
    createdAt: Date.now(),
    self: { machine: board.value?.me.machineKey ?? thisMachine(loadProfile().profile, os.hostname())?.id ?? os.hostname(), appVersion },
    broker: {
      state: transport?.broker ?? (board.value ? "unknown" : "unreadable"),
      lastSyncAt: transport?.lastSuccessfulSyncAt ?? null,
      error: error ? scrubCredentials(error) : null,
      directM1: transport?.directM1 ?? null,
      directM1Error: transport?.directM1Error ? scrubCredentials(transport.directM1Error) : null,
    },
    machines: rows,
  };
  return { ...report, text: formatFleetDoctor(report) };
}

export function createFleetDoctor(bb: BbPluginApi) {
  const call = <T extends z.ZodType>(method: string, input: unknown, outputSchema: T) =>
    bb.sdk.plugins.callRpc({ pluginId: FLEET, method, input: input as never, outputSchema }) as Promise<z.infer<T>>;
  return {
    run: () =>
      collectFleetDoctor({
        board: () => call("board_get", null, boardSchema),
        ownerDetail: (machine) => call("owner_detail_get", { machine }, detailSchema),
        appVersion: () => bb.sdk.system.version().then((value) => value.currentVersion),
      }),
  };
}

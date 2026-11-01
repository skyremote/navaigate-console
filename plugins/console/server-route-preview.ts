import { z } from "zod";
import { fleetRouteSchema, fleetWorkspaceSchema, type createFleetLink } from "./server-fleet";
import { knownMachine, machineKeys } from "./server-words";


export const routePreviewInput = z.object({
  machine: z.string().min(1).max(40),
  providerId: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  reasoningLevel: z.string().trim().min(1).max(80).optional(),
  serviceTier: z.string().trim().min(1).max(80).optional(),
  destinationProjectName: z.string().trim().min(1).max(200).optional(),
  workspace: fleetWorkspaceSchema.optional(),
  routing: z.object({
    workload: z.string().trim().min(1).max(60).optional(), needsNas: z.boolean().optional(), unattended: z.boolean().optional(),
    requiredCapabilities: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  }).strict().optional(),
}).strict();

const providerRow = z.object({
  id: z.string(), name: z.string(), available: z.boolean(), auth: z.string().nullable(), observedAt: z.number(), planLabel: z.string().nullable(),
});
const machineRow = z.object({
  machine: z.string(), chosen: z.boolean(), eligible: z.boolean().nullable(), reasons: z.array(z.string()), score: z.number().nullable(),
  providers: z.array(providerRow).nullable(), xcode: z.object({ verified: z.boolean(), version: z.string().nullable() }).nullable(),
});
export const routePreviewOutput = z.object({
  route: fleetRouteSchema.nullable(), refusal: z.string().nullable(), machines: z.array(machineRow), checkedAt: z.number(),
});
export type RoutePreview = z.infer<typeof routePreviewOutput>;
export type RoutePreviewMachine = z.infer<typeof machineRow>;
export type RoutePreviewProvider = z.infer<typeof providerRow>;

type Fleet = Pick<ReturnType<typeof createFleetLink>, "route" | "ownerDetail">;

/**
 * Fleet's read-only route check plus each Mac's provider availability, shown
 * before anything is sent. A refusal from the route check is returned as text,
 * not thrown, so the dialog can show why a start would not go ahead.
 */
export function createRoutePreview(fleet: Fleet, now: () => number = Date.now) {
  return async function preview(raw: z.input<typeof routePreviewInput>): Promise<RoutePreview> {
    const input = routePreviewInput.parse(raw);
    const { destinationProjectName, ...rest } = input;
    let route: z.infer<typeof fleetRouteSchema> | null = null;
    let refusal: string | null = null;
    try {
      route = fleetRouteSchema.parse(await fleet.route({ ...rest, ...(destinationProjectName ? { projectName: destinationProjectName } : {}) }));
    } catch (cause) {
      refusal = cause instanceof Error ? cause.message : String(cause);
    }
    const wanted = input.machine === "Auto" ? machineKeys() : [input.machine];
    const names = [...new Set([...wanted, ...(route?.candidates.map((candidate) => candidate.machine) ?? [])])].filter((name) => knownMachine(name));
    const details = await Promise.all(names.map((name) => fleet.ownerDetail(name).then((detail) => detail, () => null)));
    const machines = names.map((name, index) => {
      const candidate = route?.candidates.find((item) => item.machine === name);
      const detail = details[index];
      return {
        machine: name,
        chosen: !!route?.machine && route.machine === name,
        eligible: candidate ? candidate.eligible : null,
        reasons: candidate?.reasons ?? [],
        score: candidate?.score ?? null,
        providers: detail?.providers
          ? detail.providers.map((provider) => ({
            id: provider.id, name: provider.displayName ?? provider.id, available: provider.available, auth: provider.auth ?? null,
            observedAt: provider.observedAt, planLabel: provider.planLabel ?? null,
          }))
          : null,
        xcode: detail?.capabilities ? { verified: detail.capabilities.xcode.verified, version: detail.capabilities.xcode.version } : null,
      };
    });
    return { route, refusal, machines, checkedAt: now() };
  };
}

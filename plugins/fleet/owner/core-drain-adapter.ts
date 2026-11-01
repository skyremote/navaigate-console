// Adapter from the owner drain (owner/update-drain.ts) to core's update drain
// API (sdk.system.experimental_*UpdateDrain). Present only when the running
// core exposes those methods; vendor bb 0.48.1 does not, so the drain stays
// unavailable and no update is launched. Core's serverId is its own profile
// id, so the binding is the exact request id plus the proven primary host.
import { z } from "zod";
import type { UpdateDrainCoreGate, UpdateDrainCoreProof, UpdateDrainTarget } from "./update-drain";

const coreDrainSchema = z.object({
  requestId: z.string().nullable(),
  primaryHostId: z.string().nullable(),
  serverId: z.string(),
  state: z.enum(["not-held", "pending", "held"]),
  armed: z.boolean(),
  cancelRequested: z.boolean(),
  admissionClosed: z.boolean(),
  atomic: z.literal(true),
  persistent: z.literal(true),
  activeOperations: z.number().int().nonnegative().nullable(),
  reason: z.string().nullable(),
}).passthrough();

type CoreDrainMethod = (input: Record<string, unknown>) => Promise<unknown>;
export interface CoreDrainSdk {
  experimental_acquireUpdateDrain?: CoreDrainMethod;
  experimental_updateDrainStatus?: CoreDrainMethod;
  experimental_armUpdateDrain?: CoreDrainMethod;
  experimental_cancelUpdateDrain?: CoreDrainMethod;
  experimental_releaseUpdateDrain?: CoreDrainMethod;
}

export const CANCEL_REQUESTED = "core-drain-cancel-requested";

function proof(input: UpdateDrainTarget, raw: unknown): UpdateDrainCoreProof {
  const core = coreDrainSchema.parse(raw);
  if (core.requestId !== input.intentId) throw new Error(`Core drain answered for ${core.requestId ?? "no request"}, not ${input.intentId}`);
  if (core.primaryHostId !== input.hostId) throw new Error("Core drain is bound to another primary host");
  if (core.cancelRequested) throw new Error(`${CANCEL_REQUESTED}: the update was cancelled on the owner; stop before signalling bb`);
  if (core.activeOperations === null) throw new Error(`Core drain counts are unknown (${core.state}); not safe to quit`);
  return { requestId: input.intentId, ownerServerId: input.ownerServerId, hostId: input.hostId, admissionClosed: core.admissionClosed && core.state === "held", armed: core.armed, activeOperations: core.activeOperations, atomic: true, persistent: true };
}

export function coreDrainGate(system: CoreDrainSdk): UpdateDrainCoreGate | undefined {
  const { experimental_acquireUpdateDrain: acquire, experimental_updateDrainStatus: status, experimental_armUpdateDrain: arm, experimental_cancelUpdateDrain: cancel, experimental_releaseUpdateDrain: release } = system;
  if (!acquire || !status || !arm || !cancel || !release) return undefined;
  const base = (input: UpdateDrainTarget) => ({ requestId: input.intentId, expectedPrimaryHostId: input.hostId });
  return {
    acquire: async (input) => {
      const targetVersion = (input as UpdateDrainTarget & { targetVersion?: unknown }).targetVersion;
      if (typeof targetVersion !== "string") throw new Error("The core drain must be acquired with the reviewed target version");
      return proof(input, await acquire.call(system, { ...base(input), targetVersion }));
    },
    status: async (input) => proof(input, await status.call(system, base(input))),
    arm: async (input) => proof(input, await arm.call(system, base(input))),
    cancel: async (input) => proof(input, await cancel.call(system, base(input))),
    release: async (input, terminal) => proof(input, await release.call(system, { ...base(input), terminalProof: { intentId: terminal.intentId, fromVersion: terminal.fromVersion, targetVersion: terminal.targetVersion, phase: terminal.phase, updatedAt: terminal.updatedAt } })),
  };
}

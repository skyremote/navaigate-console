// Host entry contract: the enrolled daemon reports its own opaque hardware id,
// so the server can prove an enrolled host and an independent owner are the
// same physical machine before reusing core terminals on it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostIdentityContract = defineRpcContract({
  host_identity_get: { input: z.null(), output: z.object({ hardwareId: z.string().nullable(), os: z.string() }) },
});

export const hostBindingSchema = z.object({
  machine: z.string(),
  ownerServerId: z.string().nullable(),
  ownerHardwareId: z.string().nullable(),
  enrolledHostId: z.string().nullable(),
  enrolledHardwareId: z.string().nullable(),
  verified: z.boolean(),
  reason: z.string().nullable(),
});
export type HostBinding = z.infer<typeof hostBindingSchema>;

/** Same machine only when both opaque ids exist and match exactly; names never count. */
export function bindingVerdict(args: { machine: string; ownerServerId: string | null; ownerHardwareId: string | null; candidates: { hostId: string; hardwareId: string | null; error: string | null }[] }): HostBinding {
  const base = { machine: args.machine, ownerServerId: args.ownerServerId, ownerHardwareId: args.ownerHardwareId };
  if (args.ownerHardwareId === null) return { ...base, enrolledHostId: null, enrolledHardwareId: null, verified: false, reason: "The independent owner did not report a hardware identity" };
  const matches = args.candidates.filter((candidate) => candidate.hardwareId !== null && candidate.hardwareId === args.ownerHardwareId);
  if (matches.length === 1) return { ...base, enrolledHostId: matches[0]!.hostId, enrolledHardwareId: matches[0]!.hardwareId, verified: true, reason: null };
  if (matches.length > 1) return { ...base, enrolledHostId: null, enrolledHardwareId: null, verified: false, reason: "More than one enrolled host reports this hardware identity" };
  const errors = args.candidates.filter((candidate) => candidate.error).map((candidate) => `${candidate.hostId}: ${candidate.error}`);
  return { ...base, enrolledHostId: null, enrolledHardwareId: null, verified: false, reason: errors.length ? `No enrolled host proved the same hardware (${errors.join("; ")})` : "No enrolled host on this server reports the owner's hardware identity" };
}

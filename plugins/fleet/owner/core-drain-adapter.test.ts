import { describe, expect, it } from "vitest";
import { coreDrainGate, CANCEL_REQUESTED } from "./core-drain-adapter";

const target = { v: 1 as const, ownerServerId: "studio-srv", hostId: "host_d4g9y874v4", intentId: "fleet-studio-0481-abcd" };
const reply = (patch: Record<string, unknown> = {}) => ({ requestId: target.intentId, primaryHostId: target.hostId, serverId: "core-profile-uuid", state: "held", armed: false, cancelRequested: false, admissionClosed: true, atomic: true, persistent: true, activeOperations: 0, counts: null, recovered: false, reason: null, ...patch });

describe("core drain adapter", () => {
  it("is absent on a core without the drain API, so updates stay refused", () => {
    expect(coreDrainGate({})).toBeUndefined();
  });

  it("binds the exact request id and proven primary host, not core's profile id", async () => {
    const calls: unknown[] = [];
    const method = async (input: Record<string, unknown>) => { calls.push(input); return reply(); };
    const gate = coreDrainGate({ experimental_acquireUpdateDrain: method, experimental_updateDrainStatus: method, experimental_armUpdateDrain: method, experimental_cancelUpdateDrain: method, experimental_releaseUpdateDrain: method })!;
    await expect(gate.acquire(target)).rejects.toThrow("reviewed target version");
    expect(await gate.acquire({ ...target, targetVersion: "0.48.2" } as typeof target)).toEqual({ requestId: target.intentId, ownerServerId: "studio-srv", hostId: target.hostId, admissionClosed: true, armed: false, activeOperations: 0, atomic: true, persistent: true });
    expect(calls[0]).toEqual({ requestId: target.intentId, expectedPrimaryHostId: target.hostId, targetVersion: "0.48.2" });
    await gate.release(target, { intentId: target.intentId, fromVersion: "0.48.1", targetVersion: "0.48.2", phase: "updated", updatedAt: 5 });
    expect(calls[1]).toEqual({ requestId: target.intentId, expectedPrimaryHostId: target.hostId, terminalProof: { intentId: target.intentId, fromVersion: "0.48.1", targetVersion: "0.48.2", phase: "updated", updatedAt: 5 } });
  });

  it("fails closed on another request, another host, unknown counts or a requested cancellation", async () => {
    const gateWith = (value: unknown) => { const method = async () => value; return coreDrainGate({ experimental_acquireUpdateDrain: method, experimental_updateDrainStatus: method, experimental_armUpdateDrain: method, experimental_cancelUpdateDrain: method, experimental_releaseUpdateDrain: method })!; };
    await expect(gateWith(reply({ requestId: "other-request-1" })).status(target)).rejects.toThrow("not fleet-studio-0481-abcd");
    await expect(gateWith(reply({ primaryHostId: "host_other" })).status(target)).rejects.toThrow("another primary host");
    await expect(gateWith(reply({ activeOperations: null, state: "pending" })).status(target)).rejects.toThrow("counts are unknown");
    await expect(gateWith(reply({ cancelRequested: true, armed: true })).status(target)).rejects.toThrow(CANCEL_REQUESTED);
    expect(await gateWith(reply({ state: "pending" })).status(target)).toMatchObject({ admissionClosed: false });
  });
});

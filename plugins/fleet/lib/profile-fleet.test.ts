import { describe, expect, it } from "vitest";
import { COMMUNITY_DEFAULTS } from "../profile/schema";
import { directRouteMachine, fleetSection, isFleetMachine, isWorkloadId, resolveMachineId, workloadIds, workloadRefusal } from "./profile-fleet";
import { fixtureProfile } from "./test-profile";

const profile = fixtureProfile();

describe("machines from the profile", () => {
  it("accepts any profile machine id, case-insensitively, and nothing else", () => {
    expect(isFleetMachine(profile, "studio")).toBe(true);
    expect(resolveMachineId(profile, " STUDIO ")).toBe("studio");
    expect(isFleetMachine(profile, "unknown-box")).toBe(false);
    expect(resolveMachineId(profile, "")).toBeNull();
  });

  it("routes directly to the always-on machine through its ssh alias, never to itself", () => {
    expect(directRouteMachine(profile, "laptop")).toMatchObject({ alias: "studio", machine: { id: "studio" } });
    expect(directRouteMachine(profile, "studio")).toBeNull();
  });

  it("has no direct route when the always-on machine has no ssh alias, or on community defaults", () => {
    const noAlias = { ...profile, machines: profile.machines.map((machine) => (machine.id === "studio" ? { ...machine, sshAlias: null } : machine)) };
    expect(directRouteMachine(noAlias, "laptop")).toBeNull();
    expect(directRouteMachine(COMMUNITY_DEFAULTS, "this-mac")).toBeNull();
  });
});

describe("workloads from the profile", () => {
  it("keeps a restricted machine to its own workload and that workload on its machine", () => {
    expect(workloadRefusal(profile, "work", undefined)).toBe("Work requires an explicitly Client A workload");
    expect(workloadRefusal(profile, "work", "general")).toBe("Work requires an explicitly Client A workload");
    expect(workloadRefusal(profile, "work", "client-a")).toBeNull();
    expect(workloadRefusal(profile, "laptop", "client-a")).toBe("Client A workloads require Work's host-local access; capacity does not authorise transfer to a personal host");
    expect(workloadRefusal(profile, "laptop", "general")).toBeNull();
    expect(workloadRefusal(profile, "studio", undefined)).toBeNull();
  });

  it("has no restrictions on community defaults", () => {
    expect(workloadRefusal(COMMUNITY_DEFAULTS, "this-mac", undefined)).toBeNull();
    expect(workloadIds(COMMUNITY_DEFAULTS)).toEqual(["general"]);
    expect(isWorkloadId(COMMUNITY_DEFAULTS, "client-a")).toBe(false);
    expect(isWorkloadId(profile, "client-a")).toBe(true);
  });
});

describe("Fleet's section of the profile", () => {
  it("reads plugins.fleet and falls back to neutral defaults", () => {
    expect(fleetSection(profile)).toEqual({ nasHost: "192.0.2.10", installUrl: "https://example.invalid/fleet", defaultProject: "Demo Project" });
    expect(fleetSection(COMMUNITY_DEFAULTS)).toEqual({ nasHost: null, installUrl: null, defaultProject: "" });
    expect(fleetSection({ ...profile, plugins: { fleet: { nasHost: 7 } } })).toEqual({ nasHost: null, installUrl: null, defaultProject: "" });
  });
});

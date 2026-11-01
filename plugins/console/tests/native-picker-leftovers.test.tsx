// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { COMMUNITY_DEFAULTS, type Profile } from "../profile/schema";
import { machineOptions, placementKey } from "../src/native-work-composer";
import { pullRequest } from "../src/m1";

const machine = (id: string, label: string, over: Record<string, unknown> = {}) => ({ ...COMMUNITY_DEFAULTS.machines[0]!, id, label, ...over });
const profileOf = (machines: ReturnType<typeof machine>[]): Profile => ({ ...COMMUNITY_DEFAULTS, machines });

describe("the new-work picker's options", () => {
  it("lists This Mac once for a single-Mac profile, whatever its machine is called", () => {
    for (const label of ["This Mac", "Pat's Laptop"]) {
      const options = machineOptions(profileOf([machine("this-mac", label)]));
      expect(options.map((o) => o.label)).toEqual(["This Mac", "Auto"]);
    }
  });

  it("lists every machine of a multi-Mac profile after This Mac and Auto, except one called This Mac", () => {
    const options = machineOptions(profileOf([machine("laptop", "This Mac"), machine("studio", "Studio", { role: "always-on" }), machine("work", "Work", { restricted: true })]));
    expect(options.map((o) => o.label)).toEqual(["This Mac", "Auto", "Studio", "Work"]);
  });

  it("keeps the picker's own options distinct from a machine whose id is Auto or here", () => {
    const options = machineOptions(profileOf([machine("laptop", "Laptop"), machine("Auto", "Cloud box"), machine("here", "Garage")]));
    const keys = options.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice(0, 2)).toEqual(["@here", "@auto"]);
    expect(placementKey("Auto")).toBe("@auto");
    expect(options.find((o) => o.label === "Cloud box")!.key).toBe("m:Auto");
    expect(options.find((o) => o.label === "Garage")!.key).toBe("m:here");
  });
});

describe("asking the agent to pull a handed-over chat's results", () => {
  it("names no private helper when the profile sets none", () => {
    const text = pullRequest("thr_remote", COMMUNITY_DEFAULTS);
    expect(text).not.toMatch(/\bm1\b|skill/i);
    expect(text).toContain("thr_remote");
  });

  it("names the hand-over helper when the profile sets one", () => {
    const profile: Profile = { ...COMMUNITY_DEFAULTS, plugins: { console: { handoffScript: "~/bin/handover" } } };
    expect(pullRequest("thr_remote", profile)).toMatch(/hand-over helper: run `m1 pull thr_remote`/);
  });
});

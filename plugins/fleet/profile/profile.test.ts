// Shared profile contract tests. Byte-identical in every plugin that reads the profile.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProfile, profilePath, resetProfileCache, saveProfile } from "./load";
import {
  COMMUNITY_DEFAULTS,
  alwaysOnMachine,
  featureOn,
  hasTwoMachines,
  isRestricted,
  machineLabel,
  resolveProfile,
  setupDone,
  thisMachine,
  workloadFor,
  workloadMachine,
} from "./schema";

const here = dirname(fileURLToPath(import.meta.url));

const twoMacs = {
  owner: { name: "Sam Example", username: "sam" },
  machines: [
    { id: "laptop", label: "Laptop", role: "laptop", hostnames: ["sams-laptop"] },
    { id: "studio", label: "Studio", role: "always-on", sshAlias: "studio" },
    { id: "work", label: "Work Mac", role: "restricted", restricted: true, workloads: ["client-a"] },
  ],
  workloads: [{ id: "client-a", label: "Client A", machine: "work", match: ["client-a", "clienta"] }],
  setup: { completedAt: 1, version: 1 },
};

describe("profile schema", () => {
  it("is the community defaults when there is no profile", () => {
    const r = resolveProfile(undefined);
    expect(r.source).toBe("defaults");
    expect(r.profile).toEqual(COMMUNITY_DEFAULTS);
    expect(hasTwoMachines(r.profile)).toBe(false);
    expect(alwaysOnMachine(r.profile)).toBeNull();
    expect(setupDone(r.profile)).toBe(false);
  });

  it("community.defaults.json matches COMMUNITY_DEFAULTS", () => {
    expect(JSON.parse(readFileSync(join(here, "community.defaults.json"), "utf8"))).toEqual(COMMUNITY_DEFAULTS);
  });

  it("overlays a partial profile and fills machine defaults", () => {
    const r = resolveProfile(twoMacs);
    expect(r.errors).toEqual([]);
    expect(r.source).toBe("file");
    expect(r.profile.machines[1]?.workloads).toEqual([]);
    expect(r.profile.hosts.fleet).toBeNull();
    expect(alwaysOnMachine(r.profile)?.id).toBe("studio");
    expect(isRestricted(r.profile, "work")).toBe(true);
    expect(isRestricted(r.profile, "studio")).toBe(false);
    expect(machineLabel(r.profile, "studio")).toBe("Studio");
    expect(machineLabel(r.profile, "unknown")).toBe("unknown");
    expect(workloadFor(r.profile, "/projects/ClientA-site")?.id).toBe("client-a");
    expect(workloadMachine(r.profile, "client-a")?.id).toBe("work");
  });

  it("falls back to the defaults on an invalid profile and says why", () => {
    const r = resolveProfile({ machines: [{ id: "", label: "x" }] });
    expect(r.source).toBe("defaults");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(resolveProfile([1, 2]).errors).toEqual(["profile is not a JSON object"]);
    expect(resolveProfile({ machines: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }).errors[0]).toMatch(/duplicate/);
  });

  it("finds this machine explicitly, by hostname, then first", () => {
    const p = resolveProfile(twoMacs).profile;
    expect(thisMachine(p, "SAMS-LAPTOP.local").id).toBe("laptop");
    expect(thisMachine(p, "somewhere-else").id).toBe("laptop");
    expect(thisMachine({ ...p, thisMachine: "studio" }, "sams-laptop").id).toBe("studio");
  });

  it("uses the saved pick, else the picker default", () => {
    const p = resolveProfile({ features: { preset: "custom", picks: { F01: false, F02: true } } }).profile;
    expect(featureOn(p, "F01", "on")).toBe(false);
    expect(featureOn(p, "F02", "off")).toBe(true);
    expect(featureOn(p, "F03", "on")).toBe(true);
    expect(featureOn(p, "F04", "off")).toBe(false);
  });
});

describe("profile file", () => {
  it("resolves its path from the override, then XDG, then ~/.config", () => {
    expect(profilePath({ NAVAIGATE_CONSOLE_PROFILE: "/x/p.json" })).toBe("/x/p.json");
    expect(profilePath({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/navaigate-console/profile.json");
    expect(profilePath({})).toMatch(/\.config\/navaigate-console\/profile\.json$/);
  });

  it("reads defaults when missing, round-trips a save with owner-only permissions, and never overwrites a broken file", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"));
    const file = join(dir, "sub", "profile.json");
    resetProfileCache();
    expect(loadProfile(file).source).toBe("defaults");
    const saved = saveProfile(resolveProfile(twoMacs).profile, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadProfile(file).profile).toEqual(saved);
    writeFileSync(file, "{ not json");
    const broken = loadProfile(file);
    expect(broken.source).toBe("defaults");
    expect(broken.errors[0]).toMatch(/could not read/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("matches the shared copy recorded in SHARED.sha256", () => {
    const lines = readFileSync(join(here, "SHARED.sha256"), "utf8").trim().split("\n");
    for (const line of lines) {
      const [hash, name] = line.split(/\s+/);
      const actual = createHash("sha256").update(readFileSync(join(here, name as string))).digest("hex");
      expect(`${name} ${actual}`).toBe(`${name} ${hash}`);
    }
  });
});

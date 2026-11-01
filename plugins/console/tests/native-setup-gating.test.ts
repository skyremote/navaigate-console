import { describe, expect, it } from "vitest";
import { COMMUNITY_DEFAULTS, resolveProfile, type Profile } from "../profile/schema";
import { CORE_LEDGER } from "../src/core-ledger-data";
import { FEATURES } from "../src/features-guide-data";
import { featureState, isFeatureEnabled, ledgerIdsPassed, NO_PROBES, pickerFeatures, presetPicks, shouldOpenSetup } from "../src/features-enabled";

const community = (over: Partial<Profile> = {}): Profile => ({ ...COMMUNITY_DEFAULTS, ...over });
const twoMachines = (): Profile => resolveProfile({
  ...COMMUNITY_DEFAULTS,
  machines: [
    { ...COMMUNITY_DEFAULTS.machines[0] },
    { id: "studio", label: "Studio", role: "always-on", sshAlias: "studio" },
  ],
}).profile;
const allCore = new Set(CORE_LEDGER.map((c) => c.id));

describe("the feature gating helper", () => {
  it("treats the private edition as all on unless a pick says false", () => {
    const priv = community({ edition: "private" });
    for (const f of FEATURES) expect(isFeatureEnabled(priv, f.id, NO_PROBES), f.id).toBe(true);
    const off = community({ edition: "private", features: { preset: "pro", picks: { F55: false } } });
    expect(isFeatureEnabled(off, "F55", NO_PROBES)).toBe(false);
    expect(isFeatureEnabled(off, "F57", NO_PROBES)).toBe(true);
  });

  it("uses the picker default in the community edition, and a saved pick over it", () => {
    expect(isFeatureEnabled(community(), "F56", NO_PROBES)).toBe(true); // default on
    expect(isFeatureEnabled(community(), "EXTRA-I", NO_PROBES)).toBe(false); // default off
    expect(isFeatureEnabled(community({ features: { preset: "custom", picks: { "EXTRA-I": true } } }), "EXTRA-I", NO_PROBES)).toBe(true);
    expect(isFeatureEnabled(community({ features: { preset: "custom", picks: { F56: false } } }), "F56", NO_PROBES)).toBe(false);
    expect(isFeatureEnabled(community(), "NOT-A-FEATURE", NO_PROBES)).toBe(false);
  });

  it("keeps a feature that needs a second Mac off until there is one, even when ticked", () => {
    const ticked = { preset: "custom" as const, picks: { F10: true } };
    expect(isFeatureEnabled(community({ features: ticked }), "F10", NO_PROBES)).toBe(false);
    expect(isFeatureEnabled({ ...twoMachines(), features: ticked }, "F10", NO_PROBES)).toBe(true);
    expect(featureState(community(), "F10", NO_PROBES)).toEqual({ kind: "greyed", reason: "needs a second Mac" });
  });

  it("asks for a public address and a brain with the words the picker shows", () => {
    const base = { ...twoMachines(), features: { preset: "custom" as const, picks: { F51: true, F52: true, F53: true } } };
    expect(featureState(base, "F53", allCore)).toEqual({ kind: "greyed", reason: "needs a public address" });
    const withHooks = { ...base, hosts: { ...base.hosts, hooks: "https://hooks.example.test" } };
    expect(isFeatureEnabled(withHooks, "F51", allCore)).toBe(true);
    expect(isFeatureEnabled(withHooks, "F52", allCore)).toBe(true);
    expect(isFeatureEnabled({ ...withHooks, features: { preset: "custom", picks: { F51: false, F52: true } } }, "F52", allCore)).toBe(false);
    const needsFeature = featureState({ ...withHooks, features: { preset: "custom", picks: { F51: false, F52: true } } }, "F52", allCore);
    expect(needsFeature.kind).toBe("greyed");
    expect(needsFeature.kind === "greyed" && needsFeature.reason).toMatch(/^needs .* ticked$/);
    const brainNeeding = FEATURES.find((f) => f.picker?.requires.includes("brain"));
    if (brainNeeding) {
      expect(featureState(community(), brainNeeding.id, allCore)).toMatchObject({ kind: "greyed", reason: "needs a brain" });
      const brain = { ...community(), brain: { url: "https://brain.example.test", tokenSecret: "BRAIN_TOKEN" } };
      expect(featureState(brain, brainNeeding.id, allCore).kind).not.toBe("greyed");
    }
  });

  it("hides, rather than greys, a feature whose core change is missing from the running bb", () => {
    const state = featureState(community(), "F08", NO_PROBES);
    expect(state).toEqual({ kind: "hidden" });
    expect(isFeatureEnabled(community({ features: { preset: "custom", picks: { F08: true } } }), "F08", NO_PROBES)).toBe(false);
    const passed = ledgerIdsPassed({ releaseBuild: true, nativeHistory: true, cleanupSafety: true, continuationIntent: true });
    expect(passed.has("native-history-and-composer-actions")).toBe(true);
    expect(featureState(community(), "F08", passed).kind).toBe("off");
    expect(isFeatureEnabled(community({ features: { preset: "custom", picks: { F08: true } } }), "F08", passed)).toBe(true);
    // The probe for one change does not stand in for another.
    expect(ledgerIdsPassed({ releaseBuild: false, nativeHistory: true, cleanupSafety: false, continuationIntent: false }).has("protected-worktree-removal")).toBe(false);
  });

  it("hides the features that need unmerged core changes when the probe fails, even those that were listed as always on", () => {
    for (const id of ["F76", "S01", "S02", "EXTRA-F"]) {
      expect(featureState(community(), id, NO_PROBES), id).toEqual({ kind: "hidden" });
      expect(FEATURES.find((f) => f.id === id)!.picker!.default, id).toBe("off");
    }
  });

  it("shows an always-on feature ticked and locked, and never lets it be unticked", () => {
    const always = pickerFeatures().filter((f) => f.picker!.enforced === "always" && f.picker!.requires.length === 0);
    expect(always.length).toBeGreaterThan(3);
    for (const f of always) {
      expect(featureState(community(), f.id, allCore), f.id).toEqual({ kind: "locked" });
      expect(isFeatureEnabled(community({ features: { preset: "custom", picks: { [f.id]: false } } }), f.id, allCore), f.id).toBe(true);
    }
  });

  it("treats the Markdown plugin and Prompt Stack as separate plugins: no pick, never switched by a tick, named by their plugin id", () => {
    const expected = { "EXTRA-E": "navmotion-skin", "EXTRA-H": "prompt-stack" };
    for (const [id, plugin] of Object.entries(expected)) {
      const picker = FEATURES.find((f) => f.id === id)!.picker!;
      expect(picker.enforced, id).toBe("plugin");
      expect(picker.gate, id).toBe(`bb plugin enable/disable ${plugin}`);
      expect(featureState(community(), id, allCore), id).toEqual({ kind: "plugin", plugin });
      // A saved tick, either way, changes nothing: the Console is not the one that gates it.
      expect(isFeatureEnabled(community({ features: { preset: "custom", picks: { [id]: false } } }), id, allCore), id).toBe(true);
      expect(presetPicks("simple")[id]).toBeUndefined();
      expect(presetPicks("pro")[id]).toBeUndefined();
    }
  });

  it("turns a preset into picks from the data, and Simple is a subset of Pro", () => {
    const simple = presetPicks("simple");
    const pro = presetPicks("pro");
    for (const f of pickerFeatures()) {
      if (f.picker!.enforced === "always" || f.picker!.enforced === "plugin") {
        expect(simple[f.id]).toBeUndefined();
        expect(pro[f.id]).toBeUndefined();
        continue;
      }
      expect(simple[f.id], f.id).toBe(f.picker!.presets.includes("simple"));
      expect(pro[f.id], f.id).toBe(f.picker!.presets.includes("pro"));
      if (simple[f.id]) expect(pro[f.id], `${f.id} is in Simple, so in Pro`).toBe(true);
    }
    expect(Object.values(pro).filter(Boolean).length).toBeGreaterThan(Object.values(simple).filter(Boolean).length);
  });

  it("lists every gate it can wire with a plugin that is this one, or says who honours it", () => {
    for (const f of pickerFeatures()) {
      expect(["registration", "server", "inline", "always", "plugin"], f.id).toContain(f.picker!.enforced);
      expect(f.picker!.gate.trim().length, f.id).toBeGreaterThan(5);
    }
  });
});

describe("the first-run rule", () => {
  const state = (over: Partial<Parameters<typeof shouldOpenSetup>[0]> = {}) => ({ profile: community(), loaded: true, errors: [] as string[], ...over });

  it("opens setup for the community edition once the server has answered and setup was never finished", () => {
    expect(shouldOpenSetup(state())).toBe(true);
  });

  it("waits for the server's answer, so the defaults are never mistaken for a first run", () => {
    expect(shouldOpenSetup(state({ loaded: false }))).toBe(false);
  });

  it("never opens for the private edition or after setup is done", () => {
    expect(shouldOpenSetup(state({ profile: community({ edition: "private" }) }))).toBe(false);
    expect(shouldOpenSetup(state({ profile: community({ setup: { completedAt: 5, version: 1 } }) }))).toBe(false);
  });

  it("does not open over a profile file that could not be read, which a save would overwrite", () => {
    expect(shouldOpenSetup(state({ errors: ["machines: duplicate id a"] }))).toBe(false);
  });
});

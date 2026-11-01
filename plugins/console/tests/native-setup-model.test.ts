import { describe, expect, it } from "vitest";
import { COMMUNITY_DEFAULTS, featureOn, isRestricted, resolveProfile, thisMachine, type Profile } from "../profile/schema";
import { pickerFeatures } from "../src/features-enabled";
import {
  TOKEN_REFUSAL, addressProblem, applyPreset, buildProfile, draftFromProfile, hasProblems, looksLikeSecret, problemsOf, secretNameProblem, setPick, slug,
} from "../src/setup-model";

const fresh = () => draftFromProfile(COMMUNITY_DEFAULTS);

describe("refusing a token in the secret-name field", () => {
  // Built from parts, so no secret-shaped literal sits in the repository.
  const j = (...parts: string[]) => parts.join("");
  const tokens = [
    j("sk", "-ant-", "api03-AbCdEf0123456789AbCdEf0123456789"),
    j("sk", "_live_", "51H8abcdefghijklmnop"),
    j("gh", "p_", "16C7e42F292c6912E7710c838347Ae178B4a"),
    j("xo", "xb-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"),
    j("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0In0", ".", "SflKxwRJSMeKKF2QT4fwpM"),
    "0123456789abcdef0123456789abcdef0123456789abcdef",
    "Xk9dLm2PqR7vTn4YbZ1cWe8Hs3Ua",
    "Bearer abc.def",
    "my secret value",
  ];
  it.each(tokens)("refuses %s with a plain message", (value) => {
    expect(looksLikeSecret(value)).toBe(true);
    expect(secretNameProblem(value)).toBe(TOKEN_REFUSAL);
    expect(TOKEN_REFUSAL).toMatch(/never stored/);
  });

  it("accepts the name of a secret or an environment variable, and an empty field", () => {
    for (const name of ["BRAIN_TOKEN", "brain.token", "my-brain-key", "AIOS_BRAIN_TOKEN_2"]) expect(secretNameProblem(name), name).toBeNull();
    expect(secretNameProblem("")).toBeNull();
    expect(secretNameProblem("  ")).toBeNull();
  });

  it("rejects names that are not names, without calling them secrets", () => {
    expect(secretNameProblem("1BAD")).toMatch(/starts with a letter/);
  });

  it("keeps a refused value out of the profile: saving is blocked and nothing is written for it", () => {
    const draft = { ...fresh(), name: "Pat", brainUrl: "https://brain.example.test", brainTokenSecret: tokens[0]! };
    const problems = problemsOf(draft);
    expect(problems.brainTokenSecret).toBe(TOKEN_REFUSAL);
    expect(hasProblems(problems)).toBe(true);
  });

  it("refuses an address that carries a credential", () => {
    expect(addressProblem("https://user:pass@brain.example.test")).toMatch(/user name and password/);
    expect(addressProblem("https://brain.example.test/?token=abc")).toMatch(/keys and tokens/);
    expect(addressProblem(`https://brain.example.test/?x=${tokens[0]}`)).toMatch(/keys and tokens/);
    expect(addressProblem("brain.example.test")).toMatch(/full address/);
    expect(addressProblem("ftp://brain.example.test")).toMatch(/full address/);
    expect(addressProblem("https://brain.example.test")).toBeNull();
    expect(addressProblem("")).toBeNull();
  });
});

describe("the draft and the profile it builds", () => {
  it("needs a name and a name for this Mac, and nothing else", () => {
    expect(problemsOf(fresh()).name).toBeTruthy();
    expect(hasProblems(problemsOf({ ...fresh(), name: "Pat" }))).toBe(false);
    expect(problemsOf({ ...fresh(), name: "Pat", thisMac: " " }).thisMac).toBeTruthy();
  });

  it("builds a one-Mac profile from the defaults, with an id derived from the Mac's name and setup marked done", () => {
    const profile = buildProfile(COMMUNITY_DEFAULTS, { ...fresh(), name: "Pat", thisMac: "Pat's MacBook" }, 1_700_000_000_000);
    expect(profile.owner.name).toBe("Pat");
    expect(profile.machines).toHaveLength(1);
    expect(profile.machines[0]).toMatchObject({ id: "pat-s-macbook", label: "Pat's MacBook" });
    expect(profile.thisMachine).toBe("pat-s-macbook");
    expect(profile.setup.completedAt).toBe(1_700_000_000_000);
    expect(resolveProfile(profile).errors).toEqual([]);
    expect(resolveProfile(profile).source).toBe("file");
  });

  it("adds Macs, restricted workloads and addresses, and the result passes the shared schema", () => {
    const draft = {
      ...fresh(), name: "Pat", thisMac: "Laptop",
      machines: [
        { id: null, label: "Studio", role: "always-on" as const, sshAlias: "studio", bbUrl: "https://studio.example.test" },
        { id: null, label: "Work Mac", role: "restricted" as const, sshAlias: "", bbUrl: "" },
      ],
      workloads: [{ id: null, name: "Client work", machine: "work mac", match: "clientco, client-x" }],
      hooks: "https://hooks.example.test", brainUrl: "https://brain.example.test", brainTokenSecret: "BRAIN_TOKEN",
    };
    expect(hasProblems(problemsOf(draft))).toBe(false);
    const profile = buildProfile(COMMUNITY_DEFAULTS, draft, 5);
    expect(profile.machines.map((m) => m.id)).toEqual(["laptop", "studio", "work-mac"]);
    expect(profile.machines[1]).toMatchObject({ role: "always-on", restricted: false, sshAlias: "studio", bbUrl: "https://studio.example.test" });
    expect(profile.machines[2]).toMatchObject({ role: "restricted", restricted: true, workloads: ["client-work"] });
    expect(profile.workloads).toEqual([{ id: "client-work", label: "Client work", machine: "work-mac", match: ["clientco", "client-x"] }]);
    expect(profile.hosts.hooks).toBe("https://hooks.example.test");
    expect(profile.brain).toEqual({ url: "https://brain.example.test", tokenSecret: "BRAIN_TOKEN" });
    const again = resolveProfile(profile);
    expect(again.errors).toEqual([]);
    expect(again.profile.machines).toHaveLength(3);
  });

  it("refuses a workload tied to a Mac that is not listed, and an SSH alias that is not a plain Host name", () => {
    const draft = { ...fresh(), name: "Pat", workloads: [{ id: null, name: "Client", machine: "Nowhere", match: "" }], machines: [{ id: null, label: "Studio", role: "always-on" as const, sshAlias: "-oProxyCommand=x", bbUrl: "" }] };
    const p = problemsOf(draft);
    expect(p.workloads[0]?.machine).toBeTruthy();
    expect(p.machines[0]?.sshAlias).toBeTruthy();
  });

  it("keeps what the screen does not ask about, and never changes a machine id once it exists", () => {
    const base = resolveProfile({
      ...COMMUNITY_DEFAULTS, setup: { completedAt: 1, version: 1 }, paths: { home: "/Users/pat", nas: null, nasLocal: null }, plugins: { console: { nasLink: "/x" } },
      machines: [{ id: "laptop", label: "Laptop", role: "laptop", hostnames: ["pats-laptop"], home: "/Users/pat" }, { id: "studio", label: "Studio", role: "always-on", hostnames: ["studio"] }],
    }).profile;
    const draft = { ...draftFromProfile(base), thisMac: "Pat's Laptop", machines: [{ ...draftFromProfile(base).machines[0]!, label: "Home Studio" }] };
    const next = buildProfile(base, draft, 9);
    expect(next.machines.map((m) => m.id)).toEqual(["laptop", "studio"]);
    expect(next.machines[0]).toMatchObject({ label: "Pat's Laptop", hostnames: ["pats-laptop"], home: "/Users/pat" });
    expect(next.machines[1]).toMatchObject({ label: "Home Studio", hostnames: ["studio"] });
    expect(next.paths.home).toBe("/Users/pat");
    expect(next.plugins).toEqual({ console: { nasLink: "/x" } });
    expect(next.setup.completedAt).toBe(9);
  });

  it("derives ids that are safe and unique", () => {
    expect(slug("  My Mac!  ")).toBe("my-mac");
    expect(slug("***")).toBe("");
    const profile = buildProfile(COMMUNITY_DEFAULTS, { ...fresh(), name: "Pat", thisMac: "Mac", machines: [{ id: null, label: "Mac", role: "laptop", sshAlias: "", bbUrl: "" }] }, 1);
    expect(profile.machines.map((m) => m.id)).toEqual(["mac", "mac-2"]);
  });
});

describe("presets and boxes in the draft", () => {
  it("choosing a preset sets the preset and the picks; changing any box makes it custom", () => {
    const pro = applyPreset(fresh(), "pro");
    expect(pro.preset).toBe("pro");
    expect(pro.picks.F55).toBe(true);
    const simple = applyPreset(pro, "simple");
    expect(simple.preset).toBe("simple");
    expect(Object.keys(simple.picks).length).toBe(Object.keys(pro.picks).length);
    const custom = setPick(simple, "EXTRA-I", true);
    expect(custom.preset).toBe("custom");
    expect(custom.picks["EXTRA-I"]).toBe(true);
    const built = buildProfile(COMMUNITY_DEFAULTS, { ...custom, name: "Pat" }, 1).features;
    expect(built.preset).toBe("custom");
    expect(built.picks).toMatchObject(custom.picks); // the boxes ticked or unticked are kept as they are
  });

  it("writes an explicit pick for every community picker feature, so a missing pick is never read as on", () => {
    const profile = buildProfile(COMMUNITY_DEFAULTS, { ...fresh(), name: "Pat" }, 1);
    for (const f of pickerFeatures()) {
      if (f.picker!.enforced === "plugin") expect(profile.features.picks[f.id], f.id).toBeUndefined();
      else if (f.picker!.enforced === "always") expect(profile.features.picks[f.id], f.id).toBe(true);
      else expect(profile.features.picks[f.id], f.id).toBe(featureOn(COMMUNITY_DEFAULTS, f.id, f.picker!.default));
    }
    // A box the draft changed wins over the default.
    const off = pickerFeatures().find((f) => f.picker!.enforced !== "plugin" && f.picker!.enforced !== "always" && f.picker!.default === "on")!;
    expect(buildProfile(COMMUNITY_DEFAULTS, setPick({ ...fresh(), name: "Pat" }, off.id, false), 1).features.picks[off.id]).toBe(false);
  });

  it("starts from the installer's preset on a first run, but never over a saved choice", () => {
    expect(draftFromProfile(COMMUNITY_DEFAULTS, "pro").preset).toBe("pro");
    expect(draftFromProfile(COMMUNITY_DEFAULTS, null).preset).toBeNull();
    const saved = { ...COMMUNITY_DEFAULTS, features: { preset: "custom" as const, picks: { F56: false } } };
    expect(draftFromProfile(saved, "pro")).toMatchObject({ preset: "custom", picks: { F56: false } });
  });

  it("does not touch plugin settings: building a profile only returns a profile", () => {
    const next = buildProfile(COMMUNITY_DEFAULTS, { ...applyPreset(fresh(), "simple"), name: "Pat" }, 1);
    expect(Object.keys(next).sort()).toEqual(Object.keys(COMMUNITY_DEFAULTS).sort());
  });
});

// A profile as it sits on the second Mac of three: this Mac is not the first one listed, the first Mac has a
// role the screen cannot show, and the Mac it sits on is restricted. Neutral names throughout.
const second = (): Profile => resolveProfile({
  schemaVersion: 1, edition: "community", owner: { name: "Pat", username: "pat" }, thisMachine: "annex",
  machines: [
    { id: "desk", label: "Desk", role: "primary", restricted: false, workloads: [], hostnames: ["pats-desk"], sshAlias: null, bbUrl: "https://desk.example.test", home: "/Users/pat" },
    { id: "annex", label: "Annex", role: "restricted", restricted: true, workloads: ["client"], hostnames: ["annex-mac"], sshAlias: null, bbUrl: null, home: null },
    { id: "rack", label: "Rack", role: "always-on", restricted: false, workloads: [], hostnames: ["rack"], sshAlias: "rack", bbUrl: "https://rack.example.test", home: "/Users/rack" },
    { id: "spare", label: "Spare", role: "other", restricted: false, workloads: [], hostnames: [], sshAlias: null, bbUrl: null, home: null },
  ],
  workloads: [{ id: "client", label: "Client", machine: "annex", match: ["clientco"] }],
  setup: { completedAt: 1, version: 1 },
  features: { preset: "custom", picks: { F56: false } },
  plugins: { console: { x: 1 } },
}).profile;
const stripDone = (p: Profile) => ({ ...p, setup: { ...p.setup, completedAt: null } });

describe("saving Setup on the second or third Mac", () => {
  it("starts from the Mac the profile sits on, not the first one listed, and lists the rest as other Macs", () => {
    const p = second();
    expect(p.machines.map((m) => m.id)).toEqual(["desk", "annex", "rack", "spare"]); // the fixture really is valid
    const draft = draftFromProfile(p, null, "something-else");
    expect(draft.thisMac).toBe("Annex");
    expect(draft.thisMacId).toBe("annex");
    expect(draft.machines.map((m) => m.label)).toEqual(["Desk", "Rack", "Spare"]);
  });

  it("finds this Mac from the hostname the server gave when the profile does not say", () => {
    const p = { ...second(), thisMachine: null };
    expect(draftFromProfile(p, null, "rack.local").thisMac).toBe("Rack");
    expect(draftFromProfile(p, null, "annex-mac").thisMacId).toBe("annex");
  });

  it("round-trips with no change to identity, order, role, restriction or anything else", () => {
    const p = second();
    const next = buildProfile(p, draftFromProfile(p, null, null), null);
    // Only the picks differ: every box is now written down, and the one that was unticked still is.
    expect({ ...next, features: p.features }).toEqual(p);
    expect(next.features.preset).toBe("custom");
    expect(next.features.picks.F56).toBe(false);
    expect(next.thisMachine).toBe("annex");
    expect(next.machines.map((m) => [m.id, m.role, m.restricted])).toEqual([["desk", "primary", false], ["annex", "restricted", true], ["rack", "always-on", false], ["spare", "other", false]]);
    expect(isRestricted(next, thisMachine(next, "x")!.id)).toBe(true);
    const saved = stripDone({ ...buildProfile(p, draftFromProfile(p, null, null), 77), features: p.features });
    expect(JSON.stringify(saved)).toBe(JSON.stringify(stripDone(p))); // same keys in the same order
  });

  it("keeps a restricted Mac restricted when only its name is changed", () => {
    const p = second();
    const next = buildProfile(p, { ...draftFromProfile(p, null, null), thisMac: "Annex two" }, 5);
    expect(next.thisMachine).toBe("annex");
    expect(next.machines[1]).toMatchObject({ id: "annex", label: "Annex two", role: "restricted", restricted: true, workloads: ["client"], hostnames: ["annex-mac"] });
  });

  it("changes a role only when the role was changed on the screen", () => {
    const p = second();
    const d = draftFromProfile(p, null, null);
    const next = buildProfile(p, { ...d, machines: d.machines.map((m) => (m.id === "rack" ? { ...m, role: "restricted" as const } : m)) }, 5);
    expect(next.machines.find((m) => m.id === "rack")).toMatchObject({ role: "restricted", restricted: true });
    expect(next.machines.find((m) => m.id === "desk")).toMatchObject({ role: "primary" });
  });

  it("keeps the order when a Mac is removed or added, and puts a new Mac last", () => {
    const p = second();
    const d = draftFromProfile(p, null, null);
    const removed = buildProfile(p, { ...d, machines: d.machines.filter((m) => m.id !== "desk") }, 5);
    expect(removed.machines.map((m) => m.id)).toEqual(["annex", "rack", "spare"]);
    const added = buildProfile(p, { ...d, machines: [...d.machines, { id: null, label: "New Mac", role: "laptop", sshAlias: "", bbUrl: "" }] }, 5);
    expect(added.machines.map((m) => m.id)).toEqual(["desk", "annex", "rack", "spare", "new-mac"]);
    expect(added.thisMachine).toBe("annex");
  });

  it("drops a workload id from every Mac when the workload is removed", () => {
    const p = second();
    const next = buildProfile(p, { ...draftFromProfile(p, null, null), workloads: [] }, 5);
    expect(next.workloads).toEqual([]);
    expect(next.machines.every((m) => m.workloads.length === 0)).toBe(true);
    expect(resolveProfile(next).errors).toEqual([]);
  });

  it("does not pin a guess: with no explicit Mac and nothing matching, thisMachine stays unset", () => {
    const p = { ...second(), thisMachine: null };
    expect(buildProfile(p, draftFromProfile(p, null, "unknown-host"), 5).thisMachine).toBeNull();
    // A first run (one Mac) is this Mac and stays so once more are added.
    const added = buildProfile(COMMUNITY_DEFAULTS, { ...fresh(), name: "Pat", thisMac: "Desk", machines: [{ id: null, label: "Rack", role: "always-on", sshAlias: "", bbUrl: "" }] }, 1);
    expect(added.thisMachine).toBe("desk");
  });
});

describe("the private edition in Setup", () => {
  const priv = (): Profile => ({ ...second(), edition: "private", features: { preset: "pro", picks: { F56: false } } });

  it("does not apply the installer's preset, which would switch features off", () => {
    const fresh = { ...priv(), features: { preset: null, picks: {} } };
    expect(draftFromProfile(fresh, "simple").preset).toBeNull();
    expect(draftFromProfile(fresh, "simple").picks).toEqual({});
  });

  it("saves no pick it did not touch", () => {
    const p = priv();
    expect(buildProfile(p, draftFromProfile(p, null, null), null).features).toEqual(p.features);
    const unset = { ...p, features: { preset: null, picks: {} } };
    expect(buildProfile(unset, draftFromProfile(unset, null, null), null).features.picks).toEqual({});
    expect(buildProfile(unset, setPick(draftFromProfile(unset, null, null), "F56", false), null).features.picks).toEqual({ F56: false });
  });
});

import { describe, expect, it } from "vitest";
import { COMMUNITY_DEFAULTS, resolveProfile } from "../profile/schema";
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
    expect(buildProfile(COMMUNITY_DEFAULTS, { ...custom, name: "Pat" }, 1).features).toEqual({ preset: "custom", picks: custom.picks });
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

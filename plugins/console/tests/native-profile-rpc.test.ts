import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProfile, profileResult } from "../server-profile";
import { resetProfileCache } from "../profile/load";
import { alwaysOnPhrase, labelPhrase, ownerName } from "../lib/profile-text";
import { COMMUNITY_DEFAULTS } from "../profile/schema";
import { consoleSection, consoleSectionProblems, handoffOn, nasPair } from "../lib/profile-console";
import { isShared, localPathFor, m1PathFor } from "../server-machines";
import { machineKeyOf, chipsFor } from "../src/machines";

describe("profile plumbing", () => {
  it("reads the fixture profile the tests point at", () => {
    const res = profileResult();
    expect(res.source).toBe("file");
    expect(res.profile.machines.map((m) => m.id)).toEqual(["laptop", "studio", "work"]);
    expect(res.stamp).not.toBe("none");
  });

  it("saves a whole profile, validated, with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "console-profile-"));
    const file = join(dir, "profile.json");
    const prev = process.env.NAVAIGATE_CONSOLE_PROFILE;
    process.env.NAVAIGATE_CONSOLE_PROFILE = file;
    resetProfileCache();
    try {
      let saved = 0;
      const profile = createProfile(() => void (saved += 1));
      expect(profile.get().source).toBe("defaults");
      const out = profile.save({ profile: { ...COMMUNITY_DEFAULTS, owner: { name: "Pat", username: "pat" } } });
      expect(out.source).toBe("file");
      expect(out.profile.owner.name).toBe("Pat");
      expect(saved).toBe(1);
      expect(JSON.parse(readFileSync(file, "utf8")).owner.name).toBe("Pat");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      process.env.NAVAIGATE_CONSOLE_PROFILE = prev;
      resetProfileCache();
    }
  });

  it("words machines and the owner from the profile, with neutral fallbacks", () => {
    expect(labelPhrase("M9")).toBe("the M9");
    expect(labelPhrase("Studio")).toBe("Studio");
    expect(alwaysOnPhrase(profileResult().profile)).toBe("Studio");
    expect(alwaysOnPhrase(COMMUNITY_DEFAULTS)).toBe("the always-on Mac");
    expect(ownerName(profileResult().profile)).toBe("Sam Example");
    expect(ownerName(COMMUNITY_DEFAULTS)).toBe("the owner");
  });

  it("keeps every remote feature off and every path as it is on the community defaults", () => {
    expect(handoffOn(COMMUNITY_DEFAULTS)).toBe(false);
    expect(nasPair(COMMUNITY_DEFAULTS, "/Users/pat")).toBeNull();
    expect(consoleSection(COMMUNITY_DEFAULTS).nasProject).toBeNull();
    expect(m1PathFor("/Users/pat/code/x", COMMUNITY_DEFAULTS, "/Users/pat")).toBe("/Users/pat/code/x");
    expect(localPathFor("/Users/other/x", COMMUNITY_DEFAULTS, "/Users/pat")).toBe("/Users/other/x");
    expect(isShared("/Volumes/Anything", COMMUNITY_DEFAULTS, "/Users/pat")).toBe(false);
    expect(machineKeyOf("Some Mac", "this-mac", COMMUNITY_DEFAULTS)).toBe("Some Mac");
    expect(chipsFor({ serverId: "s", serverKey: "this-mac", columns: [] }, {}, COMMUNITY_DEFAULTS)).toEqual([]);
  });

  it("maps paths between this Mac, the always-on Mac and the shared folder from the fixture profile", () => {
    const p = profileResult().profile;
    expect(m1PathFor("/Users/sam/Documents/GitHub/x", p, "/Users/sam")).toBe("/Users/studio/Documents/GitHub/x");
    expect(m1PathFor("/Users/sam/Shared/proj", p, "/Users/sam")).toBe("/Volumes/Shared/proj");
    expect(localPathFor("/Users/studio/a", p, "/Users/sam")).toBe("/Users/sam/a");
    expect(isShared("/Volumes/Shared/x", p, "/Users/sam")).toBe(true);
    expect(isShared("/Users/sam/Shared/x", p, "/Users/sam")).toBe(true);
    expect(isShared("/Users/sam/other", p, "/Users/sam")).toBe(false);
    expect(handoffOn(p)).toBe(true);
  });
});

describe("the Console's own section of the profile", () => {
  const withSection = (section: unknown) => ({ ...COMMUNITY_DEFAULTS, plugins: { console: section } });

  it("keeps the valid keys when another key is wrong, and names the wrong one", () => {
    const p = withSection({ nasProject: "Shared work", handoffFile: 42, machineHints: { laptop: "Daily driver" } });
    expect(consoleSection(p).nasProject).toBe("Shared work");
    expect(consoleSection(p).machineHints).toEqual({ laptop: "Daily driver" });
    expect(consoleSection(p).handoffFile).toBeNull();
    expect(consoleSectionProblems(p)).toHaveLength(1);
    expect(consoleSectionProblems(p)[0]).toMatch(/^plugins\.console\.handoffFile: .*ignored/);
  });

  it("ignores unknown keys quietly, and reads a section that is not an object as off, with a reason", () => {
    expect(consoleSectionProblems(withSection({ somethingNew: true }))).toEqual([]);
    expect(consoleSection(withSection("nonsense")).nasProject).toBeNull();
    expect(consoleSectionProblems(withSection("nonsense"))[0]).toMatch(/must be an object/);
    expect(consoleSectionProblems(COMMUNITY_DEFAULTS)).toEqual([]);
  });

  it("reports the problems through the profile the browser reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "console-profile-"));
    const file = join(dir, "profile.json");
    writeFileSync(file, JSON.stringify(withSection({ nasProject: "x", handoffScript: 7 })));
    const prev = process.env.NAVAIGATE_CONSOLE_PROFILE;
    process.env.NAVAIGATE_CONSOLE_PROFILE = file;
    resetProfileCache();
    try {
      const res = profileResult();
      expect(res.errors.some((e) => /plugins\.console\.handoffScript/.test(e))).toBe(true);
      expect(consoleSection(res.profile).nasProject).toBe("x");
    } finally {
      process.env.NAVAIGATE_CONSOLE_PROFILE = prev;
      resetProfileCache();
    }
  });
});

describe("saving the profile", () => {
  function inTempProfile(body: (file: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "console-profile-"));
    const file = join(dir, "profile.json");
    const prev = process.env.NAVAIGATE_CONSOLE_PROFILE;
    process.env.NAVAIGATE_CONSOLE_PROFILE = file;
    resetProfileCache();
    try { body(file); } finally {
      process.env.NAVAIGATE_CONSOLE_PROFILE = prev;
      resetProfileCache();
    }
  }

  it("refuses with a plain message when the file changed since Setup opened, and saves when the stamp still matches", () => {
    inTempProfile((file) => {
      const profile = createProfile();
      const first = profile.save({ profile: { ...COMMUNITY_DEFAULTS, owner: { name: "Pat", username: "pat" } }, expectedStamp: profile.get().stamp });
      const opened = first.stamp;
      writeFileSync(file, JSON.stringify({ ...first.profile, owner: { name: "Someone else", username: "x" } }));
      expect(() => profile.save({ profile: first.profile, expectedStamp: opened })).toThrow("The profile changed since you opened Setup. Reload and try again.");
      expect(JSON.parse(readFileSync(file, "utf8")).owner.name).toBe("Someone else");
      const current = profile.get().stamp;
      expect(profile.save({ profile: first.profile, expectedStamp: current }).profile.owner.name).toBe("Pat");
    });
  });

  it("checks the stamp only when one is sent", () => {
    inTempProfile(() => {
      const profile = createProfile();
      expect(profile.save({ profile: COMMUNITY_DEFAULTS }).source).toBe("file");
    });
  });

  it("returns the loader's refusal of a profile the next read would reject, in words", () => {
    inTempProfile(() => {
      const profile = createProfile();
      const dup = { ...COMMUNITY_DEFAULTS, machines: [COMMUNITY_DEFAULTS.machines[0]!, COMMUNITY_DEFAULTS.machines[0]!] };
      expect(() => profile.save({ profile: dup })).toThrow(/profile not saved: /);
    });
  });
});

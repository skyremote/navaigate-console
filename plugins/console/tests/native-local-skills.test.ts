// The skills opencode lists in a Local chat's first prompt, counted as opencode finds them. Every test
// builds its own home folder under the system's temporary folder; none reads the real home folder.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCODE_SKILL_CAP, SKILL_SCAN_MAX_ENTRIES, SKILLS_UNKNOWN, countSkills, createSkillCount, homeFromEnv, type LocalSkillsCount } from "../server-local-models";

const made: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "local-skills-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const skill = (folder: string, name: string, description = "Does one thing.") => {
  mkdirSync(path.join(folder, name), { recursive: true });
  writeFileSync(path.join(folder, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
};
const claudeSkills = (home: string) => path.join(home, ".claude", "skills");
const agentSkills = (home: string) => path.join(home, ".agents", "skills");

describe("counting the skills opencode lists", () => {
  it("counts none, without an error, when neither folder exists", async () => {
    expect(await countSkills(tempHome())).toEqual({ skills: 0, capped: false, complete: true });
  });

  it("does not know the count without a home folder, and counts none when home is a file", async () => {
    expect((await countSkills(null)).skills).toBeNull();
    const home = tempHome();
    const file = path.join(home, "not-a-folder");
    writeFileSync(file, "x");
    expect((await countSkills(file)).skills).toBe(0);
  });

  it("counts only folders with a SKILL.md directly inside, in both folders", async () => {
    const home = tempHome();
    skill(claudeSkills(home), "one");
    skill(claudeSkills(home), "two");
    skill(agentSkills(home), "three");
    mkdirSync(path.join(claudeSkills(home), "empty"), { recursive: true });
    mkdirSync(path.join(claudeSkills(home), "nested", "deeper"), { recursive: true });
    writeFileSync(path.join(claudeSkills(home), "nested", "deeper", "SKILL.md"), "---\ndescription: x\n---\n");
    mkdirSync(path.join(claudeSkills(home), "dir-not-file", "SKILL.md"), { recursive: true });
    skill(claudeSkills(home), ".hidden");
    writeFileSync(path.join(claudeSkills(home), "README.md"), "not a skill");
    const r = await countSkills(home);
    expect(r.skills).toBe(3);
    expect(r).toEqual({ skills: 3, capped: false, complete: true });
  });

  it("follows links: a linked skill, a linked skills folder; a broken link is left out", async () => {
    const home = tempHome();
    const elsewhere = tempHome();
    skill(path.join(elsewhere, "store"), "linked-skill");
    mkdirSync(claudeSkills(home), { recursive: true });
    symlinkSync(path.join(elsewhere, "store", "linked-skill"), path.join(claudeSkills(home), "linked-skill"));
    symlinkSync(path.join(elsewhere, "gone"), path.join(claudeSkills(home), "broken"));
    skill(path.join(elsewhere, "agents"), "a");
    skill(path.join(elsewhere, "agents"), "b");
    mkdirSync(path.join(home, ".agents"), { recursive: true });
    symlinkSync(path.join(elsewhere, "agents"), agentSkills(home));
    expect((await countSkills(home)).skills).toBe(3);
  });

  it("counts a skill name once when both folders hold it", async () => {
    const home = tempHome();
    for (const name of ["shared", "only-claude"]) skill(claudeSkills(home), name);
    for (const name of ["shared", "only-agents"]) skill(agentSkills(home), name);
    expect((await countSkills(home)).skills).toBe(3);
  });

  it("stops at opencode's cap of 200", async () => {
    const home = tempHome();
    for (let i = 0; i < 130; i++) skill(claudeSkills(home), `c${i}`);
    for (let i = 0; i < 130; i++) skill(agentSkills(home), `a${i}`);
    expect(await countSkills(home)).toMatchObject({ skills: OPENCODE_SKILL_CAP, capped: true, complete: true });
  });

  it("stays bounded in a folder with thousands of entries, and says the count stopped early", async () => {
    const home = tempHome();
    const dir = claudeSkills(home);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < SKILL_SCAN_MAX_ENTRIES + 500; i++) writeFileSync(path.join(dir, `file-${i}.txt`), "");
    const started = Date.now();
    const r = await countSkills(home);
    expect(r).toMatchObject({ skills: 0, complete: false });
    expect(Date.now() - started).toBeLessThan(10_000);
    // A smaller bound stops sooner, and a clock past the deadline stops the count at once.
    expect(await countSkills(home, { maxEntries: 10 })).toMatchObject({ skills: 0, complete: false });
    let t = 0;
    expect(await countSkills(home, { maxMs: 5, now: () => (t += 10) })).toMatchObject({ skills: 0, complete: false });
  });
});

it("opens no SKILL.md: a skill whose file cannot be read still counts", async () => {
  const home = tempHome();
  skill(claudeSkills(home), "locked");
  const { chmodSync } = await import("node:fs");
  chmodSync(path.join(claudeSkills(home), "locked", "SKILL.md"), 0o000);
  try {
    expect((await countSkills(home)).skills).toBe(1);
  } finally {
    chmodSync(path.join(claudeSkills(home), "locked", "SKILL.md"), 0o644);
  }
});

describe("the count the server serves", () => {
  it("is kept for a few minutes, then read again", async () => {
    const home = tempHome();
    skill(claudeSkills(home), "one");
    let now = 1_000_000;
    const counter = createSkillCount({ home: () => home, now: () => now, ttlMs: 60_000 });
    expect((await counter.count()).skills).toBe(1);
    skill(claudeSkills(home), "two");
    now += 30_000;
    expect((await counter.count()).skills).toBe(1);
    now += 31_000;
    expect((await counter.count()).skills).toBe(2);
  });

  it("runs one count at a time, and answers unknown rather than throwing", async () => {
    const home = tempHome();
    skill(agentSkills(home), "one");
    const counter = createSkillCount({ home: () => home });
    const [a, b] = await Promise.all([counter.count(), counter.count()]);
    expect(a).toBe(b);
    expect(a).toEqual({ skills: 1, capped: false, complete: true });
    const broken = createSkillCount({
      home: () => {
        throw new Error("no home");
      },
    });
    await expect(broken.count()).resolves.toMatchObject({ skills: null });
  });

  it("never starts a second count while one hangs: it answers unknown until that count itself finishes", async () => {
    let calls = 0;
    let finish: (v: LocalSkillsCount) => void = () => {};
    const hanging = () => {
      calls++;
      return new Promise<LocalSkillsCount>((resolve) => {
        finish = resolve;
      });
    };
    const counter = createSkillCount({ home: () => "/nowhere", count: hanging, maxMs: 10 });
    // The time limit answers unknown (maxMs + 1 s), but the count goes on.
    expect(await counter.count()).toEqual(SKILLS_UNKNOWN);
    expect(calls).toBe(1);
    expect(await counter.count()).toEqual(SKILLS_UNKNOWN);
    expect(await counter.count()).toEqual(SKILLS_UNKNOWN);
    expect(calls).toBe(1);
    // When it finishes, its answer is kept and served.
    finish({ skills: 7, capped: false, complete: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(await counter.count()).toEqual({ skills: 7, capped: false, complete: true });
    expect(calls).toBe(1);
  }, 10_000);

  it("finds the home folder in the server's environment, on Windows too", () => {
    expect(homeFromEnv({ HOME: "/home/someone" }, "linux")).toBe("/home/someone");
    expect(homeFromEnv({ HOME: "/Users/someone", USERPROFILE: "C:\\Users\\other" }, "darwin")).toBe("/Users/someone");
    expect(homeFromEnv({ HOME: "/c/Users/someone", USERPROFILE: "C:\\Users\\someone" }, "win32")).toBe("C:\\Users\\someone");
    expect(homeFromEnv({ USERPROFILE: "C:\\Users\\someone" }, "win32")).toBe("C:\\Users\\someone");
  });
});

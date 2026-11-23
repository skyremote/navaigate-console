// The Local loadout: listing the user's own skills and agents (names and sizes only), the links in the
// Local settings folder (made and removed only by their own manifest, never through a linked folder,
// never touching the user's real folders), the options written by the one settings writer, and the
// service bb's server runs. Every test works in its own temporary home, never the real one.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalClaudeSetup, ensureLocalClaude, LOCAL_TRIMMED_TOOLS, localConfigPath, localDir } from "../server-local-claude";
import { applyLoadoutLinks, createLocalLoadout, frontMatter, listLoadout, loadoutFile, readLoadout } from "../server-local-loadout";
import { defaultChoice, SKILL_LISTING_BUDGET_FRACTION, type LoadoutChoice } from "../src/local-loadout";

let home: string;
let data: string;
let bin: string;
const skillsDir = () => path.join(home, ".claude", "skills");
const agentsDir = () => path.join(home, ".claude", "agents");
const config = () => localConfigPath(home);
const file = () => loadoutFile(data);

function skill(name: string, opts: { desc?: string; bodyChars?: number } = {}) {
  const dir = path.join(skillsDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  const head = `---\nname: ${name}\ndescription: ${opts.desc ?? `Use for ${name}.`}\n---\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), head + "x".repeat(Math.max(0, (opts.bodyChars ?? 400) - head.length)));
}
function agent(name: string, desc = `Agent ${name}.`, tools = "Read, Grep") {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), `${name}.md`), `---\nname: ${name}\ndescription: ${desc}\ntools: ${tools}\n---\nYou are ${name}.\n`);
}
const fakeClaude = () => {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};
/** Every path under a folder with its kind, link target or content hash: the user's real folders must never change. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    const rel = path.relative(root, p) || ".";
    if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
    else if (st.isDirectory()) {
      out[rel] = `dir:${st.mode}`;
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    } else out[rel] = `file:${st.mode}:${st.mtimeMs}:${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;
  };
  walk(root);
  return out;
}
const choice = (over: Partial<LoadoutChoice> = {}): LoadoutChoice => ({ skills: [], agents: [], descriptions: false, allTools: false, thinkLess: false, ...over });
const ready = () => {
  fs.mkdirSync(config(), { recursive: true });
};
const apply = async (c: LoadoutChoice, extra: Partial<Parameters<typeof applyLoadoutLinks>[0]> = {}) =>
  applyLoadoutLinks({ home, config: config(), localRoot: localDir(home), file: file(), choice: c, listing: await listLoadout(home), ...extra });

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nav-loadout-")));
  data = path.join(home, ".bb");
  bin = path.join(home, "tools");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("frontMatter", () => {
  it("reads the lengths of name, description and tools, block scalars and quotes included", () => {
    expect(frontMatter("---\nname: a\ndescription: \"Hello there\"\ntools: Read\n---\nbody")).toEqual({ name: "a", descChars: 11, tools: "Read" });
    expect(frontMatter("---\ndescription: >\n  one\n  two\n---\n")?.descChars).toBe("one two".length);
    expect(frontMatter("---\ndescription: |\n  one\n  two\n---\n")?.descChars).toBe("one\ntwo".length);
    expect(frontMatter("# no front matter")).toBeNull();
    expect(frontMatter("---\nname: a\n")).toBeNull();
  });
});

describe("listLoadout", () => {
  it("is fine when the folders are missing, and when there is no home", async () => {
    expect(await listLoadout(home)).toEqual({ skills: [], agents: [], complete: true, others: { skills: 0, agents: 0 } });
    expect((await listLoadout(null)).skills).toEqual([]);
  });

  it("lists skill folders (and links to them) with a SKILL.md, and agents with front matter, by name, with sizes only", async () => {
    skill("beta", { desc: "A secret description that must never leave the server", bodyChars: 900 });
    skill("alpha");
    fs.mkdirSync(path.join(skillsDir(), "no-skill-file"));
    fs.mkdirSync(path.join(skillsDir(), ".hidden"));
    fs.writeFileSync(path.join(skillsDir(), ".hidden", "SKILL.md"), "---\ndescription: x\n---\n");
    const elsewhere = path.join(home, "elsewhere", "linked");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "---\ndescription: linked one\n---\nbody");
    fs.symlinkSync(elsewhere, path.join(skillsDir(), "linked"));
    agent("reviewer", "Reviews things.", "Read");
    fs.writeFileSync(path.join(agentsDir(), "README.md"), "# Not an agent\n");
    fs.writeFileSync(path.join(agentsDir(), "notes.txt"), "---\ndescription: x\n---\n");
    const got = await listLoadout(home);
    expect(got.skills.map((s) => s.name)).toEqual(["alpha", "beta", "linked"]);
    expect(got.skills[1]).toEqual({ name: "beta", descChars: "A secret description that must never leave the server".length, bodyChars: 900 });
    expect(got.agents).toEqual([{ name: "reviewer", listChars: "reviewer".length + "Reviews things.".length + "Read".length + 14 }]);
    expect(got.complete).toBe(true);
    // Names and numbers only: no text from any file.
    expect(JSON.stringify(got)).not.toMatch(/secret description|Reviews things|linked one/);
  });

  it("stops at its bounds and says so", async () => {
    for (let i = 0; i < 5; i++) skill(`s${i}`);
    const got = await listLoadout(home, { maxEntries: 2 });
    expect(got.complete).toBe(false);
    expect(got.skills.length).toBeLessThanOrEqual(2);
    let t = 0;
    const late = await listLoadout(home, { now: () => (t += 10_000) });
    expect(late.complete).toBe(false);
  });

  it("counts what someone put in the Local settings folder by hand, leaving the plugin's own links out", async () => {
    skill("alpha");
    ready();
    fs.mkdirSync(path.join(config(), "skills"));
    fs.mkdirSync(path.join(config(), "skills", "by-hand"));
    fs.mkdirSync(path.join(config(), "agents"));
    fs.writeFileSync(path.join(config(), "agents", "mine.md"), "---\ndescription: x\n---\n");
    const ours = path.join(config(), "skills", "alpha");
    fs.symlinkSync(path.join(skillsDir(), "alpha"), ours);
    const got = await listLoadout(home, { config: config(), manifest: { [ours]: path.join(skillsDir(), "alpha") } });
    expect(got.others).toEqual({ skills: 1, agents: 1 });
  });
});

describe("applyLoadoutLinks", () => {
  beforeEach(() => {
    skill("alpha");
    skill("beta");
    agent("reviewer");
    agent("planner");
    ready();
  });

  it("links the chosen skills and agents to the real items, and never changes the user's real folders", async () => {
    const before = snapshot(path.join(home, ".claude"));
    const got = await apply(choice({ skills: ["alpha"], agents: ["reviewer"] }));
    expect(got).toEqual({ ok: true, linked: { skills: 1, agents: 1 }, skipped: [] });
    expect(fs.readlinkSync(path.join(config(), "skills", "alpha"))).toBe(path.join(skillsDir(), "alpha"));
    expect(fs.readlinkSync(path.join(config(), "agents", "reviewer.md"))).toBe(path.join(agentsDir(), "reviewer.md"));
    expect(fs.existsSync(path.join(config(), "skills", "beta"))).toBe(false);
    expect(readLoadout(file()).links).toEqual({
      [path.join(config(), "skills", "alpha")]: path.join(skillsDir(), "alpha"),
      [path.join(config(), "agents", "reviewer.md")]: path.join(agentsDir(), "reviewer.md"),
    });
    // Unticked again: only the link goes; the real items are where they were, unchanged.
    await apply(choice());
    expect(fs.readdirSync(path.join(config(), "skills"))).toEqual([]);
    expect(fs.readdirSync(path.join(config(), "agents"))).toEqual([]);
    expect(snapshot(path.join(home, ".claude"))).toEqual(before);
  });

  it("is idempotent: applying the same choice again changes nothing", async () => {
    const c = choice({ skills: ["alpha", "beta"], agents: ["planner"] });
    await apply(c);
    const first = snapshot(config());
    const again = await apply(c);
    expect(again.linked).toEqual({ skills: 2, agents: 1 });
    expect(snapshot(config())).toEqual(first);
  });

  it("never touches a file or link someone else put where a link would go, and reports it", async () => {
    fs.mkdirSync(path.join(config(), "skills"));
    fs.mkdirSync(path.join(config(), "skills", "alpha")); // the user's own folder
    fs.mkdirSync(path.join(config(), "agents"));
    fs.symlinkSync(path.join(agentsDir(), "reviewer.md"), path.join(config(), "agents", "reviewer.md")); // a link they made by hand, same target
    const before = snapshot(config());
    const got = await apply(choice({ skills: ["alpha"], agents: ["reviewer"] }));
    expect(got.skipped).toEqual([
      { kind: "skill", name: "alpha", why: "taken" },
      { kind: "agent", name: "reviewer", why: "taken" },
    ]);
    // Unticking does not remove what the plugin did not make, even a link identical to the one it would make.
    await apply(choice());
    expect(snapshot(config())).toEqual(before);
    expect(fs.lstatSync(path.join(config(), "agents", "reviewer.md")).isSymbolicLink()).toBe(true);
    expect(fs.statSync(path.join(config(), "skills", "alpha")).isDirectory()).toBe(true);
  });

  it("leaves alone one of its own links that someone has changed since", async () => {
    await apply(choice({ skills: ["alpha"] }));
    const p = path.join(config(), "skills", "alpha");
    fs.unlinkSync(p);
    fs.symlinkSync(path.join(skillsDir(), "beta"), p); // repointed by hand
    await apply(choice());
    expect(fs.readlinkSync(p)).toBe(path.join(skillsDir(), "beta"));
    expect(readLoadout(file()).links).toEqual({});
  });

  it("removes a link without following it: the skill it points at stays whole", async () => {
    await apply(choice({ skills: ["alpha"] }));
    const before = snapshot(path.join(skillsDir(), "alpha"));
    await apply(choice());
    expect(snapshot(path.join(skillsDir(), "alpha"))).toEqual(before);
  });

  it("writes nothing when the skills or agents folder in the Local settings folder is a link (it could lead into the real one)", async () => {
    fs.symlinkSync(skillsDir(), path.join(config(), "skills"));
    const before = snapshot(path.join(home, ".claude"));
    const got = await apply(choice({ skills: ["alpha"] }));
    expect(got.ok).toBe(false);
    expect(got.reason).toMatch(/is a link/);
    expect(snapshot(path.join(home, ".claude"))).toEqual(before);
    expect(fs.existsSync(file())).toBe(false);
  });

  it("writes nothing when the Local settings folder itself is a link, or lies outside the Local folder", async () => {
    fs.rmSync(config(), { recursive: true });
    fs.symlinkSync(path.join(home, ".claude"), config());
    const before = snapshot(path.join(home, ".claude"));
    expect((await apply(choice({ skills: ["alpha"] }))).ok).toBe(false);
    expect(snapshot(path.join(home, ".claude"))).toEqual(before);
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    const got = await apply(choice({ skills: ["alpha"] }), { config: outside });
    expect(got.ok).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("where the system refuses a link, the item is reported and left out: nothing is copied", async () => {
    const got = await apply(choice({ skills: ["alpha"], agents: ["reviewer"] }), {
      symlink: () => {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
    });
    expect(got.ok).toBe(true);
    expect(got.skipped).toEqual([
      { kind: "skill", name: "alpha", why: "failed" },
      { kind: "agent", name: "reviewer", why: "failed" },
    ]);
    expect(fs.readdirSync(path.join(config(), "skills"))).toEqual([]);
    expect(readLoadout(file()).links).toEqual({});
  });

  it("saves the links it is about to make before it makes them, so an interrupted run leaves no unknown link", async () => {
    let seen: Record<string, string> = {};
    await apply(choice({ skills: ["alpha"] }), {
      symlink: (target, p) => {
        seen = readLoadout(file()).links;
        fs.symlinkSync(target, p);
      },
    });
    expect(seen[path.join(config(), "skills", "alpha")]).toBe(path.join(skillsDir(), "alpha"));
  });

  it("ignores entries of a hand-edited link list outside the Local skills/ and agents/ folders: the user's own link survives", async () => {
    // The auditor's case: the list names a link in the user's real skills folder (most skills are links).
    const elsewhere = path.join(home, "elsewhere", "linked");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "SKILL.md"), "---\ndescription: x\n---\n");
    const real = path.join(skillsDir(), "linked");
    fs.symlinkSync(elsewhere, real);
    fs.mkdirSync(path.join(config(), "skills"), { recursive: true });
    fs.mkdirSync(path.join(config(), "agents"), { recursive: true });
    const outside = path.join(home, "outside-link");
    fs.symlinkSync(elsewhere, outside);
    const viaDots = path.join(config(), "skills", "..", "..", "..", ".claude", "skills", "linked");
    const slashName = path.join(config(), "skills", "a/b");
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ v: 1, choice: null, links: { [real]: elsewhere, [outside]: elsewhere, [viaDots]: elsewhere, [slashName]: elsewhere, "relative/skills/x": elsewhere } }));
    const before = snapshot(path.join(home, ".claude"));
    await apply(choice());
    expect(fs.readlinkSync(real)).toBe(elsewhere);
    expect(fs.readlinkSync(outside)).toBe(elsewhere);
    expect(snapshot(path.join(home, ".claude"))).toEqual(before);
    expect(readLoadout(file()).links).toEqual({});
  });

  it("never writes when ~/.claude-local is a link, or resolves to the home folder or into ~/.claude", async () => {
    fs.rmSync(localDir(home), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, ".claude", "config"), { recursive: true });
    fs.symlinkSync(path.join(home, ".claude"), localDir(home));
    const before = snapshot(path.join(home, ".claude"));
    const got = await apply(choice({ skills: ["alpha"] }));
    expect(got.ok).toBe(false);
    expect(got.reason).toMatch(/is a link/);
    expect(snapshot(path.join(home, ".claude"))).toEqual(before);
    fakeClaude();
    const set = ensureLocalClaude(home, { PATH: bin });
    expect(set.ok).toBe(false);
    expect(snapshot(path.join(home, ".claude"))).toEqual(before);
  });

  it("removes its own link before checking for a name already there, so a change of case does not block the new link", async () => {
    await apply(choice({ skills: ["alpha"] }));
    // On a case-insensitive disk "Alpha" and "alpha" are one path: once the old link goes, the new one can be made.
    fs.renameSync(path.join(skillsDir(), "alpha"), path.join(skillsDir(), "alpha-old"));
    fs.mkdirSync(path.join(skillsDir(), "Alpha"));
    fs.writeFileSync(path.join(skillsDir(), "Alpha", "SKILL.md"), "---\ndescription: x\n---\n");
    const got = await apply(choice({ skills: ["Alpha"] }));
    expect(got.skipped).toEqual([]);
    expect(got.linked.skills).toBe(1);
  });

  it("links only names the listing holds", async () => {
    const got = await apply(choice({ skills: ["alpha", "../../escape", "missing"], agents: ["../x"] }));
    expect(got.linked).toEqual({ skills: 1, agents: 0 });
    expect(fs.readdirSync(path.join(config(), "skills"))).toEqual(["alpha"]);
  });
});

describe("the options go through the one settings writer", () => {
  it("writes skill descriptions and every tool into the Local settings file, and nothing else does", () => {
    fakeClaude();
    const read = () => JSON.parse(fs.readFileSync(path.join(config(), "settings.json"), "utf8"));
    expect(ensureLocalClaude(home, { PATH: bin }).ok).toBe(true);
    expect(read().permissions.deny).toEqual([...LOCAL_TRIMMED_TOOLS]);
    expect(read().skillListingBudgetFraction).toBeUndefined();
    ensureLocalClaude(home, { PATH: bin }, { descriptions: true, allTools: true });
    expect(read().skillListingBudgetFraction).toBe(SKILL_LISTING_BUDGET_FRACTION);
    expect(read().permissions).toBeUndefined();
    // Written through a temporary file renamed over the old one: none is left behind.
    expect(fs.readdirSync(config()).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("a refreshed setup takes a changed option at once, with no restart; a plain call keeps the first good result", () => {
    fakeClaude();
    let opts = { allTools: false };
    const setup = createLocalClaudeSetup({ on: () => true, ensure: () => ensureLocalClaude(home, { PATH: bin }, opts), warn: () => undefined });
    expect(setup().ok).toBe(true);
    opts = { allTools: true };
    setup();
    expect(JSON.parse(fs.readFileSync(path.join(config(), "settings.json"), "utf8")).permissions).toBeDefined();
    setup.refresh();
    expect(JSON.parse(fs.readFileSync(path.join(config(), "settings.json"), "utf8")).permissions).toBeUndefined();
  });

  it("a refresh writes nothing while the feature is off", () => {
    fakeClaude();
    const setup = createLocalClaudeSetup({ on: () => false, ensure: () => ensureLocalClaude(home, { PATH: bin }), warn: () => undefined });
    expect(setup.refresh().ok).toBe(false);
    expect(fs.existsSync(localDir(home))).toBe(false);
  });
});

describe("the loadout service", () => {
  const service = (on = true, over: Partial<Parameters<typeof createLocalLoadout>[0]> = {}) => {
    const setup = createLocalClaudeSetup({ on: () => on, ensure: () => ensureLocalClaude(home, { PATH: bin }, (() => { const c = readLoadout(file()).choice; return { allTools: c?.allTools === true, descriptions: c?.descriptions === true }; })()), warn: () => undefined });
    return createLocalLoadout({ home: () => home, config: config(), localRoot: localDir(home), file: file(), on: () => on, setup, ...over });
  };
  beforeEach(() => {
    fakeClaude();
    skill("alpha");
    skill("huge", { bodyChars: 200_000 });
    agent("reviewer");
  });

  it("reading the loadout writes nothing anywhere: no Local folder, no loadout file", async () => {
    const before = snapshot(home);
    const state = await service().state();
    expect(state.known).toBe(true);
    expect(state.saved).toBe(false);
    // The default: every skill but the oversized one, no agent, no option.
    expect(state.choice).toEqual({ skills: ["alpha"], agents: [], descriptions: false, allTools: false, thinkLess: false });
    expect(snapshot(home)).toEqual(before);
  });

  it("the server's default and the panel's default are the same function on the same listing", async () => {
    const svc = service();
    const state = await svc.state();
    expect(state.choice).toEqual(defaultChoice(state.listing));
    await svc.applyStored();
    expect(readLoadout(file()).choice).toEqual(defaultChoice(state.listing));
    expect(fs.readlinkSync(path.join(config(), "skills", "alpha"))).toBe(path.join(skillsDir(), "alpha"));
    expect(fs.existsSync(path.join(config(), "skills", "huge"))).toBe(false);
  });

  it("refuses to save while Local chats on Claude Code are off, writing nothing", async () => {
    const before = snapshot(home);
    const got = await service(false).save(choice({ skills: ["alpha"] }));
    expect(got.ok).toBe(false);
    expect(got.reason).toMatch(/are off in Setup/);
    expect(snapshot(home)).toEqual(before);
    expect(await service(false).applyStored()).toBeNull();
    expect(snapshot(home)).toEqual(before);
  });

  it("saving writes the choice, the settings (no restart) and the links, keeping only names it listed itself", async () => {
    const svc = service();
    const got = await svc.save(choice({ skills: ["alpha", "../evil", "nope"], agents: ["reviewer"], descriptions: true, thinkLess: true }));
    expect(got).toEqual({ ok: true, linked: { skills: 1, agents: 1 }, skipped: [] });
    expect(readLoadout(file()).choice).toEqual(choice({ skills: ["alpha"], agents: ["reviewer"], descriptions: true, thinkLess: true }));
    const settings = JSON.parse(fs.readFileSync(path.join(config(), "settings.json"), "utf8"));
    expect(settings.skillListingBudgetFraction).toBe(SKILL_LISTING_BUDGET_FRACTION);
    // A second save with every tool: the settings change at once, the agent link goes.
    await svc.save(choice({ skills: ["alpha"], allTools: true }));
    expect(JSON.parse(fs.readFileSync(path.join(config(), "settings.json"), "utf8")).permissions).toBeUndefined();
    expect(fs.existsSync(path.join(config(), "agents", "reviewer.md"))).toBe(false);
    expect((await svc.state()).saved).toBe(true);
  });

  it("keeps a ticked skill whose folder is briefly unreachable when saving, and links only what is listed", async () => {
    const svc = service();
    await svc.save(choice({ skills: ["alpha"] }));
    fs.renameSync(path.join(skillsDir(), "alpha"), path.join(home, "alpha-away"));
    const r = await svc.save(choice({ skills: ["alpha", "huge"] }));
    expect(r.ok).toBe(true);
    expect(readLoadout(file()).choice?.skills).toEqual(["alpha", "huge"]);
    expect(fs.existsSync(path.join(config(), "skills", "alpha"))).toBe(false);
    // A name from the browser that was never listed nor stored is not kept.
    await svc.save(choice({ skills: ["alpha", "huge", "invented"] }));
    expect(readLoadout(file()).choice?.skills).toEqual(["alpha", "huge"]);
  });

  it("says what is really linked, and why links are missing when the apply was refused", async () => {
    const svc = service();
    await svc.save(choice({ skills: ["alpha"], agents: ["reviewer"] }));
    expect((await svc.state()).linked).toEqual({ skills: ["alpha"], agents: ["reviewer"] });
    // Someone removes a link by hand: no longer counted.
    fs.unlinkSync(path.join(config(), "agents", "reviewer.md"));
    expect((await svc.state()).linked).toEqual({ skills: ["alpha"], agents: [] });
    // The skills folder becomes a link: the next apply is refused and the reason is kept.
    fs.rmSync(path.join(config(), "skills"), { recursive: true });
    fs.symlinkSync(path.join(home, "elsewhere"), path.join(config(), "skills"));
    const r = await svc.applyStored();
    expect(r?.ok).toBe(false);
    const st = await svc.state();
    expect(st.problem).toMatch(/is a link/);
    expect(st.linked.skills).toEqual([]);
  });

  it("changes nothing from a listing cut short by its bounds: no save, no apply, links kept", async () => {
    const full = service();
    await full.save(choice({ skills: ["alpha"] }));
    const cut = service(true, { list: async () => ({ skills: [], agents: [], complete: false, others: { skills: 0, agents: 0 } }) });
    const before = snapshot(config());
    const saved = await cut.save(choice({ skills: [] }));
    expect(saved.ok).toBe(false);
    expect(saved.reason).toMatch(/hold more than can be read in time/);
    expect(await cut.applyStored()).toBeNull();
    expect(snapshot(config())).toEqual(before);
    expect(readLoadout(file()).choice?.skills).toEqual(["alpha"]);
  });

  it("answers 'not known' at once, never waiting on a listing that hangs, and never joins it again", async () => {
    let calls = 0;
    const svc = service(true, { maxMs: 50, list: () => (calls++, new Promise(() => undefined)) });
    const t = Date.now();
    expect((await svc.state()).known).toBe(false);
    expect(Date.now() - t).toBeLessThan(2_000);
    expect((await svc.state()).known).toBe(false);
    expect(calls).toBe(1);
    expect((await svc.save(choice())).ok).toBe(false);
  });

  it("does not fix a default from a listing cut short by its bounds", async () => {
    const svc = service(true, { list: async () => ({ skills: [{ name: "alpha", descChars: 1, bodyChars: 1 }], agents: [], complete: false, others: { skills: 0, agents: 0 } }) });
    expect(await svc.applyStored()).toBeNull();
    expect(readLoadout(file()).choice).toBeNull();
  });
});

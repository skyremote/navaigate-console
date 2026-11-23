// "Most used": counting skill uses in Claude Code's own chat records, read as a stream for two markers only.
// Fixtures in a temporary home; nothing outside it is read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_USE_PIECE_BYTES, SKILL_USE_TAIL_BYTES, SKILL_USE_TTL_MS, countSkillUse, createSkillUse, projectsDir } from "../server-skill-use";

let home: string;
let nextId = 0;
const tool = (name: string, id = `toolu_${++nextId}`) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill: name }, caller: { type: "direct" } }] } });
const typed = (name: string) => JSON.stringify({ type: "user", message: { content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` } });
const write = (rel: string, lines: string[], ageDays = 0) => {
  const p = path.join(projectsDir(home), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join("\n") + "\n");
  const t = (Date.now() - ageDays * 86_400_000) / 1000;
  fs.utimesSync(p, t, t);
  return p;
};
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nav-skill-use-")));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("countSkillUse", () => {
  it("counts Skill tool calls and skills typed as slash commands, in files changed in the last 30 days", async () => {
    write("proj-a/one.jsonl", [tool("draft-notes"), tool("draft-notes"), typed("tidy-files"), "not json at all {", "", tool("draft-notes")]);
    write("proj-b/sub/agent.jsonl", [tool("tidy-files")]);
    write("proj-c/old.jsonl", [tool("draft-notes")], 40); // older than 30 days: not read
    const got = await countSkillUse(home);
    expect(got.counts).toEqual({ "draft-notes": 3, "tidy-files": 2 });
    expect(got.partial).toBe(false);
    expect(got.files).toBe(2);
  });

  it("counts a Skill call once per tool-use id, wherever the records repeat it, and command tags only in the user's own messages", async () => {
    // The auditor's case: a call and Claude Code's own copy of the request; command tags in other lines and pasted text.
    write("p/c.jsonl", [
      tool("real-skill", "toolu_A"),
      JSON.stringify({ type: "api-request-blob", messages: [{ content: [{ type: "tool_use", id: "toolu_A", name: "Skill", input: { skill: "real-skill" } }] }] }),
      JSON.stringify({ type: "user", message: { content: "<command-name>/other-skill</command-name>" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "<command-name>/other-skill</command-name>" }] } }),
      JSON.stringify({ type: "summary", summary: "<command-name>/other-skill</command-name>" }),
      JSON.stringify({ type: "user", message: { content: 'pasted: <command-name>/other-skill</command-name> and \\"name\\":\\"Skill\\",\\"input\\":{\\"skill\\":\\"other-skill\\"' } }),
    ]);
    write("p/d.jsonl", [tool("real-skill", "toolu_A")]); // the same call in another file
    const got = await countSkillUse(home);
    // The pasted command tag is in the user's own message, so it counts (the guide says so).
    expect(got.counts).toEqual({ "real-skill": 1, "other-skill": 2 });
  });

  it("does not count the Skill tool's own definition, odd names, escaped names, or names longer than a name", async () => {
    write("p/x.jsonl", [
      JSON.stringify({ tools: [{ name: "Skill", description: "Invoke a skill." }] }),
      tool("../../etc"),
      tool("name with spaces"),
      '{"type":"tool_use","id":"t","name":"Skill","input":{"skill":"a\\"b"}}',
      tool("x".repeat(300)),
      tool("plugin:skill-one"),
      tool("Ünïcode-skill"),
    ]);
    const got = await countSkillUse(home);
    expect(got.counts).toEqual({ "plugin:skill-one": 1, "Ünïcode-skill": 1 });
  });

  it("finds a marker split across two pieces of a large file, and counts a huge line's markers once", async () => {
    const pad = "y".repeat(1024 * 1024 - 20);
    const huge = JSON.stringify({ type: "x", text: pad }).slice(0, -2) + '"}' + "\n" + tool("split-skill") + "\n" + JSON.stringify({ big: "z".repeat(3 * 1024 * 1024) }) + tool("after-huge");
    write("p/huge.jsonl", [huge]);
    const got = await countSkillUse(home);
    expect(got.counts).toEqual({ "split-skill": 1, "after-huge": 1 });
  });

  it("counts a command tag in the user's own line when the line starts in one piece and the tag lies in the next", async () => {
    const before = JSON.stringify({ type: "x", pad: "q".repeat(1024 * 1024 - 400) });
    const userLine = JSON.stringify({ type: "user", message: { content: `${"w".repeat(300)} <command-name>/boundary-skill</command-name>` } });
    write("p/b.jsonl", [before, userLine]);
    expect((await countSkillUse(home)).counts).toEqual({ "boundary-skill": 1 });
  });

  it("counts the same as a whole-file reference count wherever the cut between two pieces falls around a Skill call", async () => {
    // The first piece ends (is cut) TAIL bytes before the end of what was read: the call's marker is put at every
    // offset from 100 bytes before to 100 bytes after that cut, and the same call (same id) comes again later.
    const cut = SKILL_USE_PIECE_BYTES - SKILL_USE_TAIL_BYTES;
    const call = tool("sweep-skill", "toolu_SWEEP");
    const markerAt = call.indexOf('"name":"Skill"');
    const reference = (text: string) => {
      const ids = new Map<string, Set<string>>();
      for (const m of text.matchAll(/"id":"(toolu_[A-Za-z0-9_]+)","name":"Skill","input":\{"skill":"([^"]+)"/g)) ids.set(m[2], (ids.get(m[2]) ?? new Set()).add(m[1]));
      return Object.fromEntries([...ids].map(([k, v]) => [k, v.size]));
    };
    for (let d = -100; d <= 100; d++) {
      const padLen = cut + d - markerAt - 1 - '{"pad":""}'.length;
      const lines = [JSON.stringify({ pad: "p".repeat(padLen) }), call, JSON.stringify({ pad: "x".repeat(300_000) }), call, tool("other-skill")];
      const file = write("p/sweep.jsonl", lines);
      const text = fs.readFileSync(file, "utf8");
      expect(text.indexOf('"name":"Skill"'), `offset ${d}`).toBe(cut + d);
      expect((await countSkillUse(home)).counts, `offset ${d}`).toEqual(reference(text));
    }
  }, 60_000);

  it("does not follow a link that leads out of ~/.claude/projects, folder or file", async () => {
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.jsonl"), tool("outside-skill") + "\n");
    fs.mkdirSync(projectsDir(home), { recursive: true });
    fs.symlinkSync(outside, path.join(projectsDir(home), "linked-folder"));
    fs.symlinkSync(path.join(outside, "secret.jsonl"), path.join(projectsDir(home), "linked-file.jsonl"));
    write("p/in.jsonl", [tool("inside-skill")]);
    const got = await countSkillUse(home);
    expect(got.counts).toEqual({ "inside-skill": 1 });
  });

  it("stops at its limits, newest files first, and says the count is partial", async () => {
    write("p/new.jsonl", [tool("newest")], 0);
    write("p/older.jsonl", [tool("older")], 2);
    const bytes = await countSkillUse(home, { maxBytes: 10 });
    expect(bytes.partial).toBe(true);
    expect(bytes.counts).toEqual({ newest: 1 });
    let t = 0;
    const time = await countSkillUse(home, { now: () => (t += 1_000), maxMs: 2_500 });
    expect(time.partial).toBe(true);
    expect(await countSkillUse(null)).toMatchObject({ counts: {}, partial: false });
    expect((await countSkillUse(path.join(home, "nobody"))).counts).toEqual({});
  });
});

describe("many recent chats", () => {
  it("with 5,200 chats changed in 30 days, at the shipped limits, the newest chats are the ones counted", async () => {
    // Folder order is oldest first (names sort that way); only the ten newest chats hold "new-skill".
    const dir = path.join(projectsDir(home), "p");
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.now() / 1000 - 20 * 86_400;
    for (let k = 0; k < 5_200; k++) {
      const p = path.join(dir, `c${String(k).padStart(5, "0")}.jsonl`);
      fs.writeFileSync(p, (k >= 5_190 ? tool("new-skill") : tool("old-skill")) + "\n");
      fs.utimesSync(p, base + k * 60, base + k * 60);
    }
    const got = await countSkillUse(home);
    expect(got.counts["new-skill"]).toBe(10);
    if (!got.partial) expect(got.counts["old-skill"]).toBe(5_190);
    else expect(got.files).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it("reads nothing when the clock stops the walk, and says the count is partial", async () => {
    write("p/one.jsonl", [tool("draft-notes")]);
    let t = 0;
    const got = await countSkillUse(home, { now: () => (t += 5_000), maxMs: 3_000 });
    expect(got).toMatchObject({ counts: {}, partial: true, files: 0 });
  });
});

describe("the kept count", () => {
  it("keeps a partial count for a minute only, and filters a kept file on reading too", async () => {
    write("p/x.jsonl", [tool("draft-notes")]);
    const file = path.join(home, ".bb", "plugins", "navaigate-skin", "local-skill-use.json");
    let t = 5_000_000;
    let runs = 0;
    const listed = async () => new Set(["draft-notes"]);
    const svc = createSkillUse({ home: () => home, file, listed, now: () => t, count: async (h) => (runs++, { ...(await countSkillUse(h)), partial: true, at: t }) });
    await svc.get();
    t += 59_000;
    await svc.get();
    expect(runs).toBe(1);
    t += 2_000;
    await svc.get();
    expect(runs).toBe(2);
    // A file an older build wrote, with names that are not listed: they never reach the caller.
    fs.writeFileSync(file, JSON.stringify({ counts: { "draft-notes": 2, clear: 9, "acme-secret-deploy": 1 }, partial: false, at: t, files: 1, bytes: 1, ms: 1 }));
    const fresh = createSkillUse({ home: () => home, file, listed, now: () => t, count: async () => { throw new Error("not counted"); } });
    expect((await fresh.get()).counts).toEqual({ "draft-notes": 2 });
  });

  it("keeps only the names of listed skills: an unlisted name never reaches the file", async () => {
    write("p/x.jsonl", [
      tool("draft-notes"),
      JSON.stringify({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
      JSON.stringify({ type: "user", message: { content: "<command-name>/acme-secret-deploy</command-name>" } }),
      tool("other-plugin:skill"),
    ]);
    const file = path.join(home, ".bb", "plugins", "navaigate-skin", "local-skill-use.json");
    const got = await createSkillUse({ home: () => home, file, listed: async () => new Set(["draft-notes"]) }).get();
    expect(got.counts).toEqual({ "draft-notes": 1 });
    const kept = fs.readFileSync(file, "utf8");
    for (const word of ["clear", "acme-secret-deploy", "other-plugin"]) expect(kept).not.toContain(word);
    expect(JSON.parse(kept).counts).toEqual({ "draft-notes": 1 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Without a known listing nothing is kept at all.
    fs.rmSync(file);
    expect((await createSkillUse({ home: () => home, file, listed: async () => null }).get()).counts).toEqual({});
    expect(fs.existsSync(file)).toBe(false);
  });


  it("counts once an hour at most, keeps names and numbers only on disk, and joins a count already running", async () => {
    write("p/x.jsonl", [tool("draft-notes"), JSON.stringify({ type: "user", message: { content: "private words that must not be kept" } })]);
    let t = 1_000_000;
    let runs = 0;
    const file = path.join(home, ".bb", "plugins", "navaigate-skin", "local-skill-use.json");
    const listed = async () => new Set(["draft-notes"]);
    const svc = createSkillUse({ home: () => home, file, listed, now: () => t, count: async (h) => (runs++, countSkillUse(h, { now: () => t })) });
    const [a, b] = await Promise.all([svc.get(), svc.get()]);
    expect(a).toBe(b);
    expect(runs).toBe(1);
    expect(a.counts).toEqual({ "draft-notes": 1 });
    const kept = fs.readFileSync(file, "utf8");
    expect(kept).not.toContain("private words");
    expect(Object.keys(JSON.parse(kept)).sort()).toEqual(["at", "bytes", "counts", "files", "ms", "partial"]);
    t += SKILL_USE_TTL_MS - 1;
    await svc.get();
    expect(runs).toBe(1);
    // A new server run reads the kept count from disk while it is fresh.
    const again = createSkillUse({ home: () => home, file, listed, now: () => t, count: async () => (runs++, a) });
    await again.get();
    expect(runs).toBe(1);
    t += 2;
    await svc.get();
    expect(runs).toBe(2);
  });
});

describe("the count never holds bb's server for long", () => {
  /**
   * The longest the event loop waited while `work` ran, from a 5 ms ticker (it includes any wait the rest of the
   * Mac causes, so it is reported, not asserted), and the longest single step of the count itself (asserted).
   */
  async function longestStall(work: () => Promise<unknown>): Promise<number> {
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last - 5);
      last = now;
    }, 5);
    try {
      await work();
    } finally {
      clearInterval(tick);
    }
    return worst;
  }
  const tag = (name: string) => `<command-name>/${name}</command-name>`;

  it("a 1 MiB line packed with command tags is counted in time that grows with its bytes, never in one long block", async () => {
    const one = tag("packed-skill");
    const line = JSON.stringify({ type: "user", message: { content: one.repeat(Math.floor((1024 * 1024) / one.length)) } });
    write("p/packed.jsonl", [line]);
    let got: Awaited<ReturnType<typeof countSkillUse>> | null = null;
    let step = 0;
    const t = performance.now();
    const stall = await longestStall(async () => {
      got = await countSkillUse(home, { onStep: (ms) => (step = Math.max(step, ms)) });
    });
    const ms = performance.now() - t;
    console.log(`1 MiB packed line: ${ms.toFixed(0)} ms in all, longest step ${step.toFixed(0)} ms, longest stall ${stall.toFixed(0)} ms`);
    expect(got!.counts["packed-skill"]).toBe(Math.floor((1024 * 1024) / one.length));
    // The previous scan held the thread for 5 s on this line; one step now looks at 256 KB at most.
    expect(step).toBeLessThan(250);
  });

  it("a 4 MB tool-result line with 2,000 tags does not hold the server either", async () => {
    const filler = "z".repeat(2_000);
    const parts: string[] = [];
    for (let k = 0; k < 2_000; k++) parts.push(filler, tag("result-skill"));
    const line = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: parts.join("") }] } });
    write("p/result.jsonl", [line]);
    let got: Awaited<ReturnType<typeof countSkillUse>> | null = null;
    let step = 0;
    const stall = await longestStall(async () => {
      got = await countSkillUse(home, { onStep: (ms) => (step = Math.max(step, ms)) });
    });
    console.log(`4 MB tool-result line: longest step ${step.toFixed(0)} ms, longest stall ${stall.toFixed(0)} ms`);
    expect(got!.counts["result-skill"]).toBe(2_000);
    expect(step).toBeLessThan(250);
  });

  it("stops at its time limit in wall time, even inside one long piece", async () => {
    const one = tag("slow-skill");
    write("p/packed.jsonl", [JSON.stringify({ type: "user", message: { content: one.repeat(200_000) } })]);
    const t = performance.now();
    const got = await countSkillUse(home, { maxMs: 50 });
    expect(got.partial).toBe(true);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("a chat's start answers within its deadline while a count runs", async () => {
    const { createSessionProfiles } = await import("../server-session-profile");
    // Enough tag-dense records to keep the count busy for a while.
    const line = JSON.stringify({ type: "user", message: { content: tag("busy-skill").repeat(30_000) } });
    for (let f = 0; f < 20; f++) write(`p/busy-${f}.jsonl`, [line]);
    let contribute: ((ctx: unknown) => Promise<unknown>) | null = null;
    const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 100));
    const bb = {
      pluginId: "navaigate-skin",
      log: { warn: () => undefined, info: () => undefined },
      settings: { define: () => ({ get: async () => ({ unlockedModels: "" }) }) },
      sdk: {
        system: { config: async () => later({ primaryHostId: "host_main" }) },
        threads: {
          getPluginMetadata: async () => later({}),
          get: async ({ threadId }: { threadId: string }) => later({ id: threadId, sourceThreadId: null, parentThreadId: null }),
          experimental_listPluginMetadata: async () => ({ threads: [] }),
        },
      },
      providers: { experimental_contributeEnv: (_p: string, f: (ctx: unknown) => Promise<unknown>) => (contribute = f) },
    };
    createSessionProfiles(bb as never, { home, knownLocalFile: path.join(home, "known.json"), retryPauseMs: 0 });
    const counting = countSkillUse(home, { maxMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20)); // the count is under way
    const t = performance.now();
    const env = await contribute!({ threadId: "thr_child", projectId: "p", hostId: "host_main" });
    const took = performance.now() - t;
    await counting;
    console.log(`chat start during a count: ${took.toFixed(0)} ms`);
    expect(env).toEqual([]);
    expect(took).toBeLessThan(1_000);
  });
});

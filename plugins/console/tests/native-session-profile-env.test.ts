import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKnownLocalStore, createSessionProfiles, LINEAGE_DEPTH, leanEnvFor, refuseLocalCopy, refuseLocalMove } from "../server-session-profile";

const MAIN = "host_main";
const OTHER = "host_other";
const lean = { profile: "lean" as const, v: 1 as const };
const base = { threadId: "thr_1", hostId: MAIN, primaryHostId: MAIN, mark: lean, dir: "/home/x/.claude-lean", dirReady: true };

describe("the lean environment rule (pure)", () => {
  it("gives CLAUDE_CONFIG_DIR only to a lean chat on the server's own Mac with the folder in place", () => {
    expect(leanEnvFor(base)).toEqual([{ name: "CLAUDE_CONFIG_DIR", value: "/home/x/.claude-lean", reason: expect.any(String) }]);
  });
  it("gives nothing to an Online chat (no mark)", () => {
    expect(leanEnvFor({ ...base, mark: null })).toEqual([]);
  });
  it("gives nothing to a Local chat", () => {
    expect(leanEnvFor({ ...base, mark: { profile: "local", model: "ollama/x", v: 1 } })).toEqual([]);
    expect(leanEnvFor({ ...base, mark: { profile: "local-unlocked", model: "ollama/x-tuned", v: 1 } })).toEqual([]);
  });
  it("gives nothing on another Mac, or when the server's own host is unknown", () => {
    expect(leanEnvFor({ ...base, hostId: OTHER })).toEqual([]);
    expect(leanEnvFor({ ...base, primaryHostId: null })).toEqual([]);
  });
  it("gives nothing without a thread, or before the lean folder is built", () => {
    expect(leanEnvFor({ ...base, threadId: null })).toEqual([]);
    expect(leanEnvFor({ ...base, dirReady: false })).toEqual([]);
  });
});

type Resolver = (ctx: { threadId: string | null; projectId: string | null; hostId: string }) => Promise<unknown[]>;

type Row = { sourceThreadId?: string | null; parentThreadId?: string | null };
function setup(metadata: Record<string, unknown>, opts: { primary?: string | null; failMeta?: Set<string>; withEnv?: boolean; rows?: Record<string, Row>; failRow?: Set<string>; deleted?: Set<string> } = {}) {
  // bb answers a read of a deleted thread with 404 thread_not_found, on both reads.
  const notFound = () => Object.assign(new Error("Thread not found"), { status: 404, code: "thread_not_found" });
  let resolver: Resolver | null = null;
  const registered: string[] = [];
  const bb = {
    pluginId: "navaigate-skin",
    log: { warn: vi.fn(), info: vi.fn() },
    settings: { define: () => ({ get: async () => ({ unlockedModels: "my-model\n# note\n\nother" }) }) },
    sdk: {
      system: { config: vi.fn(async () => ({ primaryHostId: opts.primary === undefined ? MAIN : opts.primary })) },
      threads: {
        getPluginMetadata: vi.fn(async ({ threadId }: { threadId: string }) => {
          if (opts.deleted?.has(threadId)) throw notFound();
          if (opts.failMeta?.has(threadId)) throw new Error("metadata unavailable");
          return metadata[threadId] ?? {};
        }),
        // bb's own thread row: where a chat came from (fork source, parent).
        get: vi.fn(async ({ threadId }: { threadId: string }) => {
          if (opts.deleted?.has(threadId)) throw notFound();
          if (opts.failRow?.has(threadId)) throw new Error("thread unavailable");
          return { id: threadId, sourceThreadId: null, parentThreadId: null, ...(opts.rows?.[threadId] ?? {}) };
        }),
        experimental_listPluginMetadata: vi.fn(async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds.filter((id) => metadata[id]).map((id) => ({ threadId: id, metadata: metadata[id] })),
        })),
      },
    },
    providers:
      opts.withEnv === false
        ? {}
        : {
            experimental_contributeEnv: (providerId: string, resolve: Resolver) => {
              registered.push(providerId);
              resolver = resolve;
            },
          },
  };
  return { bb, registered, resolve: (ctx: Parameters<Resolver>[0]) => resolver!(ctx) };
}

describe("the lean environment as bb calls it", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lean-env-"));
    fs.mkdirSync(path.join(home, ".claude-lean"));
    fs.writeFileSync(path.join(home, ".claude-lean", "settings.json"), "{}");
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const metadata = {
    thr_lean: { sessionProfile: { profile: "lean", v: 1 } },
    thr_local: { sessionProfile: { profile: "local", model: "ollama/qwen", v: 1 } },
    thr_other: { nativeConversation: { rootThreadId: "x" } },
    thr_bad: { sessionProfile: { profile: "lean", v: 2 } },
  };

  it("registers for Claude Code only", () => {
    const { bb, registered } = setup(metadata);
    createSessionProfiles(bb as never, { home });
    expect(registered).toEqual(["claude-code"]);
  });

  it("contributes the lean folder to a lean chat on this Mac", async () => {
    const { bb, resolve } = setup(metadata);
    createSessionProfiles(bb as never, { home });
    expect(await resolve({ threadId: "thr_lean", projectId: "p", hostId: MAIN })).toEqual([
      { name: "CLAUDE_CONFIG_DIR", value: path.join(home, ".claude-lean"), reason: expect.any(String) },
    ]);
  });

  it("contributes nothing at all to every other chat", async () => {
    const { bb, resolve } = setup(metadata, { failMeta: new Set(["thr_fail"]) });
    createSessionProfiles(bb as never, { home });
    for (const threadId of ["thr_unmarked", "thr_other", "thr_bad", "thr_fail"]) {
      expect(await resolve({ threadId, projectId: "p", hostId: MAIN })).toEqual([]);
    }
    // A chat marked Local is never left to start as an ordinary chat, even without the Local route set up: it is blocked.
    expect(await resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })).toEqual([
      { name: "BB_CLAUDE_CODE_EXECUTABLE", value: path.join(home, ".claude-local", "blocked", "local-chat-setup-failed-see-plugin-log"), reason: expect.any(String) },
    ]);
    expect(await resolve({ threadId: null, projectId: null, hostId: MAIN })).toEqual([]);
    expect(await resolve({ threadId: "thr_lean", projectId: "p", hostId: OTHER })).toEqual([]);
  });

  it("contributes nothing when the primary host is unknown or the folder is missing", async () => {
    const a = setup(metadata, { primary: null });
    createSessionProfiles(a.bb as never, { home });
    expect(await a.resolve({ threadId: "thr_lean", projectId: "p", hostId: MAIN })).toEqual([]);
    const b = setup(metadata);
    createSessionProfiles(b.bb as never, { home: path.join(home, "nowhere") });
    expect(await b.resolve({ threadId: "thr_lean", projectId: "p", hostId: MAIN })).toEqual([]);
  });

  it("keeps a lean chat lean when a later metadata read fails", async () => {
    const failMeta = new Set<string>();
    const { bb, resolve } = setup(metadata, { failMeta });
    createSessionProfiles(bb as never, { home });
    expect(await resolve({ threadId: "thr_lean", projectId: "p", hostId: MAIN })).toHaveLength(1);
    failMeta.add("thr_lean");
    expect(await resolve({ threadId: "thr_lean", projectId: "p", hostId: MAIN })).toHaveLength(1);
  });

  describe("with Local chats on Claude Code set up", () => {
    const deps = (over: Record<string, unknown> = {}) => ({ home, launcher: "/l/claude-local", guard: "/l/claude-guard", localServerPath: "/local", blocked: (why: string) => `/blocked/${why}`, ...over });
    it("gives a Local chat the launcher, the route and its marked model", async () => {
      const { bb, resolve } = setup(metadata);
      createSessionProfiles(bb as never, deps());
      const env = (await resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })) as Array<{ name: string; value: unknown }>;
      expect(env.map((e) => e.name)).toEqual(["BB_CLAUDE_CODE_EXECUTABLE", "NAV_LOCAL_BASE_URL", "NAV_LOCAL_MODEL"]);
      expect(env[2].value).toBe("qwen");
    });
    it("blocks a Local chat on another Mac, or when the launcher could not be set up", async () => {
      const a = setup(metadata);
      createSessionProfiles(a.bb as never, deps());
      expect(await a.resolve({ threadId: "thr_local", projectId: "p", hostId: OTHER })).toEqual([
        { name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/blocked/local-chats-run-only-on-the-bb-server-mac", reason: expect.any(String) },
      ]);
      const b = setup(metadata);
      createSessionProfiles(b.bb as never, deps({ launcher: null }));
      expect(await b.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })).toEqual([
        { name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/blocked/local-chat-setup-failed-see-plugin-log", reason: expect.any(String) },
      ]);
    });
    it("starts a chat whose mark cannot be read through the guard, on the bb server's Mac with the guard in place", async () => {
      const { bb, resolve } = setup(metadata, { failMeta: new Set(["thr_fail"]) });
      createSessionProfiles(bb as never, deps({ exists: (f: string) => f === "/l/claude-guard" }));
      expect(await resolve({ threadId: "thr_fail", projectId: "p", hostId: MAIN })).toEqual([{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/l/claude-guard", reason: expect.any(String) }]);
      expect(bb.sdk.threads.getPluginMetadata).toHaveBeenCalledTimes(2);
    });
    it("never changes or blocks an ordinary chat on a failed read anywhere else", async () => {
      const fail = { failMeta: new Set(["thr_fail"]) };
      // Another machine: the guard file is not there.
      const a = setup(metadata, fail);
      createSessionProfiles(a.bb as never, deps({ exists: () => true }));
      expect(await a.resolve({ threadId: "thr_fail", projectId: "p", hostId: OTHER })).toEqual([]);
      // The guard could not be set up, or its file is missing.
      const b = setup(metadata, fail);
      createSessionProfiles(b.bb as never, deps({ guard: null }));
      expect(await b.resolve({ threadId: "thr_fail", projectId: "p", hostId: MAIN })).toEqual([]);
      const c = setup(metadata, fail);
      createSessionProfiles(c.bb as never, deps({ exists: () => false }));
      expect(await c.resolve({ threadId: "thr_fail", projectId: "p", hostId: MAIN })).toEqual([]);
      // The server's own Mac is unknown.
      const d = setup(metadata, { ...fail, primary: null });
      createSessionProfiles(d.bb as never, deps({ exists: () => true }));
      expect(await d.resolve({ threadId: "thr_fail", projectId: "p", hostId: MAIN })).toEqual([]);
    });
    it("remembers a Local chat on disk, so a later failed read, or a restart, still launches it locally", async () => {
      const failMeta = new Set<string>();
      const first = setup(metadata, { failMeta });
      createSessionProfiles(first.bb as never, deps({ exists: () => true }));
      expect(((await first.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })) as Array<{ name: string }>).map((e) => e.name)).toContain("NAV_LOCAL_MODEL");
      const file = path.join(home, ".bb", "plugins", "navaigate-skin", "local-chats.json");
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ v: 1, chats: { thr_local: { profile: "local", model: "ollama/qwen", v: 1 } } });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // A restarted plugin whose every read now fails: the chat is never guarded through, it runs locally.
      const later = setup(metadata, { failMeta: new Set(["thr_local"]) });
      createSessionProfiles(later.bb as never, deps({ exists: () => true }));
      const env = (await later.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })) as Array<{ name: string; value: unknown }>;
      expect(env.map((e) => e.name)).toEqual(["BB_CLAUDE_CODE_EXECUTABLE", "NAV_LOCAL_BASE_URL", "NAV_LOCAL_MODEL"]);
      expect(env[0].value).toBe("/l/claude-local");
      expect(later.bb.sdk.threads.getPluginMetadata).not.toHaveBeenCalled();
      // And on another machine it is blocked, not passed to an ordinary claude.
      expect(await later.resolve({ threadId: "thr_local", projectId: "p", hostId: OTHER })).toEqual([
        { name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/blocked/local-chats-run-only-on-the-bb-server-mac", reason: expect.any(String) },
      ]);
    });
    it("with Local chats on Claude Code switched off: the guard leaves ordinary chats alone, and a chat marked Local is blocked", async () => {
      const off = () => false;
      const a = setup(metadata, { failMeta: new Set(["thr_fail"]) });
      createSessionProfiles(a.bb as never, deps({ exists: () => true, localClaudeOn: off }));
      expect(await a.resolve({ threadId: "thr_fail", projectId: "p", hostId: MAIN })).toEqual([]);
      const b = setup(metadata);
      createSessionProfiles(b.bb as never, deps({ localClaudeOn: off }));
      expect(await b.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })).toEqual([
        { name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/blocked/local-chats-on-claude-code-are-switched-off", reason: expect.any(String) },
      ]);
      // Switched off, nothing is set up on disk: the setup is never asked for.
      const setupCalls = vi.fn(() => ({ launcher: "/l/claude-local", guard: "/l/claude-guard" }));
      const d = setup(metadata, { failMeta: new Set(["thr_fail"]) });
      createSessionProfiles(d.bb as never, { home, localServerPath: "/local", blocked: (why: string) => `/blocked/${why}`, exists: () => true, localClaudeOn: off, localSetup: setupCalls });
      expect(await d.resolve({ threadId: "thr_fail", projectId: "p", hostId: MAIN })).toEqual([]);
      expect(await d.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })).toEqual([
        { name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/blocked/local-chats-on-claude-code-are-switched-off", reason: expect.any(String) },
      ]);
      expect(setupCalls).not.toHaveBeenCalled();
      // Switched on, the setup is asked for on first use.
      const e = setup(metadata);
      createSessionProfiles(e.bb as never, { home, localServerPath: "/local", blocked: (why: string) => `/blocked/${why}`, localClaudeOn: () => true, localSetup: setupCalls });
      expect(((await e.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })) as Array<{ value: unknown }>)[0].value).toBe("/l/claude-local");
      expect(setupCalls).toHaveBeenCalled();
      // Switched on, the same chat starts through the launcher.
      const c = setup(metadata);
      createSessionProfiles(c.bb as never, deps({ localClaudeOn: () => true }));
      expect(((await c.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN })) as Array<{ name: string }>).map((e) => e.name)).toContain("NAV_LOCAL_MODEL");
    });
    it("recovers from one failed read, and keeps an Online chat Online when a later read fails", async () => {
      let fails = 1;
      const failMeta = new Set<string>();
      const { bb, resolve } = setup(metadata, { failMeta });
      bb.sdk.threads.getPluginMetadata.mockImplementationOnce(async () => {
        if (fails-- > 0) throw new Error("blip");
        return {};
      });
      createSessionProfiles(bb as never, deps());
      expect(await resolve({ threadId: "thr_unmarked", projectId: "p", hostId: MAIN })).toEqual([]);
      failMeta.add("thr_unmarked");
      expect(await resolve({ threadId: "thr_unmarked", projectId: "p", hostId: MAIN })).toEqual([]);
    });
  });

  describe("chats made from a Local chat (forks and chats it starts)", () => {
    const CONFIG = "/l/config";
    const deps = (over: Record<string, unknown> = {}) => ({ home, launcher: "/l/claude-local", guard: "/l/claude-guard", localServerPath: "/local", localConfigDir: CONFIG, blocked: (why: string) => `/blocked/${why}`, ...over });
    const names = (env: unknown) => (env as Array<{ name: string }>).map((e) => e.name);
    const valueOf = (env: unknown, name: string) => (env as Array<{ name: string; value: unknown }>).find((e) => e.name === name)?.value;
    const knownFile = () => path.join(home, ".bb", "plugins", "navaigate-skin", "local-chats.json");

    it("the audit's case: a fork of a Local chat (no mark of its own, as bb's Fork sends none) runs on the Local chat's model through the launcher", async () => {
      const { bb, resolve } = setup(metadata, { rows: { thr_fork: { sourceThreadId: "thr_local" } } });
      const profiles = createSessionProfiles(bb as never, deps());
      const env = await resolve({ threadId: "thr_fork", projectId: "p", hostId: MAIN });
      expect(names(env)).toEqual(["BB_CLAUDE_CODE_EXECUTABLE", "NAV_LOCAL_BASE_URL", "NAV_LOCAL_MODEL", "CLAUDE_CONFIG_DIR"]);
      expect(valueOf(env, "BB_CLAUDE_CODE_EXECUTABLE")).toBe("/l/claude-local");
      expect(valueOf(env, "NAV_LOCAL_MODEL")).toBe("qwen");
      // bb copies a fork's history from the folder in the fork's own environment: the Local folder.
      expect(valueOf(env, "CLAUDE_CONFIG_DIR")).toBe(CONFIG);
      // Remembered on disk with where it came from, so a restart or a failed read cannot make it ordinary.
      expect(JSON.parse(fs.readFileSync(knownFile(), "utf8")).chats.thr_fork).toEqual({ profile: "local", model: "ollama/qwen", v: 1, line: "fork", placed: "launcher" });
      // And the Console shows it as Local.
      expect((await profiles.marks(["thr_fork"])).thr_fork).toEqual({ profile: "local", model: "ollama/qwen", v: 1 });
      // The same answer on every later start (a changed answer would rebuild its session), with no read at all.
      bb.sdk.threads.get.mockClear();
      bb.sdk.threads.getPluginMetadata.mockClear();
      expect(await resolve({ threadId: "thr_fork", projectId: "p", hostId: MAIN })).toEqual(env);
      expect(bb.sdk.threads.get).not.toHaveBeenCalled();
      expect(bb.sdk.threads.getPluginMetadata).not.toHaveBeenCalled();
    });

    it("with the feature off, a fork of a chat marked Local earlier is blocked, and the blocked path says why in words", async () => {
      const { bb, resolve } = setup(metadata, { rows: { thr_fork: { sourceThreadId: "thr_local" } } });
      const localSetup = vi.fn(() => ({ launcher: "/l/claude-local", guard: "/l/claude-guard" }));
      const profiles = createSessionProfiles(bb as never, deps({ localClaudeOn: () => false, localSetup }));
      expect(await resolve({ threadId: "thr_fork", projectId: "p", hostId: MAIN })).toEqual([
        { name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/blocked/a-fork-of-a-local-chat-stays-on-this-mac--local-chats-on-claude-code-are-switched-off", reason: expect.stringContaining("Fork of a Local chat blocked") },
        // Given with the block too, so bb fails on the blocked path (shown in its error), not on a missing history.
        { name: "CLAUDE_CONFIG_DIR", value: CONFIG, reason: expect.any(String) },
      ]);
      expect(localSetup).not.toHaveBeenCalled();
      // Blocked, so the rail does not label it as running on this Mac.
      expect(await profiles.marks(["thr_fork"])).toEqual({});
    });

    it("treats a chat started by a Local chat (its parent) the same way, and says so when it blocks it", async () => {
      const on = setup(metadata, { rows: { thr_child: { parentThreadId: "thr_local" } } });
      createSessionProfiles(on.bb as never, deps());
      expect(valueOf(await on.resolve({ threadId: "thr_child", projectId: "p", hostId: MAIN }), "NAV_LOCAL_MODEL")).toBe("qwen");
      const elsewhere = setup(metadata, { rows: { thr_child: { parentThreadId: "thr_local" } } });
      createSessionProfiles(elsewhere.bb as never, deps({ knownLocalFile: path.join(home, "other.json") }));
      expect(valueOf(await elsewhere.resolve({ threadId: "thr_child", projectId: "p", hostId: OTHER }), "BB_CLAUDE_CODE_EXECUTABLE")).toBe(
        "/blocked/a-chat-started-by-a-local-chat-stays-on-this-mac--local-chats-run-only-on-the-bb-server-mac",
      );
    });

    it("follows the line up to four steps (a fork of a chat started by a fork of a Local chat), and no further", async () => {
      const rows = { a1: { sourceThreadId: "thr_local" }, a2: { parentThreadId: "a1" }, a3: { sourceThreadId: "a2" }, a4: { parentThreadId: "a3" }, a5: { sourceThreadId: "a4" } };
      const near = setup(metadata, { rows });
      createSessionProfiles(near.bb as never, deps({ knownLocalFile: path.join(home, "near.json") }));
      expect(valueOf(await near.resolve({ threadId: "a4", projectId: "p", hostId: MAIN }), "NAV_LOCAL_MODEL")).toBe("qwen");
      const far = setup(metadata, { rows });
      createSessionProfiles(far.bb as never, deps({ knownLocalFile: path.join(home, "far.json") }));
      expect(await far.resolve({ threadId: "a5", projectId: "p", hostId: MAIN })).toEqual([]);
      expect(far.bb.sdk.threads.get.mock.calls.length).toBeLessThanOrEqual(LINEAGE_DEPTH);
    });

    it("answers from the known-Local list without reading the Local chat again", async () => {
      const first = setup(metadata);
      createSessionProfiles(first.bb as never, deps());
      await first.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN });
      const later = setup(metadata, { rows: { thr_fork: { sourceThreadId: "thr_local" } }, failMeta: new Set(["thr_local"]) });
      createSessionProfiles(later.bb as never, deps());
      expect(valueOf(await later.resolve({ threadId: "thr_fork", projectId: "p", hostId: MAIN }), "NAV_LOCAL_MODEL")).toBe("qwen");
      expect(later.bb.sdk.threads.getPluginMetadata.mock.calls.map((c) => c[0].threadId)).toEqual(["thr_fork"]);
    });

    it("costs an ordinary chat one read of its own row, once per bb run, and nothing on later starts", async () => {
      const { bb, resolve } = setup(metadata);
      createSessionProfiles(bb as never, deps());
      expect(await resolve({ threadId: "thr_unmarked", projectId: "p", hostId: MAIN })).toEqual([]);
      expect(bb.sdk.threads.getPluginMetadata).toHaveBeenCalledTimes(1);
      expect(bb.sdk.threads.get).toHaveBeenCalledTimes(1);
      expect(await resolve({ threadId: "thr_unmarked", projectId: "p", hostId: MAIN })).toEqual([]);
      expect(bb.sdk.threads.getPluginMetadata).toHaveBeenCalledTimes(1);
      expect(bb.sdk.threads.get).toHaveBeenCalledTimes(1);
    });

    it("costs a chat with an ordinary parent a bounded number of cached reads, shared with its siblings", async () => {
      const { bb, resolve } = setup(metadata, { rows: { c1: { parentThreadId: "thr_unmarked" }, c2: { parentThreadId: "thr_unmarked" } } });
      createSessionProfiles(bb as never, deps());
      expect(await resolve({ threadId: "c1", projectId: "p", hostId: MAIN })).toEqual([]);
      // Its own mark and row, the parent's mark and row.
      expect(bb.sdk.threads.getPluginMetadata).toHaveBeenCalledTimes(2);
      expect(bb.sdk.threads.get).toHaveBeenCalledTimes(2);
      expect(await resolve({ threadId: "c2", projectId: "p", hostId: MAIN })).toEqual([]);
      // The sibling reads only its own mark and row: the parent's answer is kept.
      expect(bb.sdk.threads.getPluginMetadata).toHaveBeenCalledTimes(3);
      expect(bb.sdk.threads.get).toHaveBeenCalledTimes(3);
    });

    it("leaves a chat untouched when where it came from cannot be read, and reads again at its next start", async () => {
      const failRow = new Set(["thr_unmarked"]);
      const { bb, resolve } = setup(metadata, { failRow, rows: { thr_unmarked: { sourceThreadId: "thr_local" } } });
      createSessionProfiles(bb as never, deps({ exists: () => true }));
      // Not blocked and not sent through the guard: an ordinary chat is never changed by a failed read.
      expect(await resolve({ threadId: "thr_unmarked", projectId: "p", hostId: MAIN })).toEqual([]);
      expect(bb.sdk.threads.get).toHaveBeenCalledTimes(2); // one retry
      expect(bb.log.warn).toHaveBeenCalledWith(expect.stringContaining("could not read where thr_unmarked came from"));
      // Nothing was remembered, so once the read works the fork is found.
      failRow.clear();
      expect(valueOf(await resolve({ threadId: "thr_unmarked", projectId: "p", hostId: MAIN }), "NAV_LOCAL_MODEL")).toBe("qwen");
    });

    it("leaves a chat untouched when the mark of the chat it came from cannot be read", async () => {
      const { bb, resolve } = setup(metadata, { rows: { c1: { parentThreadId: "p1" } }, failMeta: new Set(["p1"]) });
      createSessionProfiles(bb as never, deps({ exists: () => true }));
      expect(await resolve({ threadId: "c1", projectId: "p", hostId: MAIN })).toEqual([]);
    });

    it("tells another part of the Console whether a chat is Local or made from one", async () => {
      const { bb } = setup(metadata, { rows: { thr_fork: { sourceThreadId: "thr_local" } } });
      const profiles = createSessionProfiles(bb as never, deps());
      expect(await profiles.localOf("thr_local")).toMatchObject({ profile: "local" });
      expect(await profiles.localOf("thr_fork")).toMatchObject({ profile: "local", line: "fork" });
      expect(await profiles.localOf("thr_unmarked")).toBeNull();
      expect(await profiles.localOf("thr_lean")).toBeNull();
    });

    it("v2 audit: a fork whose original was deleted places as an ordinary chat, quietly, and stays placed", async () => {
      const { bb, resolve } = setup(metadata, { rows: { thr_f: { sourceThreadId: "thr_a" } }, deleted: new Set(["thr_a"]) });
      const profiles = createSessionProfiles(bb as never, deps({ exists: () => true }));
      expect(await profiles.localOf("thr_f")).toBeNull();
      expect(await resolve({ threadId: "thr_f", projectId: "p", hostId: MAIN })).toEqual([]);
      expect(await resolve({ threadId: "thr_f", projectId: "p", hostId: MAIN })).toEqual([]);
      expect(bb.log.warn).not.toHaveBeenCalled();
      // A deleted thread is not read twice, and its answer is kept.
      expect(bb.sdk.threads.getPluginMetadata.mock.calls.filter((c) => c[0].threadId === "thr_a")).toHaveLength(1);
      expect(await profiles.localOf("thr_f")).toBeNull();
    });

    it("v2 audit: a deleted Local chat is still answered from the known-Local list, so its fork stays Local", async () => {
      const first = setup(metadata);
      createSessionProfiles(first.bb as never, deps());
      await first.resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN });
      const later = setup(metadata, { rows: { thr_fork: { sourceThreadId: "thr_local" } }, deleted: new Set(["thr_local"]) });
      createSessionProfiles(later.bb as never, deps());
      expect(valueOf(await later.resolve({ threadId: "thr_fork", projectId: "p", hostId: MAIN }), "NAV_LOCAL_MODEL")).toBe("qwen");
    });

    it("v2 audit: a Codex child of a Local chat found by a refusal is never stored or shown as Local, also after a restart", async () => {
      const rows = { thr_codex: { parentThreadId: "thr_local" } };
      const a = setup(metadata, { rows });
      const profiles = createSessionProfiles(a.bb as never, deps());
      expect(await profiles.marks(["thr_codex"])).toEqual({});
      expect(await profiles.localOf("thr_codex")).toMatchObject({ profile: "local", line: "child" });
      expect(await profiles.marks(["thr_codex"])).toEqual({});
      const onDisk = fs.existsSync(knownFile()) ? JSON.parse(fs.readFileSync(knownFile(), "utf8")).chats : {};
      expect(onDisk.thr_codex).toBeUndefined();
      // A restarted plugin reading the same list: still nothing for the Codex chat, and the refusal still holds.
      const b = setup(metadata, { rows });
      const again = createSessionProfiles(b.bb as never, deps());
      expect(await again.marks(["thr_codex"])).toEqual({});
      expect(await again.localOf("thr_codex")).toMatchObject({ profile: "local" });
    });

    it("keeps what was done with a Claude Code chat made from a Local chat across a restart: Local while it runs locally, nothing once blocked", async () => {
      const rows = { thr_run: { sourceThreadId: "thr_local" }, thr_stop: { sourceThreadId: "thr_local" } };
      const on = setup(metadata, { rows });
      createSessionProfiles(on.bb as never, deps());
      await on.resolve({ threadId: "thr_run", projectId: "p", hostId: MAIN });
      const off = setup(metadata, { rows });
      createSessionProfiles(off.bb as never, deps({ localClaudeOn: () => false }));
      await off.resolve({ threadId: "thr_stop", projectId: "p", hostId: MAIN });
      const restarted = setup(metadata, { rows });
      const profiles = createSessionProfiles(restarted.bb as never, deps());
      expect(await profiles.marks(["thr_run", "thr_stop"])).toEqual({ thr_run: { profile: "local", model: "ollama/qwen", v: 1 } });
    });

    it("blocks one start, with a reason, when a chat's line cannot be read on a Mac where Local chats on Claude Code have run", async () => {
      const failRow = new Set(["thr_new"]);
      const { bb, resolve } = setup(metadata, { failRow });
      createSessionProfiles(bb as never, deps());
      await resolve({ threadId: "thr_local", projectId: "p", hostId: MAIN }); // the list is no longer empty
      expect(await resolve({ threadId: "thr_new", projectId: "p", hostId: MAIN })).toEqual([
        { name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/blocked/could-not-check-whether-a-local-chat-started-this-chat--send-again", reason: expect.any(String) },
      ]);
      // Nothing was remembered: once the read works, the ordinary chat starts as it is.
      failRow.clear();
      expect(await resolve({ threadId: "thr_new", projectId: "p", hostId: MAIN })).toEqual([]);
    });
  });

  it("leaves bb alone when it has no environment hook", () => {
    const { bb } = setup(metadata, { withEnv: false });
    expect(() => createSessionProfiles(bb as never, { home })).not.toThrow();
  });

  it("lists marks for the rail, leaving Online chats out", async () => {
    const { bb } = setup(metadata);
    const profiles = createSessionProfiles(bb as never, { home });
    expect(await profiles.marks(["thr_lean", "thr_local", "thr_other", "thr_bad", "thr_none"])).toEqual({
      thr_lean: { profile: "lean", v: 1 },
      thr_local: { profile: "local", model: "ollama/qwen", v: 1 },
    });
    // The fixture profile lists nothing, so only the setting's list counts; the lean folder is built in this home.
    expect(await profiles.config()).toEqual({ unlockedModels: ["my-model", "other"], unlockedWords: [], leanReady: true });
  });
  it("adds the profile's unlocked models and words, and says Lean is not ready without the lean folder", async () => {
    const { bb } = setup(metadata);
    const profiles = createSessionProfiles(bb as never, { home, profileUnlocked: () => ({ models: ["other", "profile-model"], words: ["tuned"] }) });
    expect(await profiles.config()).toEqual({ unlockedModels: ["my-model", "other", "profile-model"], unlockedWords: ["tuned"], leanReady: true });
    fs.rmSync(path.join(home, ".claude-lean"), { recursive: true, force: true });
    expect((await profiles.config()).leanReady).toBe(false);
  });
});

describe("the list of chats known to be Local", () => {
  it("keeps only well-formed Local marks, and survives a damaged file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "known-local-"));
    const file = path.join(dir, "local-chats.json");
    fs.writeFileSync(file, JSON.stringify({ v: 1, chats: { a: { profile: "local", model: "ollama/q", v: 1 }, b: { profile: "lean", v: 1 }, c: { profile: "local" } } }));
    const store = createKnownLocalStore(file);
    expect(store.get("a")).toEqual({ profile: "local", model: "ollama/q", v: 1 });
    expect(store.get("b")).toBeUndefined();
    expect(store.get("c")).toBeUndefined();
    fs.writeFileSync(file, "{ not json");
    const warn = vi.fn();
    expect(createKnownLocalStore(file, warn).get("a")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("moving a chat to another machine", () => {
  it("is refused for a Local chat or one made from it, and when that cannot be checked; an ordinary chat moves", async () => {
    const local = { profile: "local" as const, model: "ollama/qwen", v: 1 as const };
    await expect(refuseLocalMove(async () => local, "thr_local")).rejects.toThrow(/stays on this Mac, so it is not moved to another machine/);
    await expect(refuseLocalCopy(async (id) => (id === "thr_root" ? local : null), ["thr_member", "thr_root"], "it is not sent to another Mac with this work")).rejects.toThrow(/not sent to another Mac/);
    await expect(refuseLocalCopy(async () => null, ["thr_a", "thr_b"], "x")).resolves.toBeUndefined();
    await expect(refuseLocalMove(async () => { throw new Error("db"); }, "thr_x")).rejects.toThrow(/Could not check/);
    await expect(refuseLocalMove(async () => null, "thr_online")).resolves.toBeUndefined();
  });
});

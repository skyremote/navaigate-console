// End to end on disk: a grouped native conversation (a Codex root and a Claude
// Code continuation member) whose member runs the two Workflow runs from
// the fixtures, with real git repositories and worktrees in a temp folder.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleConversation, followedThread } from "../conversation";
import { emptyState, reduceEvents, type RawEvent } from "../model";
import { teamSchema, type DeskTeam } from "../team";
import { createTeam } from "../teamserver";

const fx = (name: string) => readFileSync(new URL(`./fixtures/team/${name}`, import.meta.url), "utf8");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

let home = "";
let repo = "";
let wt = "";
let iso = "";
const oldHome = process.env.HOME;
let team: DeskTeam;

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "hd-team-")));
  process.env.HOME = home;
  // A repo, a linked worktree one commit ahead with an uncommitted change, and a Claude Code isolated worktree.
  repo = join(home, "code", "app");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  wt = join(home, "code", "app-feature");
  git(repo, "worktree", "add", "-q", "-b", "feat/team", wt);
  writeFileSync(join(wt, "b.txt"), "b\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "second");
  writeFileSync(join(wt, "c.txt"), "dirty\n");
  iso = join(repo, ".claude", "worktrees", "agent-a1");
  git(repo, "worktree", "add", "-q", "-b", "worktree-agent-a1", iso);

  // The member's Claude Code session folder, with the two sample journals.
  const session = join(home, ".claude", "projects", "-proj", "sess-1");
  const runOne = join(session, "subagents", "workflows", "wf_b1f24914-313");
  const runTwo = join(session, "subagents", "workflows", "wf_df11a270-9c4");
  mkdirSync(runOne, { recursive: true });
  mkdirSync(runTwo, { recursive: true });
  writeFileSync(join(runOne, "journal.jsonl"), fx("journal-wf_b1f24914-313.jsonl"));
  writeFileSync(join(runTwo, "journal.jsonl"), fx("journal-wf_df11a270-9c4.jsonl"));
  const toolRow = (name: string, input: Record<string, unknown>) => JSON.stringify({ type: "assistant", message: { id: `m${Math.random()}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t", name, input }] } });
  // fix:model-switch works in the feature worktree (cwd stays elsewhere, as in real transcripts).
  writeFileSync(join(runOne, "agent-a0000000000000001.jsonl"), [toolRow("Read", { file_path: join(repo, "a.txt") }), toolRow("Bash", { command: `cd ${wt} && npm test` }), toolRow("Edit", { file_path: join(wt, "b.txt") })].join("\n") + "\n");
  writeFileSync(join(runOne, "agent-a0000000000000001.meta.json"), fx("meta-workflow.json"));
  // build:team-tab was started with Claude Code's worktree isolation.
  writeFileSync(join(runTwo, "agent-a0000000000000002.jsonl"), toolRow("Bash", { command: "ls" }) + "\n");
  writeFileSync(join(runTwo, "agent-a0000000000000002.meta.json"), JSON.stringify({ agentType: "workflow-subagent", description: "build:team-tab", worktreePath: iso, worktreeBranch: "worktree-agent-a1" }));
  writeFileSync(`${session}.jsonl`, toolRow("Bash", { command: `git -C ${repo} status` }) + "\n");

  const memberEvents: RawEvent[] = JSON.parse(fx("member-workflow-events.json"));
  // Keep the runs live relative to the test clock.
  const shift = Date.now() - Math.max(...memberEvents.map((e) => e.createdAt)) - 60_000;
  for (const e of memberEvents) {
    e.createdAt += shift;
    const agents = ((e.data.item as Record<string, unknown> | undefined)?.workflow as { agents?: { lastProgressAt?: number; startedAt?: number }[] } | undefined)?.agents ?? [];
    for (const a of agents) {
      if (a.lastProgressAt) a.lastProgressAt += shift;
      if (a.startedAt) a.startedAt += shift;
    }
  }
  const states = { thr_root: reduceEvents(emptyState(), []), thr_member: reduceEvents(emptyState(), memberEvents) };
  const now = Date.now();
  const threads: Record<string, Record<string, unknown>> = {
    thr_root: { id: "thr_root", providerId: "codex", title: "Plan the work", titleFallback: null, status: "idle", createdAt: now - 3_600_000, environment: { path: repo, branchName: "main" } },
    thr_member: { id: "thr_member", providerId: "claude-code", title: "Carry on the work", titleFallback: null, status: "active", createdAt: now - 600_000, environment: { path: join(home, "notgit"), branchName: null } },
    thr_child: { id: "thr_child", providerId: "claude-code", title: "Review thread", status: "idle", createdAt: now - 300_000, environment: { path: wt, branchName: "feat/team" } },
  };
  // The root's own items: a Fleet call to the studio.
  const rootItems: RawEvent[] = [
    { seq: 1, type: "item/completed", createdAt: now - 1000, data: { item: { type: "commandExecution", cwd: repo, command: "bb fleet start STUDIO --provider claude-code -- \"$(cat /tmp/brief.md)\"", aggregatedOutput: "Started thr_remote1\nhttps://studio.example.test/projects/p/threads/thr_remote1\n", exitCode: 0 } } },
  ];
  const bb = {
    storage: { kv: { get: async () => undefined, set: async () => undefined } },
    log: { warn: () => undefined },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => threads[threadId],
        list: async ({ parentThreadId }: { parentThreadId?: string }) => (parentThreadId === "thr_root" ? [{ ...threads.thr_child, visibility: "visible" }] : []),
        getPluginMetadata: async () => ({}),
        interactions: { list: async () => [] },
        events: { list: async ({ threadId, afterSeq }: { threadId: string; afterSeq: string }) => (threadId === "thr_root" ? rootItems.filter((e) => e.seq > Number(afterSeq)) : []) },
      },
    },
  };
  const conversation = assembleConversation({ id: "thr_root", createdAt: now - 3_600_000, status: "idle" }, [
    { id: "thr_member", createdAt: now - 600_000, status: "active", claim: { rootThreadId: "thr_root", sourceThreadId: "thr_root", kind: "continuation" } },
  ]);
  const crew = createTeam(bb as never, {
    sync: async (id) => ({ state: states[id as keyof typeof states], providerSessionId: id === "thr_member" ? "sess-1" : null }),
    conversationFor: async () => conversation,
    followedThread,
    leadModel: async (id) => (id === "thr_root" ? "GPT-6.1 Sol" : "Opus 5.5"),
    modelLabel: (m) => (m.includes("opus") ? "Opus 5.5" : m),
  });
  team = teamSchema.parse(await crew.team("thr_root"));
}, 60_000);

afterAll(() => {
  process.env.HOME = oldHome;
});

describe("the team of a grouped native conversation", () => {
  it("shows both sessions, Sol first and the Opus continuation as the one working now", () => {
    expect(team.sessions.map((s) => [s.threadId, s.role, s.model, s.active])).toEqual([
      ["thr_root", "root", "GPT-6.1 Sol", false],
      ["thr_member", "continuation", "Opus 5.5", true],
    ]);
  });

  it("finds the Workflow runs that run in the continuation member, opened from the root", () => {
    const runs = team.agents.filter((a) => a.kind === "workflow");
    expect(runs.map((r) => r.threadId)).toEqual(["thr_member", "thr_member"]);
    expect(runs.every((r) => r.state === "running")).toBe(true);
    const kids = team.agents.filter((a) => a.kind === "workflow-agent");
    expect(kids.length).toBeGreaterThanOrEqual(13);
    expect(kids.every((k) => runs.some((r) => r.id === k.parentId))).toBe(true);
    expect(runs.every((r) => r.parentId === "lead:thr_member")).toBe(true);
  });

  it("puts each Workflow agent in its worktree: from its tool calls, or from Claude Code's isolation", () => {
    const fixer = team.agents.find((a) => a.name === "fix:model-switch")!;
    expect(fixer.worktree).toBe(wt);
    expect(fixer.worktreeSource).toBe("tool-calls");
    expect(fixer.alsoTouched).toEqual([repo]);
    const builder = team.agents.find((a) => a.name === "build:team-tab")!;
    expect(builder.worktree).toBe(iso);
    expect(builder.worktreeSource).toBe("isolated");
  });

  it("reads each worktree's branch, changes and ahead/behind from git", () => {
    const feature = team.worktrees.find((w) => w.path === wt)!;
    expect(feature).toMatchObject({ name: "app-feature", repo: "app", isMain: false, branch: "feat/team", changed: 1, ahead: 1, behind: 0, base: "main", error: null });
    const main = team.worktrees.find((w) => w.path === repo)!;
    expect(main).toMatchObject({ isMain: true, branch: "main", changed: 0, base: null });
    expect(team.worktrees.find((w) => w.path === iso)).toMatchObject({ branch: "worktree-agent-a1", ahead: 0, behind: 0, base: "main" });
  });

  it("gives each lead its worktree: the Codex lead's command cwd, and none where nothing is in git", () => {
    const sol = team.agents.find((a) => a.id === "lead:thr_root")!;
    expect(sol).toMatchObject({ kind: "lead", provider: "Codex", model: "GPT-6.1 Sol", worktree: repo, state: "waiting" });
    const opus = team.agents.find((a) => a.id === "lead:thr_member")!;
    expect(opus).toMatchObject({ provider: "Claude Code", model: "Opus 5.5", state: "running", worktree: repo }); // its own git -C call
  });

  it("lists the child bb thread with its environment's worktree, and the Fleet job on the studio with its link", () => {
    expect(team.agents.find((a) => a.kind === "thread")).toMatchObject({ name: "Review thread", worktree: wt, worktreeSource: "bb", link: { localThreadId: "thr_child" } });
    expect(team.agents.find((a) => a.kind === "remote")).toMatchObject({
      name: "Brief from brief.md",
      provider: "Fleet · STUDIO",
      state: "running",
      link: { threadId: "thr_remote1", url: "https://studio.example.test/projects/p/threads/thr_remote1", machine: "STUDIO", localThreadId: null },
    });
  });
});

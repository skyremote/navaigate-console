import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyState, reduceEvents, type RawEvent } from "../model";
import { capTeam, matchRun, mergeFleetCalls, parseCodexMeta, parseFleetCall, parseJournal, parseSubagentMeta, worktreeLine, type FleetCall, type TeamAgent } from "../team";
import { observeEvents } from "../teamserver";
import { ancestors, claudeToolPaths, codexToolPaths, commandPaths, compareBase, itemPaths, parseLeftRight, parseStatus, parseWorktreeList, rankWorktrees, type PathHit } from "../worktrees";

const fx = (name: string) => readFileSync(new URL(`./fixtures/team/${name}`, import.meta.url), "utf8");

// Synthetic Workflow journals in the shape Claude Code writes under .../subagents/workflows/ (result text removed).
const waveOne = parseJournal(fx("journal-wf_b1f24914-313.jsonl"));
const waveTwo = parseJournal(fx("journal-wf_df11a270-9c4.jsonl"));

describe("Workflow journals", () => {
  it("reads every started agent with its transcript id, label and phase", () => {
    expect(waveOne).toHaveLength(11);
    expect(waveOne.find((a) => a.label === "fix:model-switch")).toEqual({ agentId: "a0000000000000001", label: "fix:model-switch", phase: "Fix", done: true });
    expect(waveTwo.map((a) => a.label)).toEqual(["integrate:release", "build:team-tab"]);
  });

  it("marks agents with a result row as done", () => {
    expect(waveOne.filter((a) => a.done).map((a) => a.label).sort()).toEqual(["build:task-a", "build:task-b", "build:task-f", "fix:model-switch", "fix:running-chip", "fix:theme-polish", "fix:usage-card", "plan:next-wave"]);
    expect(waveTwo.every((a) => !a.done)).toBe(true); // both still running when the fixture was taken
  });

  it("ignores blank and broken lines", () => {
    expect(parseJournal('{"type":"launched"}\n\nnot json\n{"type":"started","agentId":"a1","label":"x","phase":"P"}\n')).toHaveLength(1);
  });
});

describe("matching a run in bb's events to its folder on disk", () => {
  // Synthetic bb progress events for the two runs above, in the shape of a continuation member thread.
  const events: RawEvent[] = JSON.parse(fx("member-workflow-events.json"));
  const state = reduceEvents(emptyState(), events);
  const runs = [
    { dir: "wf_df11a270-9c4", agents: waveTwo },
    { dir: "wf_b1f24914-313", agents: waveOne },
  ];
  const labelsOf = (runId: string) => [...state.agents.values()].filter((a) => a.parentId === runId).map((a) => a.name);

  it("finds both runs and their agents in the member's events", () => {
    expect(labelsOf("dexample01-i129").length).toBeGreaterThanOrEqual(11);
    expect(labelsOf("dexample01-i176")).toContain("build:team-tab");
  });

  it("matches each run to the journal that shares its labels", () => {
    expect(matchRun(labelsOf("dexample01-i129"), runs)).toBe("wf_b1f24914-313");
    expect(matchRun(labelsOf("dexample01-i176"), runs)).toBe("wf_df11a270-9c4");
  });

  it("matches nothing when no label is shared", () => {
    expect(matchRun(["someone-else"], runs)).toBeNull();
    expect(matchRun([], runs)).toBeNull();
  });
});

describe("which worktree an agent works in", () => {
  // Synthetic tool calls of two Workflow agents (file bodies removed). Their process cwd stayed in the session folder, not in their worktree.
  const hitsOf = (name: string) => {
    const hits: PathHit[] = [];
    for (const line of fx(name).split("\n")) {
      if (!line.trim()) continue;
      for (const b of JSON.parse(line).message.content) hits.push(...claudeToolPaths(b.name, b.input));
    }
    return hits;
  };
  // Stand-in for the server's `.git` lookup: the checkouts that existed on the machine.
  const checkouts = ["/tmp/bbwt/model-switch", "/tmp/bbwt/theme-polish", "/tmp/bbwt/theme-harness", "/home/example/code/example-app", "/home/example/code/example-plugin"];
  const rootOf = (p: string) => checkouts.find((c) => p === c || p.startsWith(c + "/")) ?? null;

  it("puts the model-switch fixer in its own worktree, not the session cwd", () => {
    const ranked = rankWorktrees(hitsOf("agent-helperdesk-switch.jsonl"), rootOf);
    expect(ranked[0].root).toBe("/tmp/bbwt/model-switch");
    expect(ranked.map((r) => r.root)).toContain("/home/example/code/example-app"); // it read the live copy too
  });

  it("puts the theme polisher in the theme-polish worktree", () => {
    expect(rankWorktrees(hitsOf("agent-ember-polish.jsonl"), rootOf)[0].root).toBe("/tmp/bbwt/theme-polish");
  });

  it("reads cd, git -C and worktree add from shell commands", () => {
    expect(commandPaths('cd /tmp/bbwt/x && npm test; git -C "/Users/me/repo" status')).toEqual([
      { path: "/tmp/bbwt/x", weight: 2 },
      { path: "/Users/me/repo", weight: 2 },
    ]);
    expect(commandPaths("git worktree add -b feat/a /tmp/bbwt/a HEAD")).toEqual([{ path: "/tmp/bbwt/a", weight: 3 }]);
    expect(commandPaths("ls -la")).toEqual([]);
  });

  it("reads Codex exec code and patches", () => {
    const hits = codexToolPaths("exec", 'await tools.exec_command({cmd:"cd /tmp/wt && git status",workdir:"/home/example/repo"})\n*** Update File: /home/example/repo/a.ts');
    expect(hits.map((h) => h.path)).toEqual(["/home/example/repo", "/tmp/wt", "/home/example/repo/a.ts"]);
  });

  it("reads the cwd of a Codex command item and the paths of a file change in bb's events", () => {
    expect(itemPaths({ type: "commandExecution", cwd: "/tmp/wt", command: "ls" })).toEqual([{ path: "/tmp/wt", weight: 2 }]);
    expect(itemPaths({ type: "fileChange", changes: [{ path: "/tmp/wt/a.ts", kind: "update" }] })).toEqual([{ path: "/tmp/wt/a.ts", weight: 3 }]);
  });

  it("weights edits over reads and breaks ties by the newest sighting", () => {
    const ranked = rankWorktrees(
      [
        { path: "/a/x", weight: 1 },
        { path: "/b/y", weight: 3 },
        { path: "/a/z", weight: 1 },
        { path: "/c/q", weight: 2 },
        { path: "/c/r", weight: 1 },
      ],
      (p) => "/" + p.split("/")[1],
    );
    expect(ranked.map((r) => r.root)).toEqual(["/c", "/b", "/a"]);
  });

  it("walks a path up to its checkout but never past the home or tmp folders", () => {
    expect(ancestors("/home/example/code/r/src/a.ts", "/home/example")).toEqual([
      "/home/example/code/r/src/a.ts",
      "/home/example/code/r/src",
      "/home/example/code/r",
      "/home/example/code",
          ]);
    expect(ancestors("~/x/y", "/home/example")).toEqual(["/home/example/x/y", "/home/example/x"]);
    expect(ancestors("/tmp/bbwt/a", "/home/example")).toEqual(["/tmp/bbwt/a", "/tmp/bbwt"]);
  });
});

describe("git porcelain", () => {
  it("reads a clean worktree on its own branch", () => {
    const s = parseStatus(fx("git-status-worktree.txt"));
    expect(s.branch).toBe("feature/continuation");
    expect(s.head).toHaveLength(7);
    expect(s.changed).toBe(0);
    expect(s.upstream).toBeNull();
  });

  it("counts changed and untracked files", () => {
    const s = parseStatus(fx("git-status-dirty.txt"));
    expect(s.changed).toBeGreaterThanOrEqual(3);
    expect(s.untracked).toBeGreaterThanOrEqual(1);
  });

  it("reads ahead and behind against an upstream", () => {
    const s = parseStatus("# branch.oid abcdef1234\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -5\n");
    expect([s.ahead, s.behind, s.upstream]).toEqual([2, 5, "origin/main"]);
    expect(parseStatus("# branch.oid abc\n# branch.head (detached)\n").branch).toBeNull();
  });

  it("lists the repo's worktrees with the main checkout first", () => {
    const list = parseWorktreeList(fx("git-worktree-list.txt"));
    expect(list[0]).toMatchObject({ path: "/home/example/code/example-app", branch: "main" });
    expect(list.find((w) => w.path === "/private/tmp/bbwt/continuation")?.branch).toBe("feature/continuation");
  });

  it("measures a branch with no upstream against the main checkout's branch", () => {
    const main = parseWorktreeList(fx("git-worktree-list.txt"))[0];
    expect(compareBase({ branch: "navaigate/x", upstream: null }, main)).toBe("main");
    expect(compareBase({ branch: "main", upstream: null }, main)).toBeNull();
    expect(compareBase({ branch: "x", upstream: "origin/x" }, main)).toBe("origin/x");
    // `git rev-list --left-right --count main...HEAD` on the continuation worktree: 0 behind, 2 ahead.
    expect(parseLeftRight(fx("git-leftright.txt"))).toEqual([0, 2]);
  });

  it("writes one plain line per worktree", () => {
    const base = { path: "/p", name: "p", repo: "r", isMain: false, head: "abc1234", error: null };
    expect(worktreeLine({ ...base, branch: "feat/a", changed: 0, ahead: 2, behind: 0, base: "main" })).toBe("feat/a · clean · 2 ahead, 0 behind main");
    expect(worktreeLine({ ...base, branch: "feat/a", changed: 3, ahead: 0, behind: 0, base: "main" })).toBe("feat/a · 3 changed · level with main");
    expect(worktreeLine({ ...base, branch: null, changed: 0, ahead: null, behind: null, base: null })).toBe("detached at abc1234 · clean");
  });
});

describe("sub-agent records on disk", () => {
  it("reads a Workflow agent's meta", () => {
    expect(parseSubagentMeta(fx("meta-workflow.json"))).toMatchObject({ agentType: "workflow-subagent", description: "fix:model-switch", worktreePath: null });
  });

  it("reads Claude Code's worktree isolation", () => {
    const meta = parseSubagentMeta('{"agentType":"general-purpose","description":"Install","toolUseId":"toolu_1","worktreePath":"/r/.claude/worktrees/agent-a1","worktreeBranch":"worktree-agent-a1","spawnedWithWorktree":true}');
    expect(meta).toMatchObject({ toolUseId: "toolu_1", worktreePath: "/r/.claude/worktrees/agent-a1", worktreeBranch: "worktree-agent-a1" });
    expect(parseSubagentMeta("nope")).toBeNull();
  });

  it("reads a Codex sub-agent's session_meta", () => {
    const line = JSON.stringify({ type: "session_meta", payload: { id: "01a18d69", cwd: "/home/example/project", agent_nickname: "Scout", agent_role: "explorer", agent_path: "/root/example_task" } });
    expect(parseCodexMeta(line)).toEqual({ id: "01a18d69", cwd: "/home/example/project", nickname: "Scout", role: "explorer", agentPath: "/root/example_task" });
    expect(parseCodexMeta('{"type":"turn_context"}')).toBeNull();
  });
});

describe("Fleet: agents on another Mac", () => {
  it("reads a started job and its thread link (sample output)", () => {
    const out = "Selected the studio explicitly\nStarted thr_examplejob\nhttps://studio.example.test/projects/proj_exampleab/threads/thr_examplejob\nRead the answer with: bb fleet result 00000000-0000-0000-0000-000000000001\n";
    expect(parseFleetCall('bb fleet start STUDIO "$(cat /tmp/handoff/brief.md)"', out, 0)).toMatchObject({
      verb: "start",
      machine: "STUDIO",
      threadId: "thr_examplejob",
      url: "https://studio.example.test/projects/proj_exampleab/threads/thr_examplejob",
      commandId: "00000000-0000-0000-0000-000000000001",
      outcome: "started",
    });
  });

  it("reads an answered ask (sample output)", () => {
    const out = "LAPTOP here, Fleet two-way confirmed.\n\nexample-host\n\n-- LAPTOP · thread thr_exampleans · https://laptop.example.test/threads/thr_exampleans\n";
    const call = parseFleetCall('bb fleet ask LAPTOP "Reply with exactly: hello" --timeout 5m 2>&1 | tail -6', out, 0)!;
    expect(call).toMatchObject({ verb: "ask", machine: "LAPTOP", threadId: "thr_exampleans", url: "https://laptop.example.test/threads/thr_exampleans", outcome: "answered" });
    expect(call.prompt).toBe("Reply with exactly: hello");
  });

  it("reads queued, timed-out, JSON and tell calls, and skips help", () => {
    expect(parseFleetCall("bb fleet start studio do it", "Sent to STUDIO (command 00000000-0000-0000-0000-000000000002); it starts within ~10s if that machine is awake", 0)).toMatchObject({ machine: "STUDIO", threadId: null, commandId: "00000000-0000-0000-0000-000000000002", outcome: "sent" });
    expect(parseFleetCall("bb fleet ask LAPTOP long job", "timed out; command 00000000-0000-0000-0000-000000000002", 2)?.outcome).toBe("waiting");
    expect(parseFleetCall("bb fleet start --json LAPTOP go", '{"outcome":"started","threadId":"thr_abc","url":"https://laptop.example.test/threads/thr_abc","commandId":null}', 0)).toMatchObject({ machine: "LAPTOP", threadId: "thr_abc", outcome: "started" });
    expect(parseFleetCall("bb fleet tell STUDIO thr_xyz please carry on", "Delivered", 0)).toMatchObject({ verb: "tell", threadId: "thr_xyz" });
    expect(parseFleetCall("bb fleet start --help 2>&1 | head -30", "usage", 0)).toBeNull();
    expect(parseFleetCall("bb fleet status", "", 0)).toBeNull();
  });

  it("names a brief passed as a file, and ignores Fleet mentioned only inside a heredoc (sample commands)", () => {
    const started = "Selected the studio explicitly\nStarted thr_examplejob\nhttps://studio.example.test/projects/proj_exampleab/threads/thr_examplejob\n";
    const call = parseFleetCall("cat > /tmp/handoff/brief.md <<'EOF'\nrun bb fleet start LAPTOP later\nEOF\nbb fleet start STUDIO --provider claude-code -- \"$(cat /tmp/handoff/brief.md)\"", started, 0);
    expect(call).toMatchObject({ machine: "STUDIO", threadId: "thr_examplejob", prompt: "Brief from brief.md" });
    expect(parseFleetCall("bb fleet ask STUDIO --message-file /tmp/rollout_brief.md --timeout 20m > /tmp/out 2>&1", "", 2)?.prompt).toBe("Brief from rollout_brief.md");
    expect(parseFleetCall("cat >> README.md <<'EOF'\nUse bb fleet start STUDIO to begin.\nEOF", "dist/server.js", 0)).toBeNull();
  });

  it("keeps one entry per remote thread, newest outcome winning", () => {
    const list: FleetCall[] = [];
    mergeFleetCalls(list, { verb: "start", machine: "STUDIO", threadId: "thr_a", url: "https://studio/threads/thr_a", commandId: "c1", outcome: "started", prompt: "build it", at: 10 });
    mergeFleetCalls(list, { verb: "tell", machine: "STUDIO", threadId: "thr_a", url: null, commandId: null, outcome: "answered", prompt: "carry on", at: 20 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ outcome: "answered", url: "https://studio/threads/thr_a", prompt: "build it", commandId: "c1", at: 10 });
  });
});

describe("observing bb's events", () => {
  it("keeps the lead's paths, each delegation's paths and child ref, and Fleet calls", () => {
    const o = observeEvents({ version: 1, afterSeq: 0, lead: [], delegations: {}, childRefs: {}, fleet: [] }, [
      { seq: 1, type: "item/completed", createdAt: 1, data: { item: { type: "commandExecution", command: "cd /tmp/bbwt/a && npm test", cwd: "" } } },
      { seq: 2, type: "item/completed", createdAt: 2, data: { item: { type: "delegation", id: "d1", childRef: "toolu_9" } } },
      { seq: 3, type: "item/completed", createdAt: 3, data: { item: { type: "fileChange", parentToolCallId: "d1", changes: [{ path: "/tmp/bbwt/b/x.ts" }] } } },
      { seq: 4, type: "item/completed", createdAt: 4, data: { item: { type: "commandExecution", command: "bb fleet ask LAPTOP hello", aggregatedOutput: "hi\n\n-- LAPTOP · thread thr_q · https://laptop.example.test/threads/thr_q", exitCode: 0 } } },
      { seq: 5, type: "item/started", createdAt: 5, data: { item: { type: "commandExecution", command: "cd /ignored" } } },
    ]);
    expect(o.afterSeq).toBe(5);
    expect(o.lead.map((h) => h.path)).toEqual(["/tmp/bbwt/a"]);
    expect(o.delegations.d1).toEqual([{ path: "/tmp/bbwt/b/x.ts", weight: 3 }]);
    expect(o.childRefs.d1).toBe("toolu_9");
    expect(o.fleet).toEqual([expect.objectContaining({ machine: "LAPTOP", threadId: "thr_q", outcome: "answered" })]);
  });
});

describe("keeping the team under the cap", () => {
  const agent = (id: string, state: TeamAgent["state"], parentId: string | null, startedAt: number, kind: TeamAgent["kind"] = "subagent"): TeamAgent => ({
    id, kind, name: id, provider: "Claude Code", model: "", state, threadId: "thr_a", parentId, startedAt, phase: null, worktree: null, alsoTouched: [], worktreeSource: "none", link: null, note: "",
  });
  it("keeps leads, running agents and their parents, then the newest finished", () => {
    const list = [agent("lead", "waiting", null, 0, "lead"), agent("old", "finished", "lead", 1), agent("run", "finished", "lead", 2, "workflow"), agent("kid", "running", "run", 3, "workflow-agent"), agent("new", "finished", "lead", 4)];
    const { agents, omitted } = capTeam(list, 4);
    expect(agents.map((a) => a.id)).toEqual(["lead", "run", "kid", "new"]);
    expect(omitted).toBe(1);
  });
});

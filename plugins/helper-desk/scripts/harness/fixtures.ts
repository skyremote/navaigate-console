import type { AgentState, DeskAgent, DeskSnapshot } from "../../model";

const NAMES: [string, string][] = [
  ["console-finish-everything", "workflow"],
  ["verify:cutover-2", "Verify"],
  ["release:core-3", "Release"],
  ["release:desktop-package", "Release"],
  ["bug:BUG-fleet-stop", "Bugs"],
  ["bug:BUG-m1-git-504", "Bugs"],
  ["accept:three-mac-f22", "Accept"],
  ["docs:team-readme", "Docs"],
  ["verify:media-review", "Verify"],
  ["bug:BUG-connect-crash", "Bugs"],
  ["release:rebuild-2", "Release"],
  ["polish:ember-theme", "Polish"],
];
const MIXED: AgentState[] = ["running", "running", "running", "finished", "running", "failed", "running", "finished", "running", "interrupted", "running", "finished"];

export function fixtureSnapshot(count: number, mode: "running" | "mixed" | "finished", now = Date.now()): DeskSnapshot {
  const agents: DeskAgent[] = Array.from({ length: count }, (_, i) => {
    const [name, type] = NAMES[i % NAMES.length];
    const state: AgentState = mode === "mixed" ? MIXED[i % MIXED.length] : mode === "finished" ? "finished" : "running";
    return {
      id: `a${(0x5f3a91 * (i + 7)).toString(16)}${i}`,
      name: i < NAMES.length ? name : `${name}-${Math.floor(i / NAMES.length) + 1}`,
      agentType: type,
      model: i % 3 === 2 ? "Sonnet 5.5" : "Opus 5.5",
      state,
      background: true,
      startedAt: now - 302_000 + i * 1000,
      finishedAt: state === "running" ? null : now - 60_000,
      tokens: 90_000 + ((i * 7919) % 40_000),
      steps: 20 + i,
      stepLabel: state === "running" ? `Step ${20 + i} · npx vitest run` : state === "finished" ? "Reported back" : "Stopped before reporting back",
      details: [],
      progress: state === "running" ? 0.4 + ((i * 13) % 50) / 100 : 1,
      colour: i,
      summary: "",
      parentId: null,
    };
  });
  const running = agents.some((a) => a.state === "running");
  return {
    threadId: "thr_examplenx",
    title: "Helper Desk mascots",
    turnKey: "t1",
    agents,
    todos: [],
    cost: { amount: 72.1, estimated: true, currency: "USD" },
    costBreakdown: null,
    subagentTokens: agents.reduce((n, a) => n + a.tokens, 0),
    startedAt: now - 302_000,
    endedAt: running ? null : now - 60_000,
    running,
    todosUpdatedAt: null,
    lead: { label: "Lead", model: "Opus 5.5", state: running ? "working" : "waiting", activity: "Writing reply", contextUsed: 356_000, contextPct: 36, costUsd: 72.1, costEstimated: true },
    conversation: null,
    updatedAt: now,
  };
}

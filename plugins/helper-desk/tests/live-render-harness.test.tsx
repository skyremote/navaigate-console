// Renders the Live tab for a made-up batch of agents into a standalone HTML
// page with Helper Desk's CSS, for screenshots and frame-timing traces.
// Not part of the normal test run.
//
//   HD_LIVE_HTML=/tmp/live.html HD_LIVE_AGENTS=40 HD_LIVE_STATE=running npx vitest run tests/live-render-harness.test.tsx
//   HD_LIVE_STATE is running, finished or mixed. HD_LIVE_THEME=dark for the dark theme.
import { readFileSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveTab } from "../app";
import type { AgentState, DeskAgent, DeskSnapshot } from "../model";

const output = process.env.HD_LIVE_HTML ?? "";
const count = Number(process.env.HD_LIVE_AGENTS ?? 40);
const mode = process.env.HD_LIVE_STATE ?? "running";
const dark = process.env.HD_LIVE_THEME === "dark";

const NAMES = [
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

function agents(now: number): DeskAgent[] {
  return Array.from({ length: count }, (_, i) => {
    const [name, type] = NAMES[i % NAMES.length];
    const state: AgentState = mode === "mixed" ? MIXED[i % MIXED.length] : mode === "finished" ? "finished" : "running";
    const nested = mode === "mixed" && i > 0 && i < 6;
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
      stepLabel: state === "running" ? `Step ${20 + i} · cd /tmp/bbwt/${name.replace(/[^a-z0-9-]/gi, "-")} && npx vitest run` : state === "finished" ? "Reported back" : "Stopped before reporting back",
      details: [`git -C /tmp/bbwt/${name.replace(/[^a-z0-9-]/gi, "-")} log --oneline -6`, "npx tsc --noEmit -p ."],
      progress: state === "running" ? 0.4 + ((i * 13) % 50) / 100 : 1,
      colour: i,
      summary: "",
      parentId: nested ? "a" + (0x5f3a91 * 7).toString(16) + "0" : null,
    };
  });
}

describe.skipIf(!output)("render the Live tab to HTML", () => {
  it("writes the page", () => {
    const now = Date.now();
    const list = agents(now);
    const running = list.some((a) => a.state === "running");
    const data: DeskSnapshot = {
      threadId: "thr_examplenx",
      title: "Helper Desk mascots",
      turnKey: "t1",
      agents: list,
      todos: [],
      cost: { amount: 72.1, estimated: true, currency: "USD" },
      costBreakdown: null,
      subagentTokens: list.reduce((n, a) => n + a.tokens, 0),
      startedAt: now - 302_000,
      endedAt: running ? null : now - 60_000,
      running,
      todosUpdatedAt: null,
      lead: { label: "Lead", model: "Opus 5.5", state: running ? "working" : "waiting", activity: "Writing reply", contextUsed: 356_000, contextPct: 36, costUsd: 72.1, costEstimated: true },
      conversation: null,
      updatedAt: now,
    };
    const css = ["../desk.css", "../team.css"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
    const theme = dark
      ? ":root{--foreground:#ececf0;--background:#16171c;--muted:#23242a;--muted-foreground:#9a9aa3;--border:#2c2d34;--card:#1c1d22;--accent:#23242a;--ring:#c2561a;color-scheme:dark}body{margin:0;background:#101114;font-family:system-ui}"
      : ":root{--foreground:#1d1d1f;--background:#fff;--muted:#f2f2f4;--muted-foreground:#6b6b72;--border:#e3e3e8;--card:#fff;--accent:#f4f4f6;--ring:#c2561a}body{margin:0;background:#fafafa;font-family:system-ui}";
    const frame = `.frame{width:440px;margin:16px auto;border:1px solid var(--border);border-radius:12px;background:var(--background);height:auto;padding:10px}.hd-root{height:auto}`;
    const body = renderToStaticMarkup(<LiveTab threadId={data.threadId} data={data} error={null} visibility="live" now={now} delayMs={8000} onHistory={() => undefined} />);
    writeFileSync(output, `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Helper Desk Live</title><style>${theme}${frame}\n${css}</style></head><body><div class="frame"><div class="hd-root">${body}</div></div></body></html>`);
    expect(body).toContain("hd-live");
  });
});

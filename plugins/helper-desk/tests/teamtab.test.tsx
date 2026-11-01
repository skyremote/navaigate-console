// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { TeamView } from "../teamtab";
import { silenceCanvas } from "./no-canvas";
import type { DeskTeam, TeamAgent } from "../team";

silenceCanvas();
const T = 1_793_400_000_000;
const agent = (over: Partial<TeamAgent> & Pick<TeamAgent, "id" | "kind" | "name" | "threadId">): TeamAgent => ({
  provider: "Claude Code", model: "Opus 5.5", state: "finished", parentId: null, startedAt: T, phase: null, worktree: null, alsoTouched: [], worktreeSource: "none", link: null, note: "", ...over,
});
const data: DeskTeam = {
  threadId: "thr_root",
  sessions: [
    { threadId: "thr_root", title: "Plan the work", provider: "Codex", model: "GPT-6.1 Sol", role: "root", active: false, status: "idle", createdAt: T - 9e6 },
    { threadId: "thr_studio", title: "Chat on the studio", provider: "Fleet mirror", model: "On studio", role: "parallel", active: false, status: "idle", createdAt: T - 8e6 },
    { threadId: "thr_member", title: "Carry on the work", provider: "Claude Code", model: "Opus 5.5", role: "continuation", active: true, status: "active", createdAt: T - 6e5 },
  ],
  agents: [
    agent({ id: "lead:thr_root", kind: "lead", name: "Lead", threadId: "thr_root", provider: "Codex", model: "GPT-6.1 Sol", state: "waiting", worktree: "/r/app" }),
    agent({ id: "thr_root:d1", kind: "subagent", name: "/root/example_task", threadId: "thr_root", provider: "Codex", parentId: "lead:thr_root", worktree: "/r/app" }),
    agent({ id: "mirror:thr_studio", kind: "remote", name: "Chat on the studio", threadId: "thr_studio", provider: "Fleet · STUDIO", model: "", link: { threadId: "thr_r", url: "https://studio.example.test/threads/thr_r", machine: "STUDIO", localThreadId: "thr_studio" } }),
    agent({ id: "lead:thr_member", kind: "lead", name: "Lead (continuation)", threadId: "thr_member", state: "running", worktree: "/r/app" }),
    agent({ id: "thr_member:run", kind: "workflow", name: "example-wave-2", threadId: "thr_member", provider: "Workflow", state: "running", parentId: "lead:thr_member", note: "2 worktrees" }),
    agent({ id: "thr_member:run:a2", kind: "workflow-agent", name: "build:team-tab", threadId: "thr_member", provider: "Workflow", state: "running", parentId: "thr_member:run", phase: "Team", worktree: "/tmp/bbwt/team-tab", worktreeSource: "tool-calls", alsoTouched: ["/r/app"] }),
    agent({ id: "remote:x", kind: "remote", name: "Brief from brief.md", threadId: "thr_member", provider: "Fleet · STUDIO", model: "", state: "running", parentId: "lead:thr_member", link: { threadId: "thr_8j", url: "https://studio.example.test/projects/p/threads/thr_8j", machine: "STUDIO", localThreadId: null }, note: "Started on studio" }),
  ],
  worktrees: [
    { path: "/tmp/bbwt/team-tab", name: "team-tab", repo: "example-app", isMain: false, branch: "feature/team-tab", head: "64a62c9", changed: 2, ahead: 3, behind: 0, base: "main", error: null },
    { path: "/r/app", name: "app", repo: "app", isMain: true, branch: "main", head: "abc1234", changed: 0, ahead: 0, behind: 0, base: "origin/main", error: null },
  ],
  omitted: 0,
  updatedAt: T,
};

describe("Team tab", () => {
  it("shows the sessions as Sol, then the Opus continuation working now, with the studio chat alongside", () => {
    const { container } = render(<TeamView data={data} onOpenThread={() => undefined} />);
    const strip = container.querySelector(".ht-sessions")!.textContent!;
    expect(strip).toBe("GPT-6.1 Solfirst→Opus 5.5nowalongsideOn studioparallel");
  });

  it("shows working agents under the continuation lead with their worktree, branch, changes and ahead/behind", () => {
    const { container } = render(<TeamView data={data} onOpenThread={() => undefined} />);
    expect(container.querySelector(".ht-summary")!.textContent).toBe("3 agents working · 2 worktrees in use · 3 sessions");
    const live = [...container.querySelectorAll(".ht-root > .ht-group .ht-agent")].map((n) => n.querySelector(".ht-name")!.textContent);
    expect(live).toEqual(["Lead (continuation)", "example-wave-2", "build:team-tab", "Brief from brief.md"]);
    const chip = [...container.querySelectorAll(".ht-agent")].find((n) => n.textContent!.includes("build:team-tab"))!.querySelector(".ht-wt")!;
    expect(chip.textContent).toBe("team-tabfeature/team-tab · 2 changed · 3 ahead, 0 behind main");
    expect(chip.className).toContain("ht-wt-dirty");
    expect(chip.getAttribute("title")).toBe("/tmp/bbwt/team-tab (worktree of example-app)");
  });

  it("links work on another Mac, and opens Fleet's copy here", () => {
    const open = vi.fn();
    const { container } = render(<TeamView data={data} onOpenThread={open} />);
    const links = [...container.querySelectorAll(".ht-link a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("https://studio.example.test/projects/p/threads/thr_8j");
    const copy = [...container.querySelectorAll(".ht-link button")].find((b) => b.textContent === "Open the copy here")!;
    fireEvent.click(copy);
    expect(open).toHaveBeenCalledWith("thr_studio");
  });

  it("keeps finished agents under Earlier in this chat", () => {
    const { container } = render(<TeamView data={data} onOpenThread={() => undefined} />);
    const earlier = container.querySelector(".ht-earlier")!;
    expect(earlier.querySelector("summary")!.textContent).toBe("Earlier in this chat · 2");
    expect(earlier.textContent).toContain("/root/example_task");
  });
});

describe("Team tab in the Helper Desk panel", () => {
  it("asks the server for the team when the user opens the tab", async () => {
    const { act } = await import("@testing-library/react");
    const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    const app = await loadPluginApp(() => import("../app"));
    const desk = app.threadPanelActions.find((a) => a.id === "desk")!;
    const team = vi.fn(() => data);
    const snapshot = () => ({ threadId: "thr_root", title: "x", turnKey: "thr_root:0", agents: [], todos: [], cost: null, subagentTokens: 0, startedAt: null, endedAt: null, running: false, todosUpdatedAt: null, lead: { label: "Lead", model: "GPT-6.1 Sol", state: "waiting", activity: "Waiting for you", contextUsed: null, contextPct: null, costUsd: null, costEstimated: true }, updatedAt: T });
    const slot = renderSlot(desk as never, { threadId: "thr_root" }, { rpc: { snapshot, team, history: () => ({ threadId: "thr_root", lead: { label: "Lead", model: "x" }, batches: [], updatedAt: T }) } });
    const tab = [...slot.container.querySelectorAll('[role="tab"]')].find((b) => b.textContent === "Team") as HTMLButtonElement;
    expect(tab).toBeTruthy();
    await act(async () => {
      tab.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(team).toHaveBeenCalledWith({ threadId: "thr_root" });
    expect(slot.container.querySelector(".ht-sessions")!.textContent).toContain("Opus 5.5now");
    slot.lifecycle.unmount();
  });
});

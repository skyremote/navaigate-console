import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBatches, emptyState, reduceEvents, type RawEvent } from "../model";

// Two real Workflow runs from a bb thread log, with labels and prompts replaced.
const events: RawEvent[] = JSON.parse(readFileSync(new URL("./fixtures/workflow-events.json", import.meta.url), "utf8"));

describe("Workflow runs", () => {
  const state = reduceEvents(emptyState(), events);
  const agents = [...state.agents.values()];
  const runs = agents.filter((a) => a.parentId === null);

  it("makes one card per run and one per workflow agent beneath it", () => {
    expect(runs.map((r) => r.name)).toEqual(["demo-workflow-1", "demo-workflow-2"]);
    expect(agents.filter((a) => a.parentId === runs[0].id)).toHaveLength(6);
    expect(agents.filter((a) => a.parentId === runs[1].id)).toHaveLength(3);
  });

  it("reads state, tokens, tool calls and model from the progress event", () => {
    const kids = agents.filter((a) => a.parentId === runs[0].id);
    expect(kids.filter((k) => k.state === "finished")).toHaveLength(4);
    expect(kids.filter((k) => k.state === "running")).toHaveLength(2);
    for (const k of kids) {
      expect(k.finalUsage!.totalTokens).toBeGreaterThan(0);
      expect(k.childSteps).toBeGreaterThan(0);
      expect(k.model).toBe("claude-opus-5-5");
    }
    expect(runs[0].finalUsage).toBeNull(); // the run card carries no tokens, so totals are not doubled
  });

  it("keeps a run and its agents in the same batch", () => {
    const [batch] = buildBatches(state);
    expect(batch.agents).toHaveLength(11);
  });

  it("finishes every agent when the run completes", () => {
    const run = runs[1];
    const done = reduceEvents(reduceEvents(emptyState(), events), [
      { seq: 99_999, type: "item/backgroundTask/completed", createdAt: Date.now(), data: { item: { type: "backgroundTask", id: run.id, taskType: "local_workflow", taskStatus: "completed" } } },
    ]);
    const kids = [...done.agents.values()].filter((a) => a.parentId === run.id);
    expect(done.agents.get(run.id)!.state).toBe("finished");
    expect(kids.every((k) => k.state === "finished")).toBe(true);
  });
});

describe("resumed background agents", () => {
  it("gives a parked agent continued by a message its own running card", () => {
    const ev: RawEvent[] = [
      { seq: 1, type: "client/turn/requested", createdAt: 1, data: { input: [{ type: "text", text: "build it" }] } },
      { seq: 2, type: "item/started", createdAt: 2, data: { item: { type: "delegation", id: "d1", label: "Build dashboard", background: true, presentation: { detail: "general-purpose agent · model opus" } } } },
      { seq: 3, type: "item/backgroundTask/completed", createdAt: 3, data: { item: { type: "backgroundTask", taskType: "local_agent", parentToolCallId: "d1", description: "Build dashboard", taskStatus: "completed" } } },
      { seq: 4, type: "client/turn/requested", createdAt: 4, data: { input: [{ type: "text", text: "carry on" }] } },
      { seq: 5, type: "item/started", createdAt: 5, data: { item: { type: "backgroundTask", taskType: "local_agent", parentToolCallId: "m1", description: "Build dashboard", taskStatus: "running", outputFile: "/tmp/x.output" } } },
    ];
    const s = reduceEvents(emptyState(), ev);
    const resumed = s.agents.get("m1")!;
    expect(resumed.state).toBe("running");
    expect(resumed.groupSeq).toBe(4);
    expect(resumed.agentType).toBe("general-purpose");
    expect(resumed.outputFile).toBe("/tmp/x.output");
    const done = reduceEvents(s, [{ seq: 6, type: "item/backgroundTask/completed", createdAt: 6, data: { item: { type: "backgroundTask", taskType: "local_agent", parentToolCallId: "m1", description: "Build dashboard", taskStatus: "completed" } } }]);
    expect(done.agents.get("m1")!.state).toBe("finished");
  });
});

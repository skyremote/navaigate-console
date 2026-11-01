import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildEvidenceReport, collectorCatalogue, collectorBrief, extractEvidence } from "../evidence-report";
import { createDelivery } from "../server-delivery";
import { deliveryPrompt } from "../src/delivery-prompts";

const row = (over: Record<string, unknown> = {}) => ({
  sourceUrl: "https://github.com/pingdotgg/t3code/issues/12", retrievedAt: "2026-11-01T09:00:00Z", kind: "issue",
  title: "Worktree cleanup", observation: "Maintainers want a dry run first.", collector: "gh", ...over,
});
const fence = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";

describe("extractEvidence", () => {
  it("takes the newest assistant message that ends in an evidence block", () => {
    const found = extractEvidence([
      { role: "assistant", text: `Old\n${fence({ question: "old", evidence: [row()] })}` },
      { role: "user", text: "go on" },
      { role: "assistant", text: `Findings\n${fence({ question: "How do others clean up worktrees?", evidence: [row(), row({ kind: "web", sourceUrl: "https://example.com/a" })] })}\nDone.` },
    ]);
    expect(found).toMatchObject({ question: "How do others clean up worktrees?", messageIndex: 2 });
    expect(found!.evidence).toHaveLength(2);
  });
  it("accepts a bare array of rows and ignores blocks that are not evidence", () => {
    const found = extractEvidence([{ role: "assistant", text: `${fence({ config: true })}\n${fence([row()])}` }]);
    expect(found!.evidence).toHaveLength(1);
    expect(found!.question).toBeNull();
  });
  it("ignores user messages and returns null when nothing was collected", () => {
    expect(extractEvidence([{ role: "user", text: fence([row()]) }, { role: "assistant", text: "no data" }])).toBeNull();
  });
  it("survives invalid JSON in a fence", () => {
    expect(extractEvidence([{ role: "assistant", text: "```json\n{nope\n```" }])).toBeNull();
  });
});

describe("buildEvidenceReport", () => {
  const joined = {
    question: "How do others clean up worktrees?",
    duplicates: 1,
    sourceCount: 3,
    limitations: ["Evidence is supplied by the selected tools."],
    evidence: [
      row(),
      row({ kind: "video", sourceUrl: "https://www.youtube.com/watch?v=abc", title: "T3 Code tour", observation: "Shows the cleanup button.", collector: "transcripts" }),
      row({ kind: "web", sourceUrl: "https://t3.codes/docs", title: "Docs", observation: "Lists stale worktrees.", sourceId: undefined, collector: undefined }),
    ],
  } as never;
  it("cites every finding by number, groups by source type and counts the types", () => {
    const report = buildEvidenceReport(joined);
    expect(report.sourceTypes).toEqual(["issue", "video", "web"]);
    expect(report.meetsThreeSourceTypes).toBe(true);
    expect(report.markdown).toContain("# How do others clean up worktrees?");
    expect(report.markdown).toMatch(/Maintainers want a dry run first\. \[1\]/);
    expect(report.markdown).toMatch(/Shows the cleanup button\. \[2\]/);
    expect(report.markdown).toContain("1. Worktree cleanup, https://github.com/pingdotgg/t3code/issues/12");
    expect(report.markdown).toContain("1 exact repeat removed");
    expect(report.markdown).toContain("Evidence is supplied by the selected tools.");
  });
  it("shares one citation number between observations from the same source", () => {
    const report = buildEvidenceReport({ ...(joined as object), evidence: [row(), row({ observation: "A second point." })] } as never);
    expect(report.markdown).toMatch(/Maintainers want a dry run first\. \[1\]/);
    expect(report.markdown).toMatch(/A second point\. \[1\]/);
    expect(report.sourceTypes).toEqual(["issue"]);
    expect(report.meetsThreeSourceTypes).toBe(false);
    expect(report.markdown).toContain("1 source type");
  });
});

describe("collector picker", () => {
  it("lists collectors by the source type they feed, with what each needs", () => {
    expect(collectorCatalogue.map((c) => c.kind).sort()).toEqual(expect.arrayContaining(["issue", "discussion", "video", "web", "dataset"]));
    for (const c of collectorCatalogue) expect(c).toMatchObject({ id: expect.any(String), label: expect.any(String), how: expect.any(String), cost: expect.any(String) });
  });
  it("writes the chosen collectors into the research task and keeps the paid ones behind a price check", () => {
    const brief = collectorBrief(["github-issues", "apify-actors"]);
    expect(brief).toContain("GitHub issues");
    expect(brief).toMatch(/Apify/);
    expect(brief).toMatch(/price/i);
    expect(collectorBrief([])).toBe("");
  });
  it("asks the model to end with one fenced json evidence block the panel can read back", () => {
    const prompt = deliveryPrompt("research", "Q");
    expect(prompt).toContain("```json");
    expect(prompt).toMatch(/last message/i);
  });
});

describe("evidence from the thread (server)", () => {
  const events = (texts: string[]) =>
    texts.map((text, index) => ({ type: "item/completed", threadId: "t1", seq: index + 1, data: { item: { id: `i${index}`, type: "agentMessage", text } } }));
  const make = (texts: string[]) => {
    const bb = { sdk: { threads: { events: { list: vi.fn(async () => [...events(texts)].reverse()) } }, environments: {}, hosts: {}, plugins: {}, system: {} }, storage: { kv: {} }, realtime: {}, hosts: { experimental_client: () => ({}) } };
    return createDelivery(bb as unknown as BbPluginApi);
  };
  it("joins the evidence block of the latest research answer and dedupes it", async () => {
    const engine = make([`Summary\n${fence({ question: "Q?", evidence: [row(), row(), row({ kind: "web", sourceUrl: "https://example.com/a?utm_source=x" })] })}`]);
    const result = await engine.evidenceFromThread({ threadId: "t1", question: null });
    expect(result.found).toBe(true);
    expect(result.joined).toMatchObject({ question: "Q?", duplicates: 1, sourceCount: 2 });
    expect(result.joined!.evidence.map((r) => r.sourceUrl)).toContain("https://example.com/a");
  });
  it("says nothing was found when the thread has no evidence block", async () => {
    const result = await make(["Just prose."]).evidenceFromThread({ threadId: "t1", question: "Q?" });
    expect(result).toMatchObject({ found: false, joined: null });
    expect(result.message).toContain("No evidence block");
  });
  it("explains a rejected row instead of throwing", async () => {
    const result = await make([fence({ question: "Q?", evidence: [row({ retrievedAt: "2026-11-01" })] })]).evidenceFromThread({ threadId: "t1", question: null });
    expect(result.found).toBe(true);
    expect(result.joined).toBeNull();
    expect(result.rejected).toContain("retrievedAt");
  });
});

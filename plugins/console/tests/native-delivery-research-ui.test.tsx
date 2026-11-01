// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("../src/delivery-shared", async (original) => ({
  ...(await original<typeof import("../src/delivery-shared")>()),
  TaskDraft: ({ context, purpose }: { context: string; purpose: string }) => <pre data-testid="task-draft" data-purpose={purpose}>{context}</pre>,
}));
import { ResearchPanel } from "../src/delivery-research";

afterEach(cleanup);
const row = (kind: string, url: string, over: Record<string, unknown> = {}) => ({
  sourceUrl: url, retrievedAt: "2026-11-01T09:00:00Z", kind, title: `Title ${kind}`, observation: `Observation from ${kind}.`, collector: "gh", ...over,
});
const joined = (kinds: string[]) => ({
  question: "How do others clean up worktrees?", duplicates: 2, sourceCount: kinds.length, limitations: ["Evidence is supplied by the selected tools."],
  evidence: kinds.map((kind) => row(kind, `https://example.com/${kind}`)),
});
const found = (kinds: string[]) => ({ found: true, rejected: null, message: `Read ${kinds.length + 2} rows from the latest research answer; ${kinds.length} remain after removing repeats.`, joined: joined(kinds) });
const mount = (rpc: Record<string, (input: never) => unknown> = {}, threadId: string | null = "t1") =>
  renderSlot({ component: () => <ResearchPanel threadId={threadId ?? undefined} /> }, {}, { rpc: { delivery_evidence_from_thread: () => found(["issue", "video", "web"]), ...rpc }, context: { projectId: "p1" } } as never);

describe("Research panel", () => {
  it("lists collectors with their source type, cost and login, and puts the chosen ones into the task", () => {
    const view = mount();
    fireEvent.change(view.getByLabelText("Research question"), { target: { value: "How do others clean up worktrees?" } });
    const picker = view.getByRole("group", { name: "Collectors" });
    expect(picker.textContent).toContain("GitHub issues");
    expect(picker.textContent).toContain("Paid per run");
    fireEvent.click(within(picker).getByLabelText(/GitHub issues/));
    fireEvent.click(within(picker).getByLabelText(/YouTube transcripts/));
    const task = view.getByTestId("task-draft");
    expect(task.getAttribute("data-purpose")).toBe("research");
    expect(task.textContent).toContain("How do others clean up worktrees?");
    expect(task.textContent).toContain("GitHub issues [issue]");
    expect(task.textContent).toContain("YouTube transcripts [video]");
  });

  it("reads the evidence back from the thread into a deduplicated table with source links", async () => {
    const read = vi.fn(() => found(["issue", "video", "web"]));
    const view = mount({ delivery_evidence_from_thread: read });
    fireEvent.click(view.getByRole("button", { name: "Read evidence from this thread" }));
    await waitFor(() => view.getByRole("table", { name: "Collected evidence" }));
    expect(read).toHaveBeenCalledWith({ threadId: "t1", question: null });
    const table = view.getByRole("table", { name: "Collected evidence" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getAllByRole("link")[0].getAttribute("href")).toBe("https://example.com/issue");
    expect(view.getByText(/2 exact repeats removed/)).toBeTruthy();
    expect(view.getByText("3 source types: issue, video, web")).toBeTruthy();
  });

  it("builds the cited report once, and says plainly when fewer than three source types back it", async () => {
    const view = mount({ delivery_evidence_from_thread: () => found(["web", "issue"]) });
    fireEvent.click(view.getByRole("button", { name: "Read evidence from this thread" }));
    await waitFor(() => view.getByRole("table", { name: "Collected evidence" }));
    expect(view.getByText(/Only 2 source types/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Build cited report" }));
    const report = view.getByLabelText("Cited report");
    expect(report.textContent).toContain("# How do others clean up worktrees?");
    expect(report.textContent).toMatch(/Observation from web\. \[\d\]/);
  });

  it("flags requested source types that produced no rows", async () => {
    const view = mount({ delivery_evidence_from_thread: () => found(["web"]) });
    fireEvent.click(within(view.getByRole("group", { name: "Collectors" })).getByLabelText(/YouTube transcripts/));
    fireEvent.click(view.getByRole("button", { name: "Read evidence from this thread" }));
    await waitFor(() => view.getByRole("table", { name: "Collected evidence" }));
    expect(view.getByText(/No rows came back for: video/)).toBeTruthy();
  });

  it("shows what the thread had when nothing could be read, and the reason a block was rejected", async () => {
    const view = mount({ delivery_evidence_from_thread: () => ({ found: true, joined: null, rejected: "Evidence rejected: row 0 retrievedAt", message: "The evidence block in this thread was rejected, so nothing was joined." }) });
    fireEvent.click(view.getByRole("button", { name: "Read evidence from this thread" }));
    await waitFor(() => view.getByText(/was rejected, so nothing was joined/));
    expect(view.getByRole("alert").textContent).toContain("retrievedAt");
    expect(view.queryByRole("table", { name: "Collected evidence" })).toBeNull();
  });

  it("needs a thread to read from, and still takes pasted rows", () => {
    const view = mount({}, null);
    expect((view.getByRole("button", { name: "Read evidence from this thread" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByText("Paste rows by hand")).toBeTruthy();
  });
});

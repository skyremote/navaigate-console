// @vitest-environment jsdom
// F08: native agent history import, proved on fixture histories.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNativeTranscript } from "../src/context-workspace-model";

const harness = vi.hoisted(() => ({ sdk: {} as Record<string, unknown>, toThread: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useSdk: () => harness.sdk,
  useBbContext: () => ({ projectId: "proj_fixture" }),
  useComposer: () => ({ selection: null }),
  useBbNavigate: () => ({ toThread: harness.toThread }),
}));
import { NativeHistoryImport, sameWorkspacePath } from "../src/context-workspace-native-history";

const fixture = (name: string) => readFileSync(path.resolve(process.cwd(), "tests/fixtures/native-history", name), "utf8");
afterEach(() => { cleanup(); harness.toThread.mockReset(); });

describe("F08 fixture histories: visible text only", () => {
  it("imports only typed Claude Code turns, not meta, request blobs, notifications, tools or reasoning", () => {
    expect(parseNativeTranscript(fixture("claude-session.jsonl"))).toEqual({
      provider: "claude-code",
      messages: [
        { role: "user", text: "Please summarise the fixture project." },
        { role: "assistant", text: "The fixture project has two modules." },
        { role: "user", text: "Thanks, list them." },
        { role: "assistant", text: "Alpha and Beta." },
      ],
      omitted: 10,
    });
  });
  it("imports only typed Codex turns, not injected AGENTS.md or environment context", () => {
    expect(parseNativeTranscript(fixture("codex-rollout.jsonl"))).toEqual({
      provider: "codex",
      messages: [
        { role: "user", text: "Fix the failing test." },
        { role: "assistant", text: "Fixed it: the assertion used the wrong path." },
      ],
      omitted: 11,
    });
  });
});

describe("workspace path match", () => {
  it("treats trailing slashes and macOS /private aliases as the same workspace", () => {
    expect(sameWorkspacePath("/Users/studio/repo/", "/Users/studio/repo")).toBe(true);
    expect(sameWorkspacePath("/private/tmp/repo", "/tmp/repo")).toBe(true);
    expect(sameWorkspacePath("/Users/studio/repo-two", "/Users/studio/repo")).toBe(false);
  });
});

describe("NativeHistoryImport against a stubbed core extension", () => {
  it("explains the missing core extension instead of offering discovery", () => {
    harness.sdk = { environments: { list: vi.fn() } };
    render(<NativeHistoryImport />);
    expect(screen.getByText(/needs the native-history core extension/)).toBeTruthy();
    expect(screen.queryByText("Load ready workspaces")).toBeNull();
  });
  it("discovers sessions for the chosen workspace, previews one and imports it by hash without starting a turn", async () => {
    const preview = parseNativeTranscript(fixture("codex-rollout.jsonl"));
    const session = "00000000-0000-4000-8000-000000000001";
    const api = {
      list: vi.fn(async () => ({ truncated: false, entries: [
        { providerId: "codex", sessionId: session, workspacePath: "/private/tmp/fixture-workspace/", modifiedAt: 1_700_000_000_000, sizeBytes: 2048 },
        { providerId: "codex", sessionId: "00000000-0000-4000-8000-000000000002", workspacePath: "/tmp/other-workspace", modifiedAt: 1_700_000_000_000, sizeBytes: 10 },
      ] })),
      read: vi.fn(async () => ({ providerId: "codex", sessionId: session, workspacePath: "/tmp/fixture-workspace", modifiedAt: 1_700_000_000_000, sizeBytes: 2048, messages: preview.messages, omittedRecords: preview.omitted, sha256: "a".repeat(64) })),
      import: vi.fn(async () => ({ threadId: "thr_imported", reused: false })),
    };
    harness.sdk = { environments: { list: vi.fn(async () => [{ id: "env_fixture", hostId: "host_M1", path: "/tmp/fixture-workspace" }]) }, experimental_nativeHistory: api };
    render(<NativeHistoryImport />);
    fireEvent.click(screen.getByText("Load ready workspaces"));
    await waitFor(() => expect(screen.getByRole("option", { name: /env|fixture-workspace/ })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Native history workspace"), { target: { value: "env_fixture" } });
    fireEvent.click(screen.getByText(/Discover sessions/));
    await waitFor(() => expect(screen.getByText(new RegExp(session))).toBeTruthy());
    expect(api.list).toHaveBeenCalledWith({ hostId: "host_M1", providerId: "codex" });
    expect(screen.queryByText(/000000000002/)).toBeNull();
    fireEvent.click(screen.getByText(new RegExp(session)));
    await waitFor(() => expect(screen.getByText(/2 visible messages/)).toBeTruthy());
    expect(screen.queryByText(/AGENTS\.md/)).toBeNull();
    fireEvent.click(screen.getByText("Import this selected native session"));
    await waitFor(() => expect(harness.toThread).toHaveBeenCalledWith("thr_imported"));
    expect(api.import).toHaveBeenCalledWith({ providerId: "codex", projectId: "proj_fixture", environmentId: "env_fixture", sessionId: session, sha256: "a".repeat(64), title: "Imported native session" });
  });
});

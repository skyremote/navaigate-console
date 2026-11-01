import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { foldNativeMembers, nativeLogicalExec, openableHere } from "../src/native-session-rail";
import { stateOf } from "../src/shared";

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id, projectId: "proj_test", title: id, titleFallback: null, displayTitle: id,
    parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null, sectionId: null,
    originKind: null, originPluginId: null, providerId: "codex", status: "idle", runtimeStatus: "idle",
    queuedWork: "none", hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false, pinnedAt: null,
    pinSortKey: null, isArchived: false, archivedAt: null, href: `/projects/proj_test/threads/${id}`,
    isHidden: false, environment: null, host: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  } as PluginSidebarThread;
}

// The live shape: a Codex root, two Fleet mirrors (one errored) and the
// active Claude Opus continuation, all members hidden behind the root row.
const conversation = { rootThreadId: "thr_root", activeThreadId: "thr_opus", memberIds: ["thr_root", "thr_mirror", "thr_mirror_failed", "thr_opus"], members: [] as Live[] };
function family(opus: Partial<PluginSidebarThread> = {}, others: Partial<PluginSidebarThread> = {}) {
  return [
    thread("thr_root"),
    thread("thr_mirror", { isHidden: true, providerId: "fleet-mirror", ...others }),
    thread("thr_mirror_failed", { isHidden: true, providerId: "fleet-mirror", status: "error" }),
    thread("thr_opus", { isHidden: true, providerId: "claude-code", ...opus }),
    thread("thr_other"),
  ];
}
const root = (threads: readonly PluginSidebarThread[]) => threads.find((t) => t.id === "thr_root")!;

type Live = { id: string; projectId: string; providerId: string; status: string; isHidden: boolean; isArchived: boolean; hasPendingInteraction: boolean; model: string | null; reasoningLevel: string | null };
const live = (id: string, overrides: Partial<Live> = {}): Live => ({ id, projectId: "proj_test", providerId: "codex", status: "idle", isHidden: true, isArchived: false, hasPendingInteraction: false, model: null, reasoningLevel: null, ...overrides });
// What bb's list really holds: the visible root only; hidden members come from the index.
function liveFamily(opus: Partial<Live> = {}, mirror: Partial<Live> = {}) {
  return {
    threads: [thread("thr_root", { isUnread: true, indicator: "unread-success", indicatorLabel: "Unread thread succeeded" }), thread("thr_other")],
    conversation: { ...conversation, members: [
      live("thr_root", { isHidden: false, model: null }),
      live("thr_mirror", { providerId: "fleet-mirror", ...mirror }),
      live("thr_mirror_failed", { providerId: "fleet-mirror", status: "error" }),
      live("thr_opus", { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", ...opus }),
    ] },
  };
}

describe("grouped native conversation rows", () => {
  it("shows the root row running while its hidden active continuation runs", () => {
    const threads = family({ status: "active", runtimeStatus: "active" });
    expect(stateOf(root(threads))).toBe("parked");
    const folded = foldNativeMembers(threads, [conversation]);
    expect(stateOf(root(folded))).toBe("running");
    expect(root(folded).status).toBe("active");
    // Other rows keep their identity, so memoised rows do not redraw.
    expect(folded.find((t) => t.id === "thr_other")).toBe(threads.find((t) => t.id === "thr_other"));
  });

  it("shows any running member, including background work", () => {
    expect(stateOf(root(foldNativeMembers(family({}, { status: "starting" }), [conversation])))).toBe("running");
    const background = foldNativeMembers(family({ activity: { workflows: 0, backgroundAgents: 2, backgroundCommands: 0 } }), [conversation]);
    expect(stateOf(root(background))).toBe("running");
    expect(root(background).activity.backgroundAgents).toBe(2);
  });

  it("shows needs input from any member, and a failure only from the active member", () => {
    const asking = root(foldNativeMembers(family({}, { hasPendingInteraction: true, indicator: "waiting-for-input", indicatorLabel: "Thread needs user input" }), [conversation]));
    expect(stateOf(asking)).toBe("needs");
    expect(asking.indicatorLabel).toBe("Thread needs user input");
    expect(stateOf(root(foldNativeMembers(family({ status: "error" }), [conversation])))).toBe("needs");
    // The errored mirror is not the active member: it does not hold the row.
    const idle = family();
    expect(foldNativeMembers(idle, [conversation])).toBe(idle);
  });

  it("prefers running over needs input and leaves the root's own state alone", () => {
    const both = foldNativeMembers(family({ status: "active" }, { hasPendingInteraction: true }), [conversation]);
    expect(stateOf(root(both))).toBe("running");
    const rootRunning = family({ status: "error" });
    rootRunning[0] = thread("thr_root", { status: "active" });
    expect(root(foldNativeMembers(rootRunning, [conversation]))).toBe(rootRunning[0]);
  });

  it("ignores visible members, archived members, other projects and unknown conversations", () => {
    const visible = family({ status: "active", isHidden: false });
    expect(foldNativeMembers(visible, [conversation])).toBe(visible);
    const archived = family({ status: "active", isArchived: true });
    expect(foldNativeMembers(archived, [conversation])).toBe(archived);
    const elsewhere = family({ status: "active", projectId: "proj_other" });
    expect(foldNativeMembers(elsewhere, [conversation])).toBe(elsewhere);
    const running = family({ status: "active" });
    expect(foldNativeMembers(running, [])).toBe(running);
    expect(foldNativeMembers(running, [{ ...conversation, rootThreadId: "thr_missing" }])).toBe(running);
  });

  it("folds hidden members that bb's list leaves out, from the index's live snapshot", () => {
    const running = liveFamily({ status: "active" });
    const row = root(foldNativeMembers(running.threads, [running.conversation]));
    expect(stateOf(row)).toBe("running");
    expect(row.status).toBe("active");
    expect(row.id).toBe("thr_root");
    expect(row.href).toBe("/projects/proj_test/threads/thr_root");
    expect(row.providerId).toBe("claude-code");
    // Working, as bb labels a running thread, not the root's own "unread thread succeeded".
    expect(row.indicator).toBe("runtime");
    expect(row.indicatorLabel).toBe("Thread working");
    // Folding never touches the physical root.
    expect(root(running.threads).providerId).toBe("codex");

    const asking = root(foldNativeMembers(liveFamily({}, { hasPendingInteraction: true }).threads, [liveFamily({}, { hasPendingInteraction: true }).conversation]));
    expect(stateOf(asking)).toBe("needs");
    expect(asking.indicator).toBe("waiting-for-input");

    const failed = liveFamily({ status: "error" });
    expect(stateOf(root(foldNativeMembers(failed.threads, [failed.conversation])))).toBe("needs");

    // Idle: the errored mirror does not hold the row, but the label moves to the active member.
    const idle = liveFamily();
    const quiet = root(foldNativeMembers(idle.threads, [idle.conversation]));
    expect(quiet.status).toBe("idle");
    expect(quiet.providerId).toBe("claude-code");
    expect(stateOf(quiet)).toBe("unread");
  });

  it("ignores live members that are visible, archived or in another project", () => {
    for (const opus of [{ isHidden: false }, { isArchived: true }, { projectId: "proj_other" }]) {
      const f = liveFamily({ status: "active", ...opus });
      expect(stateOf(root(foldNativeMembers(f.threads, [f.conversation])))).not.toBe("running");
    }
  });

  it("labels the root row with the active hidden member's model, not the root session's", () => {
    const f = liveFamily({ status: "active" });
    const exec = nativeLogicalExec(f.threads, [f.conversation]);
    expect(exec.get("thr_root")).toEqual({ model: "claude-opus-5-5", reasoningLevel: "high" });
    expect(exec.has("thr_other")).toBe(false);
    expect(nativeLogicalExec(f.threads, [{ ...f.conversation, activeThreadId: "thr_root" }]).size).toBe(0);
    expect(nativeLogicalExec(f.threads, [{ ...f.conversation, members: [] }]).size).toBe(0);
    expect(nativeLogicalExec(f.threads, []).size).toBe(0);
  });
});

describe("openableHere", () => {
  const { threads, conversation: grouped } = liveFamily();
  it("opens a visible chat as itself and a hidden member through its visible root", () => {
    expect(openableHere("thr_other", threads, [grouped])).toBe("thr_other");
    expect(openableHere("thr_root", threads, [grouped])).toBe("thr_root");
    expect(openableHere("thr_opus", threads, [grouped])).toBe("thr_root");
  });
  it("has nothing to open for a chat this window does not know, or whose root is not shown", () => {
    expect(openableHere("thr_elsewhere", threads, [grouped])).toBeUndefined();
    expect(openableHere("thr_opus", [thread("thr_root", { isArchived: true })], [grouped])).toBeUndefined();
  });
});

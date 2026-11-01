import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server-m1", () => ({ handOff: vi.fn(), transcript: vi.fn(async () => "conversation") }));

import { handOff } from "../server-m1";
import { carriedNote, createTeleport, pushWip, resumeMessage } from "../server-teleport";

const dirs: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teleport-wip-"));
  dirs.push(root);
  const origin = path.join(root, "origin.git");
  const local = path.join(root, "local");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, local);
  fs.writeFileSync(path.join(local, "README.md"), "base\n");
  git(local, "add", "README.md");
  git(local, "commit", "-q", "-m", "base");
  git(local, "push", "-q", "origin", "main");
  return { origin, local, base: git(local, "rev-parse", "HEAD") };
}

function m1Push(origin: string, root: string, ref: string) {
  const m1 = path.join(root, "m1");
  git(root, "clone", "-q", origin, m1);
  git(m1, "checkout", "-q", "-b", "m1-work", `origin/${ref}`);
  fs.writeFileSync(path.join(m1, "m1.txt"), "from the m1\n");
  git(m1, "add", "m1.txt");
  git(m1, "commit", "-q", "-m", "Studio work");
  git(m1, "push", "-q", "origin", `HEAD:refs/heads/${ref}`);
  return git(m1, "rev-parse", "HEAD");
}

describe("teleport WIP carry", () => {
  it("publishes the dirty tree as teleport/<thread> at the reported SHA without moving the local branch", async () => {
    const { origin, local, base } = repo();
    fs.appendFileSync(path.join(local, "README.md"), "dirty\n");
    fs.writeFileSync(path.join(local, "new.txt"), "untracked\n");
    const { sha, ref } = await pushWip(local, "thr_abc");
    expect(ref).toBe("teleport/thr_abc");
    expect(git(origin, "rev-parse", `refs/heads/${ref}`)).toBe(sha);
    expect(git(origin, "show", `${sha}:new.txt`)).toBe("untracked");
    expect(git(local, "rev-parse", "HEAD")).toBe(base);
    expect(git(local, "status", "--porcelain")).toContain("new.txt");
    expect(carriedNote(sha, ref, "main")).toContain(sha);
  });

  it("can be retried after a move failed past the push", async () => {
    const { origin, local } = repo();
    fs.appendFileSync(path.join(local, "README.md"), "dirty\n");
    const first = await pushWip(local, "thr_retry");
    fs.appendFileSync(path.join(local, "README.md"), "more\n");
    const second = await pushWip(local, "thr_retry");
    expect(second.sha).not.toBe(first.sha);
    expect(git(origin, "rev-parse", "refs/heads/teleport/thr_retry")).toBe(second.sha);
  });
});

describe("teleport never overwrites work Studio sent back", () => {
  it("keeps Studio's commit on origin when a second carried move would replace it", async () => {
    const { origin, local } = repo();
    fs.appendFileSync(path.join(local, "README.md"), "dirty\n");
    const first = await pushWip(local, "thr_round");
    const m1Sha = m1Push(origin, path.dirname(local), first.ref);
    fs.appendFileSync(path.join(local, "README.md"), "more\n");
    await expect(pushWip(local, "thr_round")).rejects.toThrow(/fetch and merge/i);
    expect(git(origin, "rev-parse", "refs/heads/teleport/thr_round")).toBe(m1Sha);
    expect(git(origin, "show", `${m1Sha}:m1.txt`)).toBe("from the m1");
  });

  it("publishes a fresh ref when none exists yet", async () => {
    const { origin, local } = repo();
    fs.appendFileSync(path.join(local, "README.md"), "dirty\n");
    const { sha } = await pushWip(local, "thr_new");
    expect(git(origin, "rev-parse", "refs/heads/teleport/thr_new")).toBe(sha);
  });

  it("allows a fast-forward when the laptop has merged Studio's work", async () => {
    const { origin, local } = repo();
    fs.appendFileSync(path.join(local, "README.md"), "dirty\n");
    const first = await pushWip(local, "thr_merge");
    const m1Sha = m1Push(origin, path.dirname(local), first.ref);
    git(local, "fetch", "-q", "origin", first.ref);
    git(local, "checkout", "--", "README.md");
    git(local, "merge", "-q", "--ff-only", m1Sha);
    fs.appendFileSync(path.join(local, "README.md"), "after merge\n");
    const second = await pushWip(local, "thr_merge");
    expect(git(origin, "rev-parse", "refs/heads/teleport/thr_merge")).toBe(second.sha);
    git(origin, "merge-base", "--is-ancestor", m1Sha, second.sha);
  });
});

describe("teleport move reports where it failed", () => {
  function setup(opts: { local?: string; spawnedThread?: string; archiveFails?: boolean }) {
    const calls = { archive: vi.fn(async () => { if (opts.archiveFails) throw new Error("archive refused"); }), stop: vi.fn(async () => undefined) };
    const bb = {
      sdk: {
        threads: {
          get: async () => ({
            thread: { id: "thr_x", projectId: "p", providerId: "claude", title: "Chat", status: "idle" },
            environment: opts.local ? { id: "e", hostId: "h", path: opts.local, isGitRepo: true, isWorktree: false, branchName: "main" } : null,
          }),
          stop: calls.stop,
          archive: calls.archive,
          updatePluginMetadata: async () => undefined,
        },
      },
      log: { info: () => undefined },
      realtime: { publish: () => undefined },
    };
    const machines = { forProject: async () => ({ hostId: null, connected: false, sourcePath: null }) };
    return { teleport: createTeleport(bb as never, machines as never), calls };
  }

  it("says no Studio chat was confirmed when the handoff fails, and leaves the chat unarchived", async () => {
    vi.mocked(handOff).mockRejectedValueOnce(new Error("m1 send timed out"));
    const { teleport, calls } = setup({});
    const error = await teleport.move({ threadId: "thr_x" }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toContain("starting Studio chat");
    expect(failure.message).toContain("m1 send timed out");
    expect(failure.message).toMatch(/check Studio before moving again/i);
    expect((failure.cause as Error).message).toBe("m1 send timed out");
    expect(calls.archive).not.toHaveBeenCalled();
  });

  it("points at the started Studio chat when archiving this chat fails", async () => {
    vi.mocked(handOff).mockResolvedValueOnce({ m1Thread: "thr_m1", url: "", notes: [] });
    const { teleport } = setup({ archiveFails: true });
    const failure = (await teleport.move({ threadId: "thr_x" }).catch((e: Error) => e)) as Error;
    expect(failure.message).toContain("linking and archiving this chat");
    expect(failure.message).toContain("thr_m1");
    expect(failure.message).toContain("do not move again");
  });

  it("reports a refused push with the resume advice instead of a raw git error", async () => {
    const { origin, local } = repo();
    fs.appendFileSync(path.join(local, "README.md"), "dirty\n");
    const first = await pushWip(local, "thr_x");
    m1Push(origin, path.dirname(local), first.ref);
    fs.appendFileSync(path.join(local, "README.md"), "more\n");
    const { teleport, calls } = setup({ local });
    const failure = (await teleport.move({ threadId: "thr_x", dirty: "carry" }).catch((e: Error) => e)) as Error;
    expect(failure.message).toContain("pushing to origin");
    expect(failure.message).toContain("Nothing was pushed.");
    expect(failure.message).toMatch(/fetch and merge/i);
    expect(calls.archive).not.toHaveBeenCalled();
    expect(vi.mocked(handOff)).not.toHaveBeenCalled();
  });
});

describe("teleport failure after the push", () => {
  const pushed = { ref: "teleport/thr_abc", sha: "59b6272aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", carried: true };

  it("names what was pushed and how to retry when Studio start failed", () => {
    const message = resumeMessage(new Error("HTTP 409"), pushed, "thr_abc", "starting Studio chat");
    expect(message).toContain("HTTP 409");
    expect(message).toContain(pushed.sha);
    expect(message).toContain("teleport/thr_abc");
    expect(message).toContain("not archived");
    expect(message).toContain('run the move again with "carry"');
    expect(message).toMatch(/check Studio before moving again/i);
  });

  it("does not end a sentence twice when the cause already ends in a full stop", () => {
    expect(resumeMessage(new Error("ssh: refused."), null, "thr_abc", "starting Studio chat")).not.toContain("..");
  });

  it("points at the started Studio chat instead of a second move when archiving failed", () => {
    const message = resumeMessage("boom", pushed, "thr_abc", "linking and archiving this chat", "thr_m1");
    expect(message).toContain("thr_m1");
    expect(message).toContain("do not move again");
    expect(message).not.toContain("run the move again");
  });

  it("says nothing was pushed when the failure came before any push", () => {
    expect(resumeMessage(new Error("x"), null, "thr_abc", "starting Studio chat")).toContain("Nothing was pushed.");
  });
});

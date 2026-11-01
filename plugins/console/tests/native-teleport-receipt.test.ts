import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server-m1", () => ({ handOff: vi.fn(async () => ({ m1Thread: "thr_m1", url: "", notes: [] })), transcript: vi.fn(async () => "conversation") }));

import { createTeleport, teleportMoveOutput, verifyDestination } from "../server-teleport";

const dirs: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teleport-receipt-"));
  dirs.push(root);
  const origin = path.join(root, "origin.git");
  const local = path.join(root, "local");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, local);
  fs.writeFileSync(path.join(local, "README.md"), "base\n");
  git(local, "add", "README.md");
  git(local, "commit", "-q", "-m", "base");
  git(local, "push", "-q", "origin", "main");
  return { origin, local };
}

function setup(local: string, options: { connected?: boolean; remoteSha?: (command: string, ref: string) => string; remoteFails?: boolean } = {}) {
  const spawn = vi.fn(async () => ({ id: "thr_m1_chat" }));
  const archive = vi.fn(async () => undefined);
  const metadata: Record<string, unknown> = {};
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ thread: { id: "thr_x", projectId: "p", providerId: "claude", title: "Chat", status: "idle" }, environment: { id: "e", hostId: "h_local", path: local, isGitRepo: true, isWorktree: false, branchName: "main" } }),
        stop: async () => undefined, archive, spawn,
        updatePluginMetadata: async (args: { threadId: string; set: Record<string, unknown> }) => { Object.assign(metadata, args.set); },
        getPluginMetadata: async () => metadata,
      },
    },
    log: { info: () => undefined }, realtime: { publish: () => undefined },
  };
  const machines = {
    forProject: async () => ({ hostId: "h_m1", connected: options.connected ?? true, sourcePath: "/Users/studio/Documents/GitHub/repo", localHostId: "h_local", localPath: local }),
    m1Host: async () => ({ id: "h_other" }),
  };
  const commands: string[] = [];
  const ssh = vi.fn(async (command: string) => {
    commands.push(command);
    if (options.remoteFails && /rev-parse/.test(command)) throw new Error("ssh: connect to host m1 port 22: Operation timed out");
    if (/rev-parse/.test(command)) return `${options.remoteSha ? options.remoteSha(command, "") : "FETCHED"}\n`;
    return "";
  });
  return { teleport: createTeleport(bb as never, machines as never, { ssh }), spawn, archive, ssh, commands, metadata };
}

describe("the commit a teleport reports", () => {
  it("returns the WIP commit that was carried, the ref it was published on and a verified Studio copy", async () => {
    const { local, origin } = repo();
    fs.appendFileSync(path.join(local, "README.md"), "dirty\n");
    const f = setup(local);
    f.ssh.mockImplementation(async (command: string) => { f.commands.push(command); return /rev-parse/.test(command) ? `${git(origin, "rev-parse", "refs/heads/teleport/thr_x")}\n` : ""; });
    const out = await f.teleport.move({ threadId: "thr_x", dirty: "carry" });
    const sha = git(origin, "rev-parse", "refs/heads/teleport/thr_x");
    expect(out.commit).toEqual({ sha, ref: "teleport/thr_x", carried: true });
    expect(out.notes.join("\n")).not.toMatch(/stayed on this laptop/);
    expect(out.verified).toEqual({ machine: "Studio", ok: true, sha, message: `Studio's clone has ${sha.slice(0, 7)} on teleport/thr_x.` });
    expect(teleportMoveOutput.safeParse(out).success).toBe(true);
    expect(f.commands.some((command) => command.includes("fetch origin"))).toBe(true);
    expect(f.commands.at(-1)).toContain("rev-parse");
    expect(f.metadata.teleport).toMatchObject({ sha, verified: true });
  });

  it("reports the pushed branch head for a clean move", async () => {
    const { local, origin } = repo();
    const f = setup(local);
    const head = git(local, "rev-parse", "HEAD");
    f.ssh.mockImplementation(async (command: string) => /rev-parse/.test(command) ? `${head}\n` : "");
    const out = await f.teleport.move({ threadId: "thr_x" });
    expect(out.commit).toEqual({ sha: head, ref: "main", carried: false });
    expect(out.verified).toMatchObject({ ok: true, sha: head });
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
  });

  it("refuses to start from a clone that holds a different commit and leaves the chat unarchived", async () => {
    const { local } = repo();
    const f = setup(local, { remoteSha: () => "1".repeat(40) });
    const failure = (await f.teleport.move({ threadId: "thr_x" }).catch((e: Error) => e)) as Error;
    expect(failure.message).toContain("starting Studio chat");
    expect(failure.message).toContain("1111111");
    expect(failure.message).toMatch(/not the commit that was pushed/i);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.archive).not.toHaveBeenCalled();
  });

  it("states that the copy could not be checked when Studio does not answer, and stops", async () => {
    const { local } = repo();
    const f = setup(local, { remoteFails: true });
    const failure = (await f.teleport.move({ threadId: "thr_x" }).catch((e: Error) => e)) as Error;
    expect(failure.message).toMatch(/could not check/i);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("says the clone was not checked when the chat goes to Studio's own bb", async () => {
    const { local } = repo();
    const f = setup(local, { connected: false });
    const out = await f.teleport.move({ threadId: "thr_x" });
    expect(out.via).toBe("handoff");
    expect(out.verified).toBeNull();
    expect(out.commit).toMatchObject({ ref: "main", carried: false });
    expect(f.ssh).not.toHaveBeenCalled();
  });
});

describe("verifying the destination clone", () => {
  it("compares the fetched ref with the pushed commit", async () => {
    const sha = "a".repeat(40);
    expect(await verifyDestination(async () => `${sha}\n`, "/repo", "teleport/t", sha)).toMatchObject({ ok: true, sha });
    expect(await verifyDestination(async () => `${"b".repeat(40)}\n`, "/repo", "teleport/t", sha)).toMatchObject({ ok: false, sha: "b".repeat(40) });
  });
});

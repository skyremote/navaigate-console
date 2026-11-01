import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server-m1", () => ({ handOff: vi.fn(async () => ({ m1Thread: "thr_m1", url: "", notes: [] })), transcript: vi.fn(async () => "conversation") }));

import { CLONE_TIMEOUT_MS, createMachines, isCloneableRemote, redactRemote } from "../server-machines";
import { createTeleport } from "../server-teleport";

const dirs: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** A fake bb whose Studio host starts with no checkout; a clone or local_path add gives it one. */
function fakeBb(opts: { localPath: string; remote?: string | null; m1Has?: boolean; connected?: boolean; cloneFails?: string; exists?: Record<string, boolean> }) {
  const sources: Array<{ id: string; hostId: string; path: string; isDefault: boolean }> = [{ id: "s_local", hostId: "h_local", path: opts.localPath, isDefault: true }];
  const add = vi.fn(async (args: { type: string; hostId: string; path?: string; targetPath?: string }) => {
    if (opts.cloneFails && args.type === "clone") throw new Error(opts.cloneFails);
    const p = (args.type === "clone" ? args.targetPath : args.path) as string;
    sources.push({ id: `s_${sources.length}`, hostId: args.hostId, path: p, isDefault: false });
    return sources.at(-1);
  });
  const pathsExist = vi.fn(async (a: { paths: string[] }) => ({ existence: Object.fromEntries(a.paths.map((p) => [p, opts.exists?.[p] ?? !!opts.m1Has])) }));
  const bb = {
    sdk: {
      hosts: { list: async () => [{ id: "h_m1", name: "Studio", status: opts.connected === false ? "disconnected" : "connected", type: "persistent", machineProviderId: null }], pathsExist },
      projects: { get: async () => ({ gitRemoteUrl: opts.remote === undefined ? "git@github.com:me/repo.git" : opts.remote, sources: [...sources] }), sources: { add } },
    },
    log: { info: () => undefined },
  };
  return { bb, add, pathsExist, sources };
}

describe("cloning a project onto Studio", () => {
  it("offers the remote it would clone from, and nothing when the folder is shared", async () => {
    const f = fakeBb({ localPath: "/Users/sam/Documents/GitHub/repo" });
    const m = await createMachines(f.bb as never).forProject("p");
    expect(m).toMatchObject({ sourcePath: null, suggestedPath: "/Users/studio/Documents/GitHub/repo", cloneFrom: "git@github.com:me/repo.git" });
    const shared = await createMachines(fakeBb({ localPath: "/Users/sam/Shared/proj" }).bb as never).forProject("p");
    expect(shared.cloneFrom).toBeNull();
  });

  it("clones the project's remote to the matching path on Studio and registers it", async () => {
    const f = fakeBb({ localPath: "/Users/sam/Documents/GitHub/repo" });
    const out = await createMachines(f.bb as never).link("p");
    expect(f.add).toHaveBeenCalledWith({ projectId: "p", type: "clone", hostId: "h_m1", remoteUrl: "git@github.com:me/repo.git", targetPath: "/Users/studio/Documents/GitHub/repo" });
    expect(out).toMatchObject({ sourcePath: "/Users/studio/Documents/GitHub/repo", cloned: true });
  });

  it("registers a folder that is already on Studio without cloning", async () => {
    const f = fakeBb({ localPath: "/Users/sam/Documents/GitHub/repo", m1Has: true });
    const out = await createMachines(f.bb as never).link("p");
    expect(f.add).toHaveBeenCalledWith({ projectId: "p", type: "local_path", hostId: "h_m1", path: "/Users/studio/Documents/GitHub/repo" });
    expect(out.cloned).toBeUndefined();
  });

  it("falls back to the laptop checkout's origin when bb records no remote", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "m1-clone-"));
    dirs.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "remote", "add", "origin", "https://example.com/me/repo.git");
    const f = fakeBb({ localPath: root, remote: null });
    const bbm = createMachines(f.bb as never);
    await bbm.link("p");
    expect(f.add.mock.calls[0]?.[0]).toMatchObject({ type: "clone", remoteUrl: "https://example.com/me/repo.git" });
  });

  it("says so when there is no remote to clone from", async () => {
    const f = fakeBb({ localPath: "/Users/sam/Documents/GitHub/repo", remote: null });
    await expect(createMachines(f.bb as never).link("p")).rejects.toThrow(/no git remote/);
    expect(f.add).not.toHaveBeenCalled();
  });

  it("never clones onto the NAS share and names the failed clone", async () => {
    const shared = fakeBb({ localPath: "/Users/sam/Shared/proj" });
    await expect(createMachines(shared.bb as never).link("p")).rejects.toThrow(/not on Studio/);
    expect(shared.add).not.toHaveBeenCalled();
    const failing = fakeBb({ localPath: "/Users/sam/Documents/GitHub/repo", cloneFails: "Permission denied (publickey)" });
    await expect(createMachines(failing.bb as never).link("p")).rejects.toThrow(/Could not clone git@github.com:me\/repo.git onto Studio.*publickey/);
  });

  it("refuses when Studio is not connected, and does not clone with clone switched off", async () => {
    const off = fakeBb({ localPath: "/Users/sam/Documents/GitHub/repo", connected: false });
    await expect(createMachines(off.bb as never).link("p")).rejects.toThrow(/not connected/);
    const f = fakeBb({ localPath: "/Users/sam/Documents/GitHub/repo" });
    await expect(createMachines(f.bb as never).link("p", { clone: false })).rejects.toThrow(/not on Studio/);
    expect(f.add).not.toHaveBeenCalled();
  });
});

describe("cloning waits as long as bb does, once, and with clean remotes", () => {
  const LOCAL = "/Users/sam/Documents/GitHub/repo";

  it("waits 20 minutes, as long as bb on Studio clones", () => {
    expect(CLONE_TIMEOUT_MS).toBe(1200 * 1000);
  });

  it("refuses to register or start a second clone to the same folder while the first is still in flight", async () => {
    const f = fakeBb({ localPath: LOCAL });
    let finish!: () => void;
    f.add.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { f.sources.push({ id: "s_late", hostId: "h_m1", path: "/Users/studio/Documents/GitHub/repo", isDefault: false }); resolve(undefined as never); }; }));
    const machines = createMachines(f.bb as never);
    const first = machines.link("p");
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledTimes(1));
    await expect(machines.link("p")).rejects.toThrow(/still running on Studio/);
    expect(f.add).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toMatchObject({ cloned: true });
  });

  it("does not register the half-cloned folder git has already created when a second link arrives mid-clone", async () => {
    const f = fakeBb({ localPath: LOCAL });
    let finish!: () => void;
    f.add.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { f.sources.push({ id: "s_late", hostId: "h_m1", path: "/Users/studio/Documents/GitHub/repo", isDefault: false }); resolve(undefined as never); }; }));
    // Git creates the target at once: the folder exists on Studio as soon as the clone has started.
    f.pathsExist.mockImplementation(async (a: { paths: string[] }) => ({ existence: Object.fromEntries(a.paths.map((p) => [p, f.add.mock.calls.length > 0])) }));
    const machines = createMachines(f.bb as never);
    const first = machines.link("p");
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledTimes(1));
    f.pathsExist.mockClear();
    await expect(machines.link("p")).rejects.toThrow(/still running on Studio/);
    expect(f.pathsExist).not.toHaveBeenCalled();
    expect(f.add).toHaveBeenCalledTimes(1); // no local_path registration either
    expect((await machines.forProject("p")).cloneFrom).toBeNull();
    finish();
    await first;
  });

  it("starts only one clone when two link() calls arrive at once (a double-click)", async () => {
    const f = fakeBb({ localPath: LOCAL });
    let finish!: () => void;
    f.add.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { f.sources.push({ id: "s_late", hostId: "h_m1", path: "/Users/studio/Documents/GitHub/repo", isDefault: false }); resolve(undefined as never); }; }));
    const machines = createMachines(f.bb as never);
    const both = Promise.allSettled([machines.link("p"), machines.link("p")]);
    await vi.waitFor(() => expect(f.add).toHaveBeenCalledTimes(1));
    finish();
    const [a, b] = await both;
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const lost = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(String(lost.reason)).toMatch(/still running on Studio/);
    expect(f.add).toHaveBeenCalledTimes(1);
  });

  it("allows another attempt once a clone has failed", async () => {
    const f = fakeBb({ localPath: LOCAL, cloneFails: "network down" });
    const machines = createMachines(f.bb as never);
    await expect(machines.link("p")).rejects.toThrow(/network down/);
    await expect(machines.link("p")).rejects.toThrow(/network down/);
    expect(f.add).toHaveBeenCalledTimes(2);
  });

  it("keeps the user and password out of the chip, the error and the log, but clones with the remote as saved", async () => {
    const secret = "https://sam:ghp_SECRET@github.com/me/repo.git";
    const f = fakeBb({ localPath: LOCAL, remote: secret, cloneFails: `fatal: unable to access '${secret}': 403` });
    const logs: string[] = [];
    (f.bb as { log: { info: (m: string) => void } }).log.info = (m) => logs.push(m);
    const machines = createMachines(f.bb as never);
    expect((await machines.forProject("p")).cloneFrom).toBe("https://github.com/me/repo.git");
    const failure = (await machines.link("p").catch((e: Error) => e)) as Error;
    expect(failure.message).not.toMatch(/ghp_SECRET|sam:/);
    expect(failure.message).toContain("https://github.com/me/repo.git");
    expect(f.add.mock.calls[0]?.[0]).toMatchObject({ remoteUrl: secret });
    const ok = fakeBb({ localPath: LOCAL, remote: secret });
    (ok.bb as { log: { info: (m: string) => void } }).log.info = (m) => logs.push(m);
    await createMachines(ok.bb as never).link("p");
    expect(logs.join("\n")).not.toMatch(/ghp_SECRET/);
  });

  it("clones only https://, ssh:// and git@ remotes", async () => {
    expect(["https://h/x.git", "ssh://git@h/x.git", "git@h:x.git"].every(isCloneableRemote)).toBe(true);
    expect(["--upload-pack=touch /tmp/x", "-oProxyCommand=x", "file:///etc", "http://h/x", "/local/path", "ext::sh -c x"].some(isCloneableRemote)).toBe(false);
    const f = fakeBb({ localPath: LOCAL, remote: "--upload-pack=touch /tmp/pwned" });
    const machines = createMachines(f.bb as never);
    expect((await machines.forProject("p")).cloneFrom).toBeNull();
    await expect(machines.link("p")).rejects.toThrow(/only https/);
    expect(f.add).not.toHaveBeenCalled();
  });

  it("redacts a password that holds an unencoded @ or /, and keeps no cause that carries it", async () => {
    expect(redactRemote("https://u:p@ss/w@rd@github.com/me/x.git")).toBe("https://github.com/me/x.git");
    expect(redactRemote("fatal: unable to access 'https://u:pa/ss@github.com/me/x.git': 403")).toBe("fatal: unable to access 'https://github.com/me/x.git': 403");
    const secret = "https://sam:ghp_SE/CRET@github.com/me/repo.git";
    const f = fakeBb({ localPath: LOCAL, remote: secret, cloneFails: `bad ${secret}` });
    const failure = (await createMachines(f.bb as never).link("p").catch((e: Error) => e)) as Error;
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify([failure.message, failure.stack])).not.toMatch(/ghp_SE|CRET/);
  });

  it("redacts URL credentials and leaves git@ remotes alone", () => {
    expect(redactRemote("https://u:p@h/x.git")).toBe("https://h/x.git");
    expect(redactRemote("ssh://git@h/x.git")).toBe("ssh://h/x.git");
    expect(redactRemote("git@github.com:me/x.git")).toBe("git@github.com:me/x.git");
  });
});

describe("teleport clones first when Studio has no checkout", () => {
  function repo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "m1-clone-tp-"));
    dirs.push(root);
    const origin = path.join(root, "origin.git");
    const local = path.join(root, "local");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, local);
    fs.writeFileSync(path.join(local, "README.md"), "base\n");
    git(local, "add", "README.md");
    git(local, "commit", "-q", "-m", "base");
    git(local, "push", "-q", "origin", "main");
    return { local };
  }
  function setup(local: string, link: () => Promise<unknown>) {
    const spawn = vi.fn(async () => ({ id: "thr_m1_chat" }));
    const bb = {
      sdk: {
        threads: {
          get: async () => ({ thread: { id: "thr_x", projectId: "p", providerId: "claude", title: "Chat", status: "idle" }, environment: { id: "e", hostId: "h_local", path: local, isGitRepo: true, isWorktree: false, branchName: "main" } }),
          stop: async () => undefined, archive: async () => undefined, spawn,
          updatePluginMetadata: async () => undefined, getPluginMetadata: async () => ({}),
        },
      },
      log: { info: () => undefined }, realtime: { publish: () => undefined },
    };
    const bare = { hostId: "h_m1", connected: true, sourcePath: null, suggestedPath: "/Users/studio/Documents/GitHub/repo", localHostId: "h_local", localPath: local };
    const machines = { forProject: async () => bare, m1Host: async () => ({ id: "h_other" }), link: vi.fn(link) };
    const ssh = vi.fn(async (command: string) => (/rev-parse/.test(command) ? `${git(local, "rev-parse", "HEAD")}\n` : ""));
    return { teleport: createTeleport(bb as never, machines as never, { ssh }), spawn, machines, ssh };
  }

  it("clones the repo, then starts the chat on Studio machine", async () => {
    const { local } = repo();
    const f = setup(local, async () => ({ hostId: "h_m1", connected: true, sourcePath: "/Users/studio/Documents/GitHub/repo", cloned: true }));
    const out = await f.teleport.move({ threadId: "thr_x" });
    expect(f.machines.link).toHaveBeenCalledWith("p");
    expect(out.via).toBe("machine");
    expect(out.notes.join("\n")).toContain("Cloned the project onto Studio at /Users/studio/Documents/GitHub/repo");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(out.verified).toMatchObject({ ok: true });
  });

  it("falls back to Studio's own bb and says why when the clone fails", async () => {
    const { local } = repo();
    const f = setup(local, async () => { throw new Error("Could not clone x: Permission denied (publickey)"); });
    const out = await f.teleport.move({ threadId: "thr_x" });
    expect(out.via).toBe("handoff");
    expect(out.notes.join("\n")).toMatch(/Could not set the project up on Studio: .*publickey/);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createOwnerProject, type OwnerProjectOptions } from "./project";
import { ownerProjectContract, TRANSFER_FILE_BYTES, type ProjectOwnerTarget } from "./project-contract";

const execute = promisify(execFile);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const COMMIT = "1".repeat(40);
const REMOTE = "https://example.com/fixture/repository.git";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function repository(root: string, remote = REMOTE) {
  await mkdir(root, { recursive: true });
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "config", "remote.origin.url", remote]);
}
function file(relative: string, value: string | Uint8Array = "explicit ignored fixture\n") {
  const bytes = Buffer.from(value);
  return { path: relative, sizeBytes: bytes.length, sha256: sha(bytes), contentBase64: bytes.toString("base64") };
}
async function fixture(machineKey: "studio" | "laptop" = "laptop") {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "owner-project-test-")));
  const root = path.join(temporary, "checkout");
  await repository(root);
  const dbPath = path.join(temporary, "receipts.db");
  let db = new Database(dbPath);
  const target: ProjectOwnerTarget = { serverId: `owner-${machineKey}`, machineKey, hostId: `host_${machineKey}`, projectId: "proj_fixture", environmentId: "env_fixture" };
  let identity = { serverId: target.serverId, machineKey, hostId: target.hostId as string | null };
  let environment = { id: target.environmentId, hostId: target.hostId, projectId: target.projectId, status: "ready", path: root };
  const project = { id: target.projectId, name: "Fixture", gitRemoteUrl: REMOTE, sources: [] as { id: string; projectId: string; hostId: string; path: string; type: "local_path" }[] };
  let writeLost = false;
  let failWriteNumber = 0;
  let sourceLost = false;
  let casConflict = false;
  let currentBranch = "fixture";
  let dirty = false;
  const writes: unknown[] = [];
  const sources: unknown[] = [];
  const creations: unknown[] = [];
  const gitReads: unknown[] = [];
  const callOwner = vi.fn<OwnerProjectOptions["callOwner"]>(async () => ({ ok: false, kind: "unavailable", message: "no-authenticated-owner-route" }));
  const bb = {
    storage: { database: () => db },
    sdk: {
      hosts: {
        get: async ({ hostId }: { hostId: string }) => ({ id: hostId, status: "connected" }),
        directory: async ({ path: full }: { path: string }) => ({ directory: await realpath(full) }),
      },
      environments: { get: async () => environment },
      projects: {
        get: async () => project,
        create: async (input: unknown) => { creations.push(input); return { ...project, id: "proj_new", sources: [{ id: "source_new", projectId: "proj_new", hostId: target.hostId, type: "local_path", path: root }] }; },
        sources: { add: async (input: { projectId: string; hostId: string; type: string; targetPath?: string; remoteUrl?: string; path?: string }) => {
          sources.push(input);
          if (input.type === "clone") await repository(input.targetPath!, input.remoteUrl!);
          const source = { id: "source_added", projectId: input.projectId, hostId: input.hostId, type: "local_path" as const, path: input.targetPath ?? input.path! };
          project.sources.push(source);
          if (sourceLost) throw new Error("Synthetic reply lost after source creation");
          return source;
        } },
      },
      plugins: { callRpc: async (input: unknown) => {
        gitReads.push(input);
        return { outcome: "available", workspace: { checkout: { kind: "branch", branchName: currentBranch, headSha: COMMIT }, branch: { currentBranch, defaultBranch: "main" }, workingTree: { hasUncommittedChanges: dirty } } };
      } },
      files: {
        write: async (input: { path: string; rootPath: string; content: string; expectedSha256: string | null }) => {
          writes.push(input);
          if (casConflict) return { outcome: "conflict", currentSha256: null };
          if (failWriteNumber === writes.length) throw new Error("Synthetic host write interrupted");
          if (input.expectedSha256 !== null || !input.path.startsWith(input.rootPath + path.sep)) throw new Error("Fixture requires rooted create-only CAS");
          await mkdir(path.dirname(input.path), { recursive: true });
          await writeFile(input.path, Buffer.from(input.content, "base64"), { flag: "wx" });
          if (writeLost) throw new Error("Synthetic reply lost after writing selected bytes");
          return { outcome: "written", sha256: sha(Buffer.from(input.content, "base64")), sizeBytes: Buffer.from(input.content, "base64").length };
        },
        read: async ({ path: full }: { path: string }) => { const bytes = await readFile(full); return { content: bytes.toString("base64"), contentEncoding: "base64", sizeBytes: bytes.length, sha256: sha(bytes), mimeType: "application/octet-stream" }; },
      },
    },
  } as unknown as BbPluginApi;
  const options: OwnerProjectOptions = { identity: async () => identity, callOwner, restricted: (machineKey) => machineKey === "work" };
  let service = createOwnerProject(bb, options);
  cleanups.push(async () => { db.close(); await rm(temporary, { recursive: true, force: true }); });
  const transfer = (files = [file("ignored/selected.bin", new Uint8Array([0, 255, 128, 10]))]) => ({ target, requestId: randomUUID(), files });
  const clone = (destinationPath = path.join(temporary, "new-clone")) => ({ target: { ...target, environmentId: null }, requestId: randomUUID(), prepare: { mode: "clone_source" as const, destinationPath, remoteUrl: REMOTE } });
  return { bb, options, target, temporary, root, project, writes, sources, creations, gitReads, callOwner, transfer, clone,
    get service() { return service; },
    restart() { db.close(); db = new Database(dbPath); service = createOwnerProject(bb, options); },
    setWrongIdentity() { identity = { ...identity, hostId: "host_other" }; },
    setWrongEnvironment() { environment = { ...environment, projectId: "proj_other" }; },
    setCasConflict() { casConflict = true; },
    setWriteLost() { writeLost = true; }, setSourceLost() { sourceLost = true; }, failWrite(number: number) { failWriteNumber = number; },
    setGit(branch: string, changed: boolean) { currentBranch = branch; dirty = changed; },
  };
}

describe("exact owner repository verification", () => {
  it("uses actual SDK Git status and current owner origin, not the persisted project anchor", async () => {
    const f = await fixture();
    const verified = await f.service.handlers.project_verify({ target: f.target, expected: { remoteUrl: REMOTE, branch: "fixture", commit: COMMIT, dirty: false } });
    expect(verified).toMatchObject({ available: true, verified: true, repository: { rootPath: f.root, remoteUrl: REMOTE, commit: COMMIT, dirty: false } });
    expect(f.gitReads).toHaveLength(1);
    expect(f.gitReads[0]).toMatchObject({ pluginId: "bb--git", method: "workspaceStatus", input: { environmentId: f.target.environmentId } });
    await execute("git", ["-C", f.root, "config", "remote.origin.url", "git@example.com:other/current.git"]);
    f.setGit("changed", true);
    const changed = await f.service.handlers.project_verify({ target: f.target, expected: { remoteUrl: REMOTE, branch: "fixture", dirty: false } });
    expect(changed).toMatchObject({ available: true, verified: false, mismatches: ["remoteUrl", "branch", "dirty"], repository: { remoteUrl: "git@example.com:other/current.git" } });
  });
  it("refuses mismatched authenticated host, project or environment and credential origins", async () => {
    const f = await fixture(); f.setWrongIdentity();
    expect(await f.service.handlers.project_verify({ target: f.target, expected: {} })).toMatchObject({ available: false, verified: false });
    expect(f.gitReads).toHaveLength(0);
    const g = await fixture(); g.setWrongEnvironment();
    expect(await g.service.handlers.project_verify({ target: g.target, expected: {} })).toMatchObject({ available: false });
    const h = await fixture(); await execute("git", ["-C", h.root, "config", "remote.origin.url", "https://name:fixture-secret@example.com/repo.git"]);
    const result = await h.service.handlers.project_verify({ target: h.target, expected: {} });
    expect(result).toMatchObject({ available: false }); expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
});

describe("native project preparation", () => {
  it("clones only through SDK source add and never overwrites existing or empty destinations", async () => {
    const f = await fixture(); const input = f.clone();
    expect(await f.service.handlers.project_prepare(input)).toMatchObject({ outcome: "applied", result: { environmentId: null, path: input.prepare.destinationPath } });
    expect(f.sources).toEqual([{ projectId: f.target.projectId, hostId: f.target.hostId, type: "clone", targetPath: input.prepare.destinationPath, remoteUrl: REMOTE }]);
    const g = await fixture(); await mkdir(g.clone().prepare.destinationPath); await writeFile(path.join(g.clone().prepare.destinationPath, "keep.txt"), "existing");
    expect(await g.service.handlers.project_prepare(g.clone())).toMatchObject({ outcome: "refused" }); expect(g.sources).toHaveLength(0);
    expect(await readFile(path.join(g.clone().prepare.destinationPath, "keep.txt"), "utf8")).toBe("existing");
    const h = await fixture(); await mkdir(h.clone().prepare.destinationPath);
    expect(await h.service.handlers.project_prepare(h.clone())).toMatchObject({ outcome: "refused" }); expect(h.sources).toHaveLength(0);
  });
  it("creates and registers existing checked native paths; refuses wrong remote and existing host source", async () => {
    const f = await fixture();
    const input = { target: { ...f.target, projectId: null, environmentId: null }, requestId: randomUUID(), prepare: { mode: "create_project" as const, name: "New native project", path: f.root, expectedRemoteUrl: REMOTE } };
    expect(await f.service.handlers.project_prepare(input)).toMatchObject({ outcome: "applied", result: { projectId: "proj_new", environmentId: null } });
    expect(f.creations).toEqual([{ name: "New native project", source: { type: "local_path", hostId: f.target.hostId, path: f.root } }]);
    const g = await fixture();
    expect(await g.service.handlers.project_prepare({ target: { ...g.target, environmentId: null }, requestId: randomUUID(), prepare: { mode: "register_checkout", path: g.root, expectedRemoteUrl: "https://example.com/wrong.git" } })).toMatchObject({ outcome: "refused" });
    expect(g.sources).toHaveLength(0);
    g.project.sources.push({ id: "already", projectId: g.target.projectId!, hostId: g.target.hostId, path: g.root, type: "local_path" });
    expect(await g.service.handlers.project_prepare(g.clone())).toMatchObject({ outcome: "refused" });
  });
  it("does not repeat a native clone after an unknown result across a real SQLite reopen", async () => {
    const f = await fixture(); f.setSourceLost(); const input = f.clone();
    expect(await f.service.handlers.project_prepare(input)).toMatchObject({ outcome: "unknown" }); f.restart();
    expect(await f.service.handlers.project_prepare(input)).toMatchObject({ outcome: "unknown" }); expect(f.sources).toHaveLength(1);
    expect(await f.service.handlers.project_prepare({ ...input, prepare: { ...input.prepare, destinationPath: path.join(f.temporary, "different") } })).toMatchObject({ outcome: "refused" }); expect(f.sources).toHaveLength(1);
  });
});

describe("explicit bounded selected-file transfer", () => {
  it("copies only selected binary bytes through native create-only CAS and verifies hashes", async () => {
    const f = await fixture(); const input = f.transfer();
    expect(await f.service.handlers.transfer_manifest_apply(input)).toMatchObject({ outcome: "applied", result: { count: 1, totalBytes: 4, files: [{ path: "ignored/selected.bin", sha256: input.files[0]!.sha256 }] } });
    expect(await readFile(path.join(f.root, "ignored/selected.bin"))).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(f.writes).toHaveLength(1); expect(f.writes[0]).toMatchObject({ hostId: f.target.hostId, rootPath: f.root, expectedSha256: null, mode: 0o600 });
  });
  it.each([".env", ".env.local", "nested/.ENV.production", ".ssh/id_rsa", "keys/public.pub", "credentials.json", "nested/api-key.json", "signing.pem", ".git/config"])("refuses protected selected path %s before writes", async (relative) => {
    const f = await fixture(); expect(await f.service.handlers.transfer_manifest_apply(f.transfer([file(relative)]))).toMatchObject({ outcome: "refused" }); expect(f.writes).toHaveLength(0);
  });
  it("preflights all files before writing: no overwrite, forged hash, private keys or symlinks", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "existing.txt"), "preserve");
    expect(await f.service.handlers.transfer_manifest_apply(f.transfer([file("valid.txt"), file("existing.txt")]))).toMatchObject({ outcome: "refused" }); expect(f.writes).toHaveLength(0);
    expect(await f.service.handlers.transfer_manifest_apply(f.transfer([{ ...file("forged.txt"), sha256: "0".repeat(64) }]))).toMatchObject({ outcome: "refused" });
    expect(await f.service.handlers.transfer_manifest_apply(f.transfer([file("ordinary.txt", ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + "\nfixture")]))).toMatchObject({ outcome: "refused" });
    await mkdir(path.join(f.root, "real")); await symlink(path.join(f.root, "real"), path.join(f.root, "inside"));
    expect(await f.service.handlers.transfer_manifest_apply(f.transfer([file("inside/alias.txt")]))).toMatchObject({ outcome: "refused" });
    await symlink(f.temporary, path.join(f.root, "outside"));
    expect(await f.service.handlers.transfer_manifest_apply(f.transfer([file("outside/escape.txt")]))).toMatchObject({ outcome: "refused" }); expect(f.writes).toHaveLength(0);
    expect(await readFile(path.join(f.root, "existing.txt"), "utf8")).toBe("preserve");
  });
  it("rejects traversal, duplicate/case aliases, prefix conflicts and byte caps at the schema boundary", async () => {
    const f = await fixture();
    for (const relative of ["../escape", "/absolute", "dir/../escape", "dir\\escape", "dir//empty", "C:/escape"]) expect(ownerProjectContract.transfer_manifest_apply.input.safeParse(f.transfer([file(relative)])).success).toBe(false);
    expect(ownerProjectContract.transfer_manifest_apply.input.safeParse(f.transfer([file("same"), file("SAME")])).success).toBe(false);
    expect(ownerProjectContract.transfer_manifest_apply.input.safeParse(f.transfer([file("file"), file("file/child")])).success).toBe(false);
    expect(ownerProjectContract.transfer_manifest_apply.input.safeParse(f.transfer([file("big", new Uint8Array(TRANSFER_FILE_BYTES + 1))])).success).toBe(false);
    expect(ownerProjectContract.transfer_manifest_apply.input.safeParse(f.transfer(Array.from({ length: 9 }, (_, i) => file(`file${i}`, new Uint8Array(TRANSFER_FILE_BYTES))))).success).toBe(false);
    expect(f.writes).toHaveLength(0);
  });
  it("does not label a native create-only CAS conflict applied", async () => {
    const f = await fixture(); f.setCasConflict(); const input = f.transfer();
    expect(await f.service.handlers.transfer_manifest_apply(input)).toMatchObject({ outcome: "unknown", message: expect.stringContaining("Native create-only") });
    f.restart(); expect(await f.service.handlers.transfer_manifest_apply(input)).toMatchObject({ outcome: "unknown" }); expect(f.writes).toHaveLength(1);
  });
  it("holds unknown file effects and immutable fingerprints across SQLite reopen without rerunning", async () => {
    const f = await fixture(); f.setWriteLost(); const input = f.transfer();
    const first = await f.service.handlers.transfer_manifest_apply(input); expect(first.outcome).toBe("unknown"); expect(f.writes).toHaveLength(1);
    f.restart(); expect(await f.service.handlers.transfer_manifest_apply(input)).toEqual(first); expect(f.writes).toHaveLength(1);
    expect(await f.service.handlers.transfer_receipt({ target: f.target, requestId: input.requestId })).toEqual(first);
    expect(await f.service.handlers.transfer_manifest_apply({ ...input, files: [file("another.txt")] })).toMatchObject({ outcome: "refused" }); expect(f.writes).toHaveLength(1);
    await expect(f.service.handlers.transfer_receipt({ target: { ...f.target, environmentId: "different" }, requestId: input.requestId })).rejects.toThrow("another owner target");
  });
  it("persists verified partial progress when the second effect becomes unknown", async () => {
    const f = await fixture(); f.failWrite(2); const input = f.transfer([file("first.txt"), file("second.txt")]);
    const first = await f.service.handlers.transfer_manifest_apply(input);
    expect(first).toMatchObject({ outcome: "unknown", result: { count: 1, files: [{ path: "first.txt" }] } }); f.restart();
    expect(await f.service.handlers.transfer_manifest_apply(input)).toEqual(first); expect(f.writes).toHaveLength(2); expect((await lstat(path.join(f.root, "first.txt"))).isFile()).toBe(true);
  });
});

describe("finite owner forwarding and durable source receipts", () => {
  it("reconciles a lost remote reply read-only after reload, without resending the manifest", async () => {
    const source = await fixture(); const destination = await fixture("studio");
    const input = destination.transfer(); let mutations = 0;
    source.callOwner.mockImplementation(async (target, method, raw, mutation) => {
      expect(target).toEqual({ serverId: destination.target.serverId, machineKey: "studio", hostId: destination.target.hostId });
      const result = await (destination.service.handlers[method] as (input: unknown) => Promise<unknown>)(raw);
      if (mutation) { mutations++; throw new Error("Transport reply lost after owner execution"); }
      return { ok: true, result };
    });
    expect(await source.service.handlers.transfer_manifest_apply(input)).toMatchObject({ outcome: "unknown" }); source.restart();
    expect(await source.service.handlers.transfer_manifest_apply(input)).toMatchObject({ outcome: "unknown" }); expect(mutations).toBe(1); expect(destination.writes).toHaveLength(1);
    expect(await source.service.handlers.transfer_receipt({ target: destination.target, requestId: input.requestId })).toMatchObject({ outcome: "applied", result: { count: 1 } });
    expect(await source.service.handlers.transfer_manifest_apply(input)).toMatchObject({ outcome: "applied" }); expect(mutations).toBe(1);
  });
  it("keeps work unavailable and rejects malformed or cross-scope remote replies durably", async () => {
    const f = await fixture(); const input = { ...f.transfer(), target: { ...f.target, serverId: "owner-work", machineKey: "work" as const, hostId: "host_work" } };
    expect(await f.service.handlers.transfer_manifest_apply(input)).toMatchObject({ outcome: "unavailable" }); expect(f.callOwner).not.toHaveBeenCalled();
    const remote = { ...f.transfer(), target: { ...f.target, serverId: "owner-studio", machineKey: "studio" as const, hostId: "host_studio" } };
    f.callOwner.mockResolvedValue({ ok: true, result: { owner: remote.target, requestId: remote.requestId, method: "transfer_manifest_apply", fingerprint: "0".repeat(64), outcome: "applied", result: null, message: null, updatedAt: 1 } });
    expect(await f.service.handlers.transfer_manifest_apply(remote)).toMatchObject({ outcome: "unknown" }); f.restart();
    expect(await f.service.handlers.transfer_manifest_apply(remote)).toMatchObject({ outcome: "unknown" }); expect(f.callOwner).toHaveBeenCalledTimes(1); expect(f.writes).toHaveLength(0);
  });
});

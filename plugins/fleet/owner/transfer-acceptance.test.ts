// F29 acceptance, scripted: a real Git checkout with ignored files on this Mac
// goes through candidate listing, the source manifest, the apply input schema
// and the owner's create-only apply into a real destination directory.
// Selected-file transfer copies only named files, 1 MiB each, 8 MiB total,
// and refuses .env, keys and credentials.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildTransferManifest, listTransferCandidates } from "./transfer-manifest";
import { createOwnerProject } from "./project";
import { ownerProjectContract, TRANSFER_FILE_BYTES, TRANSFER_TOTAL_BYTES, type ProjectOwnerTarget } from "./project-contract";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const work = realpathSync(mkdtempSync(path.join(tmpdir(), "f29-acceptance-")));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const MIB = TRANSFER_FILE_BYTES;
const fill = (size: number, seed: number) => Buffer.alloc(size, seed);

function sourceCheckout() {
  const root = path.join(work, "source");
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "aws"), { recursive: true });
  mkdirSync(path.join(root, "chunks"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, ".gitignore"), ["config/local.json", "config/unselected.json", ".env", ".env.production", "id_ed25519", "aws/", "api-key.json", "signing.pem", "exact.bin", "over.bin", "chunks/"].join("\n") + "\n");
  writeFileSync(path.join(root, "config/local.json"), '{"debug":true}\n');
  writeFileSync(path.join(root, "config/unselected.json"), '{"never":"copied"}\n');
  writeFileSync(path.join(root, ".env"), "TOKEN=fixture\n");
  writeFileSync(path.join(root, ".env.production"), "TOKEN=fixture\n");
  writeFileSync(path.join(root, "id_ed25519"), ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ") + "\nfixture\n");
  writeFileSync(path.join(root, "aws/credentials"), "[default]\n");
  writeFileSync(path.join(root, "api-key.json"), "{}");
  writeFileSync(path.join(root, "signing.pem"), "fixture");
  writeFileSync(path.join(root, "exact.bin"), fill(MIB, 1));
  writeFileSync(path.join(root, "over.bin"), fill(MIB + 1, 2));
  for (let index = 1; index <= 9; index++) writeFileSync(path.join(root, `chunks/part${index}.bin`), fill(MIB, 10 + index));
  return root;
}

async function destination(name: string) {
  const root = path.join(work, name);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  const target: ProjectOwnerTarget = { serverId: "owner-studio", machineKey: "studio", hostId: "host_studio", projectId: "proj_dest", environmentId: "env_dest" };
  const db = new Database(path.join(work, `${name}.db`));
  const writes: string[] = [];
  const bb = {
    storage: { database: () => db },
    sdk: {
      hosts: { get: async ({ hostId }: { hostId: string }) => ({ id: hostId, status: "connected" }), directory: async ({ path: full }: { path: string }) => ({ directory: await realpath(full) }) },
      environments: { get: async () => ({ id: target.environmentId, hostId: target.hostId, projectId: target.projectId, status: "ready", path: root }) },
      projects: { get: async () => ({ id: target.projectId, sources: [] }) },
      files: {
        write: async (input: { path: string; rootPath: string; content: string; expectedSha256: string | null }) => {
          if (input.expectedSha256 !== null || !input.path.startsWith(input.rootPath + path.sep)) throw new Error("create-only rooted write required");
          const bytes = Buffer.from(input.content, "base64");
          await mkdir(path.dirname(input.path), { recursive: true });
          await writeFile(input.path, bytes, { flag: "wx" });
          writes.push(path.relative(root, input.path));
          return { outcome: "written", sha256: sha(bytes), sizeBytes: bytes.length };
        },
        read: async ({ path: full }: { path: string }) => { const bytes = await readFile(full); return { content: bytes.toString("base64"), contentEncoding: "base64", sizeBytes: bytes.length, sha256: sha(bytes) }; },
      },
    },
  } as unknown as BbPluginApi;
  const service = createOwnerProject(bb, { identity: async () => ({ serverId: target.serverId, machineKey: target.machineKey, hostId: target.hostId }), callOwner: async () => ({ ok: false, kind: "unavailable", message: "local only" }) });
  const tree = () => { const out: string[] = []; const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.name === ".git") continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else out.push(path.relative(root, full)); } }; walk(root); return out.sort(); };
  return { root, target, service, writes, tree, close: () => db.close() };
}

const log: string[] = [];
const note = (line: string) => { log.push(line); };
afterAll(() => { const out = process.env.F29_ACCEPTANCE_LOG; if (out) writeFileSync(out, log.join("\n") + "\n"); });

describe("F29 acceptance: select ignored files during transfer", () => {
  const source = sourceCheckout();

  it("lists the checkout's ignored files and marks .env, keys, credentials and >1 MiB as not selectable", async () => {
    const listed = await listTransferCandidates(source);
    const byPath = Object.fromEntries(listed.candidates.map((entry) => [entry.path, entry]));
    for (const selectable of ["config/local.json", "config/unselected.json", "exact.bin"]) expect(byPath[selectable]).toMatchObject({ selectable: true });
    for (const refused of [".env", ".env.production", "id_ed25519", "api-key.json", "signing.pem"]) expect(byPath[refused]).toMatchObject({ selectable: false, reason: expect.stringContaining("never copied") });
    expect(byPath["over.bin"]).toMatchObject({ selectable: false, reason: "Larger than 1 MiB" });
    expect(byPath["aws"]).toMatchObject({ kind: "directory", selectable: false });
    note(`candidates: ${listed.candidates.map((entry) => `${entry.path}${entry.kind === "directory" ? "/" : ""}=${entry.selectable ? "selectable" : `refused(${entry.reason})`}`).join("; ")}`);
  });

  it("copies only the named files, refuses secrets and keys, and enforces the 1 MiB per-file cap", async () => {
    const named = ["config/local.json", "exact.bin", ".env", ".env.production", "id_ed25519", "aws/credentials", "api-key.json", "signing.pem", "over.bin"];
    const manifest = buildTransferManifest(source, named);
    expect(manifest.files.map((file) => file.path)).toEqual(["config/local.json", "exact.bin"]);
    expect(manifest.files.find((file) => file.path === "exact.bin")!.sizeBytes).toBe(MIB);
    expect(Object.fromEntries(manifest.refused.map((entry) => [entry.path, entry.reason]))).toEqual({
      ".env": expect.stringContaining("never copied"), ".env.production": expect.stringContaining("never copied"), "id_ed25519": expect.stringContaining("never copied"),
      "aws/credentials": expect.stringContaining("never copied"), "api-key.json": expect.stringContaining("never copied"), "signing.pem": expect.stringContaining("never copied"), "over.bin": "Larger than 1 MiB",
    });
    const dest = await destination("dest-named");
    const input = ownerProjectContract.transfer_manifest_apply.input.parse({ target: dest.target, requestId: randomUUID(), files: manifest.files });
    const receipt = await dest.service.handlers.transfer_manifest_apply(input);
    expect(receipt).toMatchObject({ outcome: "applied", result: { count: 2, totalBytes: MIB + 15 } });
    expect(dest.tree()).toEqual(["config/local.json", "exact.bin"]);
    for (const file of manifest.files) expect(sha(readFileSync(path.join(dest.root, file.path)))).toBe(sha(readFileSync(path.join(source, file.path))));
    note(`named transfer: applied ${dest.tree().join(", ")}; refused ${manifest.refused.map((entry) => `${entry.path} (${entry.reason})`).join("; ")}`);
    dest.close();
  });

  it("accepts exactly 8 MiB in eight 1 MiB files and refuses the ninth", async () => {
    const named = Array.from({ length: 9 }, (_, index) => `chunks/part${index + 1}.bin`);
    const manifest = buildTransferManifest(source, named);
    expect(manifest.files).toHaveLength(8);
    expect(manifest.totalBytes).toBe(TRANSFER_TOTAL_BYTES);
    expect(manifest.refused).toEqual([{ path: "chunks/part9.bin", reason: "The manifest would exceed 8 MiB" }]);
    const dest = await destination("dest-cap");
    const input = ownerProjectContract.transfer_manifest_apply.input.parse({ target: dest.target, requestId: randomUUID(), files: manifest.files });
    expect(await dest.service.handlers.transfer_manifest_apply(input)).toMatchObject({ outcome: "applied", result: { count: 8, totalBytes: TRANSFER_TOTAL_BYTES } });
    expect(dest.tree()).toEqual(named.slice(0, 8));
    const ninth = readFileSync(path.join(source, "chunks/part9.bin"));
    const overfull = [...manifest.files, { path: "chunks/part9.bin", sizeBytes: ninth.length, sha256: sha(ninth), contentBase64: ninth.toString("base64") }];
    expect(ownerProjectContract.transfer_manifest_apply.input.safeParse({ target: dest.target, requestId: randomUUID(), files: overfull }).success).toBe(false);
    note(`cap transfer: applied ${dest.tree().length} files totalling ${manifest.totalBytes} bytes; ninth refused at source and at the apply schema`);
    dest.close();
  });

  it("refuses protected paths at the owner even if a forged manifest bypasses the source", async () => {
    const dest = await destination("dest-forged");
    const bytes = Buffer.from("TOKEN=fixture\n");
    for (const forged of [".env", "id_ed25519", "aws/credentials"]) {
      const receipt = await dest.service.handlers.transfer_manifest_apply({ target: dest.target, requestId: randomUUID(), files: [{ path: forged, sizeBytes: bytes.length, sha256: sha(bytes), contentBase64: bytes.toString("base64") }] });
      expect(receipt.outcome).toBe("refused");
    }
    expect(dest.tree()).toEqual([]); expect(dest.writes).toEqual([]);
    note("forged manifest: .env, id_ed25519 and aws/credentials refused by the owner; nothing written");
    dest.close();
  });
});

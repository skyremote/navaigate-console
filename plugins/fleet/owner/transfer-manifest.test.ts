import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildTransferManifest, listTransferCandidates } from "./transfer-manifest";
import { ownerProjectContract, TRANSFER_FILE_BYTES, type ProjectOwnerTarget } from "./project-contract";

const target: ProjectOwnerTarget = { serverId: "owner-studio", machineKey: "studio", hostId: "host_studio", projectId: "proj", environmentId: "env" };

describe("selected-file transfer manifest", () => {
  it("includes only regular, small, non-secret files inside the checkout and refuses the rest with reasons", () => {
    const root = mkdtempSync(`${tmpdir()}/fleet-manifest-`);
    mkdirSync(`${root}/config`);
    writeFileSync(`${root}/config/local.json`, '{"debug":true}');
    writeFileSync(`${root}/.env`, "TOKEN=x");
    writeFileSync(`${root}/deploy.pem`, "key");
    writeFileSync(`${root}/big.bin`, Buffer.alloc(1024 * 1024 + 1));
    symlinkSync("/etc/hosts", `${root}/hosts-link`);
    const manifest = buildTransferManifest(root, ["config/local.json", ".env", "deploy.pem", "big.bin", "hosts-link", "../outside", "missing.txt"]);
    expect(manifest.files).toEqual([{ path: "config/local.json", sizeBytes: 14, sha256: createHash("sha256").update('{"debug":true}').digest("hex"), contentBase64: Buffer.from('{"debug":true}').toString("base64") }]);
    expect(Object.fromEntries(manifest.refused.map((entry) => [entry.path, entry.reason]))).toEqual({
      ".env": expect.stringContaining("never copied"),
      "deploy.pem": expect.stringContaining("never copied"),
      "big.bin": "Larger than 1 MiB",
      "hosts-link": expect.stringContaining("no symlinks"),
      "../outside": expect.stringContaining("without traversal"),
      "missing.txt": "No such file",
    });
    expect(manifest.totalBytes).toBe(14);
  });
});

describe("selected-file transfer: source-side selection", () => {
  it("refuses duplicate, case-alias and file/directory conflicts per path, so apply never fails the whole manifest", () => {
    const root = mkdtempSync(`${tmpdir()}/fleet-manifest-`);
    mkdirSync(`${root}/config`);
    writeFileSync(`${root}/config/local.json`, "{}");
    writeFileSync(`${root}/Notes.txt`, "a");
    const manifest = buildTransferManifest(root, ["config/local.json", "config/local.json", "CONFIG/LOCAL.JSON", "config", "Notes.txt"]);
    expect(manifest.files.map((file) => file.path)).toEqual(["config/local.json", "Notes.txt"]);
    expect(manifest.refused).toEqual([
      { path: "config/local.json", reason: expect.stringContaining("Already selected") },
      { path: "CONFIG/LOCAL.JSON", reason: expect.stringContaining("Already selected") },
      { path: "config", reason: expect.stringContaining("Conflicts with the selected path config/local.json") },
    ]);
    expect(ownerProjectContract.transfer_manifest_apply.input.safeParse({ target, requestId: randomUUID(), files: manifest.files }).success).toBe(true);
  });
  it("refuses private key material at the source even under an innocent name", () => {
    const root = mkdtempSync(`${tmpdir()}/fleet-manifest-`);
    writeFileSync(`${root}/notes.txt`, ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ") + "\nfixture\n");
    expect(buildTransferManifest(root, ["notes.txt"])).toMatchObject({ files: [], refused: [{ path: "notes.txt", reason: expect.stringContaining("private key") }], totalBytes: 0 });
  });
  it("lists git-ignored entries with eligibility and collapses ignored directories", async () => {
    const root = mkdtempSync(`${tmpdir()}/fleet-candidates-`);
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(`${root}/config`); mkdirSync(`${root}/node_modules/pkg`, { recursive: true });
    writeFileSync(`${root}/.gitignore`, "config/local.json\n.env\nnode_modules/\nonly-ignored/settings.json\nbig.bin\ndeploy.pem\nlink\n");
    writeFileSync(`${root}/config/local.json`, '{"debug":true}');
    writeFileSync(`${root}/config/tracked.json`, "{}");
    mkdirSync(`${root}/only-ignored`);
    writeFileSync(`${root}/only-ignored/settings.json`, "{}");
    writeFileSync(`${root}/.env`, "TOKEN=x");
    writeFileSync(`${root}/deploy.pem`, "key");
    writeFileSync(`${root}/big.bin`, Buffer.alloc(TRANSFER_FILE_BYTES + 1));
    writeFileSync(`${root}/node_modules/pkg/index.js`, "");
    symlinkSync("/etc/hosts", `${root}/link`);
    const listed = await listTransferCandidates(root);
    expect(listed.truncated).toBe(false);
    expect(Object.fromEntries(listed.candidates.map((entry) => [entry.path, [entry.kind, entry.selectable, entry.reason]]))).toEqual({
      ".env": ["file", false, expect.stringContaining("never copied")],
      "big.bin": ["file", false, "Larger than 1 MiB"],
      "config/local.json": ["file", true, null],
      "deploy.pem": ["file", false, expect.stringContaining("never copied")],
      "link": ["other", false, expect.stringContaining("no symlinks")],
      "node_modules": ["directory", false, expect.stringContaining("individually")],
      "only-ignored/settings.json": ["file", true, null],
    });
    expect((await listTransferCandidates(root, 2)).truncated).toBe(true);
  });
});

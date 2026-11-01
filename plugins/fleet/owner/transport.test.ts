import { describe, expect, it } from "vitest";
import { classifySshFailure, createSshOwnerTransport, isOwnerMethod, ownerRpcCommand } from "./transport";

type Callback = (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void;

function fakeRun(reply: { error?: (Error & { code?: number }) | null; stdout?: string; stderr?: string }, seen: { args?: string[]; input?: string; maxBuffer?: number }) {
  return ((_bin: string, args: string[], options: { maxBuffer?: number }, callback: Callback) => {
    seen.args = args;
    seen.maxBuffer = options.maxBuffer;
    queueMicrotask(() => callback(reply.error ?? null, reply.stdout ?? "", reply.stderr ?? ""));
    return { stdin: { on() {}, end(text: string) { seen.input = text; } } };
  }) as never;
}

function exitError(code: number, text: string) {
  return Object.assign(new Error(text), { code });
}

describe("ssh failure classification", () => {
  it("treats a pre-connect ssh failure as unavailable even for a mutation", () => {
    expect(classifySshFailure({ code: 255, stdout: "", stderr: "ssh: connect to host studio.local port 22: Connection refused", mutation: true })).toBe("unavailable");
    expect(classifySshFailure({ code: 255, stdout: "", stderr: "ssh: Could not resolve hostname studio: nodename nor servname provided", mutation: true })).toBe("unavailable");
    expect(classifySshFailure({ code: 255, stdout: "", stderr: "daniel@studio: Permission denied (publickey).", mutation: true })).toBe("unavailable");
  });

  it("keeps a mutation unknown when the remote command may have run", () => {
    expect(classifySshFailure({ code: 255, stdout: "", stderr: "Connection to studio closed by remote host.", mutation: true })).toBe("unknown");
    expect(classifySshFailure({ code: 1, stdout: "", stderr: "node: crashed", mutation: true })).toBe("unknown");
    expect(classifySshFailure({ code: 255, stdout: "{\"ok\":", stderr: "ssh: connect to host studio port 22: Connection refused", mutation: true })).toBe("unknown");
    expect(classifySshFailure({ code: null, stdout: "", stderr: "", mutation: true })).toBe("unknown");
  });

  it("treats a failed owner-side stdin spool as unavailable: the owner command never ran", () => {
    expect(classifySshFailure({ code: 70, stdout: "", stderr: "mktemp: failed", mutation: true })).toBe("unavailable");
    expect(classifySshFailure({ code: 71, stdout: "", stderr: "cat: write error: No space left on device", mutation: true })).toBe("unavailable");
    expect(classifySshFailure({ code: 70, stdout: "{\"ok\":", stderr: "", mutation: true })).toBe("unknown");
  });

  it("treats any failed read as unavailable", () => {
    expect(classifySshFailure({ code: 1, stdout: "", stderr: "boom", mutation: false })).toBe("unavailable");
  });
});

describe("finite owner transport", () => {
  it("only reaches listed (plugin, method) pairs", async () => {
    expect(isOwnerMethod("fleet", "updates_apply")).toBe(true);
    expect(isOwnerMethod("navaigate-skin", "attention_owner_action")).toBe(true);
    expect(isOwnerMethod("automations", "automations_run")).toBe(false);
    expect(isOwnerMethod("fleet", "constructor")).toBe(false);
    const seen: { args?: string[] } = {};
    const transport = createSshOwnerTransport({ alias: "studio", run: fakeRun({ stdout: "{}" }, seen) });
    const refused = await transport.call("fleet", "drop_tables" as never, {}, true);
    expect(refused).toEqual({ ok: false, kind: "refused", message: "fleet.drop_tables is not an owner method" });
    expect(seen.args).toBeUndefined();
  });

  it("spools stdin to a private owner temp file instead of bb reading /dev/stdin (EAGAIN on a large SSH pipe)", () => {
    const command = ownerRpcCommand("fleet", "work_attachments_put");
    expect(command).not.toContain("/dev/stdin");
    expect(command.indexOf("umask 077")).toBe(0);
    expect(command).toContain('mktemp "${TMPDIR:-/tmp}/fleet-rpc.XXXXXX") || exit 70');
    expect(command).toContain(`trap 'rm -f "$f"' EXIT`);
    expect(command.indexOf('cat > "$f" || exit 71')).toBeLessThan(command.indexOf("plugin rpc call 'fleet' 'work_attachments_put' --input-file \"$f\" --json"));
  });

  it("delivers a 7 MB input whole on stdin, never in the command", async () => {
    const seen: { args?: string[]; input?: string } = {};
    const contentBase64 = Buffer.alloc(5_212_401, 7).toString("base64");
    await createSshOwnerTransport({ alias: "studio", run: fakeRun({ stdout: JSON.stringify({ ok: true, result: {} }) }, seen) }).call("fleet", "work_attachments_put", { files: [{ contentBase64 }] }, true);
    expect(JSON.parse(seen.input!).files[0].contentBase64).toBe(contentBase64);
    expect(seen.args!.at(-1)!.length).toBeLessThan(1024);
  });

  it("allows a 12 MiB answer for context_bundle_export only", async () => {
    const exported: { maxBuffer?: number } = {};
    await createSshOwnerTransport({ alias: "studio", run: fakeRun({ stdout: JSON.stringify({ ok: true, result: {} }) }, exported) }).call("fleet", "context_bundle_export", {}, false);
    expect(exported.maxBuffer).toBe(12 * 1024 * 1024);
    const other: { maxBuffer?: number } = {};
    await createSshOwnerTransport({ alias: "studio", run: fakeRun({ stdout: JSON.stringify({ ok: true, result: {} }) }, other) }).call("fleet", "owner_file_read", {}, false);
    expect(other.maxBuffer).toBe(2 * 1024 * 1024);
  });

  it("sends input on stdin only and returns the owner result", async () => {
    const seen: { args?: string[]; input?: string } = {};
    const transport = createSshOwnerTransport({ alias: "studio", run: fakeRun({ stdout: JSON.stringify({ ok: true, result: { state: "sent" } }) }, seen) });
    const outcome = await transport.call("fleet", "control_deliver", { text: "'; rm -rf / #" }, true);
    expect(outcome).toEqual({ ok: true, result: { state: "sent" } });
    expect(seen.args?.at(-1)).toContain(`plugin rpc call 'fleet' 'control_deliver' --input-file "$f" --json`);
    expect(seen.args?.at(-1)).not.toContain("rm -rf");
    expect(seen.input).toContain("rm -rf");
  });

  it("maps a pre-connect failure to unavailable, an owner refusal to unknown for mutations, and a missing method to unavailable", async () => {
    const unreachable = createSshOwnerTransport({ alias: "studio", run: fakeRun({ error: exitError(255, "ssh failed"), stderr: "ssh: connect to host studio port 22: Operation timed out" }, {}) });
    expect(await unreachable.call("fleet", "work_start", {}, true)).toMatchObject({ ok: false, kind: "unavailable" });
    const midway = createSshOwnerTransport({ alias: "studio", run: fakeRun({ error: exitError(255, "ssh failed"), stderr: "Connection to studio closed by remote host." }, {}) });
    expect(await midway.call("fleet", "work_start", {}, true)).toMatchObject({ ok: false, kind: "unknown" });
    const missing = createSshOwnerTransport({ alias: "studio", run: fakeRun({ error: exitError(1, "x"), stdout: JSON.stringify({ ok: false, error: { message: "Unknown RPC method updates_apply" } }) }, {}) });
    expect(await missing.call("fleet", "updates_apply", {}, true)).toMatchObject({ ok: false, kind: "unavailable", message: expect.stringContaining("owner-method-missing") });
  });
});

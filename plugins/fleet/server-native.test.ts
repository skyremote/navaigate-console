import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { commandAad, EXECUTION_FEATURE, SEALED_COMMAND_PLACEHOLDER, SEALED_CONTROL_PLACEHOLDER, SEALED_RELAY_FEATURE, type Snapshot } from "./model";
import { mirrorControlInput } from "./mirror/control";
import { generateMirrorKeyPair, open as openSealed } from "./mirror/crypto";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SYSTEM_TOOLS = vi.hoisted(() => ["/usr/bin/top ", "/usr/bin/vm_stat", "/bin/df ", "/usr/bin/pmset ", "/usr/sbin/sysctl -n hw.ncpu", "/usr/sbin/sysctl -n vm.loadavg", "/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level", "/usr/sbin/sysctl -n vm.swapusage"]);

const state = vi.hoisted(() => ({
  sshSnapshot: null as Record<string, unknown> | null,
  snapshotGate: null as Promise<void> | null,
  snapshotCalls: 0,
  sshMutations: [] as { command: string; input: Record<string, unknown> }[],
  failMutation: false,
  sshPreConnect: false,
  studioEvents: [] as { seq: number; type: string }[],
  attachments: new Map<string, Uint8Array>(),
  uploads: [] as { projectId: string; filename: string }[],
  studioAnswerState: "idle",
  ownerRejects: null as string | null,
  brainBlocked: false,
  brain: null as { batch: (statements: { sql: string; args?: (string | number | null)[] }[]) => Promise<Record<string, string | number | null>[][]>; query: (sql: string, args?: (string | number | null)[]) => Promise<Record<string, string | number | null>[]> } | null,
  handle: "laptop-srv",
  mirrorJwk: null as { x?: string; d?: string; kty?: string; crv?: string } | null,
  mirrorDeps: null as { forwardControl: (request: unknown) => Promise<unknown>; interactionDetail?: (input: unknown) => Promise<unknown>; direct?: { events(input: { serverId: string; machine: string; threadId: string }): Promise<unknown> } } | null,
  onBrokerQuery: null as ((sql: string, args: (string | number | null)[]) => void) | null,
  cliThreads: {} as Record<string, { output: string }>,
  cliOutputReads: [] as string[],
  memoryLevel: "56\n" as string,
  systemOutputs: {} as Record<string, string | null>,
  systemCalls: [] as string[],
  systemHold: null as Promise<void> | null,
  mirrorTick: null as (() => Promise<void>) | null,
  threadAccounts: null as unknown,
  accountCalls: 0,
}));
vi.mock("./turso", async (importOriginal) => ({
  ...await importOriginal<typeof import("./turso")>(),
  loadBrainCredentials: () => state.brainBlocked || state.brain ? { url: "https://fake.invalid", token: "fixture" } : null,
  TursoClient: class {
    async batch(statements: { sql: string; args?: (string | number | null)[] }[]) { if (state.brain) return state.brain.batch(statements); throw new Error("SQL read operations are forbidden (fixture)"); }
    async query(sql: string, args?: (string | number | null)[]) { if (state.brain) return state.brain.query(sql, args); throw new Error("SQL read operations are forbidden (fixture)"); }
  },
}));
vi.mock("./mirror/service", () => ({ createMirror: (deps: { forwardControl: (request: unknown) => Promise<unknown> }) => {
  state.mirrorDeps = deps;
  return state.mirrorJwk ? { publicKey: state.mirrorJwk.x, feedDir: "/tmp/fleet-synthetic-feed", tick: async () => { await state.mirrorTick?.(); }, nextDelay: () => 30_000, copyOwner: async (id: string) => (id === "thr_copy" ? { machine: "studio", serverId: "studio-srv", remoteThreadId: "thr_owned" } : null), open: async () => ({ localThreadId: "thr_copy" }) } : null;
} }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => String(args[0]).endsWith("/.ssh/config") ? "Host studio-ssh\n  HostName fixture.invalid\n" : String(args[0]).endsWith("/mirror-key.json") && state.mirrorJwk ? JSON.stringify(state.mirrorJwk) : fs.readFileSync(...args) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: (bin: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const systemKey = `${bin} ${args.join(" ")}`.trim();
    if (systemKey in state.systemOutputs || SYSTEM_TOOLS.some((tool) => systemKey.startsWith(tool))) { state.systemCalls.push(systemKey); const output = state.systemOutputs[systemKey] ?? null; const respond = () => callback(output === null ? new Error("read failed") : null, output ?? "", ""); if (bin === "/usr/bin/top" && state.systemHold) void state.systemHold.then(respond); else queueMicrotask(respond); return { stdin: { on() {}, end() {} } }; }
    if (bin === "/usr/sbin/sysctl") { queueMicrotask(() => callback(null, state.memoryLevel, "")); return { stdin: { on() {}, end() {} } }; }
    if (bin !== "ssh") {
      const threadId = args[2] ?? "";
      const shown = args[0] === "thread" ? state.cliThreads[threadId] : undefined;
      if (shown && args[1] === "output") state.cliOutputReads.push(threadId);
      const result = shown && args[1] === "show" ? { thread: { id: threadId, status: "idle", projectId: "proj_native", updatedAt: Date.now() }, environment: null }
        : shown && args[1] === "output" ? { output: shown.output }
          : { handle: state.handle, url: `https://${state.handle}.example.test` };
      queueMicrotask(() => callback(null, JSON.stringify(result), ""));
      return { stdin: { on() {}, end() {} } };
    }
    return { stdin: { on() {}, end(text: string) {
      const input = JSON.parse(text);
      const command = args.at(-1)!;
      if (command.includes("'snapshot_get'")) {
        state.snapshotCalls++;
        void (state.snapshotGate ?? Promise.resolve()).then(() => state.sshSnapshot ? callback(null, JSON.stringify({ ok: true, result: state.sshSnapshot }), "") : callback(new Error("unreachable fixture"), "", "unreachable fixture"));
      } else {
        state.sshMutations.push({ command, input });
        const route = { machine: "studio", serverId: "studio-srv", hostId: "host_studio", mode: "manual", reason: "studio owner", warnings: [], candidates: [] };
        const method = /'fleet' '([a-z_]+)'/.exec(command)?.[1];
        if (method === "thread_answer_get") { queueMicrotask(() => callback(null, JSON.stringify({ ok: true, result: { machine: "studio", threadId: input.threadId, url: "https://studio.example.test/t", state: state.studioAnswerState, output: `studio answer for ${input.threadId}`, truncated: false, publishedAt: Date.now() } }), "")); return; }
        if (method === "thread_events_get") { const after = Number(input.afterSeq ?? -1); const rows = input.order === "desc" ? state.studioEvents.slice(-1) : state.studioEvents.filter((event) => event.seq > after); queueMicrotask(() => callback(null, JSON.stringify({ ok: true, result: rows }), "")); return; }
        if (state.sshPreConnect) { queueMicrotask(() => callback(Object.assign(new Error("ssh exit 255"), { code: 255 }), "", "ssh: connect to host fixture.invalid port 22: Connection refused\n")); return; }
        if (method === "owner_file_stat") { queueMicrotask(() => callback(null, JSON.stringify({ ok: true, result: { owner: input.target, rootPath: "/Users/tester/Documents/GitHub/My Repo", path: ".", kind: "directory", sizeBytes: null, sha256: null, preview: null } }), "")); return; }
        if (method === "interaction_list") { queueMicrotask(() => callback(null, JSON.stringify({ ok: true, result: { owner: input.target, interactions: [{ id: "int_a", threadId: input.target.threadId, turnId: "t1", kind: "approval", createdAt: 1, expiresAt: null, fingerprint: "a".repeat(64), payload: { kind: "approval", subject: { kind: "command", itemId: "i1", command: "ls" }, availableDecisions: ["deny", "allow_once"] } }], truncated: false } }), "")); return; }
        if (method === "interaction_respond") { state.sshMutations.push({ command, input }); queueMicrotask(() => callback(null, JSON.stringify({ ok: true, result: { owner: input.target, requestId: input.requestId, method: "interaction_respond", outcome: input.expectedFingerprint === "a".repeat(64) ? "applied" : "refused", result: null, message: input.expectedFingerprint === "a".repeat(64) ? null : "Native interaction changed or expired; reload before answering", updatedAt: Date.now() } }), "")); return; }
        if (method === "thread_target_get") { queueMicrotask(() => callback(null, JSON.stringify({ ok: true, result: { serverId: "studio-srv", machineKey: "studio", hostId: "host_studio", environmentId: "env_studio", projectId: "proj_studio", threadId: input.threadId } }), "")); return; }
        if (method === "context_bundle_import") {
          const files = input.files as { name: string; sha256: string; contentBase64: string; mimeType: string }[];
          const result = { owner: input.target, context: null, contextSourceVerification: "caller-supplied", attachments: files.map((file, index) => ({ type: "localImage", name: file.name, path: `uploads/studio-img-${index}`, sizeBytes: Buffer.from(file.contentBase64, "base64").length, mimeType: file.mimeType, sourceProjectId: "proj_studio", sha256: file.sha256, verified: true })), runtimeFiles: [] };
          queueMicrotask(() => callback(null, JSON.stringify({ ok: true, result: { owner: input.target, requestId: input.requestId, method: "context_bundle_import", outcome: "applied", result, message: null, updatedAt: Date.now() } }), ""));
          return;
        }
        if (method === "work_attachments_put") { queueMicrotask(() => callback(null, JSON.stringify({ ok: true, result: { projectId: "proj_studio", attachments: (input.files as { name: string; sha256: string; contentBase64: string; type: string; mimeType: string }[]).map((file, index) => ({ type: file.type, path: `uploads/studio-${index}`, sourceProjectId: "proj_studio", name: file.name, sizeBytes: Buffer.from(file.contentBase64, "base64").length, mimeType: file.mimeType, sha256: file.sha256 })) } }), "")); return; }
        if (method === "control_deliver") { queueMicrotask(() => state.failMutation ? callback(new Error("connection closed after dispatch"), "", "connection closed after dispatch") : callback(null, JSON.stringify({ ok: true, result: { state: "sent", remoteRequestId: input.id } }), "")); setTimeout(() => state.studioEvents.push({ seq: 12, type: "turn/started" }, { seq: 13, type: "turn/completed" }), 5); return; }
        if (state.ownerRejects) { queueMicrotask(() => callback(Object.assign(new Error("exit 1"), { code: 1 }), JSON.stringify({ ok: false, error: { code: "handler_error", message: `fleet-rejected: ${state.ownerRejects}` } }), "")); return; }
        queueMicrotask(() => state.failMutation ? callback(new Error("connection closed after dispatch"), "", "connection closed after dispatch") : callback(null, JSON.stringify({ ok: true, result: { outcome: "started", threadId: "thr_remote", url: "https://studio.example.test/threads/thr_remote", commandId: null, requestId: input.requestId, route } }), ""));
      }
    } } };
  } };
});
import plugin from "./server";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  state.sshSnapshot = null; state.snapshotGate = null; state.snapshotCalls = 0; state.sshMutations = []; state.failMutation = false; state.sshPreConnect = false; state.ownerRejects = null; state.studioEvents = []; state.studioAnswerState = "idle"; state.attachments = new Map(); state.uploads = []; state.brainBlocked = false; state.brain = null; state.handle = "laptop-srv";
  state.mirrorJwk = null; state.mirrorDeps = null; state.onBrokerQuery = null;
  state.cliThreads = {}; state.cliOutputReads = []; state.memoryLevel = "56\n"; state.mirrorTick = null;
  state.systemOutputs = {}; state.systemCalls = []; state.systemHold = null;
  state.threadAccounts = null; state.accountCalls = 0;
});
async function host(overrides: Record<string, unknown> = {}, joined = false, machine = "laptop", extraSettings: Record<string, unknown> = {}) {
  const spawned: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const stopped: string[] = [];
  const fixture = createFakePluginHost({
    pluginId: "fleet-native-test",
    settings: { machineKey: machine, machineLabel: `${machine} test`, joinFleet: joined, ...extraSettings },
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: `host_${machine}`, name: machine, status: "connected", type: "persistent", machineProviderId: null })] },
      projects: {
        attachments: {
          read: async ({ projectId, path }: { projectId: string; path: string }) => { const bytes = state.attachments.get(`${projectId}:${path}`); if (!bytes) throw new Error("ENOENT attachment"); return { bytes, sizeBytes: bytes.length, mimeType: "image/png" }; },
          upload: async ({ projectId, filename, clientFile }: { projectId: string; filename: string; clientFile: Uint8Array }) => { state.uploads.push({ projectId, filename }); const path = `uploads/${state.uploads.length}-${filename}`; state.attachments.set(`${projectId}:${path}`, new Uint8Array(clientFile)); return { type: filename.endsWith(".png") ? "localImage" : "localFile", name: filename, path, sizeBytes: clientFile.length, mimeType: "image/png", sourceProjectId: projectId }; },
        },
        list: async () => [
        { id: "proj_native", name: "NavAIgate", kind: "standard", sources: [{ hostId: `host_${machine}`, path: "/tmp/fleet-native-fixture" }] },
        { id: "proj_personal", name: "Personal", kind: "personal" },
      ] as never },
      providers: {
        list: async () => [{ id: "codex", available: true, reasoningLevels: [{ id: "high" }], serviceTiers: [{ id: "fast" }] }] as never,
        models: async () => ({ modelLoadError: null, models: [{ id: "gpt-test", model: "gpt-test", supportedReasoningEfforts: [{ reasoningEffort: "high" }], supportedServiceTiers: [{ id: "fast" }] }] }) as never,
      },
      threadSections: { list: async () => [] },
      plugins: { callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
        if (pluginId === "navaigate-skin" && method === "thread_accounts") { state.accountCalls++; if (state.threadAccounts === null) throw new Error("plugin navaigate-skin is not installed"); return state.threadAccounts; }
        throw new Error(`unexpected plugin call ${pluginId}.${method}`);
      } },
      threads: {
        list: async () => [],
        spawn: async (args: Record<string, unknown>) => { spawned.push(args); return makeThreadResponse({ id: `thr_native${spawned.length}`, projectId: "proj_native" }); },
        send: async (args: Record<string, unknown>) => { sent.push(args); return { ok: true, delivery: "sent" } as never; },
        stop: async ({ threadId }: { threadId: string }) => { stopped.push(threadId); return { ok: true }; },
        events: { list: async () => [] },
        queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
        ...overrides,
      } as never,
    },
  });
  disposals.push(() => fixture.harness.lifecycle.dispose());
  await plugin(fixture.bb);
  return { ...fixture, spawned, sent, stopped };
}
function remoteM1(): Snapshot {
  const now = Date.now();
  return { serverId: "studio-srv", label: "studio", machineKey: "studio", url: "https://studio.example.test", ownerHostId: "host_studio", machines: [{ key: "studio", label: "studio", online: true, capabilities: ["NAS"], verifiedCapabilities: ["NAS"] }], threads: [], publishedAt: now, features: [EXECUTION_FEATURE], providers: [{ id: "codex", available: true, observedAt: now }], resources: { observedAt: now, cpuCount: 8, cpuUtilization: 0.2, totalMemoryBytes: 1000, availableMemoryBytes: 500 } };
}

function brokerFixture(snapshot: Snapshot) {
  const db = new Database(":memory:");
  disposals.push(async () => db.close());
  db.exec(`CREATE TABLE fleet_servers (server_id TEXT PRIMARY KEY, label TEXT, url TEXT, hostname TEXT, published_at INTEGER, payload TEXT);
    CREATE TABLE fleet_commands (id TEXT PRIMARY KEY, target_server TEXT, target_host_id TEXT, title TEXT, prompt TEXT, provider_id TEXT, from_server TEXT, status TEXT, thread_id TEXT, thread_url TEXT, error TEXT, created_at INTEGER, updated_at INTEGER);`);
  state.brain = {
    async batch(statements) {
      return statements.map(({ sql, args = [] }) => { const statement = db.prepare(sql); const rows = statement.reader ? statement.all(...args) as Record<string, string | number | null>[] : (statement.run(...args), []); state.onBrokerQuery?.(sql, args); return rows; });
    },
    async query(sql, args) { return (await this.batch([{ sql, args }]))[0]!; },
  };
  db.prepare("INSERT INTO fleet_servers VALUES (?, ?, ?, ?, ?, ?)").run(snapshot.serverId, "studio", snapshot.url, "fixture", snapshot.publishedAt, JSON.stringify(snapshot));
  return db;
}

describe("native Fleet execution contract", () => {
  it("returns an available local mirror before an outstanding studio identity refresh", async () => {
    const keys = generateMirrorKeyPair();
    state.mirrorJwk = keys.privateKey.export({ format: "jwk" }) as typeof state.mirrorJwk;
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    let release!: () => void;
    state.snapshotGate = new Promise<void>((resolve) => { release = resolve; });
    const f = await host({}, true);
    try {
      const result = await f.harness.behavior.callRpc("mirror_open", { machine: "studio", threadId: "thr_saved" });
      expect(result).toEqual({ localThreadId: "thr_copy" });
    } finally { release(); await Promise.resolve(); }
  });

  it("rechecks the owner identity before fetching background events for a saved mirror", async () => {
    const keys = generateMirrorKeyPair();
    state.mirrorJwk = keys.privateKey.export({ format: "jwk" }) as typeof state.mirrorJwk;
    state.sshSnapshot = { ...remoteM1(), serverId: "replacement-owner" } as unknown as Record<string, unknown>;
    await host({}, true);
    await expect(state.mirrorDeps!.direct!.events({ serverId: "studio-srv", machine: "studio", threadId: "thr_saved" })).rejects.toThrow("verified Studio");
    expect(state.sshMutations.some((call) => call.command.includes("'thread_events_get'"))).toBe(false);
  });

  it("preserves an explicit selection at destination and deduplicates a repeated job", async () => {
    const f = await host();
    const input = { machine: "laptop", prompt: "Read the fixture only", providerId: "codex", model: "gpt-test", reasoningLevel: "high", serviceTier: "fast", requestId: "job-native-0001" };
    const first = await f.harness.behavior.callRpc("work_start", input);
    const second = await f.harness.behavior.callRpc("work_start", input);
    expect(second).toEqual(first);
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: input.requestId })).toMatchObject({ state: "completed", result: first });
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]).toMatchObject({ providerId: "codex", model: "gpt-test", reasoningLevel: "high", serviceTier: "fast", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit" } });
    await expect(f.harness.behavior.callRpc("work_start", { ...input, prompt: "different task" })).rejects.toThrow("identity");
    expect(f.spawned).toHaveLength(1);
  });

  it("refuses an explicit unmapped project rather than silently using personal workspace", async () => {
    const f = await host();
    await expect(f.harness.behavior.callRpc("work_start", { machine: "laptop", prompt: "Read", projectName: "Missing remote repo" })).rejects.toThrow("no checkout");
    expect(f.spawned).toHaveLength(0);
  });

  it.each([
    { type: "managed-worktree", baseBranch: { kind: "named", name: "release" } },
    { type: "managed-worktree", baseBranch: { kind: "default" } },
    { type: "unmanaged", path: null, branch: { kind: "existing", name: "feature/current" } },
    { type: "unmanaged", path: null, branch: { kind: "new", baseBranch: "main" } },
  ])("preserves transferable workspace intent on the destination's actual host", async (workspace) => {
    const f = await host();
    await f.harness.behavior.callRpc("work_start", { machine: "laptop", prompt: "Read", projectName: "NavAIgate", workspace });
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]).toMatchObject({ projectId: "proj_native", environment: { type: "host", hostId: "host_laptop", workspace } });
  });

  it("refuses arbitrary remote paths, environment reuse, and worktrees in personal workspaces", async () => {
    const f = await host();
    for (const workspace of [{ type: "unmanaged", path: "/Users/someone/checkout" }, { type: "reuse", environmentId: "env_source" }]) {
      await expect(f.harness.behavior.callRpc("work_start", { machine: "laptop", prompt: "Read", workspace })).rejects.toThrow();
    }
    await expect(f.harness.behavior.callRpc("work_start", { machine: "laptop", prompt: "Read", projectName: "Personal", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } })).rejects.toThrow("workspace");
    expect(f.spawned).toHaveLength(0);
  });

  it("passes the full selection and prompt only through SSH stdin to studio's independent owner", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    const f = await host();
    const prompt = 'Inspect literal `code` and $(do-not-execute)';
    const result = await f.harness.behavior.callRpc("work_start", { machine: "studio", prompt, providerId: "codex", model: "gpt-test", reasoningLevel: "high", serviceTier: "fast", requestId: "job-direct-0001", projectName: "NavAIgate" });
    expect(result).toMatchObject({ outcome: "started", threadId: "thr_remote", route: { machine: "studio", serverId: "studio-srv", hostId: "host_studio" } });
    expect(f.spawned).toHaveLength(0);
    expect(state.sshMutations).toHaveLength(1);
    expect(state.sshMutations[0]!.input).toMatchObject({ prompt, providerId: "codex", model: "gpt-test", reasoningLevel: "high", serviceTier: "fast", projectName: "NavAIgate" });
    expect(state.sshMutations[0]!.command).not.toContain(prompt);
    expect(state.sshMutations[0]!.command).toContain('cat > "$f"');
    expect(state.sshMutations[0]!.command).toContain('--input-file "$f" --json');
    expect(state.sshMutations[0]!.command).not.toContain("/dev/stdin");
    expect(state.sshMutations[0]!.command).toContain("PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'");
  });

  it("does not repeat a mutation after its SSH outcome becomes unknown", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    state.failMutation = true;
    const f = await host();
    const input = { machine: "studio", prompt: "Read", requestId: "job-direct-unknown" };
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("outcome is unknown");
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("unknown or in-progress");
    expect(state.sshMutations).toHaveLength(1);
  });

  it("records a known pre-dispatch rejection as not started and lets the same request id retry", async () => {
    const f = await host();
    const input = { machine: "laptop", prompt: "Read", providerId: "codex", model: "gpt-missing", requestId: "job-rejected-0001" };
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("fleet-rejected: Model gpt-missing is not available for codex on laptop");
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: input.requestId })).toMatchObject({ state: "missing", result: null, notStarted: { reason: "rejected", message: expect.stringContaining("gpt-missing") } });
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("fleet-rejected");
    await expect(f.harness.behavior.callRpc("work_start", { ...input, prompt: "other" })).rejects.toThrow("identity");
    expect(f.spawned).toHaveLength(0);
  });

  it.each(["HTTP 409: This project checkout could not be inspected.", "HTTP 409: This project checkout has no usable git branch.", "Error: HTTP 409: This project checkout could not be inspected."])("records the core's pre-creation checkout refusal (%s) as not started, never unknown", async (refusal) => {
    let calls = 0;
    const f = await host({ spawn: async () => { calls += 1; throw new Error(refusal); } });
    const input = { machine: "laptop", prompt: "Read", projectName: "NavAIgate", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } }, requestId: "job-checkout-refused" };
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("fleet-rejected: laptop could not use this project's checkout, so nothing was started");
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: input.requestId })).toMatchObject({ state: "missing", result: null, notStarted: { reason: "rejected", message: expect.stringContaining(refusal) } });
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("fleet-rejected");
    expect(calls).toBe(2);
  });

  it("keeps any other native spawn failure as an unknown outcome", async () => {
    const f = await host({ spawn: async () => { throw new Error("HTTP 409: Thread already exists for this checkout"); } });
    const input = { machine: "laptop", prompt: "Read", requestId: "job-spawn-other-409" };
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("Native start outcome is unknown");
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: input.requestId })).toMatchObject({ state: "unknown" });
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("unknown or in-progress");
  });

  it("treats an SSH pre-connect failure as not started, and retries the same id once studio is reachable", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    const f = await host();
    await f.harness.behavior.callRpc("snapshot_get", null);
    state.sshPreConnect = true;
    const input = { machine: "studio", prompt: "Read", requestId: "job-direct-preconnect" };
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("Studio was not reached; nothing was started");
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: input.requestId })).toMatchObject({ state: "missing", notStarted: { reason: "unavailable" } });
    state.sshPreConnect = false;
    const started = await f.harness.behavior.callRpc("work_start", input);
    expect(started).toMatchObject({ outcome: "started", threadId: "thr_remote" });
    expect(state.sshMutations).toHaveLength(2);
  });

  it("publishes macOS available memory from the kernel level, so Auto does not see a busy Mac as exhausted", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    disposals.push(async () => { Object.defineProperty(process, "platform", platform); });
    const f = await host();
    const snapshot = await f.harness.behavior.callRpc("snapshot_get", null) as Snapshot;
    const resources = snapshot.resources!;
    expect(resources.availableMemoryBytes).toBe(Math.round(resources.totalMemoryBytes * 0.56));
    state.memoryLevel = "not a level";
    const fallback = (await f.harness.behavior.callRpc("snapshot_get", null) as Snapshot).resources!;
    expect(fallback.availableMemoryBytes).toBeLessThan(fallback.totalMemoryBytes);
    expect(fallback.availableMemoryBytes).not.toBe(Math.round(fallback.totalMemoryBytes * 0.56));
  });

  describe("system", () => {
    const fixture = (dir: string, name: string) => readFileSync(new URL(`./fixtures/${dir}/${name}`, import.meta.url), "utf8");
    const commands = {
      top: "/usr/bin/top -l 2 -n 0 -s 1",
      hardware: "/usr/sbin/sysctl -n hw.ncpu hw.memsize",
      loadavg: "/usr/sbin/sysctl -n vm.loadavg",
      vmStat: "/usr/bin/vm_stat",
      pressure: "/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level",
      swap: "/usr/sbin/sysctl -n vm.swapusage",
      df: "/bin/df -k /",
      pmset: "/usr/bin/pmset -g assertions",
    };
    const recordedOutputs = (): Record<string, string | null> => ({
      [commands.top]: fixture("system", "top-laptop.txt"),
      [commands.hardware]: fixture("system", "hardware-laptop.txt"),
      [commands.loadavg]: fixture("system", "loadavg-laptop.txt"),
      [commands.vmStat]: fixture("system", "vm_stat-laptop.txt"),
      [commands.pressure]: fixture("system", "pressure-laptop.txt"),
      [commands.swap]: fixture("system", "swap-laptop.txt"),
      [commands.df]: fixture("system", "df-laptop.txt"),
      [commands.pmset]: fixture("pmset", "assertions-amphetamine-caffeinate.txt"),
    });
    const onDarwin = () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "darwin" });
      disposals.push(async () => { Object.defineProperty(process, "platform", platform); });
    };
    const clock = (start: number) => {
      let at = start;
      const spy = vi.spyOn(Date, "now").mockImplementation(() => at);
      disposals.push(async () => { spy.mockRestore(); });
      return { advance: (ms: number) => { at += ms; } };
    };
    const system = async (f: Awaited<ReturnType<typeof host>>) => (await f.harness.behavior.callRpc("snapshot_get", null) as Snapshot).system;

    it("publishes CPU, memory, load, swap, disk and keep-awake holders from fixed system tools", async () => {
      onDarwin();
      state.systemOutputs = recordedOutputs();
      clock(1_800_000_000_000);
      const f = await host();
      expect(await system(f)).toEqual({
        cpuPercent: 22.1,
        cores: 18,
        loadAvg: [6.41, 8.21, 7.46],
        memUsedBytes: (981_927 + 375_022 + 712_297) * 16_384,
        memTotalBytes: 51_539_607_552,
        memPressure: "normal",
        swapUsedBytes: Math.round(13235.62 * 1024 * 1024),
        diskFreeBytes: 58_863_068 * 1024,
        diskTotalBytes: 1_948_404_040 * 1024,
        keepAwake: ["Amphetamine", "caffeinate"],
      });
      expect(state.systemCalls.sort()).toEqual(Object.values(commands).sort());
    });

    it("reads at most once every 30 seconds however many snapshots are built", async () => {
      onDarwin();
      state.systemOutputs = recordedOutputs();
      const time = clock(1_800_000_000_000);
      const f = await host();
      await system(f);
      time.advance(10_000);
      await system(f);
      time.advance(19_000);
      await system(f);
      expect(state.systemCalls).toHaveLength(8);
      time.advance(2_000);
      state.systemOutputs[commands.pressure] = "2\n";
      expect((await system(f))?.memPressure).toBe("normal");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.systemCalls).toHaveLength(16);
      expect((await system(f))?.memPressure).toBe("warn");
      expect(state.systemCalls).toHaveLength(16);
    });

    it("returns the last value at once while a slow refresh runs in the background", async () => {
      onDarwin();
      state.systemOutputs = recordedOutputs();
      const time = clock(1_800_000_000_000);
      const f = await host();
      const first = await system(f);
      expect(first?.memPressure).toBe("normal");
      let release!: () => void;
      state.systemHold = new Promise<void>((resolve) => { release = resolve; });
      state.systemOutputs[commands.pressure] = "2\n";
      time.advance(31_000);
      expect(await system(f)).toEqual(first);
      expect(await system(f)).toEqual(first);
      expect(state.systemCalls).toHaveLength(16);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await system(f))?.memPressure).toBe("warn");
    });

    it("gives null for a field whose read failed and keeps the others", async () => {
      onDarwin();
      state.systemOutputs = { ...recordedOutputs(), [commands.top]: null, [commands.swap]: null };
      const f = await host();
      expect(await system(f)).toMatchObject({ cpuPercent: null, swapUsedBytes: null, cores: 18, memPressure: "normal", keepAwake: ["Amphetamine", "caffeinate"] });
    });

    it("does not run the readers off macOS", async () => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "linux" });
      disposals.push(async () => { Object.defineProperty(process, "platform", platform); });
      const f = await host();
      expect(await system(f)).toBeNull();
      expect(state.systemCalls).toEqual([]);
    });
  });

  it("refuses an unavailable model on studio with the owner's exact reason and starts nothing locally", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    state.ownerRejects = "Model gpt-missing is not available for codex on studio";
    const f = await host();
    const input = { machine: "studio", prompt: "Read", providerId: "codex", model: "gpt-missing", reasoningLevel: "high", requestId: "job-direct-missing-model" };
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("Model gpt-missing is not available for codex on studio");
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: input.requestId })).toMatchObject({ state: "missing", notStarted: { reason: "rejected", message: expect.stringContaining("Model gpt-missing is not available for codex on studio") } });
    expect(f.spawned).toHaveLength(0);
  });

  it("maps an owner-side pre-dispatch rejection over SSH to a retryable refusal, never unknown", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    state.ownerRejects = "Model gpt-x is not available for codex on studio";
    const f = await host();
    const input = { machine: "studio", prompt: "Read", requestId: "job-direct-rejected" };
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("fleet-rejected: ");
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: input.requestId })).toMatchObject({ notStarted: { reason: "rejected" } });
  });

  it("serves normal CLI output, tell and result for a direct-only studio owner without the broker", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    state.studioEvents = [{ seq: 10, type: "turn/completed" }];
    const f = await host();
    const output = await f.harness.behavior.runCli(["output", "studio", "thr_ownedexample", "--json"]);
    expect(output.stderr ?? "").toBe("");
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout!)).toMatchObject({ ok: true, machine: "studio", threadId: "thr_ownedexample", output: "studio answer for thr_ownedexample" });

    const told = await f.harness.behavior.runCli(["tell", "studio", "thr_ownedexample", "--wait", "--json", "--", "reply with nonce X"]);
    expect(told.exitCode).toBe(0);
    expect(JSON.parse(told.stdout!)).toMatchObject({ ok: true, delivered: true, delivery: "sent", output: "studio answer for thr_ownedexample" });
    const control = state.sshMutations.find((entry) => entry.command.includes("'control_deliver'"))!;
    expect(control.input).toMatchObject({ action: "send", remoteThreadId: "thr_ownedexample", targetServer: "studio-srv", text: "reply with nonce X" });
    expect(control.command).not.toContain("nonce");

    const started = await f.harness.behavior.callRpc("work_start", { machine: "studio", prompt: "Read", requestId: "job-direct-result1" });
    expect(started).toMatchObject({ outcome: "started", threadId: "thr_remote" });
    const result = await f.harness.behavior.runCli(["result", "job-direct-result1", "--json"]);
    expect(result.stderr ?? "").toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toMatchObject({ ok: true, requestId: "job-direct-result1", threadId: "thr_remote", output: "studio answer for thr_remote" });
  });

  it("reports an unreachable direct owner on tell as not sent", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    const f = await host();
    await f.harness.behavior.callRpc("snapshot_get", null);
    state.sshPreConnect = true;
    const told = await f.harness.behavior.runCli(["tell", "studio", "thr_remote", "--json", "--", "hello"]);
    expect(told.exitCode).not.toBe(0);
    expect(JSON.parse(told.stdout!)).toMatchObject({ ok: false });
  });

  it("keeps an explicitly Client A-tagged project off general starts and forces Auto routing to work only", async () => {
    const f = await host({}, false, "laptop", { projectWorkloads: JSON.stringify({ NavAIgate: "client-a" }) });
    await expect(f.harness.behavior.callRpc("work_start", { machine: "laptop", prompt: "Read", projectName: "NavAIgate", requestId: "job-tagged-0001" })).rejects.toThrow();
    const preview = await f.harness.behavior.callRpc("route_preview", { machine: "auto", projectName: "NavAIgate" });
    expect(preview).toMatchObject({ machine: null, warnings: expect.arrayContaining([expect.stringContaining("tagged Client A")]) });
    expect(f.spawned).toHaveLength(0);
  });

  it("describes an owner without an authenticated route honestly", async () => {
    const f = await host();
    const detail = await f.harness.behavior.callRpc("owner_detail_get", { machine: "work" });
    expect(detail).toMatchObject({ machine: "work", owner: null, activeRoute: "none", editorLinks: [], binding: { verified: false } });
    expect(detail.routes.find((route: { kind: string }) => route.kind === "ssh")).toMatchObject({ state: "unconfigured" });
    const self = await f.harness.behavior.callRpc("owner_detail_get", { machine: "laptop" });
    expect(self).toMatchObject({ activeRoute: "self" });
    expect(self.routes[0]).toMatchObject({ kind: "self", state: "healthy" });
  });

  it("offers an editor link only for the SSH-reachable owner's own checkout paths", async () => {
    state.sshSnapshot = { ...remoteM1(), projects: [{ id: "proj_studio", name: "Repo", kind: "standard", path: "/Users/tester/Repo" }, { id: "proj_space", name: "My Repo", kind: "standard", path: "/Users/tester/My Repo" }] } as unknown as Record<string, unknown>;
    const f = await host();
    const detail = await f.harness.behavior.callRpc("owner_detail_get", { machine: "studio" });
    expect(detail).toMatchObject({ activeRoute: "ssh", editorLinks: [{ projectId: "proj_studio", url: "vscode://vscode-remote/ssh-remote+studio-ssh/Users/tester/Repo" }, { projectId: "proj_space", url: "vscode://vscode-remote/ssh-remote+studio-ssh/Users/tester/My%20Repo" }] });
  });

  it("opens the studio owner thread's real project folder in the editor from a mirror copy", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    state.mirrorJwk = generateMirrorKeyPair().privateKey.export({ format: "jwk" }) as typeof state.mirrorJwk;
    const f = await host();
    expect(await f.harness.behavior.callRpc("mirror_owner_editor", { threadId: "thr_copy" })).toEqual({ available: true, machine: "studio", path: "/Users/tester/Documents/GitHub/My Repo", url: "vscode://vscode-remote/ssh-remote+studio-ssh/Users/tester/Documents/GitHub/My%20Repo" });
    expect(await f.harness.behavior.callRpc("mirror_owner_editor", { threadId: "thr_plain" })).toMatchObject({ available: false });
  });

  it("uploads a task's attachments into the destination project, verifies them, then starts once with native blocks", async () => {
    state.attachments.set("proj_native:att/shot.png", new Uint8Array([1, 2, 3, 4]));
    const f = await host();
    const input = { machine: "laptop", prompt: "Look at this", projectName: "NavAIgate", requestId: "job-attach-0001", attachments: [{ type: "localImage", sourceProjectId: "proj_native", path: "att/shot.png", name: "shot.png", mimeType: "image/png" }] };
    const started = await f.harness.behavior.callRpc("work_start", input);
    expect(started).toMatchObject({ outcome: "started", attachments: [{ name: "shot.png", sizeBytes: 4, verified: true }] });
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]).toMatchObject({ projectId: "proj_native", input: [{ type: "text", text: "Look at this" }, { type: "localImage", path: "uploads/1-shot.png", sourceProjectId: "proj_native" }] });
    expect(f.spawned[0]!.prompt).toBeUndefined();
    expect(await f.harness.behavior.callRpc("work_start", input)).toEqual(started);
    expect(state.uploads).toHaveLength(1);
    expect(f.spawned).toHaveLength(1);
  });

  it("refuses attachments it cannot read and attachments for an owner without a direct route, before any claim or spawn", async () => {
    const f = await host();
    const missing = { machine: "laptop", prompt: "x", requestId: "job-attach-0002", attachments: [{ type: "localFile", sourceProjectId: "proj_native", path: "missing.pdf", name: "missing.pdf", mimeType: null }] };
    await expect(f.harness.behavior.callRpc("work_start", missing)).rejects.toThrow("fleet-rejected: Attachment missing.pdf could not be read");
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: "job-attach-0002" })).toMatchObject({ state: "missing", notStarted: { reason: "rejected", message: expect.stringContaining("missing.pdf") } });
    state.attachments.set("proj_native:missing.pdf", new Uint8Array([1]));
    expect(await f.harness.behavior.callRpc("work_start", missing)).toMatchObject({ outcome: "started", attachments: [{ name: "missing.pdf", verified: true }] });
    state.attachments.set("proj_native:a.png", new Uint8Array([9]));
    const preview = await f.harness.behavior.callRpc("route_preview", { machine: "work", routing: { workload: "client-a" }, attachments: [{ type: "localImage", sourceProjectId: "proj_native", path: "a.png", name: "a.png", mimeType: "image/png" }] });
    expect(preview).toMatchObject({ machine: null, reason: expect.stringContaining("attachments need a direct authenticated owner route") });
    expect(f.spawned).toHaveLength(1);
    expect(state.uploads).toHaveLength(1);
  });

  it("sends attachment bytes to studio only through its SSH owner, then starts there with the owner-side references", async () => {
    state.sshSnapshot = { ...remoteM1(), features: [EXECUTION_FEATURE, "work-attachments-v1"] } as unknown as Record<string, unknown>;
    state.attachments.set("proj_native:att/report.pdf", new Uint8Array([7, 7, 7]));
    const f = await host();
    const started = await f.harness.behavior.callRpc("work_start", { machine: "studio", prompt: "Summarise", requestId: "job-attach-studio-01", attachments: [{ type: "localFile", sourceProjectId: "proj_native", path: "att/report.pdf", name: "report.pdf", mimeType: "application/pdf" }] });
    expect(started).toMatchObject({ outcome: "started", attachments: [{ name: "report.pdf", sizeBytes: 3, verified: true }] });
    const put = state.sshMutations.find((entry) => entry.command.includes("'work_attachments_put'"))!;
    expect(put.input).toMatchObject({ v: 1, files: [{ name: "report.pdf", mimeType: "application/pdf", contentBase64: Buffer.from([7, 7, 7]).toString("base64") }] });
    expect(put.command).not.toContain("BwcH");
    const start = state.sshMutations.find((entry) => entry.command.includes("'work_start'"))!;
    expect(start.input).toMatchObject({ projectId: "proj_studio", ownerAttachments: [{ path: "uploads/studio-0", sourceProjectId: "proj_studio", name: "report.pdf" }] });
    expect(start.input.attachments).toBeUndefined();
  });

  it("carries a 5 MB PDF and a PNG to studio whole through the spooled SSH stdin, verified by SHA-256 (F60)", async () => {
    state.sshSnapshot = { ...remoteM1(), features: [EXECUTION_FEATURE, "work-attachments-v1"] } as unknown as Record<string, unknown>;
    const pdf = new Uint8Array(5_212_401).map((_, index) => (index * 2654435761) >>> 24);
    const png = new Uint8Array(33_416).fill(137);
    state.attachments.set("proj_native:att/big.pdf", pdf);
    state.attachments.set("proj_native:att/logo.png", png);
    const f = await host();
    const started = await f.harness.behavior.callRpc("work_start", { machine: "studio", prompt: "Count the pages", requestId: "job-attach-studio-f60", attachments: [
      { type: "localFile", sourceProjectId: "proj_native", path: "att/big.pdf", name: "big.pdf", mimeType: "application/pdf" },
      { type: "localImage", sourceProjectId: "proj_native", path: "att/logo.png", name: "logo.png", mimeType: "image/png" },
    ] });
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    expect(started).toMatchObject({ outcome: "started", attachments: [{ name: "big.pdf", sizeBytes: 5_212_401, sha256: hash(pdf), verified: true }, { name: "logo.png", sizeBytes: 33_416, sha256: hash(png), verified: true }] });
    const put = state.sshMutations.find((entry) => entry.command.includes("'work_attachments_put'"))!;
    const files = put.input.files as { contentBase64: string; sha256: string }[];
    expect(files.map((file) => hash(Buffer.from(file.contentBase64, "base64")))).toEqual([hash(pdf), hash(png)]);
    expect(put.command.length).toBeLessThan(1024);
    expect(put.command).toContain('cat > "$f"');
    expect(put.command).not.toContain("/dev/stdin");
  });

  it("uses the direct studio owner for attachment jobs even while the broker is healthy", async () => {
    const snapshot = { ...remoteM1(), features: [EXECUTION_FEATURE, SEALED_RELAY_FEATURE, "work-attachments-v1"] } as Snapshot;
    state.sshSnapshot = snapshot as unknown as Record<string, unknown>;
    brokerFixture(snapshot);
    state.attachments.set("proj_native:att/a.txt", new Uint8Array([1]));
    const f = await host({}, true);
    await f.harness.behavior.callRpc("board_get", null);
    const started = await f.harness.behavior.callRpc("work_start", { machine: "studio", prompt: "Read", requestId: "job-attach-studio-healthy", attachments: [{ type: "localFile", sourceProjectId: "proj_native", path: "att/a.txt", name: "a.txt", mimeType: "text/plain" }] });
    expect(started).toMatchObject({ outcome: "started", attachments: [{ name: "a.txt", verified: true }] });
    expect(state.sshMutations.map((entry) => /'fleet' '([a-z_]+)'/.exec(entry.command)?.[1])).toEqual(["work_attachments_put", "work_start"]);
  });

  it("never turns an unknown in-flight claim into a retryable refusal", async () => {
    state.sshSnapshot = { ...remoteM1(), features: [EXECUTION_FEATURE, "work-attachments-v1"] } as unknown as Record<string, unknown>;
    state.attachments.set("proj_native:att/b.txt", new Uint8Array([2]));
    state.failMutation = true;
    const f = await host();
    const input = { machine: "studio", prompt: "Read", requestId: "job-attach-unknown1", attachments: [{ type: "localFile", sourceProjectId: "proj_native", path: "att/b.txt", name: "b.txt", mimeType: "text/plain" }] };
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("outcome is unknown");
    state.attachments.delete("proj_native:att/b.txt");
    state.failMutation = false;
    await expect(f.harness.behavior.callRpc("work_start", input)).rejects.toThrow("unknown or in-progress");
    expect(await f.harness.behavior.callRpc("work_receipt", { requestId: input.requestId })).toMatchObject({ state: "unknown" });
    expect(state.sshMutations.filter((entry) => entry.command.includes("'work_start'"))).toHaveLength(1);
  });

  it("moves a mirror reply's project attachment to the studio owner and forwards only verified owner references", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    state.attachments.set("proj_native:uploads/photo.png", new Uint8Array([9, 9, 9]));
    await host();
    const forward = state.mirrorDeps!.forwardControl;
    const result = await forward({ v: 1, id: "c".repeat(64), localThreadId: "thr_copy", targetServer: "studio-srv", remoteThreadId: "thr_ownedexample", action: "send", text: "what is this?", createdAt: Date.now(), attachments: [{ type: "localImage", path: "uploads/photo.png", sourceProjectId: "proj_native", name: "photo.png", sizeBytes: null, mimeType: "image/png" }] });
    expect(result).toMatchObject({ state: "sent" });
    const deliver = state.sshMutations.find((entry) => entry.command.includes("'control_deliver'"))!;
    expect(deliver.input).toMatchObject({ remoteThreadId: "thr_ownedexample", ownerAttachments: [{ type: "localImage", path: "uploads/studio-img-0", sourceProjectId: "proj_studio", name: "photo.png", sizeBytes: 3 }] });
    expect(deliver.input.attachments).toBeUndefined();
    const imported = state.sshMutations.find((entry) => entry.command.includes("'context_bundle_import'"))!;
    expect(imported.input).toMatchObject({ target: { serverId: "studio-srv", machineKey: "studio", projectId: "proj_studio", threadId: "thr_ownedexample" }, files: [{ name: "photo.png", mimeType: "image/png", contentBase64: Buffer.from([9, 9, 9]).toString("base64") }] });
  });

  it("answers an owner approval from the mirror only through the owner workspace with the exact fingerprint", async () => {
    state.sshSnapshot = { ...remoteM1(), features: [EXECUTION_FEATURE, "mirror-interactions-v1"] } as unknown as Record<string, unknown>;
    await host();
    const detail = await state.mirrorDeps!.interactionDetail!({ serverId: "studio-srv", machine: "studio", threadId: "thr_owned", interactionId: "int_a" });
    expect(detail).toMatchObject({ fingerprint: "a".repeat(64), payload: { kind: "approval", availableDecisions: ["deny", "allow_once"] } });
    const respond = (fingerprint: string, id: string) => state.mirrorDeps!.forwardControl({ v: 1, id, localThreadId: "thr_copy", targetServer: "studio-srv", remoteThreadId: "thr_owned", action: "respond", text: "", createdAt: Date.now(), interaction: { interactionId: "int_a", fingerprint, response: { kind: "approval", decision: "allow_once" } } });
    expect(await respond("a".repeat(64), "1".repeat(64))).toMatchObject({ state: "sent" });
    const sent = state.sshMutations.find((entry) => entry.command.includes("'interaction_respond'"))!;
    expect(sent.input).toMatchObject({ target: { serverId: "studio-srv", threadId: "thr_owned" }, interactionId: "int_a", expectedFingerprint: "a".repeat(64), response: { kind: "approval", decision: "allow_once" } });
    expect(await respond("b".repeat(64), "2".repeat(64))).toMatchObject({ state: "failed", message: expect.stringContaining("changed or expired") });
  });

  it("never offers native answers to an owner without the mirror-interactions feature", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    await host();
    expect(await state.mirrorDeps!.interactionDetail!({ serverId: "studio-srv", machine: "studio", threadId: "thr_owned", interactionId: "int_a" })).toBeNull();
    expect(await state.mirrorDeps!.forwardControl({ v: 1, id: "3".repeat(64), localThreadId: "thr_copy", targetServer: "studio-srv", remoteThreadId: "thr_owned", action: "respond", text: "", createdAt: Date.now(), interaction: { interactionId: "int_a", fingerprint: "a".repeat(64), response: { kind: "approval", decision: "deny" } } })).toMatchObject({ state: "failed" });
    expect(state.sshMutations.some((entry) => entry.command.includes("'interaction_respond'"))).toBe(false);
  });

  it("delivers a control's verified owner attachments as native blocks and refuses a mismatched one", async () => {
    state.attachments.set("proj_native:uploads/x.png", new Uint8Array([5, 5]));
    state.cliThreads = { thr_owner: { output: "" } };
    const f = await host();
    const sha = (await import("node:crypto")).createHash("sha256").update(new Uint8Array([5, 5])).digest("hex");
    const control = { v: 1, id: "a".repeat(64), localThreadId: "thr_copy", targetServer: "laptop-srv", remoteThreadId: "thr_owner", action: "send", text: "see image", createdAt: Date.now(), ownerAttachments: [{ type: "localImage", path: "uploads/x.png", sourceProjectId: "proj_native", name: "x.png", sizeBytes: 2, mimeType: "image/png", sha256: sha }] };
    expect(await f.harness.behavior.callRpc("control_deliver", control)).toMatchObject({ state: "sent" });
    expect(f.sent.at(-1)).toMatchObject({ threadId: "thr_owner", input: [{ type: "text", text: "see image" }, { type: "text", visibility: "agent-only" }, { type: "localImage", path: "uploads/x.png", sourceProjectId: "proj_native" }] });
    const bad = { ...control, id: "b".repeat(64), ownerAttachments: [{ ...control.ownerAttachments[0]!, sha256: "0".repeat(64) }] };
    expect(await f.harness.behavior.callRpc("control_deliver", bad)).toMatchObject({ state: "failed", message: expect.stringContaining("does not match its verified bytes") });
    expect(f.sent).toHaveLength(1);
  });

  it("reports broker failure separately from local and direct owner availability", async () => {
    state.brainBlocked = true;
    const f = await host({}, true);
    const route = await f.harness.behavior.callRpc("route_preview", { machine: "work", routing: { workload: "client-a" } });
    expect(route).toMatchObject({ machine: null });
    const board = await f.harness.behavior.callRpc("board_get", null);
    expect(board).toMatchObject({ me: { brain: true, backendHealthy: false }, transport: { broker: "unavailable", lastSuccessfulSyncAt: null }, error: expect.stringContaining("SQL read operations are forbidden") });
    expect(f.spawned).toHaveLength(0);
  });

  it("reports a direct owner waiting for input without treating an idle status as a completed answer", async () => {
    const output = vi.fn(async () => ({ output: "old answer" }));
    const f = await host({ get: async () => makeThreadResponse({ id: "thr_owner", projectId: "proj_native", status: "idle" }), interactions: { list: async () => [{ id: "interaction-pending" }] }, output });
    expect(await f.harness.behavior.callRpc("thread_answer_get", { threadId: "thr_owner" })).toMatchObject({ state: "needs-you", output: "" });
    expect(output).not.toHaveBeenCalled();
  });

  it("persists and delivers a full broker selection, while a legacy command retains destination defaults", async () => {
    const recipient = generateMirrorKeyPair();
    const snapshot = remoteM1();
    snapshot.features!.push(SEALED_RELAY_FEATURE);
    snapshot.mirrorKey = recipient.publicKey;
    const db = brokerFixture(snapshot);
    const source = await host({}, true);
    const workspace = { type: "managed-worktree", baseBranch: { kind: "named", name: "release" } };
    const prompt = `PRIVATE_NATIVE_CONTEXT_SENTINEL ${"context ".repeat(7500)}`.trim();
    const started = await source.harness.behavior.callRpc("work_start", { machine: "studio", prompt, title: "PRIVATE_TITLE_SENTINEL", providerId: "codex", model: "gpt-test", reasoningLevel: "high", serviceTier: "fast", projectName: "NavAIgate", workspace }) as { commandId: string };
    expect(db.prepare("SELECT provider_id,prompt,title FROM fleet_commands WHERE id = ?").get(started.commandId)).toEqual({ provider_id: null, prompt: SEALED_COMMAND_PLACEHOLDER, title: SEALED_COMMAND_PLACEHOLDER });
    const options = db.prepare("SELECT payload FROM fleet_command_options WHERE command_id = ?").get(started.commandId) as { payload: string };
    const persisted = JSON.stringify([db.prepare("SELECT * FROM fleet_commands").all(), db.prepare("SELECT * FROM fleet_command_options").all()]);
    for (const secret of ["PRIVATE_NATIVE_CONTEXT_SENTINEL", "PRIVATE_TITLE_SENTINEL", "gpt-test", "NavAIgate", "release"]) expect(persisted).not.toContain(secret);
    const content = JSON.parse(openSealed(JSON.parse(options.payload).sealed, recipient, commandAad({ id: started.commandId, fromServer: "laptop-srv", targetServer: snapshot.serverId, machine: "studio" })));
    expect(content).toMatchObject({ prompt, title: "PRIVATE_TITLE_SENTINEL" });
    expect(JSON.parse(content.options)).toMatchObject({ execution: { providerId: "codex", model: "gpt-test", reasoningLevel: "high", serviceTier: "fast" }, project: { projectName: "NavAIgate", workspace } });
    expect(await source.harness.behavior.callRpc("command_get", { commandId: started.commandId })).toMatchObject({ status: "pending", machine: "studio", threadId: null, error: null });
    db.prepare("INSERT INTO fleet_commands (id,target_server,target_host_id,prompt,status,from_server,created_at) VALUES ('legacy-command','studio-srv','studio','legacy defaults','pending','old-server',?)").run(Date.now() + 1);
    db.prepare("INSERT INTO fleet_commands (id,target_server,target_host_id,prompt,status,from_server,created_at) VALUES ('unknown-command','studio-srv','studio','uncertain native dispatch','pending','laptop-srv',?)").run(Date.now() + 2);
    db.prepare("INSERT INTO fleet_commands (id,target_server,target_host_id,prompt,status,from_server,created_at) VALUES ('badcap-command','studio-srv','studio','must not dispatch','pending','laptop-srv',?)").run(Date.now() + 3);
    db.prepare("INSERT INTO fleet_command_options VALUES (?, ?)").run("badcap-command", JSON.stringify({ execution: {}, routing: { requiredCapabilities: ["VPN"] }, project: {} }));
    db.prepare("INSERT INTO fleet_commands (id,target_server,target_host_id,prompt,status,from_server,created_at) VALUES ('client-a-command','studio-srv','studio','must remain on work','pending','laptop-srv',?)").run(Date.now() + 4);
    db.prepare("INSERT INTO fleet_command_options VALUES (?, ?)").run("client-a-command", JSON.stringify({ execution: {}, routing: { workload: "client-a" }, project: {} }));
    state.handle = "studio-srv";
    state.mirrorJwk = recipient.privateKey.export({ format: "jwk" });
    state.cliThreads = { thr_owner1: { output: "PRIVATE_NATIVE_CONTEXT_SENTINEL echoed answer" }, thr_owner2: { output: "LEGACY_PUBLIC_RESPONSE" } };
    const received: Record<string, unknown>[] = [];
    let release!: () => void;
    const receivedBoth = new Promise<void>((resolve) => { release = resolve; });
    let published!: () => void;
    const legacyPublished = new Promise<void>((resolve) => { published = resolve; });
    state.onBrokerQuery = (sql, args) => { if (sql.startsWith("INSERT INTO fleet_outputs") && args[1] === "thr_owner2") published(); };
    const destination = await host({ spawn: async (input: Record<string, unknown>) => { received.push(input); if (received.length === 3) { release(); throw new Error("native connection closed after dispatch"); } return makeThreadResponse({ id: `thr_owner${received.length}`, projectId: "proj_native" }); } }, true, "studio");
    const service = destination.harness.behavior.runService("fleet-sync");
    await receivedBoth;
    await legacyPublished;
    service.controller.abort();
    await service.done;
    expect(received[0]).toMatchObject({ providerId: "codex", model: "gpt-test", reasoningLevel: "high", serviceTier: "fast", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit" } });
    expect(received[0]).toMatchObject({ environment: { type: "host", hostId: "host_studio", workspace } });
    expect(received[0]).toMatchObject({ prompt, title: "PRIVATE_TITLE_SENTINEL" });
    expect(received[1]).not.toHaveProperty("providerId");
    expect(received[1]).not.toHaveProperty("model");
    expect(db.prepare("SELECT status FROM fleet_commands ORDER BY created_at").all()).toEqual([{ status: "started" }, { status: "started" }, { status: "unknown" }, { status: "failed" }, { status: "failed" }]);
    expect(await source.harness.behavior.callRpc("command_get", { commandId: started.commandId })).toMatchObject({ status: "started", machine: "studio", threadId: "thr_owner1", error: null });
    expect(await destination.harness.behavior.callRpc("command_get", { commandId: started.commandId })).toMatchObject({ status: "unknown", machine: null, threadId: null, error: expect.stringContaining("this sender") });
    expect(await source.harness.behavior.callRpc("command_get", { commandId: "unknown-command" })).toMatchObject({ status: "unknown", machine: "studio", threadId: null, error: expect.stringContaining("do not resend automatically") });
    expect(await source.harness.behavior.callRpc("command_get", { commandId: "badcap-command" })).toMatchObject({ status: "failed", error: expect.stringContaining("not independently verified") });
    expect(await source.harness.behavior.callRpc("command_get", { commandId: "client-a-command" })).toMatchObject({ status: "failed", error: expect.stringContaining("Work's host-local access") });
    expect(received).toHaveLength(3);
    expect(destination.bb.storage.database().prepare("SELECT reason FROM fleet_private_threads WHERE thread_id = 'thr_owner1'").get()).toEqual({ reason: "sealed-command" });
    expect(state.cliOutputReads).toEqual(["thr_owner2"]);
    expect(db.prepare("SELECT thread_id,state,output,output_hash FROM fleet_outputs ORDER BY thread_id").all()).toEqual([
      { thread_id: "thr_owner1", state: "private", output: "", output_hash: "private" },
      { thread_id: "thr_owner2", state: "idle", output: "LEGACY_PUBLIC_RESPONSE", output_hash: expect.any(String) },
    ]);
    expect(JSON.stringify(db.prepare("SELECT * FROM fleet_outputs").all())).not.toContain("PRIVATE_NATIVE_CONTEXT_SENTINEL");
    const privateResult = await source.harness.behavior.runCli(["result", started.commandId, "--json"]);
    expect(privateResult).toMatchObject({ exitCode: 1, stdout: expect.stringContaining("private_output") });
  });
});

describe("sealed native broker transport", () => {
  it("refuses new broker jobs and controls on an older peer without writing plaintext", async () => {
    const snapshot = remoteM1();
    snapshot.features!.push("controls-v1");
    const db = brokerFixture(snapshot);
    state.mirrorJwk = generateMirrorKeyPair().privateKey.export({ format: "jwk" });
    const source = await host({}, true);
    const forward = state.mirrorDeps!.forwardControl;
    await expect(source.harness.behavior.callRpc("work_start", { machine: "studio", prompt: "MUST_NOT_PERSIST_SENTINEL" })).rejects.toThrow("plaintext downgrade");
    expect(await forward({ v: 1, id: "c".repeat(64), localThreadId: "thr_copy", targetServer: snapshot.serverId, remoteThreadId: "thr_owner", action: "send", text: "MUST_NOT_PERSIST_SENTINEL", createdAt: 10 })).toMatchObject({ state: "unavailable", message: expect.stringContaining("plaintext control downgrade") });
    expect(db.prepare("SELECT COUNT(*) AS n FROM fleet_commands").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('fleet_command_options','fleet_message_controls')").all().flatMap(({ name }) => db.prepare(`SELECT * FROM ${name}`).all())).toEqual([]);
  });

  it.each(["wrong-key", "sender", "command-id", "machine", "missing-envelope"])("rejects an encrypted command with %s before native spawn", async (tamper) => {
    const recipient = generateMirrorKeyPair();
    const snapshot = remoteM1();
    snapshot.features!.push(SEALED_RELAY_FEATURE); snapshot.mirrorKey = recipient.publicKey;
    const db = brokerFixture(snapshot);
    const source = await host({}, true);
    const accepted = await source.harness.behavior.callRpc("work_start", { machine: "studio", prompt: "SECRET_TAMPER_SENTINEL" }) as { commandId: string };
    if (tamper === "sender") db.prepare("UPDATE fleet_commands SET from_server = 'moved-sender' WHERE id = ?").run(accepted.commandId);
    if (tamper === "command-id") {
      db.prepare("UPDATE fleet_commands SET id = 'moved-command' WHERE id = ?").run(accepted.commandId);
      db.prepare("UPDATE fleet_command_options SET command_id = 'moved-command' WHERE command_id = ?").run(accepted.commandId);
    }
    if (tamper === "machine") db.prepare("UPDATE fleet_commands SET target_host_id = 'laptop' WHERE id = ?").run(accepted.commandId);
    if (tamper === "missing-envelope") db.prepare("DELETE FROM fleet_command_options WHERE command_id = ?").run(accepted.commandId);
    state.handle = snapshot.serverId;
    state.mirrorJwk = (tamper === "wrong-key" ? generateMirrorKeyPair() : recipient).privateKey.export({ format: "jwk" });
    let failed!: () => void;
    const rejected = new Promise<void>((resolve) => { failed = resolve; });
    state.onBrokerQuery = (sql, args) => { if (sql.startsWith("UPDATE fleet_commands SET status = ?") && args[0] === "failed") failed(); };
    const destination = await host({}, true, "studio");
    const service = destination.harness.behavior.runService("fleet-sync");
    await rejected; service.controller.abort(); await service.done;
    expect(destination.spawned).toHaveLength(0);
    expect(db.prepare("SELECT status,error FROM fleet_commands").get()).toEqual({ status: "failed", error: "Encrypted command could not be opened or accepted by its owner; inspect the owner locally for details" });
  });

  it.each(["valid", "wrong-key", "thread", "action", "missing-envelope"])("keeps native control text sealed and handles a %s envelope before native send", async (tamper) => {
    const recipient = generateMirrorKeyPair();
    const snapshot = remoteM1();
    snapshot.features!.push("controls-v1", SEALED_RELAY_FEATURE); snapshot.mirrorKey = recipient.publicKey;
    const db = brokerFixture(snapshot);
    state.mirrorJwk = generateMirrorKeyPair().privateKey.export({ format: "jwk" });
    const source = await host({}, true);
    const forward = state.mirrorDeps!.forwardControl;
    await source.harness.behavior.callRpc("route_preview", { machine: "studio" });
    const request = { v: 1, id: "d".repeat(64), localThreadId: "thr_copy", targetServer: snapshot.serverId, remoteThreadId: "thr_owner", action: "send", text: "PRIVATE_FOLLOWUP_SENTINEL", createdAt: 10 };
    expect(await forward(request)).toMatchObject({ state: "accepted" });
    expect(db.prepare("SELECT body FROM fleet_messages WHERE id = ?").get(request.id)).toEqual({ body: SEALED_CONTROL_PLACEHOLDER });
    const stored = JSON.stringify([db.prepare("SELECT * FROM fleet_messages").all(), db.prepare("SELECT * FROM fleet_message_controls").all()]);
    expect(stored).not.toContain(request.text);
    if (tamper === "thread") db.prepare("UPDATE fleet_messages SET thread_id = 'thr_other' WHERE id = ?").run(request.id);
    if (tamper === "action") {
      const row = db.prepare("SELECT payload FROM fleet_message_controls WHERE message_id = ?").get(request.id) as { payload: string };
      db.prepare("UPDATE fleet_message_controls SET payload = ? WHERE message_id = ?").run(JSON.stringify({ ...JSON.parse(row.payload), action: "steer" }), request.id);
    }
    if (tamper === "missing-envelope") db.prepare("DELETE FROM fleet_message_controls WHERE message_id = ?").run(request.id);
    state.handle = snapshot.serverId;
    state.mirrorJwk = (tamper === "wrong-key" ? generateMirrorKeyPair() : recipient).privateKey.export({ format: "jwk" });
    state.cliThreads[request.remoteThreadId] = { output: "PRIVATE_FOLLOWUP_SENTINEL echoed answer" };
    db.prepare("INSERT INTO fleet_outputs (server_id,thread_id,state,output,output_hash,truncated,updated_at) VALUES (?,?, 'idle','old legacy answer','old',0,?)").run(snapshot.serverId, request.remoteThreadId, Date.now());
    let delivered!: () => void;
    const handled = new Promise<void>((resolve) => { delivered = resolve; });
    const received: Record<string, unknown>[] = [];
    state.onBrokerQuery = (sql) => { if (sql.startsWith("UPDATE fleet_messages SET status = 'failed'") || sql.startsWith("UPDATE fleet_messages SET status = 'delivered'")) delivered(); };
    const destination = await host({ send: async (input: Record<string, unknown>) => { received.push(input); return { ok: true, delivery: "sent" }; } }, true, "studio");
    const service = destination.harness.behavior.runService("fleet-sync");
    await handled; service.controller.abort(); await service.done;
    if (tamper === "valid") {
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ threadId: request.remoteThreadId, input: mirrorControlInput(request) });
      expect(db.prepare("SELECT status,body FROM fleet_messages").get()).toEqual({ status: "delivered", body: "" });
      expect(destination.bb.storage.database().prepare("SELECT reason FROM fleet_private_threads WHERE thread_id = ?").get(request.remoteThreadId)).toEqual({ reason: "native-control" });
      // The first relay read precedes owner delivery, so a second cycle applies
      // the durable private policy in the next publisher cycle.
      let replaced!: () => void;
      const tombstoned = new Promise<void>((resolve) => { replaced = resolve; });
      state.onBrokerQuery = (sql) => { if (sql.startsWith("INSERT INTO fleet_outputs")) replaced(); };
      const second = destination.harness.behavior.runService("fleet-sync");
      await tombstoned; second.controller.abort(); await second.done;
      expect(db.prepare("SELECT state,output,output_hash FROM fleet_outputs WHERE thread_id = ?").get(request.remoteThreadId)).toEqual({ state: "private", output: "", output_hash: "private" });
      expect(state.cliOutputReads).toEqual([]);
    } else {
      expect(received).toHaveLength(0);
      expect(db.prepare("SELECT status,error FROM fleet_messages").get()).toEqual({ status: "failed", error: "Encrypted control could not be opened or accepted by its owner; inspect the owner locally for details" });
    }
    expect(JSON.stringify(db.prepare("SELECT * FROM fleet_messages").all())).not.toContain(request.text);
  });
});

describe("owner control receipts and stop scope", () => {
  const control = { v: 1, id: "a".repeat(64), localThreadId: "thr_copy", targetServer: "laptop-srv", remoteThreadId: "thr_owner", action: "send", text: "Continue", createdAt: 10 };
  it.each(["message.dispatched", "message.cancelled"] as const)("reconciles a queued owner receipt from its scoped native %s event", async (event) => {
    const entry = makeQueueEntry({ id: "queue-control", threadId: control.remoteThreadId, content: mirrorControlInput(control) as never });
    let sends = 0;
    const f = await host({ send: async () => { sends += 1; return { ok: true, delivery: "queued", queuedMessage: entry }; } });
    expect(await f.harness.behavior.callRpc("control_deliver", control)).toMatchObject({ state: "queued" });
    await f.harness.behavior.emitThreadEvent(event, { entry: { ...entry, threadId: "thr_other" } });
    expect(await f.harness.behavior.callRpc("control_receipt", { id: control.id, remoteThreadId: control.remoteThreadId })).toMatchObject({ state: "queued" });
    await f.harness.behavior.emitThreadEvent(event, { entry });
    const expected = event === "message.dispatched" ? "sent" : "failed";
    expect(await f.harness.behavior.callRpc("control_receipt", { id: control.id, remoteThreadId: control.remoteThreadId })).toMatchObject({ state: expected });
    expect(await f.harness.behavior.callRpc("control_deliver", control)).toMatchObject({ state: expected });
    expect(sends).toBe(1);
  });
  it("persists an uncertain delivery and never sends it twice", async () => {
    let calls = 0;
    const f = await host({ send: async () => { calls += 1; throw new Error("connection closed after input acceptance"); } });
    expect(await f.harness.behavior.callRpc("control_deliver", control)).toMatchObject({ state: "unknown" });
    expect(await f.harness.behavior.callRpc("control_deliver", control)).toMatchObject({ state: "unknown" });
    expect(calls).toBe(1);
  });

  it("refuses to stop a newer unrelated turn", async () => {
    const f = await host({ events: { list: async () => [{ type: "turn/started", scope: { turnId: "turn-newer" }, data: {} }] } });
    expect(await f.harness.behavior.callRpc("control_deliver", { ...control, action: "stop", text: "", expectedRemoteTurnId: "turn-original" })).toMatchObject({ state: "failed", message: expect.stringContaining("newer turn was not stopped") });
    expect(f.stopped).toHaveLength(0);
  });

  it("does not treat absent owner turn identities as a stop match", async () => {
    const f = await host({ events: { list: async () => [{ type: "turn/started", data: {} }] } });
    expect(await f.harness.behavior.callRpc("control_deliver", { ...control, action: "stop", text: "" })).toMatchObject({ state: "failed" });
    expect(f.stopped).toHaveLength(0);
  });

  it.each([
    { type: "turn/started", scope: { turnId: "turn-newer" }, data: {} },
    { type: "turn/completed", scope: { turnId: "turn-original" }, data: {} },
  ])("does not deliver a delayed steer to a newer or finished turn", async (event) => {
    const f = await host({ events: { list: async () => [event] } });
    expect(await f.harness.behavior.callRpc("control_deliver", { ...control, action: "steer", expectedRemoteTurnId: "turn-original" })).toMatchObject({ state: "failed", message: expect.stringContaining("was not steered") });
    expect(f.sent).toHaveLength(0);
  });

  it("steers the displayed owner turn once while preserving the native control marker", async () => {
    const f = await host({ events: { list: async () => [{ type: "turn/started", scope: { turnId: "turn-original" }, data: {} }] } });
    const input = { ...control, action: "steer", expectedRemoteTurnId: "turn-original" };
    expect(await f.harness.behavior.callRpc("control_deliver", input)).toMatchObject({ state: "sent" });
    expect(await f.harness.behavior.callRpc("control_deliver", input)).toMatchObject({ state: "sent" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ threadId: "thr_owner", mode: "steer", input: mirrorControlInput(control) });
  });

  it("cancels only queued messages carrying the specified control IDs", async () => {
    const removed: string[] = [];
    const cancelledId = "b".repeat(64);
    const f = await host({
      queuedMessages: {
        list: async () => [{ id: "queue-ours", content: mirrorControlInput({ id: cancelledId, text: "ours" }) }, { id: "queue-unrelated", content: [{ type: "text", text: "other" }] }],
        delete: async ({ queuedMessageId }: { queuedMessageId: string }) => { removed.push(queuedMessageId); return { ok: true }; },
      },
      events: { list: async () => [{ type: "turn/started", scope: { turnId: "turn-unrelated" }, data: {} }] },
    });
    expect(await f.harness.behavior.callRpc("control_deliver", { ...control, action: "stop", text: "", cancelRequestIds: [cancelledId] })).toMatchObject({ state: "sent" });
    expect(removed).toEqual(["queue-ours"]);
    expect(f.stopped).toHaveLength(0);
    expect(await f.harness.behavior.callRpc("control_deliver", { ...control, id: cancelledId, text: "late delivery" })).toMatchObject({ state: "failed", message: expect.stringContaining("cancelled") });
    expect(f.sent).toHaveLength(0);
  });
});

describe("board and owner reads under a polling storm", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("builds the board once for 50 concurrent calls and asks the unreachable studio once", async () => {
    const f = await host({}, false, "laptop");
    state.snapshotCalls = 0;
    const answers = await Promise.all(Array.from({ length: 50 }, () => f.harness.behavior.callRpc("board_get", null)));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(state.snapshotCalls).toBeLessThanOrEqual(1);
  });

  it("does not ask an unreachable studio again within the retry window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await host({}, true, "laptop");
    await f.harness.behavior.callRpc("board_get", null);
    const first = state.snapshotCalls;
    expect(first).toBeGreaterThan(0);
    vi.setSystemTime(Date.now() + 5_000);
    await f.harness.behavior.callRpc("board_get", null);
    vi.setSystemTime(Date.now() + 5_000);
    await f.harness.behavior.callRpc("board_get", null);
    expect(state.snapshotCalls).toBe(first);
    vi.setSystemTime(Date.now() + 16_000);
    await f.harness.behavior.callRpc("board_get", null);
    expect(state.snapshotCalls).toBeGreaterThan(first);
  });

  it("lets a user action try the unreachable studio again inside the board retry window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await host({}, true, "laptop");
    await f.harness.behavior.callRpc("board_get", null);
    const afterBoard = state.snapshotCalls;
    expect(afterBoard).toBeGreaterThan(0);
    vi.setSystemTime(Date.now() + 5_000);
    await f.harness.behavior.callRpc("route_preview", { machine: "studio" });
    expect(state.snapshotCalls).toBeGreaterThan(afterBoard);
    const afterAction = state.snapshotCalls;
    vi.setSystemTime(Date.now() + 1_000);
    await f.harness.behavior.callRpc("board_get", null);
    expect(state.snapshotCalls).toBe(afterAction);
  });

  it("lets an explicit status read try the unreachable studio again inside the board retry window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await host({}, true, "laptop");
    await f.harness.behavior.callRpc("board_get", null);
    const afterBoard = state.snapshotCalls;
    vi.setSystemTime(Date.now() + 5_000);
    await f.harness.behavior.runCli(["status", "--json"]);
    expect(state.snapshotCalls).toBeGreaterThan(afterBoard);
  });

  it("answers 50 concurrent owner detail reads for one machine with one owner read", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    const f = await host();
    const answers = await Promise.all(Array.from({ length: 50 }, () => f.harness.behavior.callRpc("owner_detail_get", { machine: "studio" })));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(state.snapshotCalls).toBe(1);
  });

  it("keeps different machines apart", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    const f = await host();
    const [studio, work] = await Promise.all([f.harness.behavior.callRpc("owner_detail_get", { machine: "studio" }), f.harness.behavior.callRpc("owner_detail_get", { machine: "work" })]);
    expect(studio.machine).toBe("studio");
    expect(work.machine).toBe("work");
  });

  it("serves a fresh board after work starts instead of the answer kept before it", async () => {
    const f = await host({}, false, "laptop");
    const before = await f.harness.behavior.callRpc("board_get", null);
    await f.harness.behavior.callRpc("work_start", { machine: "laptop", prompt: "Read", requestId: "job-board-refresh-1" });
    const after = await f.harness.behavior.callRpc("board_get", null);
    expect(after).not.toBe(before);
  });
});

describe("background services stop within the host budget", () => {
  const STOP_BUDGET_MS = 4000;
  const outcome = (done: Promise<unknown>) => Promise.race([done.then(() => "stopped"), new Promise<string>((resolve) => setTimeout(() => resolve("did not stop"), STOP_BUDGET_MS))]);
  const mirrorHost = async () => {
    state.mirrorJwk = generateMirrorKeyPair().privateKey.export({ format: "jwk" }) as typeof state.mirrorJwk;
    return host({}, true);
  };

  it("stops fleet-mirror when the stop signal lands while a tick is running and the tick then finishes", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    state.mirrorTick = () => { started(); return new Promise<void>((resolve) => { finish = resolve; }); };
    const f = await mirrorHost();
    const service = f.harness.behavior.runService("fleet-mirror");
    await running;
    service.controller.abort();
    finish();
    expect(await outcome(service.done)).toBe("stopped");
  });

  it("stops fleet-mirror while a tick never settles", { timeout: 10_000 }, async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    state.mirrorTick = () => { started(); return new Promise<void>(() => {}); };
    const f = await mirrorHost();
    const service = f.harness.behavior.runService("fleet-mirror");
    await running;
    service.controller.abort();
    expect(await outcome(service.done)).toBe("stopped");
  });

  it("stops fleet-mirror while it waits between ticks", async () => {
    const f = await mirrorHost();
    const service = f.harness.behavior.runService("fleet-mirror");
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.controller.abort();
    expect(await outcome(service.done)).toBe("stopped");
  });

  it("stops fleet-sync while a brain request never answers", { timeout: 10_000 }, async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    state.brain = { batch: () => { started(); return new Promise(() => {}); }, query: () => { started(); return new Promise(() => {}); } };
    const f = await host({}, true);
    const service = f.harness.behavior.runService("fleet-sync");
    await running;
    service.controller.abort();
    expect(await outcome(service.done)).toBe("stopped");
  });
});

describe("fleet channels (F78)", () => {
  it("saves the nightly host and pin, and the next matrix and refusal use them without a reload", async () => {
    const f = await host({}, false, "laptop");
    expect(await f.harness.behavior.callRpc("updates_policy_get", null)).toEqual({ testMachine: "studio", pinnedVersion: null });
    const saved = await f.harness.behavior.callRpc("updates_policy_set", { testMachine: "laptop", pinnedVersion: "0.48.1" });
    expect(saved).toEqual({ testMachine: "laptop", pinnedVersion: "0.48.1" });
    expect(await f.harness.behavior.callRpc("updates_policy_get", null)).toEqual({ testMachine: "laptop", pinnedVersion: "0.48.1" });
    expect(await f.harness.behavior.callRpc("updates_matrix", null)).toMatchObject({ policy: { testMachine: "laptop", pinnedVersion: "0.48.1" } });
    expect((await f.harness.behavior.callRpc("updates_matrix", null)).rows.map((row: { machine: string }) => row.machine)).toEqual(["laptop", "studio", "work"]);
  });

  it("switches staging off when no machine is the nightly host", async () => {
    const f = await host({}, false, "laptop");
    await f.harness.behavior.callRpc("updates_policy_set", { testMachine: null, pinnedVersion: null });
    expect(await f.harness.behavior.callRpc("updates_policy_get", null)).toEqual({ testMachine: null, pinnedVersion: null });
  });
});

describe("ask, tell, output and receipts from the UI (F06)", () => {
  async function studioHost() {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    state.studioEvents = [{ seq: 10, type: "turn/completed" }];
    const f = await host();
    await f.harness.behavior.callRpc("snapshot_get", null);
    return f;
  }

  it("tells a thread on studio once, even if the same request is submitted twice", async () => {
    const f = await studioHost();
    const input = { machine: "studio", threadId: "thr_ownedexample", message: "reply with nonce X", requestId: "tell-ui-0000001" };
    const first = await f.harness.behavior.callRpc("thread_tell", input);
    expect(first).toMatchObject({ requestId: "tell-ui-0000001", delivered: true, delivery: "sent", threadId: "thr_ownedexample", machine: "studio" });
    const second = await f.harness.behavior.callRpc("thread_tell", input);
    expect(second).toEqual(first);
    expect(state.sshMutations.filter((entry) => entry.command.includes("'control_deliver'"))).toHaveLength(1);
    await expect(f.harness.behavior.callRpc("thread_tell", { ...input, message: "something else" })).rejects.toThrow("identity");
  });

  it("does not report a tell as sent when studio cannot be reached, and lets the same request be retried", async () => {
    const f = await studioHost();
    state.sshPreConnect = true;
    const input = { machine: "studio", threadId: "thr_ownedexample", message: "hello", requestId: "tell-ui-0000002" };
    await expect(f.harness.behavior.callRpc("thread_tell", input)).rejects.toThrow("nothing was sent");
    state.sshPreConnect = false;
    expect(await f.harness.behavior.callRpc("thread_tell", input)).toMatchObject({ delivered: true });
  });

  it("never re-sends a tell whose outcome is unknown, and says so instead of a schema error", async () => {
    const f = await studioHost();
    const input = { machine: "studio", threadId: "thr_ownedexample", message: "maybe sent", requestId: "tell-ui-0000003" };
    state.failMutation = true;
    await expect(f.harness.behavior.callRpc("thread_tell", input)).rejects.toThrow();
    state.failMutation = false;
    await expect(f.harness.behavior.callRpc("thread_tell", input)).rejects.toThrow("may already have been sent");
  });

  it("reads a remote thread's latest answer", async () => {
    const f = await studioHost();
    expect(await f.harness.behavior.callRpc("thread_output_get", { machine: "studio", threadId: "thr_ownedexample" })).toMatchObject({ machine: "studio", threadId: "thr_ownedexample", output: "studio answer for thr_ownedexample", state: "idle" });
  });

  it("re-reads an ask by its request id as often as needed and says when it is still working", async () => {
    const f = await studioHost();
    await f.harness.behavior.callRpc("work_start", { machine: "studio", prompt: "Read", requestId: "job-ui-ask-0001" });
    const again = await f.harness.behavior.callRpc("receipt_result", { id: "job-ui-ask-0001" });
    expect(again).toMatchObject({ state: "ready", threadId: "thr_remote", answer: { output: "studio answer for thr_remote" } });
    expect(await f.harness.behavior.callRpc("receipt_result", { id: "job-ui-ask-0001" })).toMatchObject({ state: "ready", threadId: again.threadId, answer: { output: again.answer.output } });
    state.studioAnswerState = "running";
    expect(await f.harness.behavior.callRpc("receipt_result", { id: "job-ui-ask-0001" })).toMatchObject({ state: "pending" });
  });

  it("says plainly when an id is unknown instead of throwing", async () => {
    const f = await studioHost();
    expect(await f.harness.behavior.callRpc("receipt_result", { id: "job-never-sent-1" })).toMatchObject({ state: "failed", answer: null, message: expect.any(String) });
  });

  it("lists what was sent from here, newest first, for asks and tells", async () => {
    const f = await studioHost();
    await f.harness.behavior.callRpc("work_start", { machine: "studio", prompt: "Read", requestId: "job-ui-list-0001" });
    await f.harness.behavior.callRpc("thread_tell", { machine: "studio", threadId: "thr_remote", message: "and then?", requestId: "tell-ui-list-001" });
    const list = await f.harness.behavior.callRpc("receipts_list", null);
    expect(list.map((row: { id: string; kind: string }) => [row.id, row.kind])).toEqual([["tell-ui-list-001", "tell"], ["job-ui-list-0001", "ask"]]);
    expect(list[1]).toMatchObject({ machine: "studio", threadId: "thr_remote", status: "completed" });
  });
});

describe("project creation target and terminal facts (F65, F18)", () => {
  it("lists the projects the independent studio owner reports, with their paths, in its detail", async () => {
    state.sshSnapshot = { ...remoteM1(), projects: [{ id: "proj_studio", name: "Repo", kind: "standard", path: "/Users/tester/Repo" }, { id: "proj_personal", name: "Personal", kind: "personal" }] } as unknown as Record<string, unknown>;
    const f = await host();
    const detail = await f.harness.behavior.callRpc("owner_detail_get", { machine: "studio" });
    expect(detail.projects).toEqual([{ id: "proj_studio", name: "Repo", path: "/Users/tester/Repo" }, { id: "proj_personal", name: "Personal", path: null }]);
    expect(detail.owner).toMatchObject({ serverId: "studio-srv", hostId: "host_studio" });
  });

  it("reports the studio ssh alias and whether this Mac's own host is proven, for the terminal button", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    const f = await host();
    const detail = await f.harness.behavior.callRpc("owner_detail_get", { machine: "studio" });
    expect(detail.terminal).toEqual({ sshAlias: "studio-ssh", sshVerified: true, localHostId: null });
    const own = await f.harness.behavior.callRpc("owner_detail_get", { machine: "laptop" });
    expect(own.terminal.sshAlias).toBeNull();
  });

  it("gives the exact owner target to create a project on studio over its authenticated route", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    const f = await host();
    expect(await f.harness.behavior.callRpc("owner_project_target_get", { machine: "studio" })).toEqual({ serverId: "studio-srv", machineKey: "studio", hostId: "host_studio", projectId: null, environmentId: null });
  });

  it("refuses to guess a target for work or for a Mac whose own host is not proven", async () => {
    const f = await host();
    await expect(f.harness.behavior.callRpc("owner_project_target_get", { machine: "work" })).rejects.toThrow("no-authenticated-owner-route");
    await expect(f.harness.behavior.callRpc("owner_project_target_get", { machine: "laptop" })).rejects.toThrow("not proven");
  });

  it("sends project_prepare for studio through the authenticated owner route and returns its receipt", async () => {
    state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
    const f = await host();
    await f.harness.behavior.callRpc("snapshot_get", null);
    const target = await f.harness.behavior.callRpc("owner_project_target_get", { machine: "studio" });
    const requestId = "00000000-0000-4000-8000-000000000004";
    const receipt = await f.harness.behavior.callRpc("project_prepare", { target, requestId, prepare: { mode: "create_project", path: "/Users/tester/Documents/GitHub/demo", name: "demo", expectedRemoteUrl: null } });
    expect(receipt).toMatchObject({ requestId });
    expect(state.sshMutations.some((call) => call.command.includes("'project_prepare'"))).toBe(true);
  });
});

describe("account on thread cards and the verified SSH route (F03, F18)", () => {
  const listed = (id: string) => makeThreadResponse({ id, projectId: "proj_native", status: "idle", title: id, updatedAt: Date.now(), visibility: "visible", archivedAt: null } as never);

  it("publishes the account each of this Mac's chats last ran on, and only for those chats", async () => {
    state.threadAccounts = { threads: { thr_a: { accountId: "pool-1", label: "sam", email: "sam@example.com", harness: "claude" } } };
    const f = await host({ list: async () => [listed("thr_a"), listed("thr_b")] });
    const snapshot = await f.harness.behavior.callRpc("snapshot_get", null) as Snapshot;
    expect(snapshot.threads.find((t) => t.id === "thr_a")?.account).toEqual({ label: "sam", email: "sam@example.com", harness: "claude" });
    expect(snapshot.threads.find((t) => t.id === "thr_b")?.account).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("pool-1");
  });

  it("still publishes the chats when the Console cannot say which account they use", async () => {
    const f = await host({ list: async () => [listed("thr_a")] });
    const snapshot = await f.harness.behavior.callRpc("snapshot_get", null) as Snapshot;
    expect(snapshot.threads.map((t) => t.id)).toEqual(["thr_a"]);
    expect(snapshot.threads[0]?.account).toBeUndefined();
  });

  it("asks the Console once for several snapshots inside its window", async () => {
    state.threadAccounts = { threads: {} };
    const f = await host({ list: async () => [listed("thr_a")] });
    await f.harness.behavior.callRpc("snapshot_get", null);
    await f.harness.behavior.callRpc("snapshot_get", null);
    expect(state.accountCalls).toBe(1);
  });

  it("offers no SSH terminal while the studio route is not authenticated, even though the alias exists", async () => {
    state.sshSnapshot = null;
    const f = await host();
    const detail = await f.harness.behavior.callRpc("owner_detail_get", { machine: "studio" });
    expect(detail.routes.find((route: { kind: string }) => route.kind === "ssh")).toMatchObject({ state: "unavailable" });
    expect(detail.terminal).toMatchObject({ sshAlias: "studio-ssh", sshVerified: false });
  });
});

describe("Fleet on the profile", () => {
  const withProfile = async (path: string | undefined, body: () => Promise<void>) => {
    const before = process.env.NAVAIGATE_CONSOLE_PROFILE;
    if (path === undefined) delete process.env.NAVAIGATE_CONSOLE_PROFILE; else process.env.NAVAIGATE_CONSOLE_PROFILE = path;
    try { await body(); }
    finally { if (before === undefined) delete process.env.NAVAIGATE_CONSOLE_PROFILE; else process.env.NAVAIGATE_CONSOLE_PROFILE = before; }
  };

  it("on community defaults shows just this Mac, with every remote feature inert and nothing sent to an SSH alias", async () => {
    await withProfile("/nonexistent/community-profile.json", async () => {
      state.sshSnapshot = remoteM1() as unknown as Record<string, unknown>;
      const f = await host({}, false, "this-mac", { machineKey: "", machineLabel: "" });
      const board = await f.harness.behavior.callRpc("board_get", null);
      expect(board.me).toMatchObject({ machineKey: "this-mac", label: "This Mac", joined: false });
      expect(board.columns.map((column: { key: string }) => column.key)).toEqual(["this-mac"]);
      expect(board.transport).toMatchObject({ directOwner: "unconfigured", directMachine: null });
      const profile = await f.harness.behavior.callRpc("profile_get", null);
      expect(profile.machines.map((machine: { id: string }) => machine.id)).toEqual(["this-mac"]);
      expect(await f.harness.behavior.callRpc("updates_policy_get", null)).toEqual({ testMachine: null, pinnedVersion: null });
      expect(state.snapshotCalls).toBe(0);
      expect(state.sshMutations).toHaveLength(0);
    });
  });

  it("serves the resolved profile to the browser, in the owner's machine order", async () => {
    const f = await host();
    const profile = await f.harness.behavior.callRpc("profile_get", null);
    expect(profile.machines.map((machine: { id: string; label: string }) => [machine.id, machine.label])).toEqual([["laptop", "Laptop"], ["studio", "Studio"], ["work", "Work"]]);
    expect(profile.machines[2]).toEqual({ id: "work", label: "Work", role: "restricted", restricted: true });
    expect(Object.keys(profile).sort()).toEqual(["machines", "picksOff", "setupDone"]);
    expect(profile.picksOff).toEqual([]);
  });

  /** A community profile whose picks switch the named Fleet features off; ticked-off ids are false, the rest absent. */
  const withPicks = async (off: string[], body: () => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-picks-"));
    const path = join(dir, "profile.json");
    const base = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/profile.json", import.meta.url)), "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...base, edition: "community", features: { preset: null, picks: Object.fromEntries(off.map((id) => [id, false])) } }));
    try { await withProfile(path, body); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it("sends the browser the Fleet features switched off, and nothing else of the picks", async () => {
    await withPicks(["F07", "F18", "F99"], async () => {
      const f = await host();
      expect((await f.harness.behavior.callRpc("profile_get", null)).picksOff).toEqual(["F07", "F18"]);
    });
  });

  it("refuses MCP control, the simulator, the browser, updates and a new project with a plain message while their features are off", async () => {
    await withPicks(["F07", "F21", "F22", "F26", "F78", "F65", "F29", "F06"], async () => {
      const f = await host();
      const call = (method: string, input: unknown) => f.harness.behavior.callRpc(method as never, input as never);
      await expect(call("mcp_enable", { enabled: true })).rejects.toThrow("MCP on/off is switched off");
      await expect(call("simulator_forward", { machine: "laptop", call: { method: "simulator_list", input: null } })).rejects.toThrow("Simulators is switched off");
      await expect(call("browser_forward", { machine: "laptop", call: { method: "owner_browser_instances", input: null } })).rejects.toThrow("Browser is switched off");
      await expect(call("update_dispatch", { v: 1, machine: "studio", intentId: "fleet-studio-0481-abc123", fromVersion: "0.48.0", targetVersion: "0.48.1", mode: "native" })).rejects.toThrow("Versions and updates is switched off");
      await expect(call("provider_update_dispatch", { v: 1, machine: "studio", requestId: "fleet-studio-codex-abc123", provider: "codex", expectedFromVersion: null })).rejects.toThrow("Versions and updates is switched off");
      await expect(call("updates_policy_set", { testMachine: null, pinnedVersion: null })).rejects.toThrow("Update channels and Pin version is switched off");
      await expect(call("project_prepare", { target: { serverId: "srv_a", machineKey: "laptop", hostId: "host_laptop", projectId: null, environmentId: null }, requestId: randomUUID(), prepare: { mode: "create_project", path: "/tmp/demo", name: "demo", expectedRemoteUrl: null } })).rejects.toThrow("New project on a machine is switched off");
      await expect(call("transfer_candidates", { projectId: "prj_none" })).rejects.toThrow("Ignored files transfer is switched off");
      await expect(call("thread_tell", { machine: "studio", threadId: "thr_abc123", message: "hi" })).rejects.toThrow("Tell and Ask is switched off");
    });
  });

  it("starts and serves the board with machines enrolment switched off, ignoring a saved host alias", async () => {
    await withPicks(["F82"], async () => {
      const f = await host({}, false, "laptop", { hostAliases: JSON.stringify({ "laptop-host": "studio" }) });
      const board = await f.harness.behavior.callRpc("board_get", null);
      expect(board.me.machineKey).toBe("laptop");
      expect(board.columns.map((column: { key: string }) => column.key)).toContain("laptop");
    });
  });

  it("hides the terminal from the owner detail while the terminal is off, and shows it again when it is on", async () => {
    state.sshSnapshot = null;
    await withPicks(["F18"], async () => {
      const f = await host();
      const detail = await f.harness.behavior.callRpc("owner_detail_get", { machine: "studio" });
      expect(detail.terminal).toEqual({ sshAlias: null, sshVerified: false, localHostId: null });
    });
    await withPicks([], async () => {
      const f = await host();
      expect((await f.harness.behavior.callRpc("owner_detail_get", { machine: "studio" })).terminal.sshAlias).toBe("studio-ssh");
    });
  });

  it("with several machines and an unmatched hostname, uses the raw hostname and never another machine's key; the setting still wins", async () => {
    const fromHost = await host({}, false, "studio", { machineKey: "" });
    expect((await fromHost.harness.behavior.callRpc("board_get", null)).me.machineKey).toBe(hostname());
    const fromSetting = await host({}, false, "studio");
    expect((await fromSetting.harness.behavior.callRpc("board_get", null)).me.machineKey).toBe("studio");
    const folded = await host({}, false, "studio", { machineKey: "STUDIO" });
    expect((await folded.harness.behavior.callRpc("board_get", null)).me.machineKey).toBe("studio");
  });

  describe("fails closed when the identity or the profile is wrong", () => {
    const refuses = async (f: Awaited<ReturnType<typeof host>>, reason: RegExp) => {
      await expect(f.harness.behavior.callRpc("work_start", { machine: "laptop", prompt: "Read", requestId: "job-closed-0001" })).rejects.toThrow(reason);
      await expect(f.harness.behavior.callRpc("work_attachments_put", { v: 1, requestId: "00000000-0000-4000-8000-000000000009", files: [{ name: "a.txt", type: "localFile", mimeType: "text/plain", sha256: "0".repeat(64), contentBase64: "YQ==" }] })).rejects.toThrow(reason);
      await expect(f.harness.behavior.callRpc("transfer_manifest_build", { projectId: "proj_native", paths: ["a.txt"] })).rejects.toThrow(reason);
      expect(f.spawned).toHaveLength(0);
      expect((await f.harness.behavior.callRpc("board_get", null)).error).toMatch(reason);
    };

    it("refuses starts, attachments and transfers, and shows why on the board, when the machine key is not in a several-machine profile", async () => {
      await refuses(await host({}, false, "ghost"), /machine key "ghost" is not a machine in the profile/);
    });

    it("refuses when the profile has errors, even though the machine key setting names a real machine", async () => {
      await withProfile(fileURLToPath(new URL("./fixtures/profile-broken.json", import.meta.url)), async () => {
        await refuses(await host({}, false, "work"), /profile has errors/);
      });
    });

    it("refuses a restricted machine's key set against the community defaults, but not the community default key", async () => {
      await withProfile("/nonexistent/community-profile.json", async () => {
        await refuses(await host({}, false, "work"), /machine key "work" is not a machine in the profile/);
        const fine = await host({}, false, "this-mac", { machineKey: "this-mac" });
        expect((await fine.harness.behavior.callRpc("board_get", null)).error).toBeNull();
        await fine.harness.behavior.callRpc("work_start", { machine: "this-mac", prompt: "Read", requestId: "job-open-00001" });
        expect(fine.spawned).toHaveLength(1);
      });
    });
  });

  it("gives the always-on machine no direct route to itself", async () => {
    const f = await host({}, false, "studio");
    const board = await f.harness.behavior.callRpc("board_get", null);
    expect(board.transport).toMatchObject({ directOwner: "unconfigured", directMachine: null });
  });
});

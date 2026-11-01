import { describe, expect, it } from "vitest";
import { buildColumns, chooseRoute, commandOptions, EXECUTION_FEATURE, macAvailableMemoryBytes, SEALED_RELAY_FEATURE, parseRelayArgs, readCommandOptions, RESOURCE_STALE_MS, type Snapshot } from "./model";
import { fixtureProfile } from "./lib/test-profile";

const now = 1_800_000_000_000;
const execution = { providerId: "codex", model: "gpt-test", reasoningLevel: "high", serviceTier: "fast" };
function owner(key: string, changes: Partial<Snapshot> = {}): Snapshot {
  return {
    serverId: `server-${key}`, machineKey: key, label: key, url: `https://${key}.example.test`, ownerHostId: `host-${key}`,
    machines: [{ key, label: key, online: true, capabilities: ["NAS", "VPN"], verifiedCapabilities: key === "studio" ? ["NAS"] : [] }],
    threads: [], publishedAt: now, features: [EXECUTION_FEATURE],
    providers: [{ id: "codex", available: true, observedAt: now }],
    resources: { observedAt: now, cpuCount: 8, cpuUtilization: 0.2, totalMemoryBytes: 1000, availableMemoryBytes: 500 },
    ...changes,
  };
}

describe("new-job placement", () => {
  it("filters Client A and verified capability boundaries before comparing resource scores", () => {
    const result = chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [owner("studio"), owner("work", { resources: { observedAt: now, cpuCount: 128, cpuUtilization: 0.01, totalMemoryBytes: 1000, availableMemoryBytes: 900 } })], now, execution, routing: { needsNas: true } });
    expect(result.machine).toBe("studio");
    expect(result.candidates.find((entry) => entry.machine === "work")?.reasons).toEqual(expect.arrayContaining([expect.stringContaining("explicitly Client A"), expect.stringContaining("NAS has not been verified")]));
    expect(chooseRoute({ profile: fixtureProfile(), machine: "work", snapshots: [owner("work")], now, routing: { workload: "client-a", requiredCapabilities: ["VPN"] } }).machine).toBeNull();
    expect(chooseRoute({ profile: fixtureProfile(), machine: "work", snapshots: [owner("work")], now, routing: { workload: "client-a" } }).machine).toBe("work");
  });

  it("prefers an eligible studio owner for unattended work and exposes the actual owner identity", () => {
    const result = chooseRoute({ profile: fixtureProfile(), machine: "AUTO", snapshots: [owner("studio"), owner("laptop", { resources: { observedAt: now, cpuCount: 64, cpuUtilization: 0, totalMemoryBytes: 1000, availableMemoryBytes: 900 } })], now, execution, routing: { unattended: true } });
    expect(result).toMatchObject({ machine: "studio", serverId: "server-studio", hostId: "host-studio", mode: "auto" });
    expect(result.reason).toContain("unattended");
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [owner("studio"), owner("laptop", { resources: { observedAt: now, cpuCount: 64, cpuUtilization: 0, totalMemoryBytes: 1000, availableMemoryBytes: 900 } })], now, execution }).machine).toBe("laptop");
  });

  it.each([
    owner("studio", { resources: null }),
    owner("studio", { resources: { observedAt: now - RESOURCE_STALE_MS - 1, cpuCount: 8, cpuUtilization: 0.2, totalMemoryBytes: 1000, availableMemoryBytes: 500 } }),
    owner("studio", { resources: { observedAt: now, cpuCount: 8, cpuUtilization: null, totalMemoryBytes: 1000, availableMemoryBytes: 500 } }),
    owner("studio", { resources: { observedAt: now, cpuCount: 8, cpuUtilization: 0.99, totalMemoryBytes: 1000, availableMemoryBytes: 500 } }),
  ])("rejects unknown, stale or exhausted resources for Auto while preserving a manual choice", (snapshot) => {
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [snapshot], now }).machine).toBeNull();
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [snapshot], now }).machine).toBe("studio");
  });

  it("reads macOS available memory from the kernel level instead of never-used pages", () => {
    const total = 51_539_607_552;
    expect(macAvailableMemoryBytes("56\n", total)).toBe(Math.round(total * 0.56));
    expect(macAvailableMemoryBytes("0", total)).toBe(0);
    for (const bad of ["", "abc", "101", "-5", "5.5"]) expect(macAvailableMemoryBytes(bad, total)).toBeNull();
    // Live laptop on 30 October: freemem() said 1.3 GB of 51.5 GB (2.5%) while the kernel level said 56%.
    const busyMac = (availableMemoryBytes: number) => owner("laptop", { resources: { observedAt: now, cpuCount: 18, cpuUtilization: 0.47, totalMemoryBytes: total, availableMemoryBytes } });
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [busyMac(1_311_588_352)], now, execution }).machine).toBeNull();
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [busyMac(macAvailableMemoryBytes("56", total)!)], now, execution }).machine).toBe("laptop");
  });

  it("does not silently send explicit provider options to an old peer", () => {
    const old = owner("studio", { features: [], providers: undefined });
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [old], now, execution }).reason).toContain("execution-selection-v1");
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [old], now }).machine).toBe("studio");
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [old], now, project: { projectName: "NavAIgate" } }).reason).toContain("execution-selection-v1");
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [old], now, project: { workspace: { type: "unmanaged", path: null } } }).machine).toBeNull();
  });

  it("requires a negotiated sealed relay only for broker destinations", () => {
    const old = owner("studio");
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [old], now }).machine).toBe("studio");
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [old], now, brokerServerIds: [old.serverId] }).reason).toContain("plaintext downgrade is disabled");
    const upgraded = { ...old, features: [...old.features!, SEALED_RELAY_FEATURE], mirrorKey: "a".repeat(43) };
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [upgraded], now, brokerServerIds: [old.serverId] }).machine).toBe("studio");
  });

  it("rejects unavailable or stale provider observations for Auto", () => {
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [owner("studio", { providers: [{ id: "codex", available: false, observedAt: now }] })], now, execution }).machine).toBeNull();
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [owner("studio", { providers: [{ id: "codex", available: true, observedAt: now - RESOURCE_STALE_MS - 1 }] })], now, execution }).reason).toContain("Provider availability observation is stale");
  });

  it("does not spill Client A jobs to personal hosts and keeps explicit project affinity ahead of CPU", () => {
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [owner("studio"), owner("laptop")], now, routing: { workload: "client-a" } }).machine).toBeNull();
    const studio = owner("studio", { projects: [{ id: "project-other", name: "Other", kind: "standard" }] });
    const laptop = owner("laptop", { projects: [{ id: "project-client", name: "Client repo", kind: "standard" }] });
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [studio, laptop], now, project: { projectName: "Client repo" } }).machine).toBe("laptop");
    expect(chooseRoute({ profile: fixtureProfile(), machine: "auto", snapshots: [owner("studio")], now, project: { projectName: "Unknown" } }).reason).toContain("project availability is unknown");
  });

  it("separates an enrolled execution host from its stale independent owner", () => {
    const local = owner("laptop");
    local.machines.push({ key: "studio", label: "studio enrolled", online: true, capabilities: [] });
    const stale = owner("studio", { publishedAt: now - 10 * 60_000 });
    const column = buildColumns([local, stale], local.serverId, ["laptop", "studio"], now, fixtureProfile()).find((entry) => entry.key === "studio")!;
    expect(column.online).toBe(true);
    expect(column.ownerStatus).toBe("stale");
    expect(chooseRoute({ profile: fixtureProfile(), machine: "studio", snapshots: [local, stale], now }).machine).toBeNull();
  });
});

describe("execution selection persistence and CLI", () => {
  it("round-trips the full selection, routing and explicit destination project", () => {
    const project = { projectName: "Customer project", workspace: { type: "managed-worktree" as const, baseBranch: { kind: "named" as const, name: "release" } } };
    expect(readCommandOptions(commandOptions(execution, { workload: "client-a" }, project))).toEqual({ execution, routing: { workload: "client-a" }, project });
    expect(readCommandOptions(null, "claude-code")).toEqual({ execution: { providerId: "claude-code" }, routing: {}, project: {} });
    expect(readCommandOptions(null)).toEqual({ execution: {}, routing: {}, project: {} });
    expect(() => readCommandOptions('{"execution":{"model":"gpt-test"},"routing":{}}')).toThrow("Select a provider");
    expect(() => readCommandOptions("broken-json")).toThrow();
  });

  it("parses a complete tuple without stealing prompt text after the delimiter", () => {
    const result = parseRelayArgs(["ask", "auto", "--provider", "codex", "--model=gpt-test", "--reasoning-level", "high", "--service-tier", "fast", "--nas", "--unattended", "--workload", "general", "--", "Inspect", "--model", "literally"], fixtureProfile());
    expect(result).toMatchObject({ ok: true, command: { kind: "ask", machine: "AUTO", prompt: "Inspect --model literally", execution, routing: { needsNas: true, unattended: true, workload: "general" } } });
    expect(parseRelayArgs(["ask", "studio", "hello"], fixtureProfile())).toEqual({ ok: true, command: { kind: "ask", machine: "studio", prompt: "hello", messageFile: null, timeoutMs: 1_200_000, json: false } });
    expect(parseRelayArgs(["ask", "studio", "hello", "--model", "gpt-test"], fixtureProfile())).toMatchObject({ ok: false, error: expect.stringContaining("Select a provider") });
  });
});

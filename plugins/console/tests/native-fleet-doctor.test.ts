import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { collectFleetDoctor, createFleetDoctor, formatFleetDoctor } from "../fleet-doctor";

const TURSO_BODY = 'HTTP 403 from libsql: {"error":"Authorization header is invalid: token expired"}';
const detail = (machine: string, activeRoute: string, routes: Array<[string, string, string | null]>, verified = true) => ({
  machine,
  owner: activeRoute === "none" ? null : { serverId: `srv-${machine}`, url: null, appVersion: machine === "studio" ? "0.48.1" : "0.48.0", publishedAt: 1 },
  routes: routes.map(([kind, state, note]) => ({ kind, state, detail: note, lastOkAt: null })),
  activeRoute,
  capabilities: null, providers: null, mcp: null, editorLinks: [],
  binding: verified ? { verified: true, enrolledHostId: `host-${machine}` } : { verified: false, reason: "no route to read the host identity" },
});
const board = { me: { serverId: "srv-Laptop", machineKey: "laptop" }, columns: [], error: TURSO_BODY, transport: { broker: "unavailable", lastSuccessfulSyncAt: 1_800_000_000_000, directM1: "ready", directM1Error: null } };
const sources = (over: Record<string, unknown> = {}) => ({
  machines: ["laptop", "studio", "work"] as const,
  board: async () => board,
  ownerDetail: async (machine: string) =>
    machine === "laptop" ? detail("laptop", "self", [["self", "healthy", null]])
    : machine === "studio" ? detail("studio", "ssh", [["ssh", "healthy", "SSH OK"], ["broker", "unavailable", "broker down"]])
    : detail("work", "none", [["ssh", "unconfigured", null], ["broker", "unavailable", "no heartbeat"], ["connect", "unavailable", null]], false),
  ...over,
});

describe("fleet doctor", () => {
  it("names the broker's error body, Studio over SSH and Work with no route", async () => {
    const report = await collectFleetDoctor(sources());
    const text = formatFleetDoctor(report);
    expect(text).toContain(`Broker error: ${TURSO_BODY}`);
    expect(text).toMatch(/Studio: OK . route ssh/);
    expect(text).toContain("ssh healthy (SSH OK)");
    expect(text).toMatch(/Work: NO ROUTE/);
    expect(report.machines.map((m) => [m.machine, m.ok])).toEqual([["laptop", true], ["studio", true], ["work", false]]);
    expect(report.broker).toMatchObject({ state: "unavailable", error: TURSO_BODY });
  });

  it("reports a machine that errors or hangs on its own row and still reads the rest", async () => {
    const report = await collectFleetDoctor(sources({
      timeoutMs: 20,
      ownerDetail: async (machine: string) => {
        if (machine === "studio") throw new Error("ssh: connect timed out");
        if (machine === "work") return new Promise(() => undefined);
        return detail("laptop", "self", [["self", "healthy", null]]);
      },
    }));
    expect(report.machines.find((m) => m.machine === "studio")).toMatchObject({ ok: false, error: "ssh: connect timed out" });
    expect(report.machines.find((m) => m.machine === "work")!.error).toContain("timed out");
    expect(report.machines.find((m) => m.machine === "laptop")!.ok).toBe(true);
  });

  it("still produces a report when the board itself cannot be read", async () => {
    const report = await collectFleetDoctor(sources({ board: async () => { throw new Error("fleet plugin not installed"); } }));
    expect(report.broker.error).toContain("fleet plugin not installed");
    expect(report.machines).toHaveLength(3);
  });

  it("strips credentials from an error body but keeps the status and message", async () => {
    const report = await collectFleetDoctor(sources({ board: async () => ({ ...board, error: "403 Bearer eyJhbGciOi.payload.sig github_pat_ABC123 rejected" }) }));
    expect(report.broker.error).toBe("403 [credential] [credential] rejected");
  });

  it("reads the board and each machine through the Fleet plugin's RPCs", async () => {
    const callRpc = vi.fn(async ({ method, input }: { method: string; input: { machine?: string } | null }) =>
      method === "board_get" ? board : detail(input!.machine!, "ssh", [["ssh", "healthy", null]]));
    const bb = { sdk: { plugins: { callRpc }, system: { version: async () => ({ currentVersion: "0.48.0" }) } } } as unknown as BbPluginApi;
    const report = await createFleetDoctor(bb).run();
    expect(callRpc.mock.calls.map((c) => [c[0].method, c[0].input])).toEqual(
      expect.arrayContaining([["board_get", null], ["owner_detail_get", { machine: "studio" }], ["owner_detail_get", { machine: "work" }], ["owner_detail_get", { machine: "laptop" }]]),
    );
    expect(report.self).toMatchObject({ machine: "laptop", appVersion: "0.48.0" });
    expect(report.text).toContain("laptop");
  });
});

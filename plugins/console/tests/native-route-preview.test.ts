import { describe, expect, it, vi } from "vitest";
import { createRoutePreview, routePreviewInput } from "../server-route-preview";

const route = (over: Record<string, unknown> = {}) => ({
  machine: "studio", serverId: "srv_m1", hostId: "host_m1", mode: "auto" as const, reason: "Selected Studio's independent owner for unattended work", warnings: [],
  candidates: [
    { machine: "studio", serverId: "srv_m1", hostId: "host_m1", eligible: true, reasons: [], score: 6.2 },
    { machine: "laptop", serverId: "srv_m5", hostId: "host_m5", eligible: false, reasons: ["Provider codex is not reported available on this owner"], score: null },
  ],
  ...over,
});
const detail = (providers: unknown, xcode: { verified: boolean; version: string | null } | null) => ({
  providers, capabilities: xcode ? { xcode, gui: "present" } : null,
});
const providers = [
  { id: "codex", displayName: "Codex", available: true, observedAt: 1_000, auth: "ready", planLabel: "Pro" },
  { id: "cursor", available: false, observedAt: 900, auth: "unauthenticated" },
];

function fleet(over: { route?: () => unknown; owner?: (machine: string) => unknown } = {}) {
  return {
    route: vi.fn(async () => (over.route ? over.route() : route()) as never),
    ownerDetail: vi.fn(async (machine: string) => (over.owner ? over.owner(machine) : detail(providers, { verified: machine === "studio", version: machine === "studio" ? "26.1" : null })) as never),
  };
}

describe("route preview before sending", () => {
  it("reports the chosen Mac and why each other Mac is not eligible", async () => {
    const link = fleet();
    const out = await createRoutePreview(link, () => 5_000)({ machine: "Auto", providerId: "codex", destinationProjectName: "Atlas", routing: { workload: "general", unattended: true } });
    expect(link.route).toHaveBeenCalledWith({ machine: "Auto", providerId: "codex", projectName: "Atlas", routing: { workload: "general", unattended: true } });
    expect(out.checkedAt).toBe(5_000);
    expect(out.route?.machine).toBe("studio");
    expect(out.machines.find((item) => item.machine === "studio")).toMatchObject({ chosen: true, eligible: true, score: 6.2 });
    expect(out.machines.find((item) => item.machine === "laptop")).toMatchObject({ chosen: false, eligible: false, reasons: ["Provider codex is not reported available on this owner"] });
  });

  it("lists every provider's availability and observation time per Mac", async () => {
    const out = await createRoutePreview(fleet(), () => 5_000)({ machine: "Auto" });
    const m1 = out.machines.find((item) => item.machine === "studio")!;
    expect(m1.providers).toEqual([
      { id: "codex", name: "Codex", available: true, auth: "ready", observedAt: 1_000, planLabel: "Pro" },
      { id: "cursor", name: "cursor", available: false, auth: "unauthenticated", observedAt: 900, planLabel: null },
    ]);
    expect(m1.xcode).toEqual({ verified: true, version: "26.1" });
    expect(out.machines.map((item) => item.machine).sort()).toEqual(["laptop", "studio", "work"]);
  });

  it("returns a refusal as text instead of throwing, and still reads the named Mac", async () => {
    const link = fleet({ route: () => { throw new Error("Work requires an explicitly Clientco workload"); } });
    const out = await createRoutePreview(link)({ machine: "work" });
    expect(out.route).toBeNull();
    expect(out.refusal).toMatch(/Clientco workload/);
    expect(out.machines.map((item) => item.machine)).toEqual(["work"]);
    expect(out.machines[0]).toMatchObject({ chosen: false, eligible: null });
  });

  it("keeps the route when one Mac's provider list cannot be read", async () => {
    const link = fleet({ owner: (machine) => { if (machine === "laptop") throw new Error("owner offline"); return detail(providers, null); } });
    const out = await createRoutePreview(link)({ machine: "Auto" });
    expect(out.route?.machine).toBe("studio");
    expect(out.machines.find((item) => item.machine === "laptop")?.providers).toBeNull();
    expect(out.machines.find((item) => item.machine === "studio")?.xcode).toBeNull();
  });

  it("carries the required capability to the route check", async () => {
    const link = fleet();
    await createRoutePreview(link)({ machine: "studio", routing: { workload: "general", requiredCapabilities: ["xcode"] } });
    expect(link.route).toHaveBeenCalledWith({ machine: "studio", routing: { workload: "general", requiredCapabilities: ["xcode"] } });
  });

  it("rejects unknown fields", () => {
    expect(routePreviewInput.safeParse({ machine: "Auto", prompt: "secret" }).success).toBe(false);
  });
});

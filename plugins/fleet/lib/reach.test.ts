import { describe, expect, it } from "vitest";
import { reachOf } from "./reach";

const column = (over: Record<string, unknown> = {}) => ({ key: "studio", online: true, local: false, ...over });
const me = (joined: boolean, directOwner: "ready" | "unavailable" | "unconfigured" = "unconfigured") => ({ me: { joined }, transport: { directOwner, directMachine: "studio" } });

describe("reachOf", () => {
  it("starts work here on a machine this bb runs", () => {
    expect(reachOf(column({ key: "laptop", local: true }), me(false))).toBe("here");
  });

  it("goes through the brain for a joined Mac", () => {
    expect(reachOf(column(), me(true))).toBe("brain");
  });

  it("goes over the SSH route to the always-on studio when this Mac has not joined the fleet", () => {
    expect(reachOf(column(), me(false, "ready"))).toBe("ssh");
  });

  it("offers nothing when no route is proven, for an offline machine, or for a machine SSH does not reach", () => {
    expect(reachOf(column(), me(false, "unavailable"))).toBeNull();
    expect(reachOf(column({ online: false }), me(true))).toBeNull();
    expect(reachOf(column({ key: "work" }), me(false, "ready"))).toBeNull();
  });
});

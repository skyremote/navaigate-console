import { describe, expect, it } from "vitest";
import { pickReusableTerminal, planTerminal, terminalTitle } from "./terminal";

const verifiedBinding = { machine: "studio", ownerServerId: "s", ownerHardwareId: "hw", enrolledHostId: "host_studio", enrolledHardwareId: "hw", verified: true, reason: null };
const unverified = { ...verifiedBinding, enrolledHostId: null, enrolledHardwareId: null, verified: false, reason: "No enrolled host on this server reports the owner's hardware identity" };

describe("planTerminal", () => {
  it("uses the enrolled host's own terminal when the hardware binding is proven", () => {
    expect(planTerminal({ machine: "studio", localMachine: "laptop", binding: verifiedBinding, sshAlias: "studio", sshVerified: true, localHostId: "host_laptop" })).toEqual({ kind: "enrolled", hostId: "host_studio" });
  });

  it("opens ssh to the independent studio from this Mac's own host when no enrolled host is proven", () => {
    expect(planTerminal({ machine: "studio", localMachine: "laptop", binding: unverified, sshAlias: "studio", sshVerified: true, localHostId: "host_laptop" })).toEqual({ kind: "ssh", hostId: "host_laptop", alias: "studio", argv: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "studio"] });
  });

  it("says why there is no terminal when this Mac's own host is not proven", () => {
    expect(planTerminal({ machine: "studio", localMachine: "laptop", binding: unverified, sshAlias: "studio", sshVerified: true, localHostId: null })).toEqual({ kind: "none", reason: "This Mac's own host is not proven yet, so Fleet cannot start an SSH terminal from it" });
  });

  it("offers no SSH terminal while the studio route is not verified, and says so", () => {
    expect(planTerminal({ machine: "studio", localMachine: "laptop", binding: unverified, sshAlias: "studio", sshVerified: false, localHostId: "host_laptop" })).toEqual({ kind: "none", reason: "The studio SSH route to studio is not verified right now, so Fleet will not open a terminal over it" });
  });

  it("says why there is no terminal without an SSH alias, and never offers SSH to other machines", () => {
    expect(planTerminal({ machine: "studio", localMachine: "laptop", binding: unverified, sshAlias: null, sshVerified: false, localHostId: "host_laptop" })).toMatchObject({ kind: "none", reason: expect.stringContaining("No SSH alias") });
    expect(planTerminal({ machine: "work", localMachine: "laptop", binding: { ...unverified, machine: "work" }, sshAlias: null, sshVerified: true, localHostId: "host_laptop" })).toMatchObject({ kind: "none", reason: expect.stringContaining("work") });
  });

  it("offers nothing for the machine you are already on unless it is proven", () => {
    expect(planTerminal({ machine: "laptop", localMachine: "laptop", binding: { ...unverified, machine: "laptop" }, sshAlias: null, sshVerified: false, localHostId: "host_laptop" })).toMatchObject({ kind: "none" });
  });
});

describe("pickReusableTerminal", () => {
  const session = (over: Record<string, unknown>) => ({ id: "t1", title: terminalTitle("studio", "ssh"), status: "running", hostId: "host_laptop", updatedAt: 10, ...over });
  it("reuses the newest live session with this machine's terminal title instead of opening another", () => {
    const sessions = [session({ id: "old", updatedAt: 5 }), session({ id: "new", updatedAt: 9 }), session({ id: "gone", status: "exited", updatedAt: 99 }), session({ id: "other", title: "work terminal (ssh)", updatedAt: 100 })];
    expect(pickReusableTerminal(sessions, "studio", "ssh", "host_laptop")?.id).toBe("new");
  });
  it("keeps a session whose connection dropped so the open terminal is reconnected rather than replaced", () => {
    expect(pickReusableTerminal([session({ id: "d", status: "disconnected" })], "studio", "ssh", "host_laptop")?.id).toBe("d");
  });
  it("does not reuse a session on another host, or an exited one", () => {
    expect(pickReusableTerminal([session({ hostId: "host_other" }), session({ status: "exited" })], "studio", "ssh", "host_laptop")).toBeNull();
  });
});

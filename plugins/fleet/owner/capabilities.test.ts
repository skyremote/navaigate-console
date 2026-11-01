import { describe, expect, it } from "vitest";
import { opaqueHardwareId, probeCapabilities, rawHardwareId, verifiedCapabilityNames, type Exec } from "./capabilities";
import { bindingVerdict } from "./host-identity";

const IOREG = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000213, registered, matched, active, busy 0 (0 ms), retain 39>
    {
      "IOPlatformSerialNumber" = "SERIAL123"
      "IOPlatformUUID" = "8A1B2C3D-1111-2222-3333-444455556666"
    }`;

function fakeExec(replies: Record<string, { code: number; stdout: string }>): Exec {
  return async (bin, args) => replies[[bin, ...args].join(" ")] ?? { code: 1, stdout: "" };
}

describe("hardware identity", () => {
  it("hashes the platform UUID into an opaque id and never exposes it", async () => {
    const raw = await rawHardwareId(fakeExec({ "/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice": { code: 0, stdout: IOREG } }), "darwin");
    expect(raw).toBe("8A1B2C3D-1111-2222-3333-444455556666");
    const id = opaqueHardwareId(raw);
    expect(id).toMatch(/^bbhw1:[0-9a-f]{40}$/);
    expect(id).not.toContain("8A1B2C3D");
    expect(opaqueHardwareId(raw)).toBe(id);
    expect(opaqueHardwareId("")).toBeNull();
    expect(opaqueHardwareId(null)).toBeNull();
  });

  it("returns null when ioreg fails rather than guessing", async () => {
    expect(await rawHardwareId(fakeExec({}), "darwin")).toBeNull();
    expect(await rawHardwareId(fakeExec({}), "aix" as NodeJS.Platform)).toBeNull();
  });
});

describe("capability probe", () => {
  it("verifies Xcode, counts booted simulators and reports taps unsupported without idb", async () => {
    const caps = await probeCapabilities({
      os: "darwin",
      uid: 501,
      now: () => 42,
      exec: fakeExec({
        "/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice": { code: 0, stdout: IOREG },
        "/bin/launchctl print gui/501": { code: 0, stdout: "gui/501 = {}" },
        "/usr/bin/xcodebuild -version": { code: 0, stdout: "Xcode 26.1\nBuild version 17B55\n" },
        "/usr/bin/xcrun simctl list devices booted -j": { code: 0, stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [{ udid: "A" }] } }) },
      }),
    });
    expect(caps).toMatchObject({ observedAt: 42, gui: "present", xcode: { verified: true, version: "26.1" }, simulators: { available: true, booted: 1, tapControl: false } });
    expect(verifiedCapabilityNames(caps)).toEqual(["xcode", "ios-simulator", "gui-session"]);
  });

  it("verifies nothing on a host without Xcode or a GUI session, and nothing macOS-specific on Linux", async () => {
    const mac = await probeCapabilities({ os: "darwin", uid: 501, exec: fakeExec({ "/bin/launchctl print gui/501": { code: 113, stdout: "" } }) });
    expect(mac).toMatchObject({ gui: "absent", xcode: { verified: false }, simulators: { available: false } });
    expect(verifiedCapabilityNames(mac)).toEqual([]);
    const linux = await probeCapabilities({ os: "linux", exec: fakeExec({}) });
    expect(linux).toMatchObject({ gui: "not-applicable", xcode: { verified: false } });
    expect(linux.platform.os).toBe("linux");
  });
});

describe("enrolled host binding", () => {
  const owner = { machine: "studio", ownerServerId: "studio-srv", ownerHardwareId: "bbhw1:aaaa" };

  it("proves the enrolled host whose daemon reports the owner's hardware id", () => {
    expect(bindingVerdict({ ...owner, candidates: [{ hostId: "host_9ijpy7ufsr", hardwareId: "bbhw1:aaaa", error: null }, { hostId: "host_other", hardwareId: "bbhw1:bbbb", error: null }] })).toMatchObject({ verified: true, enrolledHostId: "host_9ijpy7ufsr" });
  });

  it("refuses name-only, missing, duplicate and failed proofs", () => {
    expect(bindingVerdict({ ...owner, candidates: [{ hostId: "host_9ijpy7ufsr", hardwareId: "bbhw1:bbbb", error: null }] })).toMatchObject({ verified: false, enrolledHostId: null });
    expect(bindingVerdict({ ...owner, ownerHardwareId: null, candidates: [{ hostId: "host_9ijpy7ufsr", hardwareId: "bbhw1:aaaa", error: null }] })).toMatchObject({ verified: false });
    expect(bindingVerdict({ ...owner, candidates: [{ hostId: "a", hardwareId: "bbhw1:aaaa", error: null }, { hostId: "b", hardwareId: "bbhw1:aaaa", error: null }] })).toMatchObject({ verified: false, reason: expect.stringContaining("More than one") });
    expect(bindingVerdict({ ...owner, candidates: [{ hostId: "host_9ijpy7ufsr", hardwareId: null, error: "worker timed out" }] })).toMatchObject({ verified: false, reason: expect.stringContaining("worker timed out") });
  });
});

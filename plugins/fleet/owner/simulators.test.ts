import { describe, expect, it } from "vitest";
import { createSimulators, simulatorRpcContract, type SimExec, type SimExecBytes } from "./simulators";

const UDID = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0";
const ADB = "/Users/test/Library/Android/sdk/platform-tools/adb";

function tools(options: { idb?: boolean; adb?: boolean; screenshotFails?: boolean }) {
  const calls: string[] = [];
  const exec: SimExec = async (bin, args) => {
    calls.push([bin, ...args].join(" "));
    if (bin === "/bin/test") return { code: (options.idb && args[1] === "/usr/local/bin/idb") || (options.adb && args[1] === ADB) ? 0 : 1, stdout: "", stderr: "" };
    if (bin === "/usr/bin/xcrun" && args[1] === "list") return { code: 0, stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [{ udid: UDID, name: "iPhone 17", state: "Booted", isAvailable: true }] } }), stderr: "" };
    if (bin === "/usr/bin/xcrun" && args[1] === "io") return options.screenshotFails ? { code: 1, stdout: "", stderr: "No devices are booted." } : { code: 0, stdout: "", stderr: "" };
    if (bin === ADB && args[0] === "devices") return { code: 0, stdout: "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\nbad;serial device\n\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const execBytes: SimExecBytes = async (bin, args) => { calls.push([bin, ...args].join(" ")); return { code: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47]), stderr: "" }; };
  return { sims: createSimulators({ exec, execBytes, readFile: () => Buffer.from([0xff, 0xd8, 0xff]), now: () => 7, env: {}, home: "/Users/test" }), calls };
}

describe("owner simulators and emulators", () => {
  it("lists iOS simulators and running Android emulators, and says when adb is missing", async () => {
    const both = tools({ adb: true });
    expect(await both.sims.handlers.simulator_list()).toEqual({
      ios: { available: true, inputControl: false },
      android: { available: true, reason: null },
      devices: [{ platform: "ios", id: UDID, name: "iPhone 17", state: "Booted", runtime: "iOS-26-1" }, { platform: "android", id: "emulator-5554", name: "sdk gphone64 arm64", state: "Booted", runtime: "Android emulator" }],
    });
    const iosOnly = tools({});
    expect((await iosOnly.sims.handlers.simulator_list()).android).toEqual({ available: false, reason: expect.stringContaining("adb is not installed") });
  });

  it("captures iOS JPEG frames through simctl and Android PNG frames through adb screencap", async () => {
    const { sims, calls } = tools({ adb: true });
    expect(await sims.handlers.simulator_frame({ platform: "ios", id: UDID })).toEqual({ platform: "ios", id: UDID, mimeType: "image/jpeg", contentBase64: "/9j/", capturedAt: 7 });
    expect(await sims.handlers.simulator_frame({ platform: "android", id: "emulator-5554" })).toMatchObject({ platform: "android", mimeType: "image/png", contentBase64: "iVBORw==" });
    expect(calls).toContain(`${ADB} -s emulator-5554 exec-out screencap -p`);
    await expect(tools({ screenshotFails: true }).sims.handlers.simulator_frame({ platform: "ios", id: UDID })).rejects.toThrow("No devices are booted");
  });

  it("drives Android with fixed adb argv and refuses text that would need device-shell quoting", async () => {
    const { sims, calls } = tools({ adb: true });
    const target = { platform: "android" as const, id: "emulator-5554" };
    expect(await sims.handlers.simulator_action({ target, action: { kind: "tap", x: 100.4, y: 200.6 } })).toEqual({ ok: true, message: null });
    expect(await sims.handlers.simulator_action({ target, action: { kind: "text", text: "hello world" } })).toEqual({ ok: true, message: null });
    expect(await sims.handlers.simulator_action({ target, action: { kind: "text", text: "a; rm -rf /" } })).toMatchObject({ ok: false, message: expect.stringContaining("nothing was typed") });
    expect(await sims.handlers.simulator_action({ target, action: { kind: "key", key: "Back" } })).toEqual({ ok: true, message: null });
    expect(await sims.handlers.simulator_action({ target, action: { kind: "boot" } })).toMatchObject({ ok: false });
    expect(calls).toEqual(expect.arrayContaining([`${ADB} -s emulator-5554 shell input tap 100 201`, `${ADB} -s emulator-5554 shell input text hello%sworld`, `${ADB} -s emulator-5554 shell input keyevent 4`]));
    expect(calls.some((call) => call.includes("rm -rf"))).toBe(false);
  });

  it("refuses iOS taps, text and keys without idb and uses idb when installed", async () => {
    const without = tools({});
    expect(await without.sims.handlers.simulator_action({ target: { platform: "ios", id: UDID }, action: { kind: "tap", x: 10, y: 20 } })).toMatchObject({ ok: false, message: expect.stringContaining("idb") });
    const withIdb = tools({ idb: true });
    expect(await withIdb.sims.handlers.simulator_action({ target: { platform: "ios", id: UDID }, action: { kind: "tap", x: 10.4, y: 20.6 } })).toEqual({ ok: true, message: null });
    expect(withIdb.calls).toContain(`/usr/local/bin/idb ui tap 10 21 --udid ${UDID}`);
  });

  it("accepts only real device ids, safe URLs and app ids", () => {
    const action = simulatorRpcContract.simulator_action.input;
    expect(action.safeParse({ target: { platform: "ios", id: UDID }, action: { kind: "openurl", url: "https://example.test/a" } }).success).toBe(true);
    expect(action.safeParse({ target: { platform: "ios", id: UDID }, action: { kind: "openurl", url: "file:///etc/passwd" } }).success).toBe(false);
    expect(action.safeParse({ target: { platform: "android", id: "emulator-5554" }, action: { kind: "openurl", url: "https://example.test/$(reboot)" } }).success).toBe(false);
    expect(action.safeParse({ target: { platform: "android", id: "x; reboot" }, action: { kind: "key", key: "Home" } }).success).toBe(false);
    expect(action.safeParse({ target: { platform: "android", id: "emulator-5554" }, action: { kind: "launch", appId: "com.example.app" } }).success).toBe(true);
  });
});

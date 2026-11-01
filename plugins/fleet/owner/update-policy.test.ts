import { describe, expect, it } from "vitest";
import { channelChangeMessage, channelFor, parsePinInput, policyForChannel, policyFromSettings, policyToSettings, updateGate } from "./update-policy";

describe("update channels", () => {
  it("marks only the staging machine as nightly and every other machine as stable", () => {
    const policy = { testMachine: "studio", pinnedVersion: null };
    expect(channelFor(policy, "studio")).toBe("nightly");
    expect(channelFor(policy, "laptop")).toBe("stable");
    expect(channelFor({ testMachine: null, pinnedVersion: null }, "studio")).toBe("stable");
  });

  it("moves the nightly channel to the chosen machine so there is only ever one test host", () => {
    expect(policyForChannel({ testMachine: "studio", pinnedVersion: "0.48.1" }, "laptop", "nightly")).toEqual({ testMachine: "laptop", pinnedVersion: "0.48.1" });
  });

  it("switches staging off when the nightly machine is set back to stable, and ignores a stable choice for another machine", () => {
    expect(policyForChannel({ testMachine: "studio", pinnedVersion: null }, "studio", "stable")).toEqual({ testMachine: null, pinnedVersion: null });
    expect(policyForChannel({ testMachine: "studio", pinnedVersion: null }, "laptop", "stable")).toEqual({ testMachine: "studio", pinnedVersion: null });
  });

  it("accepts only an exact x.y.z pin and treats blank as clearing it", () => {
    expect(parsePinInput(" 0.48.1 ")).toEqual({ ok: true, value: "0.48.1" });
    expect(parsePinInput("")).toEqual({ ok: true, value: null });
    expect(parsePinInput("0.48")).toMatchObject({ ok: false });
    expect(parsePinInput("latest")).toMatchObject({ ok: false });
  });

  it("round-trips through the stored plugin settings", () => {
    expect(policyToSettings({ testMachine: null, pinnedVersion: "0.48.1" })).toEqual({ updateTestMachine: "", updatePinnedVersion: "0.48.1" });
    expect(policyFromSettings({ updateTestMachine: " studio ", updatePinnedVersion: "nonsense" })).toEqual({ testMachine: "studio", pinnedVersion: null });
    expect(policyFromSettings({ updateTestMachine: "", updatePinnedVersion: "0.48.1" })).toEqual({ testMachine: null, pinnedVersion: "0.48.1" });
  });
});

describe("update gate shown on the Fleet page", () => {
  const row = (machine: string, current: string | null, available: string | null) => ({ machine, status: current === null ? null : { app: { current, available } } });
  const rows = [row("laptop", "0.48.0", "0.49.0"), row("studio", "0.48.0", "0.49.0"), row("work", "0.48.0", "0.49.0")];

  it("lets the nightly machine take a new version straight away", () => {
    expect(updateGate({ testMachine: "studio", pinnedVersion: null }, rows, "studio")).toBeNull();
  });

  it("holds a stable machine until the nightly machine runs the offered version, and says which machine it waits for", () => {
    expect(updateGate({ testMachine: "studio", pinnedVersion: null }, rows, "laptop")).toBe("Waits for studio to run 0.49.0 (it runs 0.48.0)");
    const staged = [row("laptop", "0.48.0", "0.49.0"), row("studio", "0.49.0", null)];
    expect(updateGate({ testMachine: "studio", pinnedVersion: null }, staged, "laptop")).toBeNull();
  });

  it("holds a stable machine when the nightly machine cannot be read", () => {
    expect(updateGate({ testMachine: "studio", pinnedVersion: null }, [row("laptop", "0.48.0", "0.49.0"), row("studio", null, null)], "laptop")).toBe("Waits for studio to run 0.49.0 (it runs unknown)");
  });

  it("does not hold anything when no machine is nightly", () => {
    expect(updateGate({ testMachine: null, pinnedVersion: null }, rows, "laptop")).toBeNull();
  });

  it("refuses a version other than the pin on every machine, the nightly one included", () => {
    expect(updateGate({ testMachine: "studio", pinnedVersion: "0.48.1" }, rows, "studio")).toBe("Pinned to 0.48.1");
    expect(updateGate({ testMachine: null, pinnedVersion: "0.49.0" }, rows, "laptop")).toBeNull();
  });

  it("has nothing to hold when no update is offered", () => {
    expect(updateGate({ testMachine: "studio", pinnedVersion: "0.48.1" }, [row("laptop", "0.48.1", null)], "laptop")).toBeNull();
  });
});

describe("channel change message", () => {
  it("says when choosing nightly sends the previous test host back to stable", () => {
    expect(channelChangeMessage({ testMachine: "studio", pinnedVersion: null }, "laptop", "nightly")).toBe("laptop is now the nightly test host; studio is back on stable");
    expect(channelChangeMessage({ testMachine: null, pinnedVersion: null }, "laptop", "nightly")).toBe("laptop is now the nightly test host");
    expect(channelChangeMessage({ testMachine: "studio", pinnedVersion: null }, "studio", "stable")).toBe("studio is on the stable channel; no machine is nightly");
    expect(channelChangeMessage({ testMachine: "studio", pinnedVersion: null }, "laptop", "stable")).toBe("laptop is on the stable channel");
  });
});

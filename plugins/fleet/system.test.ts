import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildColumns, buildSystem, parseCoresAndMemory, parseDf, parseLoadAvg, parsePressure, parseSleepAssertions, parseSwapUsed, parseTopCpu, parseVmStatUsed, snapshotSchema, type Snapshot, type SystemReads } from "./model";
import { fixtureProfile } from "./lib/test-profile";

const system = (name: string) => readFileSync(new URL(`./fixtures/system/${name}`, import.meta.url), "utf8");
const pmset = (name: string) => readFileSync(new URL(`./fixtures/pmset/${name}`, import.meta.url), "utf8");
const AT = 1_800_000_000_000;

const recorded = (): SystemReads => ({
  top: system("top-laptop.txt"),
  hardware: system("hardware-laptop.txt"),
  loadavg: system("loadavg-laptop.txt"),
  vmStat: system("vm_stat-laptop.txt"),
  pressure: system("pressure-laptop.txt"),
  swap: system("swap-laptop.txt"),
  df: system("df-laptop.txt"),
  pmset: pmset("assertions-amphetamine-caffeinate.txt"),
});

describe("reading the system from the recorded laptop output", () => {
  it("takes busy CPU from the second top sample, not the average since boot", () => {
    expect(parseTopCpu(system("top-laptop.txt"))).toBe(22.1);
    expect(parseTopCpu("nothing useful")).toBeNull();
  });

  it("reads cores and memory, load, pressure, swap and disk", () => {
    expect(parseCoresAndMemory(system("hardware-laptop.txt"))).toEqual({ cores: 18, memTotalBytes: 51_539_607_552 });
    expect(parseLoadAvg(system("loadavg-laptop.txt"))).toEqual([6.41, 8.21, 7.46]);
    expect(parsePressure("1\n")).toBe("normal");
    expect(parsePressure("2\n")).toBe("warn");
    expect(parsePressure("4\n")).toBe("critical");
    expect(parsePressure("3\n")).toBeNull();
    expect(parseSwapUsed(system("swap-laptop.txt"))).toBe(Math.round(13235.62 * 1024 * 1024));
    expect(parseDf(system("df-laptop.txt"))).toEqual({ diskFreeBytes: 58_863_068 * 1024, diskTotalBytes: 1_948_404_040 * 1024 });
  });

  it("counts used memory as active + wired + compressor pages times the page size", () => {
    expect(parseVmStatUsed(system("vm_stat-laptop.txt"))).toBe((981_927 + 375_022 + 712_297) * 16_384);
    expect(parseVmStatUsed("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 5.\n")).toBeNull();
    expect(parseVmStatUsed("")).toBeNull();
  });

  it("returns nothing for output that is not the tool's", () => {
    expect(parseCoresAndMemory("")).toEqual({ cores: null, memTotalBytes: null });
    expect(parseLoadAvg("oops")).toBeNull();
    expect(parseSwapUsed("oops")).toBeNull();
    expect(parseDf("Filesystem\n")).toEqual({ diskFreeBytes: null, diskTotalBytes: null });
  });
});

describe("keepAwake from pmset -g assertions", () => {
  it("names the apps that hold the Mac awake, once each, and leaves out system daemons and display-only holders", () => {
    expect(parseSleepAssertions(pmset("assertions-amphetamine-caffeinate.txt"))).toEqual(["Amphetamine", "caffeinate"]);
  });

  it("is empty when only system daemons hold an assertion, and for output that is not pmset's", () => {
    expect(parseSleepAssertions(pmset("assertions-idle.txt"))).toEqual([]);
    expect(parseSleepAssertions("")).toEqual([]);
  });

  it("never publishes more holders than the snapshot schema allows", () => {
    const many = Array.from({ length: 30 }, (_, i) => `  pid ${100 + i}(app${i}): [0x0001] 00:01:00 PreventUserIdleSystemSleep named: "x"`).join("\n");
    expect(parseSleepAssertions(many)).toHaveLength(20);
    expect(snapshotSchema.shape.system.safeParse(buildSystem({ ...recorded(), pmset: many })).success).toBe(true);
  });
});

describe("the whole system reading", () => {
  it("joins every read in the published shape", () => {
    expect(buildSystem(recorded())).toEqual({
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
  });

  it("gives null for the field whose read failed and keeps the rest", () => {
    const reading = buildSystem({ ...recorded(), top: null, vmStat: null, pmset: null });
    expect(reading).toMatchObject({ cpuPercent: null, memUsedBytes: null, keepAwake: [], cores: 18, memTotalBytes: 51_539_607_552, memPressure: "normal" });
  });

  it("is null when every read failed", () => {
    expect(buildSystem({ top: null, hardware: null, loadavg: null, vmStat: null, pressure: null, swap: null, df: null, pmset: null })).toBeNull();
  });
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  serverId: "studio-srv",
  label: "studio",
  url: null,
  machineKey: "studio",
  machines: [{ key: "studio", label: "studio", online: true, capabilities: [] }],
  threads: [],
  publishedAt: AT,
  ...over,
});

describe("the system field on a snapshot", () => {
  it("still parses a snapshot from before the field existed", () => {
    expect(snapshotSchema.parse(snapshot()).system).toBeUndefined();
  });

  it("keeps a reading and accepts null", () => {
    const reading = buildSystem(recorded());
    expect(snapshotSchema.parse(snapshot({ system: reading })).system).toEqual(reading);
    expect(snapshotSchema.parse(snapshot({ system: null })).system).toBeNull();
  });

  it("rejects a reading that is not shaped like one", () => {
    expect(() => snapshotSchema.parse(snapshot({ system: { cpuPercent: "busy" } }))).toThrow();
    expect(() => snapshotSchema.parse(snapshot({ system: { ...buildSystem(recorded()), memPressure: "high" } }))).toThrow();
  });

  it("carries each Mac's system into its column, and null when the snapshot has none", () => {
    const reading = buildSystem(recorded());
    const snapshots = [snapshotSchema.parse(snapshot({ system: reading })), snapshotSchema.parse(snapshot({ serverId: "laptop", machineKey: "laptop", label: "laptop", machines: [{ key: "laptop", label: "laptop", online: true, capabilities: [] }] }))] satisfies Snapshot[];
    const columns = buildColumns(snapshots, "laptop", ["laptop"], AT, fixtureProfile());
    expect(columns.find((c) => c.key === "studio")?.system).toEqual(reading);
    expect(columns.find((c) => c.key === "laptop")?.system).toBeNull();
  });
});

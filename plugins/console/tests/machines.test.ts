// Run with: node --test tests/machines.test.ts (Node strips the types itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveProfile } from "../profile/schema.ts";
import { chipsFor, machineKeyOf, machineMetric, pickMachine, systemView, remoteFor, remoteSections, sinceLabel, subLabel, type FleetBoard, type RemoteThread } from "../src/machines.ts";

const profile = resolveProfile(JSON.parse(readFileSync(process.env.NAVAIGATE_CONSOLE_PROFILE ?? "tests/fixtures/profile.json", "utf8"))).profile;

const t = (over: Partial<RemoteThread>): RemoteThread => ({
  id: "thr_x",
  title: "A chat",
  state: "idle",
  machine: "work",
  projectName: null,
  providerId: "claude-code",
  updatedAt: 1000,
  url: "https://work.example.test/threads/thr_x",
  via: "work-bb",
  ...over,
});

const board: FleetBoard = {
  serverId: "laptop-bb",
  serverKey: "laptop",
  columns: [
    { key: "work", label: "work Client", serverId: "work-bb", online: true, lastSeenAt: 5000, threads: [
      t({ id: "a", title: "Compile report", updatedAt: 3000 }),
      t({ id: "b", title: "Master Reports Insights", state: "running", updatedAt: 1000, projectName: "Reports" }),
      t({ id: "c", title: "Sales stages", updatedAt: 4000 }),
    ] },
    { key: "laptop", label: "laptop home", serverId: "laptop-bb", online: true, lastSeenAt: 5000, threads: [
      t({ id: "d", machine: "laptop", via: "laptop-bb", state: "running" }),
    ] },
    { key: "studio", label: "Studio home", serverId: "studio-bb", online: false, lastSeenAt: 2000, threads: [
      t({ id: "e", machine: "studio", via: "laptop-bb", state: "running" }),
      t({ id: "f", machine: "studio", via: "studio-bb", state: "running" }),
    ] },
  ],
};

test("machineKeyOf follows Fleet's host-name rule", () => {
  assert.equal(machineKeyOf("Sam’s Laptop MacBook Pro", "studio", profile), "laptop");
  assert.equal(machineKeyOf("studio", "laptop", profile), "studio");
  assert.equal(machineKeyOf("work build box", "laptop", profile), "work");
  assert.equal(machineKeyOf(null, "laptop", profile), "laptop");
  assert.equal(machineKeyOf("Mystery Mac", "laptop", profile), "Mystery Mac");
});

test("subLabel drops the key from Fleet's label", () => {
  assert.equal(subLabel("work Client", "work"), "Client");
  assert.equal(subLabel("studio", "studio"), "");
  assert.equal(subLabel("Studio Mac", "M9"), "Studio Mac");
});

test("remoteFor keeps only chats from another bb, running first, then newest", () => {
  assert.deepEqual(remoteFor(board, "work").map((x) => x.id), ["b", "c", "a"]);
  assert.deepEqual(remoteFor(board, "laptop").map((x) => x.id), []);
  assert.deepEqual(remoteFor(board, "studio").map((x) => x.id), ["f"]);
  assert.deepEqual(remoteFor(board, "M9"), []);
});

test("chipsFor orders Laptop, Studio, Work and shows exactly the running view's counts, with the quiet ones apart", () => {
  const chips = chipsFor(board, { laptop: { running: 3, stuck: 0, stuckAt: null }, studio: { running: 2, stuck: 1, stuckAt: 900 } }, profile);
  assert.deepEqual(chips.map((c) => c.key), ["laptop", "studio", "work"]);
  assert.deepEqual(chips.map((c) => c.cooking), [3, 2, 0]);
  assert.deepEqual(chips.map((c) => c.stuck), [undefined, 1, undefined]);
  assert.deepEqual(chips.map((c) => c.sub), ["home", "home", "Client"]);
  assert.equal(chips[1].online, false);
  assert.equal(chips[1].lastSeenAt, 2000);
});

test("remoteSections groups by project in first-seen order, no project is Personal", () => {
  const sections = remoteSections(remoteFor(board, "work"));
  assert.deepEqual(sections.map((s) => s.name), ["Reports", "Personal"]);
  assert.deepEqual(sections[1].threads.map((x) => x.id), ["c", "a"]);
});

test("pickMachine falls back to this bb when the remembered machine has gone", () => {
  assert.equal(pickMachine(board, "work", profile), "work");
  assert.equal(pickMachine(board, "M9", profile), "laptop");
  assert.equal(pickMachine(null, "work", profile), "laptop");
});

test("an enrolled host cannot make an unverified independent owner look ready", () => {
  const observed: FleetBoard = { ...board, columns: [{ ...board.columns[2], online: true, ownerStatus: "unknown", enrolledOnline: true, resources: null }] };
  const chip = chipsFor(observed, {}, profile)[0];
  assert.equal(chip.online, false);
  assert.equal(chip.enrolledOnline, true);
  assert.equal(chip.ownerStatus, "unknown");
});

test("machineMetric shows CPU, free RAM and the age of the reading together", () => {
  const resources = { observedAt: 100_000, cpuCount: 8, cpuUtilization: 0.42, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 28 * 1024 ** 3 };
  const chip = { key: "studio", sub: "home", online: true, cooking: 0, lastSeenAt: 100_000, ownerStatus: "live" as const, resources };
  assert.deepEqual(machineMetric(chip, 127_000), { line: "42% CPU · 28 GB free", age: "updated 27s ago", stale: false });
});

test("machineMetric marks a reading older than a minute as stale and keeps its numbers", () => {
  const resources = { observedAt: 0, cpuCount: 8, cpuUtilization: 0.99, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 2 * 1024 ** 3 };
  const chip = { key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: 0, resources };
  assert.deepEqual(machineMetric(chip, 180_000), { line: "99% CPU · 2 GB free", age: "stale · updated 3m ago", stale: true });
});

test("machineMetric marks readings from an offline or unverified owner as stale and tolerates a missing CPU figure", () => {
  const resources = { observedAt: 1_000, cpuCount: 8, cpuUtilization: null, totalMemoryBytes: 1, availableMemoryBytes: 8 * 1024 ** 3 };
  assert.deepEqual(machineMetric({ key: "work", sub: "", online: false, cooking: 0, lastSeenAt: 1_000, resources }, 11_000), { line: "CPU n/a · 8 GB free", age: "stale · updated 10s ago", stale: true });
  assert.equal(machineMetric({ key: "work", sub: "", online: true, cooking: 0, lastSeenAt: 1_000, ownerStatus: "stale", resources }, 11_000).stale, true);
});

test("machineMetric without a reading says so instead of leaving the age blank", () => {
  assert.deepEqual(machineMetric({ key: "laptop", sub: "laptop", online: true, cooking: 0, lastSeenAt: 5 }, 1_000), { line: "laptop", age: "no health data", stale: false });
  assert.deepEqual(machineMetric({ key: "work", sub: "", online: false, cooking: 0, lastSeenAt: 1_000 }, 121_000), { line: "offline", age: "stale · last seen 2m ago", stale: true });
  assert.equal(machineMetric({ key: "work", sub: "", online: false, cooking: 0, lastSeenAt: null }, 1_000).age, "stale · never seen");
});

test("machineMetric labels a live owner with no reading as no health data, matching its stale flag", () => {
  const chip = { key: "studio", sub: "home", online: true, cooking: 0, lastSeenAt: 995, ownerStatus: "live" as const, resources: null };
  assert.deepEqual(machineMetric(chip, 1_000), { line: "home", age: "no health data", stale: false });
});

test("machineMetric keeps every no-reading label consistent with its stale flag", () => {
  for (const ownerStatus of [undefined, "live", "stale", "unknown"] as const) {
    for (const online of [true, false]) {
      const chip = { key: "studio", sub: "", online, cooking: 0, lastSeenAt: 995, ...(ownerStatus ? { ownerStatus } : {}) };
      const m = machineMetric(chip, 1_000);
      assert.equal(m.age.startsWith("stale"), m.stale, `${ownerStatus} online=${online}: ${m.age}`);
    }
  }
});

test("sinceLabel rounds down and a reading exactly a minute old is already stale", () => {
  assert.equal(sinceLabel(0, 90_000), "1m");
  const resources = { observedAt: 0, cpuCount: 8, cpuUtilization: 0.5, totalMemoryBytes: 1, availableMemoryBytes: 4 * 1024 ** 3 };
  assert.equal(machineMetric({ key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: 0, resources }, 60_000).stale, true);
  assert.equal(machineMetric({ key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: 0, resources }, 59_999).stale, false);
});

test("machineMetric shows free RAM under a gigabyte with one decimal", () => {
  const resources = { observedAt: 0, cpuCount: 8, cpuUtilization: 0.5, totalMemoryBytes: 1, availableMemoryBytes: 0.4 * 1024 ** 3 };
  assert.equal(machineMetric({ key: "studio", sub: "", online: true, cooking: 0, lastSeenAt: 0, resources }, 1_000).line, "50% CPU · 0.4 GB free");
});

const GB = 1024 ** 3;
const system = {
  cpuPercent: 42.4, cores: 10, loadAvg: [1.234, 2, 3.5] as [number, number, number],
  memUsedBytes: 12.34 * GB, memTotalBytes: 32 * GB, memPressure: "warn" as const, swapUsedBytes: 1.5 * GB,
  diskFreeBytes: 120 * GB, diskTotalBytes: 2048 * GB, keepAwake: ["Amphetamine", "caffeinate"],
};

test("system view for a machine tile hover", () => {
  const v = systemView("laptop", system, profile)!;
  assert.deepEqual(v.cpu, { fraction: 0.424, text: "42%", cores: "10 cores" });
  assert.deepEqual(v.ram, { fraction: 12.34 / 32, text: "12.3 GB of 32.0 GB", pressure: "warn", pressureText: "Memory pressure rising" });
  assert.equal(v.swap, "1.5 GB in use");
  assert.equal(v.load, "1.23 \u00b7 2.00 \u00b7 3.50");
  assert.equal(v.disk, "120.0 GB free of 2.0 TB");
  assert.equal(v.keepAwake, "Kept awake by Amphetamine, caffeinate");
  assert.equal(systemView("studio", { ...system, memPressure: "critical" }, profile)!.ram!.pressureText, "Memory pressure critical");
  assert.equal(systemView("studio", { ...system, memPressure: "normal" }, profile)!.ram!.pressureText, "Memory pressure normal");
});

test("system view leaves out swap at zero and any missing reading", () => {
  const v = systemView("studio", { ...system, swapUsedBytes: 0, cpuPercent: null, loadAvg: null, diskFreeBytes: null, keepAwake: [] }, profile)!;
  assert.equal(v.swap, null);
  assert.equal(v.cpu, null);
  assert.equal(v.load, null);
  assert.equal(v.disk, null);
  assert.equal(v.keepAwake, null);
  assert.ok(v.ram);
});

test("system view shows nothing when system is null, missing, empty or Work", () => {
  assert.equal(systemView("studio", null, profile), null);
  assert.equal(systemView("studio", undefined, profile), null);
  assert.equal(systemView("work", system, profile), null);
  assert.equal(systemView("studio", { cpuPercent: null, cores: null, loadAvg: null, memUsedBytes: null, memTotalBytes: null, memPressure: null, swapUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, keepAwake: [] }, profile), null);
  assert.deepEqual(chipsFor({ serverId: "s", serverKey: "laptop", columns: [{ key: "studio", label: "studio", serverId: null, online: true, lastSeenAt: 1, threads: [], system }] }, {}, profile)[0]?.system, system);
});

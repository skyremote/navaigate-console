import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fleet-live-2026-11-01.json";
import { boardSchema, collectFleetDoctor, detailSchema, formatFleetDoctor } from "../fleet-doctor";
import { fleetBoardResultSchema, fleetBoardSchema, fleetOwnerDetailSchema, fleetRouteSchema } from "../server-fleet";
import { fetched, normaliseOwnerRows, plainReason } from "../server-attention-owners";
import { fleetUsageResult } from "../server-attention-integrations";
import { nativeResult } from "../server-usage-fleet";

// Payloads read from the live Fleet (382cdd5) on 1 Nov 2026, with ids, paths and titles removed.
// The Fleet doctor and the Work needs you page failed on these while their hand-made test data passed.

describe("live Fleet payloads against the Console's schemas", () => {
  it("reads the board, including each Mac's system block and Work with no system reading", () => {
    const board = fleetBoardSchema.parse(fixture.board);
    expect(board.columns.map((c) => c.key)).toEqual(["laptop", "studio", "work"]);
    expect(board.columns[0]?.system).toMatchObject({ memPressure: "normal", cores: 18 });
    expect(board.columns[2]?.system).toBeNull();
    expect(board.columns[2]?.ownerStatus).toBe("stale");
    const forRail = fleetBoardResultSchema.parse({
      available: true,
      error: null,
      board: { serverId: board.me.serverId, serverKey: "laptop", columns: board.columns.map(({ key, label, serverId, online, lastSeenAt, threads, mirror, ownerStatus, ownerOnline, enrolledOnline, system }) => ({ key, label, serverId, online, lastSeenAt, threads, mirror, ownerStatus, ownerOnline, enrolledOnline, system })) },
    });
    expect(forRail.board?.columns[1]?.system?.cpuPercent).toBeTypeOf("number");
  });

  it("keeps a Mac's board when its system block carries values it does not know", () => {
    const odd = structuredClone(fixture.board) as typeof fixture.board & { columns: Array<Record<string, unknown>> };
    odd.columns[0]!.system = { ...(odd.columns[0]!.system as object), memPressure: "severe", loadAvg: "n/a", keepAwake: null, newField: 1 };
    const parsed = fleetBoardSchema.parse(odd);
    expect(parsed.columns[0]?.system).toMatchObject({ memPressure: null, loadAvg: null, keepAwake: [] });
    odd.columns[0]!.threads = [{ ...(fixture.board.columns[0]!.threads[0] as object), state: "paused" }];
    expect(fleetBoardSchema.parse(odd).columns[0]?.threads[0]?.state).toBe("idle");
  });

  it("reads the board for the doctor", () => {
    expect(boardSchema.parse(fixture.board).transport).toMatchObject({ broker: "healthy", directM1: "ready", directM1Error: null });
  });

  it("reads every Mac's owner detail, whose binding reason and host id are null when there is nothing to say", () => {
    for (const machine of ["laptop", "studio", "work"] as const) {
      const raw = fixture.ownerDetail[machine];
      expect(() => detailSchema.parse(raw), machine).not.toThrow();
      expect(() => fleetOwnerDetailSchema.parse(raw), machine).not.toThrow();
    }
    expect(fixture.ownerDetail.laptop.binding.reason).toBeNull();
    expect(fixture.ownerDetail.work.binding.enrolledHostId).toBeNull();
  });

  it("shows plain values on every Fleet doctor row instead of Unreadable", async () => {
    const report = await collectFleetDoctor({
      machines: ["laptop", "studio", "work"],
      board: async () => boardSchema.parse(fixture.board),
      ownerDetail: async (machine) => detailSchema.parse(fixture.ownerDetail[machine as "laptop"]),
    });
    expect(report.machines.map((m) => [m.machine, m.error, m.ok])).toEqual([["laptop", null, true], ["studio", null, true], ["work", null, false]]);
    expect(report.machines[0]?.binding).toMatch(/^verified enrolled host /);
    expect(report.machines[2]?.binding).toBe("not proven (The independent owner did not report a hardware identity)");
    const text = formatFleetDoctor(report);
    expect(text).not.toMatch(/unreadable/i);
    expect(text).toMatch(/Work: NO ROUTE/);
  });

  it("shows a verified Mac with a null host id and an unproven one with a null reason as plain words", async () => {
    const report = await collectFleetDoctor({
      machines: ["studio", "work"],
      board: async () => boardSchema.parse(fixture.board),
      ownerDetail: async (machine) => {
        const raw = structuredClone(fixture.ownerDetail.studio) as typeof fixture.ownerDetail.studio;
        raw.binding = machine === "studio" ? { ...raw.binding, verified: true, enrolledHostId: null as never } : { ...raw.binding, verified: false, reason: null as never };
        return detailSchema.parse(raw);
      },
    });
    expect(report.machines.map((m) => m.binding)).toEqual(["verified enrolled host ?", "not proven (no reason given)"]);
  });

  it("reads the route preview, with a null score for a manual choice", () => {
    expect(fleetRouteSchema.parse(fixture.route.studio).candidates[0]?.score).toBeNull();
    expect(fleetRouteSchema.parse(fixture.route.auto).candidates.length).toBeGreaterThan(1);
  });

  it("reads the owner usage snapshot in both places that fetch it", () => {
    expect(() => nativeResult.parse(fixture.usage.studio)).not.toThrow();
    expect(() => fleetUsageResult.parse(fixture.usage.studio)).not.toThrow();
  });
});

describe("Work needs you reads another Mac's inbox", () => {
  const ok = (rows: unknown[]) => ({ state: "ok", reason: null, snapshot: { ...fixture.ownerInbox, rows } });

  it("accepts every status the owners send now, stashed included, and keeps the row", () => {
    const parsed = fetched.parse(ok(fixture.ownerInbox.rows));
    const { rows, unknown } = normaliseOwnerRows(parsed.snapshot!.rows);
    expect(rows.map((r) => r.status)).toEqual(fixture.ownerInbox.rows.map((r) => r.status));
    expect(rows.some((r) => r.status === "stashed")).toBe(true);
    expect(unknown.size).toBe(0);
  });

  it("shows a status it does not know, or none, as needs-you rather than failing the Mac", () => {
    const base = fixture.ownerInbox.rows[0]!;
    const { status: _gone, ...noStatus } = base;
    const rows = [...fixture.ownerInbox.rows, { ...base, threadId: "thr_future", status: "paused-by-a-future-console" }, { ...base, threadId: "thr_null", status: null }, noStatus];
    const parsed = fetched.parse(ok(rows));
    expect(parsed.snapshot?.rows).toHaveLength(rows.length);
    const { rows: shown, unknown } = normaliseOwnerRows(parsed.snapshot!.rows);
    expect(shown.slice(-3).map((r) => r.status)).toEqual(["needs-you", "needs-you", "needs-you"]);
    expect([...unknown]).toEqual([["paused-by-a-future-console", 1], ["(missing)", 2]]);
  });

  it("turns a pasted validation dump into a plain sentence and leaves ordinary reasons alone", () => {
    expect(plainReason('[\n  {\n    "code": "invalid_value"')).toBe("owner attention could not be read (unexpected reply)");
    expect(plainReason("No authenticated owner route is available for this machine.")).toBe("No authenticated owner route is available for this machine.");
    expect(plainReason(null)).toBe("owner attention unavailable");
  });
});

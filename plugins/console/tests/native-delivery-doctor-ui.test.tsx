// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FleetDoctorPanel } from "../src/delivery-doctor";

afterEach(cleanup);
const TURSO = 'HTTP 403: {"error":"Authorization header is invalid: token expired"}';
const report = {
  createdAt: 1_800_000_000_000,
  self: { machine: "laptop", appVersion: "0.48.0" },
  broker: { state: "unavailable", lastSyncAt: 1_799_999_000_000, error: TURSO, directM1: "ready", directM1Error: null },
  machines: [
    { machine: "laptop", ok: true, activeRoute: "self", appVersion: "0.48.0", routes: [{ kind: "self", state: "healthy", detail: null }], binding: "verified enrolled host host-Laptop", error: null },
    { machine: "studio", ok: true, activeRoute: "ssh", appVersion: "0.48.1", routes: [{ kind: "ssh", state: "healthy", detail: "SSH OK" }, { kind: "broker", state: "unavailable", detail: "broker down" }], binding: "verified enrolled host host-Studio", error: null },
    { machine: "work", ok: false, activeRoute: "none", appVersion: null, routes: [{ kind: "ssh", state: "unconfigured", detail: null }], binding: "not proven (no route)", error: null },
  ],
  text: "This bb: Laptop\nBroker error: x",
};
const mount = (rpc: Record<string, (input: never) => unknown> = {}) =>
  renderSlot({ component: () => <FleetDoctorPanel /> }, {}, { rpc: { delivery_fleet_doctor: () => report, ...rpc } } as never);

describe("Fleet doctor panel", () => {
  it("runs on a click and shows the broker's error body, Studio over SSH and Work with no route", async () => {
    const run = vi.fn(() => report);
    const view = mount({ delivery_fleet_doctor: run });
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Run fleet doctor" }));
    await waitFor(() => view.getByLabelText("Broker error"));
    expect(view.getByLabelText("Broker error").textContent).toContain(TURSO);
    const m1 = view.getByRole("listitem", { name: "Studio" });
    expect(m1.textContent).toContain("OK");
    expect(m1.textContent).toContain("ssh healthy (SSH OK)");
    const m4 = view.getByRole("listitem", { name: "Work" });
    expect(m4.textContent).toContain("No route");
    expect(m4.textContent).toContain("not proven (no route)");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("names a machine that could not be read and keeps the others", async () => {
    const view = mount({ delivery_fleet_doctor: () => ({ ...report, machines: [report.machines[0], { ...report.machines[1], ok: false, activeRoute: null, routes: [], error: "ssh: connect timed out" }] }) });
    fireEvent.click(view.getByRole("button", { name: "Run fleet doctor" }));
    await waitFor(() => view.getByRole("listitem", { name: "Studio" }));
    expect(view.getByRole("listitem", { name: "Studio" }).textContent).toContain("Unreadable: ssh: connect timed out");
    expect(view.getByRole("listitem", { name: "Laptop" }).textContent).toContain("OK");
  });

  it("shows an RPC failure instead of an empty panel", async () => {
    const view = mount({ delivery_fleet_doctor: () => { throw new Error("fleet plugin not installed"); } });
    fireEvent.click(view.getByRole("button", { name: "Run fleet doctor" }));
    await waitFor(() => within(view.container).getByRole("alert"));
    expect(view.getByRole("alert").textContent).toContain("fleet plugin not installed");
  });
});

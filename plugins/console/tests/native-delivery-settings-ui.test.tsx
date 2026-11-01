// @vitest-environment jsdom
import React from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DeliverySettings } from "../src/delivery";
import { resetRpcFlight } from "../src/rpc-flight";

const settings = { revision: 1, resolved: [], appliedTo: "delivery-tasks", remoteApplied: false };
const matrix = { revision: 1, readAt: 0, hosts: [] };
const helper = { choices: { title: null, commit: null }, runs: [], serviceRegistered: true };
const services = { selections: { "thread-title": { mode: "automatic" }, "commit-message": { mode: "automatic" }, voice: { mode: "automatic" } }, services: [] };
const slow = () => new Promise((resolve) => setTimeout(resolve, 20));
const setVisibility = (state: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
afterEach(() => {
  cleanup();
  setVisibility("visible");
});

function show(counts: { settings: number; matrix: number }) {
  return renderSlot({ component: DeliverySettings }, {}, {
    context: { projectId: "proj-1", threadId: null },
    rpc: {
      delivery_settings: async () => (counts.settings++, await slow(), settings),
      delivery_matrix: async () => (counts.matrix++, await slow(), matrix),
      delivery_helper_models: () => helper,
    },
    sdk: { system: { aiServices: async () => services } } as never,
  } as never);
}

describe("Delivery settings reads", () => {
  it("reads the machine matrix and the settings at most three times, not once per event, for a burst of 50", async () => {
    resetRpcFlight();
    const counts = { settings: 0, matrix: 0 };
    const view = show(counts);
    await waitFor(() => expect(counts.matrix).toBe(1));
    await act(async () => {
      for (let wave = 0; wave < 5; wave++) {
        await Promise.all(Array.from({ length: 10 }, () => view.behavior.emitRealtime("delivery-settings", {})));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    await waitFor(() => expect(counts.matrix).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(counts.matrix).toBeLessThanOrEqual(3);
    expect(counts.settings).toBeLessThanOrEqual(counts.matrix + 1);
  });

  it("does not ask every machine for its models while the document is hidden", async () => {
    const counts = { settings: 0, matrix: 0 };
    const view = show(counts);
    await waitFor(() => expect(counts.matrix).toBe(1));
    setVisibility("hidden");
    await act(async () => {
      await Promise.all(Array.from({ length: 5 }, () => view.behavior.emitRealtime("delivery-settings", {})));
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(counts.matrix).toBe(1);
  });
});

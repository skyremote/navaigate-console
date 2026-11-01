import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  createEventInbox,
  webhookSignature,
  type HookConfig,
  type EventTransport,
} from "../server-event-inbox";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
});
const SECRET = ["synthetic", "test", "value", "of", "at", "least", "32", "characters"].join("-");
function fixture(options: Partial<HookConfig> = {}) {
  let now = 1_800_000_000_000,
    online = true,
    unknown = false,
    calls = 0;
  const keys: string[] = [];
  const runs = new Map<string, string>();
  const hook = {
    id: "ci",
    enabled: true,
    ownerServerId: "owner-m1",
    hostId: "host-m1",
    projectId: "project",
    automationId: "automation",
    holdOffline: true,
    coalesceSeconds: 0,
    filters: [],
    ...options,
  };
  const transport: EventTransport = {
    available: async () => online,
    run: async (_h, key) => {
      calls++;
      keys.push(key);
      if (unknown) return { kind: "unknown" };
      if (!online) return { kind: "offline" };
      const runId = runs.get(key) ?? `run-${runs.size + 1}`;
      runs.set(key, runId);
      return { kind: "admitted", runId };
    },
  };
  const host = createFakePluginHost({
    pluginId: "attention-hook-test",
    settings: {
      webhookEnabled: true,
      webhookSecret: SECRET,
      webhookHooks: JSON.stringify([hook]),
      webhookPublicBaseUrl: "https://synthetic.getbb.app",
    },
  });
  hosts.push(host);
  let engine = createEventInbox(host.bb, transport, () => now);
  const headers = (body: string, delivery = "delivery-1", timestamp = String(now)) =>
    new Headers({
      "content-type": "application/json",
      "x-nav-hook": "ci",
      "x-nav-delivery": delivery,
      "x-nav-timestamp": timestamp,
      "x-nav-signature": webhookSignature(SECRET, "ci", timestamp, delivery, body),
    });
  return {
    ...host,
    get engine() {
      return engine;
    },
    headers,
    transport,
    keys,
    runs,
    get calls() {
      return calls;
    },
    online(v: boolean) {
      online = v;
    },
    unknown(v: boolean) {
      unknown = v;
    },
    advance(ms: number) {
      now += ms;
    },
    async reload() {
      await host.harness.lifecycle.reload((bb) => {
        engine = createEventInbox(bb, transport, () => now);
      });
    },
  };
}
describe("authenticated durable webhook admission", () => {
  it("verifies timestamped signatures and bounds payloads before accepting", async () => {
    const f = fixture();
    const raw = '{"event":"ci_failed"}';
    const headers = f.headers(raw);
    headers.set("x-nav-signature", "invalid");
    expect((await f.engine.receive(headers, raw)).status).toBe(401);
    expect((await f.engine.receive(f.headers(raw, "stale", "1799999000000"), raw)).status).toBe(
      401,
    );
    expect((await f.engine.receive(f.headers(raw), raw + " ")).status).toBe(401);
    expect((await f.engine.receive(f.headers("x"), "x".repeat(65537))).status).toBe(413);
    // An unknown hook gets exactly the answer a bad signature gets, so hook names cannot be guessed.
    const unknown = f.headers(raw);
    unknown.set("x-nav-hook", "no-such-hook");
    const bad = await f.engine.receive(headers, raw);
    expect(await f.engine.receive(unknown, raw)).toEqual(bad);
    expect(bad.status).toBe(401);
    expect((await f.engine.state()).receipts).toHaveLength(0);
    expect(f.calls).toBe(0);
  });
  it("binds the HMAC to the hook selector so a valid request cannot be replayed against another task", async () => {
    const f = fixture();
    const base = (await f.engine.state()).hooks[0]!;
    await f.harness.behavior.setSettings({
      webhookHooks: JSON.stringify([base, { ...base, id: "other", automationId: "other-task" }]),
    });
    const headers = f.headers("{}");
    headers.set("x-nav-hook", "other");
    expect((await f.engine.receive(headers, "{}")).status).toBe(401);
    expect((await f.engine.state()).receipts).toHaveLength(0);
    expect(f.calls).toBe(0);
  });
  it("persists immutable execution binding and refuses held or claimed events after configuration repoints across restart", async () => {
    const f = fixture();
    f.online(false);
    await f.engine.receive(f.headers("{}"), "{}");
    const first = (await f.engine.state()).receipts[0]!;
    const original = (await f.engine.state()).hooks[0]!;
    await f.harness.behavior.setSettings({
      webhookHooks: JSON.stringify([
        { ...original, ownerServerId: "owner-b", automationId: "task-b" },
      ]),
    });
    await f.reload();
    f.online(true);
    await f.engine.tick();
    expect(f.calls).toBe(0);
    expect((await f.engine.state()).receipts[0]?.state).toBe("refused");
    expect(first.binding.ownerServerId).toBe("owner-m1");
    const claimed = fixture();
    await claimed.engine.receive(claimed.headers("{}"), "{}");
    const pending = (await claimed.engine.state()).receipts[0]!;
    claimed.bb.storage
      .database()
      .prepare("UPDATE nav_hook_events SET value=? WHERE id=?")
      .run(JSON.stringify({ ...pending, state: "dispatching" }), pending.id);
    await claimed.harness.behavior.setSettings({
      webhookHooks: JSON.stringify([
        { ...(await claimed.engine.state()).hooks[0]!, automationId: "changed" },
      ]),
    });
    await claimed.reload();
    await claimed.engine.tick();
    expect(claimed.calls).toBe(0);
    expect((await claimed.engine.state()).receipts[0]?.state).toBe("unknown");
  });
  it("accepts durably without executing in HTTP request and deduplicates across reload", async () => {
    const f = fixture();
    const raw = '{"event":"ci_failed","text":"untrusted prompt"}';
    expect((await f.engine.receive(f.headers(raw), raw)).status).toBe(202);
    expect(f.calls).toBe(0);
    await f.reload();
    const duplicate = await f.engine.receive(f.headers(raw), raw);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    await f.engine.tick();
    await f.engine.tick();
    expect(f.calls).toBe(1);
    expect(f.runs.size).toBe(1);
    expect((await f.engine.state()).receipts[0]?.state).toBe("owner-accepted");
    const state = JSON.stringify(await f.engine.state());
    expect(state).not.toContain(SECRET);
    expect(state).not.toContain("untrusted prompt");
    const different = '{"event":"different"}';
    expect((await f.engine.receive(f.headers(different), different)).status).toBe(409);
  });
  it("holds offline only when opted in and expires after 24 hours", async () => {
    const f = fixture();
    f.online(false);
    const raw = "{}";
    expect((await f.engine.receive(f.headers(raw), raw)).status).toBe(202);
    await f.engine.tick();
    expect(f.calls).toBe(0);
    f.advance(86400_001);
    await f.engine.tick();
    f.online(true);
    await f.engine.tick();
    expect(f.calls).toBe(0);
    expect((await f.engine.state()).receipts[0]?.state).toBe("expired");
    const disabled = fixture({ holdOffline: false });
    disabled.online(false);
    expect((await disabled.engine.receive(disabled.headers(raw), raw)).status).toBe(503);
  });
  it("persists burst coalescing, applies filters and executes only one fixed automation", async () => {
    const f = fixture({ coalesceSeconds: 20, filters: [{ path: "ci.status", equals: "failed" }] });
    const pass = '{"ci":{"status":"passed"}}';
    expect((await f.engine.receive(f.headers(pass), pass)).body.filtered).toBe(true);
    const raw = '{"ci":{"status":"failed"}}';
    await f.engine.receive(f.headers(raw, "a"), raw);
    await f.reload();
    await f.engine.receive(f.headers(raw, "b"), raw);
    await f.engine.tick();
    expect(f.calls).toBe(0);
    f.advance(20_000);
    await f.engine.tick();
    expect(f.calls).toBe(1);
    const rows = (await f.engine.state()).receipts;
    expect(rows.find((r) => r.deliveryId === "a")?.count).toBe(2);
    expect(rows.find((r) => r.deliveryId === "b")?.state).toBe("coalesced");
  });
  it("never blindly retries an unknown owner effect", async () => {
    const f = fixture();
    f.unknown(true);
    const raw = "{}";
    await f.engine.receive(f.headers(raw), raw);
    await f.engine.tick();
    await f.reload();
    await f.engine.tick();
    expect(f.calls).toBe(1);
    expect((await f.engine.state()).receipts[0]?.state).toBe("unknown");
  });
  it("records a definite owner refusal with its reason and does not retry it", async () => {
    const f = fixture();
    let attempts = 0;
    f.transport.run = async () => {
      attempts++;
      return { kind: "refused", reason: "plugin automations has no rpc method experimental_automations_execution_guard" };
    };
    await f.engine.receive(f.headers("{}"), "{}");
    await f.engine.tick();
    await f.engine.tick();
    const receipt = (await f.engine.state()).receipts[0]!;
    expect(attempts).toBe(1);
    expect(receipt).toMatchObject({ state: "refused", runId: null });
    expect(receipt.error).toContain("execution_guard");
  });
  it("reconciles a dispatch crash with the identical durable owner key", async () => {
    const f = fixture();
    const raw = "{}";
    await f.engine.receive(f.headers(raw), raw);
    const r = (await f.engine.state()).receipts[0]!;
    const key = `nav-hook:${r.id}`;
    f.runs.set(key, "previous-owner-run");
    f.bb.storage
      .database()
      .prepare("UPDATE nav_hook_events SET value=? WHERE id=?")
      .run(JSON.stringify({ ...r, state: "dispatching" }), r.id);
    await f.reload();
    await f.engine.tick();
    expect(f.keys).toEqual([key]);
    expect(f.runs.size).toBe(1);
    expect((await f.engine.state()).receipts[0]?.runId).toBe("previous-owner-run");
  });
  it("enforces per-task pending bounds and exposes the configured existing Connect endpoint", async () => {
    const f = fixture({ coalesceSeconds: 0 });
    f.online(false);
    for (let i = 0; i < 100; i++) await f.engine.receive(f.headers("{}", `d-${i}`), "{}");
    expect((await f.engine.receive(f.headers("{}", "overflow"), "{}")).status).toBe(429);
    expect((await f.engine.state()).endpoint).toBe(
      "https://synthetic.getbb.app/api/v1/plugins/attention-hook-test/http/automation-hook",
    );
  });
  it("uses the real SDK route with signature checking even though external ingress has no BB session", async () => {
    const f = fixture();
    const raw = "{}";
    const response = await f.harness.behavior.fetchHttp("POST", "/automation-hook", {
      headers: Object.fromEntries(f.headers(raw)),
      body: raw,
    });
    expect(response.status).toBe(202);
    expect(f.calls).toBe(0);
  });
});

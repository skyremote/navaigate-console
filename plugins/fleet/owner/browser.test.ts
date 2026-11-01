import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { browserRpcContract, createOwnerBrowser, type Cdp } from "./browser";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const scope = { threadId: "thr_owned", instanceId: "inst_studio", generation: "gen_1" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture(options: { url?: string; cdpUrl?: string; inputFails?: boolean; hostId?: string | null; pages?: number } = {}) {
  const db = new Database(":memory:");
  dbs.push(db);
  const calls: string[] = [];
  const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  let url = options.url ?? "https://example.test/login";
  const browsers = {
    listInstances: async () => ({ instances: [{ instanceId: "inst_studio", generation: "gen_1", label: "studio desktop", hostId: "host_studio" }] }),
    listTabs: async () => ({ tabs: [{ tabId: "tab_1", threadId: scope.threadId, url, title: "Login", control: null, presentation: "reveal" }] }),
    createTab: async (input: Record<string, unknown>) => { calls.push(`create:${String(input.url)}:${String(input.presentation)}:${String(input.hostId)}`); return { tab: { tabId: "tab_1", threadId: scope.threadId, url: String(input.url), title: "", control: null, presentation: "reveal" } }; },
    captureTab: async () => ({ mimeType: "image/jpeg", width: 1280, height: 800, base64: "/9j/" }),
    acquireControl: async (input: Record<string, unknown>) => { calls.push(`acquire:${JSON.stringify(input.tabIds)}:${String(input.ttlMs)}`); return { leaseId: "lease_1", tabIds: ["tab_1"], controllerLabel: "Fleet takeover", expiresAt: Date.now() + 60_000 }; },
    openConnection: async () => ({ hostId: "host_studio", wsEndpoint: "ws://127.0.0.1:9333/lease", expiresAt: Date.now() + 60_000 }),
    releaseControl: async () => { calls.push("release"); return { ok: true }; },
  };
  const cdp = async (): Promise<Cdp> => ({
    async send(method, params, sessionId) {
      sent.push({ method, params, ...(sessionId ? { sessionId } : {}) });
      if (method === "Target.getTargets") return { targetInfos: Array.from({ length: options.pages ?? 1 }, (_, i) => ({ targetId: `t${i}`, type: "page", url: options.cdpUrl ?? url })) };
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 640, clientHeight: 400 } };
      if (method.startsWith("Input.") && options.inputFails) throw new Error("socket closed");
      return {};
    },
    close() { calls.push("close"); },
  });
  const owner = createOwnerBrowser({ bb: { storage: { database: () => db } } as never, hostId: async () => (options.hostId === undefined ? "host_studio" : options.hostId), browsers: browsers as never, cdp, controllerLabel: "Fleet takeover" });
  return { owner, calls, sent, setUrl: (next: string) => { url = next; } };
}

const expected = { url: "https://example.test/login", width: 1280, height: 800 };

describe("owner browser", () => {
  it("opens an http(s) page as a revealed tab bound to the owner thread on the proven host, once per request id", async () => {
    const f = fixture();
    const open = { v: 1 as const, requestId: uuid(1), ...scope, url: "https://example.test/login" };
    expect(await f.owner.handlers.owner_browser_open(open)).toMatchObject({ state: "applied", result: { tabId: "tab_1" } });
    expect(await f.owner.handlers.owner_browser_open(open)).toMatchObject({ state: "applied" });
    expect(f.calls.filter((call) => call.startsWith("create"))).toEqual(["create:https://example.test/login:reveal:host_studio"]);
    expect(browserRpcContract.owner_browser_open.input.safeParse({ ...open, url: "file:///etc/passwd" }).success).toBe(false);
  });

  it("clicks through a short lease with coordinates scaled from the frame to the page, and releases the lease", async () => {
    const f = fixture();
    const receipt = await f.owner.handlers.owner_browser_input({ v: 1, requestId: uuid(2), ...scope, tabId: "tab_1", expected, input: { kind: "click", x: 640, y: 400 } });
    expect(receipt).toMatchObject({ state: "applied" });
    expect(f.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent").map((entry) => [entry.params.type, entry.params.x, entry.params.y, entry.sessionId])).toEqual([["mousePressed", 320, 200, "s1"], ["mouseReleased", 320, 200, "s1"]]);
    expect(f.calls).toEqual(['acquire:["tab_1"]:60000', "close", "release"]);
    expect(f.sent.every((entry) => entry.method.startsWith("Input.") || entry.method.startsWith("Target.") || entry.method === "Page.getLayoutMetrics")).toBe(true);
  });

  it("sends Enter with its character so a focused form submits, and keys without a character without one", async () => {
    const f = fixture();
    const key = (n: number, name: "Enter" | "Tab") => f.owner.handlers.owner_browser_input({ v: 1, requestId: uuid(n), ...scope, tabId: "tab_1", expected, input: { kind: "key", key: name } });
    expect(await key(20, "Enter")).toMatchObject({ state: "applied" });
    expect(await key(21, "Tab")).toMatchObject({ state: "applied" });
    const events = f.sent.filter((entry) => entry.method === "Input.dispatchKeyEvent").map((entry) => entry.params);
    expect(events).toMatchObject([
      { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" },
      { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 },
      { type: "keyDown", key: "Tab", windowsVirtualKeyCode: 9 },
      { type: "keyUp", key: "Tab", windowsVirtualKeyCode: 9 },
    ]);
    expect(events[2]).not.toHaveProperty("text");
  });

  it("refuses when the page changed since the frame, and never repeats an input under the same id", async () => {
    const f = fixture();
    f.setUrl("https://example.test/account");
    const stale = await f.owner.handlers.owner_browser_input({ v: 1, requestId: uuid(3), ...scope, tabId: "tab_1", expected, input: { kind: "text", text: "hello" } });
    expect(stale).toMatchObject({ state: "refused", message: expect.stringContaining("changed since the frame") });
    expect(f.sent).toHaveLength(0);
    f.setUrl(expected.url);
    const typed = { v: 1 as const, requestId: uuid(4), ...scope, tabId: "tab_1", expected, input: { kind: "text" as const, text: "hello" } };
    await f.owner.handlers.owner_browser_input(typed);
    await f.owner.handlers.owner_browser_input(typed);
    expect(f.sent.filter((entry) => entry.method === "Input.insertText")).toHaveLength(1);
    expect(await f.owner.handlers.owner_browser_input({ ...typed, input: { kind: "text", text: "other" } })).toMatchObject({ state: "refused", message: expect.stringContaining("another browser action") });
  });

  it("keeps an input whose delivery failed midway as unknown, and refuses when the leased page differs", async () => {
    const broken = fixture({ inputFails: true });
    const input = { v: 1 as const, requestId: uuid(5), ...scope, tabId: "tab_1", expected, input: { kind: "key" as const, key: "Enter" as const } };
    expect(await broken.owner.handlers.owner_browser_input(input)).toMatchObject({ state: "unknown" });
    expect(await broken.owner.handlers.owner_browser_receipt({ requestId: uuid(5) })).toMatchObject({ state: "unknown" });
    expect(broken.calls).toContain("release");
    const elsewhere = fixture({ cdpUrl: "https://evil.test/" });
    expect(await elsewhere.owner.handlers.owner_browser_input({ ...input, requestId: uuid(6) })).toMatchObject({ state: "refused", message: expect.stringContaining("does not match") });
    expect(elsewhere.sent.some((entry) => entry.method.startsWith("Input."))).toBe(false);
  });

  it("uses nothing without a proven owner host", async () => {
    const f = fixture({ hostId: null });
    expect(await f.owner.handlers.owner_browser_instances()).toEqual({ hostId: null, instances: [] });
    expect(await f.owner.handlers.owner_browser_open({ v: 1, requestId: uuid(7), ...scope, url: "https://example.test/" })).toMatchObject({ state: "refused" });
  });

  it("reports an action that is still running as unknown, never as stopped, and only a restart proves it never started", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let proofs = 0;
    let created = 0;
    const make = () => createOwnerBrowser({
      bb: { storage: { database: () => db } } as never,
      hostId: async () => { proofs += 1; if (proofs === 1) await gate; return "host_studio"; },
      browsers: { createTab: async () => { created += 1; return { tab: { tabId: "tab_new", threadId: scope.threadId, url: "https://example.test/a", title: "A" } }; } } as never,
      controllerLabel: "Fleet takeover",
    });
    const owner = make();
    const input = { v: 1 as const, requestId: uuid(98), ...scope, url: "https://example.test/a" };
    const first = owner.handlers.owner_browser_open(input);
    expect(await owner.handlers.owner_browser_receipt({ requestId: input.requestId })).toMatchObject({ state: "unknown" });
    expect(await owner.handlers.owner_browser_open(input)).toMatchObject({ state: "unknown" });
    expect(created).toBe(0);
    release();
    expect(await first).toMatchObject({ state: "applied" });
    expect(await owner.handlers.owner_browser_receipt({ requestId: input.requestId })).toMatchObject({ state: "applied" });
    expect(created).toBe(1);

    const stalled = { ...input, requestId: uuid(99) };
    db.prepare("INSERT INTO fleet_browser_receipts (id, method, fingerprint, state, result, message, updated_at) VALUES (?, 'owner_browser_open', 'x', 'claimed', NULL, NULL, 1)").run(stalled.requestId);
    expect(await make().handlers.owner_browser_receipt({ requestId: stalled.requestId })).toMatchObject({ state: "refused" });
  });
});

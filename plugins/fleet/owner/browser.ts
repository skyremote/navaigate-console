// F22: the execution Mac's own browser, driven from another Mac. Everything
// runs on the owner through core's host- and thread-bound desktop browser
// (sdk.experimental_desktopBrowsers): tabs belong to one owner thread, frames
// are core captures, and input goes through a short core lease and its
// lease-scoped CDP endpoint on the owner, limited to Input.* events. Every
// mutation has a durable UUID receipt with a fingerprint; an input whose
// delivery is uncertain stays unknown and is never repeated.
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(256);
const scope = { threadId: id, instanceId: id, generation: id };
const KEYS = ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), x: z.number().min(0).max(20_000), y: z.number().min(0).max(20_000) }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("key"), key: z.enum(KEYS) }).strict(),
]);
const expectedSchema = z.object({ url: z.string().max(32_768), width: z.number().int().positive(), height: z.number().int().positive() }).strict();
const tabSchema = z.object({ tabId: z.string(), threadId: z.string(), url: z.string(), title: z.string() });
const receiptSchema = z.object({
  requestId: z.string(),
  method: z.enum(["owner_browser_open", "owner_browser_input"]),
  state: z.enum(["applied", "refused", "unknown", "unavailable"]),
  result: z.json().nullable(),
  message: z.string().nullable(),
});
export type BrowserReceipt = z.infer<typeof receiptSchema>;

export const browserRpcContract = defineRpcContract({
  owner_browser_instances: { input: z.null(), output: z.object({ hostId: z.string().nullable(), instances: z.array(z.object({ instanceId: z.string(), generation: z.string(), label: z.string() })) }) },
  owner_browser_tabs: { input: z.object(scope).strict(), output: z.object({ tabs: z.array(tabSchema) }) },
  owner_browser_open: { input: z.object({ v: z.literal(1), requestId: z.string().uuid(), ...scope, url: z.string().url().max(4096).refine((value) => /^https?:\/\//i.test(value), "Only http(s) pages are opened") }).strict(), output: receiptSchema },
  owner_browser_frame: { input: z.object({ ...scope, tabId: id }).strict(), output: z.object({ tab: tabSchema, mimeType: z.literal("image/jpeg"), width: z.number(), height: z.number(), base64: z.string() }) },
  owner_browser_input: { input: z.object({ v: z.literal(1), requestId: z.string().uuid(), ...scope, tabId: id, expected: expectedSchema, input: inputSchema }).strict(), output: receiptSchema },
  owner_browser_receipt: { input: z.object({ requestId: z.string().uuid() }).strict(), output: receiptSchema },
});

const callSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("owner_browser_instances"), input: browserRpcContract.owner_browser_instances.input }).strict(),
  z.object({ method: z.literal("owner_browser_tabs"), input: browserRpcContract.owner_browser_tabs.input }).strict(),
  z.object({ method: z.literal("owner_browser_open"), input: browserRpcContract.owner_browser_open.input }).strict(),
  z.object({ method: z.literal("owner_browser_frame"), input: browserRpcContract.owner_browser_frame.input }).strict(),
  z.object({ method: z.literal("owner_browser_input"), input: browserRpcContract.owner_browser_input.input }).strict(),
  z.object({ method: z.literal("owner_browser_receipt"), input: browserRpcContract.owner_browser_receipt.input }).strict(),
]);
/** Source-side forwarder: exactly the six owner browser methods, to this Mac or to the always-on Mac over its SSH owner route. */
export const browserForwardContract = defineRpcContract({
  browser_forward: { input: z.object({ machine: z.string().min(1).max(40), call: callSchema }).strict(), output: z.json() },
});

export interface Cdp {
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  close(): void;
}

/** A lease-scoped CDP endpoint on this machine (ws://127.0.0.1 only, enforced by core). */
export async function openCdp(wsEndpoint: string): Promise<Cdp> {
  const url = new URL(wsEndpoint);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") throw new Error("Only the owner's own lease endpoint is used");
  const Socket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Socket) throw new Error("This bb runtime has no WebSocket client");
  const socket = new Socket(wsEndpoint);
  await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true }); });
  let next = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  socket.addEventListener("message", (event) => {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "CDP error")); else waiter.resolve(message.result ?? {});
  });
  return {
    send(method, params, sessionId) {
      next += 1;
      const messageId = next;
      return new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        socket.send(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => { if (pending.delete(messageId)) reject(new Error(`CDP ${method} timed out`)); }, 10_000);
      });
    },
    close() { socket.close(); },
  };
}

type Browsers = Pick<BbPluginApi["sdk"]["experimental_desktopBrowsers"], "listInstances" | "listTabs" | "createTab" | "captureTab" | "acquireControl" | "openConnection" | "releaseControl">;

export interface OwnerBrowserDeps {
  bb: BbPluginApi;
  hostId(): Promise<string | null>;
  browsers?: Browsers;
  cdp?: (wsEndpoint: string) => Promise<Cdp>;
  controllerLabel: string;
}

const KEY_TEXT: Partial<Record<(typeof KEYS)[number], string>> = { Enter: "\r" };
const KEY_CODES: Record<(typeof KEYS)[number], number> = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);

export function createOwnerBrowser(deps: OwnerBrowserDeps) {
  const browsers = deps.browsers ?? (deps.bb.sdk.experimental_desktopBrowsers as unknown as Browsers);
  const cdp = deps.cdp ?? openCdp;
  const db = deps.bb.storage.database();
  db.exec("CREATE TABLE IF NOT EXISTS fleet_browser_receipts (id TEXT PRIMARY KEY, method TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT, message TEXT, updated_at INTEGER NOT NULL)");

  const active = new Set<string>();
  const receipt = (requestId: string, method: BrowserReceipt["method"], state: BrowserReceipt["state"], result: unknown, message: string | null): BrowserReceipt => ({ requestId, method, state, result: (result ?? null) as BrowserReceipt["result"], message });
  function stored(requestId: string): BrowserReceipt | null {
    const row = db.prepare("SELECT method, state, result, message FROM fleet_browser_receipts WHERE id = ?").get(requestId) as { method: BrowserReceipt["method"]; state: string; result: string | null; message: string | null } | undefined;
    if (!row) return null;
    if (row.state === "dispatching") return receipt(requestId, row.method, "unknown", null, "The browser action may have run; it is not repeated");
    if (row.state === "claimed" && active.has(requestId)) return receipt(requestId, row.method, "unknown", null, "The browser action is still in progress; read its receipt again, it is not repeated");
    if (row.state === "claimed") return receipt(requestId, row.method, "refused", null, "The action stopped before anything was sent");
    return receipt(requestId, row.method, row.state as BrowserReceipt["state"], row.result ? JSON.parse(row.result) : null, row.message);
  }
  /** Claim before any effect; the same id with other input is refused, a repeat returns the stored receipt. */
  function claim(requestId: string, method: BrowserReceipt["method"], input: unknown): BrowserReceipt | null {
    const fingerprint = sha256(JSON.stringify(input));
    const old = db.prepare("SELECT fingerprint FROM fleet_browser_receipts WHERE id = ?").get(requestId) as { fingerprint: string } | undefined;
    if (old) return old.fingerprint === fingerprint ? stored(requestId) : receipt(requestId, method, "refused", null, "This request id was already used for another browser action");
    db.prepare("INSERT INTO fleet_browser_receipts (id, method, fingerprint, state, result, message, updated_at) VALUES (?, ?, ?, 'claimed', NULL, NULL, ?)").run(requestId, method, fingerprint, Date.now());
    active.add(requestId);
    return null;
  }
  function finish(value: BrowserReceipt): BrowserReceipt {
    active.delete(value.requestId);
    db.prepare("UPDATE fleet_browser_receipts SET state = ?, result = ?, message = ?, updated_at = ? WHERE id = ?").run(value.state, value.result === null ? null : JSON.stringify(value.result), value.message, Date.now(), value.requestId);
    return value;
  }
  async function host(): Promise<string> {
    const hostId = await deps.hostId();
    if (hostId === null) throw new Error("This owner's own host is not proven; its browser is not used");
    return hostId;
  }
  async function tabOf(input: { threadId: string; instanceId: string; generation: string; tabId: string }) {
    const listed = await browsers.listTabs({ hostId: await host(), instanceId: input.instanceId, generation: input.generation, threadId: input.threadId }) as unknown as { tabs: z.infer<typeof tabSchema>[] };
    return listed.tabs.find((tab) => tab.tabId === input.tabId) ?? null;
  }

  return {
    handlers: {
      owner_browser_instances: async () => {
        const hostId = await deps.hostId();
        if (hostId === null) return { hostId: null, instances: [] };
        const listed = await browsers.listInstances({ hostId }) as unknown as { instances: { instanceId: string; generation: string; label: string }[] };
        return { hostId, instances: listed.instances.map(({ instanceId, generation, label }) => ({ instanceId, generation, label })) };
      },
      owner_browser_tabs: async (input: { threadId: string; instanceId: string; generation: string }) => {
        const listed = await browsers.listTabs({ hostId: await host(), ...input }) as unknown as { tabs: z.infer<typeof tabSchema>[] };
        return { tabs: listed.tabs.map(({ tabId, threadId, url, title }) => ({ tabId, threadId, url, title })) };
      },
      owner_browser_open: async (input: z.infer<typeof browserRpcContract.owner_browser_open.input>) => {
        const existing = claim(input.requestId, "owner_browser_open", input);
        if (existing) return existing;
        let hostId: string;
        try { hostId = await host(); } catch (cause) { return finish(receipt(input.requestId, "owner_browser_open", "refused", null, errorText(cause))); }
        db.prepare("UPDATE fleet_browser_receipts SET state = 'dispatching' WHERE id = ?").run(input.requestId);
        try {
          const created = await browsers.createTab({ hostId, instanceId: input.instanceId, generation: input.generation, threadId: input.threadId, url: input.url, presentation: "reveal" }) as unknown as { tab: z.infer<typeof tabSchema> };
          return finish(receipt(input.requestId, "owner_browser_open", "applied", { tabId: created.tab.tabId, url: created.tab.url, title: created.tab.title }, null));
        } catch (cause) {
          return finish(receipt(input.requestId, "owner_browser_open", "unknown", null, `The tab may have opened: ${errorText(cause)}`));
        }
      },
      owner_browser_frame: async (input: { threadId: string; instanceId: string; generation: string; tabId: string }) => {
        const tab = await tabOf(input);
        if (!tab) throw new Error("This tab is no longer open in the owner thread's browser");
        const frame = await browsers.captureTab({ hostId: await host(), ...input }) as unknown as { mimeType: "image/jpeg"; width: number; height: number; base64: string };
        if (frame.base64.length > 1_400_000) throw new Error("The frame is larger than the direct transport allows");
        return { tab: { tabId: tab.tabId, threadId: tab.threadId, url: tab.url, title: tab.title }, mimeType: frame.mimeType, width: frame.width, height: frame.height, base64: frame.base64 };
      },
      owner_browser_input: async (input: z.infer<typeof browserRpcContract.owner_browser_input.input>) => {
        const existing = claim(input.requestId, "owner_browser_input", input);
        if (existing) return existing;
        const refuse = (text: string) => finish(receipt(input.requestId, "owner_browser_input", "refused", null, text));
        let hostId: string;
        try { hostId = await host(); } catch (cause) { return refuse(errorText(cause)); }
        const tab = await tabOf(input).catch(() => null);
        if (!tab) return refuse("The tab is gone; nothing was typed or clicked");
        if (tab.url !== input.expected.url) return refuse("The page changed since the frame you saw; refresh before acting");
        const scopeArgs = { hostId, instanceId: input.instanceId, generation: input.generation, threadId: input.threadId };
        let lease: { leaseId: string };
        try { lease = await browsers.acquireControl({ ...scopeArgs, tabIds: [input.tabId], controllerLabel: deps.controllerLabel, ttlMs: 60_000 }) as unknown as { leaseId: string }; }
        catch (cause) { return refuse(`The browser could not be controlled now (${errorText(cause)}); nothing was sent`); }
        let session: Cdp | null = null;
        try {
          const connection = await browsers.openConnection({ ...scopeArgs, leaseId: lease.leaseId }) as unknown as { wsEndpoint: string };
          session = await cdp(connection.wsEndpoint);
          const targets = await session.send("Target.getTargets", {}) as { targetInfos?: { targetId: string; type: string; url: string }[] };
          const pages = (targets.targetInfos ?? []).filter((info) => info.type === "page");
          if (pages.length !== 1 || pages[0]!.url !== input.expected.url) return refuse("The leased page does not match the frame you saw; nothing was sent");
          const { sessionId } = await session.send("Target.attachToTarget", { targetId: pages[0]!.targetId, flatten: true }) as { sessionId: string };
          const metrics = await session.send("Page.getLayoutMetrics", {}, sessionId) as { cssLayoutViewport?: { clientWidth: number; clientHeight: number } };
          db.prepare("UPDATE fleet_browser_receipts SET state = 'dispatching' WHERE id = ?").run(input.requestId);
          if (input.input.kind === "click") {
            const viewport = metrics.cssLayoutViewport ?? { clientWidth: input.expected.width, clientHeight: input.expected.height };
            const x = input.input.x * (viewport.clientWidth / input.expected.width);
            const y = input.input.y * (viewport.clientHeight / input.expected.height);
            await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
            await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
          } else if (input.input.kind === "text") {
            await session.send("Input.insertText", { text: input.input.text }, sessionId);
          } else {
            const code = KEY_CODES[input.input.key];
            const text = KEY_TEXT[input.input.key];
            await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: input.input.key, code: input.input.key, windowsVirtualKeyCode: code, ...(text ? { text, unmodifiedText: text } : {}) }, sessionId);
            await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: input.input.key, code: input.input.key, windowsVirtualKeyCode: code }, sessionId);
          }
          return finish(receipt(input.requestId, "owner_browser_input", "applied", { kind: input.input.kind }, null));
        } catch (cause) {
          const state = (db.prepare("SELECT state FROM fleet_browser_receipts WHERE id = ?").get(input.requestId) as { state: string }).state;
          return state === "dispatching" ? finish(receipt(input.requestId, "owner_browser_input", "unknown", null, `The input may have reached the page: ${errorText(cause)}`)) : refuse(`Nothing was sent: ${errorText(cause)}`);
        } finally {
          session?.close();
          await browsers.releaseControl({ ...scopeArgs, leaseId: lease.leaseId }).catch(() => undefined);
        }
      },
      owner_browser_receipt: ({ requestId }: { requestId: string }) => stored(requestId) ?? receipt(requestId, "owner_browser_input", "unavailable", null, "no-receipt"),
    },
  };
}

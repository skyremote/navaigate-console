// Hold until sub-agents finish: a message typed into a chat that has running
// child threads (sub-agents) waits here, and is sent to the chat once every
// child has finished. Holds live in plugin kv, so they survive reloads and
// restarts; a background service checks them every few seconds.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const KEY = "hold:";
const RUNNING = new Set(["pending", "starting", "active", "stopping"]);
const TICK_MS = 4_000;

const holdSchema = z.object({ threadId: z.string(), text: z.string(), createdAt: z.number(), error: z.string().nullable().default(null) });
type Hold = z.infer<typeof holdSchema>;

export const holdStateSchema = z.object({
  hold: holdSchema.nullable(),
  /** Child threads of this chat that are still working. */
  running: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
});
export type HoldState = z.infer<typeof holdStateSchema>;

type Row = { id: string; title: string | null; titleFallback?: string | null; status: string; archivedAt?: number | null };

export function createHolds(bb: BbPluginApi) {
  const kv = bb.storage.kv;

  async function runningChildren(threadId: string) {
    const rows = (await bb.sdk.threads.list({ parentThreadId: threadId, includeHidden: true })) as unknown as Row[];
    return rows.filter((r) => !r.archivedAt && RUNNING.has(r.status)).map((r) => ({ id: r.id, title: r.title || r.titleFallback || "Sub-agent", status: r.status }));
  }

  async function state(threadId: string): Promise<HoldState> {
    const hold = ((await kv.get<Hold>(KEY + threadId)) as Hold | undefined) ?? null;
    return { hold, running: await runningChildren(threadId) };
  }

  async function create(threadId: string, text: string): Promise<HoldState> {
    const running = await runningChildren(threadId);
    if (!running.length) throw new Error("No sub-agents are running in this chat, so there is nothing to wait for. Send it normally.");
    const existing = (await kv.get<Hold>(KEY + threadId)) as Hold | undefined;
    // One hold per chat: a second message joins the first, in order.
    const hold: Hold = { threadId, text: existing ? `${existing.text}\n\n${text}` : text, createdAt: existing?.createdAt ?? Date.now(), error: null };
    await kv.set(KEY + threadId, hold);
    bb.log.info(`hold: ${threadId} waits for ${running.length} sub-agent(s)`);
    bb.realtime.publish("holds", { threadId });
    return { hold, running };
  }

  async function cancel(threadId: string): Promise<{ text: string | null }> {
    const hold = (await kv.get<Hold>(KEY + threadId)) as Hold | undefined;
    await kv.delete(KEY + threadId);
    bb.realtime.publish("holds", { threadId });
    return { text: hold?.text ?? null };
  }

  /** Send every hold whose chat has no running children left. */
  async function tick() {
    for (const key of await kv.list(KEY)) {
      const hold = (await kv.get<Hold>(key)) as Hold | undefined;
      if (!hold || hold.error) continue;
      // A missing chat is only forgotten on a definite "not found", never on a network blip.
      let gone = false;
      const parent = (await bb.sdk.threads.get({ threadId: hold.threadId }).catch((e: unknown) => {
        gone = /not found|404/i.test(String(e));
        return null;
      })) as unknown as { id?: string; deletedAt?: number | null } | null;
      if (!parent) {
        if (gone) await kv.delete(key);
        continue;
      }
      if (parent.deletedAt) {
        await kv.delete(key);
        continue;
      }
      if ((await runningChildren(hold.threadId)).length) continue;
      // Delete first: a failed send must not be resent on every tick.
      await kv.delete(key);
      try {
        await bb.sdk.threads.send({ threadId: hold.threadId, mode: "queue-if-active", input: [{ type: "text", text: hold.text, mentions: [] }] } as never);
        bb.log.info(`hold: sent the held message to ${hold.threadId}`);
      } catch (e) {
        // Keep it, marked, so the pill shows the error and the owner can take the text back.
        await kv.set(key, { ...hold, error: e instanceof Error ? e.message : String(e) });
        bb.log.warn(`hold: send to ${hold.threadId} failed: ${String(e)}`);
      }
      bb.realtime.publish("holds", { threadId: hold.threadId });
    }
  }

  bb.background.service("hold-watch", {
    async start(signal) {
      while (!signal.aborted) {
        await tick().catch((e) => bb.log.warn(`hold watch: ${String(e)}`));
        if (signal.aborted) break;
        await new Promise((r) => {
          const t = setTimeout(r, TICK_MS);
          signal.addEventListener("abort", () => { clearTimeout(t); r(null); }, { once: true });
        });
      }
    },
  });

  return { state, create, cancel };
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { folderOfThread } from "./src/folder-of-thread";

const id = z.string().min(1).max(128);
export const attentionPolicy = z
  .object({
    autoMerge: z.boolean().default(false),
    requiredPrUrls: z.array(z.string().url().max(500)).max(20).default([]),
    requiredPrEnvironments: z.record(z.string(), z.string().min(1).max(128)).default({}),
    acceptancePending: z.boolean().default(true),
    inactiveAfterMs: z
      .number()
      .int()
      .min(3_600_000)
      .max(365 * 86400_000)
      .nullable()
      .default(null),
  })
  .strict();
export const attentionRecord = z.object({
  threadId: id,
  mode: z.enum(["open", "settled", "snoozed", "stashed"]),
  wakeAt: z.number().nullable(),
  changedAt: z.number(),
  revision: z.string().uuid().nullable().default(null),
  policy: attentionPolicy,
  stashedAt: z.number().nullable().optional(),
});
export type AttentionRecord = z.infer<typeof attentionRecord>;
export const attentionInput = z
  .object({
    threadIds: z.array(id).min(1).max(200),
    action: z.enum(["settle", "snooze", "restore", "retitle", "stash"]),
    wakeAt: z.number().int().optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const attentionResult = z.object({
  receiptId: z.string(),
  results: z.array(z.object({ threadId: id, ok: z.boolean(), error: z.string().nullable() })),
});
export const attentionState = z.object({
  records: z.array(attentionRecord),
  foldWorking: z.boolean(),
  stashAfterDays: z.number().optional(),
});
export const attentionPr = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["draft", "open", "merged", "closed"]),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  failedCount: z.number().int().nonnegative(),
});
export type AttentionPr = z.infer<typeof attentionPr>;
export const attentionRow = z.object({
  threadId: id,
  remote: z.boolean().optional(),
  policy: attentionPolicy.optional(),
  ownerServerId: z.string().nullable().optional(),
  ownerHostId: z.string().nullable().optional(),
  machine: z.string().min(1).max(40).optional(),
  title: z.string(),
  hostId: z.string().nullable(),
  environmentId: z.string().nullable(),
  status: z.enum([
    "running",
    "waiting",
    "needs-you",
    "failed",
    "reviewable",
    "accepted",
    "snoozed",
    "stashed",
  ]),
  question: z.string().nullable(),
  updatedAt: z.number(),
  pinned: z.boolean(),
  wakeAt: z.number().nullable(),
  pr: attentionPr.nullable().optional(),
});
export const attentionInbox = z.object({
  rows: z.array(attentionRow),
  truncated: z.boolean(),
  notices: z.array(z.string()).optional(),
});
const busy = new Set([
  "active",
  "starting",
  "pending",
  "stopping",
  "waiting-for-host",
  "provisioning",
]);
const defaultPolicy = () => attentionPolicy.parse({});
/** The part of project-folders' `list` answer that says which folder each chat sits in. */
const folderList = z
  .object({
    folders: z.array(z.object({ id: z.string() }).passthrough()),
    bindings: z.record(z.string(), z.string()),
    places: z.record(z.string(), z.string()),
  })
  .passthrough();
const prOutput = z.record(
  z.string(),
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("available"),
      pullRequest: z
        .object({
          url: z.string().url(),
          state: z.enum(["draft", "open", "merged", "closed"]),
          number: z.number().int().positive().optional(),
          checks: z
            .object({
              state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]),
              failedCount: z.number().optional(),
              totalCount: z.number().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    }),
    z.object({ outcome: z.literal("absent") }),
    z.object({ outcome: z.literal("unavailable"), message: z.string() }),
  ]),
);

export function summarisePr(row: z.infer<typeof prOutput>[string] | undefined): AttentionPr | null {
  if (!row || row.outcome !== "available") return null;
  const p = row.pullRequest;
  if (typeof p.number !== "number") return null;
  const checks = p.checks?.state;
  return {
    number: p.number,
    url: p.url,
    state: p.state,
    checks:
      checks === "passing" || checks === "failing" || checks === "pending" ? checks : "none",
    failedCount: p.checks?.failedCount ?? 0,
  };
}

/** Completion is presentation state only. No archive, visibility, section or pin mutations. */
export function createAttention(bb: BbPluginApi, clock = Date.now, featureOn: (id: string) => boolean = () => true) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS nav_attention (thread_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nav_attention_undo (id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0);`);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => {});
    return p;
  };
  const read = (threadId: string): AttentionRecord => {
    const r = db.prepare("SELECT value FROM nav_attention WHERE thread_id = ?").get(threadId) as
      | { value: string }
      | undefined;
    return r
      ? attentionRecord.parse(JSON.parse(r.value))
      : {
          threadId,
          mode: "open",
          wakeAt: null,
          changedAt: 0,
          revision: null,
          policy: defaultPolicy(),
        };
  };
  /**
   * For each stashed chat, the `updatedAt` each of its members had when their events were last read and showed no turn after the stash.
   * A later stash only moves the cut-off forward, so that answer stays right until the member changes again.
   * An entry goes as soon as its chat is written as anything but stashed, so the map never outgrows the Stash.
   */
  const checkedAt = new Map<string, Map<string, number>>();
  const write = (r: AttentionRecord) => {
    if (r.mode !== "stashed") checkedAt.delete(r.threadId);
    return db
      .prepare(
        "INSERT INTO nav_attention VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET value = excluded.value",
      )
      .run(r.threadId, JSON.stringify(r));
  };
  const publish = () => bb.realtime.publish("attention", null);
  // Native model members are top-level hidden threads, deliberately not core children.
  // Read their existing index without creating sessions or reparenting anything.
  const logicalRecord = z.object({
    rootThreadId: id,
    members: z.array(z.object({ id })).max(100),
    arms: z.record(z.string(), z.object({ expiresAt: z.number() })).optional(),
  });
  async function conversation(threadId: string) {
    const lookup = await bb.storage.kv.get<unknown>("native-conversation-root:" + threadId);
    const root = typeof lookup === "string" ? lookup : threadId;
    const raw = await bb.storage.kv.get<unknown>("native-conversation:" + root);
    if (raw === undefined) return { rootThreadId: threadId, members: [{ id: threadId }], arms: {} };
    const record = logicalRecord.parse(raw);
    if (!record.members.some((m) => m.id === threadId))
      return { rootThreadId: threadId, members: [{ id: threadId }], arms: {} };
    return record;
  }
  async function logicalRows(
    threadId: string,
    fallback?: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number],
  ) {
    const record = await conversation(threadId);
    return {
      record,
      rows:
        fallback && record.members.length === 1 && record.members[0]?.id === threadId
          ? [fallback]
          : await bb.sdk.threads.list({
              threadIds: record.members.map((m) => m.id),
              includeHidden: true,
              limit: 200,
            }),
    };
  }

  async function protectedWork(threadId: string) {
    const t = await bb.sdk.threads.get({ threadId });
    if (t.archivedAt || t.deletedAt || t.visibility === "hidden")
      throw new Error("Only a visible, unarchived owning thread can be changed here.");
    if (
      busy.has(t.runtime.displayStatus) ||
      t.activeBackgroundAgentCount > 0 ||
      (await bb.sdk.threads.queue.list({ threadId })).length > 0
    )
      throw new Error("Thread has active or waiting work.");
    if ((await bb.sdk.threads.interactions.list({ threadId })).length)
      throw new Error("Thread has a pending decision.");
    const logical = await logicalRows(threadId);
    if (Object.values(logical.record.arms ?? {}).some((a) => a.expiresAt > clock()))
      throw new Error("A model session is awaiting dispatch.");
    if (
      logical.rows.some(
        (m) =>
          !m.archivedAt &&
          !m.deletedAt &&
          (m.hasPendingInteraction ||
            m.queuedWork !== "none" ||
            busy.has(m.runtime.displayStatus) ||
            Object.values(m.activity).some((n) => n > 0)),
      )
    )
      throw new Error("A model session still has active or waiting work.");
    const children = await bb.sdk.threads.list({
      parentThreadId: threadId,
      includeHidden: true,
      limit: 200,
    });
    if (children.length >= 200)
      throw new Error("Too many child threads to prove settlement safe; review them first.");
    if (
      children.some(
        (c) =>
          !c.archivedAt &&
          (c.hasPendingInteraction ||
            busy.has(c.runtime.displayStatus) ||
            Object.values(c.activity).some((n) => n > 0) ||
            c.queuedWork !== "none"),
      )
    )
      throw new Error("A child still has active or waiting work.");
    return t;
  }
  async function state() {
    return {
      records: (db.prepare("SELECT value FROM nav_attention").all() as { value: string }[]).map(
        (r) => attentionRecord.parse(JSON.parse(r.value)),
      ),
      foldWorking: (await bb.storage.kv.get<boolean>("attention:fold")) ?? false,
      // 0 means never stash: the Stash feature unticked in the picker (EXTRA-A) behaves like that setting.
      stashAfterDays: featureOn("EXTRA-A") ? Number((await settings.get()).stashAfterDays) : 0,
    };
  }
  async function apply(raw: z.infer<typeof attentionInput>, expectedRevision?: string | null) {
    const input = attentionInput.parse(raw);
    return serial(async () => {
      const receiptId = randomUUID();
      const changes: {
        threadId: string;
        before: AttentionRecord;
        after: AttentionRecord;
        oldTitle?: string | null;
        newTitle?: string;
      }[] = [];
      const results = [];
      if (
        input.action === "snooze" &&
        (!input.wakeAt || input.wakeAt <= clock() || input.wakeAt > clock() + 365 * 86400_000)
      )
        throw new Error("Choose a future snooze time within one year.");
      if (input.action === "retitle" && !input.title) throw new Error("A title is required.");
      db.prepare("INSERT INTO nav_attention_undo(id,value,created_at) VALUES (?,?,?)").run(
        receiptId,
        "[]",
        clock(),
      );
      for (const threadId of [...new Set(input.threadIds)]) {
        try {
          if (expectedRevision !== undefined && read(threadId).revision !== expectedRevision)
            throw new Error("Attention choices changed while the automatic check was running.");
          const t =
            input.action === "settle" || input.action === "stash"
              ? await protectedWork(threadId)
              : await bb.sdk.threads.get({ threadId });
          if (t.archivedAt || t.deletedAt || t.visibility === "hidden")
            throw new Error("Thread is unavailable for attention changes.");
          const before = read(threadId),
            after: AttentionRecord = { ...before, changedAt: clock(), revision: randomUUID() };
          if (input.action === "retitle")
            await bb.sdk.threads.update({ threadId, title: input.title! });
          else {
            after.mode =
              input.action === "settle"
                ? "settled"
                : input.action === "snooze"
                  ? "snoozed"
                  : input.action === "stash"
                    ? "stashed"
                    : "open";
            after.wakeAt = input.action === "snooze" ? input.wakeAt! : null;
            if (input.action === "stash") after.stashedAt = clock();
            else delete after.stashedAt;
          }
          changes.push({
            threadId,
            before,
            after,
            ...(input.action === "retitle" ? { oldTitle: t.title, newTitle: input.title } : {}),
          });
          db.transaction(() => {
            write(after);
            db.prepare("UPDATE nav_attention_undo SET value = ? WHERE id = ?").run(
              JSON.stringify(changes),
              receiptId,
            );
          })();
          results.push({ threadId, ok: true, error: null });
        } catch (e) {
          results.push({
            threadId,
            ok: false,
            error: e instanceof Error ? e.message : "Change failed",
          });
        }
      }
      db.prepare("DELETE FROM nav_attention_undo WHERE created_at < ?").run(
        clock() - 7 * 86400_000,
      );
      publish();
      return { receiptId, results };
    });
  }
  async function undo(receiptId: string) {
    return serial(async () => {
      const r = db
        .prepare("SELECT value, undone FROM nav_attention_undo WHERE id = ?")
        .get(receiptId) as { value: string; undone: number } | undefined;
      if (!r) throw new Error("Undo receipt expired or is unknown.");
      if (r.undone) return { receiptId, results: [] };
      const changes = JSON.parse(r.value) as {
        threadId: string;
        before: AttentionRecord;
        after: AttentionRecord;
        oldTitle?: string | null;
        newTitle?: string;
      }[];
      const results = [];
      for (const c of changes) {
        try {
          if (JSON.stringify(read(c.threadId)) !== JSON.stringify(c.after))
            throw new Error("Thread changed since this receipt; restore it explicitly.");
          if (c.newTitle) {
            const t = await bb.sdk.threads.get({ threadId: c.threadId });
            if (t.title !== c.newTitle) throw new Error("Title has since changed.");
            await bb.sdk.threads.update({ threadId: c.threadId, title: c.oldTitle ?? "" });
          }
          write({ ...c.before, changedAt: clock() });
          results.push({ threadId: c.threadId, ok: true, error: null });
        } catch (e) {
          results.push({ threadId: c.threadId, ok: false, error: String(e) });
        }
      }
      db.prepare("UPDATE nav_attention_undo SET undone = 1 WHERE id = ?").run(receiptId);
      publish();
      return { receiptId, results };
    });
  }
  async function wake(
    threadId: string,
    expected?: { revision: string | null; wakeAt: number | null },
  ) {
    return serial(async () => {
      const root = (await conversation(threadId)).rootThreadId;
      const r = read(root);
      if (
        expected &&
        (r.mode !== "snoozed" ||
          r.revision !== expected.revision ||
          r.wakeAt !== expected.wakeAt ||
          (r.wakeAt ?? Infinity) > clock())
      )
        return;
      if (r.mode !== "open") {
        const { stashedAt: _stashedAt, ...rest } = r;
        write({ ...rest, mode: "open", wakeAt: null, changedAt: clock(), revision: randomUUID() });
      }
      publish();
    });
  }
  type Member = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
  /**
   * When the last real turn happened in a chat: the newest user message or finished turn.
   * Renames, read marks and other metadata edits move `updatedAt` but are not work, so they do not count.
   * Null when there is none; undefined when the events cannot be read, so the answer is not remembered.
   */
  async function lastTurnAt(threadId: string): Promise<number | null | undefined> {
    try {
      const rows = (await bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "1",
        types: ["client/turn/requested", "turn/completed"],
      })) as unknown as { createdAt?: number }[];
      const at = rows[0]?.createdAt;
      return typeof at === "number" ? at : null;
    } catch {
      return undefined;
    }
  }
  /** A stashed chat comes back only on real new work: a turn or message after it was stashed, a queued message, a question or running work. */
  async function hasNewActivity(record: AttentionRecord, members: Member[]) {
    const since = record.stashedAt ?? record.changedAt;
    if (
      members.some(
        (m) =>
          m.hasPendingInteraction ||
          m.queuedWork !== "none" ||
          busy.has(m.runtime.displayStatus) ||
          Object.values(m.activity).some((n) => n > 0),
      )
    )
      return true;
    for (const m of members) {
      if (m.updatedAt <= since) continue; // nothing changed at all, so no event lookup
      if (checkedAt.get(record.threadId)?.get(m.id) === m.updatedAt) continue; // already read at this updatedAt, and it held no new turn
      const turn = await lastTurnAt(m.id);
      if (turn === undefined) continue;
      if (turn !== null && turn > since) {
        checkedAt.delete(record.threadId);
        return true;
      }
      const seen = checkedAt.get(record.threadId) ?? new Map<string, number>();
      seen.set(m.id, m.updatedAt);
      checkedAt.set(record.threadId, seen);
    }
    return false;
  }
  async function unstash(threadIds: string[]) {
    return serial(async () => {
      let changed = false;
      for (const threadId of threadIds) {
        const r = read(threadId);
        if (r.mode !== "stashed") continue;
        const { stashedAt: _stashedAt, ...rest } = r;
        write({ ...rest, mode: "open", wakeAt: null, changedAt: clock(), revision: randomUUID() });
        changed = true;
      }
      if (changed) publish();
    });
  }
  async function reopenStashed(onlyThreadIds?: string[]) {
    const stashed = (
      db.prepare("SELECT value FROM nav_attention").all() as { value: string }[]
    )
      .map((r) => attentionRecord.parse(JSON.parse(r.value)))
      .filter((r) => r.mode === "stashed" && (!onlyThreadIds || onlyThreadIds.includes(r.threadId)));
    if (!stashed.length) return;
    const listed = new Map<string, Member>();
    for (let i = 0; i < stashed.length; i += 200)
      for (const t of await bb.sdk.threads.list({
        threadIds: stashed.slice(i, i + 200).map((r) => r.threadId),
        includeHidden: true,
        limit: 200,
      }))
        listed.set(t.id, t);
    const back: string[] = [];
    for (const record of stashed) {
      const own = listed.get(record.threadId);
      if (!own) continue;
      const { rows } = await logicalRows(record.threadId, own);
      const members = rows.filter((m) => !m.archivedAt && !m.deletedAt);
      if (await hasNewActivity(record, members.length ? members : [own])) back.push(record.threadId);
    }
    await unstash(back);
  }
  async function allThreads() {
    const threads = [];
    let truncated = false;
    for (let offset = 0; offset < 2000; offset += 200) {
      const page = await bb.sdk.threads.list({ limit: 200, offset });
      threads.push(...page);
      if (page.length < 200) break;
      if (offset === 1800) truncated = true;
    }
    return { threads, truncated };
  }
  type PrAnswer = z.infer<typeof prOutput>[string];
  const PR_CACHE_MS = 60_000;
  const prCache = new Map<string, { at: number; value: PrAnswer | undefined }>();
  async function pullRequestsFor(
    environmentIds: string[],
    options: { fresh?: boolean; failed?: Set<string> } = {},
  ) {
    const out = new Map<string, PrAnswer>();
    const keys = [...new Set(environmentIds)];
    const missing: string[] = [];
    for (const key of keys) {
      const hit = prCache.get(key);
      if (!options.fresh && hit && clock() - hit.at < PR_CACHE_MS) {
        if (hit.value) out.set(key, hit.value);
      } else missing.push(key);
    }
    for (let i = 0; i < missing.length; i += 200) {
      const batch = missing.slice(i, i + 200);
      try {
        const got = await bb.sdk.plugins.callRpc({
          pluginId: "bb--github-pr-status",
          method: "pullRequests",
          input: { keys: batch },
          outputSchema: prOutput,
          signal: AbortSignal.timeout(10000),
        });
        for (const key of batch) {
          prCache.set(key, { at: clock(), value: got[key] });
          if (got[key]) out.set(key, got[key]);
        }
      } catch {
        for (const key of batch) options.failed?.add(key);
      }
    }
    return out;
  }
  async function inbox(): Promise<z.infer<typeof attentionInbox>> {
    const { threads, truncated } = await allThreads();
    const rows: z.infer<typeof attentionRow>[] = [];
    const reopened: string[] = [];
    for (const t of threads.filter(
      (t) => !t.archivedAt && !t.deletedAt && t.visibility !== "hidden",
    )) {
      let r = read(t.id);
      const logical = await logicalRows(t.id, t);
      const memberRows = logical.rows.length
        ? logical.rows.filter((m) => !m.archivedAt && !m.deletedAt)
        : [t];
      if (r.mode === "stashed" && (await hasNewActivity(r, memberRows))) {
        reopened.push(t.id);
        r = { ...r, mode: "open", wakeAt: null };
      }
      const questionOwner = memberRows.find((m) => m.hasPendingInteraction);
      const interactions = questionOwner
        ? await bb.sdk.threads.interactions.list({ threadId: questionOwner.id })
        : [];
      const hasError = memberRows.some((m) => m.status === "error"),
        hasRunning = memberRows.some(
          (m) => busy.has(m.runtime.displayStatus) || Object.values(m.activity).some((n) => n > 0),
        ),
        hasWaiting = memberRows.some((m) => m.queuedWork !== "none");
      const first = interactions[0];
      const question = first
        ? (first.payload.kind === "user_question"
            ? first.payload.questions.map((q) => q.prompt).join("\n")
            : first.payload.kind === "plugin"
              ? first.payload.title
              : "A provider decision is pending. Open the thread to review it."
          ).slice(0, 1200)
        : null;
      const status = question
        ? "needs-you"
        : r.mode === "stashed" && !hasRunning
          ? "stashed"
          : hasError
          ? "failed"
          : r.mode === "settled"
            ? "accepted"
            : r.mode === "snoozed" && (r.wakeAt ?? 0) > clock()
              ? "snoozed"
              : hasRunning
                ? "running"
                : hasWaiting
                  ? "waiting"
                  : "reviewable";
      rows.push({
        threadId: t.id,
        policy: r.policy,
        title: t.title || t.titleFallback || "Untitled",
        environmentId: t.environmentId,
        hostId: t.environmentHostId,
        status,
        question,
        updatedAt: t.updatedAt,
        pinned: t.pinnedAt !== null,
        wakeAt: r.wakeAt,
      });
    }
    if (reopened.length) await unstash(reopened);
    const prs = await pullRequestsFor(
      rows.flatMap((row) => (row.environmentId ? [row.environmentId] : [])),
    );
    for (const row of rows) {
      const pr = row.environmentId ? summarisePr(prs.get(row.environmentId)) : null;
      if (pr) row.pr = pr;
    }
    return { rows, truncated };
  }
  const settings = bb.settings.define({
    stashAfterDays: {
      type: "number",
      label: "Stash chats untouched for (days)",
      description:
        "Chats you have not touched for this many days move to the Stash, to keep your sidebar clear. They are not archived: open one and carry on, and it moves back to your list as soon as you send a message. Chats in a folder stay in their folder, and running, pinned, waiting and needs-you chats are never stashed. 0 switches the Stash off.",
      default: 7,
      experimental_schema: z.number().int().min(0).max(365),
    },
    ciWake: {
      type: "boolean",
      label: "Tell a chat when its PR checks start failing",
      description:
        "When the checks on a chat's pull request change to failing, post 'CI failed' into that chat so the agent can fix it.",
      default: true,
    },
  });
  const SWEEP_EVERY_MS = 10 * 60_000;
  const SWEEP_BATCH = 25;
  const CI_EVERY_MS = 2 * 60_000;
  let lastSweep = 0;
  let lastCi = 0;
  type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
  const idleAndFree = (t: ListedThread) =>
    !t.hasPendingInteraction &&
    t.status !== "error" &&
    t.queuedWork === "none" &&
    !busy.has(t.runtime.displayStatus) &&
    !Object.values(t.activity).some((n) => n > 0);
  const openSince = (threadId: string, cutoff: number) => {
    const record = read(threadId);
    return record.mode === "open" && record.changedAt < cutoff;
  };
  type InFolder = (t: { id: string; environmentId: string | null }) => boolean;
  const noFolders: InFolder = () => false;
  let foldersDown = false;
  /**
   * A test for "this chat sits in a folder", with the same rule the sidebar uses.
   * With the folders feature (EXTRA-X) off, or project-folders not installed or switched off,
   * no chat is in a folder, which is what the sidebar shows then.
   * Null when project-folders is on but cannot answer: callers then stash nothing rather than
   * guess, and the outage is logged once, not every ten minutes.
   */
  async function inFolder(): Promise<InFolder | null> {
    if (!featureOn("EXTRA-X")) return noFolders;
    try {
      const { plugins } = await bb.sdk.plugins.list();
      const pf = plugins.find((p) => p.id === "project-folders");
      if (!pf || pf.enabled === false) return noFolders;
      const data = await bb.sdk.plugins.callRpc({
        pluginId: "project-folders",
        method: "list",
        input: null,
        outputSchema: folderList,
        signal: AbortSignal.timeout(10_000),
      });
      if (foldersDown) bb.log.info("stash: project-folders answers again");
      foldersDown = false;
      const ids = new Set(data.folders.map((f) => f.id));
      return (t) => folderOfThread(data, ids, t.id, t.environmentId) !== null;
    } catch (e) {
      if (!foldersDown)
        bb.log.warn(`stash: no chat is stashed or released by folder until project-folders answers: ${String(e)}`);
      foldersDown = true;
      return null;
    }
  }
  async function stashSweep(force = false) {
    const days = featureOn("EXTRA-A") ? Number((await settings.get()).stashAfterDays) : 0;
    if (!(days > 0)) return { stashed: [] as string[] };
    if (!force && clock() - lastSweep < SWEEP_EVERY_MS) return { stashed: [] as string[] };
    lastSweep = clock();
    const cutoff = clock() - days * 86400_000;
    const { threads } = await allThreads();
    const idle = threads.filter(
      (t) =>
        !t.archivedAt &&
        !t.deletedAt &&
        t.visibility !== "hidden" &&
        !t.parentThreadId &&
        t.pinnedAt === null &&
        t.updatedAt < cutoff &&
        idleAndFree(t) &&
        openSince(t.id, cutoff),
    );
    if (!idle.length) return { stashed: [] as string[] };
    // The Stash only tidies loose chats: a chat in a folder stays in its folder.
    // If project-folders cannot answer, nothing is stashed this round.
    const filed = await inFolder();
    if (!filed) return { stashed: [] as string[] };
    const due = idle
      .filter((t) => !filed(t))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, SWEEP_BATCH);
    if (!due.length) return { stashed: [] as string[] };
    const done = await apply({ threadIds: due.map((t) => t.id), action: "stash" });
    return { stashed: done.results.filter((x) => x.ok).map((x) => x.threadId) };
  }
  const RELEASE_KEY = "stash:folders-released:v1";
  const RELEASE_CUTOFF_KEY = "stash:folders-release-cutoff:v1";
  let releaseDone = false;
  let lastRelease = 0;
  /**
   * Once, when the folder rule arrives: chats stashed before its first attempt that sit in a folder go back to it.
   * If project-folders cannot answer, it tries again ten minutes later. A chat stashed by hand after the first
   * attempt stays stashed, even while the release is still waiting for project-folders.
   */
  async function releaseFiled(force = false) {
    const none = { released: [] as string[] };
    if (releaseDone || (!force && clock() - lastRelease < SWEEP_EVERY_MS)) return none;
    lastRelease = clock();
    if (await bb.storage.kv.get<boolean>(RELEASE_KEY)) {
      releaseDone = true;
      return none;
    }
    let cutoff = await bb.storage.kv.get<number>(RELEASE_CUTOFF_KEY);
    if (typeof cutoff !== "number") {
      cutoff = clock();
      await bb.storage.kv.set(RELEASE_CUTOFF_KEY, cutoff);
    }
    const firstTry = cutoff;
    const stashed = (db.prepare("SELECT value FROM nav_attention").all() as { value: string }[])
      .map((r) => attentionRecord.parse(JSON.parse(r.value)))
      .filter((r) => r.mode === "stashed" && (r.stashedAt ?? r.changedAt) <= firstTry)
      .map((r) => r.threadId);
    let released: string[] = [];
    if (stashed.length) {
      const filed = await inFolder();
      if (!filed) return none;
      const listed: ListedThread[] = [];
      for (let i = 0; i < stashed.length; i += 200)
        listed.push(
          ...(await bb.sdk.threads.list({
            threadIds: stashed.slice(i, i + 200),
            includeHidden: true,
            limit: 200,
          })),
        );
      released = listed.filter((t) => filed(t)).map((t) => t.id);
      await unstash(released);
    }
    await bb.storage.kv.set(RELEASE_KEY, true);
    releaseDone = true;
    if (released.length) bb.log.info(`stash: ${released.length} chats went back to their folders`);
    return { released };
  }
  async function ciCheck(force = false) {
    const none = { notified: [] as string[] };
    // F69 in the feature picker, and the setting under it.
    if (!featureOn("F69") || !(await settings.get()).ciWake) return none;
    if (!force && clock() - lastCi < CI_EVERY_MS) return none;
    lastCi = clock();
    const { threads } = await allThreads();
    const newest = new Map<string, ListedThread>();
    for (const t of threads) {
      if (
        t.archivedAt ||
        t.deletedAt ||
        t.visibility === "hidden" ||
        t.parentThreadId ||
        !t.environmentId ||
        t.updatedAt < clock() - 14 * 86400_000
      )
        continue;
      const have = newest.get(t.environmentId);
      if (!have || t.updatedAt > have.updatedAt) newest.set(t.environmentId, t);
    }
    if (!newest.size) return none;
    const failed = new Set<string>();
    const prs = await pullRequestsFor([...newest.keys()], { fresh: true, failed });
    if (!prs.size) return none;
    const known = await bb.storage.kv.get<Record<string, { failing: boolean }>>("ci-watch:v1");
    const next: Record<string, { failing: boolean }> = {};
    const notified: string[] = [];
    for (const [environmentId, thread] of newest) {
      if (failed.has(environmentId) && known?.[environmentId]) {
        next[environmentId] = known[environmentId];
        continue;
      }
      const pr = summarisePr(prs.get(environmentId));
      if (!pr || (pr.state !== "open" && pr.state !== "draft")) continue;
      const failing = pr.checks === "failing";
      const was = known?.[environmentId]?.failing === true;
      next[environmentId] = { failing };
      if (!failing || was || known === undefined) continue;
      const mode = read(thread.id).mode;
      if (mode === "settled" || mode === "stashed") continue;
      const what =
        pr.failedCount > 0
          ? `${pr.failedCount} check${pr.failedCount === 1 ? "" : "s"} failing`
          : "checks failing";
      try {
        await bb.sdk.threads.send({
          threadId: thread.id,
          mode: "auto",
          input: [
            {
              type: "text",
              text: `CI failed: ${what} on PR #${pr.number} (${pr.url}). Open the failing checks, fix them and push.`,
              mentions: [],
            },
          ],
        } as never);
        notified.push(thread.id);
      } catch {
        next[environmentId] = { failing: false };
      }
    }
    await bb.storage.kv.set("ci-watch:v1", next);
    if (notified.length) publish();
    return { notified };
  }
  async function tick() {
    await reopenStashed().catch((e) => bb.log.warn(`stash reopen: ${String(e)}`));
    await releaseFiled().catch((e) => bb.log.warn(`stash folder release: ${String(e)}`));
    await stashSweep().catch((e) => bb.log.warn(`stash sweep: ${String(e)}`));
    const { records } = await state();
    for (const r of records) {
      if (r.mode === "snoozed" && (r.wakeAt ?? Infinity) <= clock()) {
        await wake(r.threadId, { revision: r.revision, wakeAt: r.wakeAt });
        continue;
      }
      if (r.mode !== "open" || r.policy.acceptancePending) continue;
      const t = await protectedWork(r.threadId).catch(() => null);
      if (!t || t.status !== "idle" || t.pinnedAt !== null) continue;
      let settle =
        r.policy.inactiveAfterMs !== null && clock() - t.updatedAt >= r.policy.inactiveAfterMs;
      if (r.policy.autoMerge) {
        settle = false;
        if (!t.environmentId || !r.policy.requiredPrUrls.length) continue;
        // Refresh the genuine linked branch PR before evaluating; no inferred merge event.
        try {
          const links = r.policy.requiredPrUrls.map((url) => ({
            url,
            environmentId:
              r.policy.requiredPrEnvironments[url] ??
              (r.policy.requiredPrUrls.length === 1 ? t.environmentId! : null),
          }));
          if (links.some((link) => !link.environmentId)) continue;
          const keys = [...new Set(links.map((link) => link.environmentId!))];
          for (const environmentId of keys)
            await bb.sdk.plugins.callRpc({
              pluginId: "bb--github-pr-status",
              method: "refresh",
              input: { environmentId },
              outputSchema: z.object({ ok: z.literal(true) }),
              signal: AbortSignal.timeout(10000),
            });
          const prs = await bb.sdk.plugins.callRpc({
            pluginId: "bb--github-pr-status",
            method: "pullRequests",
            input: { keys },
            outputSchema: prOutput,
          });
          settle = links.every((link) => {
            const p = prs[link.environmentId!];
            return (
              p?.outcome === "available" &&
              p.pullRequest.state === "merged" &&
              p.pullRequest.url === link.url
            );
          });
        } catch {
          /* unavailable is not merged */
        }
      }
      if (settle) await apply({ threadIds: [r.threadId], action: "settle" }, r.revision);
    }
  }
  bb.events.on("interaction.pending", ({ thread }) => wake(thread.id));
  bb.events.on("thread.failed", ({ thread }) => wake(thread.id));
  bb.events.on("thread.active", ({ thread }) => wake(thread.id));
  bb.events.on("thread.idle", ({ thread }) => {
    void conversation(thread.id)
      .then((c) => reopenStashed([c.rootThreadId]))
      .catch((e) => bb.log.warn(`stash reopen: ${String(e)}`))
      .finally(publish);
  });
  bb.background.schedule("attention-clock", "* * * * *", tick);
  bb.background.schedule("attention-ci", "* * * * *", async () => {
    await ciCheck().catch((e) => bb.log.warn(`ci check: ${String(e)}`));
  });
  return {
    state,
    inbox,
    apply,
    undo,
    tick,
    wake,
    reopenStashed,
    stashSweep,
    releaseFiled,
    ciCheck,
    async configure(threadId: string, raw: z.infer<typeof attentionPolicy>) {
      const policy = attentionPolicy.parse(raw);
      if (policy.autoMerge && !policy.requiredPrUrls.length)
        throw new Error("Automatic merge settlement requires explicit required PR URLs.");
      if (
        policy.autoMerge &&
        policy.requiredPrUrls.length > 1 &&
        policy.requiredPrUrls.some((url) => !policy.requiredPrEnvironments[url])
      )
        throw new Error("Each required PR needs its verified environment ID.");
      await serial(async () => {
        write({ ...read(threadId), policy, changedAt: clock(), revision: randomUUID() });
        publish();
      });
      return state();
    },
    async fold(value: boolean) {
      await bb.storage.kv.set("attention:fold", value);
      publish();
      return state();
    },
  };
}

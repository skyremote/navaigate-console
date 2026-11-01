// Helper Desk — server side. Folds a thread's bb events into sub-agent cards,
// tails each Claude Code sub-agent transcript for live tokens and steps,
// estimates the chat's API-equivalent cost, and serves a per-thread history of
// past agent batches (parsed state cached in plugin storage by thread + last seq).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { isActive, pickRailThreads, railOverviewSchema, recentBatches, type RailOverview } from "./railmodel";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { teamSchema } from "./team";
import { loadProfile } from "./profile/load";
import { picksOff } from "./lib/picks";
import { createTeam } from "./teamserver";
import {
  agentProgress,
  buildBatches,
  clip,
  effectiveState,
  emptyState,
  emptyTranscript,
  feedTranscript,
  orchestratorState,
  historySchema,
  reduceEvents,
  restoreState,
  serialiseState,
  snapshotSchema,
  summariseBatch,
  type AgentRecord,
  type CachedThread,
  type DeskAgent,
  type DeskHistory,
  type DeskSnapshot,
  type RawEvent,
  type ThreadState,
  type TranscriptState,
} from "./model";
import {
  assembleConversation,
  followedThread,
  modelAt,
  modelSwitches,
  parseNativeClaim,
  SKIN_PLUGIN_ID,
  type Conversation,
  type NativeClaim,
} from "./conversation";

const threadIdSchema = z.string().regex(/^thr_[a-zA-Z0-9_-]+$/);

export const rpcContract = defineRpcContract({
  snapshot: { input: z.object({ threadId: threadIdSchema }), output: snapshotSchema },
  history: { input: z.object({ threadId: threadIdSchema }), output: historySchema },
  overview: { input: z.null(), output: railOverviewSchema },
  team: { input: z.object({ threadId: threadIdSchema }), output: teamSchema },
  // The Helper Desk features switched off in the Console's setup picker; carries nothing else of the profile.
  picks: { input: z.null(), output: z.object({ picksOff: z.array(z.string()) }) },
});

const EVENT_TYPES = [
  "client/turn/requested",
  "item/started",
  "item/completed",
  "item/delegation/completed",
  "item/backgroundTask/completed",
  "item/backgroundTask/progress", // Workflow runs report their agents here
] as const;

const MAX_READ_PER_CALL = 32 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

interface Tail extends TranscriptState {
  mtimeMs: number;
}

/** Read only the new bytes of a growing JSONL file into a transcript state. */
async function tail(path: string, state: Tail): Promise<Tail> {
  let handle;
  try {
    const info = await stat(path);
    state.mtimeMs = info.mtimeMs;
    if (info.size < state.offset) Object.assign(state, emptyTranscript()); // rewritten
    if (info.size === state.offset) return state;
    handle = await open(path, "r");
    let budget = MAX_READ_PER_CALL;
    while (state.offset < info.size && budget > 0) {
      const length = Math.min(CHUNK, info.size - state.offset, budget);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      if (bytesRead <= 0) break;
      feedTranscript(state, buffer.subarray(0, bytesRead).toString("utf8"), bytesRead);
      budget -= bytesRead;
    }
  } catch {
    // Missing or unreadable transcript: keep what we have.
  } finally {
    await handle?.close();
  }
  return state;
}

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    autoHide: {
      type: "boolean",
      label: "Auto-hide finished agents",
      description: "When every agent in a batch has finished, keep the cards for a few seconds, then clear the live view and the taskbar. Past batches stay in History.",
      default: true,
    },
    hideDelaySeconds: {
      type: "number",
      label: "Seconds to keep finished agents on screen",
      description: "How long finished cards stay visible with their final numbers before they slide away.",
      default: 8,
    },
    companion: {
      type: "boolean",
      label: "Show the coach companion",
      description: "The coach floats along the right edge of bb and reacts to the chat in view: thinking while it works, a badge when it needs you, a wink when it finishes. Hidden on phone-sized screens.",
      default: true,
    },
  });

  const threads = new Map<string, { state: ThreadState; providerSessionId: string | null; viewedAt: number; savedSeq: number; loaded: boolean }>();
  const transcripts = new Map<string, Tail>();
  const sessionFiles = new Map<string, string | null>();
  const syncing = new Map<string, Promise<unknown>>();

  async function findSessionFile(sessionId: string): Promise<string | null> {
    if (sessionFiles.has(sessionId)) return sessionFiles.get(sessionId) ?? null;
    const root = join(homedir(), ".claude", "projects");
    let found: string | null = null;
    try {
      for (const dir of await readdir(root)) {
        const candidate = join(root, dir, `${sessionId}.jsonl`);
        try {
          await stat(candidate);
          found = candidate;
          break;
        } catch { /* not here */ }
      }
    } catch { /* no projects dir */ }
    sessionFiles.set(sessionId, found);
    return found;
  }

  async function transcript(path: string): Promise<Tail> {
    let t = transcripts.get(path);
    if (!t) {
      t = { ...emptyTranscript(), mtimeMs: 0 };
      transcripts.set(path, t);
    }
    return tail(path, t);
  }

  /**
   * Every transcript that belongs to one Claude Code session: the main file, plus each sub-agent and
   * Workflow agent under <session>/subagents/ in any project folder (a mid-session cwd change can
   * split them). The listing is cached briefly; each file is still tailed incrementally.
   */
  const sessionListings = new Map<string, { at: number; files: string[] }>();
  async function sessionTranscripts(sessionId: string): Promise<string[]> {
    const hit = sessionListings.get(sessionId);
    if (hit && Date.now() - hit.at < 5_000) return hit.files;
    const files: string[] = [];
    const root = join(homedir(), ".claude", "projects");
    try {
      for (const dir of await readdir(root)) {
        const sub = join(root, dir, sessionId, "subagents");
        try {
          for (const rel of await readdir(sub, { recursive: true })) {
            if (String(rel).endsWith(".jsonl")) files.push(join(sub, String(rel)));
          }
        } catch { /* no sub-agents here */ }
      }
    } catch { /* no projects dir */ }
    sessionListings.set(sessionId, { at: Date.now(), files });
    return files;
  }

  /** API-equivalent cost of a whole session, split into the lead, sub-agents, Workflow agents and advisor calls. */
  async function sessionCost(sessionId: string, mainFile: string) {
    const out = { lead: 0, subagents: 0, workflows: 0, advisor: 0, total: 0 };
    const main = await transcript(mainFile);
    out.lead = main.costUsd - main.advisorUsd;
    out.advisor += main.advisorUsd;
    for (const file of await sessionTranscripts(sessionId)) {
      const t = await transcript(file);
      const own = t.costUsd - t.advisorUsd;
      if (file.includes("/subagents/workflows/")) out.workflows += own;
      else out.subagents += own;
      out.advisor += t.advisorUsd;
    }
    out.total = out.lead + out.subagents + out.workflows + out.advisor;
    return out;
  }

  // v5: Workflow runs and resumed agents are now parsed. v6: each turn's model is kept for model-switch
  // markers. Caches built before that are re-read from the event log.
  const cacheKey = (threadId: string) => `history:v6:${threadId}`;

  async function sync(threadId: string) {
    // One sync per thread at a time; concurrent callers share it.
    const pending = syncing.get(threadId);
    if (pending) await pending.catch(() => undefined);
    const run = doSync(threadId);
    syncing.set(threadId, run);
    try {
      return await run;
    } finally {
      if (syncing.get(threadId) === run) syncing.delete(threadId);
    }
  }

  async function doSync(threadId: string) {
    let entry = threads.get(threadId);
    if (!entry) {
      entry = { state: emptyState(), providerSessionId: null, viewedAt: Date.now(), savedSeq: 0, loaded: false };
      threads.set(threadId, entry);
    }
    if (!entry.loaded) {
      entry.loaded = true;
      try {
        const cached = restoreState(await bb.storage.kv.get<CachedThread>(cacheKey(threadId)));
        if (cached) {
          entry.state = cached;
          entry.savedSeq = cached.afterSeq;
        }
      } catch (e) {
        bb.log.warn(`history cache read failed for ${threadId}: ${String(e)}`);
      }
    }
    entry.viewedAt = Date.now();
    // bb caps a page at 100 events. Long threads catch up over a few calls.
    for (let page = 0; page < 250; page++) {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(entry.state.afterSeq),
        limit: "100",
        order: "asc",
        types: EVENT_TYPES as unknown as Parameters<typeof bb.sdk.threads.events.list>[0]["types"],
      });
      if (rows.length === 0) break;
      const events: RawEvent[] = rows.map((r) => ({
        seq: r.seq,
        type: r.type,
        createdAt: r.createdAt,
        data: (r.data ?? {}) as Record<string, unknown>,
      }));
      for (const e of events) {
        const sid = e.data.providerThreadId;
        if (typeof sid === "string" && sid) entry.providerSessionId = sid;
      }
      reduceEvents(entry.state, events);
      if (rows.length < 100) break;
    }
    return entry;
  }

  async function saveCache(threadId: string) {
    const entry = threads.get(threadId);
    if (!entry || entry.state.afterSeq === entry.savedSeq) return;
    try {
      let payload = serialiseState(entry.state);
      if (JSON.stringify(payload).length > 240_000) payload = { ...payload, agents: payload.agents.slice(-120).map((a) => ({ ...a, summary: clip(a.summary, 400) })) };
      await bb.storage.kv.set(cacheKey(threadId), payload);
      entry.savedSeq = entry.state.afterSeq;
    } catch (e) {
      bb.log.warn(`history cache write failed for ${threadId}: ${String(e)}`);
    }
  }

  /** Per-agent live numbers from its transcript, remembered on the record once it has finished. */
  async function agentLive(rec: AgentRecord) {
    if (rec.derived && rec.state !== "running") {
      return { ...rec.derived, costUsd: rec.derived.costUsd, lastLifeAt: rec.finishedAt ?? rec.lastActivityAt, fromTranscript: true };
    }
    const t = rec.outputFile ? await transcript(rec.outputFile) : null;
    const read = !!t && t.offset > 0;
    if (read && rec.state !== "running") {
      rec.derived = { tokens: t!.tokens, model: t!.model, steps: t!.steps, costUsd: t!.costUsd, recent: t!.recent.slice() };
    }
    return {
      tokens: t?.tokens ?? 0,
      model: t?.model || rec.model,
      steps: t?.steps ?? 0,
      costUsd: read ? t!.costUsd : null,
      recent: t?.recent ?? [],
      lastLifeAt: t?.mtimeMs ?? 0,
      fromTranscript: read,
    };
  }

  // ---------- Logical conversations across native model continuations ----------
  // Read-only: the NavAIgate Workspace plugin's `nativeConversation` thread metadata (see conversation.ts).
  const CONVERSATION_TTL_MS = 20_000;
  const projectClaims = new Map<string, { at: number; run: Promise<Map<string, { createdAt: number; status: string; claim: NativeClaim }>> }>();
  const conversations = new Map<string, { at: number; run: Promise<Conversation | null> }>();
  /** Member thread -> the thread ids whose panels show it, so a member's events refresh the root's panel. */
  const viewers = new Map<string, Set<string>>();

  /** Hidden top-level threads in a project that carry a skin claim. Members are always hidden while grouped. */
  function claimsIn(projectId: string) {
    const hit = projectClaims.get(projectId);
    if (hit && Date.now() - hit.at < CONVERSATION_TTL_MS) return hit.run;
    const run = (async () => {
      const out = new Map<string, { createdAt: number; status: string; claim: NativeClaim }>();
      const hidden: { id: string; createdAt: number; status: string }[] = [];
      for (let page = 0; page < 10; page++) {
        const rows = await bb.sdk.threads.list({ projectId, includeHidden: true, hasParent: false, limit: 200, offset: page * 200 });
        for (const r of rows) if (r.visibility === "hidden") hidden.push({ id: r.id, createdAt: r.createdAt, status: r.status });
        if (rows.length < 200) break;
      }
      for (let i = 0; i < hidden.length; i += 100) {
        const chunk = hidden.slice(i, i + 100);
        const { threads: meta } = await bb.sdk.threads.experimental_listPluginMetadata({ pluginId: SKIN_PLUGIN_ID, threadIds: chunk.map((t) => t.id) });
        const byId = new Map(chunk.map((t) => [t.id, t]));
        for (const m of meta) {
          const claim = parseNativeClaim(m.metadata);
          const t = byId.get(m.threadId);
          if (claim && t) out.set(t.id, { createdAt: t.createdAt, status: t.status, claim });
        }
      }
      return out;
    })();
    projectClaims.set(projectId, { at: Date.now(), run });
    run.catch(() => projectClaims.delete(projectId));
    return run;
  }

  async function resolveConversation(threadId: string): Promise<Conversation | null> {
    let own: NativeClaim | null = null;
    try {
      own = parseNativeClaim(await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: SKIN_PLUGIN_ID }));
    } catch { /* no skin, or the thread is gone */ }
    const rootId = own?.rootThreadId ?? threadId;
    let root;
    try {
      root = await bb.sdk.threads.get({ threadId: rootId });
    } catch {
      return null;
    }
    if (root.deletedAt !== null) return null;
    const claims = await claimsIn(root.projectId);
    const candidates = [...claims.entries()].map(([id, c]) => ({ id, ...c }));
    return assembleConversation({ id: root.id, createdAt: root.createdAt, status: root.status }, candidates);
  }

  /** The logical conversation a thread belongs to, or null for an ordinary chat. Never throws. */
  function conversationFor(threadId: string): Promise<Conversation | null> {
    const hit = conversations.get(threadId);
    if (hit && Date.now() - hit.at < CONVERSATION_TTL_MS) return hit.run;
    const run = resolveConversation(threadId).catch((e) => {
      bb.log.warn(`conversation lookup failed for ${threadId}: ${String(e)}`);
      return null;
    });
    conversations.set(threadId, { at: Date.now(), run });
    void run.then((c) => {
      for (const m of c?.members ?? []) {
        if (m.threadId === threadId) continue;
        const set = viewers.get(m.threadId) ?? new Set<string>();
        set.add(threadId);
        viewers.set(m.threadId, set);
      }
    });
    return run;
  }

  /** The lead's model label for a thread: its transcript, else the model its latest turn asked for, else the provider. */
  async function leadModelOf(threadId: string, entry: Awaited<ReturnType<typeof sync>>): Promise<string> {
    if (entry.providerSessionId) {
      const file = await findSessionFile(entry.providerSessionId);
      if (file) {
        const model = (await transcript(file)).model;
        if (model) return modelLabel(model);
      }
    }
    const turn = entry.state.turns.at(-1)?.model;
    if (turn) return modelLabel(turn);
    try {
      return providerLabel((await bb.sdk.threads.get({ threadId })).providerId ?? "");
    } catch {
      return providerLabel("");
    }
  }

  async function switchesFor(conversation: Conversation) {
    const members = [];
    for (const m of conversation.members) members.push({ threadId: m.threadId, kind: m.kind, turns: (await sync(m.threadId)).state.turns });
    return modelSwitches(members, modelLabel);
  }

  async function snapshot(threadId: string): Promise<DeskSnapshot> {
    const conversation = await conversationFor(threadId);
    const followed = followedThread(threadId, conversation);
    const snap = await threadSnapshot(followed);
    if (!conversation) return snap;
    const switches = await switchesFor(conversation);
    return {
      ...snap,
      threadId,
      conversation: { rootThreadId: conversation.rootThreadId, followedThreadId: followed, members: conversation.members.length, switches: switches.slice(-20) },
    };
  }

  async function threadSnapshot(threadId: string): Promise<DeskSnapshot> {
    const entry = await sync(threadId);
    const batches = buildBatches(entry.state);
    const now = Date.now();
    // The newest batch, plus anything from an earlier request that is still running (a Workflow
    // or background agent launched two messages ago is still live work) and that run's agents.
    const carried = new Set<string>();
    for (const a of batches.slice(1).flatMap((b) => b.agents)) {
      if (a.state !== "running") continue;
      const life = a.outputFile ? (await agentLive(a)).lastLifeAt : 0; // a quiet background agent is alive while its transcript grows
      if (effectiveState(a, now, life) === "running") carried.add(a.id);
    }
    const older = batches.slice(1).flatMap((b) => b.agents).filter((a) => carried.has(a.id) || (a.parentId !== null && carried.has(a.parentId)));
    const group = [...older, ...(batches[0]?.agents ?? [])].sort((x, y) => x.order - y.order).slice(-40); // the snapshot schema caps agents at 40

    const agents: DeskAgent[] = [];
    let subagentCost = 0;
    for (const [index, rec] of group.entries()) {
      const live = await agentLive(rec);
      subagentCost += live.costUsd ?? 0;
      const state = effectiveState(rec, now, live.lastLifeAt);
      const tokens = rec.finalUsage?.totalTokens ?? live.tokens;
      const steps = Math.max(rec.finalUsage?.toolUses ?? 0, live.steps, rec.childSteps);
      const recent = live.recent.length ? live.recent : rec.childRecent;
      const latest = recent.at(-1);
      const finishedAt = rec.finishedAt ?? (state === "running" ? null : Math.max(rec.lastActivityAt, live.lastLifeAt));
      const stepLabel =
        state === "running"
          ? latest
            ? `Step ${Math.max(1, steps)} · ${latest}`
            : "Getting started"
          : state === "failed"
            ? "Failed"
            : state === "interrupted"
              ? "Interrupted"
              : `Done · ${steps} steps`;
      const details = state === "running" ? recent.slice(-3, -1).reverse() : recent.slice(-2).reverse();
      agents.push({
        id: rec.id,
        name: clip(rec.name, 80),
        agentType: rec.agentType,
        model: modelLabel(live.model),
        state,
        background: rec.background,
        startedAt: rec.startedAt,
        finishedAt,
        tokens,
        steps,
        stepLabel: clip(stepLabel, 90),
        details: details.map((d) => clip(d, 80)).slice(0, 2),
        progress: agentProgress(state, steps),
        colour: index,
        summary: clip(rec.summary, 400),
        parentId: rec.parentId,
      });
    }

    // To-do list and context usage.
    let todos: DeskSnapshot["todos"] = [];
    let todosUpdatedAt: number | null = null;
    let cost: DeskSnapshot["cost"] = null;
    try {
      const status = await bb.sdk.status.get({ threadId });
      todos = (status.pendingTodos?.items ?? []).slice(0, 60).map((t) => ({ id: t.id, text: clip(t.text, 200), status: t.status }));
      todosUpdatedAt = status.pendingTodos?.updatedAt ?? null;
    } catch { /* thread gone */ }
    let contextUsed: number | null = null;
    let contextWindow: number | null = null;
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId, segmentLimit: "1", summaryOnly: "true", deferContent: "true" });
      const usage = timeline.contextWindowUsage;
      const c = usage?.cost;
      if (c) cost = { amount: c.amount, currency: c.currency, estimated: false };
      if (usage) {
        contextUsed = usage.usedTokens ?? null;
        contextWindow = usage.modelContextWindow ?? null;
      }
    } catch { /* ignore */ }
    let mainCost = 0;
    let mainModel = entry.state.turns.at(-1)?.model ?? "";
    let costBreakdown: DeskSnapshot["costBreakdown"] = null;
    let session: Awaited<ReturnType<typeof sessionCost>> | null = null;
    if (entry.providerSessionId) {
      const file = await findSessionFile(entry.providerSessionId);
      if (file) {
        session = await sessionCost(entry.providerSessionId, file);
        const t = await transcript(file);
        mainCost = t.costUsd; // the lead's own replies plus its advisor calls
        mainModel = t.model || mainModel;
      }
    }
    if (!cost) {
      if (session && session.total > 0) {
        // Whole session from disk: lead, every sub-agent, every Workflow agent and every advisor call.
        cost = { amount: session.total, currency: "USD", estimated: true };
        costBreakdown = { lead: session.lead, subagents: session.subagents, workflows: session.workflows, advisor: session.advisor };
      } else {
        for (const rec of entry.state.agents.values()) {
          if (group.includes(rec)) continue;
          subagentCost += rec.derived?.costUsd ?? (rec.outputFile ? transcripts.get(rec.outputFile)?.costUsd ?? 0 : 0);
        }
        if (mainCost + subagentCost > 0) cost = { amount: mainCost + subagentCost, currency: "USD", estimated: true };
      }
    }

    const startedAt = agents.length ? Math.min(...agents.map((a) => a.startedAt)) : null;
    const running = agents.some((a) => a.state === "running");
    const endedAt = !running && agents.length ? Math.max(...agents.map((a) => a.finishedAt ?? a.startedAt)) : null;
    const request = batches[0]?.request || entry.state.lastUserText;
    void saveCache(threadId);

    // The orchestrator: this thread's own agent.
    let threadStatus = "idle";
    let providerId = "";
    let pendingInteractions = 0;
    try {
      const t = await bb.sdk.threads.get({ threadId });
      threadStatus = t.status;
      providerId = t.providerId ?? "";
    } catch { /* thread gone */ }
    try {
      pendingInteractions = (await bb.sdk.threads.interactions.list({ threadId })).length;
    } catch { /* none */ }
    const leadState = orchestratorState({ threadStatus, pendingInteractions, lead: entry.state.lead });
    const lead = {
      label: "Lead",
      model: mainModel ? modelLabel(mainModel) : providerLabel(providerId),
      state: leadState.state,
      activity: clip(leadState.activity, 90),
      contextUsed,
      contextPct: contextUsed !== null && contextWindow ? Math.round((contextUsed / contextWindow) * 100) : null,
      // The lead card shows the lead's own replies, matching "Lead" in the panel split. Advisor calls are listed there separately.
      costUsd: session && session.lead > 0 ? session.lead : mainCost > 0 ? mainCost : cost && !cost.estimated ? cost.amount : null,
      costEstimated: session && session.lead > 0 ? true : mainCost > 0 ? true : cost ? cost.estimated : true,
    };

    return {
      threadId,
      title: clip(request || "Current work", 120),
      turnKey: `${threadId}:${batches[0]?.seq ?? 0}`,
      agents,
      todos,
      cost,
      costBreakdown,
      subagentTokens: agents.reduce((sum, a) => sum + a.tokens, 0), // a Workflow run card carries 0 tokens; its agents carry them
      startedAt,
      endedAt,
      running,
      todosUpdatedAt,
      lead,
      updatedAt: now,
    };
  }

  async function threadBatches(threadId: string, now: number) {
    const entry = await sync(threadId);
    const batches = buildBatches(entry.state).slice(0, 200);
    const out = [];
    for (const batch of batches) {
      const lives = new Map<string, Awaited<ReturnType<typeof agentLive>>>();
      for (const rec of batch.agents.slice(0, 60)) lives.set(rec.id, await agentLive(rec));
      const turnModel = modelAt(entry.state.turns, batch.seq);
      out.push({
        ...summariseBatch(batch, now, (rec) => {
          const l = lives.get(rec.id)!;
          return { tokens: l.tokens, model: modelLabel(l.model), steps: l.steps, costUsd: l.costUsd, lastLifeAt: l.lastLifeAt };
        }),
        ...(turnModel ? { model: modelLabel(turnModel) } : {}),
      });
    }
    // Derived numbers may have been filled in: force a cache write.
    const e = threads.get(threadId);
    if (e) e.savedSeq = -1;
    void saveCache(threadId);
    return { entry, batches: out };
  }

  async function history(threadId: string): Promise<DeskHistory> {
    const now = Date.now();
    const conversation = await conversationFor(threadId);
    if (!conversation) {
      const { entry, batches } = await threadBatches(threadId, now);
      return { threadId, lead: { label: "Lead", model: await leadModelOf(threadId, entry) }, batches, switches: modelSwitches([{ threadId, kind: "root", turns: entry.state.turns }], modelLabel), members: 1, updatedAt: now };
    }
    // The whole logical conversation: every session's batches, each tagged with its session and model.
    const merged = [];
    for (const m of conversation.members) {
      const { batches } = await threadBatches(m.threadId, now);
      for (const b of batches) merged.push({ ...b, key: `${m.threadId}:${b.key}`, threadId: m.threadId });
    }
    merged.sort((a, b) => b.startedAt - a.startedAt);
    const followed = followedThread(threadId, conversation);
    const switches = await switchesFor(conversation);
    return {
      threadId,
      lead: { label: "Lead", model: await leadModelOf(followed, await sync(followed)) },
      batches: merged.slice(0, 200),
      switches: switches.slice(-200),
      members: conversation.members.length,
      updatedAt: now,
    };
  }

  /**
   * Left-rail Agents page: threads with agents running now, then the last day's finished runs.
   * Each picked thread also resolves its logical conversation (one metadata read and one thread
   * read; the project's member list is shared and cached), so this stays light at rail sizes.
   */
  async function overview(): Promise<RailOverview> {
    const now = Date.now();
    const list = await bb.sdk.threads.list({ archived: false, limit: 200 });
    const picked = pickRailThreads(list, now);
    const read = await Promise.all(
      picked.map(async (t) => {
        try {
          const [snap, hist] = await Promise.all([snapshot(t.id), history(t.id)]);
          return { threadId: t.id, title: t.title || "Untitled chat", snap, batches: hist.batches, model: hist.lead.model };
        } catch (e) {
          bb.log.warn(`overview skipped ${t.id}: ${String(e)}`);
          return null;
        }
      }),
    );
    const ok = read.filter((r): r is NonNullable<typeof r> => r !== null);
    const active = ok.filter((r) => isActive(r.snap)).map((r) => ({ threadId: r.threadId, title: r.title, snapshot: r.snap }));
    const recent = recentBatches(ok, now).map(({ entry, batch }) => ({ threadId: entry.threadId, title: entry.title, model: entry.model, batch }));
    return { active, recent, scanned: picked.length, updatedAt: now };
  }

  // The chat's team: every agent across the conversation's sessions and the worktree each works in (teamserver.ts).
  const crew = createTeam(bb, {
    sync,
    conversationFor,
    followedThread,
    leadModel: async (id) => leadModelOf(id, await sync(id)),
    modelLabel,
  });

  bb.rpc.register(rpcContract, {
    snapshot: ({ threadId }) => snapshot(threadId),
    history: ({ threadId }) => history(threadId),
    overview: () => overview(),
    team: ({ threadId }) => crew.team(threadId),
    // Read afresh (the loader caches by modification time), so a tick saved in Setup applies without a reload.
    picks: () => ({ picksOff: picksOff(loadProfile().profile) }),
  });

  // Tell open panels to refetch when a watched thread moves. Signals carry no content.
  const lastPublish = new Map<string, number>();
  // A brand-new native continuation is not watched yet. Check its skin claim once, and if the
  // conversation's root is open, drop the cached grouping and refresh the root's panel at once.
  const probed = new Map<string, number>();
  async function probeNewMember(thread: { id: string; projectId: string; visibility?: string; parentThreadId: string | null }) {
    if (thread.visibility !== "hidden" || thread.parentThreadId !== null) return;
    const now = Date.now();
    if (now - (probed.get(thread.id) ?? 0) < 10_000) return;
    if (probed.size > 500) probed.clear();
    probed.set(thread.id, now);
    let claim: NativeClaim | null = null;
    try {
      claim = parseNativeClaim(await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, pluginId: SKIN_PLUGIN_ID }));
    } catch { return; }
    if (!claim) return;
    const root = threads.get(claim.rootThreadId);
    if (!root || now - root.viewedAt > 15 * 60_000) return;
    conversations.clear();
    projectClaims.delete(thread.projectId);
    const set = viewers.get(thread.id) ?? new Set<string>();
    set.add(claim.rootThreadId);
    viewers.set(thread.id, set);
    bb.realtime.publish("desk-changed", { threadId: claim.rootThreadId });
  }

  bb.events.on("experimental_thread.events", async ({ thread }) => {
    const entry = threads.get(thread.id);
    if (!entry) return probeNewMember(thread);
    if (Date.now() - entry.viewedAt > 15 * 60_000) return;
    const last = lastPublish.get(thread.id) ?? 0;
    if (Date.now() - last < 1000) return;
    lastPublish.set(thread.id, Date.now());
    bb.realtime.publish("desk-changed", { threadId: thread.id });
    // A native continuation's events also refresh the panel open on its conversation's root.
    for (const viewer of viewers.get(thread.id) ?? []) bb.realtime.publish("desk-changed", { threadId: viewer });
  });

  bb.cli.register({
    name: "helper-desk",
    summary: "Show a thread's sub-agents, tokens, to-do progress and agent history",
    commands: [
      { name: "show", summary: "Print the live Helper Desk snapshot for a thread", usage: "bb helper-desk show <thread-id>" },
      { name: "history", summary: "Print past agent batches for a thread, newest first", usage: "bb helper-desk history <thread-id>" },
      { name: "team", summary: "Print every agent working for a thread and the git worktree each works in", usage: "bb helper-desk team <thread-id>" },
    ],
    async run(args) {
      const usage = "Usage: bb helper-desk show|history|team <thread-id>";
      if ((args[0] !== "show" && args[0] !== "history" && args[0] !== "team") || !args[1]) return { exitCode: 1, stderr: usage };
      const threadId = threadIdSchema.safeParse(args[1]);
      if (!threadId.success) return { exitCode: 1, stderr: "Thread ids look like thr_abc123." };
      const out = args[0] === "show" ? await snapshot(threadId.data) : args[0] === "history" ? await history(threadId.data) : await crew.team(threadId.data);
      return { exitCode: 0, stdout: clip(JSON.stringify(out, null, 2), 60_000) };
    },
  });
}

function providerLabel(providerId: string): string {
  if (providerId.includes("claude")) return "Claude";
  if (providerId.includes("codex")) return "Codex";
  if (providerId.includes("cursor")) return "Cursor";
  return providerId ? clip(providerId, 24) : "Agent";
}

export function modelLabel(model: string): string {
  const m = model.toLowerCase();
  // OpenAI models on the Codex provider: "gpt-6.1-sol" -> "GPT-6.1 Sol".
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/.exec(m);
  if (gpt) return clip(`GPT-${gpt[1]}${gpt[2] ? " " + gpt[2].split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : ""}`, 24);
  if (/^(opus|sonnet|haiku|fable)( \d+\.\d+)?$/.test(m)) return model.charAt(0).toUpperCase() + model.slice(1); // already a label, or a bare family name
  const version = /(\d+)[-.](\d+)/.exec(m);
  const v = version ? `${version[1]}.${version[2]}` : "";
  if (m.includes("opus")) return `Opus${v ? " " + v : ""}`;
  if (m.includes("sonnet")) return `Sonnet${v ? " " + v : ""}`;
  if (m.includes("haiku")) return `Haiku${v ? " " + v : ""}`;
  if (m.includes("fable")) return "Fable";
  return model ? clip(model, 24) : "inherited model";
}

// Read-only harness against a running bb (not part of the normal test run).
// Loads the real server plugin with a bb object whose SDK calls go to the live
// HTTP API using GET only (plus the read-only plugin-metadata list POST), keeps
// plugin storage in memory, and prints the Team for a thread.
//
//   HD_LIVE=http://127.0.0.1:38886 HD_THREAD=thr_x HD_OUT=/tmp/team.json npx vitest run tests/live-harness.test.ts
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { teamSchema } from "../team";

const base = process.env.HD_LIVE ?? "";
const threadId = process.env.HD_THREAD ?? "";

async function getJson(path: string, query: Record<string, unknown> = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && k !== "signal" && k !== "threadId") qs.set(k, String(v));
  const res = await fetch(`${base}/api/v1${path}${qs.size ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

function liveBb() {
  const kv = new Map<string, unknown>();
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
  const bb = {
    pluginId: "helper-desk",
    settings: { define: () => ({}) },
    storage: { kv: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v) } },
    events: { on: () => () => undefined },
    realtime: { publish: () => undefined },
    log: { warn: (m: string) => console.warn(m), info: () => undefined, error: (m: string) => console.error(m), debug: () => undefined },
    cli: { register: () => undefined },
    rpc: { register: (_c: unknown, h: typeof handlers) => Object.assign(handlers, h) },
    sdk: {
      status: { get: async () => ({ pendingTodos: null }) },
      threads: {
        get: ({ threadId: id, include }: { threadId: string; include?: string }) => getJson(`/threads/${id}`, include ? { include } : {}),
        list: (args: Record<string, unknown> = {}) => getJson("/threads", args),
        timeline: async () => ({ contextWindowUsage: null }),
        getPluginMetadata: ({ threadId: id, pluginId }: { threadId: string; pluginId: string }) => getJson(`/threads/${id}/plugin-metadata`, { pluginId }),
        experimental_listPluginMetadata: async (body: { pluginId: string; threadIds: string[] }) => {
          const res = await fetch(`${base}/api/v1/threads/plugin-metadata`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          return res.json();
        },
        interactions: { list: async ({ threadId: id }: { threadId: string }) => getJson(`/threads/${id}/interactions`).catch(() => []) },
        events: {
          list: (args: { threadId: string; afterSeq: string; limit: string; order: string; types?: string[] }) =>
            getJson(`/threads/${args.threadId}/events`, { afterSeq: args.afterSeq, limit: args.limit, order: args.order, ...(args.types ? { types: args.types.join(",") } : {}) }),
        },
      },
    },
  };
  return { bb, handlers };
}

describe.skipIf(!base || !threadId)("live team harness (read-only)", () => {
  it(
    "builds the team for a live thread",
    async () => {
      const { bb, handlers } = liveBb();
      const mod = await import("../server");
      mod.default(bb as never);
      const team = teamSchema.parse(await handlers.team({ threadId }));
      if (process.env.HD_OUT) writeFileSync(process.env.HD_OUT, JSON.stringify(team, null, 2));
      for (const s of team.sessions) console.log(`session ${s.threadId} ${s.role} ${s.provider} ${s.model}${s.active ? " (now)" : ""}`);
      for (const a of team.agents.filter((x) => x.state === "running" || x.kind === "lead")) console.log(`${a.kind.padEnd(14)} ${a.state.padEnd(9)} ${a.name.slice(0, 40).padEnd(40)} ${a.worktree ?? "-"}`);
      for (const w of team.worktrees) console.log(`worktree ${w.path} ${w.branch} changed=${w.changed} ahead=${w.ahead} behind=${w.behind} base=${w.base}`);
      expect(team.sessions.length).toBeGreaterThan(0);
    },
    240_000,
  );
});

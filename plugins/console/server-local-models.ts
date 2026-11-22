// Local models in memory: what Ollama holds loaded on this Mac, and loading or
// unloading one from the Local orb. bb's server asks Ollama, so the buttons
// work from a phone too. Only `ollama/` models: LM Studio loads its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isRemoteModel } from "./src/session-profile";

/**
 * Where Ollama answers on this Mac, from OLLAMA_HOST as Ollama itself reads it ("host", "host:port" or a
 * URL; with no port, 11434, or 80 / 443 after an explicit http:// / https://), or the default 127.0.0.1:11434. Only an address of this Mac counts:
 * a loopback address, or 0.0.0.0 / :: (Ollama listening on every address of this Mac, reached here on the
 * loopback). OLLAMA_HOST naming another machine gives null: its models are not on this Mac, so nothing
 * here calls them Local. Shared by the orb's checks and the Claude Code route, so the two always agree.
 */
export function ollamaBaseFrom(host: string | undefined): string | null {
  const raw = (host ?? "").trim();
  if (!raw) return "http://127.0.0.1:11434";
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const h = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Ollama's own rule: no scheme means port 11434; an explicit http:// or https:// means 80 or 443.
  const port = url.port || (/^https:\/\//i.test(raw) ? "443" : /^http:\/\//i.test(raw) ? "80" : "11434");
  if (h === "::1") return `${url.protocol}//[::1]:${port}`;
  if (h === "localhost" || h === "0.0.0.0" || h === "::" || /^127\.\d+\.\d+\.\d+$/.test(h)) return `${url.protocol}//127.0.0.1:${port}`;
  return null;
}
/** Ollama on this Mac, or null when OLLAMA_HOST points it at another machine. */
export const OLLAMA_BASE = ollamaBaseFrom(process.env.OLLAMA_HOST);
export const OLLAMA_ELSEWHERE_REASON = "OLLAMA_HOST points Ollama at another machine, so its models are not on this Mac and a Local chat does not use them";
/** In local_models_remote: every Ollama model is to be left out (Ollama is set to another machine). */
export const ALL_OLLAMA = "ollama/*";
/** How long a model loaded from the orb stays in memory with no use. */
const KEEP_ALIVE = "30m";

export const localModelId = z.string().regex(/^(ollama|lmstudio)\/[A-Za-z0-9._:@\/-]{1,180}$/);
export const localModelInput = z.object({ model: localModelId }).strict();
export const localModelStateOutput = z.object({
  /** False when Ollama does not answer on this Mac (LM Studio has its own entry below). */
  reachable: z.boolean(),
  /** Whether LM Studio answers on this Mac, and why not when it does not. */
  lmStudio: z.object({ reachable: z.boolean(), reason: z.string().optional() }),
  loaded: z.array(z.object({ model: z.string(), bytes: z.number(), until: z.string().nullable() })),
  loading: z.array(z.string()),
  /** The last load that failed, cleared by the next load of that model. */
  failed: z.array(z.object({ model: z.string(), reason: z.string() })),
});
export const localModelActionOutput = z.object({ ok: z.boolean(), reason: z.string().optional() });
/** The Ollama models served from Ollama's cloud, as the orb names them ("ollama/<name>"), so the orb never lists them. */
export const localModelsRemoteOutput = z.object({ remote: z.array(z.string()) });
export type LocalModelState = z.infer<typeof localModelStateOutput>;
export const localModelToolsOutput = z.object({
  /** True when the model can call tools in Claude Code; false when it cannot; null when Ollama did not say. */
  tools: z.boolean().nullable(),
  reason: z.string(),
  /** Why Claude Code is not offered: no tool use, too small a window, a cloud model, or not known. */
  why: z.enum(["tools", "window", "remote", "unknown"]).optional(),
  /** The window the model really runs with, when Ollama says. */
  window: z.number().nullable().optional(),
  /** The window Claude Code plans for (LOCAL_WINDOW_TOKENS). */
  need: z.number().optional(),
});
export type LocalModelTools = z.infer<typeof localModelToolsOutput>;

/**
 * Whether a model can call tools, from what Ollama itself reports (/api/show), so it works for any
 * model a user has, not a list of names. Two things must hold: Ollama lists the "tools" capability,
 * and the model's chat template really passes the tool list to the model (or Ollama renders it
 * itself). Some models list the capability but their template never shows the model a tool: they
 * then describe a tool call in prose instead of making one (DeepSeek R1 14B, 21 Nov 2026).
 */
export function toolSupportFromShow(show: { capabilities?: unknown; template?: unknown; renderer?: unknown; parser?: unknown }): LocalModelTools {
  const caps = Array.isArray(show.capabilities) ? show.capabilities.map(String) : [];
  if (!caps.includes("tools")) return { tools: false, reason: "Ollama says this model cannot call tools" };
  if ((typeof show.renderer === "string" && show.renderer) || (typeof show.parser === "string" && show.parser)) return { tools: true, reason: "Ollama renders this model's tools itself" };
  const template = typeof show.template === "string" ? show.template : "";
  // Go templates read .Tools; Jinja (GGUF) templates read a `tools` variable inside a tag.
  const passesTools = /\{\{[^}]*\.Tools\b/.test(template) || /\{[{%][^}%]*\btools\b/.test(template);
  return passesTools
    ? { tools: true, reason: "The model's template gives it the tool list" }
    : { tools: false, reason: "The model's template never shows it the tools, so it would describe a tool call instead of making one" };
}

const bare = (model: string) => model.replace(/^ollama\//, "");

/** LM Studio's server on this Mac (its default port). */
export const LMSTUDIO = "http://127.0.0.1:1234";
export const LMSTUDIO_PREFIX = "lmstudio/";
export const isLmStudio = (model: string) => model.startsWith(LMSTUDIO_PREFIX);
type LmEntry = { key?: string; type?: string; size_bytes?: number; capabilities?: { trained_for_tool_use?: boolean }; loaded_instances?: Array<{ id?: string; config?: { context_length?: number } }> };
/**
 * LM Studio is running but its server has "Require Authentication" on, so it answers 401 (or 403)
 * without a token. Local chats do not send one, so this is a setting to change in LM Studio, not an outage.
 */
export const LMSTUDIO_TOKEN_REASON =
  'LM Studio asks for an API token, and Local chats do not send one. In LM Studio\'s server settings, turn off "Require Authentication", then send again.';
export class LmStudioTokenError extends Error {
  constructor() {
    super(LMSTUDIO_TOKEN_REASON);
  }
}
/** Every model LM Studio lists (its REST API). Throws LmStudioTokenError when it wants a token, and an Error when it does not answer. */
async function lmStudioList(f: typeof fetch, timeoutMs: number): Promise<LmEntry[]> {
  const res = await f(`${LMSTUDIO}/api/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401 || res.status === 403) throw new LmStudioTokenError();
  if (!res.ok) throw new Error(`LM Studio answered ${res.status}`);
  const body = (await res.json()) as { models?: LmEntry[] };
  return body.models ?? [];
}
/** LM Studio's own record of a model (its REST API), or null when it does not list it. Throws when LM Studio does not answer or wants a token. */
export async function lmStudioModel(f: typeof fetch, key: string): Promise<LmEntry | null> {
  return (await lmStudioList(f, 4000)).find((m) => m.key === key) ?? null;
}
/** Whether an LM Studio model can take a Local Claude chat now: loaded, with a big enough window. */
export async function lmStudioReady(f: typeof fetch, key: string): Promise<{ ok: true } | { ok: false; status: number; type: string; message: string }> {
  let entry: LmEntry | null;
  try {
    entry = await lmStudioModel(f, key);
  } catch (e) {
    // Not an outage: a 400 is shown once, where a 5xx would be retried for minutes with nothing changing.
    if (e instanceof LmStudioTokenError) return { ok: false, status: 400, type: "invalid_request_error", message: LMSTUDIO_TOKEN_REASON };
    return { ok: false, status: 503, type: "api_error", message: "LM Studio is not running on this Mac. Start LM Studio (or run: lms server start), then send again." };
  }
  if (!entry) return { ok: false, status: 404, type: "not_found_error", message: `No LM Studio model called "${key}" on this Mac. Pick one from the Local orb.` };
  const window = entry.loaded_instances?.[0]?.config?.context_length;
  const how = `Load it from the Local orb, or run: lms load ${key} --context-length ${LOCAL_WINDOW_TOKENS}`;
  if (typeof window !== "number") return { ok: false, status: 400, type: "invalid_request_error", message: `${key} is not loaded in LM Studio. ${how}` };
  if (window < LOCAL_WINDOW_TOKENS)
    return { ok: false, status: 400, type: "invalid_request_error", message: `${key} is loaded with a ${window.toLocaleString("en-GB")}-token window and Claude Code needs ${LOCAL_WINDOW_TOKENS.toLocaleString("en-GB")}. Unload it, then ${how.charAt(0).toLowerCase()}${how.slice(1)}` };
  return { ok: true };
}
/** Whether Ollama serves a model from its cloud (shared with the app, which hides such models). */
export { isRemoteModel };
/**
 * The window a Local chat on Claude Code plans for (the launcher's CLAUDE_CODE_MAX_CONTEXT_TOKENS).
 * The lean prompt is about 31,000 tokens on its first turn and Claude Code compacts at this less
 * 13,000 and the 8,192 output cap, so a model must really run with at least this many.
 */
export const LOCAL_WINDOW_TOKENS = 65_536;

/**
 * The least total memory on which Load asks LM Studio for a LOCAL_WINDOW_TOKENS window. Measured: a
 * 27B model at that window held about 21 GB on a 48 GB Apple Silicon Mac. macOS lets the GPU use only
 * part of memory (roughly two thirds to three quarters), so on a 32 GB Mac that load can exhaust
 * memory. 40 GiB keeps every 32 GB and smaller Mac out, and lets 48 GB and larger in. Machines below
 * 48 GB are untested, so the rule stays on the cautious side.
 */
export const LMSTUDIO_LOAD_MIN_MEMORY = 40 * 1024 ** 3;
export const LMSTUDIO_SMALL_MEMORY_REASON =
  "This Mac has less than 40 GB of memory, so Load does not ask LM Studio for the 65,536-token window Claude Code needs: it could run out of memory. Load the model in LM Studio itself with a smaller window, then chat with it through opencode.";

/** num_ctx from a Modelfile's parameters text ("num_ctx    65536"), or null when it is not set. */
export function numCtxFromParameters(parameters: unknown): number | null {
  if (typeof parameters !== "string") return null;
  const m = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(parameters);
  return m ? Number(m[1]) : null;
}
/** The longest window the model was trained for (model_info "<arch>.context_length"), or null. */
export function trainedContext(modelInfo: unknown): number | null {
  if (!modelInfo || typeof modelInfo !== "object") return null;
  for (const [k, v] of Object.entries(modelInfo as Record<string, unknown>)) if (k.endsWith(".context_length") && typeof v === "number") return v;
  return null;
}

export const REMOTE_REASON = "This model runs on Ollama's cloud, not on this Mac, so a Local chat cannot use it";

/**
 * Ollama's own name for a model, from a name as the orb or a mark gives it. Ollama lists a model
 * pulled without a tag as "name:latest", so a bare name also matches that. Exact otherwise.
 */
export function ollamaName(listed: Iterable<string>, wanted: string): string | null {
  const want = bare(wanted);
  const names = new Set(listed);
  if (names.has(want)) return want;
  if (!want.includes(":") && names.has(`${want}:latest`)) return `${want}:latest`;
  return null;
}
const tagged = (name: string) => `ollama/${name}`;

type Fetch = typeof fetch;

export function createLocalModels(deps: { fetch?: Fetch; warn?: (m: string) => void; totalMemory?: () => number; ollama?: string | null } = {}) {
  const f: Fetch = deps.fetch ?? fetch;
  // Ollama on this Mac; null when it is set to another machine (then no Ollama model is treated as Local).
  const ollamaBase = deps.ollama === undefined ? OLLAMA_BASE : deps.ollama;
  const OLLAMA = ollamaBase ?? "http://127.0.0.1:0";
  const totalMemory = deps.totalMemory ?? (() => os.totalmem());
  const loading = new Set<string>();
  const failed = new Map<string, string>();

  const generate = async (model: string, keepAlive: string | number, timeoutMs: number): Promise<void> => {
    const res = await f(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: bare(model), keep_alive: keepAlive, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let reason = `Ollama answered ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) reason = body.error;
      } catch {}
      throw new Error(reason);
    }
  };

  /** LM Studio's loaded models, for the memory light, and whether it answered at all (and why not). */
  const lmStudioLoaded = async (): Promise<{ status: LocalModelState["lmStudio"]; loaded: LocalModelState["loaded"] }> => {
    try {
      const models = await lmStudioList(f, 2000);
      const loaded = models.filter((m) => (m.loaded_instances ?? []).length > 0).map((m) => ({ model: `${LMSTUDIO_PREFIX}${m.key}`, bytes: Number(m.size_bytes ?? 0), until: null }));
      return { status: { reachable: true }, loaded };
    } catch (e) {
      return { status: { reachable: false, reason: e instanceof LmStudioTokenError ? LMSTUDIO_TOKEN_REASON : "LM Studio is not running" }, loaded: [] };
    }
  };
  /** LM Studio loads a model with a 4,096-token window unless told; a Local Claude chat needs LOCAL_WINDOW_TOKENS. */
  const lmStudioLoad = async (key: string): Promise<void> => {
    const res = await f(`${LMSTUDIO}/api/v1/models/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: key, context_length: LOCAL_WINDOW_TOKENS }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (res.status === 401 || res.status === 403) throw new LmStudioTokenError();
    if (!res.ok) {
      let reason = `LM Studio answered ${res.status}`;
      try {
        const b = (await res.json()) as { error?: { message?: string } };
        if (b?.error?.message) reason = b.error.message;
      } catch {}
      throw new Error(reason);
    }
  };
  const lmStudioUnload = async (key: string): Promise<void> => {
    const entry = await lmStudioModel(f, key);
    for (const inst of entry?.loaded_instances ?? []) {
      if (!inst.id) continue;
      const res = await f(`${LMSTUDIO}/api/v1/models/unload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance_id: inst.id }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 || res.status === 403) throw new LmStudioTokenError();
      if (!res.ok) throw new Error(`LM Studio answered ${res.status}`);
    }
  };
  // Keyed by model and Ollama's modified time, so a re-pulled model is checked again.
  const toolChecks = new Map<string, { support: LocalModelTools; numCtx: number | null; trained: number | null }>();

  return {
    /** Whether a model can call tools on the Claude Code harness (see toolSupportFromShow). */
    async tools(model: string): Promise<LocalModelTools> {
      if (isLmStudio(model)) {
        // LM Studio says whether a model was trained for tool use, and the window it is loaded with.
        const key = model.slice(LMSTUDIO_PREFIX.length);
        let entry: LmEntry | null;
        try {
          entry = await lmStudioModel(f, key);
        } catch (e) {
          return { tools: null, why: "unknown", reason: e instanceof LmStudioTokenError ? LMSTUDIO_TOKEN_REASON : "LM Studio did not answer" };
        }
        if (!entry) return { tools: null, why: "unknown", reason: "LM Studio does not list this model" };
        if (entry.type !== "llm" || entry.capabilities?.trained_for_tool_use !== true) return { tools: false, why: "tools", reason: "LM Studio says this model was not trained to use tools" };
        const window = entry.loaded_instances?.[0]?.config?.context_length ?? null;
        const need = LOCAL_WINDOW_TOKENS;
        if (window === null) return { tools: null, why: "unknown", window, need, reason: `Not loaded in LM Studio yet. Load it from the orb (it loads with a ${need.toLocaleString("en-GB")}-token window)` };
        if (window < need) return { tools: false, why: "window", window, need, reason: `Loaded with a ${window.toLocaleString("en-GB")}-token window and Claude Code needs ${need.toLocaleString("en-GB")}` };
        return { tools: true, window, need, reason: "LM Studio says this model can use tools" };
      }
      if (!ollamaBase) return { tools: false, why: "remote", reason: OLLAMA_ELSEWHERE_REASON };
      try {
        // The cheap list first: a model already checked at the same modified time is answered from the cache.
        const tags = await f(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!tags.ok) return { tools: null, reason: `Ollama answered ${tags.status}` };
        const list = (await tags.json()) as { models?: Array<{ name?: string; model?: string; modified_at?: string; remote_host?: string; remote_model?: string }> };
        const listed = (list.models ?? []).map((m) => String(m.name ?? m.model ?? ""));
        const name = ollamaName(listed, model);
        const entry = name ? (list.models ?? []).find((m) => (m.name ?? m.model) === name) : undefined;
        if (!entry) return { tools: null, reason: "Ollama does not list this model" };
        if (isRemoteModel(entry)) return { tools: false, reason: REMOTE_REASON, why: "remote" };
        const key = `${model}@${String(entry.modified_at ?? "")}`;
        let found = toolChecks.get(key);
        if (!found) {
          const res = await f(`${OLLAMA}/api/show`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: name }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return { tools: null, reason: `Ollama answered ${res.status}` };
          const show = (await res.json()) as { capabilities?: unknown; template?: unknown; renderer?: unknown; parser?: unknown; remote_host?: unknown; remote_model?: unknown; parameters?: unknown; model_info?: unknown };
          if (isRemoteModel({ ...show, name })) return { tools: false, reason: REMOTE_REASON, why: "remote" };
          found = { support: toolSupportFromShow(show), numCtx: numCtxFromParameters(show.parameters), trained: trainedContext(show.model_info) };
          toolChecks.set(key, found);
        }
        if (found.support.tools !== true) return { ...found.support, why: "tools" };
        // The window the model really runs with: its own num_ctx (capped by what it was trained for),
        // else what Ollama reports for it while it is in memory. The server's default is not readable.
        let window: number | null = found.numCtx !== null ? (found.trained ? Math.min(found.numCtx, found.trained) : found.numCtx) : null;
        if (window === null) {
          try {
            const ps = await f(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(3000) });
            const body = (await ps.json()) as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
            const loaded = (body.models ?? []).find((m) => (m.name ?? m.model) === name);
            if (loaded && typeof loaded.context_length === "number") window = loaded.context_length;
          } catch {}
        }
        const need = LOCAL_WINDOW_TOKENS;
        if (window === null)
          return { tools: null, why: "unknown", window, need, reason: "Ollama does not say what window this model runs with. Load it once from the orb, or give it num_ctx 65536" };
        if (window < need)
          return { tools: false, why: "window", window, need, reason: `This model runs with a ${window.toLocaleString("en-GB")}-token window and Claude Code needs ${need.toLocaleString("en-GB")}` };
        return { ...found.support, window, need };
      } catch {
        return { tools: null, reason: "Ollama did not answer" };
      }
    },
    /** What each runtime holds in memory. `reachable` is Ollama alone; LM Studio reports for itself. */
    async state(): Promise<LocalModelState> {
      const failures = [...failed].map(([model, reason]) => ({ model, reason }));
      const fromOllama = async (): Promise<LocalModelState["loaded"] | null> => {
        if (!ollamaBase) return null;
        try {
          const res = await f(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(3000) });
          if (!res.ok) return null;
          const body = (await res.json()) as { models?: Array<{ name?: string; model?: string; size?: number; expires_at?: string }> };
          return (body.models ?? []).map((m) => ({ model: tagged(m.name ?? m.model ?? ""), bytes: Number(m.size ?? 0), until: m.expires_at ?? null }));
        } catch {
          return null;
        }
      };
      const [ollama, lm] = await Promise.all([fromOllama(), lmStudioLoaded()]);
      const loaded = [...(ollama ?? []), ...lm.loaded];
      for (const m of loaded) loading.delete(m.model);
      return { reachable: ollama !== null, lmStudio: lm.status, loaded, loading: [...loading], failed: failures };
    },
    /** The Ollama models served from its cloud, named as the orb names them; none when Ollama does not answer. */
    async remote(): Promise<z.infer<typeof localModelsRemoteOutput>> {
      if (!ollamaBase) return { remote: [ALL_OLLAMA] };
      try {
        const res = await f(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { remote: [] };
        const body = (await res.json()) as { models?: Array<{ name?: string; model?: string; remote_host?: string; remote_model?: string }> };
        const out = new Set<string>();
        for (const m of body.models ?? []) {
          const name = String(m.name ?? m.model ?? "");
          if (!name || !isRemoteModel(m)) continue;
          out.add(tagged(name));
          // The orb may name a "<name>:latest" model without its tag, as Ollama itself accepts.
          if (name.endsWith(":latest")) out.add(tagged(name.slice(0, -":latest".length)));
        }
        return { remote: [...out] };
      } catch {
        return { remote: [] };
      }
    },
    /** Starts the load and returns at once: a large model takes minutes, and state() reports when it is in memory. */
    async load(model: string): Promise<z.infer<typeof localModelActionOutput>> {
      if (loading.has(model)) return { ok: true };
      // An LM Studio load always asks for the full window (see lmStudioLoad); refuse it where memory cannot hold that.
      if (isLmStudio(model)) {
        let total = 0;
        try {
          total = totalMemory();
        } catch {
          total = 0;
        }
        if (!(total >= LMSTUDIO_LOAD_MIN_MEMORY)) return { ok: false, reason: LMSTUDIO_SMALL_MEMORY_REASON };
      }
      if (!isLmStudio(model) && !ollamaBase) return { ok: false, reason: OLLAMA_ELSEWHERE_REASON };
      failed.delete(model);
      loading.add(model);
      void (isLmStudio(model) ? lmStudioLoad(model.slice(LMSTUDIO_PREFIX.length)) : generate(model, KEEP_ALIVE, 15 * 60_000))
        .catch((e: unknown) => {
          const reason = e instanceof Error ? e.message : String(e);
          failed.set(model, reason.slice(0, 200));
          deps.warn?.(`local model: load of ${model} failed (${reason})`);
        })
        .finally(() => loading.delete(model));
      return { ok: true };
    },
    async unload(model: string): Promise<z.infer<typeof localModelActionOutput>> {
      loading.delete(model);
      try {
        if (isLmStudio(model)) await lmStudioUnload(model.slice(LMSTUDIO_PREFIX.length));
        else await generate(model, 0, 20_000);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    },
  };
}

/* ------------------- the skills opencode puts in its first prompt ------------------- */

/**
 * opencode lists every installed skill in the first prompt of a chat: each folder holding a SKILL.md
 * directly under ~/.claude/skills and ~/.agents/skills, at most 200 of them (opencode 2.2.5, read from
 * a captured prompt). The Local orb counts them the same way, to warn before a slow first reply.
 * Only numbers leave this module: no SKILL.md is opened, only checked to exist.
 */
export const OPENCODE_SKILL_CAP = 200;
/** The skill folders opencode reads, under the home folder, in this order. */
export const SKILL_FOLDERS: ReadonlyArray<readonly [string, string]> = [
  [".claude", "skills"],
  [".agents", "skills"],
];
/** Bounds on one count: folder entries read per folder, and time for the whole count. */
export const SKILL_SCAN_MAX_ENTRIES = 5_000;
export const SKILL_SCAN_MAX_MS = 2_000;
/** How long a count is kept before the folders are read again. */
export const SKILL_COUNT_TTL_MS = 3 * 60_000;

export const localSkillsCountOutput = z.object({
  /** Skills opencode would list (capped at OPENCODE_SKILL_CAP); null when the count is not known. */
  skills: z.number().int().nonnegative().nullable(),
  /** True when the cap was reached, as it is for opencode. */
  capped: z.boolean(),
  /** False when a bound stopped the count early: the number is then a lower bound. */
  complete: z.boolean(),
});
export type LocalSkillsCount = z.infer<typeof localSkillsCountOutput>;
export const SKILLS_UNKNOWN: LocalSkillsCount = { skills: null, capped: false, complete: false };

/** The home folder from the server's environment, as opencode finds it on macOS, Linux and Windows. */
export function homeFromEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  for (const key of platform === "win32" ? ["USERPROFILE", "HOME"] : ["HOME", "USERPROFILE"]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  try {
    return os.homedir() || null;
  } catch {
    return null;
  }
}

/**
 * Counts the skills opencode would list for this home folder. Read-only and never throws: a missing or
 * unreadable folder counts as none. A name in both folders counts once. Stops at the cap, after
 * `maxEntries` entries of one folder, or after `maxMs`.
 */
export async function countSkills(
  home: string | null | undefined,
  limits: { maxEntries?: number; maxMs?: number; now?: () => number } = {},
): Promise<LocalSkillsCount> {
  if (!home) return SKILLS_UNKNOWN;
  const now = limits.now ?? Date.now;
  const maxEntries = limits.maxEntries ?? SKILL_SCAN_MAX_ENTRIES;
  const deadline = now() + (limits.maxMs ?? SKILL_SCAN_MAX_MS);
  const names = new Set<string>();
  let complete = true;
  try {
    for (const parts of SKILL_FOLDERS) {
      if (names.size >= OPENCODE_SKILL_CAP) break;
      const dir = path.join(home, ...parts);
      let handle: fs.Dir;
      try {
        handle = await fs.promises.opendir(dir); // follows a linked skills folder
      } catch {
        continue;
      }
      try {
        for (let read = 0; names.size < OPENCODE_SKILL_CAP; read++) {
          if (read >= maxEntries || now() > deadline) {
            complete = false;
            break;
          }
          const entry = await handle.read();
          if (!entry) break;
          if (entry.name.startsWith(".") || names.has(entry.name) || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
          try {
            if (!(await fs.promises.stat(path.join(dir, entry.name, "SKILL.md"))).isFile()) continue; // stat follows links
          } catch {
            continue;
          }
          names.add(entry.name);
        }
      } catch {
        complete = false;
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  } catch {
    return SKILLS_UNKNOWN;
  }
  return { skills: names.size, capped: names.size >= OPENCODE_SKILL_CAP, complete };
}

/**
 * The count as the server serves it: kept for SKILL_COUNT_TTL_MS, and answered as unknown if the
 * folders do not answer in time (a skills folder on a network share, say). A count that hangs is
 * never joined by another: until that count itself finishes, every ask answers unknown at once.
 */
export function createSkillCount(deps: { home?: () => string | null; now?: () => number; ttlMs?: number; maxMs?: number; maxEntries?: number; count?: typeof countSkills } = {}) {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? SKILL_COUNT_TTL_MS;
  const maxMs = deps.maxMs ?? SKILL_SCAN_MAX_MS;
  const count = deps.count ?? countSkills;
  let cached: { at: number; value: LocalSkillsCount } | null = null;
  let waiting: Promise<LocalSkillsCount> | null = null;
  /** Set while a count runs; cleared only when that count itself finishes, never by the time limit. */
  let counting = false;
  return {
    count(): Promise<LocalSkillsCount> {
      if (cached && now() - cached.at < ttl) return Promise.resolve(cached.value);
      if (waiting) return waiting;
      if (counting) return Promise.resolve(SKILLS_UNKNOWN);
      let job: Promise<LocalSkillsCount>;
      try {
        const home = (deps.home ?? (() => homeFromEnv()))();
        counting = true;
        job = count(home, { maxMs, maxEntries: deps.maxEntries, now }).catch(() => SKILLS_UNKNOWN);
      } catch {
        return Promise.resolve(SKILLS_UNKNOWN);
      }
      void job
        .then((value) => {
          cached = { at: now(), value };
        })
        .finally(() => {
          counting = false;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<LocalSkillsCount>((resolve) => {
        timer = setTimeout(() => resolve(SKILLS_UNKNOWN), maxMs + 1_000);
      });
      waiting = Promise.race([job, late]).finally(() => {
        clearTimeout(timer);
        waiting = null;
      });
      return waiting;
    },
  };
}

// bb's measured share of a Local chat's first prompt: which request counts as a chat's first, what the route reads
// from the runner's answer (passing it on byte for byte), and the numbers-only file it keeps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PING_EVENT, createLocalClaudeRoute, firstPromptOf, usageTap } from "../server-local-claude";
import { FIRST_PROMPT_KEEP, createLocalLoadout, measuredShare, readFirstPrompts, recordFirstPrompt } from "../server-local-loadout";
import { BASE_TRIMMED_TOKENS, FIRST_WORDS_MAX_CHARS } from "../src/local-loadout";

const tools = (names: string[]) => names.map((name) => ({ name, input_schema: { type: "object" } }));
const TRIMMED = tools(["Agent", "Bash", "Edit", "NotebookEdit", "Read", "Skill", "TaskStop", "WebFetch", "Write", "mcp__bb__a", "mcp__bb__b"]);
const REMINDER = "<system-reminder>\nThe user's instruction files and the skill list.\n</system-reminder>";
// As Claude Code 2.1.330 sends a chat's first request: Claude Code's notes, then the user's words, then a "system" note.
const first = (over: Record<string, unknown> = {}) => ({
  model: "qwen:27b",
  stream: true,
  tools: TRIMMED,
  messages: [{ role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "Say OK." }] }, { role: "system", content: "A note from Claude Code." }],
  ...over,
});

describe("which request is a chat's first (firstPromptOf)", () => {
  it("reads the tool count, whether the trimmed tools were on, and the user's own words only", () => {
    expect(firstPromptOf(first())).toEqual({ tools: 11, trimmed: true, user: Math.ceil(7 / 3.4) });
    expect(firstPromptOf(first({ tools: [...TRIMMED, ...tools(["Monitor", "WebSearch"])] }))?.trimmed).toBe(false);
    expect(firstPromptOf(first({ messages: [{ role: "user", content: "Say OK." }] }))).toEqual({ tools: 11, trimmed: true, user: 3 });
  });
  it("is not a side request without tools, a later turn, a resumed chat, an image, or long words", () => {
    expect(firstPromptOf(first({ tools: [] }))).toBeNull();
    expect(firstPromptOf(first({ tools: undefined }))).toBeNull();
    expect(firstPromptOf(first({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "and?" }] }))).toBeNull();
    expect(firstPromptOf(first({ messages: [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "what is this" }] }] }))).toBeNull();
    expect(firstPromptOf(first({ messages: [{ role: "user", content: "x".repeat(FIRST_WORDS_MAX_CHARS + 1) }] }))).toBeNull();
    expect(firstPromptOf(first({ messages: [{ role: "user", content: "x".repeat(FIRST_WORDS_MAX_CHARS) }] }))).not.toBeNull();
    expect(firstPromptOf(first({ messages: [] }))).toBeNull();
  });
});

const sse = (events: Array<Record<string, unknown>>) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const answer = (input: number | null, opts: { stop?: boolean; error?: boolean; cache?: number } = {}) =>
  sse([
    { type: "message_start", message: { id: "m", usage: { input_tokens: 0, output_tokens: 0, ...(opts.cache ? { cache_read_input_tokens: opts.cache } : {}) } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'quoted "input_tokens": 99999 in the answer' } },
    ...(opts.error ? [{ type: "error", error: { type: "api_error", message: "x" } }] : []),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3, ...(input === null ? {} : { input_tokens: input }), ...(opts.cache ? { cache_read_input_tokens: opts.cache } : {}) } },
    ...(opts.stop === false ? [] : [{ type: "message_stop" }]),
  ]);
/** A body cut into pieces in the middle of lines, as a network read can. */
const pieces = (text: string, size = 37) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < text.length; i += size) c.enqueue(new TextEncoder().encode(text.slice(i, i + size)));
      c.close();
    },
  });

describe("what the route reads from the runner's answer (usageTap)", () => {
  const run = async (text: string) => {
    const onRead = vi.fn();
    const out = await new Response(pieces(text).pipeThrough(usageTap(onRead))).text();
    return { out, onRead };
  };
  it("passes the answer on byte for byte and reads the last input_tokens once, after message_stop", async () => {
    const text = answer(17_483);
    const { out, onRead } = await run(text);
    expect(out).toBe(text);
    expect(onRead.mock.calls).toEqual([[17_483]]);
  });
  it("reads nothing from a runner that reports no usage, an answer with an error event, or one cut short", async () => {
    for (const text of [answer(null), answer(0), answer(17_483, { error: true }), answer(17_483, { stop: false })]) {
      const { out, onRead } = await run(text);
      expect(out).toBe(text);
      expect(onRead).not.toHaveBeenCalled();
    }
  });
});

describe("the route, for a Local chat's first request", () => {
  // The same, under another name for a test whose runner is also called post.
  const postReq = (headers: Record<string, string>, body: unknown) => post(headers, body);
  const post = (headers: Record<string, string>, body: unknown) =>
    new Request("http://x/local/v1/messages", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s3cret", ...headers }, body: JSON.stringify(body) });
  const tags = () => new Response(JSON.stringify({ models: [{ name: "qwen:27b" }] }));
  const route = (reply: () => Response) => {
    const onRead = vi.fn();
    const firstPrompt = vi.fn(() => onRead);
    const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/tags") ? tags() : String(url).endsWith("/api/ps") ? new Response("{}") : reply()));
    return { r: createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, firstPrompt }), firstPrompt, onRead };
  };
  const stream = (text: string) => () => new Response(pieces(text), { headers: { "content-type": "text/event-stream" } });

  it("records the chat's first request with tools once per Claude Code session: a subagent's first request comes later in the same session", async () => {
    const text = answer(17_483);
    const { r, firstPrompt, onRead } = route(stream(text));
    const res = await r.messages(post({ "x-claude-code-session-id": "s-1" }, first()));
    expect(await res.text()).toBe(text); // Claude Code gets the answer unchanged
    expect(firstPrompt.mock.calls).toEqual([[{ tools: 11, trimmed: true, user: 3 }]]);
    expect(onRead.mock.calls).toEqual([[17_483]]);
    // The same session again (a subagent's opener, or the chat's next turn): not a first request.
    await (await r.messages(post({ "x-claude-code-session-id": "s-1" }, first({ messages: [{ role: "user", content: "Reply with hi." }] })))).text();
    expect(firstPrompt).toHaveBeenCalledTimes(1);
    // Another chat: its own first request.
    await (await r.messages(post({ "x-claude-code-session-id": "s-2" }, first()))).text();
    expect(firstPrompt).toHaveBeenCalledTimes(2);
  });
  it("a side request without tools does not use up the session's first request", async () => {
    const { r, firstPrompt } = route(stream(answer(300)));
    await (await r.messages(post({ "x-claude-code-session-id": "s-3" }, first({ tools: [] })))).text();
    expect(firstPrompt).not.toHaveBeenCalled();
    await (await r.messages(post({ "x-claude-code-session-id": "s-3" }, first()))).text();
    expect(firstPrompt).toHaveBeenCalledTimes(1);
  });
  it("records nothing without a session, for a resumed chat, a refused caller, a runner error or an answer that is not streamed", async () => {
    const a = route(stream(answer(17_483)));
    await (await a.r.messages(post({}, first()))).text();
    await (await a.r.messages(post({ "x-claude-code-session-id": "s-4" }, first({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "go on" }] })))).text();
    await (await a.r.messages(post({ authorization: "Bearer guess", "x-claude-code-session-id": "s-5" }, first()))).text();
    expect(a.firstPrompt).not.toHaveBeenCalled();
    const failed = route(() => new Response(JSON.stringify({ error: { message: "no" } }), { status: 500, headers: { "content-type": "application/json" } }));
    await (await failed.r.messages(post({ "x-claude-code-session-id": "s-6" }, first()))).text();
    expect(failed.onRead).not.toHaveBeenCalled();
    const whole = route(() => new Response(JSON.stringify({ type: "message", usage: { input_tokens: 17_483, output_tokens: 1 } }), { headers: { "content-type": "application/json" } }));
    await (await whole.r.messages(post({ "x-claude-code-session-id": "s-7" }, first({ stream: false })))).text();
    expect(whole.onRead).not.toHaveBeenCalled();
  });
  it("for a runner slow to answer (the route answers first and keeps Claude Code waiting with pings): reads once, the answer intact after the pings", async () => {
    const text = answer(18_492);
    const onRead = vi.fn();
    const fetch = vi.fn(async () => tags());
    // The runner holds its headers for a while, as Ollama does while it reads a first prompt.
    const post = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response(pieces(text), { headers: { "content-type": "text/event-stream" } });
    });
    const r = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, post, earlyHeadersMs: 20, pingEveryMs: 40, firstPrompt: () => onRead });
    const res = await r.messages(postReq({ "x-claude-code-session-id": "s-slow" }, first()));
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out.replaceAll(PING_EVENT, "")).toBe(text);
    expect(out.startsWith(PING_EVENT)).toBe(true);
    expect(onRead.mock.calls).toEqual([[18_492]]);
  });
  it("on LM Studio reads the whole prompt (its own input_tokens), while Claude Code gets the counts the Anthropic way", async () => {
    const onRead = vi.fn();
    const models = { models: [{ key: "qwen/qwen3.8-27b", type: "llm", loaded_instances: [{ id: "q", config: { context_length: 65_536 } }] }] };
    const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/v1/models") ? new Response(JSON.stringify(models)) : new Response(pieces(answer(17_000, { cache: 16_990 })), { headers: { "content-type": "text/event-stream" } })));
    const r = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, firstPrompt: () => onRead });
    const out = await (await r.messages(post({ "x-claude-code-session-id": "s-8", "x-nav-local-model": "lmstudio/qwen/qwen3.8-27b" }, first()))).text();
    expect(onRead.mock.calls).toEqual([[17_000]]);
    const delta = out.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "message_delta");
    expect(delta.usage.input_tokens).toBe(10);
  });
});

describe("the kept readings", () => {
  let dir = "";
  let file = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-first-"));
    file = path.join(dir, "plugins", "navaigate-skin", "local-first-prompt.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reading = (over = {}) => ({ at: Date.UTC(2026, 10, 22, 12), input: 17_483, tools: 17, trimmed: true, loadout: 0, user: 3, ...over });

  it("keeps the last five, numbers and a time only, readable by the user alone", () => {
    for (let i = 0; i < FIRST_PROMPT_KEEP + 2; i++) expect(recordFirstPrompt(file, reading({ at: 1_000 + i, input: 17_000 + i }))).toBe(17_000 + i - BASE_TRIMMED_TOKENS - 3);
    const kept = readFirstPrompts(file);
    expect(kept.map((r) => r.at)).toEqual([1_002, 1_003, 1_004, 1_005, 1_006]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(raw)).toEqual(["v", "readings"]);
    for (const r of raw.readings) {
      expect(Object.keys(r).sort()).toEqual(["at", "input", "loadout", "tools", "trimmed", "user"]);
      for (const [k, v] of Object.entries(r)) expect(typeof v, k).toBe(k === "trimmed" ? "boolean" : "number");
    }
    expect(measuredShare(file)).toEqual({ bb: 17_006 - BASE_TRIMMED_TOKENS - 3, at: 1_006, tools: 17, trimmed: true });
  });
  it("writes nothing for a nonsense reading, and keeps the last good share", () => {
    expect(recordFirstPrompt(file, reading({ input: 0 }))).toBeNull();
    expect(recordFirstPrompt(file, reading({ input: 8_000 }))).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(measuredShare(file)).toBeNull();
    recordFirstPrompt(file, reading());
    expect(recordFirstPrompt(file, reading({ input: 5 }))).toBeNull();
    expect(measuredShare(file)?.bb).toBe(17_483 - BASE_TRIMMED_TOKENS - 3);
  });
  it("gives no share from a damaged or hand-edited file", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const text of ["not json", JSON.stringify({ v: 1, readings: [{ ...reading(), text: "a prompt" }] }), JSON.stringify({ v: 2, readings: [reading()] })]) {
      fs.writeFileSync(file, text);
      expect(measuredShare(file)).toBeNull();
    }
    fs.writeFileSync(file, JSON.stringify({ v: 1, readings: [reading(), reading({ input: 2 })] }));
    expect(measuredShare(file)?.bb).toBe(17_483 - BASE_TRIMMED_TOKENS - 3); // the latest that gives a share
  });
  it("the loadout's state carries the share, and its part is what is linked, with the stored options", async () => {
    const listing = { skills: [{ name: "a", descChars: 10, bodyChars: 100 }, { name: "b", descChars: 10, bodyChars: 100 }], agents: [], complete: true, others: { skills: 0, agents: 0 } };
    const setup = Object.assign(() => ({ ok: true as const }), { refresh: () => ({ ok: true as const }) });
    const svc = createLocalLoadout({ home: () => dir, config: path.join(dir, "cfg"), localRoot: path.join(dir, "local"), file: path.join(dir, "loadout.json"), firstPrompts: file, on: () => true, setup, list: async () => listing });
    expect((await svc.state()).measured).toBeNull();
    expect(await svc.part()).toBe(0); // nothing linked yet
    recordFirstPrompt(file, reading());
    expect((await svc.state()).measured).toEqual({ bb: 17_483 - BASE_TRIMMED_TOKENS - 3, at: reading().at, tools: 17, trimmed: true });
  });
});

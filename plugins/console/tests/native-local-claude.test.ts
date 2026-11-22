// A Local chat on the Claude Code harness: the environment rule, the launcher,
// the message repair that keeps a local model's prompt cache, and the route's checks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localEnvFor } from "../server-session-profile";
import type { SessionProfileMark } from "../src/session-profile";
import { createLocalClaudeRoute, fixLmStudioEventLine, guardScript, launcherScript, ollamaErrorType, repairMessages, rewriteRequest, UNAUTHORISED_LOG_MS } from "../server-local-claude";

/** Writes a script and a fake claude that prints its arguments and two variables, then runs the script. */
function runScript(make: (fakeClaude: string) => string, args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-local-"));
  const fake = path.join(dir, "claude");
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "ARGS:%s\\n" "$*"\nprintf "HEADER:%s\\n" "$ANTHROPIC_CUSTOM_HEADERS"\nprintf "BASE:%s\\n" "$ANTHROPIC_BASE_URL"\n', { mode: 0o700 });
  const script = path.join(dir, "script");
  fs.writeFileSync(script, make(fake), { mode: 0o700 });
  try {
    const out = execFileSync("/bin/sh", [script, ...args], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? -1, out: String(x.stdout ?? ""), err: String(x.stderr ?? "") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MAIN = "host_main";
const local = { profile: "local" as const, model: "ollama/qwen", v: 1 as const };
const base = {
  threadId: "thr_1" as string | null,
  hostId: MAIN,
  primaryHostId: MAIN as string | null,
  mark: local as SessionProfileMark | null,
  launcher: "/home/x/.claude-local/bin/claude-local" as string | null,
  serverPath: "/api/v1/plugins/navaigate-skin/http/local",
  blocked: (why: string) => `/blocked/${why}`,
};

describe("the local environment rule (pure)", () => {
  it("names the launcher, the route and the chat's marked model for a local chat on the server's own Mac", () => {
    expect(localEnvFor(base)).toEqual([
      { name: "BB_CLAUDE_CODE_EXECUTABLE", value: base.launcher, reason: expect.any(String) },
      { name: "NAV_LOCAL_BASE_URL", value: { serverPath: base.serverPath }, reason: expect.any(String) },
      { name: "NAV_LOCAL_MODEL", value: "qwen", reason: expect.any(String) },
    ]);
    expect(localEnvFor({ ...base, mark: { ...local, profile: "local-unlocked" } })).toHaveLength(3);
  });
  it("passes an LM Studio model with its prefix, so the route knows where it runs", () => {
    const env = localEnvFor({ ...base, mark: { profile: "local", model: "lmstudio/qwen/qwen3.8-27b", v: 1 } });
    expect(env.find((e) => e.name === "NAV_LOCAL_MODEL")?.value).toBe("lmstudio/qwen/qwen3.8-27b");
  });
  it("never touches the Account Pooler's own values", () => {
    const names = localEnvFor(base).map((e) => e.name);
    for (const taken of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "ENABLE_TOOL_SEARCH", "CLAUDE_CONFIG_DIR"]) expect(names).not.toContain(taken);
  });
  it("gives nothing to an Online or Lean chat, or without a thread", () => {
    expect(localEnvFor({ ...base, mark: null })).toEqual([]);
    expect(localEnvFor({ ...base, mark: { profile: "lean", v: 1 } })).toEqual([]);
    expect(localEnvFor({ ...base, threadId: null })).toEqual([]);
  });
  it("blocks a local chat it cannot run here, instead of letting it start as an ordinary Claude chat", () => {
    const only = (entries: ReturnType<typeof localEnvFor>) => {
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("BB_CLAUDE_CODE_EXECUTABLE");
      return String(entries[0].value);
    };
    expect(only(localEnvFor({ ...base, hostId: "host_other" }))).toBe("/blocked/local-chats-run-only-on-the-bb-server-mac");
    expect(only(localEnvFor({ ...base, primaryHostId: null }))).toContain("/blocked/");
    expect(only(localEnvFor({ ...base, launcher: null }))).toBe("/blocked/local-chat-setup-failed-see-plugin-log");
    expect(only(localEnvFor({ ...base, mark: { profile: "local", v: 1 } }))).toBe("/blocked/local-chat-has-no-model");
  });
  it("answers the same every time (a changed answer rebuilds the chat's session)", () => {
    expect(JSON.stringify(localEnvFor(base))).toBe(JSON.stringify(localEnvFor(base)));
  });
});

describe("the launcher", () => {
  const script = launcherScript({ secret: "s3cret", realClaude: "/opt/x/claude", configDir: "/home/x/.claude-local/config" });
  it("refuses to start without the local route, so a Local chat cannot reach Anthropic", () => {
    expect(script).toMatch(/if \[ -z "\$NAV_LOCAL_BASE_URL" \]; then[\s\S]*exit 78/);
    expect(script.indexOf("exit 78")).toBeLessThan(script.indexOf("exec "));
  });
  it("points Claude Code at the route and hands every argument to the real claude", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('export ANTHROPIC_BASE_URL="$NAV_LOCAL_BASE_URL"');
    expect(script).toContain("export ANTHROPIC_AUTH_TOKEN='s3cret'");
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/home/x/.claude-local/config'");
    expect(script.trimEnd().endsWith(`exec '/opt/x/claude' "$@"`)).toBe(true);
  });
  it("runs on the chat's marked model whatever bb asks for, and starts Claude Code on it too", () => {
    const make = (fake: string) => launcherScript({ secret: "s3cret", realClaude: fake, configDir: "/tmp/cfg" });
    // A later turn after a session restart: bb asks for a Claude model; the mark says qwen.
    const r = runScript(make, ["--print", "--model", "claude-opus-5-5", "--verbose"], { NAV_LOCAL_BASE_URL: "http://127.0.0.1:1/local", NAV_LOCAL_MODEL: "qwen:27b" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ARGS:--print --model qwen:27b --verbose");
    expect(r.out).toContain("HEADER:x-nav-local-model: qwen:27b");
    expect(r.out).toContain("BASE:http://127.0.0.1:1/local");
    const eq = runScript(make, ["--model=claude-opus-5-5"], { NAV_LOCAL_BASE_URL: "http://x", NAV_LOCAL_MODEL: "qwen:27b" });
    expect(eq.out).toContain("ARGS:--model=qwen:27b");
    // An older server that sends no mark model: the launcher keeps bb's --model, as before.
    const old = runScript(make, ["--model", "qwen:27b"], { NAV_LOCAL_BASE_URL: "http://x" });
    expect(old.out).toContain("HEADER:x-nav-local-model: qwen:27b");
  });
  it("does not start at all without the local route", () => {
    const r = runScript((fake) => launcherScript({ secret: "s", realClaude: fake, configDir: "/tmp/cfg" }), ["--model", "qwen:27b"], { NAV_LOCAL_MODEL: "qwen:27b" });
    expect(r.code).toBe(78);
    expect(r.out).not.toContain("ARGS:");
  });
  it("keeps prompt and answer inside the local window, and keeps the prompt's start the same every turn", () => {
    expect(script).toContain("export CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536");
    // Claude Code ignores an auto-compact window under 100k (and warns), so it is not set.
    expect(script).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    expect(script).toContain("export CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192");
    expect(script).toContain("export CLAUDE_CODE_ATTRIBUTION_HEADER=0");
    expect(script).toContain('export CLAUDE_CODE_SUBAGENT_MODEL="$model"');
    expect(script.indexOf("CLAUDE_CODE_MAX_OUTPUT_TOKENS")).toBeLessThan(script.indexOf("exec "));
  });
});

describe("the guard, used when the plugin could not read whether a chat is Local", () => {
  const make = (fake: string) => guardScript({ realClaude: fake });
  it("starts the real claude, untouched, for a Claude model name", () => {
    for (const m of ["claude-opus-5-5", "claude-fable-5-2[1m]", "opus", "sonnet[1m]", "default", "us.anthropic.claude-sonnet-4-5-v1:0", "anthropic.claude-3-haiku-20240307-v1:0", "global.anthropic.claude-sonnet-4-5-v1:0", "arn:aws:bedrock:us-east-1:000000000000:inference-profile/x"]) {
      const r = runScript(make, ["--model", m], { ANTHROPIC_BASE_URL: "http://pool" });
      expect(r.code, m).toBe(0);
      expect(r.out).toContain(`ARGS:--model ${m}`);
      expect(r.out).toContain("BASE:http://pool");
    }
  });
  it("refuses any other model name, so a Local chat's prompt never goes to an online account", () => {
    for (const args of [["--model", "qwen3.8-64k:27b"], ["--model=deepseek-r1:14b"], ["--model", "my-anthropic.claude-tune"], ["--model", "anthropic.claude"]]) {
      const r = runScript(make, args, { ANTHROPIC_BASE_URL: "http://pool" });
      expect(r.code).toBe(78);
      expect(r.out).not.toContain("ARGS:");
      expect(r.err).toContain("does not start");
    }
  });
});

describe("the message repair", () => {
  it("keeps a mid-conversation system note in place, as text on the user message before it", () => {
    const out = repairMessages([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "system", content: [{ type: "text", text: "a note" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "a note" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(out.some((m) => m.role === "system")).toBe(false);
  });
  it("turns a note with no user message before it into one, and leaves other messages alone", () => {
    const tool = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] };
    expect(repairMessages([{ role: "system", content: "note" }, tool])).toEqual([{ role: "user", content: [{ type: "text", text: "note" }] }, tool]);
  });
  it("drops the billing line whose code changes every request, and sets Ollama's model name", () => {
    const body = { model: "claude-opus-5-5", system: [{ type: "text", text: "x-anthropic-billing-header: cch=abc12;" }, { type: "text", text: "You are Claude Code." }], messages: [{ role: "user", content: "hi" }], tools: [{ name: "Bash" }] };
    const a = rewriteRequest(body, "qwen:27b");
    const b = rewriteRequest({ ...body, system: [{ type: "text", text: "x-anthropic-billing-header: cch=zzz99;" }, body.system[1]] }, "qwen:27b");
    expect(a.model).toBe("qwen:27b");
    expect(a.system).toEqual([{ type: "text", text: "You are Claude Code." }]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tools).toEqual(body.tools);
  });
});

describe("the route", () => {
  const tags = () => new Response(JSON.stringify({ models: [{ name: "qwen:27b" }] }));
  const post = (headers: Record<string, string>, body: unknown) => new Request("http://x/local/v1/messages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  it("refuses a caller without the secret, before anything reaches Ollama", async () => {
    const fetch = vi.fn();
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch });
    expect((await route.messages(post({}, { model: "qwen:27b", messages: [] }))).status).toBe(401);
    expect((await route.messages(post({ authorization: "Bearer wrong" }, { model: "qwen:27b", messages: [] }))).status).toBe(401);
    expect((await createLocalClaudeRoute({ secret: () => null, fetch: fetch as unknown as typeof globalThis.fetch }).messages(post({ authorization: "Bearer " }, {}))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a model Ollama does not hold", async () => {
    const fetch = vi.fn(async () => tags());
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch });
    const res = await route.messages(post({ authorization: "Bearer s3cret" }, { model: "claude-opus-5-5", messages: [] }));
    expect(res.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("logs every request on arrival and every refusal with its reason and the model asked for, never the prompt", async () => {
    const log = vi.fn();
    const fetch = vi.fn(async () => tags());
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, log });
    await route.messages(post({ authorization: "Bearer wrong" }, { model: "qwen:27b", messages: [{ role: "user", content: "secret plans" }] }));
    await route.messages(post({ authorization: "Bearer s3cret", "x-nav-local-model": "claude-opus-5-5" }, { model: "claude-opus-5-5", messages: [{ role: "user", content: "secret plans" }] }));
    const lines = log.mock.calls.map((c) => String(c[0]));
    // A caller without the secret gets one fixed line, with nothing it sent in it.
    expect(lines.filter((l) => l.includes("request in"))).toHaveLength(1);
    expect(lines).toContainEqual("local claude: answered 401 (authentication_error) to 1 request without the secret: This route is for Local chats started by bb on this Mac.");
    expect(lines).toContainEqual(expect.stringMatching(/answered 404 \(not_found_error\) for model "claude-opus-5-5": No local model called/));
    expect(lines.join("\n")).not.toContain("secret plans");
  });
  it("logs only the status and error type of an error answer from Ollama, and passes the body on unchanged", async () => {
    const log = vi.fn();
    const err = JSON.stringify({ type: "error", error: { type: "api_error", message: "could not parse tool call: secret plans" } });
    const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/tags") ? tags() : new Response(err, { status: 500, headers: { "content-type": "application/json" } })));
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, log });
    const res = await route.messages(post({ authorization: "Bearer s3cret" }, { model: "qwen:27b", messages: [{ role: "user", content: "secret plans" }] }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(err);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual('local claude: answered 500 (from Ollama, api_error) for model "qwen:27b"');
    expect(lines.join("\n")).not.toContain("secret plans");
  });
  it("writes no log line per refused caller: the first, then one line every ten minutes with how many", async () => {
    const log = vi.fn();
    let t = 0;
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: vi.fn() as unknown as typeof globalThis.fetch, log, now: () => t });
    for (let i = 0; i < 50; i++) await route.messages(post({ authorization: "Bearer wrong" }, {}));
    expect(log).toHaveBeenCalledTimes(1);
    t += UNAUTHORISED_LOG_MS;
    await route.messages(post({}, {}));
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1][0])).toContain("to 50 requests without the secret");
  });
  it("uses the same Ollama address as the orb, and refuses every Ollama model when Ollama is set to another machine", async () => {
    const fetch = vi.fn(async () => tags());
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, ollama: null });
    const res = await route.messages(post({ authorization: "Bearer s3cret", "x-nav-local-model": "qwen:27b" }, { model: "qwen:27b", messages: [] }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("another machine");
    expect(fetch).not.toHaveBeenCalled();
    const elsewhere = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, ollama: "http://127.0.0.1:11500" });
    await elsewhere.messages(post({ authorization: "Bearer s3cret" }, { model: "qwen:27b", messages: [] }));
    expect(String(fetch.mock.calls[0][0])).toBe("http://127.0.0.1:11500/api/tags");
  });
  it("names Ollama's error type only from a fixed list", () => {
    expect(ollamaErrorType(JSON.stringify({ error: { type: "api_error", message: "x" } }))).toBe("api_error");
    expect(ollamaErrorType(JSON.stringify({ error: { type: "secret plans" } }))).toBe("unknown");
    expect(ollamaErrorType("secret plans")).toBe("not JSON");
  });
  it("uses the chat's model from the launcher's header even when the request names another model Ollama holds", async () => {
    const both = () => new Response(JSON.stringify({ models: [{ name: "qwen:27b" }, { name: "gemma:4b" }] }));
    const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/tags") ? both() : new Response("event: message_start\n\n", { headers: { "content-type": "text/event-stream" } })));
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch });
    await route.messages(post({ authorization: "Bearer s3cret", "x-nav-local-model": "qwen:27b" }, { model: "gemma:4b", messages: [{ role: "user", content: "hi" }] }));
    const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("qwen:27b");
  });
  it("refuses a model Ollama serves from its cloud, with the reason in the chat and the log, before anything is sent", async () => {
    const log = vi.fn();
    const cloud = () => new Response(JSON.stringify({ models: [{ name: "gpt-oss:120b-cloud", remote_host: "https://ollama.com:443", remote_model: "gpt-oss:120b" }] }));
    const fetch = vi.fn(async () => cloud());
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch, log });
    const res = await route.messages(post({ authorization: "Bearer s3cret", "x-nav-local-model": "gpt-oss:120b-cloud" }, { model: "claude-opus-5-5", messages: [{ role: "user", content: "secret plans" }] }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toMatch(/Ollama's cloud, not on this Mac/);
    expect(fetch).toHaveBeenCalledTimes(1); // only the model list, never /v1/messages
    expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/answered 403 \(permission_error\) for model "gpt-oss:120b-cloud"/));
  });
  describe("an LM Studio chat", () => {
    const models = (loaded: number | null) => ({ models: [{ key: "qwen/qwen3.8-27b", type: "llm", loaded_instances: loaded === null ? [] : [{ id: "q", config: { context_length: loaded } }] }] });
    const ask = (route: ReturnType<typeof createLocalClaudeRoute>) =>
      route.messages(post({ authorization: "Bearer s3cret", "x-nav-local-model": "lmstudio/qwen/qwen3.8-27b" }, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }, { role: "system", content: "note" }] }));
    it("goes to LM Studio on 127.0.0.1:1234 with LM Studio's own key and the repaired messages", async () => {
      const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/v1/models") ? new Response(JSON.stringify(models(65536))) : new Response("event: message_start\n\n", { headers: { "content-type": "text/event-stream" } })));
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch }));
      expect(res.status).toBe(200);
      const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:1234/v1/messages");
      const sent = JSON.parse(String(init.body));
      expect(sent.model).toBe("qwen/qwen3.8-27b");
      expect(sent.messages.some((m: { role: string }) => m.role === "system")).toBe(false);
    });
    it("refuses with a readable reason when LM Studio is not running, the model is not loaded, or its window is too small", async () => {
      const down = createLocalClaudeRoute({ secret: () => "s3cret", fetch: (async () => { throw new Error("refused"); }) as unknown as typeof globalThis.fetch });
      const a = await ask(down);
      expect(a.status).toBe(503);
      expect((await a.json()).error.message).toMatch(/LM Studio is not running/);
      const notLoaded = vi.fn(async () => new Response(JSON.stringify(models(null))));
      const b = await ask(createLocalClaudeRoute({ secret: () => "s3cret", fetch: notLoaded as unknown as typeof globalThis.fetch }));
      expect(b.status).toBe(400);
      expect((await b.json()).error.message).toMatch(/not loaded in LM Studio.*lms load qwen\/qwen3.8-27b --context-length 65536/);
      const small = vi.fn(async () => new Response(JSON.stringify(models(4096))));
      const c = await ask(createLocalClaudeRoute({ secret: () => "s3cret", fetch: small as unknown as typeof globalThis.fetch }));
      expect(c.status).toBe(400);
      expect((await c.json()).error.message).toMatch(/4,096-token window and Claude Code needs 65,536/);
      expect(small).toHaveBeenCalledTimes(1); // nothing reached /v1/messages
    });
    it("puts LM Studio's token counts the Anthropic way, so a chat does not look twice its size", async () => {
      // As LM Studio 0.4.21 answers a prompt it has cached: input_tokens is the whole prompt.
      const start = `data: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: 4316, output_tokens: 0, cache_read_input_tokens: 4312 } } })}\n\n`;
      const text = `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cache_read_input_tokens stays as written" } })}\n\n`;
      const delta = `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 4316, output_tokens: 3, cache_read_input_tokens: 4312 } })}\n\n`;
      const sse = "event: message_start\n" + start + "event: content_block_delta\n" + text + "event: message_delta\n" + delta;
      // Split in the middle of a line, as a network read can.
      const cut = sse.indexOf("4316") + 2;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse.slice(0, cut)));
          c.enqueue(new TextEncoder().encode(sse.slice(cut)));
          c.close();
        },
      });
      const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/v1/models") ? new Response(JSON.stringify(models(65536))) : new Response(stream, { headers: { "content-type": "text/event-stream" } })));
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch }));
      const out = await res.text();
      const events = out.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
      expect(events[0].message.usage).toEqual({ input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 4312 });
      expect(events[1].delta.text).toBe("cache_read_input_tokens stays as written");
      expect(events[2].usage).toEqual({ input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 4312 });
      expect(out.split("\n").filter((l) => l.startsWith("event:"))).toEqual(["event: message_start", "event: content_block_delta", "event: message_delta"]);
      // A whole (not streamed) answer too, and a first answer with nothing cached is left alone.
      const whole = vi.fn(async (url: string) =>
        String(url).endsWith("/api/v1/models") ? new Response(JSON.stringify(models(65536))) : new Response(JSON.stringify({ type: "message", usage: { input_tokens: 4316, output_tokens: 3, cache_read_input_tokens: 4312 } }), { headers: { "content-type": "application/json" } }),
      );
      expect((await (await ask(createLocalClaudeRoute({ secret: () => "s3cret", fetch: whole as unknown as typeof globalThis.fetch }))).json()).usage).toEqual({ input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 4312 });
      expect(fixLmStudioEventLine(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 4316, cache_read_input_tokens: 0 } } })}`)).toContain('"input_tokens":4316');
    });
    it("leaves Ollama's answers exactly as Ollama sent them (its counts already add up)", async () => {
      const body = `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 19385 } } })}\n\n`;
      const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/tags") ? new Response(JSON.stringify({ models: [{ name: "qwen:27b" }] })) : new Response(body, { headers: { "content-type": "text/event-stream" } })));
      const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch });
      const res = await route.messages(post({ authorization: "Bearer s3cret", "x-nav-local-model": "qwen:27b" }, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
      expect(await res.text()).toBe(body);
    });
    it("says LM Studio wants an API token (not that it is not running) when it answers 401", async () => {
      const token = vi.fn(async () => new Response(JSON.stringify({ error: { message: "API token required" } }), { status: 401 }));
      const log = vi.fn();
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", fetch: token as unknown as typeof globalThis.fetch, log }));
      expect(res.status).toBe(400);
      const message = (await res.json()).error.message;
      expect(message).toMatch(/LM Studio asks for an API token.*Require Authentication/);
      expect(message).not.toMatch(/not running/);
      expect(token).toHaveBeenCalledTimes(1); // nothing reached /v1/messages
      expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/answered 400 \(invalid_request_error\) for model "lmstudio\/qwen\/qwen3.8-27b": LM Studio asks for an API token/));
    });
  });
  it("forwards a bare model name as Ollama's name:latest", async () => {
    const latest = () => new Response(JSON.stringify({ models: [{ name: "qwen:latest" }] }));
    const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/tags") ? latest() : new Response("event: message_start\n\n", { headers: { "content-type": "text/event-stream" } })));
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch });
    const res = await route.messages(post({ authorization: "Bearer s3cret", "x-nav-local-model": "qwen" }, { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("qwen:latest");
  });
  it("forwards to Ollama on 127.0.0.1 only, with the repaired request, and streams the answer back", async () => {
    const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/tags") ? tags() : new Response("event: message_start\n\n", { headers: { "content-type": "text/event-stream" } })));
    const route = createLocalClaudeRoute({ secret: () => "s3cret", fetch: fetch as unknown as typeof globalThis.fetch });
    const res = await route.messages(
      post({ authorization: "Bearer s3cret", "x-nav-local-model": "qwen:27b" }, { model: "claude-haiku-4-5", stream: true, messages: [{ role: "user", content: "hi" }, { role: "system", content: "note" }] }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toContain("message_start");
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/messages");
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe("qwen:27b");
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "note" }] }]);
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });
});

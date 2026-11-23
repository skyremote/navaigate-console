// The Local route's long-answer behaviour: no time limit on the runner's answer (node:http), Anthropic
// ping events while the runner is silent, and stopping that still reaches the runner at once.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_MEMORY_MS, createLocalClaudeRoute, httpPost, lmStudioUsageStream, PING_EVENT, withPings } from "../server-local-claude";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sse = (ev: string, data: unknown) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
const ANSWER =
  sse("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1 } } }) +
  sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }) +
  sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
  sse("message_stop", { type: "message_stop" });

/** A stream fed by hand, so a test decides when each piece arrives. */
function handFed() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    cancel: cancelled,
  });
  return { stream, send: (s: string) => ctl.enqueue(enc.encode(s)), close: () => ctl.close(), cancelled };
}
/** Reads a stream into a string as it comes, so a test can look at what has arrived so far. */
function collect(stream: ReadableStream<Uint8Array>) {
  const got = { text: "", done: false };
  const reader = stream.getReader();
  const pump = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      got.text += dec.decode(r.value);
    }
    got.done = true;
  })();
  return { got, pump, reader };
}
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("withPings", () => {
  afterEach(() => vi.useRealTimers());

  it("sends a ping every 30 s while the runner is silent before its first event, then passes the answer on unchanged", async () => {
    vi.useFakeTimers();
    const src = handFed();
    const onEnd = vi.fn();
    const { got, pump } = collect(withPings(src.stream, { onEnd }));
    await tick(29_999);
    expect(got.text).toBe("");
    await tick(1);
    expect(got.text).toBe(PING_EVENT);
    await tick(65_000);
    expect(got.text).toBe(PING_EVENT.repeat(3));
    src.send(ANSWER);
    src.close();
    await tick(0);
    await pump;
    expect(got.text).toBe(PING_EVENT.repeat(3) + ANSWER);
    expect(onEnd).toHaveBeenCalledWith(3);
  });

  it("never puts a ping inside an event: a runner silent in the middle of one gets none until the event ends", async () => {
    vi.useFakeTimers();
    const src = handFed();
    const { got, pump } = collect(withPings(src.stream));
    const first = sse("message_start", { type: "message_start", message: { id: "m" } });
    src.send(first + "event: content_block_delta\ndata: {\"type\":");
    await tick(0);
    await tick(120_000);
    expect(got.text).toBe(first + "event: content_block_delta\ndata: {\"type\":");
    src.send('"content_block_delta"}\n');
    await tick(60_000);
    expect(got.text).not.toContain("ping"); // one newline: still inside the event
    src.send("\n");
    await tick(0);
    await tick(30_000);
    expect(got.text.endsWith('"content_block_delta"}\n\n' + PING_EVENT)).toBe(true);
    src.close();
    await pump;
  });

  it("counts a blank line split across two pieces, and CRLF line ends, as the end of an event", async () => {
    vi.useFakeTimers();
    for (const [a, b] of [
      ["event: x\ndata: {}\n", "\n"],
      ["event: x\r\ndata: {}\r\n", "\r\n"],
    ]) {
      const src = handFed();
      const { got, pump } = collect(withPings(src.stream));
      src.send(a);
      src.send(b);
      await tick(0);
      await tick(30_000);
      expect(got.text).toBe(a + b + PING_EVENT);
      src.close();
      await pump;
    }
  });

  it("passes a fast answer through byte for byte, with no ping and in the same pieces", async () => {
    vi.useFakeTimers();
    const pieces = [ANSWER.slice(0, 7), ANSWER.slice(7, 200), ANSWER.slice(200)];
    const src = handFed();
    const out = withPings(src.stream);
    const reader = out.getReader();
    const seen: string[] = [];
    for (const p of pieces) {
      src.send(p);
      await tick(1_000);
      seen.push(dec.decode((await reader.read()).value));
    }
    src.close();
    expect((await reader.read()).done).toBe(true);
    expect(seen).toEqual(pieces);
  });

  it("does not stall on an empty piece from the runner: it reads on to the next piece with bytes", async () => {
    vi.useFakeTimers();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const src = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    const { got, pump } = collect(withPings(src));
    ctl.enqueue(new Uint8Array(0));
    ctl.enqueue(new Uint8Array(0));
    await tick(0);
    ctl.enqueue(enc.encode(ANSWER));
    ctl.close();
    await tick(0);
    await pump;
    expect(got.text).toBe(ANSWER);
  });

  it("stops its timer, without throwing, when the stream can no longer take a ping", async () => {
    vi.useFakeTimers();
    const src = handFed();
    const onEnd = vi.fn();
    const out = withPings(src.stream, { onEnd });
    const reader = out.getReader();
    void reader.read().catch(() => undefined); // waiting on the runner
    // The stream refuses new pieces (as a closed or errored stream does) when the ping is due.
    const proto = ReadableStreamDefaultController.prototype as unknown as { enqueue: (c: unknown) => void };
    const real = proto.enqueue;
    proto.enqueue = () => {
      throw new TypeError("closed");
    };
    try {
      await tick(30_000);
    } finally {
      proto.enqueue = real;
    }
    expect(onEnd).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts silence only while it waits for the runner, not while the reader is slow", async () => {
    vi.useFakeTimers();
    const src = handFed();
    const out = withPings(src.stream);
    const reader = out.getReader();
    src.send(ANSWER);
    // Nobody reads for two minutes: the stream is not waiting on the runner, so no ping is made.
    await tick(120_000);
    expect(dec.decode((await reader.read()).value)).toBe(ANSWER);
    src.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("cancelling the result cancels the runner's stream at once and stops the pings", async () => {
    vi.useFakeTimers();
    const src = handFed();
    const onEnd = vi.fn();
    const out = withPings(src.stream, { onEnd });
    const reader = out.getReader();
    const pending = reader.read();
    await tick(30_000);
    expect(dec.decode((await pending).value)).toBe(PING_EVENT);
    await reader.cancel("caller went away");
    expect(src.cancelled).toHaveBeenCalledWith("caller went away");
    expect(onEnd).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps LM Studio's token fix and pings apart: a ping only after the fixed line is whole", async () => {
    vi.useFakeTimers();
    const src = handFed();
    const { got, pump } = collect(withPings(src.stream.pipeThrough(lmStudioUsageStream())));
    const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 90 } } })}\n\n`;
    src.send(start.slice(0, 40));
    await tick(0);
    await tick(60_000);
    expect(got.text).not.toContain("ping");
    src.send(start.slice(40));
    await tick(0);
    await tick(30_000);
    expect(got.text).toContain('"input_tokens":10');
    expect(got.text.endsWith("\n\n" + PING_EVENT)).toBe(true);
    src.close();
    await pump;
  });
});

/** A runner stand-in on 127.0.0.1: records what happens to each connection. */
async function fakeRunner(handler: (req: http.IncomingMessage, res: http.ServerResponse, events: string[]) => void) {
  const events: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      events.push(`request ${req.method} ${req.url} ${raw.length}`);
      res.on("close", () => events.push(`closed finished=${res.writableFinished}`));
      handler(req, res, events);
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, events, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
const waitFor = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("httpPost (node:http, no time limit)", () => {
  it("speaks TLS to an https:// origin (an OLLAMA_HOST on this Mac may name one), as fetch does, instead of failing on the protocol", async () => {
    const net = await import("node:net");
    for (const [scheme, first] of [["https", 0x16], ["http", "P".charCodeAt(0)]] as const) {
      let seen = -1;
      const server = net.createServer((sock) => sock.once("data", (d) => { seen = d[0]; sock.destroy(); }));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;
      await httpPost(`${scheme}://127.0.0.1:${port}/v1/messages`, { headers: {}, body: "{}", signal: new AbortController().signal }).then(
        () => undefined,
        (e: NodeJS.ErrnoException) => expect(e.code).not.toBe("ERR_INVALID_PROTOCOL"),
      );
      await new Promise<void>((r) => server.close(() => r()));
      expect(seen).toBe(first); // 0x16: a TLS handshake; "P": a plain POST
    }
  });
  it("streams the answer as it comes, with the runner's status and headers", async () => {
    const runner = await fakeRunner((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(ANSWER.slice(0, 50));
      setTimeout(() => res.end(ANSWER.slice(50)), 50);
    });
    try {
      const res = await httpPost(`${runner.base}/v1/messages`, { headers: { "content-type": "application/json" }, body: '{"a":1}', signal: new AbortController().signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(await res.text()).toBe(ANSWER);
      expect(runner.events[0]).toBe("request POST /v1/messages 7");
    } finally {
      await runner.close();
    }
  });

  it("closes the connection to the runner at once when the caller's signal stops it, before or during the answer", async () => {
    const runner = await fakeRunner((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders(); // then silent, as LM Studio is while it reads a prompt
    });
    try {
      const stop = new AbortController();
      const res = await httpPost(`${runner.base}/v1/messages`, { headers: {}, body: "{}", signal: stop.signal });
      const reading = res.text().catch((e: unknown) => e);
      stop.abort();
      await waitFor(() => runner.events.some((e) => e.startsWith("closed")));
      expect(runner.events.at(-1)).toBe("closed finished=false");
      expect(await reading).toBeInstanceOf(Error);
      // Stopped before the runner's headers: the promise is refused and the connection closed too.
      const late = await fakeRunner(() => undefined);
      try {
        const stop2 = new AbortController();
        const pending = httpPost(`${late.base}/v1/messages`, { headers: {}, body: "{}", signal: stop2.signal });
        await waitFor(() => late.events.length > 0);
        stop2.abort();
        await expect(pending).rejects.toBeInstanceOf(Error);
        await waitFor(() => late.events.some((e) => e.startsWith("closed")));
      } finally {
        await late.close();
      }
    } finally {
      await runner.close();
    }
  });

  it("closes the connection to the runner when the answer's reader cancels it", async () => {
    const runner = await fakeRunner((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hello\n\n");
    });
    try {
      const res = await httpPost(`${runner.base}/v1/messages`, { headers: {}, body: "{}", signal: new AbortController().signal });
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      await waitFor(() => runner.events.some((e) => e.startsWith("closed")));
      expect(runner.events.at(-1)).toBe("closed finished=false");
    } finally {
      await runner.close();
    }
  });

  it("refuses when the runner is not there, and passes an error status and body on", async () => {
    await expect(httpPost("http://127.0.0.1:9/v1/messages", { headers: {}, body: "{}", signal: new AbortController().signal })).rejects.toBeInstanceOf(Error);
    const runner = await fakeRunner((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"type":"error"}');
    });
    try {
      const res = await httpPost(`${runner.base}/v1/messages`, { headers: {}, body: "{}", signal: new AbortController().signal });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('{"type":"error"}');
    } finally {
      await runner.close();
    }
  });
});

describe("the route with node:http to an Ollama stand-in", () => {
  const ask = (route: ReturnType<typeof createLocalClaudeRoute>, signal?: AbortSignal) =>
    route.messages(
      new Request("http://x/local/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret", "x-nav-local-model": "qwen:27b" },
        body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
        signal,
      }),
    );
  // ps: what /api/ps lists (the route reads it to tell whether the runner's state changed since a failure).
  const ollama = (answer: (res: http.ServerResponse) => void, ps: () => unknown[] = () => []) =>
    fakeRunner((req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen:27b" }] }));
      } else if (req.url === "/api/ps") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: ps() }));
      } else answer(res);
    });

  it("hands a fast answer to Claude Code exactly as the runner sent it, with no ping", async () => {
    const runner = await ollama((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(ANSWER);
    });
    try {
      const log = vi.fn();
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, log }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(ANSWER);
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("keep-alive");
    } finally {
      await runner.close();
    }
  });

  it("pings while the runner is silent and closes the runner's connection at once when Claude Code goes away", async () => {
    const runner = await ollama((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
    });
    try {
      const log = vi.fn();
      const caller = new AbortController();
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, log, pingEveryMs: 40 }), caller.signal);
      const reader = res.body!.getReader();
      expect(dec.decode((await reader.read()).value)).toBe(PING_EVENT);
      expect(dec.decode((await reader.read()).value)).toBe(PING_EVENT);
      const before = runner.events.filter((e) => e.startsWith("closed")).length; // the model list's own request
      caller.abort();
      await waitFor(() => runner.events.filter((e) => e.startsWith("closed")).length > before);
      expect(runner.events.at(-1)).toBe("closed finished=false");
      await reader.cancel().catch(() => undefined);
      expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/qwen:27b was silent for a while: \d+ keep-alive pings sent/));
    } finally {
      await runner.close();
    }
  });
});

describe("a runner that holds its headers (sends nothing until its first word)", () => {
  const ask = (route: ReturnType<typeof createLocalClaudeRoute>, stream = true, signal?: AbortSignal) =>
    route.messages(
      new Request("http://x/local/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer s3cret", "x-nav-local-model": "qwen:27b" },
        body: JSON.stringify({ model: "claude-opus-5-5", stream, messages: [{ role: "user", content: "hi" }] }),
        signal,
      }),
    );
  // ps: what /api/ps lists (the route reads it to tell whether the runner's state changed since a failure).
  const ollama = (answer: (res: http.ServerResponse) => void, ps: () => unknown[] = () => []) =>
    fakeRunner((req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "qwen:27b" }] }));
      } else if (req.url === "/api/ps") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: ps() }));
      } else answer(res);
    });

  it("answers 200 itself after the wait, pings, then passes the runner's answer on", async () => {
    const runner = await ollama((res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(ANSWER);
      }, 150);
    });
    try {
      const log = vi.fn();
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, log, earlyHeadersMs: 20, pingEveryMs: 40 }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const text = await res.text();
      expect(text.startsWith(PING_EVENT)).toBe(true);
      expect(text.endsWith(ANSWER)).toBe(true);
      expect(text.replaceAll(PING_EVENT, "")).toBe(ANSWER);
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContainEqual(expect.stringMatching(/Ollama has not answered after \d+ s; Claude Code is kept waiting with pings/));
    } finally {
      await runner.close();
    }
  });

  it("turns a late error from the runner into Anthropic's error event, and logs only its status and type", async () => {
    const runner = await ollama((res) => {
      setTimeout(() => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt too long: secret plans" } }));
      }, 80);
    });
    try {
      const log = vi.fn();
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, log, earlyHeadersMs: 20, pingEveryMs: 1_000 }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe(PING_EVENT + `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt too long: secret plans" } })}\n\n`);
      const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(lines).toContain('answered 400 (from Ollama, invalid_request_error) for model "qwen:27b", as an error event');
      expect(lines).not.toContain("secret plans");
    } finally {
      await runner.close();
    }
  });

  it("sends a late overloaded error as api_error, the type after which Claude Code does not stream the request again", async () => {
    const runner = await ollama((res) => {
      setTimeout(() => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }));
      }, 80);
    });
    try {
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 20, pingEveryMs: 1_000 }));
      expect(await res.text()).toBe(PING_EVENT + `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "busy" } })}\n\n`);
    } finally {
      await runner.close();
    }
  });

  it("passes only invalid_request_error and not_found_error as a late error's type; any other is api_error", async () => {
    for (const [type, sent] of [["rate_limit_error", "api_error"], ["permission_error", "api_error"], ["not_found_error", "not_found_error"]] as const) {
      const runner = await ollama((res) => {
        setTimeout(() => {
          res.writeHead(type === "not_found_error" ? 404 : 400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type, message: "m" } }));
        }, 80);
      });
      try {
        const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 20, pingEveryMs: 1_000 }));
        expect(await res.text()).toContain(`"type":"${sent}"`);
      } finally {
        await runner.close();
      }
    }
  });

  it("remembers a request the runner failed and answers identical repeats itself for two minutes, saying so; 503 is never remembered", async () => {
    let reached = 0;
    let status = 500;
    let loaded: unknown[] = [];
    const runner = await ollama(
      (res) => {
        reached++;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "out of memory" } }));
      },
      () => loaded,
    );
    try {
      let t = 0;
      const route = createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 2_000, now: () => t });
      const first = await ask(route);
      expect(first.status).toBe(400);
      expect(((await first.json()) as { error: { message: string } }).error.message).toBe("Ollama answered 500: out of memory");
      // Claude Code's repeats: streamed again, then whole. Answered from memory; the runner is not asked.
      for (const streamed of [true, false, false, false]) {
        const again = await ask(route, streamed);
        expect(again.status).toBe(400);
        expect(((await again.json()) as { error: { message: string } }).error.message).toBe("Ollama refused this a moment ago, so it was not sent again: out of memory. Send again in half a minute, or change your message, to try once more.");
      }
      expect(reached).toBe(1);
      // The runner's state for the model changes (it was loaded since): the same request goes to it again.
      loaded = [{ name: "qwen:27b", size: 1, size_vram: 1 }];
      await (await ask(route)).text();
      expect(reached).toBe(2);
      // That new failure is remembered with the new state: an identical repeat is answered from memory.
      await (await ask(route)).text();
      expect(reached).toBe(2);
      // After two minutes the same request goes to the runner again.
      t += FAILURE_MEMORY_MS;
      await (await ask(route)).text();
      expect(reached).toBe(3);
      // 503: passed as it is, every time.
      status = 503;
      const busy = createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 2_000 });
      expect((await ask(busy)).status).toBe(503);
      expect((await ask(busy)).status).toBe(503);
      expect(reached).toBe(5);
    } finally {
      await runner.close();
    }
  });

  it("after a runner 500, a request with the same prompt but another max_tokens or effort, or a new chat's own first request, goes to the runner", async () => {
    // The auditor's case: the memory must not hide a recovery.
    let hits = 0;
    const runner = await ollama((res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "model requires more system memory" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }] }));
    });
    try {
      const route = createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 2_000 });
      const send = (extra: Record<string, unknown>) =>
        route.messages(
          new Request("http://x/local/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer s3cret", "x-nav-local-model": "qwen:27b" },
            body: JSON.stringify({ model: "x", stream: false, system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: "hello" }], ...extra }),
          }),
        );
      const first = await send({ max_tokens: 100, metadata: { user_id: "session-a" } });
      expect(first.status).toBe(400);
      expect(((await first.json()) as { error: { message: string } }).error.message).toBe("Ollama answered 500: model requires more system memory");
      const tokens = await send({ max_tokens: 4000, metadata: { user_id: "session-a" } });
      expect(tokens.status).toBe(200);
      const effort = await send({ max_tokens: 100, output_config: { effort: "low" }, metadata: { user_id: "session-a" } });
      expect(effort.status).toBe(200);
      const newChat = await send({ max_tokens: 100, metadata: { user_id: "session-b" } });
      expect(newChat.status).toBe(200);
      expect(hits).toBe(4);
    } finally {
      await runner.close();
    }
  });

  it("sends a changed request on to the runner, even right after a failure", async () => {
    let reached = 0;
    const runner = await ollama((res) => {
      reached++;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "x" } }));
    });
    try {
      const route = createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 2_000 });
      const send = (text: string) =>
        route.messages(new Request("http://x/local/v1/messages", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer s3cret", "x-nav-local-model": "qwen:27b" }, body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: text }] }) }));
      await (await send("one")).text();
      await (await send("two")).text();
      expect(reached).toBe(2);
    } finally {
      await runner.close();
    }
  });

  it("after a late error, Claude Code's whole-request repeat is answered from memory, not read again", async () => {
    let reached = 0;
    const runner = await ollama((res) => {
      reached++;
      setTimeout(() => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "model failed to load" } }));
      }, 80);
    });
    try {
      const route = createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 20, pingEveryMs: 1_000 });
      const late = await ask(route);
      expect(late.status).toBe(200);
      expect(await late.text()).toContain("event: error");
      const whole = await ask(route, false);
      expect(whole.status).toBe(400);
      expect(((await whole.json()) as { error: { message: string } }).error.message).toBe("Ollama refused this a moment ago, so it was not sent again: model failed to load. Send again in half a minute, or change your message, to try once more.");
      expect(reached).toBe(1);
    } finally {
      await runner.close();
    }
  });

  it("keeps the runner's own status when it answers within the wait, and never answers early for a whole (not streamed) request", async () => {
    const quick = await ollama((res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"overloaded_error","message":"x"}}');
    });
    try {
      expect((await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: quick.base, earlyHeadersMs: 2_000 }))).status).toBe(503);
    } finally {
      await quick.close();
    }
    const slowWhole = await ollama((res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"type":"message","content":[{"type":"text","text":"OK"}]}');
      }, 120);
    });
    try {
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: slowWhole.base, earlyHeadersMs: 20 }), false);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.text()).toBe('{"type":"message","content":[{"type":"text","text":"OK"}]}');
    } finally {
      await slowWhole.close();
    }
  });

  it("closes the runner's connection at once when Claude Code goes away while the runner still holds its headers", async () => {
    const runner = await ollama(() => undefined);
    try {
      const res = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 20, pingEveryMs: 1_000 }));
      const reader = res.body!.getReader();
      expect(dec.decode((await reader.read()).value)).toBe(PING_EVENT);
      const before = runner.events.filter((e) => e.startsWith("closed")).length;
      await reader.cancel();
      await waitFor(() => runner.events.filter((e) => e.startsWith("closed")).length > before);
      expect(runner.events.at(-1)).toBe("closed finished=false");
      // And by the caller's signal alone.
      const other = new AbortController();
      const third = await ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 20, pingEveryMs: 1_000 }), true, other.signal);
      const r3 = third.body!.getReader();
      await r3.read();
      const before3 = runner.events.filter((e) => e.startsWith("closed")).length;
      other.abort();
      await waitFor(() => runner.events.filter((e) => e.startsWith("closed")).length > before3);
      await r3.cancel().catch(() => undefined);
      // Stopped before the runner's headers, inside the wait: logged as stopped, not as the runner failing.
      const log = vi.fn();
      const fourth = new AbortController();
      const asked = runner.events.filter((e) => e.startsWith("request POST /v1")).length;
      const pending = ask(createLocalClaudeRoute({ secret: () => "s3cret", ollama: runner.base, earlyHeadersMs: 5_000, log }), true, fourth.signal);
      await waitFor(() => runner.events.filter((e) => e.startsWith("request POST /v1")).length > asked);
      fourth.abort();
      await pending;
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContainEqual("local claude: qwen:27b: stopped by Claude Code before Ollama answered");
      expect(lines.join("\n")).not.toContain("did not answer");
    } finally {
      await runner.close();
    }
  });
});

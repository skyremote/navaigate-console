// Local models in memory: what the server reports from Ollama, a load that
// returns at once, and an unload that waits for Ollama's answer.
import { describe, expect, it, vi } from "vitest";
import { ALL_OLLAMA, TOOLS_FAILED_REASON, failedToolFamily, LMSTUDIO_LOAD_MIN_MEMORY, LMSTUDIO_SMALL_MEMORY_REASON, LMSTUDIO_TOKEN_REASON, OLLAMA_ELSEWHERE_REASON, createLocalModels, isRemoteModel, ollamaBaseFrom, lmStudioReady, localModelInput, numCtxFromParameters, ollamaName, toolSupportFromShow, trainedContext } from "../server-local-models";

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

describe("local models in memory", () => {
  it("reports what Ollama holds, with the ollama/ prefix the orb uses", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (!String(url).includes("11434")) throw new Error("no LM Studio");
      return json({ models: [{ name: "qwen:27b", size: 18_500_000_000, expires_at: "2026-11-16T17:00:00Z" }] });
    });
    const state = await createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch }).state();
    expect(state).toEqual({
      reachable: true,
      lmStudio: { reachable: false, reason: "LM Studio is not running" },
      loaded: [{ model: "ollama/qwen:27b", bytes: 18_500_000_000, until: "2026-11-16T17:00:00Z" }],
      loading: [],
      failed: [],
    });
  });

  it("reports each runtime on its own: LM Studio answering does not make Ollama reachable", async () => {
    const lmOnly = vi.fn(async (url: string) => {
      if (String(url).includes("11434")) throw new Error("ECONNREFUSED");
      return json({ models: [{ key: "qwen/qwen3.8-27b", size_bytes: 17_000_000_000, loaded_instances: [{ id: "q" }] }] });
    });
    const a = await createLocalModels({ fetch: lmOnly as unknown as typeof globalThis.fetch }).state();
    expect(a.reachable).toBe(false);
    expect(a.lmStudio).toEqual({ reachable: true });
    expect(a.loaded).toEqual([{ model: "lmstudio/qwen/qwen3.8-27b", bytes: 17_000_000_000, until: null }]);
    const token = vi.fn(async (url: string) => (String(url).includes("11434") ? json({ models: [] }) : json({ error: "unauthorised" }, false, 401)));
    const b = await createLocalModels({ fetch: token as unknown as typeof globalThis.fetch }).state();
    expect(b.reachable).toBe(true);
    expect(b.lmStudio).toEqual({ reachable: false, reason: LMSTUDIO_TOKEN_REASON });
  });

  it("says Ollama is unreachable instead of throwing", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const state = await createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch }).state();
    expect(state.reachable).toBe(false);
    expect(state.loaded).toEqual([]);
  });

  it("starts a load without waiting for it, and shows it as loading until Ollama lists it", async () => {
    let finish: (r: Response) => void = () => {};
    const fetch = vi.fn(async (url: string) =>
      String(url).endsWith("/api/ps") ? json({ models: [] }) : String(url).endsWith("/api/v1/models") ? json({ models: [] }) : new Promise<Response>((r) => (finish = r)),
    );
    const models = createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await models.load("ollama/deepseek:14b")).toEqual({ ok: true });
    const sent = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent).toMatchObject({ model: "deepseek:14b", keep_alive: "30m", stream: false });
    expect(sent.prompt).toBeUndefined();
    expect((await models.state()).loading).toEqual(["ollama/deepseek:14b"]);
    finish(json({}));
    await new Promise((r) => setTimeout(r, 0));
    expect((await models.state()).loading).toEqual([]);
  });

  it("keeps the reason when a load fails", async () => {
    const fetch = vi.fn(async (url: string) => (String(url).endsWith("/api/ps") ? json({ models: [] }) : json({ error: "model requires more system memory" }, false, 500)));
    const warn = vi.fn();
    const models = createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch, warn });
    await models.load("ollama/qwen:27b");
    await new Promise((r) => setTimeout(r, 0));
    expect((await models.state()).failed).toEqual([{ model: "ollama/qwen:27b", reason: "model requires more system memory" }]);
    expect(warn).toHaveBeenCalled();
  });

  it("unloads with keep_alive 0 and reports a refusal", async () => {
    const fetch = vi.fn(async () => json({}));
    const models = createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await models.unload("ollama/qwen:27b")).toEqual({ ok: true });
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ model: "qwen:27b", keep_alive: 0 });
    const refusing = createLocalModels({ fetch: (async () => json({ error: "no such model" }, false, 404)) as unknown as typeof globalThis.fetch });
    expect(await refusing.unload("ollama/nope")).toEqual({ ok: false, reason: "no such model" });
  });

  it("accepts only Ollama and LM Studio model ids", () => {
    expect(localModelInput.safeParse({ model: "ollama/hf.co/example-org/Example-Qwen3.8-27B-GGUF:UD-Q4_K_XL" }).success).toBe(true);
    expect(localModelInput.safeParse({ model: "lmstudio/qwen/qwen3.8-27b" }).success).toBe(true);
    expect(localModelInput.safeParse({ model: "opencode/big-pickle" }).success).toBe(false);
    expect(localModelInput.safeParse({ model: "ollama/x; rm -rf ~" }).success).toBe(false);
  });
});

// Real template excerpts as Ollama 0.40.16 reports them (21 Nov 2026).
const QWEN_JINJA = "{%- if tools and tools is iterable and tools is not mapping %}\n    {{- '<|im_start|>system\\n' }}{%- for tool in tools %}{{ tool | tojson }}{%- endfor %}";
const DEEPSEEK_JINJA = "{%- for message in messages %}{%- if message['role'] == 'assistant' and message['content'] is none %}{%- for tool in message['tool_calls']%}{{'<｜tool▁call▁begin｜>' + tool['function']['name']}}{%- endfor %}{%- endif %}{%- endfor %}";
const GO_TEMPLATE = "{{- if .Tools }}<tools>{{ range .Tools }}{{ . }}{{ end }}</tools>{{ end }}{{ .Prompt }}";

describe("whether a local model can call tools", () => {
  it("yes when Ollama lists tools and the template passes the tool list (Jinja or Go)", () => {
    expect(toolSupportFromShow({ capabilities: ["completion", "tools"], template: QWEN_JINJA }).tools).toBe(true);
    expect(toolSupportFromShow({ capabilities: ["tools"], template: GO_TEMPLATE }).tools).toBe(true);
  });
  it("yes when Ollama renders the tools itself", () => {
    expect(toolSupportFromShow({ capabilities: ["tools"], template: "{{ .Prompt }}", renderer: "qwen3-coder" }).tools).toBe(true);
  });
  it("no when the capability is listed but the template never shows the model a tool (DeepSeek R1 14B)", () => {
    const r = toolSupportFromShow({ capabilities: ["tools", "thinking", "completion"], template: DEEPSEEK_JINJA });
    expect(r.tools).toBe(false);
    expect(r.reason).toMatch(/never shows it the tools/);
  });
  it("no when Ollama does not list the capability", () => {
    expect(toolSupportFromShow({ capabilities: ["completion"], template: QWEN_JINJA }).tools).toBe(false);
    expect(toolSupportFromShow({}).tools).toBe(false);
  });
  const ollama = (modified: { at: string }, calls: string[]) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url).replace(/^.*11434/, "") + (init?.body ? ` ${String(init.body)}` : ""));
      if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen:27b", modified_at: modified.at }] }));
      return new Response(JSON.stringify({ capabilities: ["tools"], template: QWEN_JINJA, parameters: "num_ctx 65536" }));
    });
  it("asks Ollama's /api/show with the bare name, and says unknown when Ollama does not answer", async () => {
    const calls: string[] = [];
    const models = createLocalModels({ fetch: ollama({ at: "t1" }, calls) as unknown as typeof globalThis.fetch });
    expect((await models.tools("ollama/qwen:27b")).tools).toBe(true);
    expect(calls).toEqual(["/api/tags", '/api/show {"model":"qwen:27b"}']);
    const down = createLocalModels({ fetch: (async () => { throw new Error("refused"); }) as unknown as typeof globalThis.fetch });
    expect(await down.tools("ollama/qwen:27b")).toEqual({ tools: null, reason: "Ollama did not answer" });
  });
  it("answers from its cache while the model is unchanged, and checks again after a re-pull", async () => {
    const calls: string[] = [];
    const modified = { at: "t1" };
    const models = createLocalModels({ fetch: ollama(modified, calls) as unknown as typeof globalThis.fetch });
    await models.tools("ollama/qwen:27b");
    await models.tools("ollama/qwen:27b");
    expect(calls.filter((c) => c.startsWith("/api/show"))).toHaveLength(1);
    modified.at = "t2";
    await models.tools("ollama/qwen:27b");
    expect(calls.filter((c) => c.startsWith("/api/show"))).toHaveLength(2);
    expect(await models.tools("ollama/gone:1b")).toEqual({ tools: null, reason: "Ollama does not list this model" });
  });
});

describe("model families that failed our own tool tests", () => {
  it("are matched on the family after the runner's prefix, whatever the size or variant", () => {
    for (const id of ["ollama/deepseek-r1:14b", "ollama/deepseek-r1:latest", "ollama/deepseek-r1-tuned-64k:14b", "lmstudio/deepseek/deepseek-r1-0528-qwen3-8b", "lmstudio/deepseek-r1-distill-qwen-14b", "deepseek-r1"])
      expect(failedToolFamily(id)).toBe("deepseek-r1");
    for (const id of ["ollama/qwen:27b", "ollama/deepseek-v3:8b", "ollama/deepseek-r10:1b", "lmstudio/qwen/qwen3.8-27b", "ollama/mydeepseek-r1x:1b"]) expect(failedToolFamily(id)).toBeNull();
  });
  it("are not offered Claude Code even when the template passes the check, and say why in plain words, asking the runner nothing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ capabilities: ["tools"], template: QWEN_JINJA, parameters: "num_ctx 65536" })));
    const models = createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await models.tools("ollama/deepseek-r1:14b")).toEqual({ tools: false, why: "family", reason: TOOLS_FAILED_REASON });
    expect(await models.tools("lmstudio/deepseek/deepseek-r1-0528-qwen3-8b")).toEqual({ tools: false, why: "family", reason: TOOLS_FAILED_REASON });
    expect(fetch).not.toHaveBeenCalled();
    expect(TOOLS_FAILED_REASON).toBe("Claude Code is not offered for DeepSeek R1 models: two 14B versions did not use tools dependably in our tests, and other versions were not tried. This one runs as a chat model in opencode.");
  });
});

describe("Ollama's own name for a model", () => {
  it("matches exactly, and a bare name also matches name:latest", () => {
    const listed = ["qwen:latest", "qwen3.8-64k:27b", "hf.co/x/y:Q4"];
    expect(ollamaName(listed, "ollama/qwen")).toBe("qwen:latest");
    expect(ollamaName(listed, "qwen")).toBe("qwen:latest");
    expect(ollamaName(listed, "ollama/qwen3.8-64k:27b")).toBe("qwen3.8-64k:27b");
    expect(ollamaName(listed, "hf.co/x/y:Q4")).toBe("hf.co/x/y:Q4");
    expect(ollamaName(listed, "qwen3.8-64k")).toBeNull(); // a tag is never guessed beyond :latest
    expect(ollamaName(listed, "qwen:7b")).toBeNull();
  });
  it("checks tools for a model Ollama lists as name:latest", async () => {
    const fetch = vi.fn(async (url: string) =>
      String(url).endsWith("/api/tags")
        ? new Response(JSON.stringify({ models: [{ name: "qwen:latest", modified_at: "t1" }] }))
        : new Response(JSON.stringify({ capabilities: ["tools"], template: QWEN_JINJA, parameters: "num_ctx 65536" })),
    );
    const models = createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect((await models.tools("ollama/qwen")).tools).toBe(true);
    const [, init] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ model: "qwen:latest" });
  });
});

describe("the cloud models the orb leaves out", () => {
  it("lists what Ollama serves from its cloud, by remote_host / remote_model or tag, with the orb's prefix", async () => {
    const fetch = vi.fn(async () =>
      json({
        models: [
          { name: "qwen3.8-64k:27b" },
          { name: "gpt-oss:120b", remote_host: "https://ollama.com:443", remote_model: "gpt-oss:120b" },
          { name: "glm-4.6:cloud" },
          { name: "my-alias:latest", remote_model: "qwen3-coder:480b" },
        ],
      }),
    );
    const { remote } = await createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch }).remote();
    expect(remote.sort()).toEqual(["ollama/glm-4.6:cloud", "ollama/gpt-oss:120b", "ollama/my-alias", "ollama/my-alias:latest"]);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/api\/tags$/);
  });
  it("lists none when Ollama does not answer", async () => {
    const down = createLocalModels({ fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch });
    expect(await down.remote()).toEqual({ remote: [] });
  });
});

describe("models that are not on this Mac", () => {
  it("are told by Ollama's own remote fields, and by the cloud tag as a second sign", () => {
    expect(isRemoteModel({ name: "gpt-oss:120b", remote_host: "https://ollama.com:443", remote_model: "gpt-oss:120b" })).toBe(true);
    expect(isRemoteModel({ name: "my-alias", remote_model: "qwen3-coder:480b" })).toBe(true);
    expect(isRemoteModel({ name: "qwen3-coder:480b-cloud" })).toBe(true);
    expect(isRemoteModel({ name: "glm-4.6:cloud" })).toBe(true);
    expect(isRemoteModel({ name: "qwen3.8-64k:27b" })).toBe(false);
    expect(isRemoteModel({ name: "cloudy-model:7b" })).toBe(false);
  });
  it("are never offered on Claude Code, whatever their template says", async () => {
    const fetch = vi.fn(async (url: string) =>
      String(url).endsWith("/api/tags")
        ? new Response(JSON.stringify({ models: [{ name: "big:latest", modified_at: "t", remote_host: "https://ollama.com:443", remote_model: "big" }] }))
        : new Response(JSON.stringify({ capabilities: ["tools"], template: QWEN_JINJA })),
    );
    const r = await createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch }).tools("ollama/big");
    expect(r.tools).toBe(false);
    expect(r.reason).toMatch(/Ollama's cloud/);
    expect(fetch).toHaveBeenCalledTimes(1); // refused from the list, /api/show is not needed
  });
});

describe("the window a local model really runs with", () => {
  const ollama = (show: Record<string, unknown>, ps: Array<Record<string, unknown>> = []) =>
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "m:1", modified_at: "t" }] }));
      if (String(url).endsWith("/api/ps")) return new Response(JSON.stringify({ models: ps }));
      return new Response(JSON.stringify({ capabilities: ["tools"], template: QWEN_JINJA, ...show }));
    });
  const check = (show: Record<string, unknown>, ps?: Array<Record<string, unknown>>) =>
    createLocalModels({ fetch: ollama(show, ps) as unknown as typeof globalThis.fetch }).tools("ollama/m:1");
  it("reads num_ctx and the trained length as Ollama reports them", () => {
    expect(numCtxFromParameters("num_ctx                        65536\nstop \"x\"")).toBe(65536);
    expect(numCtxFromParameters("stop \"x\"")).toBeNull();
    expect(trainedContext({ "qwen35.context_length": 262144, "qwen35.block_count": 64 })).toBe(262144);
  });
  it("offers Claude Code when the model's own num_ctx reaches the planned 65,536", async () => {
    expect(await check({ parameters: "num_ctx 65536", model_info: { "x.context_length": 262144 } })).toMatchObject({ tools: true, window: 65536, need: 65536 });
  });
  it("refuses a model whose window is too small, and names the numbers", async () => {
    const r = await check({ parameters: "num_ctx 8192" });
    expect(r).toMatchObject({ tools: false, why: "window", window: 8192, need: 65536 });
    expect(r.reason).toContain("8,192");
    // num_ctx above what the model was trained for counts only up to the trained length.
    expect(await check({ parameters: "num_ctx 131072", model_info: { "x.context_length": 32768 } })).toMatchObject({ tools: false, window: 32768 });
  });
  it("without num_ctx, uses the window Ollama reports while the model is in memory, else says it does not know", async () => {
    expect(await check({}, [{ name: "m:1", context_length: 65536 }])).toMatchObject({ tools: true, window: 65536 });
    expect(await check({}, [{ name: "m:1", context_length: 4096 }])).toMatchObject({ tools: false, why: "window", window: 4096 });
    expect(await check({})).toMatchObject({ tools: null, why: "unknown", window: null });
  });
});

describe("LM Studio models", () => {
  const lm = (loaded: number | null, tools = true, type = "llm") => ({
    models: [{ key: "qwen/qwen3.8-27b", type, size_bytes: 17_000_000_000, capabilities: { trained_for_tool_use: tools }, loaded_instances: loaded === null ? [] : [{ id: "qwen/qwen3.8-27b", config: { context_length: loaded } }] }],
  });
  const studio = (body: unknown, calls: Array<[string, RequestInit | undefined]> = []) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).includes("11434")) throw new Error("no ollama");
      return new Response(JSON.stringify(body));
    });
  it("offers Claude Code only for a tool model loaded with the full window, and names the window otherwise", async () => {
    const t = (body: unknown) => createLocalModels({ fetch: studio(body) as unknown as typeof globalThis.fetch }).tools("lmstudio/qwen/qwen3.8-27b");
    expect(await t(lm(65536))).toMatchObject({ tools: true, window: 65536 });
    expect(await t(lm(4096))).toMatchObject({ tools: false, why: "window", window: 4096 });
    expect(await t(lm(null))).toMatchObject({ tools: null, why: "unknown" });
    expect(await t(lm(65536, false))).toMatchObject({ tools: false, why: "tools" });
    expect(await createLocalModels({ fetch: (async () => { throw new Error("down"); }) as unknown as typeof globalThis.fetch }).tools("lmstudio/x")).toMatchObject({ tools: null, reason: "LM Studio did not answer" });
  });
  it("says LM Studio wants an API token when it answers 401 or 403, never that it is not running", async () => {
    const wants = (status: number) => vi.fn(async () => json({ error: { message: "API token required" } }, false, status));
    for (const status of [401, 403]) {
      const ready = await lmStudioReady(wants(status) as unknown as typeof globalThis.fetch, "qwen/qwen3.8-27b");
      expect(ready).toEqual({ ok: false, status: 400, type: "invalid_request_error", message: LMSTUDIO_TOKEN_REASON });
      const models = createLocalModels({ fetch: wants(status) as unknown as typeof globalThis.fetch, totalMemory: () => 48 * 1024 ** 3 });
      expect(await models.tools("lmstudio/qwen/qwen3.8-27b")).toMatchObject({ tools: null, why: "unknown", reason: LMSTUDIO_TOKEN_REASON });
      expect(await models.unload("lmstudio/qwen/qwen3.8-27b")).toEqual({ ok: false, reason: LMSTUDIO_TOKEN_REASON.slice(0, 200) });
      await models.load("lmstudio/qwen/qwen3.8-27b");
      await new Promise((r) => setTimeout(r, 0));
      expect((await models.state()).failed).toEqual([{ model: "lmstudio/qwen/qwen3.8-27b", reason: LMSTUDIO_TOKEN_REASON.slice(0, 200) }]);
    }
    expect(LMSTUDIO_TOKEN_REASON).toMatch(/Require Authentication/);
    expect(LMSTUDIO_TOKEN_REASON).not.toMatch(/not running/);
  });

  it("loads with the full window (LM Studio's own default is 4,096), unloads by instance, and shows it in memory", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const models = createLocalModels({ fetch: studio(lm(65536), calls) as unknown as typeof globalThis.fetch, totalMemory: () => 48 * 1024 ** 3 });
    await models.load("lmstudio/qwen/qwen3.8-27b");
    const load = calls.find(([u]) => u.endsWith("/api/v1/models/load"))!;
    // One slot: a request sent again then reuses what the model has already read.
    expect(JSON.parse(String(load[1]!.body))).toEqual({ model: "qwen/qwen3.8-27b", context_length: 65536, parallel: 1 });
    expect((await models.state()).loaded).toContainEqual({ model: "lmstudio/qwen/qwen3.8-27b", bytes: 17_000_000_000, until: null });
    expect(await models.unload("lmstudio/qwen/qwen3.8-27b")).toEqual({ ok: true });
    const unload = calls.find(([u]) => u.endsWith("/api/v1/models/unload"))!;
    expect(JSON.parse(String(unload[1]!.body))).toEqual({ instance_id: "qwen/qwen3.8-27b" });
  });

  it("reports how many slots LM Studio holds a model with, and only a whole positive number", async () => {
    const withSlots = (parallel: unknown) => ({ models: [{ key: "qwen/qwen3.8-27b", type: "llm", size_bytes: 17_000_000_000, loaded_instances: [{ id: "qwen/qwen3.8-27b", config: { context_length: 65536, parallel } }] }] });
    const state = async (parallel: unknown) => (await createLocalModels({ fetch: studio(withSlots(parallel)) as unknown as typeof globalThis.fetch }).state()).loaded[0];
    expect(await state(4)).toEqual({ model: "lmstudio/qwen/qwen3.8-27b", bytes: 17_000_000_000, until: null, slots: 4 });
    expect(await state(1)).toMatchObject({ slots: 1 });
    for (const odd of [0, -1, 1.5, "4", null, undefined]) expect(await state(odd)).not.toHaveProperty("slots");
  });

  it("refuses an LM Studio load on a Mac with less than 40 GB of memory, says why, and asks LM Studio nothing", async () => {
    for (const total of [16, 24, 32, 36].map((g) => g * 1024 ** 3).concat([0, Number.NaN])) {
      const calls: Array<[string, RequestInit | undefined]> = [];
      const models = createLocalModels({ fetch: studio(lm(null), calls) as unknown as typeof globalThis.fetch, totalMemory: () => total });
      expect(await models.load("lmstudio/qwen/qwen3.8-27b")).toEqual({ ok: false, reason: LMSTUDIO_SMALL_MEMORY_REASON });
      expect(calls.some(([u]) => u.endsWith("/api/v1/models/load"))).toBe(false);
      expect((await models.state()).loading).toEqual([]);
    }
    // A failed memory read is a refusal too, never a crash.
    const broken = createLocalModels({ fetch: studio(lm(null)) as unknown as typeof globalThis.fetch, totalMemory: () => { throw new Error("no"); } });
    expect(await broken.load("lmstudio/qwen/qwen3.8-27b")).toEqual({ ok: false, reason: LMSTUDIO_SMALL_MEMORY_REASON });
    // 48 GB and up loads; an Ollama load is never refused by this rule (Ollama uses the model's own window).
    expect(LMSTUDIO_LOAD_MIN_MEMORY).toBe(40 * 1024 ** 3);
    const big = createLocalModels({ fetch: studio(lm(null)) as unknown as typeof globalThis.fetch, totalMemory: () => 48 * 1024 ** 3 });
    expect(await big.load("lmstudio/qwen/qwen3.8-27b")).toEqual({ ok: true });
    const small = createLocalModels({ fetch: vi.fn(async () => json({})) as unknown as typeof globalThis.fetch, totalMemory: () => 16 * 1024 ** 3 });
    expect(await small.load("ollama/qwen:4b")).toEqual({ ok: true });
    expect(LMSTUDIO_SMALL_MEMORY_REASON).toMatch(/65,536/);
  });
});

describe("where Ollama answers (one address for the orb and the route)", () => {
  it("reads OLLAMA_HOST as Ollama does, and counts only an address of this Mac", () => {
    expect(ollamaBaseFrom(undefined)).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseFrom("")).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseFrom("127.0.0.1:11500")).toBe("http://127.0.0.1:11500");
    expect(ollamaBaseFrom("http://localhost:11434/")).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseFrom("0.0.0.0")).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseFrom("[::]:11434")).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseFrom("[::1]:9000")).toBe("http://[::1]:9000");
    // An explicit scheme with no port means that scheme's own port, as Ollama reads it.
    expect(ollamaBaseFrom("http://localhost")).toBe("http://127.0.0.1:80");
    expect(ollamaBaseFrom("https://127.0.0.1")).toBe("https://127.0.0.1:443");
    // Another machine is never this Mac.
    expect(ollamaBaseFrom("192.0.2.10:11434")).toBeNull();
    expect(ollamaBaseFrom("http://gpu-box.example:11434")).toBeNull();
    expect(ollamaBaseFrom("ftp://127.0.0.1")).toBeNull();
  });
  it("treats no Ollama model as Local when Ollama is set to another machine", async () => {
    const fetch = vi.fn();
    const models = createLocalModels({ fetch: fetch as unknown as typeof globalThis.fetch, ollama: null });
    expect(await models.tools("ollama/qwen:27b")).toEqual({ tools: false, why: "remote", reason: OLLAMA_ELSEWHERE_REASON });
    expect(await models.remote()).toEqual({ remote: [ALL_OLLAMA] });
    expect(await models.load("ollama/qwen:27b")).toEqual({ ok: false, reason: OLLAMA_ELSEWHERE_REASON });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("11434"), expect.anything());
  });
});

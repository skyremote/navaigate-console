// The whole server, loaded in a temporary home with Local chats on Claude Code switched ON, with every fs,
// fs.promises and child_process function wrapped (named imports synced), so any read or write of the user's
// skills, agents and chat records, or of ~/.claude-local, is seen. For someone who never uses a Local model on
// Claude Code nothing is written, and nothing is read at load or for an orb check whose answer is not "Claude
// Code is offered". Three reads are allowed, each named below: the Home screen's opencode skill count (skill
// folder names, since 1.13.0); at a chat start with an unreadable mark, a check that ~/.claude-local exists;
// and, for a request to the route, its look for a secret already on disk. bb's measured share
// (local-first-prompt.json) is watched too: only the panel reads it, and only the route writes it, for a Local
// chat's first request. The first check that offers Claude Code sets it up and links the loadout.
import fs from "node:fs";
import cp from "node:child_process";
import http from "node:http";
import mod from "node:module";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const saved = { ...process.env };
let home = "";
let host: ReturnType<typeof createFakePluginHost> | null = null;
let ollama: http.Server | null = null;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nav-lazy-")));
  const tools = path.join(home, "tools");
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "profile.json"), "utf8"));
  profile.features = { preset: null, picks: { "EXTRA-AH": true, "EXTRA-AM": true } };
  fs.writeFileSync(path.join(home, "profile.json"), JSON.stringify(profile));
  fs.mkdirSync(path.join(home, ".claude", "skills", "a-skill"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "skills", "a-skill", "SKILL.md"), "---\ndescription: x\n---\n");
  fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "p", "chat.jsonl"), '{"type":"tool_use","id":"toolu_1","name":"Skill","input":{"skill":"a-skill"}}\n');
  // A stand-in Ollama on this Mac: one model offered Claude Code, one without tools, one of a failed family.
  ollama = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/v1/messages") {
        // A streamed answer that says the runner read 17,483 tokens (as Ollama did for a first request in a real bb).
        res.writeHead(200, { "content-type": "text/event-stream" });
        const e = (x: Record<string, unknown>) => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`;
        return res.end(e({ type: "message_start", message: { id: "m", usage: { input_tokens: 0, output_tokens: 0 } } }) + e({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 17_483, output_tokens: 1 } }) + e({ type: "message_stop" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen:27b" }, { name: "plain:7b" }, { name: "deepseek-r1-tuned:14b" }] }));
      if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [] }));
      if (req.url === "/api/show") {
        const model = (JSON.parse(raw || "{}") as { model?: string }).model;
        if (model === "qwen:27b") return res.end(JSON.stringify({ capabilities: ["tools"], template: "{{ .Tools }}", parameters: "num_ctx 65536" }));
        return res.end(JSON.stringify({ capabilities: ["completion"], template: "{{ .Prompt }}" }));
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => ollama!.listen(0, "127.0.0.1", r));
  process.env.HOME = home;
  process.env.BB_DATA_DIR = path.join(home, ".bb");
  process.env.NAVAIGATE_CONSOLE_PROFILE = path.join(home, "profile.json");
  process.env.PATH = `${tools}:${process.env.PATH}`;
  process.env.OLLAMA_HOST = `127.0.0.1:${(ollama.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await host?.harness.lifecycle.dispose();
  await new Promise<void>((r) => (ollama ? ollama.close(() => r()) : r()));
  process.env = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

it("touches none of the user's skills, agents, chat records or ~/.claude-local until a Local model is offered Claude Code", async () => {
  const { resetProfileCache } = await import("../profile/load");
  resetProfileCache();
  const { serverFeatureOn } = await import("../server-features");
  expect(serverFeatureOn("EXTRA-AM")).toBe(true);
  const plugin = (await import("../server")).default;
  const local = path.join(home, ".claude-local");
  // Every function of fs, fs.promises and child_process is wrapped, and the named imports are synced.
  const watch = /[/\\]\.claude[/\\](skills|agents|projects)\b|\.claude-local|local-first-prompt\.json/;
  let phase = "load";
  const hits: string[] = [];
  const procs: string[] = [];
  const undo: Array<() => void> = [];
  const wrap = (obj: Record<string, unknown>, label: string, onCall: (name: string, a: unknown[]) => void) => {
    for (const k of Object.keys(obj)) {
      const f = obj[k];
      if (typeof f !== "function" || /^[A-Z]/.test(k)) continue;
      const w = function (this: unknown, ...a: unknown[]) {
        onCall(`${label}.${k}`, a);
        return (f as (...x: unknown[]) => unknown).apply(this, a);
      };
      try {
        obj[k] = w;
        undo.push(() => {
          obj[k] = f;
        });
      } catch {}
    }
  };
  const fsCall = (name: string, a: unknown[]) => {
    for (const x of a.slice(0, 2)) if ((typeof x === "string" || x instanceof URL) && watch.test(String(x))) hits.push(`${phase}: ${name} ${String(x).replace(home, "~")}`);
  };
  wrap(fs as never, "fs", fsCall);
  wrap(fs.promises as never, "fs.promises", fsCall);
  wrap(cp as never, "child_process", (name, a) => procs.push(`${phase}: ${name} ${JSON.stringify(a.slice(0, 2))}`));
  mod.syncBuiltinESMExports();
  const of = (p: string) => hits.filter((h) => h.startsWith(`${p}: `));
  const meta: Record<string, unknown> = { thr_plain: {}, thr_lean: { sessionProfile: { profile: "lean", v: 1 } } };
  host = createFakePluginHost({
    pluginId: "navaigate-skin",
    dataDir: path.join(home, ".bb", "plugins", "navaigate-skin"),
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => {
          if (threadId === "thr_fail") throw new Error("metadata unavailable");
          return meta[threadId] ?? {};
        },
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, sourceThreadId: null, parentThreadId: null }),
        experimental_listPluginMetadata: async () => ({ threads: [] }),
      },
      system: { config: async () => ({ primaryHostId: "host_main" }) },
    } as never,
  });
  try {
    await plugin(host.bb);
    await new Promise((r) => setTimeout(r, 300)); // anything started in the background at load has time to run
    expect(of("load")).toEqual([]);

    // The Home screen's own reads.
    phase = "home";
    for (const [name, input] of [["session_profile_config", null], ["session_profiles", { threadIds: ["thr_plain", "thr_lean"] }], ["local_models_remote", null]] as const) await host.harness.callRpc(name as never, input as never);
    expect(of("home")).toEqual([]);
    // opencode's skill count for the Local orb's note (since 1.13.0) lists skill folder names, and nothing else.
    phase = "skills count";
    await host.harness.callRpc("local_skills_count", null);
    expect(of("skills count").every((h) => h.includes("/.claude/skills"))).toBe(true);

    // Ordinary chats starting (no mark, lean, a mark that cannot be read).
    phase = "chat starts";
    const resolve = (host.harness.registrations as unknown as { providerEnvResolvers: Map<string, (ctx: unknown) => Promise<unknown>> }).providerEnvResolvers.get("claude-code")!;
    for (const id of ["thr_plain", "thr_lean", "thr_fail"]) await resolve({ threadId: id, projectId: "p", hostId: "host_main" });
    // The guard for an unreadable mark only asks whether ~/.claude-local exists (Local was used before); nothing else.
    expect(of("chat starts").filter((h) => h !== "chat starts: fs.existsSync ~/.claude-local")).toEqual([]);
    expect(fs.existsSync(local)).toBe(false);

    // A caller of the route (anyone who reaches bb's server) never makes the plugin write.
    phase = "route";
    const route = host.harness.registrations.httpRoutes.find((r) => String((r as { path?: unknown }).path ?? "").endsWith("/local/v1/messages"))!;
    const req = new Request("http://x/api/v1/plugins/navaigate-skin/http/local/v1/messages", { method: "POST", headers: { authorization: "Bearer guess", "content-type": "application/json" }, body: "{}" });
    expect(((await route.handler({ req: { raw: req } } as never)) as Response).status).toBe(401);
    // At most a read of a secret already on disk (none here); never a write.
    expect(of("route").filter((h) => !/^route: fs\.(existsSync|readFileSync|lstatSync) ~\/\.claude-local(\/secret)?$/.test(h))).toEqual([]);
    expect(fs.existsSync(local)).toBe(false);

    // Orb checks whose answer is not "offered": a failed family, a model without tools, an unknown model.
    phase = "orb not offered";
    for (const model of ["ollama/deepseek-r1-tuned:14b", "ollama/plain:7b", "ollama/missing:1b"]) {
      const r = (await host.harness.callRpc("local_model_tools", { model })) as { tools: boolean | null };
      expect(r.tools, model).not.toBe(true);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(of("orb not offered")).toEqual([]);
    expect(fs.existsSync(local)).toBe(false);

    // The panel's reads: the skills and agents, then the chat records for Most used; nothing is written in ~/.claude-local.
    phase = "panel";
    await host.harness.callRpc("local_loadout", null);
    expect((await host.harness.callRpc("local_loadout_use", null)) as unknown).toEqual({ known: true, counts: { "a-skill": 1 }, partial: false, days: 30 });
    expect(of("panel").some((h) => h.includes("/.claude/skills"))).toBe(true);
    expect(of("panel").some((h) => h.includes("/.claude/projects"))).toBe(true);
    expect(fs.existsSync(local)).toBe(false);
    expect(fs.existsSync(path.join(home, ".bb", "plugins", "navaigate-skin", "local-loadout.json"))).toBe(false);
    // The panel reads bb's measured share (there is none) and writes nothing.
    expect(of("panel").some((h) => h.includes("local-first-prompt"))).toBe(true); // the watch sees it
    expect(of("panel").filter((h) => h.includes("local-first-prompt")).every((h) => /^panel: fs\.readFileSync /.test(h))).toBe(true);
    expect(fs.existsSync(path.join(home, ".bb", "plugins", "navaigate-skin", "local-first-prompt.json"))).toBe(false);

    // No child process was started with any of those paths at any point.
    expect(procs.filter((p) => watch.test(p))).toEqual([]);

    // First real use: a check that offers Claude Code sets it up, and the loadout's links follow.
    phase = "offered";
    expect(((await host.harness.callRpc("local_model_tools", { model: "ollama/qwen:27b" })) as { tools: boolean | null }).tools).toBe(true);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(local, "config", "skills", "a-skill")); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(path.join(local, "bin", "claude-local"))).toBe(true);
    expect(fs.existsSync(path.join(local, "config", "settings.json"))).toBe(true);
    expect(fs.readlinkSync(path.join(local, "config", "skills", "a-skill"))).toBe(path.join(home, ".claude", "skills", "a-skill"));
    // Setting up and linking never writes the measured share: only a Local chat's first request does.
    expect(of("offered").filter((h) => h.includes("local-first-prompt"))).toEqual([]);
    const measured = path.join(home, ".bb", "plugins", "navaigate-skin", "local-first-prompt.json");
    expect(fs.existsSync(measured)).toBe(false);

    // A Local chat's first request, with the launcher's secret: the route keeps the reading (numbers only).
    phase = "first request";
    const secret = fs.readFileSync(path.join(local, "secret"), "utf8").trim();
    const ask = (session: string, messages: unknown[]) =>
      new Request("http://x/api/v1/plugins/navaigate-skin/http/local/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-nav-local-model": "qwen:27b", "x-claude-code-session-id": session },
        body: JSON.stringify({ model: "qwen:27b", stream: true, tools: [{ name: "Bash" }, { name: "Read" }], messages }),
      });
    const sent = (await route.handler({ req: { raw: ask("s-1", [{ role: "user", content: "Say OK." }]) } } as never)) as Response;
    expect(await sent.text()).toContain("message_stop");
    for (let i = 0; i < 50 && !fs.existsSync(measured); i++) await new Promise((r) => setTimeout(r, 50));
    const kept = JSON.parse(fs.readFileSync(measured, "utf8"));
    expect(kept.readings).toHaveLength(1);
    expect(kept.readings[0]).toMatchObject({ input: 17_483, tools: 2, trimmed: true, user: 3 });
    expect(fs.statSync(measured).mode & 0o777).toBe(0o600);
    // A later turn of the same chat adds nothing.
    await ((await route.handler({ req: { raw: ask("s-1", [{ role: "user", content: "Say OK." }, { role: "assistant", content: "OK" }, { role: "user", content: "Again." }]) } } as never)) as Response).text();
    await new Promise((r) => setTimeout(r, 200));
    expect(JSON.parse(fs.readFileSync(measured, "utf8")).readings).toHaveLength(1);
    // The panel now shows it.
    expect(((await host.harness.callRpc("local_loadout", null)) as { measured: { bb: number } | null }).measured?.bb).toBe(17_483 - 8_463 - kept.readings[0].loadout - 3);
  } finally {
    for (const u of undo.reverse()) u();
    mod.syncBuiltinESMExports();
  }
}, 60_000);

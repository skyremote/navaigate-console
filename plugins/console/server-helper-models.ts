import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { helperModelsOutput, helperPurposeSchema, helperRunSchema, modelChoice } from "./delivery-contract";
import { helperKind } from "./src/delivery-model";

export { describeSelection, helperKind } from "./src/delivery-model";

type Choice = z.infer<typeof modelChoice>;
type Purpose = z.infer<typeof helperPurposeSchema>;
type Run = z.infer<typeof helperRunSchema>;
type Output = z.infer<typeof helperModelsOutput>;
type State = { choices: { title: Choice | null; commit: Choice | null }; runs: Run[] };
type Runner = (input: { model: string; prompt: string; signal: AbortSignal }) => Promise<string>;

const KEY = "helper-models:v1";
const KEEP = 20;
const TIMEOUT_MS = 30_000;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const LABEL: Record<Purpose, string> = { title: "titles", commit: "commit messages" };
const SERVICES: { id: string; purpose: Purpose; name: string }[] = [
  { id: "title-model", purpose: "title", name: "Console: chosen title model" },
  { id: "commit-model", purpose: "commit", name: "Console: chosen commit model" },
];

export function claudeArgs(model: string): string[] {
  if (!MODEL_NAME.test(model)) throw new Error(`"${model}" is not a usable model name.`);
  return ["-p", "--model", model, "--output-format", "text", "--no-session-persistence", "--tools", "", "--disable-slash-commands"];
}

const claudePath = () =>
  [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH ?? ""].join(":");

const BILLED_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** The environment claude runs in: the signed-in subscription, never a metered API key or token that the server happens to hold. */
export function claudeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PATH: claudePath() };
  for (const name of BILLED_KEYS) delete env[name];
  return env;
}

export const runClaude: Runner = ({ model, prompt, signal }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("The request was cancelled before claude started."));
      return;
    }
    const child = spawn("claude", claudeArgs(model), { cwd: os.tmpdir(), env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", (cause) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error(`Could not start claude: ${cause.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${(err || out).trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });

/**
 * Lets a title or commit helper use a Claude model, which bb's own Codex-only
 * helper services cannot. The services appear in Settings, AI Services, and
 * every run is logged with the model that produced it.
 */
export function createHelperModels(bb: BbPluginApi, deps: { run?: Runner; featureOn?: (id: string) => boolean } = {}) {
  const featureOn = deps.featureOn ?? (() => true);
  const run = deps.run ?? runClaude;
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<State> => {
    const raw = (await bb.storage.kv.get<State>(KEY)) ?? null;
    return { choices: { title: raw?.choices?.title ?? null, commit: raw?.choices?.commit ?? null }, runs: raw?.runs ?? [] };
  };
  const write = (change: (state: State) => State | void): Promise<State> => {
    const next = chain.then(async () => {
      const state = await read();
      const changed = change(state) ?? state;
      await bb.storage.kv.set(KEY, changed);
      bb.realtime.publish("delivery-helper-models", {});
      return changed;
    });
    chain = next.catch(() => undefined);
    return next;
  };
  let registered = false;
  const output = (state: State): Output => ({ choices: state.choices, runs: state.runs, serviceRegistered: registered });
  const choiceFor = async (purpose: Purpose) => {
    // F68 in the feature picker: unticked, bb falls back to its own helper models.
    if (!featureOn("F68")) return null;
    const choice = (await read()).choices[purpose];
    return helperKind(choice) === "claude" ? choice : null;
  };
  const services = (bb as { experimental_aiServices?: BbPluginApi["experimental_aiServices"] }).experimental_aiServices;
  if (services?.register && featureOn("F68")) {
    try {
      for (const { id, purpose, name } of SERVICES) {
        const none = `Choose a Claude model for ${LABEL[purpose]} in Delivery, Models by task.`;
        services.register({
          id,
          displayName: name,
          async status() {
            return (await choiceFor(purpose)) ? { ready: true as const } : { ready: false as const, message: none };
          },
          async complete(prompt, { signal }) {
            const choice = await choiceFor(purpose);
            if (!choice) throw new Error(none);
            const started = Date.now();
            const record = (ok: boolean, text: string, error: string | null) =>
              write((state) => {
                state.runs = [{ at: started, purpose, providerId: choice.providerId, model: choice.model, ok, ms: Date.now() - started, preview: text.slice(0, 120), error }, ...state.runs].slice(0, KEEP);
              });
            try {
              const text = await run({ model: choice.model, prompt, signal });
              await record(true, text, null);
              return text;
            } catch (cause) {
              await record(false, "", cause instanceof Error ? cause.message : String(cause));
              throw cause;
            }
          },
        });
      }
      registered = true;
    } catch (cause) {
      bb.log.warn(`helper model services not registered: ${String(cause)}`);
    }
  }
  return {
    async get() {
      return output(await read());
    },
    async set(input: { purpose: Purpose; choice: Choice | null }) {
      if (input.choice && helperKind(input.choice) !== "claude")
        throw new Error("Only a Claude model can be run from here. Codex models use Codex's own helper.");
      if (input.choice && !MODEL_NAME.test(input.choice.model)) throw new Error(`"${input.choice.model}" is not a usable model name.`);
      return output(
        await write((state) => {
          state.choices[input.purpose] = input.choice;
        }),
      );
    },
  };
}

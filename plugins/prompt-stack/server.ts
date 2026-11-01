// bb-plugin-prompt-stack: backend entry.
//
// A thin bridge to the prompt-stack Claude Code plugin's CLI. This plugin never
// injects anything and never touches the stack files itself: the CLI owns the
// file format, and its UserPromptSubmit hook does the injecting inside each
// Claude Code thread. Every call runs the CLI with BB_THREAD_ID set to the
// thread's id and --cwd set to the thread's workspace, exactly as the hook sees it.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const entrySchema = z.object({
  id: z.string(),
  label: z.string(),
  aliases: z.array(z.string()),
  skill: z.string(),
  summary: z.string().optional(),
});

const stateSchema = z.object({
  entries: z.array(entrySchema),
  stack: z.array(z.string()),
  scope: z.enum(["thread", "project", "none"]),
  project: z.string(),
  workspace: z.string().nullable(),
  cli: z.string(),
});
export type PromptStackState = z.infer<typeof stateSchema>;
export type PromptStackEntry = z.infer<typeof entrySchema>;

const threadInput = z.object({ threadId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/) });
const entryId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);

export const rpcContract = defineRpcContract({
  state: { input: threadInput, output: stateSchema },
  set: {
    input: threadInput.extend({ ids: z.array(entryId).max(64) }),
    output: stateSchema,
  },
  useProjectDefault: { input: threadInput, output: stateSchema },
});

const showSchema = z.object({
  stack: z.array(z.string()),
  scope: z.enum(["thread", "project", "none"]),
  project: z.string(),
  thread: z.string().nullable(),
});

const NO_CLI_MESSAGE =
  "The prompt-stack hook is not installed: install the prompt-stack Claude Code plugin, or set the CLI path in this plugin's settings.";

/**
 * Order: the `cliPath` setting, env PROMPT_STACK_CLI, the newest installed Claude Code plugin
 * copy, then the copy bundled next to this plugin (claude-plugin/bin/prompt-stack).
 * Returns null when none exists.
 */
function locateCli(override: string): string | null {
  const fromEnv = override || process.env.PROMPT_STACK_CLI || "";
  if (fromEnv) return fromEnv;
  const cache = join(homedir(), ".claude", "plugins", "cache");
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const market of readdirSync(cache)) {
      const base = join(cache, market, "prompt-stack");
      if (!existsSync(base)) continue;
      for (const version of readdirSync(base)) {
        const cli = join(base, version, "bin", "prompt-stack");
        if (!existsSync(cli)) continue;
        const mtime = statSync(cli).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: cli, mtime };
      }
    }
  } catch {
    // no plugin cache on this machine
  }
  if (best) return best.path;
  try {
    // server.ts sits in the plugin folder; the built bundle sits one level down in dist/.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const root of [here, dirname(here)]) {
      const bundled = join(root, "claude-plugin", "bin", "prompt-stack");
      if (existsSync(bundled)) return bundled;
    }
  } catch {
    // import.meta.url is not a file URL in this runtime
  }
  return null;
}

function requireCli(override: string): string {
  const cli = locateCli(override);
  if (!cli) throw new Error(NO_CLI_MESSAGE);
  return cli;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    cliPath: {
      type: "string",
      label: "prompt-stack CLI path",
      description:
        "Leave empty to use PROMPT_STACK_CLI, then the newest installed prompt-stack plugin, then the copy bundled with this plugin.",
      default: "",
    },
    stackHome: {
      type: "string",
      label: "Stack folder (PROMPT_STACK_HOME)",
      description: "Leave empty for ~/.claude/prompt-stack. Set only for testing.",
      default: "",
    },
  });

  function run(cli: string, args: string[], threadId: string, cwd: string, stackHome: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, BB_THREAD_ID: threadId };
    delete env.CLAUDE_CODE_SESSION_ID; // the thread key must come from BB_THREAD_ID only
    if (stackHome) env.PROMPT_STACK_HOME = stackHome;
    return new Promise<string>((resolve, reject) => {
      execFile(
        "/usr/bin/env",
        ["python3", cli, ...args],
        { cwd, env, timeout: 15_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error((stderr || error.message).trim().slice(0, 500)));
          else resolve(stdout);
        },
      );
    });
  }

  async function workspaceOf(threadId: string): Promise<string | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) return null;
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      return environment.path && existsSync(environment.path) ? environment.path : null;
    } catch (cause) {
      bb.log.warn(`could not resolve workspace for ${threadId}: ${String(cause)}`);
      return null;
    }
  }

  async function state(threadId: string): Promise<PromptStackState> {
    const { cliPath, stackHome } = await settings.get();
    const cli = requireCli(cliPath);
    const workspace = await workspaceOf(threadId);
    const cwd = workspace ?? homedir();
    const [listOut, showOut] = await Promise.all([
      run(cli, ["list", "--json"], threadId, cwd, stackHome),
      run(cli, ["show", "--json", "--cwd", cwd], threadId, cwd, stackHome),
    ]);
    const entries = z.array(entrySchema).parse(JSON.parse(listOut));
    const shown = showSchema.parse(JSON.parse(showOut));
    return { entries, stack: shown.stack, scope: shown.scope, project: shown.project, workspace, cli };
  }

  // One write at a time per thread, so quick ticks land in order.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queues.set(threadId, next);
    void next.finally(() => {
      if (queues.get(threadId) === next) queues.delete(threadId);
    }).catch(() => undefined);
    return next;
  }

  async function write(threadId: string, args: string[]) {
    const { cliPath, stackHome } = await settings.get();
    const cli = requireCli(cliPath);
    const cwd = (await workspaceOf(threadId)) ?? homedir();
    await run(cli, [...args, "--thread", "--cwd", cwd], threadId, cwd, stackHome);
    bb.realtime.publish("stack-changed", { threadId });
    return state(threadId);
  }

  bb.rpc.register(rpcContract, {
    state: ({ threadId }) => state(threadId),
    // `set` with no ids would leave an empty thread override ("nothing for this thread"),
    // which is what unticking the last box means.
    set: ({ threadId, ids }) => serial(threadId, () => write(threadId, ["set", ...ids])),
    useProjectDefault: ({ threadId }) => serial(threadId, () => write(threadId, ["clear"])),
  });

  // The hook deletes a thread's stack file after one prompt uses it. Watch the
  // threads folder so the panel unticks itself as soon as that happens.
  let watcher: ReturnType<typeof watch> | null = null;
  let disposed = false;
  const watchHome = async () => {
    let dir = "the prompt-stack threads folder";
    try {
      const { stackHome } = await settings.get();
      const home = stackHome || process.env.PROMPT_STACK_HOME || join(homedir(), ".claude", "prompt-stack");
      dir = join(home, "threads");
      if (disposed) return;
      mkdirSync(dir, { recursive: true });
      watcher = watch(dir, (_event, file) => {
        const name = file ? String(file) : "";
        if (!disposed && name.endsWith(".json")) bb.realtime.publish("stack-changed", { threadId: name.slice(0, -5) });
      });
      watcher.on("error", (cause) => bb.log.warn("stack watch stopped: " + String(cause)));
    } catch (cause) {
      bb.log.warn("could not watch " + dir + ": " + String(cause));
    }
  };
  void watchHome();
  bb.onDispose(() => {
    disposed = true;
    watcher?.close();
    watcher = null;
  });

  bb.log.info("loaded: Prompt stack panel");
}

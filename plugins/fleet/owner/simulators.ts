// F21: watch and drive iOS simulators and Android emulators on the Mac that
// owns them, only with the tools already installed there. iOS frames, boot,
// open URL and launch use simctl; iOS taps, text and keys need idb. Android
// uses adb (screencap, input, am, monkey) against a running device serial.
// A missing tool is reported, never installed or faked. Every child process
// gets a fixed argv; nothing passes through a host shell, and text or URLs
// that would reach the Android device shell are limited to safe characters.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const udid = z.string().regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
const serial = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const targetSchema = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("ios"), id: udid }).strict(),
  z.object({ platform: z.literal("android"), id: serial }).strict(),
]);
const KEYS = ["Enter", "Back", "Home", "Tab", "Delete"] as const;
const safeUrl = z.string().max(2000).regex(/^(https?:\/\/|[a-z][a-z0-9+.-]{1,30}:\/\/)[A-Za-z0-9:/?&=._~%+#@!,;-]+$/i).refine((value) => !/^(file|javascript|data|intent):/i.test(value), "Local-file, intent and script URLs are not opened");
const actionKindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("boot") }).strict(),
  z.object({ kind: z.literal("openurl"), url: safeUrl }).strict(),
  z.object({ kind: z.literal("launch"), appId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{2,200}$/) }).strict(),
  z.object({ kind: z.literal("tap"), x: z.number().min(0).max(10_000), y: z.number().min(0).max(10_000) }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("key"), key: z.enum(KEYS) }).strict(),
]);
const actionSchema = z.object({ target: targetSchema, action: actionKindSchema }).strict();
const deviceSchema = z.object({ platform: z.enum(["ios", "android"]), id: z.string(), name: z.string(), state: z.string(), runtime: z.string() });
const actionResultSchema = z.object({ ok: z.boolean(), message: z.string().nullable() });
export const simulatorRpcContract = defineRpcContract({
  simulator_list: {
    input: z.null(),
    output: z.object({
      ios: z.object({ available: z.boolean(), inputControl: z.boolean() }),
      android: z.object({ available: z.boolean(), reason: z.string().nullable() }),
      devices: z.array(deviceSchema),
    }),
  },
  simulator_frame: { input: targetSchema, output: z.object({ platform: z.enum(["ios", "android"]), id: z.string(), mimeType: z.enum(["image/jpeg", "image/png"]), contentBase64: z.string(), capturedAt: z.number() }) },
  simulator_action: { input: actionSchema, output: actionResultSchema },
});

export type SimExec = (bin: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
export type SimExecBytes = (bin: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: Buffer; stderr: string }>;
const defaultExec: SimExec = (bin, args, timeoutMs = 30_000) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
});
const defaultExecBytes: SimExecBytes = (bin, args, timeoutMs = 30_000) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0, stdout: Buffer.from(stdout ?? Buffer.alloc(0)), stderr: String(stderr ?? "") });
  });
});

const ANDROID_KEYCODES: Record<(typeof KEYS)[number], string> = { Enter: "66", Back: "4", Home: "3", Tab: "61", Delete: "67" };
const IOS_KEYCODES: Record<(typeof KEYS)[number], string | null> = { Enter: "40", Back: null, Home: null, Tab: "43", Delete: "42" };
const MAX_FRAME_BYTES = 1_000_000;

export function createSimulators(options: { exec?: SimExec; execBytes?: SimExecBytes; readFile?: (path: string) => Buffer; now?: () => number; env?: NodeJS.ProcessEnv; home?: string } = {}) {
  const exec = options.exec ?? defaultExec;
  const execBytes = options.execBytes ?? defaultExecBytes;
  const read = options.readFile ?? ((path: string) => readFileSync(path));
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  async function firstExecutable(paths: (string | undefined)[]): Promise<string | null> {
    for (const path of paths) {
      if (!path) continue;
      if ((await exec("/bin/test", ["-x", path])).code === 0) return path;
    }
    return null;
  }
  const idb = () => firstExecutable(["/usr/local/bin/idb", "/opt/homebrew/bin/idb"]);
  const adb = () => firstExecutable([
    env.ANDROID_HOME ? join(env.ANDROID_HOME, "platform-tools", "adb") : undefined,
    env.ANDROID_SDK_ROOT ? join(env.ANDROID_SDK_ROOT, "platform-tools", "adb") : undefined,
    join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
  ]);
  const done = (result: { code: number; stderr: string }) => ({ ok: result.code === 0, message: result.code === 0 ? null : result.stderr.trim().slice(0, 300) || "The tool failed" });
  const refuse = (message: string) => ({ ok: false, message });

  async function iosDevices() {
    const list = await exec("/usr/bin/xcrun", ["simctl", "list", "devices", "-j"]);
    if (list.code !== 0) return null;
    let raw: unknown;
    try { raw = JSON.parse(list.stdout); } catch { return null; }
    const parsed = z.object({ devices: z.record(z.string(), z.array(z.object({ udid: z.string(), name: z.string(), state: z.string(), isAvailable: z.boolean().optional() }).passthrough())) }).safeParse(raw);
    if (!parsed.success) return null;
    return Object.entries(parsed.data.devices).flatMap(([runtime, entries]) => entries.filter((entry) => entry.isAvailable !== false).map((entry) => ({ platform: "ios" as const, id: entry.udid, name: entry.name, state: entry.state, runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "") })));
  }

  async function androidDevices(tool: string) {
    const list = await exec(tool, ["devices", "-l"]);
    if (list.code !== 0) return null;
    return list.stdout.split("\n").slice(1).flatMap((line) => {
      const match = /^(\S+)\s+(device|offline|unauthorized)\b(.*)$/.exec(line.trim());
      if (!match || !serial.safeParse(match[1]).success) return [];
      const model = /\bmodel:(\S+)/.exec(match[3] ?? "")?.[1] ?? match[1]!;
      return [{ platform: "android" as const, id: match[1]!, name: model.replace(/_/g, " "), state: match[2] === "device" ? "Booted" : match[2]!, runtime: match[1]!.startsWith("emulator-") ? "Android emulator" : "Android device" }];
    });
  }

  async function androidAction(tool: string, id: string, action: z.infer<typeof actionKindSchema>) {
    const shell = (args: string[]) => exec(tool, ["-s", id, "shell", ...args]);
    switch (action.kind) {
      case "boot": return refuse("Start the Android emulator on the owner Mac (emulator -avd); Fleet lists and drives running devices only");
      case "openurl": return done(await shell(["am", "start", "-a", "android.intent.action.VIEW", "-d", action.url]));
      case "launch": return done(await shell(["monkey", "-p", action.appId, "-c", "android.intent.category.LAUNCHER", "1"]));
      case "tap": return done(await shell(["input", "tap", String(Math.round(action.x)), String(Math.round(action.y))]));
      case "text":
        if (!/^[A-Za-z0-9@._,+-]+( [A-Za-z0-9@._,+-]+)*$/.test(action.text)) return refuse("Android text input takes letters, digits, spaces and @._,+- only; nothing was typed");
        return done(await shell(["input", "text", action.text.replace(/ /g, "%s")]));
      case "key": return done(await shell(["input", "keyevent", ANDROID_KEYCODES[action.key]]));
    }
  }

  async function iosAction(id: string, action: z.infer<typeof actionKindSchema>) {
    if (action.kind === "boot") return done(await exec("/usr/bin/xcrun", ["simctl", "boot", id]));
    if (action.kind === "openurl") return done(await exec("/usr/bin/xcrun", ["simctl", "openurl", id, action.url]));
    if (action.kind === "launch") return done(await exec("/usr/bin/xcrun", ["simctl", "launch", id, action.appId]));
    const tool = await idb();
    if (tool === null) return refuse("Taps, text and keys need idb on the owner Mac; it is not installed, so nothing was sent");
    if (action.kind === "tap") return done(await exec(tool, ["ui", "tap", String(Math.round(action.x)), String(Math.round(action.y)), "--udid", id]));
    if (action.kind === "text") return done(await exec(tool, ["ui", "text", action.text, "--udid", id]));
    const code = IOS_KEYCODES[action.key];
    if (code === null) return refuse(`${action.key} has no iOS simulator key`);
    return done(await exec(tool, ["ui", "key", code, "--udid", id]));
  }

  return {
    handlers: {
      simulator_list: async () => {
        const ios = await iosDevices();
        const tool = await adb();
        const android = tool ? await androidDevices(tool) : null;
        return {
          ios: { available: ios !== null, inputControl: ios !== null && (await idb()) !== null },
          android: { available: android !== null, reason: tool === null ? "adb is not installed on this Mac (Android SDK platform-tools)" : android === null ? "adb did not list devices" : null },
          devices: [...(ios ?? []), ...(android ?? [])].slice(0, 100),
        };
      },
      simulator_frame: async (target: z.infer<typeof targetSchema>) => {
        if (target.platform === "android") {
          const tool = await adb();
          if (tool === null) throw new Error("adb is not installed on this Mac");
          const shot = await execBytes(tool, ["-s", target.id, "exec-out", "screencap", "-p"], 20_000);
          if (shot.code !== 0 || shot.stdout.length === 0) throw new Error(`Screenshot failed: ${shot.stderr.trim().split("\n")[0] || "adb error"}`);
          if (shot.stdout.length > MAX_FRAME_BYTES) throw new Error("The frame is larger than the direct transport allows");
          return { platform: "android" as const, id: target.id, mimeType: "image/png" as const, contentBase64: shot.stdout.toString("base64"), capturedAt: now() };
        }
        const path = join(tmpdir(), `fleet-sim-${randomUUID()}.jpg`);
        try {
          const shot = await exec("/usr/bin/xcrun", ["simctl", "io", target.id, "screenshot", "--type=jpeg", path], 20_000);
          if (shot.code !== 0) throw new Error(`Screenshot failed: ${shot.stderr.trim().split("\n")[0] || "simctl error"}`);
          const bytes = read(path);
          if (bytes.length > MAX_FRAME_BYTES) throw new Error("The frame is larger than the direct transport allows");
          return { platform: "ios" as const, id: target.id, mimeType: "image/jpeg" as const, contentBase64: bytes.toString("base64"), capturedAt: now() };
        } finally {
          rmSync(path, { force: true });
        }
      },
      simulator_action: async ({ target, action }: z.infer<typeof actionSchema>) => {
        if (target.platform === "android") {
          const tool = await adb();
          if (tool === null) return refuse("adb is not installed on this Mac; nothing was sent");
          return androidAction(tool, target.id, action);
        }
        return iosAction(target.id, action);
      },
    },
  };
}

const simulatorCallSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("simulator_list"), input: z.null() }).strict(),
  z.object({ method: z.literal("simulator_frame"), input: targetSchema }).strict(),
  z.object({ method: z.literal("simulator_action"), input: actionSchema }).strict(),
]);
/** Source-side forwarder: exactly the three simulator methods, to this Mac or the always-on Mac over its SSH owner route. */
export const simulatorForwardContract = defineRpcContract({
  simulator_forward: { input: z.object({ machine: z.string().min(1).max(40), call: simulatorCallSchema }).strict(), output: z.json() },
});

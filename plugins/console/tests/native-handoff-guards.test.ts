import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetProfileCache } from "../profile/load";
import { COMMUNITY_DEFAULTS } from "../profile/schema";
import { createTeleport } from "../server-teleport";
import { createM1Service } from "../server-m1-service";
import { handOff, m1Log, m1Tell } from "../server-m1";
import { handoffRefusal, trustedHandoffScript } from "../server-words";

const before = process.env.NAVAIGATE_CONSOLE_PROFILE;
const dirs: string[] = [];
afterEach(() => {
  if (before === undefined) delete process.env.NAVAIGATE_CONSOLE_PROFILE; else process.env.NAVAIGATE_CONSOLE_PROFILE = before;
  resetProfileCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function useProfile(profile: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "console-guard-"));
  dirs.push(dir);
  const file = join(dir, "profile.json");
  writeFileSync(file, JSON.stringify(profile));
  process.env.NAVAIGATE_CONSOLE_PROFILE = file;
  resetProfileCache();
  return dir;
}

const withAlwaysOn = (script: string | null) => ({
  ...COMMUNITY_DEFAULTS,
  machines: [
    { ...COMMUNITY_DEFAULTS.machines[0]!, id: "laptop", label: "Laptop" },
    { ...COMMUNITY_DEFAULTS.machines[0]!, id: "studio", label: "Studio", role: "always-on", sshAlias: "studio-ssh" },
  ],
  thisMachine: "laptop",
  plugins: script ? { console: { handoffScript: script } } : {},
});

describe("moving chats with no always-on Mac", () => {
  const message = /Moving a chat needs an always-on Mac with an SSH alias/;

  it("refuses a move before it stops the chat, pushes a branch or reads anything", async () => {
    useProfile(COMMUNITY_DEFAULTS);
    expect(handoffRefusal()).toMatch(message);
    const untouched = new Proxy({}, { get() { throw new Error("the bb API must not be touched"); } });
    const ssh = vi.fn(async () => "");
    const teleport = createTeleport(untouched as never, untouched as never, { ssh });
    await expect(teleport.move({ threadId: "thr_one" } as never)).rejects.toThrow(message);
    expect(ssh).not.toHaveBeenCalled();
  });

  it("refuses the hand-over, a log read and a follow-up without running a script or ssh", async () => {
    useProfile(COMMUNITY_DEFAULTS);
    await expect(handOff({ threadId: "thr_one", title: "t", providerId: "claude-code" })).rejects.toThrow(message);
    await expect(m1Log("thr_one")).rejects.toThrow(message);
    await expect(m1Tell("thr_one", "hello")).rejects.toThrow(message);
  });

  it("answers the always-on Mac service check with the reason, and never runs ssh with an empty alias", async () => {
    useProfile(COMMUNITY_DEFAULTS);
    const state = await createM1Service().get();
    expect(state.reachable).toBe(false);
    expect(state.error).toMatch(message);
  });

  it("is open when the profile has an always-on Mac with an SSH alias", () => {
    useProfile(withAlwaysOn(null));
    expect(handoffRefusal()).toBeNull();
  });
});

describe("the hand-over script", () => {
  it("is refused when none is set, when it is missing, and when it is not a regular file", () => {
    useProfile(withAlwaysOn(null));
    expect(() => trustedHandoffScript()).toThrow(/No hand-over script is set/);
    const dir = useProfile(withAlwaysOn("/nonexistent/helper.sh"));
    expect(() => trustedHandoffScript()).toThrow(/does not exist/);
    const folder = join(dir, "folder");
    mkdirSync(folder);
    useProfile(withAlwaysOn(folder));
    expect(() => trustedHandoffScript()).toThrow(/not a regular file/);
  });

  it("is refused when the group or anyone else can write to it, and runs when only its owner can", () => {
    const dir = mkdtempSync(join(tmpdir(), "console-script-"));
    dirs.push(dir);
    const script = join(dir, "helper.sh");
    writeFileSync(script, "#!/bin/bash\n");
    useProfile(withAlwaysOn(script));
    chmodSync(script, 0o775);
    expect(() => trustedHandoffScript()).toThrow(/group or world writable/);
    chmodSync(script, 0o757);
    expect(() => trustedHandoffScript()).toThrow(/group or world writable/);
    chmodSync(script, 0o755);
    expect(trustedHandoffScript()).toBe(script);
  });

  it("is refused through the hand-over itself before anything is read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-script-"));
    dirs.push(dir);
    const script = join(dir, "helper.sh");
    writeFileSync(script, "#!/bin/bash\n");
    chmodSync(script, 0o777);
    useProfile(withAlwaysOn(script));
    await expect(handOff({ threadId: "thr_one", title: "t", providerId: "claude-code" })).rejects.toThrow(/group or world writable/);
  });
});


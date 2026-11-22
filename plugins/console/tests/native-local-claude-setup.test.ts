// What a Local chat on the Claude Code harness needs on disk, and how bb's server sets it up:
// the files and their modes, the Local folder for transcripts (apart from the main ~/.claude),
// the claude lookup (no shell), and that nothing is written and no one is answered while the
// feature is off. Every test works in its own temporary home, never the real one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalClaudeRoute, createLocalClaudeSetup, ensureLocalClaude, findRealClaude, localConfigPath, ownProjectsFolder, SETUP_RETRY_MS } from "../server-local-claude";

let home: string;
let bin: string;
const fakeClaude = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "claude");
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
};
const mode = (file: string) => fs.statSync(file).mode & 0o777;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nav-local-setup-")));
  bin = path.join(home, "tools");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("ensureLocalClaude", () => {
  it("writes the launcher, the guard, the secret and the settings, readable by their owner only", () => {
    const real = fakeClaude(bin);
    const got = ensureLocalClaude(home, { PATH: bin });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const dir = path.join(home, ".claude-local");
    expect(got.launcher).toBe(path.join(dir, "bin", "claude-local"));
    expect(got.guard).toBe(path.join(dir, "bin", "claude-guard"));
    expect(got.config).toBe(localConfigPath(home));
    expect(mode(got.launcher)).toBe(0o700);
    expect(mode(got.guard)).toBe(0o700);
    expect(mode(path.join(dir, "secret"))).toBe(0o600);
    expect(mode(path.join(dir, "bin"))).toBe(0o700);
    expect(mode(got.config)).toBe(0o700);
    expect(mode(path.join(got.config, "settings.json"))).toBe(0o600);
    // A long random secret, kept across runs, and the real claude named in the launcher.
    expect(got.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(fs.readFileSync(path.join(dir, "secret"), "utf8").trim()).toBe(got.secret);
    expect(fs.readFileSync(got.launcher, "utf8")).toContain(`exec '${real}' "$@"`);
    const again = ensureLocalClaude(home, { PATH: bin });
    expect(again.ok && again.secret).toBe(got.secret);
  });

  it("replaces a damaged secret with a new one", () => {
    fakeClaude(bin);
    fs.mkdirSync(path.join(home, ".claude-local"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude-local", "secret"), "short\n", { mode: 0o644 });
    const got = ensureLocalClaude(home, { PATH: bin });
    expect(got.ok && got.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mode(path.join(home, ".claude-local", "secret"))).toBe(0o600);
  });

  it("keeps Local transcripts in their own folder, never in the main ~/.claude/projects", () => {
    fakeClaude(bin);
    fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "projects", "p", "s.jsonl"), "{}\n");
    const got = ensureLocalClaude(home, { PATH: bin });
    expect(got.ok).toBe(true);
    const projects = path.join(localConfigPath(home), "projects");
    expect(fs.lstatSync(projects).isSymbolicLink()).toBe(false);
    expect(fs.statSync(projects).isDirectory()).toBe(true);
    expect(fs.readdirSync(projects)).toEqual([]);
    // The main folder is untouched.
    expect(fs.readFileSync(path.join(home, ".claude", "projects", "p", "s.jsonl"), "utf8")).toBe("{}\n");
  });

  it("copies only the main clean-up period into the Local settings, and nothing else of the main setup", () => {
    fakeClaude(bin);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 365, hooks: { Stop: [] }, enabledPlugins: { x: true } }));
    const got = ensureLocalClaude(home, { PATH: bin });
    expect(got.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(localConfigPath(home), "settings.json"), "utf8"))).toEqual({ enabledPlugins: {}, hooks: {}, cleanupPeriodDays: 365 });
  });

  it("says why it cannot set up when there is no claude program, and writes nothing", () => {
    const got = ensureLocalClaude(home, { PATH: path.join(home, "nowhere") });
    expect(got).toEqual({ ok: false, reason: "the claude program was not found on this Mac" });
    expect(fs.existsSync(path.join(home, ".claude-local"))).toBe(false);
  });
});

describe("the Local transcripts folder after an older version", () => {
  it("replaces the old link to the main projects folder with a folder of its own, leaving the main folder as it was", () => {
    const config = path.join(home, ".claude-local", "config");
    const main = path.join(home, ".claude", "projects");
    fs.mkdirSync(path.join(main, "p"), { recursive: true });
    fs.writeFileSync(path.join(main, "p", "s.jsonl"), "{}\n");
    fs.mkdirSync(config, { recursive: true });
    fs.symlinkSync(main, path.join(config, "projects"));
    ownProjectsFolder(config, main);
    expect(fs.lstatSync(path.join(config, "projects")).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(path.join(config, "projects"))).toEqual([]);
    expect(fs.readFileSync(path.join(main, "p", "s.jsonl"), "utf8")).toBe("{}\n");
  });
  it("replaces the old link even when the main folder has gone", () => {
    const config = path.join(home, ".claude-local", "config");
    const main = path.join(home, ".claude", "projects");
    fs.mkdirSync(config, { recursive: true });
    fs.symlinkSync(main, path.join(config, "projects"));
    ownProjectsFolder(config, main);
    expect(fs.statSync(path.join(config, "projects")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(config, "projects")).isSymbolicLink()).toBe(false);
  });
  it("leaves a real folder, and a link someone else made, exactly as they are", () => {
    const config = path.join(home, ".claude-local", "config");
    const main = path.join(home, ".claude", "projects");
    fs.mkdirSync(path.join(config, "projects"), { recursive: true });
    fs.writeFileSync(path.join(config, "projects", "kept.jsonl"), "x");
    ownProjectsFolder(config, main);
    expect(fs.readFileSync(path.join(config, "projects", "kept.jsonl"), "utf8")).toBe("x");
    const config2 = path.join(home, "other", "config");
    const elsewhere = path.join(home, "mine");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(config2, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(config2, "projects"));
    ownProjectsFolder(config2, main);
    expect(fs.lstatSync(path.join(config2, "projects")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(config2, "projects"))).toBe(elsewhere);
  });
});

describe("findRealClaude", () => {
  it("looks the way bb looks: bb's own setting, then PATH, then the installers' places, with file checks only", () => {
    const fromPath = fakeClaude(bin);
    const pinned = fakeClaude(path.join(home, "pinned"));
    expect(findRealClaude(home, { PATH: bin })).toBe(fromPath);
    expect(findRealClaude(home, { PATH: bin, BB_CLAUDE_CODE_EXECUTABLE: pinned })).toBe(pinned);
    const installed = fakeClaude(path.join(home, ".local", "bin"));
    expect(findRealClaude(home, { PATH: path.join(home, "nowhere") })).toBe(installed);
  });
  it("never picks the Local launcher itself, or a folder named claude", () => {
    fakeClaude(path.join(home, ".claude-local", "bin"));
    fs.mkdirSync(path.join(bin, "claude"), { recursive: true });
    expect(findRealClaude(home, { PATH: `${path.join(home, ".claude-local", "bin")}:${bin}` })).toBeNull();
  });
});

describe("the setup as bb's server uses it", () => {
  it("while the feature is off: nothing is set up or written, and the route answers no one", async () => {
    const ensure = vi.fn(() => ensureLocalClaude(home, { PATH: bin }));
    fakeClaude(bin);
    const setup = createLocalClaudeSetup({ on: () => false, ensure, warn: vi.fn() });
    expect(setup()).toEqual({ ok: false, reason: "Local chats on Claude Code are switched off" });
    const fetch = vi.fn();
    const route = createLocalClaudeRoute({ secret: () => (setup().ok ? "never" : null), fetch: fetch as unknown as typeof globalThis.fetch });
    const req = new Request("http://x/local/v1/messages", { method: "POST", headers: { authorization: "Bearer anything" }, body: "{}" });
    expect((await route.messages(req)).status).toBe(401);
    expect((await route.countTokens(new Request("http://x/local/v1/messages/count_tokens", { method: "POST", body: "{}" }))).status).toBe(401);
    expect(ensure).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, ".claude-local"))).toBe(false);
  });
  it("while it is on: sets up once and keeps it", () => {
    fakeClaude(bin);
    const ensure = vi.fn(() => ensureLocalClaude(home, { PATH: bin }));
    const setup = createLocalClaudeSetup({ on: () => true, ensure, warn: vi.fn() });
    expect(setup().ok).toBe(true);
    expect(setup().ok).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  it("keeps a failure for a minute, warns once, then tries again", () => {
    let now = 1_000;
    const warn = vi.fn();
    const ensure = vi.fn(() => ensureLocalClaude(home, { PATH: path.join(home, "nowhere") }));
    const setup = createLocalClaudeSetup({ on: () => true, ensure, warn, now: () => now });
    expect(setup().ok).toBe(false);
    now += SETUP_RETRY_MS - 1;
    expect(setup().ok).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(1);
    now += 2;
    expect(setup().ok).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    // Once claude is installed, the next try after the minute succeeds.
    fakeClaude(path.join(home, ".local", "bin"));
    now += SETUP_RETRY_MS;
    expect(setup().ok).toBe(true);
  });
  it("treats a profile that cannot be read as off, so nothing is written and bb's server keeps loading", () => {
    const ensure = vi.fn(() => ensureLocalClaude(home, { PATH: bin }));
    const setup = createLocalClaudeSetup({ on: () => { throw new Error("bad profile"); }, ensure, warn: vi.fn() });
    expect(setup().ok).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });
  it("turns a throw into a failure with its reason", () => {
    const setup = createLocalClaudeSetup({ on: () => true, ensure: () => { throw new Error("disk full"); }, warn: vi.fn() });
    expect(setup()).toEqual({ ok: false, reason: "disk full" });
  });
});

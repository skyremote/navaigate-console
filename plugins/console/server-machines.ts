// The always-on Mac as a second machine of THIS bb server (enrolled with `bb
// machine create --provider manual`, named like the profile's always-on
// machine). Unlike a hand-over (server-m1.ts), which gives a brief to that Mac's
// own separate bb, threads started here run on it but stay in this bb: same
// sidebar, same history, same server.
//
// A project runs there only through a project source (a checkout path on that
// Mac). We look it up, and can add one where the project usually lives: the NAS
// share at the same path, ~/Documents/GitHub/<repo> under that Mac's own home.
// When the folder is not there yet, the repo is cloned onto it (bb's own
// project-source clone, which runs on that Mac) at that path and registered as
// the project's checkout.
import { execFile } from "node:child_process";
import os from "node:os";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { loadProfile } from "./profile/load";
import { alwaysOnMachine, type Profile } from "./profile/schema";
import { alwaysOnPhrase, upperFirst } from "./lib/profile-text";
import { consoleSection, expandProfilePath, homeOf } from "./lib/profile-console";

export const m1MachineSchema = z.object({
  /** The always-on Mac's host id in this bb, or null when no machine of that name is enrolled. */
  hostId: z.string().nullable(),
  connected: z.boolean(),
  /** The project's checkout on the always-on Mac, when it has one. */
  sourcePath: z.string().nullable(),
  /** Where the project probably lives on the always-on Mac, when it has no checkout there yet. */
  suggestedPath: z.string().nullable(),
  /** The project's checkout on this Mac (the server machine), to switch back. */
  localHostId: z.string().nullable(),
  localPath: z.string().nullable(),
  /** The git remote the always-on Mac would clone the project from when the folder is not there, or null when there is none. */
  cloneFrom: z.string().nullable().optional(),
  /** Set on the answer to a link that had to clone the repo onto the always-on Mac. */
  cloned: z.boolean().optional(),
});
export type M1Machine = z.infer<typeof m1MachineSchema>;

type ProjectGet = { gitRemoteUrl?: string | null; sources?: Source[] };
type Host = { id: string; name: string; status: string; type: string; machineProviderId: string | null };
type Source = { id: string; hostId: string; path: string; isDefault: boolean };

type PathMap = { localHome: string; remoteHome: string | null; nas: string | null; nasLink: string | null };

function pathMap(p: Profile, osHome: string): PathMap {
  const localHome = homeOf(p, osHome).replace(/\/+$/, "");
  const link = expandProfilePath(p, consoleSection(p).nasLink, osHome);
  return { localHome, remoteHome: alwaysOnMachine(p)?.home?.replace(/\/+$/, "") ?? null, nas: p.paths.nas?.replace(/\/+$/, "") ?? null, nasLink: link ? link.replace(/\/+$/, "") : null };
}
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Where a path on this Mac usually lives on the always-on Mac. The NAS is the same share on both. */
export function m1PathFor(localPath: string, p: Profile = loadProfile().profile, osHome: string = os.homedir()): string {
  const m = pathMap(p, osHome);
  if (m.nas && m.nasLink && under(localPath, m.nasLink)) return m.nas + localPath.slice(m.nasLink.length);
  if (m.remoteHome && under(localPath, m.localHome)) return m.remoteHome + localPath.slice(m.localHome.length);
  return localPath;
}
/** The reverse: where a path on the always-on Mac lives on this Mac. */
export function localPathFor(m1Path: string, p: Profile = loadProfile().profile, osHome: string = os.homedir()): string {
  const m = pathMap(p, osHome);
  if (m.remoteHome && under(m1Path, m.remoteHome)) return m.localHome + m1Path.slice(m.remoteHome.length);
  return m1Path;
}
export function isShared(path: string, p: Profile = loadProfile().profile, osHome: string = os.homedir()): boolean {
  const m = pathMap(p, osHome);
  return (m.nas !== null && under(path, m.nas)) || (m.nasLink !== null && under(path, m.nasLink));
}

/** bb on the always-on Mac clones for up to 20 minutes, so this waits as long. */
export const CLONE_TIMEOUT_MS = 1_200_000;

/** Only these remotes are cloned: a URL that starts with "-" can never become a git option. */
export const isCloneableRemote = (url: string) => /^(https:\/\/|ssh:\/\/|git@)/i.test(url.trim());

/**
 * Takes the user and password out of a URL-form remote (https://user:token@host/x, ssh://user@host/x); git@host:x is left alone.
 * Everything between the scheme and the LAST "@" of the address goes, so a password holding an unencoded "@" or "/" does not leak.
 * (An "@" inside a path costs the host in the display only, which errs on the safe side.)
 */
export const redactRemote = (url: string) => url.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s'"<>]*@/gi, "$1");

/** origin of a checkout on this Mac, for projects bb has no remote recorded for. */
const localOrigin = (cwd: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms))]);

export function createMachines(bb: BbPluginApi) {
  let cache: { at: number; host: Host | null } | null = null;
  /** Clones still running on the always-on Mac, by target path. An entry stays until bb itself answers, even after this has stopped waiting. */
  const cloning = new Set<string>();

  async function m1Host(): Promise<Host | null> {
    if (cache && Date.now() - cache.at < 15_000) return cache.host;
    const hosts = (await bb.sdk.hosts.list({ type: "persistent" })) as unknown as Host[];
    const wanted = alwaysOnMachine(loadProfile().profile);
    const names = wanted ? [wanted.label.trim().toLowerCase(), wanted.id.trim().toLowerCase()] : [];
    const host = hosts.find((h) => names.includes(h.name.trim().toLowerCase())) ?? null;
    cache = { at: Date.now(), host };
    return host;
  }

  async function project(projectId: string): Promise<ProjectGet> {
    return ((await bb.sdk.projects.get({ projectId })) as unknown as ProjectGet) ?? {};
  }

  async function forProject(projectId: string | null): Promise<M1Machine> {
    const host = await m1Host();
    const out: M1Machine = { hostId: host?.id ?? null, connected: host?.status === "connected", sourcePath: null, suggestedPath: null, localHostId: null, localPath: null };
    if (!projectId) return out;
    const p = await project(projectId).catch(() => ({}) as ProjectGet);
    const all = p.sources ?? [];
    const local = all.filter((s) => s.hostId !== host?.id);
    const localSrc = local.find((s) => s.isDefault) ?? local[0];
    out.localHostId = localSrc?.hostId ?? null;
    out.localPath = localSrc?.path ?? null;
    const there = host ? all.find((s) => s.hostId === host.id) : undefined;
    out.sourcePath = there?.path ?? null;
    if (!there && localSrc) out.suggestedPath = m1PathFor(localSrc.path);
    const busy = !!host && !!out.suggestedPath && cloning.has(`${host.id}:${out.suggestedPath}`);
    out.cloneFrom = !there && !busy && out.suggestedPath && !isShared(out.suggestedPath) && p.gitRemoteUrl && isCloneableRemote(p.gitRemoteUrl) ? redactRemote(p.gitRemoteUrl) : null;
    return out;
  }

  /**
   * Give the project a checkout on the always-on Mac at the suggested path. A folder that is
   * already there is registered as it is; otherwise, with `clone` (the default),
   * the repo is cloned onto it at that path first. Shared (NAS) folders are
   * never cloned: they are the same files on both Macs.
   */
  async function link(projectId: string, opts: { clone?: boolean } = {}): Promise<M1Machine> {
    const state = await forProject(projectId);
    const where = alwaysOnPhrase(loadProfile().profile);
    if (!state.hostId) throw new Error(`No machine named ${alwaysOnMachine(loadProfile().profile)?.label ?? "like the always-on Mac"} is enrolled in this bb.`);
    if (!state.connected) throw new Error(`${upperFirst(where)} is not connected right now.`);
    if (state.sourcePath) return state;
    const target = state.suggestedPath;
    if (!target) throw new Error(`This project has no folder on this Mac to match on ${where}.`);
    // First of all: git makes the target folder at once, so a folder that exists while a clone runs is half-cloned and must not be registered.
    const key = `${state.hostId}:${target}`;
    if (cloning.has(key)) throw new Error(`A clone to ${target} is still running on ${where}. Wait for it to finish before trying again.`);
    const seen = await withTimeout(bb.sdk.hosts.pathsExist({ hostId: state.hostId, paths: [target] }), 20_000, `Checking the folder on ${where}`).catch((e: unknown) => {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}. If the folder is on the NAS, ${where} must let bb's node read network volumes (System Settings, Privacy & Security, Files & Folders).`,
      );
    });
    if (seen.existence[target]) {
      // Checked again after the wait: a clone may have started (and made the folder) meanwhile.
      if (cloning.has(key)) throw new Error(`A clone to ${target} is still running on ${where}. Wait for it to finish before trying again.`);
      await bb.sdk.projects.sources.add({ projectId, type: "local_path", hostId: state.hostId, path: target });
      bb.log.info(`m1 machine: added source ${target} for ${projectId}`);
      return forProject(projectId);
    }
    if (opts.clone === false || isShared(target)) throw new Error(`${target} is not on ${where}. Clone or copy the project there first.`);
    const remoteUrl = ((await project(projectId).catch(() => ({}) as ProjectGet)).gitRemoteUrl ?? (state.localPath ? await localOrigin(state.localPath) : null))?.trim() ?? null;
    if (!remoteUrl) throw new Error(`${target} is not on ${where} and this project has no git remote to clone it from. Copy the folder there first.`);
    const shown = redactRemote(remoteUrl);
    if (!isCloneableRemote(remoteUrl)) throw new Error(`Not cloning ${shown} onto ${where}: only https://, ssh:// and git@ remotes are cloned. Copy the folder there first.`);
    // Checked again just before claiming it: two link() calls (a double-click) can both pass the first check.
    if (cloning.has(key)) throw new Error(`A clone to ${target} is still running on ${where}. Wait for it to finish before trying again.`);
    cloning.add(key);
    const run = bb.sdk.projects.sources.add({ projectId, type: "clone", hostId: state.hostId, remoteUrl, targetPath: target });
    // The guard lasts until bb answers, not until this stops waiting.
    void Promise.resolve(run).then(() => undefined, () => undefined).finally(() => cloning.delete(key));
    await withTimeout(run, CLONE_TIMEOUT_MS, `Cloning onto ${where}`).catch((e: unknown) => {
      const why = (e instanceof Error ? e.message : String(e)).split(remoteUrl).join(shown);
      // No { cause }: the original error may carry the remote with its credentials.
      throw new Error(`Could not clone ${shown} onto ${where} at ${target}: ${redactRemote(why)}`);
    });
    bb.log.info(`m1 machine: cloned ${shown} to ${target} for ${projectId}`);
    const after = await forProject(projectId);
    if (!after.sourcePath) throw new Error(`The clone finished but ${where} does not list ${target} as this project's folder yet. Try again in a moment.`);
    return { ...after, cloned: true };
  }

  return { m1Host, forProject, link };
}

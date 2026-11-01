// Teleport-lite: move a chat to the always-on Mac and back.
//
// bb cannot fork a thread onto another machine: the server refuses with "Fork
// environment must use the source thread's host" (tested 12 Oct 2026, bb
// 0.45.0). So a move is a brief, not a fork: the plugin writes a handoff brief
// from the conversation (the same brief a hand-over uses) and starts a NEW chat
// from it. Where that chat runs:
//   - the always-on Mac of THIS bb, when the project has a checkout there, so the
//     chat stays in this sidebar;
//   - otherwise the always-on Mac's own bb, through the existing `m1 send` handoff.
// Either way the local chat is stopped, linked to the new one (plugin
// metadata) and archived, so it can be restored. Nothing is deleted.
//
// Git: a shared folder (the NAS) needs nothing, the always-on Mac sees the same files.
// A repo is pushed so the always-on Mac can check it out: the current branch when it is
// clean, or, with uncommitted changes and the owner's say-so, a WIP commit on
// `teleport/<thread>` built from a temporary index, so neither the working
// tree nor any local branch (main included) moves. The always-on Mac works in a fresh
// worktree from that ref, leaving its own checkout alone.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { handOff, transcript } from "./server-m1";
import { isShared, type createMachines } from "./server-machines";
import { loadProfile } from "./profile/load";
import { labelPhrase, upperFirst } from "./lib/profile-text";
import { nasPair } from "./lib/profile-console";
import { Mac, alwaysOnSsh, macLabel, mac, requireHandoff } from "./server-words";


const PLUGIN_ID = "navaigate-skin";

export const teleportLinkSchema = z.object({
  /** The other side of the move, or null. */
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** "machine": a chat on the always-on Mac in this bb. "handoff": the always-on Mac's own bb. */
  via: z.enum(["machine", "handoff"]).nullable(),
  branch: z.string().nullable(),
  at: z.number().nullable(),
  /** This chat runs on the always-on Mac. */
  onM1: z.boolean(),
  /** The commit the always-on Mac started from, when this chat was moved with its work. */
  sha: z.string().nullable(),
  /** The always-on Mac's clone was seen to hold that commit. */
  verified: z.boolean().nullable(),
});
export type TeleportLink = z.infer<typeof teleportLinkSchema>;

export const teleportMoveInput = z.object({
  threadId: z.string().min(1),
  /** What to do with uncommitted changes: unset asks first. */
  dirty: z.enum(["carry", "leave"]).optional(),
});
export const teleportMoveOutput = z.object({
  /** Set when the move needs a choice first; nothing has changed yet. */
  needs: z.object({ kind: z.literal("dirty"), files: z.number(), branch: z.string().nullable() }).nullable(),
  newThreadId: z.string().nullable(),
  via: z.enum(["machine", "handoff"]).nullable(),
  url: z.string().nullable(),
  notes: z.array(z.string()),
  /** What was pushed for the always-on Mac to start from. */
  commit: z.object({ sha: z.string(), ref: z.string(), carried: z.boolean() }).nullable(),
  /** Whether the always-on Mac's clone was seen to hold that commit; null when the chat went to the always-on Mac's own bb. */
  verified: z.object({ machine: z.string(), ok: z.boolean(), sha: z.string().nullable(), message: z.string() }).nullable(),
});
export type TeleportMoveOutput = z.infer<typeof teleportMoveOutput>;

type Env = { id: string; hostId: string; path: string; isGitRepo: boolean; isWorktree: boolean; branchName: string | null; workspaceProvisionType?: string };
type ThreadGet = { thread: { id: string; projectId: string; providerId: string; title: string | null; titleFallback?: string | null; status: string }; environment: Env | null };
type Flat = ThreadGet["thread"] & { environment?: Env | null; thread?: ThreadGet["thread"] };

const PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: { ...process.env, PATH, ...opts.env }, timeout: opts.timeout ?? 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ")));
      else resolve(stdout);
    });
  });
}
const git = (cwd: string, args: string[], env?: Record<string, string>) => sh("git", args, { cwd, env, timeout: 120_000 });
const ssh = (remote: string) => sh("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alwaysOnSsh(), remote], { timeout: 120_000 });
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const branchFor = (threadId: string) => `teleport/${threadId}`;

/** A commit of everything in the working tree (tracked and untracked), on top of HEAD, without touching the index, tree or branches. */
async function wipCommit(cwd: string, message: string): Promise<string> {
  const index = path.join(os.tmpdir(), `teleport-index-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(cwd, ["read-tree", "HEAD"], env);
    await git(cwd, ["add", "-A"], env);
    // bb's own per-chat files are not work to carry.
    await git(cwd, ["rm", "-r", "--cached", "--ignore-unmatch", "-q", ".bb"], env);
    const tree = (await git(cwd, ["write-tree"], env)).trim();
    return (await git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", message])).trim();
  } finally {
    fs.rmSync(index, { force: true });
  }
}

const wipSubject = (threadId: string) => `WIP: teleport ${threadId} to ${mac()}`;

/**
 * Commit the uncommitted work (see wipCommit) and publish it as teleport/<thread>
 * on origin. Both machines write to that ref, so it is never force-pushed over
 * commits this laptop did not make. When the ref's tip is this laptop's own
 * earlier WIP commit (a move that failed after the push and is being retried),
 * it is replaced under a lease on that exact commit; any other tip, such as work
 * the always-on Mac sent back, makes the push fail and is left untouched.
 */
export async function pushWip(cwd: string, threadId: string): Promise<{ sha: string; ref: string }> {
  const sha = await wipCommit(cwd, wipSubject(threadId));
  const ref = branchFor(threadId);
  const full = `refs/heads/${ref}`;
  const remote = (await git(cwd, ["ls-remote", "origin", full])).trim().split(/\s+/)[0] ?? "";
  let own = false;
  if (remote) {
    await git(cwd, ["fetch", "--quiet", "origin", full]);
    own = (await git(cwd, ["log", "-1", "--format=%s", remote])).trim() === wipSubject(threadId);
  }
  try {
    await git(cwd, ["push", "origin", ...(own ? [`--force-with-lease=${full}:${remote}`] : []), `${sha}:${full}`]);
  } catch (e) {
    if (!remote) throw e;
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`origin/${ref} already holds ${remote}, which this laptop did not make, so it was not overwritten. Fetch and merge it (git fetch origin ${ref}) before moving again. ${cause}`, { cause: e });
  }
  return { sha, ref };
}

/** The note the move returns for carried work: the exact commit the always-on Mac starts from. */
export const carriedNote = (sha: string, ref: string, branch: string | null) =>
  `Uncommitted work pushed as WIP commit ${sha} on ${ref}; ${branch ?? "your branch"} was not touched.`;

const PUSH_STEP = "pushing to origin";

export type TeleportPush = { ref: string; sha: string; carried: boolean };

export function resumeMessage(failure: unknown, pushed: TeleportPush | null, threadId: string, step: string, started: string | null = null): string {
  const reason = (failure instanceof Error ? failure.message : String(failure)).replace(/[.\s]+$/, "");
  const head = `Teleport failed at ${step}: ${reason}.`;
  const what = pushed
    ? `Pushed ${pushed.carried ? "WIP commit" : "commit"} ${pushed.sha} to origin as ${pushed.ref}.`
    : "Nothing was pushed.";
  const resume = started
    ? `${Mac()} chat ${started} was started; this chat (${threadId}) was stopped but not archived. To resume, archive this chat or open ${started}; do not move again or you will get a second ${macLabel()} chat.`
    : step === PUSH_STEP
      ? `This chat (${threadId}) was stopped but not archived and no ${macLabel()} chat was started. Once the push works, run the move again.`
      : `This chat (${threadId}) was stopped but not archived and no ${macLabel()} chat was confirmed: the start may have reached ${mac()} before it failed. Check ${mac()} before moving again, and only if no new chat is there, run the move again${pushed?.carried ? ' with "carry"' : ""}${pushed ? ` (it re-publishes ${pushed.ref} and retries ${mac()} start)` : ""}.`;
  return [head, what, resume].join(" ");
}

export type DestinationCheck = z.infer<typeof teleportMoveOutput>["verified"] & {};

/** Reads the ref the always-on Mac just fetched and compares it with the commit that was pushed. */
export async function verifyDestination(run: (remote: string) => Promise<string>, repoPath: string, ref: string, expected: string, machine = macLabel()): Promise<DestinationCheck> {
  let actual: string;
  try {
    actual = (await run(`git -C ${q(repoPath)} rev-parse --verify ${q(`refs/remotes/origin/${ref}`)}`)).trim().split(/\s+/)[0] ?? "";
  } catch (e) {
    throw new Error(`Could not check ${labelPhrase(machine)}'s clone: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const ok = actual === expected;
  return { machine, ok, sha: actual || null, message: ok ? `${upperFirst(labelPhrase(machine))}'s clone has ${expected.slice(0, 7)} on ${ref}.` : `${upperFirst(labelPhrase(machine))}'s clone has ${actual ? actual.slice(0, 7) : "nothing"} on ${ref}, not the commit that was pushed (${expected.slice(0, 7)}).` };
}

export function createTeleport(bb: BbPluginApi, machines: ReturnType<typeof createMachines>, deps: { ssh?: (remote: string) => Promise<string> } = {}) {
  const remote = deps.ssh ?? ssh;
  /** The SDK returns the thread itself, with its environment when asked for. */
  const getThread = async (threadId: string): Promise<ThreadGet> => {
    const r = (await bb.sdk.threads.get({ threadId, include: "environment" })) as unknown as Flat;
    const thread = r.thread ?? r;
    return { thread, environment: r.environment ?? null };
  };
  const getLink = async (threadId: string): Promise<TeleportLink> => {
    const meta = (await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: PLUGIN_ID }).catch(() => ({}))) as Record<string, unknown>;
    const t = (meta.teleport ?? {}) as Partial<TeleportLink>;
    const host = await machines.m1Host().catch(() => null);
    const got = await getThread(threadId).catch(() => null);
    return {
      from: t.from ?? null,
      to: t.to ?? null,
      via: t.via ?? null,
      branch: t.branch ?? null,
      at: t.at ?? null,
      sha: t.sha ?? null,
      verified: t.verified ?? null,
      onM1: !!host && got?.environment?.hostId === host.id,
    };
  };
  const setLink = (threadId: string, link: Partial<TeleportLink>) =>
    bb.sdk.threads.updatePluginMetadata({ threadId, pluginId: PLUGIN_ID, set: { teleport: { ...link, at: Date.now() } } });

  const stopIfRunning = async (t: ThreadGet["thread"]) => {
    if (["active", "starting"].includes(t.status)) await bb.sdk.threads.stop({ threadId: t.id }).catch(() => undefined);
  };

  const briefFor = async (threadId: string, title: string, lines: string[]) => {
    const convo = await transcript(threadId);
    return [
      `# ${title}`,
      "",
      "This chat was moved here part-way through (bb cannot fork a chat across machines, so this is a brief of it).",
      "Below is the conversation so far. Work out what was being done and what is still open, then carry on",
      "from exactly where it stopped. Act on the most recent clear request; don't redo finished steps.",
      ...lines,
      "",
      "## Conversation so far",
      "",
      convo,
    ].join("\n");
  };

  /** Move a laptop chat to the always-on Mac. */
  async function move(input: z.infer<typeof teleportMoveInput>): Promise<TeleportMoveOutput> {
    requireHandoff(); // before the chat is stopped or any branch is pushed
    const got = await getThread(input.threadId);
    const t = got.thread;
    const env = got.environment;
    const title = t.title || t.titleFallback || "Moved chat";
    const notes: string[] = [];
    let m1 = await machines.forProject(t.projectId);
    const local = env?.path ?? null;

    // 1. Git: decide what the always-on Mac checks out, before anything changes.
    let branch: string | null = null;
    let carry = false;
    const isRepo = !!(local && env?.isGitRepo && !isShared(local));
    if (isRepo && local) {
      const dirty = (await git(local, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
      branch = env?.branchName ?? ((await git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null);
      if (dirty && !input.dirty) return { needs: { kind: "dirty", files: dirty, branch }, newThreadId: null, via: null, url: null, notes, commit: null, verified: null };
      carry = dirty > 0 && input.dirty === "carry";
      if (dirty && !carry) notes.push(`${dirty} uncommitted change${dirty === 1 ? "" : "s"} stayed on this laptop.`);
    }

    // 2. A repo the always-on Mac has no checkout of yet is cloned onto it first (a failure falls back to the always-on Mac's own bb).
    if (isRepo && m1.hostId && m1.connected && !m1.sourcePath && m1.suggestedPath) {
      try {
        m1 = await machines.link(t.projectId);
        notes.push(m1.cloned ? `Cloned the project onto ${mac()} at ${m1.sourcePath}.` : `Set the project up on ${mac()} at ${m1.sourcePath}.`);
      } catch (e) {
        notes.push(`Could not set the project up on ${mac()}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const viaMachine = !!(m1.hostId && m1.connected && m1.sourcePath);

    // 2b. Stop the local turn.
    await stopIfRunning(t);

    // 3. Push what the always-on Mac needs.
    let pushed: TeleportPush | null = null;
    if (isRepo && local) {
      try {
        if (carry) {
          const { sha, ref } = await pushWip(local, t.id);
          notes.push(carriedNote(sha, ref, branch));
          pushed = { ref, sha, carried: true };
          branch = ref;
        } else if (branch && branch !== "HEAD") {
          const sha = (await git(local, ["rev-parse", "HEAD"])).trim();
          await git(local, ["push", "origin", `HEAD:refs/heads/${branch}`]);
          notes.push(`Pushed ${branch} at commit ${sha}.`);
          pushed = { ref: branch, sha, carried: false };
        }
      } catch (e) {
        throw new Error(resumeMessage(e, null, t.id, PUSH_STEP), { cause: e });
      }
    }

    const lines: string[] = [];
    const share = nasPair(loadProfile().profile, os.homedir());
    if (share && isShared(local ?? "")) lines.push(`Paths under ${share.link}/ are the same files under ${share.nas}/ on ${mac()}.`);
    if (branch) lines.push(`The code is on branch ${branch} (fetched from origin into this worktree).`);
    let newThreadId: string | null = null;
    let url: string | null = null;
    let via: "machine" | "handoff" = "handoff";
    let step = `starting ${mac()} chat`;
    let verified: TeleportMoveOutput["verified"] = null;

    try {
      if (viaMachine && m1.hostId && m1.sourcePath) {
        // 4a. A new chat on the always-on Mac, in this bb.
        via = "machine";
        let environment: Record<string, unknown> = { type: "host", hostId: m1.hostId, workspace: { type: "unmanaged", path: m1.sourcePath } };
        if (isRepo && branch) {
          await remote(`git -C ${q(m1.sourcePath)} fetch origin ${q(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}`);
          if (pushed) {
            verified = await verifyDestination(remote, m1.sourcePath, branch, pushed.sha);
            if (!verified.ok) throw new Error(verified.message);
            notes.push(verified.message);
          }
          environment = { type: "host", hostId: m1.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: `origin/${branch}` } } };
        } else if (local && !isShared(local)) {
          notes.push(`Not a git repo: ${mac()} works in its own copy of the folder; local files were not carried.`);
        }
        const brief = await briefFor(t.id, title, lines);
        const made = (await bb.sdk.threads.spawn({
          projectId: t.projectId,
          environment: environment as never,
          providerId: t.providerId,
          title: `${title} · ${macLabel()}`.slice(0, 120),
          visibility: "visible",
          permissionMode: "full",
          executionInputSources: { permissionMode: "explicit", providerId: "explicit" },
          pluginMetadata: { teleport: { from: t.id, to: null, via: "machine", branch, at: Date.now() } },
          prompt: brief,
        } as never)) as unknown as { id: string };
        newThreadId = made.id;
      } else {
        // 4b. Fallback: the always-on Mac's own bb, through the existing brief handoff.
        via = "handoff";
        notes.push(m1.hostId ? `This project has no checkout on ${mac()} machine, so it went to ${mac()}'s own bb (Send to ${macLabel()}).` : `No ${macLabel()} machine in this bb, so it went to ${mac()}'s own bb (Send to ${macLabel()}).`);
        const res = await handOff({ threadId: t.id, title, providerId: t.providerId });
        newThreadId = res.m1Thread || null;
        url = res.url || null;
        notes.push(...res.notes);
      }

      step = "linking and archiving this chat";
      // 5. Link both sides, then archive the local chat (restorable from the archive).
      await setLink(t.id, { from: null, to: newThreadId, via, branch, sha: pushed?.sha ?? null, verified: verified ? verified.ok : null });
      await bb.sdk.threads.archive({ threadId: t.id });
    } catch (e) {
      throw new Error(resumeMessage(e, pushed, t.id, step, newThreadId), { cause: e });
    }
    bb.log.info(`teleport: ${t.id} -> ${newThreadId} via ${via}${branch ? ` (${branch})` : ""}`);
    bb.realtime.publish("teleport", { at: Date.now() });
    return { needs: null, newThreadId, via, url, notes, commit: pushed ? { sha: pushed.sha, ref: pushed.ref, carried: pushed.carried } : null, verified };
  }

  /** Bring a chat that runs on the always-on Mac back to the laptop chat it came from. */
  async function back(threadId: string): Promise<TeleportMoveOutput> {
    const link = await getLink(threadId);
    const got = await getThread(threadId);
    const t = got.thread;
    const notes: string[] = [];
    if (!link.onM1) throw new Error(`This chat is not running on ${mac()} machine.`);
    await stopIfRunning(t);

    // The always-on Mac's work: push it when it is a git worktree, so the laptop can fetch it.
    let branch: string | null = null;
    const m1Path = got.environment?.path ?? null;
    if (m1Path && got.environment?.isGitRepo && !isShared(m1Path)) {
      branch = link.branch && link.branch.startsWith("teleport/") ? link.branch : branchFor(link.from ?? t.id);
      const status = await ssh(`git -C ${q(m1Path)} status --porcelain`).catch(() => "");
      if (status.trim()) {
        const script = [
          "set -e",
          `cd ${q(m1Path)}`,
          'IDX="$(mktemp)"',
          'trap \'rm -f "$IDX"\' EXIT',
          'GIT_INDEX_FILE="$IDX" git read-tree HEAD',
          'GIT_INDEX_FILE="$IDX" git add -A',
          'GIT_INDEX_FILE="$IDX" git rm -r --cached --ignore-unmatch -q .bb',
          'TREE="$(GIT_INDEX_FILE="$IDX" git write-tree)"',
          `SHA="$(git commit-tree "$TREE" -p HEAD -m ${q(`WIP: teleport ${t.id} back from ${mac()}`)})"`,
          `git push origin "$SHA:refs/heads/${branch}" --force-with-lease=${branch}`,
        ].join("\n");
        await ssh(`bash -c ${q(script)}`);
        notes.push(`${Mac()}'s uncommitted work was pushed as a WIP commit on ${branch}.`);
      } else {
        await ssh(`git -C ${q(m1Path)} push origin ${q(`HEAD:refs/heads/${branch}`)} --force-with-lease=${q(branch)}`).catch((e: unknown) => {
          notes.push(`Could not push ${mac()}'s branch: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }

    const brief = await briefFor(t.id, t.title || `Back from ${mac()}`, [
      `You were working on this on the laptop, then it moved to ${mac()}. Here is what happened on ${mac()}; carry on here.`,
      ...(branch ? [`${Mac()}'s work is on branch ${branch}; fetch it (git fetch origin ${branch}) before continuing.`] : []),
    ]);

    let target = link.from;
    if (target) {
      // Restore the original laptop chat and hand it what happened on the always-on Mac.
      await bb.sdk.threads.unarchive({ threadId: target });
      await bb.sdk.threads.send({ threadId: target, mode: "auto", input: [{ type: "text", text: brief, mentions: [] }] } as never);
      await setLink(target, { from: t.id, to: null, via: "machine", branch });
    } else {
      // No laptop chat to return to: start one in the project's local checkout.
      const m1 = await machines.forProject(t.projectId);
      if (!m1.localHostId || !m1.localPath) throw new Error("This project has no checkout on the laptop to come back to.");
      const made = (await bb.sdk.threads.spawn({
        projectId: t.projectId,
        environment: { type: "host", hostId: m1.localHostId, workspace: { type: "unmanaged", path: m1.localPath } },
        providerId: t.providerId,
        title: (t.title || `Back from ${mac()}`).replace(new RegExp(` · ${macLabel().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), ""),
        visibility: "visible",
        permissionMode: "full",
        executionInputSources: { permissionMode: "explicit", providerId: "explicit" },
        pluginMetadata: { teleport: { from: t.id, to: null, via: "machine", branch, at: Date.now() } },
        prompt: brief,
      } as never)) as unknown as { id: string };
      target = made.id;
    }
    await setLink(t.id, { from: link.from, to: target, via: "machine", branch });
    await bb.sdk.threads.archive({ threadId: t.id });
    bb.log.info(`teleport back: ${t.id} -> ${target}`);
    bb.realtime.publish("teleport", { at: Date.now() });
    return { needs: null, newThreadId: target, via: "machine", url: null, notes, commit: null, verified: null };
  }

  return { getLink, move, back };
}

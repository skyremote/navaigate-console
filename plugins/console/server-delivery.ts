import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  cleanupPlanSchema,
  deliveryRpcContract,
  evidenceJoinInput,
  hostContract,
  matrixInput,
  matrixOutput,
  modelChoice,
  prActionInput,
  prResultSchema,
  proofAttachInput,
  purposeSchema,
  worktreeMergeInput,
  scopeSchema,
  settingInput,
  settingOutput,
  staleCleanupInput,
  staleCleanupOutput,
  worktreeViewSchema,
} from "./delivery-contract";
import { safePublicUrl } from "./src/delivery-model";
import { extractEvidence } from "./evidence-report";
import { priorConversationEntries, type Event } from "./server-native-context";
import { evidenceRowSchemaText } from "./src/delivery-prompts";
const explain = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function redactProof(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProof);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|secret|password|credential|authorization|cookie|email|address/i.test(key)
          ? "[redacted]"
          : redactProof(item),
      ]),
    );
  if (typeof value !== "string") return value;
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|Bearer\s+\S+)\b/gi,
      "[credential]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[url]";
      }
    })
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[network-address]")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "/[home]");
}
type Entry = z.infer<typeof scopeSchema> & {
  purpose: z.infer<typeof purposeSchema>;
  choice: z.infer<typeof modelChoice>;
};
type Settings = { revision: number; entries: Entry[] };
export function resolveDeliverySettings(state: Settings, scope: z.infer<typeof scopeSchema>) {
  return settingOutput.parse({
    ...state,
    appliedTo: "delivery-tasks",
    remoteApplied: false,
    resolved: purposeSchema.options.map((purpose) => {
      const entry = state.entries
        .filter(
          (item) =>
            item.purpose === purpose &&
            (item.projectId === null || item.projectId === scope.projectId) &&
            (item.hostId === null || item.hostId === scope.hostId),
        )
        .sort(
          (a, b) =>
            (b.projectId ? 2 : 0) +
            (b.hostId ? 1 : 0) -
            ((a.projectId ? 2 : 0) + (a.hostId ? 1 : 0)),
        )[0];
      return {
        purpose,
        choice: entry?.choice ?? null,
        inheritedFrom: entry ? { projectId: entry.projectId, hostId: entry.hostId } : null,
      };
    }),
  });
}
type ProviderProbe =
  | { kind: "listed"; models: string[] }
  | { kind: "unavailable"; reason: string }
  | { kind: "unknown"; reason: string };
export type HostProbe = {
  hostId: string;
  name: string;
  connected: boolean;
  probes: Record<string, ProviderProbe>;
};
/** Applied means the owner machine currently lists the resolved provider and model; nothing is pushed to it. */
export function buildDeliveryMatrix(state: Settings, projectId: string | null, hosts: HostProbe[]) {
  return matrixOutput.parse({
    revision: state.revision,
    readAt: Date.now(),
    hosts: hosts.map((host) => ({
      hostId: host.hostId,
      name: host.name,
      connected: host.connected,
      cells: resolveDeliverySettings(state, {
        projectId,
        hostId: host.hostId,
      }).resolved.map(({ purpose, choice, inheritedFrom }) => {
        const cell = { purpose, choice, source: inheritedFrom };
        if (!choice)
          return {
            ...cell,
            state: "unset",
            reason: "No override applies here; the model is chosen when the task is prepared.",
          };
        if (!host.connected)
          return {
            ...cell,
            state: "unverified",
            reason: `${host.name} is offline; availability was not checked.`,
          };
        const probe = host.probes[choice.providerId];
        if (!probe || probe.kind === "unknown")
          return {
            ...cell,
            state: "unverified",
            reason: `${choice.providerId} could not be read on ${host.name}${probe ? `: ${probe.reason}` : "."}`,
          };
        if (probe.kind === "unavailable")
          return {
            ...cell,
            state: "unapplied",
            reason: `${choice.providerId} is unavailable on ${host.name}: ${probe.reason}.`,
          };
        return probe.models.includes(choice.model)
          ? {
              ...cell,
              state: "applied",
              reason: `${host.name} lists ${choice.model}.`,
            }
          : {
              ...cell,
              state: "unapplied",
              reason: `${choice.model} is not listed by ${choice.providerId} on ${host.name}.`,
            };
      }),
    })),
  });
}
const evidenceFieldHints: Record<string, string> = {
  retrievedAt:
    "use a full ISO 8601 datetime such as 2026-10-31T12:00:00Z, not a date alone",
  kind: "use one of issue, discussion, video, web, dataset",
  sourceUrl: "use the full public https URL of the original source",
};
function evidencePath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (text, part) =>
      typeof part === "number"
        ? `${text}[${part}]`
        : text
          ? `${text}.${String(part)}`
          : String(part),
    "",
  );
}
function evidenceRejection(error: z.ZodError, input: unknown): string {
  const lines = error.issues.slice(0, 10).map((issue) => {
    const where = evidencePath(issue.path) || "request";
    const value = issue.path.reduce<unknown>(
      (item, part) =>
        item && typeof item === "object"
          ? (item as Record<PropertyKey, unknown>)[part]
          : undefined,
      input,
    );
    const field = String(issue.path[issue.path.length - 1] ?? "");
    const shown =
      typeof value === "string" || typeof value === "number"
        ? ` (received ${JSON.stringify(value)})`
        : "";
    const hint = evidenceFieldHints[field]
      ? `; ${evidenceFieldHints[field]}`
      : "";
    return `- ${where}: ${issue.message}${shown}${hint}`;
  });
  const more =
    error.issues.length > lines.length
      ? `\n- ${error.issues.length - lines.length} more`
      : "";
  return `Evidence rejected, nothing was joined:\n${lines.join("\n")}${more}\n\n${evidenceRowSchemaText}`;
}
export function joinEvidence(input: unknown) {
  const request = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  if (!Array.isArray(request.evidence))
    throw new Error(
      `Evidence rejected: evidence must be an array of rows, received ${request.evidence === undefined ? "nothing" : typeof request.evidence}.\n\n${evidenceRowSchemaText}`,
    );
  const checked = evidenceJoinInput.safeParse(input);
  if (!checked.success)
    throw new Error(evidenceRejection(checked.error, input));
  const parsed = checked.data;
  const unique = new Map<string, z.infer<typeof evidenceJoinInput>["evidence"][number]>();
  for (const row of parsed.evidence) {
    const sourceUrl = safePublicUrl(row.sourceUrl);
    // Preserve different observations from one source; discard exact repeated evidence only.
    const key = `${sourceUrl}|${row.sourceId ?? ""}|${row.observation.trim().toLocaleLowerCase()}`;
    if (!unique.has(key)) unique.set(key, { ...row, sourceUrl });
  }
  const evidence = [...unique.values()];
  return {
    question: parsed.question,
    evidence,
    duplicates: parsed.evidence.length - evidence.length,
    sourceCount: new Set(evidence.map((row) => row.sourceUrl)).size,
    limitations: [
      "Evidence is supplied by the selected tools; this join does not establish complete coverage or independently verify claims.",
      "Collector cost, login scope and source terms must be checked before running a new collector.",
    ],
  };
}
export function createDelivery(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  let settingsChain: Promise<unknown> = Promise.resolve();
  const readSettings = async (): Promise<Settings> => {
    const raw = await bb.storage.kv.get<Settings>("delivery-settings:v1");
    return raw
      ? z
          .object({
            revision: z.number().int().nonnegative(),
            entries: z
              .array(scopeSchema.extend({ purpose: purposeSchema, choice: modelChoice }))
              .max(1000),
          })
          .parse(raw)
      : { revision: 0, entries: [] };
  };
  const prRead = async (environmentId: string) => {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: "bb--github-pr-status",
      method: "pullRequests",
      input: { keys: [environmentId] },
      outputSchema: z.record(z.string(), prResultSchema),
    });
    return (
      result[environmentId] ?? {
        outcome: "unavailable" as const,
        message: "No status row was returned.",
      }
    );
  };
  const freshPr = async (environmentId: string) => {
    await bb.sdk.plugins.callRpc({
      pluginId: "bb--github-pr-status",
      method: "refresh",
      input: { environmentId },
      outputSchema: z.object({ ok: z.literal(true) }),
    });
    return prRead(environmentId);
  };
  const readyEnvironment = async (environmentId: string) => {
    const environment = await bb.sdk.environments.get({ environmentId });
    if (
      !environment.path ||
      environment.status !== "ready" ||
      environment.lifecycle.phase !== "active"
    )
      throw new Error("The owner workspace is not ready.");
    const machine = await bb.sdk.hosts.get({ hostId: environment.hostId });
    if (machine.status !== "connected" || machine.lifecycle.phase !== "active")
      throw new Error(
        `${machine.name} is offline or unavailable; no cached state was treated as verified.`,
      );
    return environment;
  };
  async function queue() {
    const environments = [];
    const warnings: string[] = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const rows = await bb.sdk.environments.list({ limit: 200, offset });
      environments.push(
        ...rows
          .filter((env) => env.isGitRepo && env.status !== "destroyed")
          .map((env) => ({
            id: env.id,
            projectId: env.projectId,
            hostId: env.hostId,
            name: env.name ?? env.branchName ?? env.id,
            path: env.path,
            status: env.status,
          })),
      );
      if (rows.length < 200) return { readAt: Date.now(), environments, warnings };
    }
    warnings.push(
      "Environment inventory reached the 5,000 row bound; narrow the source server before treating this queue as complete.",
    );
    return { readAt: Date.now(), environments, warnings };
  }
  async function action(input: z.infer<typeof prActionInput>) {
    prActionInput.parse(input);
    await readyEnvironment(input.environmentId);
    const fresh = await freshPr(input.environmentId);
    if (fresh.outcome !== "available")
      throw new Error(fresh.outcome === "unavailable" ? fresh.message : "This branch has no PR.");
    if (
      fresh.pullRequest.url !== input.expectedUrl ||
      fresh.pullRequest.updatedAt !== input.expectedUpdatedAt
    )
      throw new Error(
        "The PR changed after this panel was read. Refresh and review the new status before acting.",
      );
    if (input.action === "merge" && !input.method)
      throw new Error("Choose a merge method explicitly.");
    // The native plugin does its own fresh validation and branch-rule check as well.
    return bb.sdk.plugins.callRpc({
      pluginId: "bb--github-pr-status",
      method:
        input.action === "ready" ? "markReady" : input.action === "draft" ? "markDraft" : "merge",
      input: {
        environmentId: input.environmentId,
        ...(input.action === "merge" ? { method: input.method! } : {}),
      },
      outputSchema: z.object({ message: z.string() }),
    });
  }
  async function attachProof(input: z.infer<typeof proofAttachInput>) {
    const request = proofAttachInput.parse(input);
    const environment = await readyEnvironment(request.environmentId);
    const fresh = await freshPr(request.environmentId);
    if (fresh.outcome !== "available")
      throw new Error(fresh.outcome === "unavailable" ? fresh.message : "This branch has no PR.");
    if (
      fresh.pullRequest.url !== request.expectedUrl ||
      fresh.pullRequest.updatedAt !== request.expectedUpdatedAt
    )
      throw new Error(
        "The PR changed after this panel was read. Refresh and review the new status before attaching proof.",
      );
    if (fresh.pullRequest.state !== "open" && fresh.pullRequest.state !== "draft")
      throw new Error("Proof is only attached to an open or draft PR.");
    return host.call(
      "attachProof",
      {
        cwd: environment.path!,
        prUrl: fresh.pullRequest.url,
        note: request.note,
        branch: request.branch,
        files: request.files,
      },
      { hostId: environment.hostId, timeoutMs: 180_000 },
    );
  }
  async function review(environmentId: string) {
    const environment = await readyEnvironment(environmentId);
    // A missing GitHub adapter is not a failure for another Git host.
    const pr = await freshPr(environmentId).catch(() => null);
    return host.call(
      "review",
      { cwd: environment.path!, url: pr?.outcome === "available" ? pr.pullRequest.url : null },
      { hostId: environment.hostId, timeoutMs: 60_000 },
    );
  }
  /** Which Git service each workspace's origin is on; null where the workspace or its remote cannot be read. */
  async function hosts(environmentIds: string[]) {
    const entries = await Promise.all(
      environmentIds.map(async (environmentId) => {
        try {
          const environment = await readyEnvironment(environmentId);
          const named = await host.call("gitHost", { cwd: environment.path! }, { hostId: environment.hostId, timeoutMs: 10_000 });
          return [environmentId, named] as const;
        } catch {
          return [environmentId, null] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }
  async function plan(environmentId: string, options: { store: boolean } = { store: true }) {
    const environment = await bb.sdk.environments.get({ environmentId });
    const blockers = [];
    if (
      !environment.managed ||
      !environment.isWorktree ||
      environment.workspaceProvisionType !== "managed-worktree"
    )
      blockers.push("Only BB-managed worktrees can be considered.");
    if (environment.status !== "ready" || environment.lifecycle.phase !== "active")
      blockers.push("The environment is not active and ready.");
    // Read both active and archived sets, including hidden sessions. Never assume one UI row owns a path.
    const references = [];
    for (const archived of [false, true])
      for (let offset = 0; offset < 5000; offset += 200) {
        const page = await bb.sdk.threads.list({
          environmentId,
          archived,
          includeHidden: true,
          limit: 200,
          offset,
        });
        references.push(...page);
        if (page.length < 200) break;
        if (offset === 4800) blockers.push("Thread reference inventory was truncated.");
      }
    if (references.some((thread) => thread.pinnedAt != null))
      blockers.push("A pinned thread references this worktree.");
    if (references.some((thread) => thread.deletedAt === null))
      blockers.push(
        "An undeleted thread still references this worktree, including archived tasks.",
      );
    if (references.some((thread) => !["idle", "error"].includes(thread.status)))
      blockers.push("A thread may still be running, stopping or waiting in this worktree.");
    let audit = null;
    try {
      await readyEnvironment(environmentId);
      audit = await host.call(
        "cleanupAudit",
        { cwd: environment.path! },
        { hostId: environment.hostId },
      );
      blockers.push(...audit.reasons);
      if (audit.processState !== "clear") blockers.push("Process clearance is not confirmed.");
    } catch (cause) {
      blockers.push(`Owner audit unavailable: ${explain(cause)}`);
    }
    let guarded = false;
    try {
      const safety = await bb.sdk.plugins.callRpc({
        pluginId: "environment-git-worktree",
        method: "experimental_cleanupSafety",
        input: {},
        outputSchema: z
          .object({
            version: z.literal(1),
            retainsReferences: z.literal(true),
            retainsLocalFiles: z.literal(true),
            retainsBusyWorktrees: z.literal(true),
            automaticRetirement: z.literal(false),
          })
          .strict(),
      });
      guarded = safety.version === 1;
    } catch {
      blockers.push(
        "The Worktree provider does not advertise protected cleanup version 1. Install the reviewed core patch before any removal.",
      );
    }
    const base = {
      environmentId,
      hostId: environment.hostId,
      path: environment.path,
      createdAt: Date.now(),
      blockers: [...new Set(blockers)],
      eligible: guarded && blockers.length === 0,
      execution: guarded
        ? ("protected-core-cleanup" as const)
        : ("requires-protected-core-cleanup" as const),
      audit,
    };
    const result = cleanupPlanSchema.parse({
      ...base,
      planId: randomUUID(),
      fingerprint: hash({
        environment,
        references: references.map((thread) => [
          thread.id,
          thread.status,
          thread.archivedAt,
          thread.pinnedAt,
        ]),
        audit,
      }),
    });
    if (options.store) await bb.storage.kv.set(`delivery-cleanup:${result.planId}`, result);
    return result;
  }
  const STALE_LIMIT = 30;
  const REMOTE_READ_MS = 15_000;
  const READ_BATCH = 5;
  async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    for (let at = 0; at < items.length; at += size) out.push(...(await Promise.all(items.slice(at, at + size).map(work))));
    return out;
  }
  async function staleWorktrees(input: { days: number }) {
    const DAY = 86_400_000;
    const now = Date.now();
    const warnings: string[] = [];
    const candidates = [];
    for (let offset = 0; offset < 2000; offset += 200) {
      const rows = await bb.sdk.environments.list({ limit: 200, offset });
      candidates.push(
        ...rows.filter(
          (env) =>
            env.managed &&
            env.isWorktree &&
            env.status === "ready" &&
            env.lifecycle.phase === "active",
        ),
      );
      if (rows.length < 200) break;
    }
    const aged = (
      await inBatches(candidates, READ_BATCH, async (env) => {
        let last = env.updatedAt;
        for (const archived of [false, true]) {
          const threads = await bb.sdk.threads
            .list({ environmentId: env.id, archived, includeHidden: true, limit: 200, offset: 0 })
            .catch(() => []);
          for (const thread of threads) last = Math.max(last, thread.updatedAt);
        }
        return { env, last, idleDays: Math.floor((now - last) / DAY) };
      })
    ).filter((entry) => entry.idleDays >= input.days);
    aged.sort((a, b) => a.last - b.last);
    if (aged.length > STALE_LIMIT)
      warnings.push(`Showing the ${STALE_LIMIT} longest idle of ${aged.length} stale worktrees.`);
    const checkedRows = await inBatches(aged.slice(0, STALE_LIMIT), READ_BATCH, async ({ env, last, idleDays }) => ({
      env,
      last,
      idleDays,
      checked: await plan(env.id, { store: false }),
      hostName: await bb.sdk.hosts.get({ hostId: env.hostId }).then((m) => m.name, () => env.hostId),
    }));
    const guarded: boolean | null = checkedRows.reduce<boolean | null>(
      (seen, { checked }) => seen === true || checked.execution === "protected-core-cleanup",
      null,
    );
    const rows = checkedRows.map(({ env, last, idleDays, checked, hostName }) => ({
      environmentId: env.id,
      name: env.name ?? env.branchName ?? env.id,
      branch: env.branchName,
      hostId: env.hostId,
      hostName,
      path: env.path,
      lastActivityAt: last,
      idleDays,
      plan: {
        planId: checked.planId,
        fingerprint: checked.fingerprint,
        eligible: checked.eligible,
        blockers: checked.blockers,
      },
    }));
    return { readAt: now, staleAfterDays: input.days, total: aged.length, guarded, rows, warnings };
  }
  async function staleCleanup(input: z.infer<typeof staleCleanupInput>) {
    staleCleanupInput.parse(input);
    const results: z.infer<typeof staleCleanupOutput>["results"] = [];
    for (const item of input.items) {
      try {
        const fresh = await plan(item.environmentId, { store: false });
        if (fresh.fingerprint !== item.fingerprint) {
          results.push({
            environmentId: item.environmentId,
            outcome: "skipped",
            message: "The worktree changed after it was listed. Review it again.",
          });
        } else if (!fresh.eligible) {
          results.push({
            environmentId: item.environmentId,
            outcome: "skipped",
            message: `Blocked: ${fresh.blockers.join(" ")}`,
          });
        } else {
          await bb.sdk.environments.experimental_cleanup({ environmentId: item.environmentId });
          results.push({
            environmentId: item.environmentId,
            outcome: "requested",
            message: "Protected cleanup requested.",
          });
        }
      } catch (cause) {
        results.push({ environmentId: item.environmentId, outcome: "skipped", message: explain(cause) });
      }
    }
    const requested = results.filter((r) => r.outcome === "requested").length;
    return {
      results,
      message: `Protected cleanup requested for ${requested} of ${results.length}. A request is not proof the folder is gone; the owner machine confirms removal.`,
    };
  }
  async function listProjectEnvironments(projectId: string) {
    const found = [];
    for (let offset = 0; offset < 1000; offset += 200) {
      const rows = await bb.sdk.environments.list({ limit: 200, offset });
      found.push(...rows.filter((env) => env.projectId === projectId && env.status !== "destroyed"));
      if (rows.length < 200) break;
    }
    return found;
  }
  async function worktrees(environmentId: string) {
    const environment = await readyEnvironment(environmentId);
    const warnings: string[] = [];
    const hostNames = new Map<string, string>();
    const hostName = async (hostId: string) => {
      if (!hostNames.has(hostId))
        hostNames.set(hostId, await bb.sdk.hosts.get({ hostId }).then((machine) => machine.name, () => hostId));
      return hostNames.get(hostId)!;
    };
    const local = await host.call(
      "worktrees",
      { cwd: environment.path!, base: null },
      { hostId: environment.hostId, timeoutMs: 60_000 },
    );
    const siblings = await listProjectEnvironments(environment.projectId).catch((cause) => {
      warnings.push(`Environment inventory: ${explain(cause)}`);
      return [];
    });
    const rows: z.infer<typeof worktreeViewSchema>["rows"] = [];
    for (const row of local.worktrees) {
      const match = siblings.find((env) => env.hostId === environment.hostId && env.path === row.path);
      rows.push({
        ...row,
        hostId: environment.hostId,
        hostName: await hostName(environment.hostId),
        environmentId: match?.id ?? null,
        environmentName: match?.name ?? match?.branchName ?? null,
        sameHost: true,
      });
    }
    const remotes = siblings.filter(
      (env) => env.hostId !== environment.hostId && env.isGitRepo && env.path && env.status === "ready",
    );
    const reads = await Promise.all(
      remotes.map(async (other) => {
        try {
          const remote = await host.call(
            "worktrees",
            { cwd: other.path!, base: local.base.sha },
            { hostId: other.hostId, timeoutMs: REMOTE_READ_MS },
          );
          return { other, remote, failure: null };
        } catch (cause) {
          return { other, remote: null, failure: cause };
        }
      }),
    );
    for (const { other, remote, failure } of reads) {
      if (!remote) {
        warnings.push(`${await hostName(other.hostId)} could not be read: ${explain(failure)}`);
        continue;
      }
      const own = remote.worktrees.find((row) => row.path === other.path && row.branch !== local.base.ref);
      if (own)
        rows.push({
          ...own,
          hostId: other.hostId,
          hostName: await hostName(other.hostId),
          environmentId: other.id,
          environmentName: other.name ?? other.branchName ?? null,
          sameHost: false,
        });
    }
    const touched = new Map<string, string[]>();
    for (const row of rows)
      for (const file of row.files)
        touched.set(file.path, [...(touched.get(file.path) ?? []), row.branch ?? row.path]);
    return {
      readAt: Date.now(),
      environmentId,
      hostId: environment.hostId,
      hostName: await hostName(environment.hostId),
      base: local.base,
      rows,
      overlaps: [...touched]
        .filter(([, branches]) => branches.length > 1)
        .map(([path, branches]) => ({ path, branches }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      warnings,
    };
  }
  async function worktreeMerge(input: z.infer<typeof worktreeMergeInput>) {
    worktreeMergeInput.parse(input);
    const base = await readyEnvironment(input.environmentId);
    let fetch = false;
    if (input.sourceEnvironmentId && input.sourceEnvironmentId !== input.environmentId) {
      const source = await readyEnvironment(input.sourceEnvironmentId);
      if (source.hostId !== base.hostId) {
        await host.call(
          "pushBranch",
          { cwd: source.path!, branch: input.branch, expectedHead: input.expectedHead },
          { hostId: source.hostId, timeoutMs: 60_000 },
        );
        fetch = true;
      }
    }
    const outcome = await host.call(
      "mergeBack",
      {
        cwd: base.path!,
        branch: input.branch,
        expectedHead: input.expectedHead,
        expectedBaseHead: input.expectedBaseHead,
        expectedBaseRef: input.expectedBaseRef,
        fetch,
      },
      { hostId: base.hostId, timeoutMs: 60_000 },
    );
    return {
      outcome,
      message: outcome.merged
        ? `Merged ${input.branch} into the base workspace as ${outcome.sha.slice(0, 9)}. Nothing was pushed from here and the worktree was kept.`
        : `Not merged: ${outcome.conflicts.length} file${outcome.conflicts.length === 1 ? "" : "s"} would conflict. The base workspace was not changed.`,
    };
  }
  async function evidenceFromThread(input: { threadId: string; question: string | null }) {
    const events: Event[] = [];
    let beforeSeq: string | undefined;
    for (let page = 0; page < 5; page++) {
      const entries = await bb.sdk.threads.events.list({
        threadId: input.threadId,
        order: "desc",
        limit: "100",
        types: ["client/turn/requested", "item/completed", "item/started"],
        ...(beforeSeq ? { beforeSeq } : {}),
      });
      events.push(...(entries as unknown as Event[]));
      if (entries.length < 100) break;
      beforeSeq = String(Math.min(...(entries as unknown as Event[]).map((entry) => entry.seq)));
    }
    const messages = priorConversationEntries(events, input.threadId).map(({ message }) => message);
    const found = extractEvidence(messages);
    if (!found)
      return {
        found: false,
        joined: null,
        rejected: null,
        message:
          "No evidence block found in this thread. Run the research task from the Research tab; its answer ends with a fenced json block the panel reads back.",
      };
    const question = found.question ?? input.question?.trim() ?? "";
    try {
      const joined = joinEvidence({ question: question || "Research question", evidence: found.evidence });
      return {
        found: true,
        joined,
        rejected: null,
        message: `Read ${found.evidence.length} row${found.evidence.length === 1 ? "" : "s"} from the latest research answer; ${joined.evidence.length} remain after removing repeats.`,
      };
    } catch (cause) {
      return {
        found: true,
        joined: null,
        rejected: explain(cause),
        message: "The evidence block in this thread was rejected, so nothing was joined.",
      };
    }
  }
  async function diagnose(threadId: string | null) {
    const failures: string[] = [];
    let recentErrors: unknown[] = [];
    if (threadId)
      try {
        const events = await bb.sdk.threads.events.list({
          threadId,
          types: ["system/error", "provider/error"],
          order: "desc",
          limit: "10",
        });
        recentErrors = events.map((event) => {
          const text = JSON.stringify(event);
          return text.length <= 12000
            ? event
            : { id: event.id, type: event.type, truncated: true, text: text.slice(0, 12000) };
        });
      } catch (cause) {
        failures.push(`Recent failure events: ${explain(cause)}`);
      }
    let environment = null,
      hostId = null,
      projectId = null;
    if (threadId)
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        projectId = thread.projectId;
        if (thread.environmentId) {
          const env = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          hostId = env.hostId;
          environment = {
            id: env.id,
            hostId,
            status: env.status,
            lifecycle: env.lifecycle.phase,
            workspaceProvisionType: env.workspaceProvisionType,
            branchName: env.branchName,
          };
        }
      } catch (cause) {
        failures.push(`Thread context: ${explain(cause)}`);
      }
    const version = await bb.sdk.system.version().catch((cause) => {
      failures.push(`Version: ${explain(cause)}`);
      return null;
    });
    const list = await bb.sdk.plugins.list().catch((cause) => {
      failures.push(`Plugins: ${explain(cause)}`);
      return null;
    });
    const plugins =
      list?.plugins.map((plugin) => ({
        id: plugin.id,
        version: plugin.version ?? null,
        status: plugin.status,
      })) ?? [];
    return redactProof({
      createdAt: Date.now(),
      hostId,
      threadId,
      projectId,
      version,
      plugins,
      environment,
      failures,
      recentErrors,
      privacy:
        "Private review bundle. Credentials, email addresses, user-home names, URL credentials/query strings and network addresses are redacted. Review manually before sharing; screenshots and arbitrary logs are not collected.",
      proofBoundary:
        "Facts from this BB server and enrolled owner metadata only. No remote service, OS push delivery, mobile live activity or source runtime was tested by collecting this bundle.",
    }) as z.infer<typeof deliveryRpcContract.delivery_diagnose.output>;
  }
  return {
    queue,
    action,
    attachProof,
    review,
    hosts,
    plan,
    worktrees,
    worktreeMerge,
    staleWorktrees,
    staleCleanup,
    evidenceFromThread,
    diagnose,
    joinEvidence,
    async settings(scope: z.infer<typeof scopeSchema>) {
      return resolveDeliverySettings(await readSettings(), scope);
    },
    async matrix(input: z.infer<typeof matrixInput>) {
      const { projectId } = matrixInput.parse(input);
      const state = await readSettings();
      const machines = await bb.sdk.hosts.list({ type: "persistent" });
      const hosts = await Promise.all(
        machines.map(async (machine): Promise<HostProbe> => {
          const connected = machine.status === "connected";
          const probes: HostProbe["probes"] = {};
          if (connected) {
            const wanted = new Set(
              resolveDeliverySettings(state, {
                projectId,
                hostId: machine.id,
              }).resolved.flatMap((entry) => (entry.choice ? [entry.choice.providerId] : [])),
            );
            await Promise.all(
              [...wanted].map(async (providerId) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  const answer = await Promise.race([
                    bb.sdk.providers.models({
                      hostId: machine.id,
                      providerId,
                      ...(projectId ? { projectId } : {}),
                    }),
                    new Promise<never>((_, reject) => {
                      timer = setTimeout(() => reject(new Error("the machine did not answer in time")), 15_000);
                    }),
                  ]).finally(() => clearTimeout(timer));
                  const failure = answer.modelLoadError;
                  probes[providerId] = failure
                    ? failure.code === "timeout"
                      ? {
                          kind: "unknown",
                          reason: "the machine did not answer in time",
                        }
                      : { kind: "unavailable", reason: failure.code }
                    : {
                        kind: "listed",
                        models: answer.models.flatMap((model) => [model.model, model.id]),
                      };
                } catch (cause) {
                  probes[providerId] = {
                    kind: "unknown",
                    reason: explain(cause),
                  };
                }
              }),
            );
          }
          return { hostId: machine.id, name: machine.name, connected, probes };
        }),
      );
      return buildDeliveryMatrix(state, projectId, hosts);
    },
    settingsSet(input: z.infer<typeof settingInput>) {
      const next = settingsChain.then(async () => {
        const state = await readSettings();
        if (state.revision !== input.expectedRevision)
          throw new Error("Settings changed in another view. Reload before saving your override.");
        const entries = state.entries.filter(
          (entry) =>
            !(
              entry.projectId === input.projectId &&
              entry.hostId === input.hostId &&
              entry.purpose === input.purpose
            ),
        );
        if (input.choice)
          entries.push({
            projectId: input.projectId,
            hostId: input.hostId,
            purpose: input.purpose,
            choice: input.choice,
          });
        const updated = { revision: state.revision + 1, entries };
        await bb.storage.kv.set("delivery-settings:v1", updated);
        bb.realtime.publish("delivery-settings", {});
        return resolveDeliverySettings(updated, input);
      });
      settingsChain = next.catch(() => undefined);
      return next;
    },
    async cleanupApply(input: {
      planId: string;
      fingerprint: string;
      intent: "explicit-user-action";
    }): Promise<{ message: string }> {
      const old = await bb.storage.kv.get<z.infer<typeof cleanupPlanSchema>>(
        `delivery-cleanup:${input.planId}`,
      );
      if (!old || old.fingerprint !== input.fingerprint || Date.now() - old.createdAt > 60_000)
        throw new Error("This cleanup plan is missing, changed or expired. Inspect a new plan.");
      const fresh = await plan(old.environmentId, { store: false });
      if (fresh.fingerprint !== old.fingerprint)
        throw new Error("The worktree changed after the plan was read. Review a fresh plan.");
      if (!fresh.eligible) throw new Error(`Cleanup is blocked: ${fresh.blockers.join(" ")}`);
      await bb.sdk.environments.experimental_cleanup({ environmentId: old.environmentId });
      return {
        message:
          "Protected cleanup requested through BB core. This acknowledgement is not proof that removal completed; inspect the environment's teardown result.",
      };
    },
  };
}

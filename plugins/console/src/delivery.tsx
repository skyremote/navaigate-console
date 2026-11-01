import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_ProviderModelPicker as ModelPicker,
  experimental_saveFile as saveFile,
  experimental_useRpcKeyedQuery as useKeyed,
  useBbContext,
  useBbNavigate,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import {
  deliveryRpcContract,
  nativePrContract,
  purposeSchema,
  type prResultSchema,
  type queueSchema,
  type gitHostSchema,
  type reviewSchema,
  type matrixOutput,
  type settingOutput,
  type cleanupPlanSchema,
} from "../delivery-contract";
import {
  hostBadge,
  mergeRequestFrom,
  readiness,
  readinessGroup,
  readinessSummary,
  reviewHeader,
  type MergeRequestLine,
} from "./delivery-model";
import { useItemStyles } from "./folders";
import { IconDialog } from "./rail-icons";
import { HelperModels } from "./delivery-helpers";
import { ProofAttach } from "./delivery-proof-panel";
import { DeliveryMatrixTable } from "./delivery-matrix";
import { rpcFlight } from "./rpc-flight";
import { useVisibleRealtime } from "./visible-poll";
import {
  reviewChanges,
  reviewTaskContext,
  type DeliveryPurpose,
} from "./delivery-prompts";
import { ReviewTourPanel } from "./delivery-tour";
import { FeatureOff } from "./feature-off";
import { useFeature } from "./use-feature";
import { ResearchPanel } from "./delivery-research";
import { FleetDoctorPanel } from "./delivery-doctor";
import { StaleWorktreesPanel } from "./delivery-stale";
import { WorktreesPanel } from "./delivery-worktrees";
export { TourCheck } from "./delivery-tour";
import { button, errorText, TaskDraft } from "./delivery-shared";
import { SourceNotices } from "./source-notices-view";
import { field, pageTitle, pageLede } from "./controls";
import { display } from "./shared";
type Queue = z.infer<typeof queueSchema>;
type Result = z.infer<typeof prResultSchema>;
/** Core's rebindable command and a normal native tab point at this same view. */
const SECTIONS = [
  ["pull-requests", "Pull requests"],
  ["worktrees", "Worktrees"],
  ["research", "Research"],
  ["diagnosis", "Diagnosis"],
  ["models", "Models"],
] as const;
export type DeliverySection = (typeof SECTIONS)[number][0];
export function DeliveryPanel({
  threadId,
  section = "pull-requests",
}: {
  threadId?: string;
  section?: DeliverySection;
}) {
  const [tab, setTab] = useState<DeliverySection>(section);
  // Each Delivery view follows its own ticks: pull requests (F67), worktrees (F63), research (F80, F81),
  // diagnosis (F75), models (F68, F73, F79). Readiness grouping (F70), GitLab (F66), the stale list (S06).
  const f80 = useFeature("F80"), f81 = useFeature("F81"), f68 = useFeature("F68"), f73 = useFeature("F73"), f79 = useFeature("F79");
  const on = {
    "pull-requests": useFeature("F67"),
    worktrees: useFeature("F63"),
    research: f80 || f81,
    diagnosis: useFeature("F75"),
    models: f68 || f73 || f79,
  } as const;
  const groupingOn = useFeature("F70");
  const gitlabOn = useFeature("F66");
  const staleOn = useFeature("S06");
  const sections = SECTIONS.filter(([id]) => on[id]);
  if (sections.length > 0 && !on[tab]) setTab(sections[0]![0]);
  const rpc = useRpc<typeof deliveryRpcContract>();
  const sdk = useSdk();
  const connection = useRealtimeConnectionState();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [ownEnvironmentId, setOwnEnvironmentId] = useState<string | null>(null);
  const [ownThreadId, setOwnThreadId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [page, setPage] = useState(0);
  const [hosts, setHosts] = useState<Record<string, z.infer<typeof gitHostSchema> | null>>({});
  const [mergeRequests, setMergeRequests] = useState<Record<string, MergeRequestLine>>({});
  const [readingMergeRequests, setReadingMergeRequests] = useState(false);
  const serial = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++serial.current;
    void rpc.call("delivery_queue", null).then(
      (value) => {
        if (seq === serial.current) {
          setQueue(value);
          setError(null);
        }
      },
      (cause) => {
        if (seq === serial.current) setError(errorText(cause));
      },
    );
  }, [rpc]);
  useEffect(() => {
    refresh();
    return () => {
      serial.current++;
    };
  }, [refresh]);
  useEffect(() => {
    let live = true;
    if (threadId)
      void sdk.threads
        .get({ threadId })
        .then((thread) => {
          if (live && thread.environmentId) {
            setSelection(thread.environmentId);
            setOwnEnvironmentId(thread.environmentId);
            setOwnThreadId(threadId ?? null);
          }
        })
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sdk, threadId]);
  const filtered = useMemo(
    () =>
      (queue?.environments ?? []).filter(
        (env) =>
          (!hostFilter || env.hostId === hostFilter) &&
          `${env.name} ${env.projectId}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [queue, search, hostFilter],
  );
  // The native watcher receives only one bounded page; it owns all timers, dedupe and freshness.
  const visible = filtered.slice(page * 200, (page + 1) * 200);
  const watched = useKeyed({
    pluginId: "bb--github-pr-status",
    contract: nativePrContract,
    method: "pullRequests",
    keys: visible.map((env) => env.id),
  });
  const watcherUnavailable = watched.error
    ? watched.error.message
    : connection !== "connected"
      ? "The BB realtime connection is unavailable; cached PR rows are unverified."
      : error
        ? "The workspace inventory could not refresh."
        : null;
  const results = watcherUnavailable ? {} : (watched.data ?? {});
  const unwatched = visible.filter((env) => results[env.id]?.outcome !== "available" && !(env.id in hosts)).map((env) => env.id).slice(0, 50);
  const unwatchedKey = unwatched.join(",");
  useEffect(() => {
    if (!unwatchedKey) return;
    const ids = unwatchedKey.split(",");
    let live = true;
    void rpc.call("delivery_hosts", { environmentIds: ids }).then(
      (found) => { if (live) setHosts((previous) => ({ ...previous, ...found })); },
      () => { if (live) setHosts((previous) => ({ ...previous, ...Object.fromEntries(ids.map((id) => [id, null])) })); },
    );
    return () => { live = false; };
  }, [rpc, unwatchedKey]);
  const gitlabRows = visible.filter((env) => hosts[env.id]?.hostKind === "gitlab" && !(env.id in mergeRequests));
  const readMergeRequests = async () => {
    setReadingMergeRequests(true);
    try {
      for (const env of gitlabRows.slice(0, 10)) {
        const found = await rpc.call("delivery_review", { environmentId: env.id }).then((review) => mergeRequestFrom(review), () => null);
        if (found) setMergeRequests((previous) => ({ ...previous, [env.id]: found }));
      }
    } finally {
      setReadingMergeRequests(false);
    }
  };
  const rows = [...visible].sort(
    (a, b) =>
      readiness(results[a.id]).tier - readiness(results[b.id]).tier || a.name.localeCompare(b.name),
  );
  const current = queue?.environments.find((env) => env.id === selection);
  const summary = groupingOn ? readinessSummary(rows, results) : rows.length ? [{ group: "All", count: rows.length }] : [];
  const detailThreadId =
    ownThreadId === threadId && current?.id === ownEnvironmentId ? threadId : undefined;
  if (sections.length === 0) return <FeatureOff id="F67" />;
  return (
    <main
      className="h-full space-y-4 overflow-auto px-7 py-6 text-foreground"
      aria-label="Delivery workspace"
    >
      <header className="flex flex-wrap justify-between gap-2">
        <div>
          <h1 className={pageTitle} style={display}>Delivery</h1>
          <p className={pageLede}>
            Owner workspaces on each machine and the pull requests they open. The host rules decide
            whether a merge is allowed.
          </p>
        </div>
        <button className={button} onClick={refresh}>
          Refresh inventory
        </button>
      </header>
      <div role="tablist" aria-label="Delivery sections" className="flex flex-wrap gap-1 border-b">
        {sections.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`delivery-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`delivery-panel-${id}`}
            className={`min-h-9 rounded-t px-3 py-1 text-[13px] hover:bg-accent ${tab === id ? "border-b-2 border-foreground font-medium" : "text-muted-foreground"}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-[13px] text-destructive-text">{error}</p>}
      <div role="tabpanel" id={`delivery-panel-${tab}`} aria-labelledby={`delivery-tab-${tab}`} className="space-y-4">
        {tab === "pull-requests" && (
          <>
            {watcherUnavailable && (
              <p role="alert">
                {watcherUnavailable}{" "}
                <button className={button} onClick={() => void watched.refetch()}>
                  Retry PR read
                </button>
              </p>
            )}
            {queue?.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            <nav className="flex flex-wrap gap-2" aria-label="Delivery filters">
              <input
                className={`${field}`}
                aria-label="Filter delivery tasks"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
                placeholder="Filter branch or project"
              />
              {gitlabOn && gitlabRows.length > 0 && (
                <button className={button} disabled={readingMergeRequests} onClick={() => void readMergeRequests()}>
                  Read GitLab merge requests
                </button>
              )}
              <select
                className={`${field}`}
                aria-label="Owner machine"
                value={hostFilter}
                onChange={(event) => {
                  setHostFilter(event.target.value);
                  setPage(0);
                }}
              >
                <option value="">All enrolled hosts on this server</option>
                {[...new Set(queue?.environments.map((env) => env.hostId))].map((host) => (
                  <option key={host}>{host}</option>
                ))}
              </select>
            </nav>
            <p className="text-xs text-muted-foreground">
              This server's enrolled hosts only; independent Fleet servers need their own queue.
              Status read time is provider-owned. Refresh a PR before a decision. Workspaces whose
              PR cannot be read show as Unverified: that includes machines that are offline and
              non-GitHub hosts. A GitLab row shows its merge request once you press Read GitLab merge
              requests.
            </p>
            {summary.length > 0 && (
              <p className="flex flex-wrap gap-x-3 text-[13px]" aria-label="Readiness summary">
                {summary.map((entry) => (
                  <span key={entry.group}>
                    {entry.group} {entry.count}
                  </span>
                ))}
              </p>
            )}
            {!queue ? (
              <p>Loading owner workspaces…</p>
            ) : !rows.length ? (
              <p>No matching Git workspaces</p>
            ) : (
              <div className="space-y-3">
                {summary.map((entry) => (
                  <section key={entry.group} className="space-y-2">
                    <h3 className="text-[13px] font-medium text-muted-foreground">
                      {entry.group} ({entry.count})
                    </h3>
                    <ul className="space-y-2">
                      {rows
                        .filter((env) => !groupingOn || readinessGroup(readiness(results[env.id]).tier) === entry.group)
                        .map((env) => {
                          const result = results[env.id];
                          return (
                            <li key={env.id}>
                              <button
                                className={`${button} w-full text-left ${selection === env.id ? "bg-accent" : ""}`}
                                onClick={() => setSelection(env.id)}
                              >
                                <span className="block font-medium">
                                  {result?.outcome === "available"
                                    ? `#${result.pullRequest.number} ${result.pullRequest.title}`
                                    : mergeRequests[env.id]?.number
                                      ? `!${mergeRequests[env.id].number} ${mergeRequests[env.id].title ?? env.name}`
                                      : env.name}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {env.hostId} · {mergeRequests[env.id] && result?.outcome !== "available" ? `Merge request${mergeRequests[env.id].state ? ` ${mergeRequests[env.id].state}` : ""}` : readiness(result).label}
                                  {result?.outcome === "unavailable" ? ` · ${result.message}` : ""}
                                  {result?.outcome !== "available" && !mergeRequests[env.id] && hostBadge(hosts[env.id]) ? ` · ${hostBadge(hosts[env.id])}` : ""}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            {filtered.length > 200 && (
              <div className="flex gap-2">
                <button className={button} disabled={page === 0} onClick={() => setPage(page - 1)}>
                  Previous
                </button>
                <span>Page {page + 1}; readiness sorting applies to this page</span>
                <button
                  className={button}
                  disabled={(page + 1) * 200 >= filtered.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </button>
              </div>
            )}
            {current && (
              <DeliveryDetail
                key={current.id}
                environment={current}
                result={results[current.id]}
                threadId={detailThreadId}
              />
            )}
          </>
        )}
        {tab === "worktrees" && (
          <>
            <WorktreesPanel environmentId={selection} threadId={threadId} results={results} />
            {staleOn ? <StaleWorktreesPanel /> : null}
          </>
        )}
        {tab === "research" && <ResearchPanel threadId={threadId} />}
        {tab === "diagnosis" && (
          <>
            <Diagnosis threadId={threadId} />
            <FleetDoctorPanel />
          </>
        )}
        {tab === "models" && <DeliverySettings threadId={detailThreadId} environment={current} />}
      </div>
    </main>
  );
}
export function DeliveryDetail({
  environment,
  result,
  threadId,
}: {
  environment: Queue["environments"][number];
  result?: Result;
  threadId?: string;
}) {
  const rpc = useRpc<typeof deliveryRpcContract>(),
    sdk = useSdk(),
    navigate = useBbNavigate();
  const tourOn = useFeature("S05");
  const proofAttachOn = useFeature("F83");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<z.infer<typeof reviewSchema> | null>(null),
    [plan, setPlan] = useState<z.infer<typeof cleanupPlanSchema> | null>(null);
  const [intent, setIntent] = useState<"ready" | "draft" | "merge" | null>(null),
    [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash"),
    [proofOpen, setProofOpen] = useState(false);
  const pr = result?.outcome === "available" ? result.pullRequest : null;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const fresh = () =>
    sdk.plugins.callRpc({
      pluginId: "bb--github-pr-status",
      method: "refresh",
      input: { environmentId: environment.id },
      outputSchema: nativePrContract.refresh.output,
    });
  return (
    <section className="rounded-lg border border-border p-4 space-y-3" aria-label="Selected pull request">
      <h2 className="font-medium">{environment.name}</h2>
      <p className="break-all text-xs">
        Owner {environment.hostId} · {environment.path ?? "No workspace"}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pr && (
        <>
          <a className="underline" href={pr.url} target="_blank" rel="noreferrer">
            Open #{pr.number} on its Git host
          </a>
          <p className="text-[13px]">
            Checks: {pr.checks.state}; review: {pr.review.state}; mergeability:{" "}
            {pr.mergeability.state}. Updated {pr.updatedAt}.
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy}
          className={button}
          onClick={() =>
            void run(async () => {
              await fresh();
              setNotice("Provider status refreshed. Review the updated row before acting.");
            })
          }
        >
          Refresh PR status
        </button>
        <button
          disabled={busy}
          className={button}
          onClick={() =>
            void run(async () => {
              setReview(await rpc.call("delivery_review", { environmentId: environment.id }));
            })
          }
        >
          Read diff and review conversation
        </button>
        {pr?.state === "draft" && (
          <button disabled={busy} className={button} onClick={() => setIntent("ready")}>
            Mark ready…
          </button>
        )}
        {proofAttachOn && (pr?.state === "open" || pr?.state === "draft") && (
          <button
            disabled={busy}
            className={button}
            aria-expanded={proofOpen}
            onClick={() => setProofOpen((value) => !value)}
          >
            Attach proof to PR…
          </button>
        )}
        {pr?.state === "open" && (
          <>
            <button disabled={busy} className={button} onClick={() => setIntent("draft")}>
              Mark draft…
            </button>
            <button disabled={busy} className={button} onClick={() => setIntent("merge")}>
              Merge…
            </button>
          </>
        )}
        <button
          disabled={busy}
          className={button}
          onClick={() =>
            void run(async () => {
              setPlan(await rpc.call("delivery_cleanup_plan", { environmentId: environment.id }));
            })
          }
        >
          Review cleanup plan
        </button>
      </div>
      {proofAttachOn && proofOpen && pr && (pr.state === "open" || pr.state === "draft") && (
        <ProofAttach
          environmentId={environment.id}
          pr={pr}
          onAttached={async () => {
            await fresh();
            setNotice("Proof attached. The PR status was refreshed; review it before acting.");
          }}
        />
      )}
      {intent && pr && (
        <div className="rounded-lg border border-border p-4 space-y-2" role="group" aria-label="Confirm PR action">
          <p>
            {intent === "merge" ? "Merge" : intent === "ready" ? "Mark ready" : "Mark draft"}{" "}
            {pr.url}? This changes the real PR.
          </p>
          {intent === "merge" && (
            <select
              aria-label="Merge method"
              className={`${field}`}
              value={method}
              onChange={(event) => setMethod(event.target.value as typeof method)}
            >
              <option value="squash">Squash</option>
              <option value="merge">Merge commit</option>
              <option value="rebase">Rebase</option>
            </select>
          )}
          <div className="flex gap-2">
            <button
              disabled={busy}
              className={button}
              onClick={() =>
                void run(async () => {
                  const response = await rpc.call("delivery_action", {
                    environmentId: environment.id,
                    action: intent,
                    ...(intent === "merge" ? { method } : {}),
                    intent: "explicit-user-action",
                    expectedUrl: pr.url,
                    expectedUpdatedAt: pr.updatedAt,
                  });
                  setNotice(response.message);
                  setIntent(null);
                  await fresh();
                })
              }
            >
              Confirm {intent}
            </button>
            <button disabled={busy} className={button} onClick={() => setIntent(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {review && (
        <div className="space-y-2">
          <p className="text-xs">
            {reviewHeader(review)} · read{" "}
            {new Date(review.readAt).toLocaleString()}
          </p>
          {review.warnings.map((warning) => (
            <p className="text-[13px]" key={warning}>
              {warning}
            </p>
          ))}
          <details>
            <summary>Comments, checks and review evidence</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{review.text}</pre>
          </details>
          <details>
            <summary>PR diff {review.truncated ? "(bounded)" : ""}</summary>
            <pre className="max-h-96 overflow-auto whitespace-pre text-xs">{review.diff}</pre>
          </details>
          <TaskDraft
            purpose="review"
            threadId={threadId}
            projectId={environment.projectId}
            hostId={environment.hostId}
            context={reviewTaskContext(review)}
          />
          {tourOn ? <ReviewTourPanel changes={reviewChanges(review)} /> : null}
        </div>
      )}
      {plan && (
        <div className="space-y-2" aria-label="Protected cleanup plan">
          <h3>Protected cleanup plan</h3>
          <p className="text-xs break-all">
            Plan {plan.planId} · {plan.fingerprint}
          </p>
          <ul className="list-disc pl-5 text-[13px]">
            {plan.blockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {plan.eligible ? (
            <button
              disabled={busy}
              className={button}
              onClick={() =>
                void run(async () => {
                  const result = await rpc.call("delivery_cleanup_apply", {
                    planId: plan.planId,
                    fingerprint: plan.fingerprint,
                    intent: "explicit-user-action",
                  });
                  setNotice(result.message);
                  setPlan(null);
                })
              }
            >
              Confirm protected cleanup of this path
            </button>
          ) : (
            <p className="text-[13px]">
              Cleanup is blocked by the reasons above. No files have been deleted.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
export function DeliverySettings({
  threadId,
  environment,
}: {
  threadId?: string;
  environment?: Queue["environments"][number];
}) {
  const rpc = useRpc<typeof deliveryRpcContract>(),
    context = useBbContext();
  const [settings, setSettings] = useState<z.infer<typeof settingOutput> | null>(null),
    [purpose, setPurpose] = useState<DeliveryPurpose>("pull-request"),
    [scope, setScope] = useState("project-machine"),
    [error, setError] = useState("");
  const [choice, setChoice] = useState<ExperimentalProviderModelPickerValue>({
    providerId: "",
    model: "",
    reasoningLevel: "medium",
  });
  const projectId = environment?.projectId ?? context.projectId,
    hostId = environment?.hostId ?? null;
  const [matrix, setMatrix] = useState<z.infer<typeof matrixOutput> | null>(null),
    [matrixError, setMatrixError] = useState("");
  const settingsRequest = useRef(0),
    matrixRequest = useRef(0);
  const currentScope = useRef(JSON.stringify([projectId, hostId]));
  currentScope.current = JSON.stringify([projectId, hostId]);
  const loadSettings = useCallback(
    (fresh: boolean) => {
      const seq = ++settingsRequest.current;
      void rpcFlight()
        .call(`delivery_settings:${projectId ?? ""}:${hostId ?? ""}`, () => rpc.call("delivery_settings", { projectId, hostId }), { fresh })
        .then(
          (value) => {
            if (seq === settingsRequest.current) setSettings(value);
          },
          (cause) => {
            if (seq === settingsRequest.current) setError(errorText(cause));
          },
        );
    },
    [rpc, projectId, hostId],
  );
  const loadMatrix = useCallback(
    (fresh: boolean) => {
      const seq = ++matrixRequest.current;
      void rpcFlight()
        .call(`delivery_matrix:${projectId ?? ""}`, () => rpc.call("delivery_matrix", { projectId }), { fresh })
        .then(
          (value) => {
            if (seq !== matrixRequest.current) return;
            setMatrix(value);
            setMatrixError("");
          },
          (cause) => {
            if (seq === matrixRequest.current) setMatrixError(errorText(cause));
          },
        );
    },
    [rpc, projectId],
  );
  const refresh = useCallback(() => loadSettings(true), [loadSettings]);
  useEffect(() => {
    setSettings(null);
    setMatrix(null);
    loadSettings(false);
    loadMatrix(false);
    return () => {
      settingsRequest.current++;
      matrixRequest.current++;
    };
  }, [loadSettings, loadMatrix]);
  useVisibleRealtime("delivery-settings", () => {
    loadSettings(true);
    loadMatrix(true);
  });
  const validScope = !(
    (scope.includes("machine") && !hostId) ||
    (scope.includes("project") && !projectId)
  );
  const save = async (inherit: boolean) => {
    try {
      if (!settings) return;
      const scopeAtSave = JSON.stringify([projectId, hostId]);
      const saved = await rpc.call("delivery_settings_set", {
        projectId: scope === "global" || scope === "machine" ? null : projectId,
        hostId: scope === "global" || scope === "project" ? null : hostId,
        purpose,
        choice: inherit ? null : choice,
        expectedRevision: settings.revision,
      });
      if (currentScope.current !== scopeAtSave) return;
      setSettings(saved);
      setError("");
      refresh();
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <section className="space-y-4 rounded-lg border border-border p-4" aria-label="Delivery model settings">
      <h2 className="text-[15px] font-medium leading-6">Models by task, project and machine</h2>
      <p className="text-[13px] leading-5 text-muted-foreground">
        These overrides apply to tasks prepared here. Core's automatic titles and commit helpers
        keep their AI Services selections, and offline machines are not configured remotely.
      </p>
      <ul className="space-y-1 text-[13px]">
        {settings?.resolved.map((entry) => (
          <li key={entry.purpose} className="text-muted-foreground">
            <span className="text-foreground">{entry.purpose}</span>:{" "}
            {entry.choice
              ? `${entry.choice.providerId} / ${entry.choice.model}`
              : "Choose explicitly"}{" "}
            ·{" "}
            {entry.inheritedFrom
              ? `project ${entry.inheritedFrom.projectId ?? "all"}, machine ${entry.inheritedFrom.hostId ?? "all"}`
              : "no override"}
          </li>
        ))}
      </ul>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium">Across machines</h3>
          <button className={button} onClick={() => loadMatrix(true)}>
            Check machines
          </button>
        </div>
        <p className="text-[13px] leading-5 text-muted-foreground">
          Applied means the machine currently lists that provider and model. Nothing is pushed to a
          machine from here; the choice is used when a task is prepared for it.
        </p>
        {matrix ? (
          <DeliveryMatrixTable matrix={matrix} />
        ) : (
          !matrixError && <p className="text-[13px] text-muted-foreground">Checking machines</p>
        )}
        {matrixError && (
          <p role="alert" className="text-[13px] text-destructive-text">
            {matrixError}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          className={field}
          aria-label="Task purpose"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value as DeliveryPurpose)}
        >
          {purposeSchema.options.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          className={field}
          aria-label="Override scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="project-machine">This project and machine</option>
          <option value="project">This project</option>
          <option value="machine">This machine</option>
          <option value="global">All delivery tasks</option>
        </select>
      </div>
      <ModelPicker
        value={choice}
        onChange={setChoice}
        routing={hostId ? { kind: "host", hostId } : undefined}
      />
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          disabled={!choice.model || !settings || !validScope}
          onClick={() => void save(false)}
        >
          Save override
        </button>
        <button
          className={button}
          disabled={!settings || !validScope}
          onClick={() => void save(true)}
        >
          Remove this scope's override
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <HelperModels choice={choice} purpose={purpose} />
      <TaskDraft
        purpose={purpose}
        threadId={threadId}
        projectId={projectId}
        hostId={hostId}
        context={`Purpose: ${purpose}. Project ${projectId ?? "personal"}; owner ${hostId ?? "choose native owner"}. Inspect the current task and repository state.`}
      />
      <CoreEntries projectId={projectId} />
    </section>
  );
}
export function CoreEntries({ projectId }: { projectId: string | null }) {
  const noticesOn = useFeature("F79");
  const chooseIconOn = useFeature("EXTRA-B");
  const [iconOpen, setIconOpen] = useState(false);
  const itemStyles = useItemStyles(null, iconOpen);
  const navigate = useBbNavigate();
  return (
    <details>
      <summary>Existing native entry points</summary>
      <div className="space-y-2 text-[13px]">
        <p>
          Use Settings → Appearance for themes, fonts and conversation width; Settings → Keyboard
          for rebindable commands; Project icon below to change this project's icon; Settings → AI Services for
          automatic title/commit services; Settings → Mobile for real mobile push. Live Activities
          requires a mobile client and ActivityKit/APNs support.
        </p>
        <div className="flex flex-wrap gap-2">
          <a className={button} href="/settings/appearance">
            Appearance
          </a>
          <a className={button} href="/settings/keyboard">
            Keyboard bindings
          </a>
          <a className={button} href="/settings/ai-services">
            Automatic helpers
          </a>
          <a className={button} href="/settings/mobile">
            Mobile and push
          </a>
          {chooseIconOn && projectId && (
            <button className={button} onClick={() => setIconOpen(true)}>
              Project icon
            </button>
          )}
        </div>
        <button
          className={button}
          onClick={() => navigate.toCompose({ initialPrompt: "", focusPrompt: true })}
        >
          New projectless task / choose project and machine
        </button>
        {projectId ? (
          <IconDialog
            target={iconOpen ? { kind: "project", id: projectId, name: "this project" } : null}
            store={itemStyles}
            onClose={() => setIconOpen(false)}
          />
        ) : null}
        <p>
          For isolated coding work, choose a project, owner machine and Managed worktree in the
          native new-thread environment picker. Existing Git providers retain repository ownership
          and logins.
        </p>
        <p>
          Inspect source:{" "}
          <a
            className="underline"
            href="https://github.com/get-bb/bb"
            target="_blank"
            rel="noreferrer"
          >
            BB
          </a>{" "}
          ·{" "}
          <a
            className="underline"
            href="https://github.com/pingdotgg/t3code"
            target="_blank"
            rel="noreferrer"
          >
            T3 Code
          </a>
          . Check each source licence before copying.
        </p>
        {noticesOn ? <SourceNotices /> : null}
      </div>
    </details>
  );
}
function Diagnosis({ threadId }: { threadId?: string }) {
  const rpc = useRpc<typeof deliveryRpcContract>();
  const [bundle, setBundle] = useState(""),
    [error, setError] = useState("");
  return (
    <section className="rounded-lg border border-border p-4 space-y-2">
      <h2 className="font-medium">Private diagnosis</h2>
      <button
        className={button}
        onClick={() =>
          void rpc.call("delivery_diagnose", { threadId: threadId ?? null }).then(
            (result) => {
              setBundle(JSON.stringify(result, null, 2));
              setError("");
            },
            (cause) => setError(errorText(cause)),
          )
        }
      >
        Collect context and version proof
      </button>
      {error && <p role="alert">{error}</p>}
      {bundle && (
        <>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{bundle}</pre>
          <button
            className={button}
            onClick={() => {
              void saveFile({
                fileName: "bb-private-diagnosis.json",
                blob: new Blob([bundle], { type: "application/json" }),
              }).then(
                (outcome) => {
                  if (outcome === "failed") setError("The native/browser save could not start.");
                },
                (cause) => setError(errorText(cause)),
              );
            }}
          >
            Download private bundle
          </button>
          <p className="text-xs">
            Review before sharing. The native/browser save starts a local download or share;
            completion is unconfirmed and there is no external upload receipt.
          </p>
        </>
      )}
    </section>
  );
}

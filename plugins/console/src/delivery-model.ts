import type { PrResult } from "../delivery-contract";
/** Deterministic display ordering. This never grants merge permission. */
export function readiness(result: PrResult | undefined): { tier: number; label: string } {
  if (!result || result.outcome === "unavailable") return { tier: 8, label: "Unverified" };
  if (result.outcome === "absent") return { tier: 9, label: "No PR" };
  const pr = result.pullRequest;
  if (pr.state === "merged" || pr.state === "closed")
    return { tier: 10, label: pr.state === "merged" ? "Merged" : "Closed" };
  if (pr.state === "draft") return { tier: 6, label: "Draft" };
  if (pr.mergeability.state === "conflicts") return { tier: 7, label: "Conflicts" };
  if (pr.checks.state === "failing" || pr.review.state === "changes_requested")
    return {
      tier: 5,
      label: pr.checks.state === "failing" ? "Checks failed" : "Changes requested",
    };
  if (pr.mergeability.state === "blocked") return { tier: 4, label: "Blocked by host rules" };
  if (pr.checks.state === "unknown" || pr.mergeability.state === "unknown")
    return { tier: 3, label: "Checks or mergeability unknown" };
  if (pr.checks.state === "pending") return { tier: 2, label: "Checks pending" };
  if (pr.review.state !== "approved") return { tier: 1, label: "Review needed" };
  return { tier: 0, label: pr.inMergeQueue ? "Queued" : "Likely ready; host rules apply" };
}
export function matrixCellLabel(state: "applied" | "unapplied" | "unverified" | "unset"): string {
  return {
    applied: "Applied",
    unapplied: "Not available here",
    unverified: "Not checked",
    unset: "Not set",
  }[state];
}
export function safePublicUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    /^(localhost|.*\.local|127\..*|0\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|\[.*\])$/i.test(
      url.hostname,
    )
  )
    throw new Error("Use a public HTTPS source URL without credentials or a private host.");
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  return url.toString();
}

type HostInfo = { host: string; hostKind: "github" | "gitlab" | "bitbucket" | "azure" | "other"; label: string; reviewAdapter: boolean };
/** What a workspace row says about its Git host when the GitHub watcher has no pull request for it. */
export function hostBadge(host: HostInfo | null | undefined): string | null {
  if (!host || host.hostKind === "github") return null;
  if (host.hostKind === "gitlab") return "GitLab: read its merge request";
  return `${host.label}: no review adapter yet`;
}

export type MergeRequestLine = { number: number | null; title: string | null; state: string | null; url: string | null };
/** The merge request a GitLab review read describes, from the host's own JSON; the URL alone when the text was cut short. */
export function mergeRequestFrom(review: { provider: string; url: string | null; text: string }): MergeRequestLine | null {
  if (review.provider !== "gitlab") return null;
  let number: number | null = null;
  let title: string | null = null;
  let state: string | null = null;
  try {
    const mr = (JSON.parse(review.text) as { mergeRequest?: { iid?: unknown; title?: unknown; state?: unknown; draft?: unknown } }).mergeRequest;
    if (typeof mr?.iid === "number") number = mr.iid;
    if (typeof mr?.title === "string") title = mr.title;
    if (typeof mr?.state === "string") state = mr.draft === true && mr.state === "opened" ? "draft" : mr.state;
  } catch { /* The text was bounded; the URL still names the merge request. */ }
  number ??= Number(/\/merge_requests\/(\d+)/.exec(review.url ?? "")?.[1]) || null;
  return { number, title, state, url: review.url };
}

/** The header of a review read: the host by name, with the merge request or pull request wording that host uses. */
export function reviewHeader(review: { provider: string; host?: string; hostKind?: string; revision: string | null }): string {
  const label = review.hostKind === "gitlab" ? "GitLab" : review.hostKind === "github" ? "GitHub" : review.hostKind === "bitbucket" ? "Bitbucket" : review.hostKind === "azure" ? "Azure DevOps" : review.host ?? review.provider;
  return `${label}${review.host && label !== review.host ? ` (${review.host})` : ""} · head ${review.revision ?? "unknown"}`;
}

const GROUPS: Record<number, string> = {
  0: "Likely ready",
  1: "Review needed",
  2: "Checks pending",
  3: "Unknown",
  4: "Blocked",
  5: "Needs work",
  6: "Draft",
  7: "Conflicts",
  8: "Unverified",
  9: "No PR",
  10: "Merged or closed",
};
export const readinessGroup = (tier: number) => GROUPS[tier] ?? "Other";
/** Rows per readiness group, in the order the list shows them. */
export function readinessSummary<T extends { id: string }>(
  rows: T[],
  results: Record<string, PrResult | undefined>,
): { group: string; count: number }[] {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const tier = readiness(results[row.id]).tier;
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, count]) => ({ group: readinessGroup(tier), count }));
}
export function matrixSourceLabel(
  source: { projectId: string | null; hostId: string | null } | null,
  hostId: string,
): string {
  if (!source) return "";
  return source.hostId === hostId ? "Set for this machine" : "Inherited from all machines";
}
export type HelperChoice = { providerId: string; model: string; reasoningLevel: string };
export function helperKind(choice: HelperChoice | null | undefined): "claude" | "codex" | null {
  if (!choice?.model) return null;
  const provider = choice.providerId.toLowerCase();
  if (provider.includes("claude")) return "claude";
  if (provider.includes("codex")) return "codex";
  return null;
}
type AiSelection = { mode: "automatic" } | { mode: "off" } | { mode: "service"; pluginId: string; serviceId: string };
type AiService = {
  id: string;
  pluginId: string;
  displayName: string;
  status: { ready: true } | { ready: false; message: string };
};
export function describeSelection(selection: AiSelection, services: readonly AiService[]): string {
  if (selection.mode === "automatic") return "Automatic: bb picks the first ready service";
  if (selection.mode === "off") return "Off";
  const service = services.find((entry) => entry.pluginId === selection.pluginId && entry.id === selection.serviceId);
  if (!service) return `${selection.pluginId} / ${selection.serviceId} (not installed)`;
  return service.status.ready
    ? `${service.displayName} (ready)`
    : `${service.displayName} (not ready: ${service.status.message})`;
}

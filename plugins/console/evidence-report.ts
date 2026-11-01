import type { z } from "zod";
import type { evidenceJoinOutput } from "./delivery-contract";

export type EvidenceKind = "issue" | "discussion" | "video" | "web" | "dataset";
export type Joined = z.infer<typeof evidenceJoinOutput>;
export type Collector = {
  id: string;
  label: string;
  kind: EvidenceKind;
  how: string;
  cost: string;
  login: string;
};
export const collectorCatalogue: Collector[] = [
  { id: "web-search", label: "Web search and page fetch", kind: "web", how: "The agent's own search and fetch tools.", cost: "No extra cost", login: "None" },
  { id: "github-issues", label: "GitHub issues", kind: "issue", how: "gh issue list and gh search issues through the gh login already on the machine.", cost: "No extra cost", login: "Existing gh login, read only" },
  { id: "github-discussions", label: "GitHub discussions", kind: "discussion", how: "gh api graphql against public repositories.", cost: "No extra cost", login: "Existing gh login, read only" },
  { id: "reddit-threads", label: "Reddit threads", kind: "discussion", how: "The keyless Reddit client in the web-scraping skill.", cost: "No extra cost", login: "None" },
  { id: "youtube-transcripts", label: "YouTube transcripts", kind: "video", how: "The transcripts skill or the brain media tool, one public video at a time.", cost: "No extra cost for public captions", login: "None" },
  { id: "open-datasets", label: "Public datasets (CSV, JSON, APIs)", kind: "dataset", how: "Open data downloads and public APIs the agent can fetch directly.", cost: "No extra cost", login: "None" },
  { id: "apify-actors", label: "Apify Actors and datasets (optional)", kind: "dataset", how: "Only if an Apify connection already exists: search Actors, read the input schema, run one, read its dataset.", cost: "Paid per run: read the Actor price first and do not buy credits", login: "Existing connection only" },
];

export function collectorBrief(ids: string[]): string {
  const chosen = collectorCatalogue.filter((collector) => ids.includes(collector.id));
  if (!chosen.length) return "";
  return `Requested collectors (source type in brackets):\n${chosen
    .map((collector) => `- ${collector.label} [${collector.kind}]: ${collector.how} Cost: ${collector.cost}.`)
    .join(
      "\n",
    )}\nUse only these. If one is not connected or installed, say so under coverage gaps; do not install, log in or buy credits. Cover each requested source type with at least one row, or explain why none exists. Check any price before running a paid collector.`;
}

export type FoundEvidence = { question: string | null; evidence: unknown[]; messageIndex: number };
const FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
const looksLikeRow = (value: unknown) =>
  value !== null && typeof value === "object" && "sourceUrl" in (value as object);

/** The newest assistant answer that ends in a fenced evidence block, parsed but not yet validated. */
export function extractEvidence(messages: ReadonlyArray<{ role: string; text: string }>): FoundEvidence | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const blocks = [...message.text.matchAll(FENCE)].map((match) => match[1]).reverse();
    for (const block of blocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block);
      } catch {
        continue;
      }
      const rows = Array.isArray(parsed) ? parsed : (parsed as { evidence?: unknown } | null)?.evidence;
      if (!Array.isArray(rows) || !rows.some(looksLikeRow)) continue;
      const question = (parsed as { question?: unknown })?.question;
      return { question: typeof question === "string" && question.trim() ? question : null, evidence: rows, messageIndex: index };
    }
  }
  return null;
}

export type EvidenceReport = {
  markdown: string;
  sourceTypes: string[];
  sourceCount: number;
  meetsThreeSourceTypes: boolean;
};

/** A cited report built only from the joined rows: nothing is added, every finding carries its source number. */
export function buildEvidenceReport(joined: Joined): EvidenceReport {
  const numbers = new Map<string, number>();
  for (const row of joined.evidence) if (!numbers.has(row.sourceUrl)) numbers.set(row.sourceUrl, numbers.size + 1);
  const sourceTypes = [...new Set(joined.evidence.map((row) => row.kind))].sort();
  const sections = sourceTypes.map((kind) => {
    const rows = joined.evidence.filter((row) => row.kind === kind);
    return `## ${kind} (${rows.length})\n${rows.map((row) => `- ${row.observation} [${numbers.get(row.sourceUrl)}]`).join("\n")}`;
  });
  const sources = [...numbers].map(([url, number]) => {
    const row = joined.evidence.find((item) => item.sourceUrl === url)!;
    return `${number}. ${row.title}, ${url} (${row.kind}, retrieved ${row.retrievedAt}${row.collector ? `, via ${row.collector}` : ""})`;
  });
  const repeats = joined.duplicates ? ` ${joined.duplicates} exact repeat${joined.duplicates === 1 ? "" : "s"} removed.` : "";
  const markdown = [
    `# ${joined.question}`,
    `${numbers.size} source${numbers.size === 1 ? "" : "s"} across ${sourceTypes.length} source type${sourceTypes.length === 1 ? "" : "s"} (${sourceTypes.join(", ")}).${repeats}`,
    ...sections,
    `## Sources\n${sources.join("\n")}`,
    `## Limitations\n${joined.limitations.map((item) => `- ${item}`).join("\n")}`,
  ].join("\n\n");
  return { markdown, sourceTypes, sourceCount: numbers.size, meetsThreeSourceTypes: sourceTypes.length >= 3 };
}

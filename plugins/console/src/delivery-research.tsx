import { useMemo, useState } from "react";
import { experimental_saveFile as saveFile, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { deliveryRpcContract, evidenceFromThreadOutput } from "../delivery-contract";
import { buildEvidenceReport, collectorBrief, collectorCatalogue } from "../evidence-report";
import { button, errorText, TaskDraft } from "./delivery-shared";
import { fieldArea } from "./controls";
import { useFeature } from "./use-feature";

type Found = z.infer<typeof evidenceFromThreadOutput>;

export function ResearchPanel({ threadId }: { threadId?: string }) {
  const rpc = useRpc<typeof deliveryRpcContract>(),
    context = useBbContext();
  const [question, setQuestion] = useState(""),
    [picked, setPicked] = useState<string[]>([]),
    [found, setFound] = useState<Found | null>(null),
    [reading, setReading] = useState(false),
    [error, setError] = useState(""),
    [report, setReport] = useState(""),
    [rows, setRows] = useState("[]"),
    [pasted, setPasted] = useState("");
  // F81 (join evidence across sources and build a cited report) unticked: the collected rows are not joined or shown.
  const joinOn = useFeature("F81");
  const joined = joinOn ? (found?.joined ?? null) : null;
  const kinds = useMemo(() => [...new Set(joined?.evidence.map((row) => row.kind))].sort(), [joined]);
  const wanted = [...new Set(collectorCatalogue.filter((item) => picked.includes(item.id)).map((item) => item.kind))];
  const missing = wanted.filter((kind) => !kinds.includes(kind));
  const taskContext = [question || "Enter a bounded research question first.", collectorBrief(picked)].filter(Boolean).join("\n\n");
  const read = async () => {
    if (!threadId) return;
    setReading(true);
    setError("");
    setReport("");
    try {
      const response = await rpc.call("delivery_evidence_from_thread", { threadId, question: question.trim() || null });
      setFound(response);
      if (response.rejected) setError(response.rejected);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setReading(false);
    }
  };
  return (
    <section className="space-y-3" aria-label="Research">
      <header>
        <h2 className="font-medium">Public research and evidence</h2>
        <p className="text-xs text-muted-foreground">
          Pick the collectors, put the task in this thread's composer, send it, then read the evidence back here as a table and a cited report. BB cannot list another tool's connections, so the agent confirms in its answer which collectors were actually connected.
        </p>
      </header>
      <textarea
        className={`${fieldArea} w-full`}
        aria-label="Research question"
        placeholder="One bounded research question"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <fieldset className="rounded-lg border border-border p-4 space-y-2" role="group" aria-label="Collectors">
        <legend className="px-1 text-[13px] font-medium">Collectors</legend>
        {collectorCatalogue.map((collector) => (
          <label key={collector.id} className="flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              className="mt-1"
              checked={picked.includes(collector.id)}
              onChange={(event) => setPicked(event.target.checked ? [...picked, collector.id] : picked.filter((id) => id !== collector.id))}
            />
            <span>
              <span className="font-medium">{collector.label}</span> <span className="text-xs text-muted-foreground">[{collector.kind}]</span>
              <span className="block text-xs text-muted-foreground">
                {collector.how} {collector.cost}. Login: {collector.login}.
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <TaskDraft purpose="research" threadId={threadId} projectId={context.projectId} hostId={null} context={taskContext} />
      <div className="rounded-lg border border-border p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button className={button} disabled={!threadId || reading} onClick={() => void read()}>
            Read evidence from this thread
          </button>
          {!threadId && <span className="text-xs">Open this panel from a chat to read its answer.</span>}
        </div>
        {error && <p role="alert" className="whitespace-pre-wrap text-[13px]">{error}</p>}
        {found && <p className="text-[13px]">{found.message}</p>}
        {joined && (
          <>
            <p className="text-[13px]">
              {joined.evidence.length} rows from {joined.sourceCount} sources
              {joined.duplicates ? `; ${joined.duplicates} exact repeat${joined.duplicates === 1 ? "" : "s"} removed` : ""}.
            </p>
            <p className="text-[13px]">{`${kinds.length} source type${kinds.length === 1 ? "" : "s"}: ${kinds.join(", ")}`}</p>
            {kinds.length < 3 && <p className="text-[13px]">Only {kinds.length} source type{kinds.length === 1 ? "" : "s"}: a report that cites at least three needs more collectors.</p>}
            {missing.length > 0 && <p className="text-[13px]">No rows came back for: {missing.join(", ")}.</p>}
            <div className="overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs" aria-label="Collected evidence">
                <thead>
                  <tr>
                    <th className="p-2 text-left">Type</th>
                    <th className="p-2 text-left">Source</th>
                    <th className="p-2 text-left">Observation</th>
                    <th className="p-2 text-left">Collector</th>
                    <th className="p-2 text-left">Retrieved</th>
                  </tr>
                </thead>
                <tbody>
                  {joined.evidence.map((row, index) => (
                    <tr key={index} className="border-t align-top">
                      <td className="p-2">{row.kind}</td>
                      <td className="p-2">
                        <a className="underline" href={row.sourceUrl} target="_blank" rel="noreferrer">
                          {row.title}
                        </a>
                      </td>
                      <td className="p-2">{row.observation}</td>
                      <td className="p-2">{row.collector ?? ""}</td>
                      <td className="p-2">{row.retrievedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className={button} onClick={() => setReport(buildEvidenceReport(joined).markdown)}>
                Build cited report
              </button>
              {report && (
                <button
                  className={button}
                  onClick={() =>
                    void saveFile({ fileName: "research-report.md", blob: new Blob([report], { type: "text/markdown" }) }).then(
                      (outcome) => {
                        if (outcome === "failed") setError("The native/browser save could not start.");
                      },
                      (cause) => setError(errorText(cause)),
                    )
                  }
                >
                  Save report
                </button>
              )}
            </div>
            {report && <pre aria-label="Cited report" className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 text-xs">{report}</pre>}
          </>
        )}
      </div>
      <details>
        <summary>Paste rows by hand</summary>
        <p className="text-xs">
          Paste JSON rows with sourceUrl, retrievedAt (ISO UTC), kind (issue/discussion/video/web/dataset), title and observation. Optional: sourceId, collector.
        </p>
        <textarea
          className={`${fieldArea} w-full min-h-32 font-mono`}
          aria-label="Collected public evidence JSON"
          value={rows}
          onChange={(event) => setRows(event.target.value)}
        />
        <button
          className={button}
          disabled={!question.trim()}
          onClick={() => {
            try {
              const evidence = JSON.parse(rows);
              void rpc.call("delivery_evidence_join", { question, evidence }).then(
                (value) => {
                  setPasted(JSON.stringify(value, null, 2));
                  setError("");
                },
                (cause) => setError(errorText(cause)),
              );
            } catch (cause) {
              setError(errorText(cause));
            }
          }}
        >
          Validate and deduplicate evidence
        </button>
        {pasted && <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{pasted}</pre>}
      </details>
    </section>
  );
}

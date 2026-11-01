import { useMemo, useState } from "react";
import { checkTour, splitStops, type ChangeFile, type ChangeHunk } from "../review-tour";
import { button } from "./delivery-shared";
import { fieldArea } from "./controls";

const STATUS: Record<ChangeFile["status"], string> = {
  added: "New file",
  modified: "Changed",
  deleted: "Deleted",
  renamed: "Renamed",
  unknown: "Changed",
};
const span = (side: string, range: { start: number; end: number } | null) =>
  range ? `${side} lines ${range.start}-${range.end}` : null;
export const hunkLabel = (hunk: ChangeHunk) => span("new", hunk.new) ?? span("old", hunk.old) ?? "whole file";

export function ReviewTourPanel({ changes }: { changes: ChangeFile[] }) {
  const [done, setDone] = useState<string[]>([]),
    [current, setCurrent] = useState(0);
  if (!changes.length)
    return (
      <section aria-label="Review tour" className="rounded-lg border border-border p-4 text-[13px]">
        No changed files were read from the provider, so there is nothing to walk through. Read the diff again or open the PR on its Git host.
      </section>
    );
  const toggle = (path: string, on: boolean) => setDone(on ? [...done, path] : done.filter((item) => item !== path));
  const next = () => {
    const index = changes.findIndex((file) => !done.includes(file.path));
    if (index >= 0) setCurrent(index);
  };
  const reviewed = changes.filter((file) => done.includes(file.path)).length;
  return (
    <section aria-label="Review tour" className="space-y-3 rounded-lg border border-border p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">Review tour</h3>
          <p className="text-xs text-muted-foreground">One stop for every changed file. Each hunk opens on the PR page.</p>
        </div>
        <div className="text-[13px]">
          <span>
            {reviewed} of {changes.length} files reviewed
          </span>
          <progress className="ml-2 align-middle" max={changes.length} value={reviewed} aria-label="Review coverage" />
        </div>
      </header>
      {reviewed === changes.length ? (
        <p role="status" className="text-[13px]">
          Every changed file has been reviewed.
        </p>
      ) : (
        <button className={button} onClick={next}>
          Next unreviewed stop
        </button>
      )}
      <ol className="space-y-2">
        {changes.map((file, index) => (
          <li
            key={file.path}
            aria-label={`Stop ${index + 1} of ${changes.length}: ${file.path}`}
            data-current={index === current ? "true" : "false"}
            className={`rounded-md border border-border p-3 ${index === current ? "border-foreground" : ""}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  aria-label={`Mark ${file.path} reviewed`}
                  checked={done.includes(file.path)}
                  onChange={(event) => toggle(file.path, event.target.checked)}
                />
                <span className="font-mono">{file.path}</span>
              </label>
              <span className="text-xs text-muted-foreground">
                {STATUS[file.status]}
                {file.previousPath ? ` from ${file.previousPath}` : ""}
                {file.additions !== null ? ` · +${file.additions} −${file.deletions ?? 0}` : ""}
              </span>
            </div>
            {index === current && (
              <ul className="mt-2 space-y-1 text-[13px]">
                {file.hunks.map((hunk, position) => (
                  <li key={position}>
                    {hunk.link ? (
                      <a className="underline" href={hunk.link} target="_blank" rel="noreferrer">
                        {hunkLabel(hunk)}
                      </a>
                    ) : (
                      hunkLabel(hunk)
                    )}
                  </li>
                ))}
                {!file.hunks.length && <li>No hunks to show for this file (binary or empty change).</li>}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <TourCheck changes={changes} />
    </section>
  );
}

export function TourCheck({ changes }: { changes: ChangeFile[] }) {
  const [answer, setAnswer] = useState("");
  const result = useMemo(() => (answer.trim() ? checkTour(changes, answer) : null), [changes, answer]);
  const stops = useMemo(() => (answer.trim() ? splitStops(changes, answer) : []), [changes, answer]);
  return (
    <details>
      <summary>Check a returned tour against the diff</summary>
      <div className="space-y-2">
        <textarea
          aria-label="Tour to check"
          className={`${fieldArea} w-full min-h-24`}
          placeholder="Paste the tour the model returned"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
        {result && (
          <div role="status" className="space-y-1 text-[13px]">
            <p>
              {result.covered.length} of {result.total} changed files placed
              {result.ok ? "; every hunk link is real." : "."}
            </p>
            {result.missing.length > 0 && (
              <>
                <p>Missing from the tour:</p>
                <ul className="list-disc pl-5 text-xs break-all">
                  {result.missing.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </>
            )}
            {result.invalidLinks.map((item) => (
              <p className="text-xs break-all" key={item.link}>
                {item.reason} {item.link}
              </p>
            ))}
          </div>
        )}
        {stops.length > 0 && (
          <div aria-label="Returned tour" className="space-y-1">
            <p className="text-[13px] font-medium">Returned tour</p>
            <ol className="space-y-1 text-[13px]">
              {stops.map((stop) => (
                <li key={stop.index} aria-label={`Returned stop ${stop.index}: ${stop.title}`} className="rounded-md border border-border p-3">
                  <span className="font-medium">
                    {stop.index}. {stop.title}
                  </span>
                  <ul className="text-xs">
                    {stop.files.map((file) => (
                      <li key={file.path}>
                        <span className="font-mono">{file.path}</span>{" "}
                        {file.hunks.map((hunk, position) =>
                          hunk.link ? (
                            <a key={position} className="underline mr-2" href={hunk.link} target="_blank" rel="noreferrer">
                              {hunkLabel(hunk)}
                            </a>
                          ) : null,
                        )}
                      </li>
                    ))}
                    {stop.links.filter((item) => !item.real).map((item) => (
                      <li key={item.link} className="break-all">
                        Link outside every hunk: {item.link}
                      </li>
                    ))}
                    {!stop.files.length && <li>This stop names no changed file.</li>}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </details>
  );
}

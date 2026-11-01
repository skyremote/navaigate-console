// Chat file links whose file is not in the chat's project.
//
// bb opens a chat's `file.md` link in the file panel relative to the chat's workspace. When the
// agent saved the file somewhere else (the NAS share, while the chat runs in a local project)
// the panel says "File not found.". This opener takes those files over: if the file is in the
// workspace it hands straight back to bb's own preview; otherwise it finds the file the agent
// meant (server-file-resolve.ts) and shows it with a note that it lives outside the project.
import { useEffect, useState } from "react";
import { Markdown, useBbNavigate, useRpc, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { FileResolveOutput } from "../server-file-resolve";

export { OUTSIDE_FILE_EXTENSIONS } from "./outside-file-extensions";

type State = { kind: "loading" } | { kind: "done"; result: FileResolveOutput };

export function OutsideFileOpener(props: PluginFileOpenerProps) {
  const { path, source, Original } = props;
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [failed, setFailed] = useState(false);
  // Host files (absolute paths, and what Open preview opens) and thread storage are bb's own to show.
  const skip = source.kind !== "workspace";

  useEffect(() => {
    if (skip) return;
    let live = true;
    setState({ kind: "loading" });
    rpc.call("file_link_resolve", { path, source: { kind: source.kind, threadId: source.threadId, environmentId: source.environmentId, projectId: source.projectId, hostId: source.experimental_hostId ?? null } }).then(
      (result) => { if (live) setState({ kind: "done", result }); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
    // The request is about one file in one chat; rpc is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, source.kind, source.threadId, source.environmentId, source.projectId, source.experimental_hostId, skip]);

  // bb's own preview is the default for everything except the two cases this opener exists for:
  // a file found outside the project, and a file missing from a workspace that was really checked.
  if (skip || failed || state.kind === "loading") return <Original />;
  const { result } = state;
  if (result.status === "found") return <OutsideFileCard result={result} />;
  if (result.status === "not-found") return <MissingFile path={path} result={result} />;
  return <Original />;
}

function MissingFile({ path, result }: { path: string; result: FileResolveOutput }) {
  return (
    <div className="m-4 rounded-md border border-border px-3 py-2.5" role="alert">
      <div className="text-[13px] font-medium text-foreground">File not found</div>
      <p className="mt-1 break-words text-[12px] text-muted-foreground">{result.reason ?? `No file at ${path}.`}</p>
      {result.tried.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] font-medium text-muted-foreground">Looked at</div>
          <ul className="mt-1 space-y-0.5 break-all font-mono text-[11px] text-muted-foreground">
            {result.tried.map((place) => <li key={place}>{place}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function OutsideFileCard({ result }: { result: FileResolveOutput }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [note, setNote] = useState<string | null>(null);
  const realPath = result.realPath ?? "";

  const run = async (mode: "reveal" | "open") => {
    setNote(null);
    const outcome = await rpc.call("file_link_open", { path: realPath, mode }).catch((cause: unknown) => ({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) }));
    if (!outcome.ok) setNote(outcome.reason ?? "Could not open the file.");
  };
  const openPreview = () => {
    setNote(null);
    // The panel reads host files by their real path; fall back to the file's own app when it will not.
    const opened = result.hostId ? nav.experimental_openFilePreview({ target: { kind: "host", hostId: result.hostId, path: realPath }, location: null }) : false;
    if (!opened) void run("open");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="text-[13px] font-medium text-foreground">This file is outside this chat&apos;s project</div>
        <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground" data-testid="outside-file-path">{realPath}</div>
        {result.via && <div className="mt-0.5 text-[11px] text-muted-foreground">Found in {result.via}.</div>}
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => void run("reveal")} className="rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-foreground">Open in Finder</button>
          <button type="button" onClick={openPreview} className="rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground hover:border-foreground">Open preview</button>
        </div>
        {note && <p className="mt-2 text-[12px] text-muted-foreground" role="status">{note}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <InlinePreview result={result} />
      </div>
    </div>
  );
}

function InlinePreview({ result }: { result: FileResolveOutput }) {
  if (result.content === null) {
    return <p className="p-4 text-[12px] text-muted-foreground">No inline preview for this kind of file. Use Open preview to see it in its own app.</p>;
  }
  if (result.kind === "markdown") return <div className="p-4"><Markdown content={result.content} /></div>;
  if (result.kind === "html") {
    // No scripts and no same-origin access: an agent-written page only gets to draw itself.
    return <iframe title="File preview" sandbox="" srcDoc={result.content} className="h-full min-h-[320px] w-full border-0 bg-white" />;
  }
  return <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12px] text-foreground">{result.content}</pre>;
}

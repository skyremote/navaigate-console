import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { OwnerWorkspacePanel } from "./owner-workspace";
import { RelayActions } from "./relay-actions";
import type { mirrorWorkspaceContract } from "../owner/mirror-workspace";

type Resolved = z.infer<typeof mirrorWorkspaceContract.mirror_owner_workspace.output>;

/** Shows the tab only on Fleet mirror copies, from the mirror's saved copy state. */
export function useMirrorCopyVisible({ threadId }: { threadId: string }): boolean {
  const rpc = useRpc<typeof mirrorWorkspaceContract>();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (attempt: number) => {
      rpc.call("mirror_copy_owner", { threadId }).then((owner) => { if (live) setVisible(owner !== null); }, () => {
        if (live && attempt < 6) timer = setTimeout(() => ask(attempt + 1), 1000 * 2 ** attempt);
      });
    };
    ask(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [rpc, threadId]);
  return visible;
}

/** Opens the owner thread's real project folder in VS Code over the always-on Mac's SSH alias. */
export function OpenInEditorButton({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof mirrorWorkspaceContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function open() {
    setBusy(true); setNote(null);
    try {
      const result = await rpc.call("mirror_owner_editor", { threadId });
      if (!result.available) { setNote(result.reason); return; }
      navigate.openUrl(result.url);
      setNote(`Opening ${result.path} on ${result.machine}. VS Code needs the Remote - SSH extension.`);
    } catch (cause) { setNote(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div style={{ display: "grid", gap: 4 }}>
    <button disabled={busy} onClick={() => void open()}>Open in editor</button>
    {note && <small role="status">{note}</small>}
  </div>;
}

/** The owner's files, previews and pending questions for the thread this copy mirrors. */
export function MirrorOwnerWorkspaceTab({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof mirrorWorkspaceContract>();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setResolved(null); setError(null);
    rpc.call("mirror_owner_workspace", { threadId }).then((value) => { if (live) setResolved(value); }, (cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [rpc, threadId, attempt]);
  if (error) return <div style={{ padding: 12 }}><p>{error}</p><button onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>;
  if (resolved === null) return <div style={{ padding: 12 }}>Finding the owner thread…</div>;
  if (!resolved.available) return <div style={{ padding: 12 }}><p>{resolved.reason}</p><button onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>;
  return (
    <div style={{ padding: 12, display: "grid", gap: 8 }}>
      <small>Owner: {resolved.copy.machine}, thread {resolved.target.threadId}</small>
      <OpenInEditorButton threadId={threadId} />
      <RelayActions machine={resolved.copy.machine} threadId={resolved.target.threadId ?? null} threadTitle="this chat" />
      <OwnerWorkspacePanel target={resolved.target} localServerId={resolved.localServerId} localMachineKey={resolved.localMachineKey} ownerUrl={resolved.ownerUrl} ownerThreadUrl={resolved.ownerThreadUrl} />
    </div>
  );
}

import { useState } from "react";
import type { KeyboardEvent } from "react";
import type { Reach } from "../lib/reach";

export type StartMode = "start" | "ask";

const HINT: Record<Reach, string> = { here: "Starts here", brain: "Sent through the brain", ssh: "Sent over SSH" };

export function StartBox({ column, reach, onStart, initialOpen = false, initialPrompt = "", allowAsk = true }: { column: { key: string; label: string }; reach: Reach; onStart: (prompt: string, mode: StartMode) => Promise<void>; initialOpen?: boolean; initialPrompt?: string; /** False when Tell and Ask (F06) is switched off: only Start remains. */ allowAsk?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const submit = async (mode: StartMode) => {
    if (prompt.trim() === "" || busy) return;
    setBusy(true);
    try {
      await onStart(prompt.trim(), mode);
      setPrompt("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit("start");
    if (e.key === "Escape") setOpen(false);
  };
  if (!open) {
    return (
      <button type="button" className="fleet-start" onClick={() => setOpen(true)}>
        + Start work on {column.label}
      </button>
    );
  }
  return (
    <div className="fleet-box">
      <textarea autoFocus value={prompt} placeholder={`What should ${column.label} do?`} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKey} />
      <div className="fleet-box-row">
        <span className="fleet-hint">{HINT[reach]} · Cmd+Enter starts</span>
        <span style={{ display: "flex", gap: 6 }}>
          <button type="button" className="fleet-btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          {allowAsk ? (
            <button type="button" className="fleet-btn" disabled={busy || prompt.trim() === ""} onClick={() => void submit("ask")}>
              Ask {column.label} and read the answer
            </button>
          ) : null}
          <button type="button" className="fleet-btn p" disabled={busy || prompt.trim() === ""} onClick={() => void submit("start")}>
            {busy ? "Starting..." : "Start"}
          </button>
        </span>
      </div>
    </div>
  );
}

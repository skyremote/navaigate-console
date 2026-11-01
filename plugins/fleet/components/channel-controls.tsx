import { useState } from "react";
import { parsePinInput, type UpdateChannel } from "../owner/update-policy";

export function ChannelSelect({ machine, channel, busy, nightlyDisabled = false, onChange }: { machine: string; channel: UpdateChannel; busy: boolean; nightlyDisabled?: boolean; onChange: (machine: string, channel: UpdateChannel) => void }) {
  return (
    <select aria-label={`Release channel for ${machine}`} value={channel} disabled={busy} className="fm-select" onChange={(event) => onChange(machine, event.target.value as UpdateChannel)}>
      <option value="stable">Stable</option>
      <option value="nightly" disabled={nightlyDisabled && channel !== "nightly"}>{nightlyDisabled && channel !== "nightly" ? "Nightly (needs a route)" : "Nightly (test host)"}</option>
    </select>
  );
}

export function PinControl({ pinned, busy, onSave, initialDraft = "" }: { pinned: string | null; busy: boolean; onSave: (value: string | null) => void; initialDraft?: string }) {
  const [draft, setDraft] = useState(initialDraft);
  const parsed = parsePinInput(draft);
  const invalid = draft.trim() !== "" && !parsed.ok;
  return (
    <div className="fm-row" style={{ marginBottom: 6 }}>
      <span className="fm-muted">Pinned: {pinned ?? "none"}</span>
      <input aria-label="Pin the fleet to one bb version" className="fm-input" value={draft} placeholder="x.y.z" onChange={(event) => setDraft(event.target.value)} />
      <button type="button" className="fm-btn" disabled={busy || draft.trim() === "" || !parsed.ok} onClick={() => { if (parsed.ok) { onSave(parsed.value); setDraft(""); } }}>Pin version</button>
      {pinned !== null ? <button type="button" className="fm-btn" disabled={busy} onClick={() => onSave(null)}>Clear pin</button> : null}
      {invalid && !parsed.ok ? <span className="fm-muted" role="alert">{parsed.error}</span> : null}
    </div>
  );
}

/** The Update button for one machine, held with the reason when the channel or the pin means the updater would refuse it. */
export function AppUpdateButton({ available, gate, busy, helperSupported, helperReason, onUpdate }: { available: string; gate: string | null; busy: boolean; helperSupported: boolean; helperReason: string | null; onUpdate: () => void }) {
  return (
    <>
      <button type="button" className="fm-btn" disabled={busy || !helperSupported || gate !== null} title={gate ?? helperReason ?? undefined} onClick={onUpdate}>
        Update to {available}
      </button>
      {gate !== null ? <div className="fm-muted">{gate}</div> : null}
    </>
  );
}

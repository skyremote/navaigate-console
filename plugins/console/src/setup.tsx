// First-run setup: who you are, your Macs, optional addresses, then which
// features to turn on. It writes the profile (the one file that holds every
// personal value) and nothing else: plugin settings are never touched.
// Steps after the first can be skipped. A secret is never accepted: the brain
// step asks only for the NAME of the secret that holds the token.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { usePassedProbes } from "./core-probes";
import { featureState, pickerFeatures } from "./features-enabled";
import { FEATURE_AREAS } from "./features-guide-data";
import { goToHref, openFeaturesGuide } from "./features-guide-nav";
import {
  SETUP_ROLES, applyPreset, buildProfile, draftFromProfile, hasProblems, problemsOf, setPick,
  type MachineDraft, type SetupDraft, type SetupProblems, type SetupRole, type WorkloadDraft,
} from "./setup-model";
import { adoptProfile, useProfileState } from "./use-profile";
import type { rpcContract } from "../server";

const CSS = `
.nav-su{box-sizing:border-box;height:100%;overflow:auto;padding:24px 28px 56px;color:var(--foreground);font-family:var(--font-sans);font-size:13px;line-height:20px}
.nav-su *{box-sizing:border-box}
.nav-su-wrap{max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:20px}
.nav-su h1{margin:0;font-family:var(--font-display,var(--font-sans));font-size:24px;line-height:32px;font-weight:500;letter-spacing:-0.01em}
.nav-su h2{margin:0;font-size:16px;line-height:24px;font-weight:500}
.nav-su h3{margin:0 0 6px;font-size:13px;line-height:20px;font-weight:600}
.nav-su p{margin:0}
.nav-su-muted{color:var(--muted-foreground)}
.nav-su-steps{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.nav-su-steps li{padding:2px 10px;border:1px solid var(--border);border-radius:12px;color:var(--muted-foreground);font-size:12px;line-height:18px}
.nav-su-steps li[aria-current="step"]{color:var(--foreground);border-color:var(--foreground)}
.nav-su-card{display:flex;flex-direction:column;gap:14px;padding:18px;border:1px solid var(--border);border-radius:14px;background:var(--card)}
.nav-su-field{display:flex;flex-direction:column;gap:4px}
.nav-su-field label{font-weight:500}
.nav-su-field input,.nav-su-field select{height:36px;padding:0 12px;border:1px solid var(--input);border-radius:10px;background:var(--background);color:var(--foreground);font:inherit}
.nav-su-field input:focus-visible,.nav-su-field select:focus-visible,.nav-su button:focus-visible,.nav-su-box input:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.nav-su-hint{color:var(--muted-foreground);font-size:12px;line-height:16px}
.nav-su-err{color:var(--destructive-text,var(--foreground));font-size:12px;line-height:16px}
.nav-su-row{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;background:var(--muted)}
.nav-su-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.nav-su-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.nav-su-actions .nav-su-spacer{flex:1}
.nav-su button{min-height:36px;padding:0 14px;border:1px solid var(--input);border-radius:10px;background:var(--card);color:var(--foreground);font:inherit;font-weight:500;cursor:pointer}
.nav-su button:hover:not(:disabled){background:var(--state-hover)}
.nav-su button:disabled{color:var(--muted-foreground);cursor:default}
.nav-su button[data-primary]{background:var(--primary);color:var(--primary-foreground);border-color:transparent}
.nav-su button[data-quiet]{border-color:transparent;background:transparent;color:var(--muted-foreground)}
.nav-su button[data-pressed="true"]{border-color:var(--foreground)}
.nav-su-group{display:flex;flex-direction:column;gap:2px}
.nav-su-box{display:grid;grid-template-columns:20px minmax(0,1fr);gap:2px 8px;padding:6px 0}
.nav-su-box input{margin:3px 0 0;width:16px;height:16px}
.nav-su-box[data-state="greyed"] label,.nav-su-box[data-state="greyed"] .nav-su-hint{color:var(--muted-foreground)}
.nav-su-box .nav-su-hint{grid-column:2}
.nav-su-box[data-state="plugin"]{display:block}
.nav-su-box[data-state="plugin"] .nav-su-name{margin:0;font-weight:500}
.nav-su-box[data-state="plugin"] .nav-su-hint{margin:2px 0 0}
.nav-su dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0}
.nav-su dt{color:var(--muted-foreground)}
.nav-su dd{margin:0}
@media (max-width:640px){.nav-su{padding:16px}.nav-su-cols{grid-template-columns:minmax(0,1fr)}.nav-su button,.nav-su-field input,.nav-su-field select{min-height:44px}}
`;

function ensureStyle() {
  if (typeof document === "undefined" || document.getElementById("nav-su-style")) return;
  const el = document.createElement("style");
  el.id = "nav-su-style";
  el.textContent = CSS;
  document.head.appendChild(el);
}

type StepId = "you" | "machines" | "addresses" | "features" | "review";
const STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: "you", label: "You" },
  { id: "machines", label: "Your Macs" },
  { id: "addresses", label: "Addresses" },
  { id: "features", label: "Features" },
  { id: "review", label: "Review" },
];

function Field({ id, label, value, onChange, error, hint, placeholder, type = "text" }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string; placeholder?: string; type?: string }) {
  return (
    <div className="nav-su-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} placeholder={placeholder} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} />
      {error ? <p className="nav-su-err" id={`${id}-err`} role="alert">{error}</p> : hint ? <p className="nav-su-hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}

function StepYou({ draft, set, problems }: { draft: SetupDraft; set: (d: SetupDraft) => void; problems: SetupProblems }) {
  return (
    <div className="nav-su-card">
      <h2>You</h2>
      <p className="nav-su-muted">Your name is used where the Console talks about you, such as the prompts it writes for your agents.</p>
      <Field id="su-name" label="Your name" value={draft.name} onChange={(name) => set({ ...draft, name })} error={problems.name} />
    </div>
  );
}

function MachineEditor({ m, index, problems, onChange, onRemove }: { m: MachineDraft; index: number; problems: { label?: string; sshAlias?: string; bbUrl?: string }; onChange: (m: MachineDraft) => void; onRemove: () => void }) {
  const id = `su-mac-${index}`;
  return (
    <div className="nav-su-row" data-nav-part="setup-machine">
      <div className="nav-su-cols">
        <Field id={`${id}-label`} label="Name" value={m.label} onChange={(label) => onChange({ ...m, label })} error={problems.label} />
        <div className="nav-su-field">
          <label htmlFor={`${id}-role`}>Role</label>
          <select id={`${id}-role`} value={m.role} onChange={(e) => onChange({ ...m, role: e.target.value as SetupRole })}>
            {SETUP_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <Field id={`${id}-ssh`} label="SSH alias (optional)" value={m.sshAlias} onChange={(sshAlias) => onChange({ ...m, sshAlias })} error={problems.sshAlias} hint="The Host name from your SSH config." />
        <Field id={`${id}-bb`} label="bb address (optional)" value={m.bbUrl} onChange={(bbUrl) => onChange({ ...m, bbUrl })} error={problems.bbUrl} placeholder="https://" />
      </div>
      <div className="nav-su-actions"><button type="button" data-quiet onClick={onRemove}>Remove this Mac</button></div>
    </div>
  );
}

function WorkloadEditor({ w, index, labels, problems, onChange, onRemove }: { w: WorkloadDraft; index: number; labels: string[]; problems: { name?: string; machine?: string }; onChange: (w: WorkloadDraft) => void; onRemove: () => void }) {
  const id = `su-work-${index}`;
  return (
    <div className="nav-su-row" data-nav-part="setup-workload">
      <div className="nav-su-cols">
        <Field id={`${id}-name`} label="Workload" value={w.name} onChange={(name) => onChange({ ...w, name })} error={problems.name} />
        <div className="nav-su-field">
          <label htmlFor={`${id}-machine`}>Must run on</label>
          <select id={`${id}-machine`} value={w.machine} onChange={(e) => onChange({ ...w, machine: e.target.value })}>
            <option value="">Anywhere</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          {problems.machine ? <p className="nav-su-err" role="alert">{problems.machine}</p> : null}
        </div>
      </div>
      <Field id={`${id}-match`} label="Words that mark it" value={w.match} onChange={(match) => onChange({ ...w, match })} hint="Comma-separated. A project or chat with one of these words in its name belongs to this workload." />
      <div className="nav-su-actions"><button type="button" data-quiet onClick={onRemove}>Remove this workload</button></div>
    </div>
  );
}

function StepMachines({ draft, set, problems }: { draft: SetupDraft; set: (d: SetupDraft) => void; problems: SetupProblems }) {
  const labels = [draft.thisMac, ...draft.machines.map((m) => m.label)].map((l) => l.trim()).filter(Boolean);
  return (
    <div className="nav-su-card">
      <h2>Your Macs</h2>
      <Field id="su-this" label="This Mac" value={draft.thisMac} onChange={(thisMac) => set({ ...draft, thisMac })} error={problems.thisMac} hint="The name the Console shows for this Mac." />
      <div>
        <h3>Other Macs</h3>
        <p className="nav-su-hint">A second Mac turns on the features that move work between Macs.</p>
      </div>
      {draft.machines.map((m, i) => (
        <MachineEditor key={i} m={m} index={i} problems={problems.machines[i] ?? {}} onChange={(next) => set({ ...draft, machines: draft.machines.map((x, j) => (j === i ? next : x)) })} onRemove={() => set({ ...draft, machines: draft.machines.filter((_, j) => j !== i) })} />
      ))}
      <div className="nav-su-actions"><button type="button" onClick={() => set({ ...draft, machines: [...draft.machines, { id: null, label: "", role: "always-on", sshAlias: "", bbUrl: "" }] })}>Add another Mac</button></div>
      <div>
        <h3>Restricted workloads</h3>
        <p className="nav-su-hint">Work that must stay on one Mac, for example a client project that may not leave a managed machine.</p>
      </div>
      {draft.workloads.map((w, i) => (
        <WorkloadEditor key={i} w={w} index={i} labels={labels} problems={problems.workloads[i] ?? {}} onChange={(next) => set({ ...draft, workloads: draft.workloads.map((x, j) => (j === i ? next : x)) })} onRemove={() => set({ ...draft, workloads: draft.workloads.filter((_, j) => j !== i) })} />
      ))}
      <div className="nav-su-actions"><button type="button" onClick={() => set({ ...draft, workloads: [...draft.workloads, { id: null, name: "", machine: draft.machines.find((m) => m.role === "restricted")?.label ?? "", match: "" }] })}>Add a workload</button></div>
    </div>
  );
}

function StepAddresses({ draft, set, problems }: { draft: SetupDraft; set: (d: SetupDraft) => void; problems: SetupProblems }) {
  return (
    <div className="nav-su-card">
      <h2>Addresses</h2>
      <p className="nav-su-muted">Both are optional. Each one unlocks features that need it.</p>
      <Field id="su-hooks" label="Public address for webhooks" value={draft.hooks} onChange={(hooks) => set({ ...draft, hooks })} error={problems.hooks} placeholder="https://" hint="Where other services can reach this bb. Unlocks webhook features." />
      <Field id="su-brain" label="Brain address" value={draft.brainUrl} onChange={(brainUrl) => set({ ...draft, brainUrl })} error={problems.brainUrl} placeholder="https://" hint="Your own memory service. To host one, use extras/brain-selfhost-kit in BB Overlay." />
      <Field id="su-secret" label="Name of the secret that holds the brain token" value={draft.brainTokenSecret} onChange={(brainTokenSecret) => set({ ...draft, brainTokenSecret })} error={problems.brainTokenSecret} placeholder="BRAIN_TOKEN" hint="Type the name of a bb secret or environment variable, never the token itself." />
    </div>
  );
}

function StepFeatures({ draft, set, preview }: { draft: SetupDraft; set: (d: SetupDraft) => void; preview: ReturnType<typeof buildProfile> }) {
  const probes = usePassedProbes();
  const features = useMemo(() => pickerFeatures(), []);
  return (
    <div className="nav-su-card">
      <h2>Features</h2>
      <p className="nav-su-muted">{preview.edition === "private" ? "Change any box." : "Start from a preset, then change any box. Simple is the everyday set. Pro adds everything that suits several Macs and heavier work."}</p>
      {preview.edition === "private" ? (
        <p className="nav-su-hint">Every feature is on unless you untick it. The Simple and Pro presets are not offered here because they would switch features off.</p>
      ) : (
        <div className="nav-su-actions" role="group" aria-label="Preset" data-tour="console-setup-presets">
          <button type="button" data-pressed={draft.preset === "simple"} aria-pressed={draft.preset === "simple"} onClick={() => set(applyPreset(draft, "simple"))}>Simple</button>
          <button type="button" data-pressed={draft.preset === "pro"} aria-pressed={draft.preset === "pro"} onClick={() => set(applyPreset(draft, "pro"))}>Pro</button>
          {draft.preset === "custom" ? <span className="nav-su-hint">Custom choice</span> : null}
        </div>
      )}
      {FEATURE_AREAS.map((area) => {
        const rows = features.map((f) => ({ f, s: featureState(preview, f.id, probes) })).filter((x) => x.f.area === area && x.s.kind !== "hidden");
        if (rows.length === 0) return null;
        return (
          <section key={area} className="nav-su-group" aria-label={area}>
            <h3>{area}</h3>
            {rows.map(({ f, s }) => {
              const id = `su-f-${f.id}`;
              if (s.kind === "plugin") {
                return (
                  <div key={f.id} className="nav-su-box" data-feature={f.id} data-state="plugin">
                    <p className="nav-su-name">{f.name}</p>
                    <p className="nav-su-hint" id={`${id}-d`}>{f.description} This is a separate plugin, so it is not a box here. <a href={`/settings/plugins/${s.plugin}`} onClick={(e) => { e.preventDefault(); goToHref(`/settings/plugins/${s.plugin}`); }}>Switch it on or off in Settings, Plugins</a>.</p>
                  </div>
                );
              }
              const checked = s.kind === "on" || s.kind === "locked";
              return (
                <div key={f.id} className="nav-su-box" data-feature={f.id} data-state={s.kind}>
                  <input id={id} type="checkbox" checked={checked} disabled={s.kind === "locked" || s.kind === "greyed"} onChange={(e) => set(setPick(draft, f.id, e.target.checked))} aria-describedby={`${id}-d`} />
                  <label htmlFor={id}>{f.name}</label>
                  <p className="nav-su-hint" id={`${id}-d`}>{s.kind === "greyed" ? `${f.description} Needs: ${s.reason.replace(/^needs /, "")}.` : s.kind === "locked" ? `${f.description} Always on.` : f.description}</p>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function StepReview({ draft, preview, problems, error, saved }: { draft: SetupDraft; preview: ReturnType<typeof buildProfile>; problems: SetupProblems; error: string | null; saved: boolean }) {
  const probes = usePassedProbes();
  const on = pickerFeatures().filter((f) => { const s = featureState(preview, f.id, probes); return s.kind === "on"; }).length;
  return (
    <div className="nav-su-card">
      <h2>Review</h2>
      <dl>
        <dt>Name</dt><dd>{draft.name.trim() || "Not set"}</dd>
        <dt>This Mac</dt><dd>{draft.thisMac.trim() || "Not set"}</dd>
        <dt>Other Macs</dt><dd>{draft.machines.length === 0 ? "None" : draft.machines.map((m) => m.label.trim() || "Unnamed").join(", ")}</dd>
        <dt>Workloads</dt><dd>{draft.workloads.length === 0 ? "None" : draft.workloads.map((w) => w.name.trim() || "Unnamed").join(", ")}</dd>
        <dt>Public address</dt><dd>{draft.hooks.trim() || "Not set"}</dd>
        <dt>Brain</dt><dd>{draft.brainUrl.trim() ? draft.brainUrl.trim() : "Not set"}</dd>
        <dt>Features</dt><dd>{draft.preset ? `${draft.preset === "custom" ? "Custom" : draft.preset === "pro" ? "Pro" : "Simple"}, ` : ""}{on} ticked on top of the always-on ones</dd>
      </dl>
      <p className="nav-su-hint">Saving writes your profile only. Plugin settings are not changed.</p>
      {hasProblems(problems) ? <p className="nav-su-err" role="alert">Something above needs fixing before this can be saved. Go back to the step that is marked.</p> : null}
      {error ? <p className="nav-su-err" role="alert">{error}</p> : null}
      {saved ? <p role="status">Setup saved. Pages you switched on or off in the sidebar change after bb is reloaded.</p> : null}
    </div>
  );
}

export function SetupPage() {
  ensureStyle();
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const state = useProfileState();
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [hint, setHint] = useState<{ preset: "simple" | "pro" | null; hostname: string | null } | undefined>(undefined);
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The stamp of the profile file this page started from; a save is refused if the file has changed since.
  const [loadedStamp, setLoadedStamp] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    rpc.call("setup_hint", null).then((h) => live && setHint({ preset: h.preset, hostname: h.hostname ?? null }), () => live && setHint({ preset: null, hostname: null }));
    return () => { live = false; };
  }, [rpc]);
  useEffect(() => {
    if (draft === null && state.loaded && hint !== undefined) {
      setDraft(draftFromProfile(state.profile, hint.preset, hint.hostname));
      setLoadedStamp(state.stamp);
    }
  }, [draft, state.loaded, state.profile, hint]);

  if (!draft) return <main className="nav-su" aria-label="Set up the Console" data-tour="console-setup"><div className="nav-su-wrap"><p className="nav-su-muted">Reading your settings</p></div></main>;

  const problems = problemsOf(draft);
  const preview = buildProfile(state.profile, draft, null);
  const current = STEPS[step]!;
  const last = step === STEPS.length - 1;
  const stepProblems = (): boolean => {
    if (current.id === "you") return !!problems.name;
    if (current.id === "machines") return !!problems.thisMac || problems.machines.some((m) => m.label || m.sshAlias || m.bbUrl) || problems.workloads.some((w) => w.name || w.machine);
    if (current.id === "addresses") return !!(problems.hooks || problems.brainUrl || problems.brainTokenSecret);
    return false;
  };
  // What was typed wrongly (a token, a bad address) shows at once; what is merely missing shows once Continue was pressed.
  const live: SetupProblems = {
    hooks: problems.hooks, brainUrl: problems.brainUrl, brainTokenSecret: problems.brainTokenSecret,
    machines: problems.machines.map((m) => ({ sshAlias: m.sshAlias, bbUrl: m.bbUrl })),
    workloads: problems.workloads.map((w) => ({ machine: w.machine })),
  };
  const shown: SetupProblems = attempted || current.id === "review" ? problems : live;
  const next = () => {
    if (stepProblems()) { setAttempted(true); return; }
    setAttempted(false);
    setStep(step + 1);
  };
  const skip = () => { setAttempted(false); setStep(step + 1); };
  const save = async () => {
    setAttempted(true);
    if (hasProblems(problems)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await rpc.call("profile_save", { profile: buildProfile(state.profile, draft, Date.now()), ...(loadedStamp ? { expectedStamp: loadedStamp } : {}) });
      setLoadedStamp(res.stamp);
      adoptProfile(res);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The profile could not be saved.");
    } finally {
      setSaving(false);
    }
  };
  const set = (d: SetupDraft) => { setSaved(false); setDraft(d); };

  let body: ReactNode;
  if (current.id === "you") body = <StepYou draft={draft} set={set} problems={shown} />;
  else if (current.id === "machines") body = <StepMachines draft={draft} set={set} problems={shown} />;
  else if (current.id === "addresses") body = <StepAddresses draft={draft} set={set} problems={shown} />;
  else if (current.id === "features") body = <StepFeatures draft={draft} set={set} preview={preview} />;
  else body = <StepReview draft={draft} preview={preview} problems={problems} error={error} saved={saved} />;

  return (
    <main className="nav-su" aria-label="Set up the Console" data-nav-part="setup" data-tour="console-setup">
      <div className="nav-su-wrap">
        <header>
          <h1>Set up the Console</h1>
          <p className="nav-su-muted">Five short steps. Everything after the first can be skipped, and you can come back to this page from Settings or the Features guide.</p>
        </header>
        <ol className="nav-su-steps" aria-label="Steps">
          {STEPS.map((s, i) => <li key={s.id} aria-current={i === step ? "step" : undefined}>{i + 1}. {s.label}</li>)}
        </ol>
        {body}
        <div className="nav-su-actions">
          {step > 0 ? <button type="button" onClick={() => { setAttempted(false); setStep(step - 1); }}>Back</button> : null}
          <span className="nav-su-spacer" />
          {!last && step > 0 ? <button type="button" data-quiet onClick={skip}>Skip this step</button> : null}
          {!last ? <button type="button" data-primary onClick={next}>Continue</button> : <button type="button" data-primary disabled={saving} onClick={save}>{saving ? "Saving" : saved ? "Save again" : "Save and finish"}</button>}
        </div>
        {saved ? (
          <div className="nav-su-actions">
            <button type="button" onClick={() => openFeaturesGuide()}>Open the Features guide</button>
            <button type="button" onClick={() => nav.toCompose({ focusPrompt: true })}>Start a chat</button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

/** A short block for Settings: where setup lives, and what state it is in. */
export function SetupSettings() {
  ensureStyle();
  const state = useProfileState();
  const nav = useBbNavigate();
  const done = state.profile.setup.completedAt !== null;
  return (
    <div className="nav-su" style={{ height: "auto", padding: 0 }} data-nav-part="setup-settings">
      <p className="nav-su-muted">{done ? "Setup is finished. Run it again to change your Macs, addresses or features." : "Setup has not been finished yet."}</p>
      <div className="nav-su-actions" style={{ marginTop: 8 }}>
        <button type="button" onClick={() => nav.toPluginPanel("setup")}>{done ? "Open setup" : "Finish setup"}</button>
      </div>
    </div>
  );
}


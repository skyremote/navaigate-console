import { useCallback, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ownerDetailRpcContract } from "../owner/detail-contract";
import type { ownerProjectContract, ProjectOwnerTarget } from "../owner/project-contract";
import { buildPrepareInput, describeReceipt, findCreated, validateProjectForm, type FormErrors, type ProjectForm, type ProjectValues } from "../lib/new-project";

export interface OwnerProject { id: string; name: string; path: string | null }
export interface Outcome { tone: "ok" | "bad" | "muted"; text: string; settled: boolean; projectId: string | null }

export interface NewProjectFormViewProps {
  machine: string;
  form: ProjectForm;
  errors: FormErrors;
  busy: boolean;
  outcome: Outcome | null;
  projects: OwnerProject[];
  created: OwnerProject | null;
  onChange: (next: ProjectForm) => void;
  onCreate: () => void;
  onCheck: () => void;
}

export function NewProjectFormView({ machine, form, errors, busy, outcome, projects, created, onChange, onCreate, onCheck }: NewProjectFormViewProps) {
  const ready = form.name.trim() !== "" && form.path.trim() !== "";
  return (
    <div>
      <div className="fm-muted">New project on {machine}: register an existing Git checkout on {machine} as a project; give its remote if the checkout has an origin. {machine} stays in charge of it.</div>
      <div className="fm-row" style={{ marginTop: 4 }}>
        <input aria-label="Project name" className="fm-input" style={{ width: 130 }} placeholder="Name" value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
        <input aria-label={`Checkout path on ${machine}`} className="fm-input" style={{ width: 260 }} placeholder={`/Users/.../repo on ${machine}`} value={form.path} onChange={(event) => onChange({ ...form, path: event.target.value })} />
        <input aria-label="Git remote (needed if the checkout has an origin)" className="fm-input" style={{ width: 230 }} placeholder="Git remote (needed if it has an origin)" value={form.remote} onChange={(event) => onChange({ ...form, remote: event.target.value })} />
        <button type="button" className="fm-btn" disabled={busy || !ready} onClick={onCreate}>Create on {machine}</button>
      </div>
      {(["name", "path", "remote"] as const).map((field) => errors[field] ? <div key={field} className="fm-muted" role="alert" style={{ color: "var(--destructive-text)" }}>{errors[field]}</div> : null)}
      {outcome ? (
        <div className="fm-row">
          <span className="fm-muted" role="status" style={outcome.tone === "ok" ? { color: "var(--success)" } : outcome.tone === "bad" ? { color: "var(--destructive-text)" } : undefined}>{outcome.text}</span>
          {!outcome.settled ? <button type="button" className="fm-btn" disabled={busy} onClick={onCheck}>Check again</button> : null}
        </div>
      ) : null}
      {projects.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          <div className="fm-muted">{projects.length} {projects.length === 1 ? "project" : "projects"} on {machine}</div>
          <div style={{ maxHeight: 110, overflow: "auto" }}>
            {projects.map((project) => (
              <div key={project.id} className="fm-row" style={{ fontSize: 12 }}>
                <b>{project.name}</b>
                <span className="fm-muted">{project.path ?? "no folder on this machine"}</span>
                {created?.id === project.id ? <span className="fm-chip ok">new</span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface Pending { requestId: string; target: ProjectOwnerTarget; values: ProjectValues }

export function NewProjectForm({ machine, label = machine, projects, onChanged }: { machine: string; label?: string; projects: OwnerProject[]; onChanged: () => void }) {
  const rpc = useRpc<typeof ownerProjectContract & typeof ownerDetailRpcContract>();
  const store = `fleet.newproject.pending.${machine}`;
  const readPending = (): Pending | null => { try { return JSON.parse(localStorage.getItem(store) ?? "null") as Pending | null; } catch { return null; } };
  const [form, setForm] = useState<ProjectForm>(() => { const held = readPending(); return held ? { name: held.values.name, path: held.values.path, remote: held.values.remote ?? "" } : { name: "", path: "", remote: "" }; });
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(() => readPending() ? { tone: "muted", text: `An earlier request on ${label} has not been confirmed. Check it before creating again.`, settled: false, projectId: null } : null);
  const [created, setCreated] = useState<{ projectId: string | null; path: string | null } | null>(null);

  const settle = useCallback((described: Outcome, values: ProjectValues) => {
    setOutcome(described);
    if (!described.settled) return;
    try { localStorage.removeItem(store); } catch { /* the receipt is already shown */ }
    if (described.tone === "ok") { setCreated({ projectId: described.projectId, path: values.path }); setForm({ name: "", path: "", remote: "" }); onChanged(); }
  }, [onChanged, store]);

  const check = async () => {
    const held = readPending();
    if (!held) return;
    setBusy(true);
    try {
      const receipt = await rpc.call("transfer_receipt", { target: held.target, requestId: held.requestId });
      settle(describeReceipt(receipt, label, held.values.name), held.values);
    } catch (cause) {
      setOutcome({ tone: "muted", text: `The receipt could not be read: ${cause instanceof Error ? cause.message : String(cause)}`, settled: false, projectId: null });
    } finally { setBusy(false); }
  };

  const create = async () => {
    if (readPending()) { await check(); return; }
    const checked = validateProjectForm(form);
    if (!checked.ok) { setErrors(checked.errors); return; }
    setErrors({});
    setBusy(true);
    let held: Pending | null = null;
    try {
      const target = await rpc.call("owner_project_target_get", { machine });
      held = { requestId: crypto.randomUUID(), target, values: checked.value };
      try { localStorage.setItem(store, JSON.stringify(held)); } catch { setOutcome({ tone: "bad", text: "Nothing was sent: this browser could not keep a record of the request first", settled: true, projectId: null }); return; }
      const receipt = await rpc.call("project_prepare", buildPrepareInput(target, held.requestId, checked.value));
      settle(describeReceipt(receipt, label, checked.value.name), checked.value);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      if (held === null) setOutcome({ tone: "bad", text: `Nothing was created: ${text}`, settled: true, projectId: null });
      else setOutcome({ tone: "muted", text: `${label} may have run it: ${text}. Check again before trying a second time.`, settled: false, projectId: null });
    } finally { setBusy(false); }
  };

  return <NewProjectFormView machine={label} form={form} errors={errors} busy={busy} outcome={outcome} projects={projects} created={created ? findCreated(projects, created) : null} onChange={setForm} onCreate={() => void create()} onCheck={() => void check()} />;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useFeature } from "./use-feature";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRpc,
  useSdk,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { WebhookFormState } from "../server-webhook-admin";
import {
  curlExample,
  defaultModelFor,
  deliveriesFor,
  deliveryLabel,
  deliveryTone,
  draftFromHook,
  draftProblem,
  emptyDraft,
  slugifyHookName,
  type HookDraft,
  type HookView,
} from "./webhooks-model";
import { useVisibleRealtime, useVisiblePoll } from "./visible-poll";

const btn =
  "min-h-8 rounded-md border border-border px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const field =
  "min-h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const label = "block text-xs font-medium";
const hint = "text-[11px] text-muted-foreground";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (e: unknown) => toast.error(message(e));

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}; select it and copy by hand.`);
  }
}

const TONE: Record<"good" | "wait" | "bad", string> = {
  good: "text-foreground",
  wait: "text-muted-foreground",
  bad: "text-destructive",
};

/** What the form says after a test event. Only an accepted event claims a task will start, and a refusal's own full stop is not doubled. */
export function testMessage(t: { outcome: string; accepted: boolean }): string {
  const outcome = t.outcome.replace(/[.\s]+$/, "");
  return t.accepted ? `Test event: ${outcome}. Starting the task happens within a minute.` : `Test event: ${outcome}.`;
}

export function WebhookSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [form, setForm] = useState<WebhookFormState | null>(null);
  const [problem, setProblem] = useState("");
  const read = useCallback(() => {
    rpc.call("webhook_form", null).then(
      (next) => {
        setForm(next);
        setProblem("");
      },
      (e) => setProblem(message(e)),
    );
  }, [rpc]);
  useEffect(read, [read]);
  useVisibleRealtime("automation-events", read);
  useVisiblePoll(read, 30_000);

  if (!form) return <p className={hint}>{problem || "Reading webhook settings..."}</p>;
  return (
    <div className="space-y-6" data-testid="webhook-settings">
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      <Address form={form} onChange={setForm} />
      <Secret form={form} />
      <Hooks form={form} onChange={setForm} />
      <Deliveries form={form} />
    </div>
  );
}

function Address(props: { form: WebhookFormState; onChange: (next: WebhookFormState) => void }) {
  // F53 and EXTRA-G both name this section: your own public address, and the check that it can be reached.
  const f53 = useFeature("F53");
  const g = useFeature("EXTRA-G");
  return f53 || g ? <AddressBody {...props} /> : null;
}

function AddressBody({ form, onChange }: { form: WebhookFormState; onChange: (next: WebhookFormState) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [base, setBase] = useState(form.publicBaseUrl);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<{ verdict: string; detail: string } | null>(null);
  useEffect(() => setBase(form.publicBaseUrl), [form.publicBaseUrl]);
  const apply = (patch: { enabled?: boolean; publicBaseUrl?: string }) => {
    setBusy(true);
    rpc
      .call("webhook_configure", patch)
      .then((next) => {
        onChange(next);
        setProbe(null);
      }, fail)
      .finally(() => setBusy(false));
  };
  return (
    <section className="space-y-2" aria-labelledby="webhook-address">
      <h3 id="webhook-address" className="text-sm font-medium">
        Address
      </h3>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={form.masterEnabled}
          disabled={busy}
          onChange={(e) => apply({ enabled: e.target.checked })}
        />
        Accept webhooks on this bb
      </label>
      <div>
        <label className={label} htmlFor="webhook-base">
          Public address of this bb
        </label>
        <div className="flex gap-2">
          <input
            id="webhook-base"
            className={field}
            value={base}
            placeholder="https://your-handle.getbb.app"
            onChange={(e) => setBase(e.target.value)}
          />
          <button className={btn} disabled={busy || base === form.publicBaseUrl} onClick={() => apply({ publicBaseUrl: base })}>
            Save
          </button>
        </div>
        <p className={hint}>An HTTPS address that already reaches this bb, with no path. Your own domain works if it points here.</p>
      </div>
      {form.endpoint ? (
        <div>
          <span className={label}>Webhook URL</span>
          <div className="flex gap-2">
            <input className={field} readOnly value={form.endpoint} aria-label="Webhook URL" onFocus={(e) => e.currentTarget.select()} />
            <button className={btn} onClick={() => void copy(form.endpoint!, "Webhook URL")}>
              Copy URL
            </button>
            <button
              className={btn}
              onClick={() => rpc.call("webhook_probe", null).then(setProbe, fail)}
            >
              Check it can be reached
            </button>
          </div>
          {probe && (
            <p className={`mt-1 text-xs ${probe.verdict === "reachable" ? "" : "text-destructive"}`} role="status">
              {probe.detail}
            </p>
          )}
        </div>
      ) : (
        <p className={hint}>Enter the public address to see the URL senders should post to.</p>
      )}
    </section>
  );
}

function Secret({ form }: { form: WebhookFormState }) {
  const rpc = useRpc<typeof rpcContract>();
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generate = () => {
    if (form.secretSet && !window.confirm("Every sender using the old secret will be refused until it is given the new one. Continue?"))
      return;
    setBusy(true);
    rpc
      .call("webhook_secret_regenerate", null)
      .then((r) => setFresh(r.secret), fail)
      .finally(() => setBusy(false));
  };
  return (
    <section className="space-y-2" aria-labelledby="webhook-secret">
      <h3 id="webhook-secret" className="text-sm font-medium">
        Signing secret
      </h3>
      <p className="text-xs">
        {form.secretSet ? "A secret is set. It is stored on this bb and never shown again after you leave this page." : "No secret yet, so every webhook is refused."}
      </p>
      <div className="flex gap-2">
        <button className={btn} disabled={busy} onClick={generate}>
          {form.secretSet ? "Regenerate" : "Generate"}
        </button>
      </div>
      {fresh && (
        <div className="space-y-1" role="status">
          <div className="flex gap-2">
            <input className={field} readOnly value={fresh} aria-label="New signing secret" onFocus={(e) => e.currentTarget.select()} />
            <button className={btn} onClick={() => void copy(fresh, "Secret")}>
              Copy secret
            </button>
            <button className={btn} onClick={() => setFresh(null)}>
              Hide
            </button>
          </div>
          <p className={hint}>Copy it now and give it to the sender. This is the only time it is shown.</p>
        </div>
      )}
    </section>
  );
}

function Hooks({ form, onChange }: { form: WebhookFormState; onChange: (next: WebhookFormState) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [editing, setEditing] = useState<HookDraft | null>(null);
  const [isEdit, setIsEdit] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<{ id: string; outcome: string; accepted: boolean } | null>(null);
  const [showCurl, setShowCurl] = useState<string | null>(null);
  const test = (hook: HookView) => {
    setTesting(hook.id);
    rpc
      .call("webhook_test", { id: hook.id })
      .then((r) => setLastTest({ id: hook.id, outcome: r.outcome, accepted: r.status >= 200 && r.status < 300 }), fail)
      .finally(() => setTesting(null));
  };
  const remove = (hook: HookView) => {
    if (!window.confirm(`Remove the hook "${hook.id}"? Its saved task stays in Automations.`)) return;
    rpc.call("webhook_remove", { id: hook.id }).then(onChange, fail);
  };
  return (
    <section className="space-y-2" aria-labelledby="webhook-hooks">
      <div className="flex items-center justify-between">
        <h3 id="webhook-hooks" className="text-sm font-medium">
          Hooks
        </h3>
        {!editing && (
          <button
            className={btn}
            onClick={() => {
              setIsEdit(false);
              setEditing(emptyDraft());
            }}
          >
            New hook
          </button>
        )}
      </div>
      {form.hooks.length === 0 && !editing && <p className={hint}>No hooks yet. A hook starts one agent task when a signed event arrives.</p>}
      <ul className="space-y-2">
        {form.hooks.map((hook) => (
          <li key={hook.id} className="rounded-md border border-border p-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>{hook.id}</strong>
              <span className={hook.enabled ? "" : "text-muted-foreground"}>{hook.enabled ? "On" : "Off"}</span>
            </div>
            <p>
              {hook.projectName ?? hook.projectId} · {hook.agent ? `${hook.agent.providerId} ${hook.agent.model}` : hook.agentError}
            </p>
            {hook.agent && <p className="text-muted-foreground">{hook.agent.prompt}</p>}
            <p className={hint}>
              {hook.holdOffline ? "Holds events while the machine is offline" : "Refuses events while the machine is offline"}
              {hook.coalesceSeconds > 0 ? ` · merges bursts within ${hook.coalesceSeconds}s` : ""}
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                className={btn}
                onClick={() => {
                  setIsEdit(true);
                  setEditing(draftFromHook(hook));
                }}
              >
                Edit
              </button>
              <button className={btn} disabled={testing !== null || !hook.enabled} onClick={() => test(hook)}>
                {testing === hook.id ? "Sending..." : "Send test event"}
              </button>
              {form.endpoint && (
                <button className={btn} onClick={() => setShowCurl(showCurl === hook.id ? null : hook.id)}>
                  Sender example
                </button>
              )}
              <button className={btn} onClick={() => remove(hook)}>
                Remove
              </button>
            </div>
            {lastTest?.id === hook.id && (
              <p className="mt-1" role="status">
                {testMessage(lastTest)}
              </p>
            )}
            {showCurl === hook.id && form.endpoint && (
              <div className="mt-1 space-y-1">
                <pre className="overflow-x-auto rounded bg-muted p-2 text-[11px]">{curlExample(form.endpoint, hook.id)}</pre>
                <button className={btn} onClick={() => void copy(curlExample(form.endpoint!, hook.id), "Example")}>
                  Copy example
                </button>
                <p className={hint}>Set WEBHOOK_SECRET to the signing secret first. The event text is never sent to the agent, only the saved prompt.</p>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <HookEditor
          draft={editing}
          isEdit={isEdit}
          taken={form.hooks.map((h) => h.id)}
          onCancel={() => setEditing(null)}
          onSaved={(next) => {
            onChange(next);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function HookEditor({
  draft: initial,
  isEdit,
  taken,
  onCancel,
  onSaved,
}: {
  draft: HookDraft;
  isEdit: boolean;
  taken: string[];
  onCancel: () => void;
  onSaved: (next: WebhookFormState) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [draft, setDraft] = useState(initial);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<HookDraft>) => setDraft((d) => ({ ...d, ...patch }));
  useEffect(() => {
    rpc.call("webhook_projects", null).then(setProjects, fail);
  }, [rpc]);
  useEffect(() => {
    if (draft.model) return;
    let live = true;
    sdk.providers
      .models({ providerId: draft.providerId })
      .then((r) => {
        const chosen = defaultModelFor(draft.providerId, r.models as { model: string; isDefault?: boolean }[]);
        if (live && chosen) set({ model: chosen });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.providerId, draft.model]);
  const pick = useMemo<ExperimentalProviderModelPickerValue>(
    () => ({ providerId: draft.providerId, model: draft.model, reasoningLevel: draft.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"] }),
    [draft.providerId, draft.model, draft.reasoningLevel],
  );
  const invalid = draftProblem(draft, taken, isEdit);
  const submit = () => {
    if (invalid) return setError(invalid);
    setBusy(true);
    setError("");
    rpc
      .call("webhook_save", draft)
      .then(onSaved, (e) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      aria-label={isEdit ? `Edit hook ${draft.name}` : "New hook"}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div>
        <label className={label} htmlFor="hook-name">
          Hook name
        </label>
        <input
          id="hook-name"
          className={field}
          value={draft.name}
          disabled={isEdit}
          placeholder="ci-failed"
          onChange={(e) => set({ name: slugifyHookName(e.target.value) })}
        />
        <p className={hint}>Senders put this in the x-nav-hook header. Lowercase letters, digits, hyphens and underscores.</p>
      </div>
      <div>
        <label className={label} htmlFor="hook-project">
          Project
        </label>
        <select id="hook-project" className={field} value={draft.projectId} onChange={(e) => set({ projectId: e.target.value })}>
          <option value="">Choose a project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <span className={label}>Agent</span>
        <ProviderModelPicker
          value={pick}
          onChange={(next) => set({ providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel })}
          align="start"
        />
        <p className={hint}>Claude by default. The task runs on this bb, in the project's default environment.</p>
      </div>
      <div>
        <label className={label} htmlFor="hook-prompt">
          Prompt
        </label>
        <textarea
          id="hook-prompt"
          className={`${field} min-h-24 py-1`}
          value={draft.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
        />
        <p className={hint}>Saved with the task and the same for every event. The event itself is never added to it.</p>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Hook is on
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={draft.holdOffline} onChange={(e) => set({ holdOffline: e.target.checked })} />
          Hold events while the machine is offline (up to 24 hours)
        </label>
      </div>
      <div>
        <label className={label} htmlFor="hook-merge">
          Merge bursts within (seconds)
        </label>
        <input
          id="hook-merge"
          type="number"
          min={0}
          max={3600}
          className={`${field} w-28`}
          value={draft.coalesceSeconds}
          onChange={(e) => set({ coalesceSeconds: Number(e.target.value) })}
        />
        <p className={hint}>0 starts one task per event. Above 0, events inside the window start one task between them.</p>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={btn} disabled={busy}>
          {busy ? "Saving..." : isEdit ? "Save changes" : "Create hook"}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Deliveries({ form }: { form: WebhookFormState }) {
  const rows = deliveriesFor(form.deliveries, null);
  return (
    <section className="space-y-2" aria-labelledby="webhook-deliveries">
      <h3 id="webhook-deliveries" className="text-sm font-medium">
        Recent deliveries
      </h3>
      {rows.length === 0 ? (
        <p className={hint}>Nothing has arrived yet.</p>
      ) : (
        <ul className="divide-y divide-border text-xs">
          {rows.map((d) => (
            <li key={d.id} className="py-1.5">
              <span className={TONE[deliveryTone(d.state)]}>{deliveryLabel(d.state)}</span> · {d.hookId} ·{" "}
              {new Date(d.receivedAt).toLocaleString()}
              {d.count > 1 ? ` · ${d.count} events merged` : ""}
              {d.runId ? ` · run ${d.runId}` : ""}
              <div className="text-muted-foreground">{d.deliveryId}</div>
              {d.error && <div className="text-muted-foreground">{d.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

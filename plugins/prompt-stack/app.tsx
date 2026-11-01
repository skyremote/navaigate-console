// bb-plugin-prompt-stack: frontend entry.
//
// A "Prompt stack" action in the thread's right-hand panel (New tab > Actions).
// One tick box per prompt-stack entry; ticking saves the thread override at once
// through the server, which runs the prompt-stack CLI. Nothing is injected here:
// the Claude Code hook reads the same files on the next prompt.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import type { PromptStackState, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const SCOPE_TEXT: Record<PromptStackState["scope"], string> = {
  thread: "This thread",
  project: "Project default",
  none: "Nothing stacked",
};

function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        "border px-3 py-2 text-xs " +
        (tone === "error"
          ? "border-destructive/40 text-destructive"
          : "border-dashed border-border text-muted-foreground")
      }
    >
      {children}
    </div>
  );
}

function PromptStackPanel({ threadId }: ExperimentalThreadActionTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PromptStackState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(0);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("state", { threadId }).then((next) => {
      if (pending.current === 0) setState(next);
      setError(null);
    }, report);
  }, [rpc, threadId, report]);

  useEffect(() => {
    setState(null);
    refetch();
  }, [refetch]);

  useRealtime("stack-changed", (payload) => {
    const changed = (payload as { threadId?: string } | null)?.threadId;
    if (changed === threadId) refetch();
  });

  const save = (method: "set" | "useProjectDefault", ids: string[], optimistic: PromptStackState) => {
    pending.current += 1;
    setSaving(true);
    setState(optimistic);
    const call =
      method === "set" ? rpc.call("set", { threadId, ids }) : rpc.call("useProjectDefault", { threadId });
    call
      .then((next) => {
        pending.current -= 1;
        if (pending.current === 0) setState(next);
        setError(null);
      })
      .catch((cause) => {
        pending.current -= 1;
        report(cause);
        if (pending.current === 0) refetch();
      })
      .finally(() => {
        if (pending.current === 0) setSaving(false);
      });
  };

  const toggle = (id: string, on: boolean) => {
    if (!state) return;
    const current = state.stack.filter((x) => x !== id);
    // Keep the manifest order so the cards always print in the same order.
    const wanted = new Set(on ? [...current, id] : current);
    const ids = state.entries.map((e) => e.id).filter((x) => wanted.has(x));
    const unknown = state.stack.filter((x) => !state.entries.some((e) => e.id === x));
    save("set", [...ids], { ...state, stack: [...ids, ...unknown], scope: "thread" });
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="space-y-3 px-4 pb-4 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">Prompt stack</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              <span
                aria-hidden
                className={"inline-block size-1.5 " + (state?.scope === "thread" ? "bg-primary" : "bg-muted-foreground/50")}
              />
              <span data-testid="ps-scope">{state ? SCOPE_TEXT[state.scope] : "Loading"}</span>
              {saving ? <span>· saving</span> : null}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="rounded-none"
            disabled={!state || state.scope !== "thread"}
            onClick={() => state && save("useProjectDefault", [], { ...state, scope: "project" })}
          >
            Use project default
          </Button>
        </div>

        {error ? <Notice tone="error">{error}</Notice> : null}

        {state === null ? (
          error ? null : <Notice>Reading the stack</Notice>
        ) : state.entries.length === 0 ? (
          <Notice>No entries in stack.json.</Notice>
        ) : (
          <ul className="divide-y divide-border border border-border bg-card">
            {state.entries.map((entry) => {
              const checked = state.stack.includes(entry.id);
              const inputId = `ps-${threadId}-${entry.id}`;
              return (
                <li key={entry.id}>
                  <label htmlFor={inputId} className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-accent/40">
                    <Checkbox
                      id={inputId}
                      checked={checked}
                      onCheckedChange={(next) => toggle(entry.id, next === true)}
                      className="mt-0.5 rounded-none data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="text-sm text-foreground">{entry.label}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{entry.id}</span>
                      </span>
                      {entry.summary ? (
                        <>
                          <span className="mt-1 block text-[13px] leading-snug text-foreground/90">
                            {entry.summary}
                          </span>
                          <span className="mt-1 block break-words text-[11px] text-muted-foreground">
                            Skill: {entry.skill}
                          </span>
                        </>
                      ) : (
                        <span className="block truncate text-xs text-muted-foreground/80" title={entry.skill}>
                          {entry.skill}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {state ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Ticks save at once for this thread only and apply from the next prompt.
            {state.scope !== "thread" ? " Until you tick, the thread follows the project default." : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "prompt-stack",
    title: "Prompt stack",
    icon: "Layers",
    layout: "flush",
    component: PromptStackPanel,
  });
});

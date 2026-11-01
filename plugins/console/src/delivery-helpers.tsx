import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_usePluginId as usePluginId, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { deliveryRpcContract, helperModelsOutput } from "../delivery-contract";
import { describeSelection, helperKind, type HelperChoice } from "./delivery-model";
import { rpcFlight } from "./rpc-flight";
import { useVisibleRealtime } from "./visible-poll";
import { outlineButton } from "./controls";

const button = outlineButton;
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
type Helper = z.infer<typeof helperModelsOutput>;
type Purpose = "title" | "commit";
type Services = Awaited<ReturnType<ReturnType<typeof useSdk>["system"]["aiServices"]>>;
const TASKS: { purpose: Purpose; task: "thread-title" | "commit-message"; label: string; noun: string; serviceId: string; key: string }[] = [
  { purpose: "title", task: "thread-title", label: "Titles", noun: "title", serviceId: "title-model", key: "titleHelperModel" },
  { purpose: "commit", task: "commit-message", label: "Commit messages", noun: "commit", serviceId: "commit-model", key: "commitHelperModel" },
];

/** Who writes titles and commit messages now, a way to test it, and a way to give it a Codex or Claude model. */
export function HelperModels({ choice, purpose }: { choice: HelperChoice; purpose: string }) {
  const rpc = useRpc<typeof deliveryRpcContract>();
  const sdk = useSdk();
  const pluginId = usePluginId();
  const [services, setServices] = useState<Services | null>(null);
  const [helper, setHelper] = useState<Helper | null>(null);
  const [tests, setTests] = useState<Partial<Record<Purpose, string>>>({});
  const [message, setMessage] = useState("");
  const serial = useRef(0);
  const load = useCallback(
    (fresh: boolean) => {
      const seq = ++serial.current;
      const flight = rpcFlight();
      void flight.call("ai_services", () => sdk.system.aiServices(), { fresh }).then(
        (value) => seq === serial.current && setServices(value),
        (cause) => seq === serial.current && setMessage(errorText(cause)),
      );
      void flight.call("delivery_helper_models", () => rpc.call("delivery_helper_models", {}), { fresh }).then(
        (value) => seq === serial.current && setHelper(value),
        (cause) => seq === serial.current && setMessage(errorText(cause)),
      );
    },
    [rpc, sdk],
  );
  const refresh = useCallback(() => load(true), [load]);
  useEffect(() => {
    load(false);
    return () => {
      serial.current++;
    };
  }, [load]);
  useVisibleRealtime("delivery-helper-models", refresh);
  const kind = helperKind(choice);
  const active = TASKS.find((entry) => entry.purpose === purpose);
  const test = async (entry: (typeof TASKS)[number]) => {
    setTests((now) => ({ ...now, [entry.purpose]: "Testing..." }));
    try {
      const result = await sdk.system.testAiService({ task: entry.task });
      setTests((now) => ({
        ...now,
        [entry.purpose]: result.ok
          ? `${result.displayName} answered in ${result.durationMs} ms: "${result.text}"`
          : `Failed after ${result.durationMs} ms: ${result.message}`,
      }));
      refresh();
    } catch (cause) {
      setTests((now) => ({ ...now, [entry.purpose]: errorText(cause) }));
    }
  };
  const apply = async (entry: (typeof TASKS)[number]) => {
    try {
      if (kind === "codex") {
        await sdk.plugins.updateSettings({ pluginId: "provider-codex", values: { [entry.key]: choice.model } });
        try {
          await sdk.system.setAiServiceSelection({
            task: entry.task,
            selection: { mode: "service", pluginId: "provider-codex", serviceId: entry.serviceId },
          });
        } catch (cause) {
          throw new Error(`The model was saved, but selecting its automatic helper service failed: ${errorText(cause)}`);
        }
        setMessage(`Automatic ${entry.noun} helper now uses ${choice.model} on the primary machine. This is a server-wide helper choice; scoped delivery-task overrides above are separate.`);
      } else if (kind === "claude") {
        const current = helper ?? (await rpc.call("delivery_helper_models", {}));
        if (!current.serviceRegistered)
          throw new Error("This version of bb does not offer AI services to plugins, so a Claude model cannot write titles here.");
        await rpc.call("delivery_helper_models_set", { purpose: entry.purpose, choice });
        try {
          await sdk.system.setAiServiceSelection({
            task: entry.task,
            selection: { mode: "service", pluginId, serviceId: entry.serviceId },
          });
        } catch (cause) {
          throw new Error(`The model was saved, but selecting its automatic helper service failed: ${errorText(cause)}`);
        }
        setMessage(`Automatic ${entry.noun} helper now uses ${choice.model} through Claude on this machine. Run the test below to see it answer.`);
      }
      refresh();
    } catch (cause) {
      setMessage(errorText(cause));
    }
  };
  const release = async (entry: (typeof TASKS)[number]) => {
    try {
      await sdk.system.setAiServiceSelection({ task: entry.task, selection: { mode: "automatic" } });
      await rpc.call("delivery_helper_models_set", { purpose: entry.purpose, choice: null });
      setMessage(`${entry.label} are back on automatic.`);
      refresh();
    } catch (cause) {
      setMessage(errorText(cause));
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" aria-label="Title and commit helpers">
      <h3 className="text-[13px] font-medium">Who writes titles and commit messages</h3>
      <p className="text-[13px] leading-5 text-muted-foreground">
        This is bb's own helper, used for chat titles, branch names and commit messages. Pick a Codex or a Claude model in the picker below,
        then use it here.
      </p>
      <ul className="space-y-3 text-[13px]">
        {TASKS.map((entry) => (
          <li key={entry.task} className="space-y-1">
            <div>
              <span className="font-medium text-foreground">{entry.label}</span>:{" "}
              {services ? describeSelection(services.selections[entry.task], services.services) : "Reading..."}
            </div>
            <div className="flex flex-wrap gap-2">
              <button className={button} onClick={() => void test(entry)}>
                {`Test the ${entry.noun} helper`}
              </button>
              <button
                className={button}
                disabled={services?.selections[entry.task].mode === "automatic"}
                onClick={() => void release(entry)}
              >
                {`Return ${entry.label.toLowerCase()} to automatic`}
              </button>
            </div>
            {tests[entry.purpose] && <p role="status">{tests[entry.purpose]}</p>}
          </li>
        ))}
      </ul>
      {active && (
        <div className="flex flex-wrap items-center gap-2">
          <button className={button} disabled={!kind} onClick={() => void apply(active)}>
            {`Use chosen model for automatic ${active.noun} helper`}
          </button>
          {choice.model && !kind && <span className="text-[13px] leading-5 text-muted-foreground">Titles and commit messages can use a Codex or a Claude model.</span>}
        </div>
      )}
      {message && <p role="alert" className="text-[13px] leading-5 text-muted-foreground">{message}</p>}
      <div className="text-[13px] leading-5 text-muted-foreground">
        <p className="font-medium text-foreground">Latest runs through the Console</p>
        {helper && helper.runs.length > 0 ? (
          <ul>
            {helper.runs.map((run) => (
              <li key={`${run.at}-${run.purpose}`}>
                {`${new Date(run.at).toLocaleString()}: ${run.purpose}, ${run.model}, ${run.ms} ms, ${run.ok ? run.preview : `failed: ${run.error}`}`}
              </li>
            ))}
          </ul>
        ) : (
          <p>No Claude helper run yet. Codex helper runs are logged by bb's own AI Services page, and the test button above shows one live answer.</p>
        )}
      </div>
    </div>
  );
}

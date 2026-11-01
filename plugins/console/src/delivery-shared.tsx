import { useEffect, useRef, useState } from "react";
import {
  experimental_ProviderModelPicker as ModelPicker,
  useBbNavigate,
  useComposers,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import type { deliveryRpcContract } from "../delivery-contract";
import { queueNewChatSelection } from "./composer-bridge";
import { deliveryPrompt, type DeliveryPurpose } from "./delivery-prompts";
import { outlineButton } from "./controls";
export const button = outlineButton;
export const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
export function TaskDraft({
  purpose,
  threadId,
  projectId,
  hostId,
  context,
}: {
  purpose: DeliveryPurpose;
  threadId?: string;
  projectId: string | null;
  hostId: string | null;
  context: string;
}) {
  const rpc = useRpc<typeof deliveryRpcContract>(),
    composers = useComposers(),
    navigate = useBbNavigate();
  const [choice, setChoice] = useState<ExperimentalProviderModelPickerValue>({
      providerId: "",
      model: "",
      reasoningLevel: "medium",
    }),
    [message, setMessage] = useState("");
  const request = useRef(0);
  useEffect(() => {
    const seq = ++request.current;
    void rpc
      .call("delivery_settings", { projectId, hostId })
      .then((settings) => {
        if (seq !== request.current) return;
        const model = settings.resolved.find((entry) => entry.purpose === purpose)?.choice;
        setChoice(
          model
            ? (model as ExperimentalProviderModelPickerValue)
            : { providerId: "", model: "", reasoningLevel: "medium" },
        );
      })
      .catch((cause) => {
        if (seq === request.current) setMessage(errorText(cause));
      });
    return () => {
      request.current++;
    };
  }, [rpc, projectId, hostId, purpose]);
  const matching = composers.filter(
    (composer) => composer.scope.kind === "thread" && composer.scope.threadId === threadId,
  );
  const prepare = async () => {
    try {
      if (matching.length !== 1)
        throw new Error(
          "Open exactly one composer for this physical thread before preparing the task.",
        );
      const composer = matching[0];
      if (!composer.isEmpty)
        throw new Error("Keep the current draft. Clear or send it before preparing another task.");
      if (!choice.providerId || !choice.model)
        throw new Error("Choose the provider and model explicitly.");
      const applied = await composer.setSelection(choice);
      if (applied.providerId !== choice.providerId || applied.model !== choice.model)
        throw new Error(
          "The owner machine reconciled this model to another choice. Check its provider/model picker before continuing.",
        );
      if (composer.scope.kind !== "thread" || composer.scope.threadId !== threadId)
        throw new Error(
          "The composer changed while its model was resolving. Prepare the task again in the intended physical thread.",
        );
      // A provider switch may have inserted a native handoff block. Preserve it and any intervening typing.
      composer.replace((draft) => ({
        text: `${draft.text}${draft.text ? "\n\n" : ""}${deliveryPrompt(purpose, context)}`,
        mentions: [...draft.mentions],
      }));
      composer.focus();
      setMessage(
        "Prepared in the native composer with your selected model. Review it and press Send.",
      );
    } catch (cause) {
      setMessage(errorText(cause));
    }
  };
  const openNewChat = () => {
    queueNewChatSelection(choice);
    navigate.toCompose({
      ...(projectId ? { projectId } : {}),
      ...(hostId ? { hostId } : {}),
      initialPrompt: deliveryPrompt(purpose, context),
      focusPrompt: true,
    });
    setMessage(
      "Opened a new chat with the task and your selected model. Review it and press Send.",
    );
  };
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-[13px] font-medium">Prepare {purpose} task</p>
      <ModelPicker
        value={choice}
        onChange={setChoice}
        routing={hostId ? { kind: "host", hostId } : undefined}
      />
      {threadId ? (
        <button
          className={button}
          disabled={!choice.model || matching.length !== 1}
          onClick={() => void prepare()}
        >
          Put task in this thread's composer
        </button>
      ) : (
        <button className={button} disabled={!choice.model} onClick={openNewChat}>
          Put task in a new chat's composer
        </button>
      )}
      {message && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}

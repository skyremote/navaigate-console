export interface RelayStatus { tone: "ok" | "bad" | "muted"; text: string }
export interface RelayAnswer { text: string; state: string; truncated: boolean }

type ThreadTell = (input: { machine: string; threadId: string; message: string; requestId: string }) => Promise<{ requestId: string; delivered: boolean; delivery: string; note?: string | undefined }>;
type WorkStart = (input: { machine: string; prompt: string; requestId: string }) => Promise<{ outcome: "started" | "sent"; requestId: string }>;
type OutputGet = (input: { machine: string; threadId: string }) => Promise<{ state: string; output: string; truncated: boolean }>;
export interface RelayCalls { thread_tell: ThreadTell; work_start: WorkStart; thread_output_get: OutputGet }

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The same text keeps the same request id, so a retry after a lost reply cannot send twice. */
export function nextRequestId(current: { draft: string; id: string } | null, draft: string, mint: () => string = () => crypto.randomUUID()): { draft: string; id: string } {
  return current !== null && current.draft === draft ? current : { draft, id: mint() };
}

export async function submitRelay(rpc: RelayCalls, input: { machine: string; threadId: string | null; text: string; requestId: string }): Promise<{ ok: boolean; status: RelayStatus }> {
  try {
    if (input.threadId !== null) {
      const sent = await rpc.thread_tell({ machine: input.machine, threadId: input.threadId, message: input.text, requestId: input.requestId });
      return { ok: true, status: { tone: "ok", text: sent.delivered ? `Delivered to ${input.machine}${sent.delivery === "queued" ? " (queued behind the current turn)" : ""}. Receipt ${sent.requestId}` : `Queued for ${input.machine}; it is not delivered yet. Receipt ${sent.requestId}${sent.note ?? ""}` } };
    }
    const started = await rpc.work_start({ machine: input.machine, prompt: input.text, requestId: input.requestId });
    return { ok: true, status: { tone: "ok", text: started.outcome === "started" ? `Started on ${input.machine}. Receipt ${started.requestId}: its answer shows under Sent from here` : `Sent to ${input.machine}; it starts when the machine picks it up. Receipt ${started.requestId}` } };
  } catch (cause) {
    return { ok: false, status: { tone: "bad", text: reason(cause) } };
  }
}

export async function readAnswerOf(rpc: RelayCalls, machine: string, threadId: string): Promise<{ ok: true; answer: RelayAnswer } | { ok: false; status: RelayStatus }> {
  try {
    const found = await rpc.thread_output_get({ machine, threadId });
    return { ok: true, answer: { text: found.output, state: found.state, truncated: found.truncated } };
  } catch (cause) {
    return { ok: false, status: { tone: "bad", text: reason(cause) } };
  }
}

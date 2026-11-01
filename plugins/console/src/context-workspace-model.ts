import { z } from "zod";

const id = z.string().min(1).max(300);
const range = {
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  label: z.string().max(1000),
};
export const contextMentionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...range,
    kind: z.literal("thread"),
    threadId: id,
    projectId: id.optional(),
  }),
  z.object({ ...range, kind: z.literal("project"), projectId: id }),
  z.object({ ...range, kind: z.literal("section"), sectionId: id }),
  z.object({
    ...range,
    kind: z.literal("path"),
    path: id,
    source: z.enum(["workspace", "thread-storage"]),
    entryKind: z.enum(["file", "directory"]),
  }),
  z.object({ ...range, kind: z.literal("attachment"), path: id }),
  z.object({
    ...range,
    kind: z.literal("plugin"),
    pluginId: id,
    provider: id,
    id,
    icon: z.string().nullable().optional(),
  }),
  z.object({
    ...range,
    kind: z.literal("command"),
    trigger: z.enum(["$", "/"]),
    name: id,
    source: z.enum(["command", "skill"]),
    origin: z.enum(["builtin", "project", "user"]),
    argumentHint: z.string().nullable(),
  }),
]);
export const contextAttachmentSchema = z
  .object({
    type: z.enum(["localFile", "localImage"]),
    path: z.string().min(1).max(4000),
    name: z.string().min(1).max(500),
    mimeType: z.string().max(200).optional(),
    sizeBytes: z.number().nonnegative().optional(),
    sourceProjectId: id.optional(),
    hostId: id.optional(),
  })
  .refine(
    (a) => !(a.hostId && a.sourceProjectId),
    "An attachment has one owner",
  );
export const contextDraftSchema = z
  .object({
    text: z.string().max(200_000),
    mentions: z.array(contextMentionSchema).max(200),
    attachments: z.array(contextAttachmentSchema).max(30),
  })
  .superRefine((draft, ctx) => {
    const sorted = [...draft.mentions].sort((a, b) => a.from - b.from);
    for (let i = 0; i < sorted.length; i++)
      if (
        sorted[i].to <= sorted[i].from ||
        sorted[i].to > draft.text.length ||
        (i && sorted[i].from < sorted[i - 1].to)
      )
        ctx.addIssue({ code: "custom", message: "Invalid mention ranges" });
  });
export const contextSelectionSchema = z
  .object({
    projectId: id.optional(),
    providerId: id.optional(),
    model: z.string().max(300).optional(),
    reasoningLevel: z.string().max(100).optional(),
    serviceTier: z.string().max(100).optional(),
    permissionMode: z.string().max(100).optional(),
  })
  .passthrough();
export const contextDestinationSchema = z.object({
  projectId: id,
  composerKey: id,
  threadId: id.nullable(),
  hostId: id.nullable(),
  label: z.string().max(500),
});
export const contextSaveInput = z.object({
  requestId: z.string().uuid(),
  title: z.string().trim().min(1).max(150),
  draft: contextDraftSchema,
  destination: contextDestinationSchema,
  selection: contextSelectionSchema.nullable(),
});
export const contextDraftSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  destination: contextDestinationSchema,
  attachmentCount: z.number(),
  bytes: z.number(),
  createdAt: z.number(),
  textPreview: z.string(),
});
/** Guest review lifetimes offered in the Reviews tab; the server accepts 5 to 1440 minutes. */
export const GUEST_REVIEW_EXPIRY_OPTIONS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "24 hours" },
] as const;
export type GuestReviewExpiryMinutes =
  (typeof GUEST_REVIEW_EXPIRY_OPTIONS)[number]["minutes"];
export type ContextDraft = z.infer<typeof contextDraftSchema>;
export type ContextSave = z.infer<typeof contextSaveInput>;
export type ContextDraftSummary = z.infer<typeof contextDraftSummarySchema>;
export const MAX_DRAFT_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, value]) => value !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, canonical(value)]),
        )
      : v;
export const sameDraft = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function quoteContext(input: {
  threadId?: string;
  messageSeq?: number;
  source?: string;
  quote: string;
  comment: string;
}) {
  // Text and comment are independent data fields, retaining their exact whitespace.
  return `Review this source excerpt:\n${JSON.stringify({ source: input.source ?? (input.threadId ? `@thread:${input.threadId}${input.messageSeq === undefined ? "" : `#msg=${input.messageSeq}`}` : "Unspecified source"), quotedText: input.quote, comment: input.comment }, null, 2)}`;
}
export function droppedThread(
  data: string,
): {
  kind: "thread";
  from: number;
  to: number;
  label: string;
  threadId: string;
  projectId?: string;
} | null {
  try {
    const value = z
      .object({
        id,
        projectId: id.optional(),
        title: z.string().max(300).optional(),
      })
      .parse(JSON.parse(data));
    const label = value.title ?? value.id;
    return {
      kind: "thread",
      from: 0,
      to: label.length,
      label,
      threadId: value.id,
      ...(value.projectId ? { projectId: value.projectId } : {}),
    };
  } catch {
    return null;
  }
}

/** What a rail row puts on the drag: itself, and every selected chat when it is dragged out of a multi-selection. */
export function threadDragPayload(thread: { id: string; projectId: string; title: string | null }, targets: readonly string[]): string {
  return JSON.stringify({ id: thread.id, projectId: thread.projectId, title: thread.title ?? thread.id, ...(targets.length > 1 ? { ids: [...targets] } : {}) });
}

export type DroppedThreadMention = NonNullable<ReturnType<typeof droppedThread>>;

/** Every chat in a rail drag: the dragged row, plus the rest of a multi-selection, each titled from the sidebar where it is known. */
export function droppedThreads(data: string, titleOf: (threadId: string) => string | undefined): DroppedThreadMention[] {
  const first = droppedThread(data);
  if (!first) return [];
  let ids: string[] = [];
  try {
    const parsed = z.object({ ids: z.array(id).max(200) }).safeParse(JSON.parse(data));
    ids = parsed.success ? parsed.data.ids : [];
  } catch { ids = []; }
  const out: DroppedThreadMention[] = [first];
  for (const threadId of ids) {
    if (out.some((mention) => mention.threadId === threadId)) continue;
    const label = titleOf(threadId) ?? threadId;
    out.push({ kind: "thread", from: 0, to: label.length, label, threadId });
  }
  return out;
}

export type ImportedMessage = { role: "user" | "assistant"; text: string };
/**
 * User-role text that the harness injected rather than the person typed:
 * Codex workspace context and AGENTS.md instructions, and Claude Code
 * background task notifications. Observed in real always-on Mac histories (2026-10-30).
 */
const INJECTED_USER_TEXT = /^\s*(?:<environment_context>|# AGENTS\.md|<task-notification>)/;
/** Bounded visible text import. Never imports tool results, reasoning, credentials or provider state. */
export function parseNativeTranscript(raw: string): {
  messages: ImportedMessage[];
  omitted: number;
  provider: string;
} {
  if (new TextEncoder().encode(raw).byteLength > 5 * 1024 * 1024)
    throw new Error("Select a transcript smaller than 5 MB.");
  const messages: ImportedMessage[] = [];
  let provider = "unknown",
    omitted = 0;
  for (const line of raw.split(/\r?\n/).filter((s) => s.trim())) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      omitted++;
      continue;
    }
    const codex = event.type === "response_item";
    // Claude Code also writes request blobs, attachments and settings records
    // that carry a message with a role; only user/assistant records are turns.
    const claude = event.type === "user" || event.type === "assistant";
    const payload = codex ? event.payload : claude ? event.message : null;
    if (codex) provider = "codex";
    if (claude) provider = "claude-code";
    if (
      !payload ||
      (claude && event.isMeta === true) ||
      (payload.role !== "user" && payload.role !== "assistant") ||
      (payload.type && payload.type !== "message")
    ) {
      omitted++;
      continue;
    }
    const content = payload.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (b: any) =>
                  ["text", "input_text", "output_text"].includes(b?.type) &&
                  typeof b.text === "string" &&
                  !(payload.role === "user" && INJECTED_USER_TEXT.test(b.text)),
              )
              .map((b: any) => b.text)
              .join("\n")
          : "";
    if (payload.role === "user" && INJECTED_USER_TEXT.test(text)) {
      omitted++;
      continue;
    }
    if (text.trim())
      messages.push({ role: payload.role, text: text.slice(0, 30_000) });
    else omitted++;
  }
  if (!messages.length)
    throw new Error(
      "No visible Claude or Codex user/assistant messages were found.",
    );
  const bounded =
    messages.length > 200 ? [messages[0], ...messages.slice(-199)] : messages;
  return {
    messages: bounded,
    omitted: omitted + messages.length - bounded.length,
    provider,
  };
}

// Session profiles: how a chat was set up when it started from the home
// screen's Online / Local orbs. Shared by the app (orbs, badges, filters) and
// the server (the lean settings folder for Claude chats marked lean).
//
// A chat carries its profile as this plugin's thread metadata:
//   sessionProfile: { profile: "lean" | "local" | "local-unlocked", model?, v: 1 }
// A chat without the mark counts as Online, which is every chat started any
// other way. The mark is worked out from what was actually submitted (the
// embedded new-chat box lets the owner change provider and model), never from
// the orb alone.
import { z } from "zod";
import { LOCAL_START_MODES, type LocalStartMode } from "../lib/profile-console";

export const SESSION_PROFILE_KEY = "sessionProfile";
export const SESSION_PROFILES = ["lean", "local", "local-unlocked"] as const;
export type SessionProfileKind = (typeof SESSION_PROFILES)[number];
export type SessionProfileMark = { profile: SessionProfileKind; model?: string; v: 1 };

/** The Claude provider: a lean chat is a Claude chat that starts with the lean settings folder. */
export const LEAN_PROVIDER = "claude-code";
/** The provider that runs models on this Mac (opencode, through Ollama or LM Studio). */
export const LOCAL_PROVIDER = "acp-opencode";
/** Model ids opencode gives local models: Ollama and LM Studio on this Mac. */
export const LOCAL_MODEL_PREFIXES = ["ollama/", "lmstudio/"] as const;

const markSchema = z
  .object({ profile: z.enum(SESSION_PROFILES), model: z.string().min(1).max(300).optional(), v: z.literal(1) })
  .strip();

/** The profile mark inside this plugin's metadata for a chat, or null for an Online chat (no mark, or one this version cannot read). */
export function readSessionProfile(metadata: unknown): SessionProfileMark | null {
  if (!metadata || typeof metadata !== "object") return null;
  const parsed = markSchema.safeParse((metadata as Record<string, unknown>)[SESSION_PROFILE_KEY]);
  return parsed.success ? parsed.data : null;
}

/** The metadata seed for `threads.spawn`, or undefined for an Online chat (which carries nothing). */
export function sessionProfileMetadata(mark: SessionProfileMark | null): Record<string, SessionProfileMark> | undefined {
  return mark ? { [SESSION_PROFILE_KEY]: mark } : undefined;
}

export const isLocalModel = (id: string): boolean => LOCAL_MODEL_PREFIXES.some((p) => id.toLowerCase().startsWith(p));

/**
 * True when Ollama serves the model from somewhere other than this Mac. A signed-in Ollama lists its
 * cloud models beside local ones; Ollama marks them with remote_host / remote_model in /api/tags and
 * /api/show. The ":cloud" / "-cloud" tag Ollama gives them is checked too, as a second sign (and the
 * only one the app has without asking the server). Shared by the route, the tool check and the orb list.
 */
export function isRemoteModel(entry: { name?: unknown; model?: unknown; remote_host?: unknown; remote_model?: unknown }): boolean {
  const set = (v: unknown) => typeof v === "string" && v.length > 0;
  if (set(entry.remote_host) || set(entry.remote_model)) return true;
  const name = String(entry.name ?? entry.model ?? "");
  return /(:|-)cloud$/i.test(name);
}

/** The owner's own list of unlocked models (the plugin setting), one per line; blank lines and # comments are ignored. */
export function parseUnlockedList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * The owner's own unlocked models: exact ids or names (from the plugin's settings or the profile)
 * and words that mark a model as unlocked when its id or name contains them (from the profile only).
 * No model is listed by default; the words default to "abliterated" and "uncensored" (lib/profile-console.ts),
 * and an empty word list in the profile with no models listed means no padlock at all. NO_UNLOCKED is the
 * empty list used until the server has answered.
 */
export type UnlockedList = { models: readonly string[]; words: readonly string[] };
export const NO_UNLOCKED: UnlockedList = { models: [], words: [] };
/** Whether any model or word is set (the default words are); with none the padlock is never drawn. */
export const hasUnlockedList = (list: UnlockedList): boolean => list.models.length > 0 || list.words.length > 0;

/**
 * Whether a local model is unlocked: the owner listed it by id or name, or its id or name contains
 * one of the owner's words. Nothing in this code treats any model as unlocked by itself.
 */
export function isUnlockedModel(model: { id: string; name?: string | null }, list: UnlockedList = NO_UNLOCKED): boolean {
  const names = [model.id, model.name ?? ""].map((s) => s.toLowerCase()).filter(Boolean);
  const words = list.words.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
  if (words.length > 0 && names.some((n) => words.some((w) => n.includes(w)))) return true;
  const listed = new Set(list.models.map((e) => e.trim().toLowerCase()).filter(Boolean));
  return names.some((n) => listed.has(n));
}

/** The feature-map ids of Local chats on Claude Code (comes on with Online or Local, unless a saved pick says off) and Lean chats (private). */
export const LOCAL_CLAUDE_FEATURE = "EXTRA-AM";
/** The Local loadout: part of Local chats on Claude Code (always on with it; the panel's None gives a chat none of your skills and agents). */
export const LOCAL_LOADOUT_FEATURE = "EXTRA-AO";
export const LEAN_FEATURE = "EXTRA-AN";

/** What the home screen's orbs are set to. Online + Full is today's behaviour. */
export type LocalHarness = "claude" | "opencode";
export type HomeChoice = { where: "online" | "local"; online: "full" | "lean"; localModel: string | null; localHarness: LocalHarness };
export const DEFAULT_HOME_CHOICE: HomeChoice = { where: "online", online: "full", localModel: null, localHarness: "claude" };

/** How opencode names Ollama and LM Studio models; both can run on the Claude Code harness (see canRunOnClaude). */
export const OLLAMA_PREFIX = "ollama/";
export const LMSTUDIO_PREFIX = "lmstudio/";
/** Ollama and LM Studio models can run on the Claude Code harness: the route on the bb server forwards to either. */
export const canRunOnClaude = (modelId: string): boolean => modelId.toLowerCase().startsWith(OLLAMA_PREFIX) || modelId.toLowerCase().startsWith(LMSTUDIO_PREFIX);
/**
 * Whether the chosen model can call tools on the Claude Code harness, as the server reads it from
 * Ollama or LM Studio: "checking" until it answers, "unknown" when the runtime did not say.
 */
export type ToolCheck = { state: "checking" | "yes" | "no" | "small" | "remote" | "unknown" | "family"; reason?: string; window?: number | null; need?: number };
/**
 * The harness a Local chat on this model really uses. Claude Code only when it is allowed (the
 * feature is ticked) and for a model that can call tools: Claude Code is built around tools, and a
 * model that cannot call them only describes them.
 */
export const harnessFor = (choice: HomeChoice, modelId: string | null | undefined, tools: ToolCheck, claudeAllowed = true): LocalHarness =>
  claudeAllowed && choice.localHarness === "claude" && !!modelId && canRunOnClaude(modelId) && tools.state === "yes" ? "claude" : "opencode";
/**
 * A Local chat on the Claude Code harness: provider claude-code, and Ollama's own
 * name for the model. Anthropic does not know that name, so a chat that ever
 * missed the local route is refused, never answered by a Claude model.
 *
 * Provider and model are marked "explicit". bb's server keeps a requested
 * provider or model only when it carries a source; without one it silently
 * swaps in the project's remembered model (16 Nov 2026: every Local chat ran
 * as claude-opus-5-5 and the route answered 404). The composer cannot be seeded
 * with the Ollama name instead: its picker does not list that name for Claude
 * Code, so it would fall back to a Claude model and send that as explicit.
 */
type ExecutionSource = "explicit" | "client-preference";
/**
 * The permission mode. The box is seeded with the profile's mode (`defaultPermissionMode`), and
 * bb marks a seeded mode "explicit" whatever the user does, so an explicit Accept Edits or Full
 * Access is what the picker showed and is kept. Everything else becomes `startMode`: auto ("Approve
 * for me", never used for a local model), and any mode not marked explicit, which means the seed
 * was not applied and the mode is the project's remembered one, never shown as the user's choice.
 * The result is marked "explicit": like the model, bb's server drops a mode that carries no source.
 */
export function localClaudeRequest<
  T extends { providerId: string; model: string; permissionMode?: string; executionInputSources?: Partial<Record<string, ExecutionSource>> },
>(request: T, modelId: string, startMode: LocalStartMode): T {
  const shown = request.executionInputSources?.permissionMode === "explicit" && (LOCAL_START_MODES as readonly unknown[]).includes(request.permissionMode);
  return {
    ...request,
    providerId: LEAN_PROVIDER,
    // Ollama's own name for an Ollama model; an LM Studio model keeps its prefix, so the route knows where it runs.
    model: modelId.startsWith(OLLAMA_PREFIX) ? modelId.slice(OLLAMA_PREFIX.length) : modelId,
    permissionMode: shown ? request.permissionMode : startMode,
    executionInputSources: { ...(request.executionInputSources ?? {}), providerId: "explicit", model: "explicit", permissionMode: "explicit" },
  };
}
export function markForLocalClaude(model: { id: string; name?: string }, list?: UnlockedList): SessionProfileMark {
  return { profile: isUnlockedModel(model, list) ? "local-unlocked" : "local", model: model.id, v: 1 };
}
/**
 * The title a Local chat starts with, made here from the prompt. A chat started with a title skips
 * bb's own title writing, which sends the first message to an online AI service; a Local chat's
 * prompt is meant to stay on this Mac. The first 60 characters, cut at a word.
 */
export function localChatTitle(input: ReadonlyArray<{ type?: string; text?: string }>): string {
  const text = input
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Local chat";
  if (text.length <= 60) return text;
  const cut = text.slice(0, 61);
  const space = cut.lastIndexOf(" ");
  return `${(space >= 20 ? cut.slice(0, space) : text.slice(0, 60)).replace(/[\s,.;:!?-]+$/, "")}…`;
}
export const isLocalMark = (mark: SessionProfileMark | null | undefined): boolean => mark?.profile === "local" || mark?.profile === "local-unlocked";
export const HOME_CHOICE_KEY = "nav-skin:home-session-choice";

/** True when the home screen should behave exactly as it does without this feature. */
export const isPlainOnline = (c: HomeChoice): boolean => c.where === "online" && c.online === "full";

export function parseHomeChoice(raw: string | null | undefined): HomeChoice {
  if (!raw) return DEFAULT_HOME_CHOICE;
  try {
    const v = JSON.parse(raw) as Partial<HomeChoice>;
    return {
      where: v.where === "local" ? "local" : "online",
      online: v.online === "lean" ? "lean" : "full",
      localModel: typeof v.localModel === "string" && v.localModel.length > 0 && v.localModel.length <= 300 ? v.localModel : null,
      localHarness: v.localHarness === "opencode" ? "opencode" : "claude",
    };
  } catch {
    return DEFAULT_HOME_CHOICE;
  }
}

/**
 * The mark for a chat being started, from what was actually submitted. Lean
 * only when the provider really is Claude; local only when the model really is
 * a local one. Anything else starts as an ordinary Online chat with no mark.
 */
export function markForRequest(
  choice: HomeChoice,
  request: { providerId: string; model: string },
  unlocked: { names?: Record<string, string>; list?: UnlockedList; remote?: readonly string[] } = {},
): SessionProfileMark | null {
  if (choice.where === "local") {
    if (request.providerId !== LOCAL_PROVIDER || !isLocalModel(request.model)) return null;
    // A model Ollama serves from its cloud is not a Local chat, whatever the box was set to.
    if (unlocked.remote?.includes(request.model) || isRemoteModel({ name: request.model })) return null;
    const open = isUnlockedModel({ id: request.model, name: unlocked.names?.[request.model] }, unlocked.list);
    return { profile: open ? "local-unlocked" : "local", model: request.model, v: 1 };
  }
  if (choice.online === "lean" && request.providerId === LEAN_PROVIDER) return { profile: "lean", v: 1 };
  return null;
}

export const PROFILE_LABEL: Record<SessionProfileKind, string> = { lean: "Lean", local: "Local", "local-unlocked": "Local, unlocked" };

/** The rail and Control room filter values; "online" means a chat with no mark. */
export type ProfileFilterValue = "online" | SessionProfileKind;
export const PROFILE_FILTERS: ReadonlyArray<{ value: ProfileFilterValue; label: string }> = [
  { value: "online", label: "Online" },
  { value: "lean", label: "Lean" },
  { value: "local", label: "Local" },
  { value: "local-unlocked", label: "Local, unlocked" },
];
export const matchesProfile = (kind: SessionProfileKind | null | undefined, filter: ProfileFilterValue | null): boolean =>
  filter === null || (filter === "online" ? !kind : kind === filter);

// Online or Local, on the new-chat screen: two glass orbs to the right of the
// N mark, drawn by the usage spheres' engine (usage-orb-engine.ts).
//
//   Online (default)  a chat exactly as today. Under it, Full / Lean, only where
//                     Lean is switched on and a lean settings folder is ready:
//                     Lean is a Claude chat that starts with that folder.
//   Local             a chat on a model that runs on this Mac (opencode through
//                     Ollama or LM Studio, or Claude Code where that is switched
//                     on). A model named with an unlocked word (by default
//                     abliterated or uncensored) or listed as unlocked opens the
//                     padlock, the orb glows and sparks rise; with an empty word
//                     list and no models listed there is no padlock at all.
//                     Where opencode will run the chat, a note warns when the
//                     skill list it sends makes the first prompt large (an
//                     estimate from the skill count).
//
// Online + Full changes nothing: bb's own typing box stays and the chat is
// created exactly as before, with no mark and no environment. Any other
// choice hides bb's typing box and shows bb's own new-chat box from inside the
// skin (the pattern of native-work-composer.tsx), which creates the chat with
// the profile mark. If that box cannot be shown, the screen falls back to
// Online. The choice is remembered per browser.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { Boundary } from "./boundary";
import { LoadoutDialog, LoadoutLine, useLoadout, type LoadoutState } from "./local-loadout-panel";
import { rememberSessionProfile } from "./session-profile-marks";
import { Segmented, prefersReducedMotion } from "./home-kit";
import { ORB_CENTRE_Y, ORB_RADIUS, mountOrb, toRgb, lightness, type OrbHandle, type Rgb } from "./usage-orb-engine";
import { useReducedMotion } from "./usage-orbs";
import { usePassedProbes } from "./core-probes";
import { isFeatureEnabled } from "./features-enabled";
import { useProfile, useProfileState } from "./use-profile";
import { LOCAL_START_MODE_LABEL, consoleSection, type LocalStartMode } from "../lib/profile-console";
import {
  DEFAULT_HOME_CHOICE,
  HOME_CHOICE_KEY,
  LEAN_FEATURE,
  LOCAL_CLAUDE_FEATURE,
  NO_UNLOCKED,
  hasUnlockedList,
  type UnlockedList,
  LEAN_PROVIDER,
  LOCAL_PROVIDER,
  canRunOnClaude,
  harnessFor,
  isLocalMark,
  localChatTitle,
  type ToolCheck,
  localClaudeRequest,
  markForLocalClaude,
  isLocalModel,
  isPlainOnline,
  isRemoteModel,
  isUnlockedModel,
  markForRequest,
  parseHomeChoice,
  sessionProfileMetadata,
  type HomeChoice,
} from "./session-profile";

/* --------------------------------- choice -------------------------------- */

function readChoice(): HomeChoice {
  try {
    return parseHomeChoice(typeof localStorage === "undefined" ? null : localStorage.getItem(HOME_CHOICE_KEY));
  } catch {
    return DEFAULT_HOME_CHOICE;
  }
}

/** The orbs' setting, kept per browser like the usage spheres' Left / Used switch. */
export function useHomeChoice(): [HomeChoice, (next: HomeChoice) => void] {
  const [choice, setChoice] = useState<HomeChoice>(readChoice);
  const change = (next: HomeChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(HOME_CHOICE_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  };
  return [choice, change];
}

/* ------------------------------ local models ----------------------------- */

export type LocalModel = { id: string; name: string; unlocked: boolean };
/** `remote`: the ids left out because Ollama serves them from its cloud. */
export type LocalModels = { state: "loading" } | { state: "ready"; models: LocalModel[]; remote?: readonly string[] } | { state: "none"; reason: string };

const MODELS_TTL_MS = 5 * 60_000;
/** How long the list waits for the server's list of cloud models; after that the name check alone applies. */
const REMOTE_WAIT_MS = 4000;
let modelsCache: { at: number; value: Array<{ id: string; name: string }>; remote: string[] } | null = null;
/** Forget the cached list, so the next home screen asks opencode again (tests use it too). */
export function forgetLocalModels() {
  modelsCache = null;
}

/**
 * The models on this Mac that opencode can run, read once every few minutes. A model Ollama serves
 * from its cloud is left out (the same isRemoteModel() the route refuses on): a Local chat's prompt
 * stays on this Mac on either harness.
 */
export function useLocalModels(extraUnlocked: UnlockedList): LocalModels {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const [raw, setRaw] = useState<{ state: "loading" } | { state: "ready"; models: Array<{ id: string; name: string }>; remote: string[] } | { state: "none"; reason: string }>(() =>
    modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS ? { state: "ready", models: modelsCache.value, remote: modelsCache.remote } : { state: "loading" },
  );
  useEffect(() => {
    if (raw.state !== "loading") return;
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const providers = (sdk as unknown as { providers?: { models?: (args: { providerId: string; signal?: AbortSignal }) => Promise<{ models: Array<{ id: string; model: string; displayName: string }>; modelLoadError?: { code: string } | null }> } }).providers;
    if (typeof providers?.models !== "function") {
      setRaw({ state: "none", reason: "This bb cannot list models" });
      return;
    }
    // Asked beside the list; if the server is slow or fails, only the ":cloud" name check applies.
    let cloudTimer: ReturnType<typeof setTimeout> | undefined;
    const cloud = Promise.race([
      rpc.call("local_models_remote", null).then(
        (r) => r.remote,
        () => [] as string[],
      ),
      new Promise<string[]>((resolve) => {
        cloudTimer = setTimeout(() => resolve([]), REMOTE_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(cloudTimer));
    Promise.all([providers.models({ providerId: LOCAL_PROVIDER, signal: controller.signal }), cloud])
      .then(([answer, remote]) => {
        if (!alive) return;
        const models = (answer.models ?? [])
          .map((m) => ({ id: m.model || m.id, name: m.displayName || m.model || m.id }))
          // "ollama/*": the server's Ollama is set to another machine, so no Ollama model is on this Mac.
          .filter((m) => isLocalModel(m.id) && !remote.includes(m.id) && !(remote.includes("ollama/*") && m.id.startsWith("ollama/")) && !isRemoteModel({ name: m.id }));
        if (models.length === 0) {
          setRaw({ state: "none", reason: answer.modelLoadError ? `opencode could not list models (${answer.modelLoadError.code})` : "No local model found" });
          return;
        }
        modelsCache = { at: Date.now(), value: models, remote };
        setRaw({ state: "ready", models, remote });
      })
      .catch(() => alive && setRaw({ state: "none", reason: "No local model found" }))
      .finally(() => clearTimeout(timer));
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(cloudTimer);
      controller.abort();
    };
  }, [sdk, rpc, raw.state]);
  return useMemo(() => {
    if (raw.state !== "ready") return raw;
    return { state: "ready", models: raw.models.map((m) => ({ ...m, unlocked: isUnlockedModel(m, extraUnlocked) })), remote: raw.remote };
  }, [raw, extraUnlocked]);
}

/**
 * What the server says about this Mac's setup: the owner's unlocked models and words (from the
 * plugin's settings and the profile), and whether a lean settings folder is ready. Until it answers
 * (or when it fails), nothing is unlocked and Lean is not offered.
 */
export type SessionProfileConfig = { unlocked: UnlockedList; leanReady: boolean };
const NO_CONFIG: SessionProfileConfig = { unlocked: NO_UNLOCKED, leanReady: false };
function useSessionProfileConfig(): SessionProfileConfig {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<SessionProfileConfig>(NO_CONFIG);
  useEffect(() => {
    let alive = true;
    rpc
      .call("session_profile_config", null)
      .then((r) => alive && setConfig({ unlocked: { models: r.unlockedModels ?? [], words: r.unlockedWords ?? [] }, leanReady: r.leanReady === true }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [rpc]);
  return config;
}

/**
 * Whether a feature is on, counting it off until the profile is known (the server answered, or a
 * profile from the last session is cached). The usual check shows everything while loading, which
 * is right for a page but not for the harness a chat starts on.
 */
function useSettledFeature(id: string): boolean {
  const state = useProfileState();
  const probes = usePassedProbes();
  if (!state.loaded && state.source === "defaults") return false;
  return isFeatureEnabled(state.profile, id, probes);
}

/* ------------------------- opencode's skill list ------------------------- */

/**
 * The size of a Local chat's first prompt on the opencode harness, as a floor. Base: a whole first turn
 * on a clean standard bb with no skills used 11,167 tokens (22 November 2026); on a setup with a large
 * connector catalogue and a long instruction block the same prompt was about 17,000 tokens before its
 * skills. Each skill opencode lists adds about 155 tokens (125,863 characters for 200 skills in a
 * captured prompt). Measured on one 48 GB Apple Silicon Mac, 21 to 22 November 2026; the 0-skill prompt
 * alone (6,077 tokens) was a terminal opencode run, not in bb. Only 0 and 200 skills were measured;
 * the numbers between are an estimate on a straight line.
 */
export const OPENCODE_BASE_TOKENS = 11_000;
export const OPENCODE_TOKENS_PER_SKILL = 155;
/** Above this estimate (about 91 skills) the first reply is slow. */
export const SKILLS_SLOW_TOKENS = 25_000;
/** Above this estimate (about 188 skills) the chat nears the 200-skill chats that gave no answer in 12 minutes. */
export const SKILLS_STALL_TOKENS = 40_000;
export const opencodeFirstPromptTokens = (skills: number): number => OPENCODE_BASE_TOKENS + OPENCODE_TOKENS_PER_SKILL * skills;

/** The server's count: `capped` at opencode's limit of 200; not `complete` when a bound stopped it early (a lower bound). */
export type SkillCount = { skills: number | null; capped: boolean; complete: boolean };

/**
 * The note on the Local orb when opencode will run the chat and its skill list makes the first prompt
 * large; null when the count is unknown or small.
 */
export function skillsNote(count: SkillCount | null | undefined): string | null {
  const skills = count?.skills;
  if (typeof skills !== "number" || !Number.isFinite(skills) || skills <= 0) return null;
  const tokens = opencodeFirstPromptTokens(skills);
  if (tokens <= SKILLS_SLOW_TOKENS) return null;
  const n = (v: number) => v.toLocaleString("en-GB");
  // "or more" only when the count stopped early (then the skills are "at least" this many).
  const about = `about ${n(Math.floor(tokens / 1000) * 1000)} tokens${count!.complete ? "" : " or more"} before your first word.`;
  const size = count!.capped
    ? `opencode sends your skills to the model: ${n(skills)} skills, opencode's limit, ${about}`
    : `opencode sends your whole skill list to the model: ${count!.complete ? "" : "at least "}${n(skills)} skills, ${about}`;
  const what =
    tokens > SKILLS_STALL_TOKENS
      ? "On our 48 GB test Mac, busy with other work, chats with 200 skills (about 48,000 tokens) gave no answer in 12 minutes."
      : "Expect a slow first reply.";
  return `${size} ${what} To shorten it, move skills you do not use out of ~/.claude/skills and ~/.agents/skills; your other Claude Code and agent chats stop seeing them too.`;
}

const SKILLS_TTL_MS = 3 * 60_000;
let skillsCache: { at: number; count: SkillCount } | null = null;
/** Forget the cached skill count (tests use it). */
export function forgetSkillCount() {
  skillsCache = null;
}
const freshSkills = (): SkillCount | undefined => (skillsCache && Date.now() - skillsCache.at < SKILLS_TTL_MS ? skillsCache.count : undefined);

/**
 * How many skills opencode would list, asked when the new-chat screen opens (before the model list,
 * which takes longer, so the note is there when Local first shows) and kept for a few minutes; null until known.
 */
export function useSkillCount(): SkillCount | null {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState<SkillCount | null>(() => freshSkills() ?? null);
  useEffect(() => {
    const known = freshSkills();
    if (known !== undefined) {
      setCount(known);
      return;
    }
    let alive = true;
    rpc.call("local_skills_count", null).then(
      (r) => {
        const next = { skills: r.skills, capped: r.capped === true, complete: r.complete === true };
        skillsCache = { at: Date.now(), count: next };
        if (alive) setCount(next);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [rpc]);
  return count;
}

/* --------------------------------- look ---------------------------------- */

const STYLE_ID = "nav-session-orbs-style";
const CSS = `
.nav-so-orb { transition: transform .25s ease, opacity .25s ease; }
.nav-so-body { display: block; transform-origin: 50% 100%; transition: transform .16s cubic-bezier(.3,0,.5,1); will-change: transform; }
.nav-so-orb:not(:disabled):hover .nav-so-body { transform: translateY(-2px) scale(1.03); }
.nav-so-orb:not(:disabled):active .nav-so-body { transform: translateY(5px) scale(1.16, .8); transition-duration: .09s; }
.nav-so-orb[data-pop="1"] .nav-so-body { animation: nav-so-pop .78s cubic-bezier(.2,.7,.2,1) both; }
@keyframes nav-so-pop {
  0% { transform: translateY(5px) scale(1.16, .8) }
  22% { transform: translateY(-14px) scale(.88, 1.2) }
  42% { transform: translateY(0) scale(1.12, .86) }
  60% { transform: translateY(-4px) scale(.96, 1.06) }
  78% { transform: translateY(0) scale(1.03, .98) }
  100% { transform: none }
}
.nav-so-glass { position: relative; border-radius: 9999px; transition: box-shadow .3s ease; }
.nav-so-mem { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; width: 224px; max-width: calc(100vw - 48px); }
.nav-so-mem-row { display: flex; align-items: center; gap: 7px; min-height: 26px; padding: 0 4px 0 9px; border-radius: 9999px; border: 1px solid var(--border); background: color-mix(in oklab, var(--card, #151517) 70%, transparent); }
.nav-so-mem-other { opacity: .75; }
.nav-so-mem-dot { flex: none; width: 7px; height: 7px; border-radius: 9999px; background: var(--muted-foreground); opacity: .5; }
.nav-so-mem-dot[data-on="1"] { background: var(--success); opacity: 1; box-shadow: 0 0 0 3px color-mix(in oklab, var(--success) 25%, transparent); }
.nav-so-mem-dot[data-on="wait"] { background: var(--warning); opacity: 1; animation: nav-so-wait 1s ease-in-out infinite; }
@keyframes nav-so-wait { 50% { opacity: .25 } }
.nav-so-mem-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; font-size: 11px; color: var(--muted-foreground); }
.nav-so-mem-btn { flex: none; height: 20px; padding: 0 9px; border-radius: 9999px; border: 1px solid var(--border); background: transparent; color: var(--foreground); font-size: 11px; font-weight: 500; cursor: pointer; transition: transform .12s ease, background .15s ease; }
.nav-so-mem-btn:hover:not(:disabled) { background: var(--accent, rgb(127 127 127 / .15)); }
.nav-so-mem-btn:active:not(:disabled) { transform: scale(.94); }
.nav-so-mem-btn[data-main="1"] { background: var(--foreground); color: var(--background, #0b0b0c); border-color: transparent; }
.nav-so-mem-btn[data-main="1"]:hover:not(:disabled) { background: var(--foreground); opacity: .88; }
.nav-so-mem-btn:disabled { opacity: .45; cursor: default; }
.nav-so-swap { animation: nav-so-swap .55s cubic-bezier(.3,1.5,.5,1) both; }
@keyframes nav-so-swap { 0% { opacity: 0; transform: scale(.3) rotate(-50deg) } 100% { opacity: 1; transform: none } }
.nav-so-badge { position: absolute; right: -7px; top: -7px; width: 30px; height: 30px; border-radius: 9999px; display: grid; place-items: center; pointer-events: none;
  background: color-mix(in oklab, var(--card, #151517) 88%, var(--nav-so-c)); border: 1px solid color-mix(in oklab, var(--nav-so-c) 55%, transparent); box-shadow: 0 2px 8px rgb(0 0 0 / .35); }
.nav-so-badge svg { width: 17px !important; height: 17px !important; }
.nav-so-orb[data-unlocked="true"] .nav-so-badge { animation: nav-so-badge .6s cubic-bezier(.3,1.6,.5,1) both; }
@keyframes nav-so-badge { 0% { transform: scale(.4) } 100% { transform: none } }
.nav-so-orb[aria-pressed="true"] .nav-so-glass { box-shadow: 0 0 30px color-mix(in oklab, var(--nav-so-c) 60%, transparent); }
.nav-so-orb[data-unlocked="true"] .nav-so-glass { animation: nav-so-pulse 2.2s ease-in-out infinite; }
@keyframes nav-so-pulse { 50% { box-shadow: 0 0 52px color-mix(in oklab, var(--nav-so-c) 85%, transparent); } }
.nav-so-shackle { transform-origin: 16px 11px; transition: transform .5s cubic-bezier(.3,1.6,.5,1); }
.nav-so-orb[data-unlocked="true"] .nav-so-shackle { transform: rotate(-38deg) translateY(-2px); }
.nav-so-spark { position: absolute; left: 50%; top: 58%; width: 4px; height: 4px; border-radius: 9999px; background: var(--nav-so-c); opacity: 0; pointer-events: none; }
.nav-so-orb[data-unlocked="true"] .nav-so-spark { animation: nav-so-rise 1.6s ease-out infinite; }
.nav-so-spark:nth-child(2) { animation-delay: .3s !important; --nav-so-x: -26px; }
.nav-so-spark:nth-child(3) { animation-delay: .6s !important; --nav-so-x: 22px; }
.nav-so-spark:nth-child(4) { animation-delay: .9s !important; --nav-so-x: -8px; }
.nav-so-spark:nth-child(5) { animation-delay: 1.2s !important; --nav-so-x: 30px; }
@keyframes nav-so-rise { 0% { opacity: 0; transform: translate(0, 0) } 20% { opacity: 1 } 100% { opacity: 0; transform: translate(var(--nav-so-x, 10px), -64px) } }
[data-nav-session-hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) {
  .nav-so-orb, .nav-so-glass, .nav-so-shackle, .nav-so-body { transition: none !important; }
  .nav-so-orb .nav-so-body, .nav-so-swap, .nav-so-badge { animation: none !important; transform: none !important; }
  .nav-so-mem-dot { animation: none !important; }
  .nav-so-orb[data-unlocked="true"] .nav-so-glass, .nav-so-orb[data-unlocked="true"] .nav-so-spark { animation: none !important; }
  .nav-so-orb[data-unlocked="true"] .nav-so-spark { opacity: .8; transform: translate(var(--nav-so-x, 10px), -30px); }
}
`;
export function ensureSessionOrbsStyle() {
  if (typeof document === "undefined") return;
  // A plugin reload keeps the page and its old style tag, so the text is replaced when it differs.
  const old = document.getElementById(STYLE_ID);
  if (old) {
    if (old.textContent !== CSS) old.textContent = CSS;
    return;
  }
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** The liquid of each orb: theme tokens only (the theme decides the colour). */
const LIQUID = {
  online: "var(--attention)",
  local: "var(--success)",
  unlocked: "var(--warning)",
  // One liquid per local model family, from the skin's own tag colours; each can be overridden.
  deepseek: "var(--nav-orb-deepseek, var(--nav-tc-teal, var(--success)))",
  qwen: "var(--nav-orb-qwen, var(--nav-tc-purple, var(--success)))",
  gemma: "var(--nav-orb-gemma, var(--nav-tc-pink, var(--success)))",
  llama: "var(--nav-orb-llama, var(--nav-tc-yellow, var(--success)))",
} as const;
type Liquid = keyof typeof LIQUID;

/** The family of a local model, read from its id or name. It picks the orb's liquid and icon. */
export type ModelFamily = "deepseek" | "qwen" | "gemma" | "llama" | "other";
export function modelFamily(model: { id: string; name?: string } | null | undefined): ModelFamily {
  const s = `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
  if (s.includes("deepseek")) return "deepseek";
  if (s.includes("qwen")) return "qwen";
  if (s.includes("gemma")) return "gemma";
  if (s.includes("llama")) return "llama";
  return "other";
}
const FAMILY_NAME: Record<ModelFamily, string> = { deepseek: "DeepSeek", qwen: "Qwen", gemma: "Gemma", llama: "Llama", other: "Local" };
const NEUTRAL: Rgb = [128, 128, 128];

/** The theme's colours as numbers for the canvas, read again when the theme changes. */
function useTokenRgb(): [{ ink: Rgb; dark: boolean; liquid: Record<Liquid, Rgb> }, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [palette, setPalette] = useState({ ink: NEUTRAL, dark: false, liquid: Object.fromEntries(Object.keys(LIQUID).map((k) => [k, NEUTRAL])) as Record<Liquid, Rgb> });
  useEffect(() => {
    if (!el) return;
    const read = () => {
      const resolve = (css: string): Rgb => {
        el.style.color = css;
        return toRgb(getComputedStyle(el).color, NEUTRAL);
      };
      const ink = resolve("var(--foreground)");
      const next = { ink, dark: lightness(ink) > 0.6, liquid: Object.fromEntries(Object.entries(LIQUID).map(([k, css]) => [k, resolve(css)])) as Record<Liquid, Rgb> };
      setPalette((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    read();
    const observer = typeof MutationObserver === "function" ? new MutationObserver(read) : null;
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => observer?.disconnect();
  }, [el]);
  return [palette, setEl];
}

function Globe() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" />
    </svg>
  );
}

function Padlock() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-9 overflow-visible" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path className="nav-so-shackle" d="M8 11V8a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="16" r="1.2" />
    </svg>
  );
}

const iconProps = { "aria-hidden": true, viewBox: "0 0 24 24", className: "size-9 overflow-visible", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const iconStyle = { width: 36, height: 36 } as const;

/** The icon of a model family: a whale for DeepSeek, a hexagon for Qwen, a gem for Gemma, a llama for Llama, a chip for the rest. */
function FamilyIcon({ family }: { family: ModelFamily }) {
  if (family === "deepseek")
    return (
      <svg {...iconProps} style={iconStyle}>
        <path d="M2.5 14c0-3.6 3.1-6.3 7.3-6.3 3.9 0 6.9 2.1 7.6 5.3l3.6-2.6c.3 2.6-.5 4.8-2.4 6.1-1.5 2.3-4.4 3.7-8.3 3.7-4.6 0-7.8-2.5-7.8-6.2z" />
        <circle cx="7" cy="13" r=".9" fill="currentColor" stroke="none" />
        <path d="M9.8 4.8c0-1.3-.9-2.2-2.2-2.3M9.8 4.8c0-1.3.9-2.2 2.2-2.3M9.8 4.8v1.4" />
      </svg>
    );
  if (family === "qwen")
    return (
      <svg {...iconProps} style={iconStyle}>
        <path d="M12 2.8l7.9 4.6v9.2L12 21.2l-7.9-4.6V7.4z" />
        <circle cx="12" cy="12" r="3.3" />
        <path d="M14.3 14.3l3 3" />
      </svg>
    );
  if (family === "gemma")
    return (
      <svg {...iconProps} style={iconStyle}>
        <path d="M6.5 4h11l4 5.2L12 20.5 2.5 9.2z" />
        <path d="M2.5 9.2h19M9.3 4L7.5 9.2 12 20.5l4.5-11.3L14.7 4" />
      </svg>
    );
  if (family === "llama")
    return (
      <svg {...iconProps} style={iconStyle}>
        <path d="M8 21v-8.5c0-1.4-1-2-1-3.5V4.5l2 1.8 1.5-2 1.5 2c1.5.3 2.5 1.5 2.5 3V12c2 .5 3.5 2 3.5 4.5V21" />
        <path d="M12 21v-4" />
        <circle cx="10.2" cy="8.5" r=".8" fill="currentColor" stroke="none" />
      </svg>
    );
  return (
    <svg {...iconProps} style={iconStyle}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <rect x="10" y="10" width="4" height="4" rx=".8" />
      <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
    </svg>
  );
}

const ORB_PX = 92;
/** The canvas box that makes the engine's sphere exactly ORB_PX wide. */
const CANVAS_PX = Math.round(ORB_PX / (ORB_RADIUS * 2));

function ChoiceOrb({ kind, liquid, palette, selected, unlocked = false, lock = false, disabled = false, family = null, level = 0.55, stirring = false, label, caption, onClick, children }: {
  /** Whether the padlock is drawn at all: only when the owner listed unlocked models. */
  lock?: boolean;
  /** How full the orb is: the Local orb fills when its model is in memory and drains when it is not. */
  level?: number;
  /** Bubbles while a model loads. */
  stirring?: boolean;
  /** The chosen local model's family; with it the orb shows that family's icon and the padlock moves to a badge. */
  family?: ModelFamily | null;
  kind: "online" | "local";
  liquid: Liquid;
  palette: { ink: Rgb; dark: boolean; liquid: Record<Liquid, Rgb> };
  selected: boolean;
  unlocked?: boolean;
  disabled?: boolean;
  label: string;
  caption: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<OrbHandle | null>(null);
  const reduced = useReducedMotion();
  const look = { level, liquid: palette.liquid[liquid], ink: palette.ink, dark: palette.dark, heat: 0, bubbles: (selected && !disabled) || stirring };
  const lookRef = useRef(look);
  lookRef.current = look;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const h = mountOrb(el, lookRef.current, { still: prefersReducedMotion() });
    handle.current = h;
    return () => {
      h?.destroy();
      handle.current = null;
    };
  }, []);
  useEffect(() => {
    handle.current?.setStill(reduced);
  }, [reduced]);
  // A new model family lands with the same bounce as a click, and the liquid sloshes.
  const button = useRef<HTMLButtonElement | null>(null);
  const firstFamily = useRef(true);
  useEffect(() => {
    if (firstFamily.current) {
      firstFamily.current = false;
      return;
    }
    const el = button.current;
    if (!el || !family) return;
    el.removeAttribute("data-pop");
    void el.offsetWidth;
    el.setAttribute("data-pop", "1");
    handle.current?.tap(0.6);
  }, [family]);
  useEffect(() => {
    handle.current?.set(lookRef.current);
  }, [look.level, look.bubbles, look.dark, look.liquid.join(","), look.ink.join(",")]);
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <button
        ref={button}
        type="button"
        data-nav-part="session-orb"
        data-orb-kind={kind}
        data-unlocked={unlocked ? "true" : "false"}
        aria-pressed={selected}
        aria-disabled={disabled || undefined}
        aria-label={`${label}: ${caption}`}
        disabled={disabled}
        onClick={(e) => {
          // Restart the landing bounce on every click, then hand over to the choice.
          const el = e.currentTarget;
          el.removeAttribute("data-pop");
          void el.offsetWidth;
          el.setAttribute("data-pop", "1");
          onClick?.();
        }}
        onAnimationEnd={(e) => {
          if (e.animationName === "nav-so-pop") e.currentTarget.removeAttribute("data-pop");
        }}
        onPointerEnter={(e) => e.pointerType === "mouse" && handle.current?.sweep()}
        onPointerDown={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          handle.current?.tap(box.width ? ((e.clientX - box.left) / box.width) * 2 - 1 : 0);
        }}
        className={cn(
          "nav-so-orb group flex min-w-0 flex-col items-center gap-1.5 rounded-[12px] px-1 pb-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "opacity-100" : "opacity-60 hover:opacity-90",
          disabled ? "cursor-not-allowed opacity-40 hover:opacity-40" : "cursor-pointer",
        )}
        data-family={family ?? undefined}
        style={{ ["--nav-so-c" as string]: unlocked ? LIQUID.unlocked : LIQUID[liquid], touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
      >
        <span className="nav-so-body" style={{ width: ORB_PX, height: ORB_PX }}>
        <span className="nav-so-glass block" style={{ width: ORB_PX, height: ORB_PX }}>
          {/* The engine draws its sphere 72% wide and centred 57% down, to leave room for flames on the
              usage orbs. Here the canvas is enlarged and shifted so the sphere fills the round glass exactly. */}
          <canvas
            ref={canvas}
            aria-hidden
            style={{ position: "absolute", display: "block", width: CANVAS_PX, height: CANVAS_PX, left: (ORB_PX - CANVAS_PX) / 2, top: ORB_PX / 2 - CANVAS_PX * ORB_CENTRE_Y, maxWidth: "none", pointerEvents: "none" }}
          />
          <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-foreground">
            {kind === "online" ? <Globe /> : family ? <span key={family} className="nav-so-swap grid place-items-center"><FamilyIcon family={family} /></span> : lock ? <Padlock /> : <FamilyIcon family="other" />}
          </span>
          {kind === "local" && family && lock ? (
            <span aria-hidden className="nav-so-badge text-foreground">
              <Padlock />
            </span>
          ) : null}
          {kind === "local" && lock ? (
            <span aria-hidden className="pointer-events-none absolute inset-0">
              <i className="nav-so-spark" />
              <i className="nav-so-spark" />
              <i className="nav-so-spark" />
              <i className="nav-so-spark" />
              <i className="nav-so-spark" />
            </span>
          ) : null}
        </span>
        </span>
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        <span className="block max-w-[140px] text-[11px] leading-snug text-muted-foreground">{caption}</span>
      </button>
      {children}
    </div>
  );
}

/* --------------------------- models in memory ---------------------------- */

/** `reachable` is Ollama; LM Studio answers for itself (absent from an older server: counted as Ollama's answer). */
type Memory = {
  reachable: boolean;
  lmStudio?: { reachable: boolean; reason?: string };
  loaded: Array<{ model: string; bytes: number; until: string | null; slots?: number }>;
  loading: string[];
  failed: Array<{ model: string; reason: string }>;
};
/** Ollama models can be loaded and unloaded from here; LM Studio loads its own. */
export const canHoldInMemory = (id: string) => id.startsWith("ollama/") || id.startsWith("lmstudio/");
export type MemoryStatus = "unknown" | "offline" | "loading" | "loaded" | "empty";
export function memoryStatus(memory: Memory | null, id: string): MemoryStatus {
  if (!memory) return "unknown";
  if (memory.loaded.some((m) => m.model === id)) return "loaded";
  if (memory.loading.includes(id)) return "loading";
  const up = id.startsWith("lmstudio/") ? (memory.lmStudio?.reachable ?? memory.reachable) : memory.reachable;
  return up ? "empty" : "offline";
}
/** Why the memory row cannot load a model: the runtime that model needs is not answering. */
export function offlineText(memory: Memory | null, id: string): string {
  return id.startsWith("lmstudio/") ? (memory?.lmStudio?.reason ?? "LM Studio is not running") : "Ollama is not running";
}
/** Under the memory row, for an LM Studio model loaded with several slots. */
export const slotsNote = (slots: number) =>
  `LM Studio holds this model with ${slots} slots, so a request sent again can be read again from the start, which takes minutes. To fix it: Unload, then Load (Load asks for one slot).`;
const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;

/** What Ollama holds in memory, asked while the Local orb is chosen: often during a load, seldom otherwise. */
export function useLocalMemory(active: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const busy = !!pending || (memory?.loading.length ?? 0) > 0;
  const ask = useRef<() => void>(() => {});
  useEffect(() => {
    if (!active) return;
    let alive = true;
    ask.current = () => {
      rpc
        .call("local_model_state", null)
        .then((s) => alive && setMemory(s))
        .catch(() => {});
    };
    ask.current();
    const timer = setInterval(() => document.visibilityState !== "hidden" && ask.current(), busy ? 2000 : 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active, rpc, busy]);
  const act = async (method: "local_model_load" | "local_model_unload", model: string) => {
    setPending(model);
    try {
      const answer = await rpc.call(method, { model });
      if (!answer.ok) toast.error(method === "local_model_load" ? "The model did not load" : "The model did not unload", { description: answer.reason });
    } catch (e) {
      toast.error("Ollama did not answer", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(null);
      ask.current();
    }
  };
  return { memory, pending, load: (model: string) => act("local_model_load", model), unload: (model: string) => act("local_model_unload", model) };
}

function ModelMemory({ model, local, mem }: { model: LocalModel; local: LocalModel[]; mem: ReturnType<typeof useLocalMemory> }) {
  const status = memoryStatus(mem.memory, model.id);
  const busy = mem.pending !== null;
  const mine = mem.memory?.loaded.find((m) => m.model === model.id);
  const others = (mem.memory?.loaded ?? []).filter((m) => m.model !== model.id).slice(0, 2);
  const failure = mem.memory?.failed.find((m) => m.model === model.id);
  // LM Studio loaded it (in LM Studio itself, or before this version) to serve several requests at once.
  const manySlots = status === "loaded" && (mine?.slots ?? 1) > 1;
  const nameOf = (id: string) => local.find((m) => m.id === id)?.name ?? id.replace(/^ollama\//, "");
  return (
    <div data-nav-part="local-memory" data-memory={status} className="nav-so-mem">
      <div className="nav-so-mem-row">
        <i className="nav-so-mem-dot" data-on={status === "loaded" ? "1" : status === "loading" ? "wait" : "0"} />
        <span className="nav-so-mem-text" title={status === "offline" ? offlineText(mem.memory, model.id) : failure?.reason}>
          {status === "loaded"
            ? `In memory${mine?.bytes ? ` · ${gigabytes(mine.bytes)}` : ""}${manySlots ? ` · ${mine!.slots} slots` : ""}`
            : status === "loading"
              ? "Loading into memory"
              : status === "offline"
                ? offlineText(mem.memory, model.id)
                : status === "unknown"
                  ? "Checking memory"
                  : failure
                    ? "The last load failed"
                    : "Not in memory"}
        </span>
        {status === "loaded" ? (
          <button type="button" className="nav-so-mem-btn" disabled={busy} onClick={() => void mem.unload(model.id)}>
            Unload
          </button>
        ) : status === "empty" ? (
          <button type="button" className="nav-so-mem-btn" data-main="1" disabled={busy} onClick={() => void mem.load(model.id)}>
            Load
          </button>
        ) : status === "loading" ? (
          <button type="button" className="nav-so-mem-btn" disabled={busy} onClick={() => void mem.unload(model.id)}>
            Stop
          </button>
        ) : null}
      </div>
      {manySlots ? (
        <p data-nav-part="local-memory-slots" className="px-2 text-left text-[11px] leading-snug text-muted-foreground">
          {slotsNote(mine!.slots!)}
        </p>
      ) : null}
      {others.map((o) => (
        <div key={o.model} className="nav-so-mem-row nav-so-mem-other">
          <i className="nav-so-mem-dot" data-on="1" />
          <span className="nav-so-mem-text" title={o.model}>
            Also in memory: {nameOf(o.model)}
          </span>
          <button type="button" className="nav-so-mem-btn" disabled={busy} onClick={() => void mem.unload(o.model)}>
            Unload
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ the orbs row ----------------------------- */

export type SessionOrbsProps = {
  choice: HomeChoice;
  onChoice: (next: HomeChoice) => void;
  local: LocalModels;
  /** Whether the chosen model can call tools (decides whether Claude Code is offered). */
  tools?: ToolCheck;
  /** Whether the Full / Lean switch is offered: Lean is switched on and a lean settings folder is ready. */
  leanOn?: boolean;
  /** Whether Local chats may run on the Claude Code harness (the feature is ticked). */
  claudeOn?: boolean;
  /** Whether any unlocked word or model is set (the default words are); with none there is no padlock. */
  lock?: boolean;
  /** How many skills opencode would list in the first prompt; null when not known. */
  skills?: SkillCount | null;
  /** The Local loadout, for the line under the orb on the Claude Code harness (asked only while that line shows). */
  loadout?: { state: LoadoutState | null; failed: boolean };
  /** Opens the Local loadout panel. */
  onLoadout?: () => void;
  /** Local chats on Claude Code are off by a pick saved in Setup: the orb says so, with a way to Setup. */
  claudeOffInSetup?: boolean;
};

/** Under the Local orb when Local chats on Claude Code are off by a saved pick. */
export const CLAUDE_OFF_NOTE = "Local chats on Claude Code are off in Setup.";

const CHECKING: ToolCheck = { state: "checking" };

/** Waits before asking again while Ollama has not answered: 15 s, 30 s, 60 s, then every 2 minutes. */
export const TOOL_RECHECK_MS = [15_000, 30_000, 60_000, 120_000] as const;

/**
 * Asks the server whether an Ollama or LM Studio model can call tools; other models are never asked. While the
 * answer is "unknown" (Ollama not running yet, say) it asks again on a slow back-off, so Claude Code
 * appears once Ollama starts, without asking Ollama more than once every two minutes for long.
 */
export function useToolCheck(modelId: string | null | undefined): ToolCheck {
  const rpc = useRpc<typeof rpcContract>();
  const [check, setCheck] = useState<{ model: string; result: ToolCheck; tries: number } | null>(null);
  const askable = !!modelId && canRunOnClaude(modelId);
  const mine = check !== null && check.model === modelId ? check : null;
  const tries = mine ? mine.tries : 0;
  const unknown = mine !== null && mine.result.state === "unknown";
  useEffect(() => {
    if (!askable || !modelId) return;
    let alive = true;
    const ask = () =>
      rpc
        .call("local_model_tools", { model: modelId })
        .then(
          (r) =>
            alive &&
            setCheck({
              model: modelId,
              tries: tries + 1,
              result: {
                state: r.tools === true ? "yes" : r.why === "family" ? "family" : r.why === "window" ? "small" : r.why === "remote" ? "remote" : r.tools === false ? "no" : "unknown",
                reason: r.reason,
                window: r.window ?? null,
                need: r.need,
              },
            }),
        )
        .catch(() => alive && setCheck({ model: modelId, tries: tries + 1, result: { state: "unknown", reason: "The check did not answer" } }));
    // First ask at once; after an "unknown", ask again after the back-off.
    const timer = tries === 0 ? null : unknown ? setTimeout(ask, TOOL_RECHECK_MS[Math.min(tries - 1, TOOL_RECHECK_MS.length - 1)]) : null;
    if (tries === 0) void ask();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [rpc, modelId, askable, tries, unknown]);
  if (!askable) return { state: "no", reason: "Only Ollama and LM Studio models run on Claude Code" };
  return check?.model === modelId ? check.result : CHECKING;
}

/** Under the Local orb when no local model is found: the two models we test with, and where the steps are. */
export const LOCAL_EMPTY_NOTE =
  "The two models we test with are Qwen3.8 27B abliterated (we run it in Claude Code) and DeepSeek R1 14B abliterated (chat in opencode), both on Ollama. How to get them: Main models in the install guide.";

/** The model a Local chat would start on: the remembered one while it is still on this Mac, else the first. */
export function chosenLocalModel(choice: HomeChoice, local: LocalModels): LocalModel | null {
  if (local.state !== "ready") return null;
  return local.models.find((m) => m.id === choice.localModel) ?? local.models[0] ?? null;
}

/**
 * The line under the harness switch. The box below is seeded with this mode, so its picker shows it;
 * a mode picked there is used, except Approve for me, which runs as this mode.
 */
export function localModeNote(mode: LocalStartMode): string {
  const label = LOCAL_START_MODE_LABEL[mode];
  return `The box below starts in ${label}. Approve for me picked here starts as ${label}: it would check each step with this model, which takes minutes. Changing the mode later in the chat is up to you.`;
}

export function SessionOrbs({ choice, onChoice, local, tools = CHECKING, leanOn = false, claudeOn = false, lock = false, skills = null, loadout, onLoadout, claudeOffInSetup = false }: SessionOrbsProps) {
  const nav = useBbNavigate();
  ensureSessionOrbsStyle();
  const startMode = consoleSection(useProfile()).localPermissionMode;
  const [palette, probe] = useTokenRgb();
  const model = chosenLocalModel(choice, local);
  const localOn = choice.where === "local";
  const unlocked = localOn && !!model?.unlocked;
  const family = localOn && model ? modelFamily(model) : null;
  const holdable = localOn && !!model && canHoldInMemory(model.id);
  const mem = useLocalMemory(holdable);
  const held = holdable && model ? memoryStatus(mem.memory, model.id) : "unknown";
  const harness = harnessFor(choice, model?.id, tools, claudeOn);
  // The skill-list note, only while opencode is the harness that will run the chat (not while the tool check decides).
  const claudeOffered = claudeOn && !!model && canRunOnClaude(model.id) && tools.state === "yes";
  const deciding = claudeOn && !!model && choice.localHarness === "claude" && canRunOnClaude(model.id) && tools.state === "checking";
  const skillsText = localOn && model && local.state === "ready" && !deciding && harness === "opencode" ? skillsNote(skills) : null;
  const skillsLevel = typeof skills?.skills === "number" && opencodeFirstPromptTokens(skills.skills) > SKILLS_STALL_TOKENS ? "stall" : "slow";
  const localCaption =
    local.state === "loading" ? "Looking for models on this Mac" : local.state === "none" ? local.reason : family && family !== "other" ? `${FAMILY_NAME[family]}${unlocked ? ", unlocked," : ""} on this Mac` : unlocked ? "An unlocked model on this Mac" : "A model on this Mac";
  return (
    <div data-nav-part="session-orbs" className="flex flex-wrap items-start justify-center gap-5 sm:justify-start">
      <span ref={probe} aria-hidden className="hidden" />
      <ChoiceOrb
        kind="online"
        liquid="online"
        palette={palette}
        selected={!localOn}
        label="Online"
        caption={leanOn && choice.online === "lean" ? "Claude with the lean setup" : "Every connector and skill"}
        onClick={() => onChoice({ ...choice, where: "online" })}
      >
        {leanOn ? (
          <Segmented
            size="sm"
            label="Setup for an Online chat"
            value={choice.online}
            onChange={(online) => onChoice({ ...choice, where: "online", online })}
            options={[
              { value: "full", label: "Full", title: "A chat exactly as today" },
              { value: "lean", label: "Lean", title: "A Claude chat that starts with the lean settings folder" },
            ]}
          />
        ) : null}
      </ChoiceOrb>
      <ChoiceOrb
        kind="local"
        liquid={family && family !== "other" ? family : "local"}
        family={family}
        level={held === "loaded" ? 0.84 : held === "loading" ? 0.6 : held === "empty" || held === "offline" ? 0.3 : 0.55}
        stirring={held === "loading"}
        palette={palette}
        selected={localOn}
        unlocked={unlocked}
        lock={lock}
        disabled={local.state === "none"}
        label={unlocked ? "Local, unlocked" : "Local"}
        caption={localCaption}
        onClick={() => onChoice({ ...choice, where: "local", localModel: model?.id ?? choice.localModel })}
      >
        {local.state === "none" ? (
          <p data-nav-part="local-empty-note" className="mt-1.5 max-w-[200px] text-[11px] leading-snug text-muted-foreground">
            {LOCAL_EMPTY_NOTE}
          </p>
        ) : null}
        {localOn && local.state === "ready" ? (
          <select
            aria-label="Local model"
            data-nav-part="local-model"
            className="h-7 max-w-[180px] truncate rounded-md border border-border bg-background px-1.5 text-[12px] text-foreground"
            value={model?.id ?? ""}
            onChange={(e) => onChoice({ ...choice, where: "local", localModel: e.target.value })}
          >
            {local.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.unlocked ? " (unlocked)" : ""}
              </option>
            ))}
          </select>
        ) : null}
        {claudeOn && localOn && model && local.state === "ready" && canRunOnClaude(model.id) && tools.state !== "yes" ? (
          <p data-nav-part="local-harness-note" data-tools={tools.state} className="mt-1.5 max-w-[200px] text-[11px] leading-snug text-muted-foreground" title={tools.reason}>
            {tools.state === "checking"
              ? "Checking whether this model can use tools"
              : tools.state === "family"
                ? "Claude Code is not offered for DeepSeek R1 models: two 14B versions did not use tools dependably in our tests, and other versions were not tried. This one runs as a chat model in opencode."
                : tools.state === "no"
                ? "Chat only, in opencode: this model cannot use tools, so Claude Code is not offered"
                : tools.state === "small"
                  ? `Chat only, in opencode: this model's window is ${(tools.window ?? 0).toLocaleString("en-GB")} tokens and Claude Code needs ${(tools.need ?? 65536).toLocaleString("en-GB")}`
                  : tools.state === "remote"
                    ? "Not on this Mac: this model runs on Ollama's cloud, so a Local chat cannot use it on Claude Code"
                    : model.id.startsWith("lmstudio/")
                      ? "Runs in opencode: LM Studio did not say whether this model can use tools, or what window it runs with. Load it once to check"
                      : "Runs in opencode: Ollama did not say whether this model can use tools, or what window it runs with. Load it once to check"}
          </p>
        ) : null}
        {skillsText && !claudeOffered ? (
          <p data-nav-part="local-skills-note" data-level={skillsLevel} className="mt-1.5 max-w-[200px] text-[11px] leading-snug text-muted-foreground">
            {skillsText}
          </p>
        ) : null}
        {claudeOn && localOn && model && local.state === "ready" && canRunOnClaude(model.id) && tools.state === "yes" ? (
          <div data-nav-part="local-harness" className="mt-1.5">
            <Segmented
              size="sm"
              label="Harness for a Local chat"
              value={harness}
              onChange={(localHarness) => onChoice({ ...choice, where: "local", localHarness })}
              options={[
                { value: "claude", label: "Claude Code", title: "Claude Code itself, with the model on this Mac and your Local loadout" },
                { value: "opencode", label: "opencode", title: "The opencode harness, as before" },
              ]}
            />
            {/* The Claude Code notes (the loadout line, whose height is kept while it loads, and the mode note) keep
                their space for opencode. The skill note (opencode only) shares that cell; it is not drawn for Claude
                Code, so it leaves no gap there, and being longer it adds its extra lines on opencode. */}
            <div className="mt-1.5 grid">
              <div style={{ gridArea: "1 / 1" }} className="flex flex-col gap-1.5">
                <LoadoutLine state={loadout?.state ?? null} failed={loadout?.failed ?? false} onChange={() => onLoadout?.()} hidden={harness !== "claude"} />
                <p
                  data-nav-part="local-mode-note"
                  data-mode={startMode}
                  aria-hidden={harness !== "claude"}
                  className={cn("max-w-[200px] text-[11px] leading-snug text-muted-foreground", harness !== "claude" && "invisible")}
                >
                  {localModeNote(startMode)}
                </p>
              </div>
              {skillsText ? (
                <p
                  data-nav-part="local-skills-note"
                  data-level={skillsLevel}
                  style={{ gridArea: "1 / 1" }}
                  className="max-w-[200px] text-[11px] leading-snug text-muted-foreground"
                >
                  {skillsText}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {claudeOffInSetup && !claudeOn && localOn && model && local.state === "ready" ? (
          <p data-nav-part="local-claude-off" className="mt-1.5 max-w-[200px] text-[11px] leading-snug text-muted-foreground">
            {CLAUDE_OFF_NOTE}{" "}
            <button type="button" onClick={() => nav.toPluginPanel("setup")} className="font-medium text-foreground underline underline-offset-2 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
              Open Setup
            </button>
          </p>
        ) : null}
        {holdable && model && local.state === "ready" ? <ModelMemory model={model} local={local.models} mem={mem} /> : null}
      </ChoiceOrb>
    </div>
  );
}

/* --------------------------- creating the chat --------------------------- */

const DRAFT_KEY = "nav-skin:home-session";

/** The project in the address bar of bb's new-chat screen, when there is one. */
function projectFromPath(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const m = /\/projects\/([^/?#]+)/.exec(window.location.pathname);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * bb's own new-chat box, seeded for the choice, that creates the chat with
 * the profile mark. Shown only while the choice is not Online + Full.
 */
export function SessionComposer({ choice, local, unlockedList = NO_UNLOCKED, tools = CHECKING, claudeOn = false, thinkLess = false }: { choice: HomeChoice; local: LocalModels; unlockedList?: UnlockedList; tools?: ToolCheck; claudeOn?: boolean; thinkLess?: boolean }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const model = chosenLocalModel(choice, local);
  const names = useMemo(() => (local.state === "ready" ? Object.fromEntries(local.models.map((m) => [m.id, m.name])) : {}), [local]);
  const isLocal = choice.where === "local";
  // Claude Code only where it is switched on: the remembered choice and the default say "claude", so the gate sits here.
  const harness = harnessFor(choice, model?.id, tools, claudeOn);
  const startMode = consoleSection(useProfile()).localPermissionMode;
  const submit = async (request: NewThreadRequest) => {
    // On the Claude Code harness the Local orb decides the provider and model, whatever the box shows,
    // and the permission mode is never auto (the profile's mode replaces it).
    const onClaude = isLocal && !!model && harness === "claude";
    const sent = onClaude && model ? localClaudeRequest(request, model.id, startMode) : request;
    const mark = onClaude && model ? markForLocalClaude(model, unlockedList) : markForRequest(choice, request, { names, list: unlockedList, remote: local.state === "ready" ? local.remote : undefined });
    const metadata = sessionProfileMetadata(mark);
    // A Local chat (either harness) brings its own title, so bb does not send the prompt to an online service to write one.
    const title = isLocalMark(mark) ? { title: localChatTitle(sent.input) } : {};
    const thread = await sdk.threads.spawn({ ...sent, ...title, ...(metadata ? { pluginMetadata: metadata } : {}) });
    rememberSessionProfile(thread.id, mark?.profile ?? null);
    if (!mark)
      toast.message("Started as an ordinary Online chat", {
        description: isLocal ? "The model chosen in the box is not one on this Mac." : "Lean applies to Claude chats only.",
      });
    navigate.toThread(thread.id);
  };
  if (isLocal && !model) return null;
  // A Claude Code choice waits for the tool check, so a chat is never sent on the wrong harness.
  if (isLocal && model && claudeOn && choice.localHarness === "claude" && canRunOnClaude(model.id) && tools.state === "checking")
    return (
      <p role="status" data-nav-part="session-composer-checking" className="py-6 text-center text-[13px] text-muted-foreground">
        Checking whether {model.name} can use tools
      </p>
    );
  const onClaudeHarness = isLocal && harness === "claude";
  return (
    <div
      data-nav-part="session-composer"
      data-profile={isLocal ? (model?.unlocked ? "local-unlocked" : "local") : "lean"}
      data-harness={isLocal ? harness : "claude"}
      className="w-full text-left"
    >
      <NewThreadComposer
        key={isLocal ? `${harness}${onClaudeHarness && thinkLess ? "-low" : ""}` : "lean"}
        draftKey={DRAFT_KEY}
        defaultProjectId={projectFromPath()}
        defaultProviderId={isLocal && !onClaudeHarness ? LOCAL_PROVIDER : LEAN_PROVIDER}
        defaultModel={isLocal && !onClaudeHarness ? model?.id : undefined}
        // Only a Local chat on Claude Code: its picker shows the mode it will run in, never auto.
        {...(onClaudeHarness ? { defaultPermissionMode: startMode } : {})}
        // "Think less" in the Local loadout: bb's own effort picker starts at low, shown and changeable there (never an override).
        {...(onClaudeHarness && thinkLess ? { defaultReasoningLevel: "low" } : {})}
        placeholder={
          isLocal
            ? `Ask ${model?.name ?? "the local model"}, on this Mac${onClaudeHarness ? ", in Claude Code" : ""}`
            : "Ask anything. A lean Claude chat, with the lean settings folder"
        }
        layout="document"
        onSubmit={submit}
      />
    </div>
  );
}

/**
 * The whole choice for the hero: the orbs, and, for any choice other than
 * Online + Full, the embedded new-chat box with bb's own box hidden.
 * `hostComposer` is bb's typing box on this screen; it is only ever hidden
 * here, never moved or changed, and shown again on every way out.
 */
export function SessionChoice({ hostComposer, layout }: { hostComposer: HTMLElement | null; layout: (orbs: ReactNode) => ReactNode }) {
  const [choice, setChoice] = useHomeChoice();
  const config = useSessionProfileConfig();
  const unlockedList = config.unlocked;
  const local = useLocalModels(unlockedList);
  const [broken, setBroken] = useState(false);
  // Lean is offered only where it is switched on and its settings folder is ready; Claude Code for Local chats only where it is ticked.
  const leanOn = useSettledFeature(LEAN_FEATURE) && config.leanReady;
  const claudeOn = useSettledFeature(LOCAL_CLAUDE_FEATURE);
  // Off by a pick saved in Setup (not by a requirement): the orb says so. A saved pick is never switched on here.
  const profileState = useProfileState();
  const claudeOffInSetup = (profileState.loaded || profileState.source !== "defaults") && profileState.profile.features.picks[LOCAL_CLAUDE_FEATURE] === false;
  const tools = useToolCheck(claudeOn && choice.where === "local" ? chosenLocalModel(choice, local)?.id : null);
  // Asked when the screen opens, so the note is there when Local first shows.
  const skills = useSkillCount();
  const canEmbed = typeof NewThreadComposer === "function" || (typeof NewThreadComposer === "object" && NewThreadComposer !== null);
  // A remembered Local choice with no model on this Mac counts as Online; a remembered Lean choice where Lean is not offered counts as Full.
  const withLean: HomeChoice = !leanOn && choice.online === "lean" ? { ...choice, online: "full" } : choice;
  const effective: HomeChoice = withLean.where === "local" && local.state === "none" ? { ...withLean, where: "online" } : withLean;
  const swap = !broken && canEmbed && !isPlainOnline(effective);

  useEffect(() => {
    if (!hostComposer || !swap) return;
    hostComposer.setAttribute("data-nav-session-hidden", "");
    return () => hostComposer.removeAttribute("data-nav-session-hidden");
  }, [hostComposer, swap]);

  // The loadout is asked for only while its line shows: a Local choice that will run on Claude Code.
  const onClaude = effective.where === "local" && local.state === "ready" && harnessFor(effective, chosenLocalModel(effective, local)?.id, tools, claudeOn) === "claude";
  const loadout = useLoadout(onClaude);
  const [loadoutOpen, setLoadoutOpen] = useState(false);
  const orbs = (
    <SessionOrbs
      choice={effective}
      onChoice={setChoice}
      local={local}
      tools={tools}
      leanOn={leanOn}
      claudeOn={claudeOn}
      lock={hasUnlockedList(unlockedList)}
      skills={skills}
      loadout={loadout}
      onLoadout={() => setLoadoutOpen(true)}
      claudeOffInSetup={claudeOffInSetup}
    />
  );
  return (
    <>
      {layout(orbs)}
      {!canEmbed && !isPlainOnline(effective) ? (
        <p role="status" className="mt-2 text-center text-[12px] text-muted-foreground">This bb cannot show the new-chat box here, so chats start as Online.</p>
      ) : null}
      {broken ? <p role="status" className="mt-2 text-center text-[12px] text-muted-foreground">The Lean and Local box hit an error, so chats start as Online.</p> : null}
      {loadoutOpen ? <LoadoutDialog open={loadoutOpen} onOpenChange={setLoadoutOpen} onSaved={(next) => loadout.adopt(next)} /> : null}
      {swap ? (
        <div className="mt-4 w-full">
          {effective.where === "local" && local.state === "loading" ? (
            <p role="status" className="py-6 text-center text-[13px] text-muted-foreground">Looking for the models on this Mac</p>
          ) : (
            <Boundary label="Lean and Local chat box" compact onFailure={() => setBroken(true)}>
              <SessionComposer choice={effective} local={local} unlockedList={unlockedList} tools={tools} claudeOn={claudeOn} thinkLess={loadout.state?.choice.thinkLess === true} />
            </Boundary>
          )}
        </div>
      ) : null}
    </>
  );
}

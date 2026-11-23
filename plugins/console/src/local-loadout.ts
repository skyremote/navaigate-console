// The Local loadout: which of the user's own skills and agents a Local chat on the Claude Code harness
// gets, and what that costs in the first prompt. Pure: shared by the server (the default set, what is
// linked) and the panel (the live bar), so both always count the same way.
//
// Every figure below was measured with Claude Code 2.1.330 on one 48 GB Apple Silicon Mac, 21 and 22
// November 2026, from captured first requests (a stub runner) and from real runs on Ollama and LM Studio.
// They are estimates for any other setup: the panel says "about".

/**
 * The window a Local chat on Claude Code plans for. The launcher pins it (CLAUDE_CODE_MAX_CONTEXT_TOKENS),
 * so a model that runs with a larger window does not move the point where Claude Code shortens the chat.
 */
export const LOCAL_WINDOW_TOKENS = 65_536;
/** Most a local model may write in one answer (the launcher's CLAUDE_CODE_MAX_OUTPUT_TOKENS). */
export const LOCAL_OUTPUT_TOKENS = 8_192;
/**
 * Claude Code starts to shorten (compact) a chat when its prompt reaches the window less this margin and
 * the output cap (measured with /context: 44,344 at 65,536 with an 8,192 cap).
 */
export const COMPACT_MARGIN_TOKENS = 13_000;
/** Where Claude Code starts to shorten the chat, from the window it plans for and its output cap. */
export const compactAt = (window: number = LOCAL_WINDOW_TOKENS, output: number = LOCAL_OUTPUT_TOKENS): number => window - COMPACT_MARGIN_TOKENS - output;

/**
 * Claude Code's own first prompt: 18,790 tokens read by Ollama with every tool and 8,463 with the trimmed tools,
 * both measured with a small test loadout (3 skills, 2 agents) linked; LM Studio read 8,353 trimmed with the same
 * loadout, and 18,688 with every tool and nothing linked (the spike). The larger figures are used, so with a
 * loadout of your own on top the estimate is at most a few hundred tokens high.
 */
export const BASE_FULL_TOKENS = 18_790;
export const BASE_TRIMMED_TOKENS = 8_463;
/**
 * bb's part of a Local chat's first prompt (bb's own instructions and tools), used until the route has measured
 * it on this Mac (see shareOf): a clean standard bb recorded about 25,400 tokens against 18,700 for Claude Code
 * alone in a terminal, before the tool trim, so about 6,700. A real bb has more (connectors, its own tools), so
 * without a measurement the panel says "at least". The launcher reads settings from the Local settings folder
 * only (--setting-sources user), so no project or ~/.claude instruction file is part of it; a CLAUDE.md someone
 * puts in the Local settings folder itself is.
 */
export const BB_SHARE_TOKENS = 6_700;

/**
 * One first request of a Local chat on Claude Code as the route saw it, numbers only: what the runner read
 * (its own input_tokens), how many tools the request held, whether the trimmed tools were on (none of
 * LOCAL_TRIMMED_TOOLS in it), this loadout's own part at that moment (skills, agents, items put in by hand)
 * and the user's own words (about, in tokens).
 */
export type FirstPromptReading = { at: number; input: number; tools: number; trimmed: boolean; loadout: number; user: number };
/** A measured share below this is not believed (bb's own tools alone take more): that reading is ignored. */
export const MEASURED_SHARE_MIN = 500;
/** A measured share above this is held at it (the chat would be past the point of shortening anyway). */
export const MEASURED_SHARE_MAX = 40_000;
/** A first request whose user words are longer than this (a pasted text, a summary after shortening) is not used. */
export const FIRST_WORDS_MAX_CHARS = 2_000;
/** bb's share from one reading: what the runner read less Claude Code's base for that tool set, the loadout and the user's words; null for a nonsense reading. */
export function shareOf(r: FirstPromptReading): number | null {
  if (![r.input, r.loadout, r.user, r.tools].every((v) => Number.isFinite(v) && v >= 0) || r.input <= 0 || r.tools <= 0) return null;
  const share = r.input - (r.trimmed ? BASE_TRIMMED_TOKENS : BASE_FULL_TOKENS) - r.loadout - r.user;
  if (share < MEASURED_SHARE_MIN) return null;
  return Math.min(Math.round(share), MEASURED_SHARE_MAX);
}
/** The share in force on this Mac: from the latest reading the route kept; null while there is none. */
export type MeasuredShare = { bb: number; at: number; tools: number; trimmed: boolean };

/**
 * What a skill listed by name costs: 1,009 tokens for 174 skills in a real bb (18,492 less 17,483, Ollama,
 * Claude Code 2.1.330, 22 Nov 2026), so about 5.8 each.
 */
export const SKILL_NAME_TOKENS = 5.8;
/** Characters per token of the skill and agent lists (whole captured prompts, read by LM Studio: 4.21). */
export const LIST_CHARS_PER_TOKEN = 4.21;
/** Characters per token of a skill's own text when it is used (SKILL.md files read in real runs: about 3.4). */
export const BODY_CHARS_PER_TOKEN = 3.4;
/** A skill listed by name only is "- name" and a line end. */
const NAME_ENTRY_EXTRA = 3;
/** A skill listed with its description is "- name: description" and a line end; Claude Code cuts a description at 1,536 characters. */
const DESCRIBED_ENTRY_EXTRA = 5;
export const SKILL_DESCRIPTION_MAX_CHARS = 1_536;
/**
 * What the descriptions option writes into the Local settings file (skillListingBudgetFraction). With it,
 * Claude Code showed the descriptions of the first 10 of 10, 24 of 40 and 22 of 80 test skills (about 520
 * characters each) and listed the rest by name: the user skills' part of the list stopped near 13,300
 * characters (13,075 to 13,319 measured). Without it (Claude Code's default 0.01) every user skill is
 * listed by name only, whatever its use.
 */
export const SKILL_LISTING_BUDGET_FRACTION = 0.1;
export const DESCRIBED_LIST_MAX_CHARS = 13_300;
/** About what one described skill costs (the panel's words): the mean of 40 measured skills. */
export const DESCRIBED_SKILL_TOKENS = 123;
/** An agent is listed in full: "- name: description (Tools: ...)" and a line end; no cap was seen. */
const AGENT_ENTRY_EXTRA = 14;
/** What keeping every Claude Code tool adds to every first prompt (the base with every tool less the trimmed one). */
export const ALL_TOOLS_EXTRA_TOKENS = BASE_FULL_TOKENS - BASE_TRIMMED_TOKENS;

/**
 * "Tight" below this much room before Claude Code shortens the chat. Twice the most a whole task grew a
 * Local chat's prompt in our runs (4,850 tokens: a task that used a skill and read its reference file,
 * Ollama, every tool), rounded up: below it, about two such tasks fit. One run of each task, in a terminal.
 */
export const TIGHT_BELOW_TOKENS = 10_000;
/**
 * A skill whose own text alone would take more than this share of the room left before your first word
 * (with no loadout) is marked, and not ticked by default: one use of it would leave little for the work.
 */
export const OVERSIZED_SHARE = 1 / 3;

export type LoadoutSkill = {
  /** The folder's name under the user's skills folder; the link in the Local settings folder has the same name. */
  name: string;
  /** Length of the description in its front matter; null when it could not be read. */
  descChars: number | null;
  /** Size of its SKILL.md alone (files it points to are read only if the model opens them); null when unknown. */
  bodyChars: number | null;
};
export type LoadoutAgent = {
  /** The file's name without .md; the link in the Local settings folder is <name>.md. */
  name: string;
  /** Characters of its entry in the agent list (name, description, tools). */
  listChars: number;
};
export type LoadoutListing = {
  skills: LoadoutSkill[];
  agents: LoadoutAgent[];
  /** False when a bound (entries or time) stopped the listing early. */
  complete: boolean;
  /** Skills and agents someone put in the Local settings folder by hand: listed by Claude Code too, not managed here. */
  others: { skills: number; agents: number };
};
export type LoadoutChoice = {
  skills: string[];
  agents: string[];
  /** Show skill descriptions to the model (SKILL_LISTING_BUDGET_FRACTION in the Local settings file). */
  descriptions: boolean;
  /** Keep every Claude Code tool (no deny rules in the Local settings file). */
  allTools: boolean;
  /** New Local chats on Claude Code start with bb's own effort picker set to low (the user can change it). */
  thinkLess: boolean;
};

export const tokensOf = (chars: number, perToken: number): number => Math.ceil(Math.max(0, chars) / perToken);
/** A skill's own text when it is used, in tokens; null when its size is unknown. */
export const skillBodyTokens = (s: LoadoutSkill): number | null => (s.bodyChars === null ? null : tokensOf(s.bodyChars, BODY_CHARS_PER_TOKEN));
export const agentListTokens = (a: LoadoutAgent): number => tokensOf(a.listChars, LIST_CHARS_PER_TOKEN);
const nameEntry = (s: LoadoutSkill) => s.name.length + NAME_ENTRY_EXTRA;
const describedEntry = (s: LoadoutSkill) => s.name.length + DESCRIBED_ENTRY_EXTRA + Math.min(s.descChars ?? 0, SKILL_DESCRIPTION_MAX_CHARS);

/** The first prompt before any skill or agent of the user's: Claude Code's base and bb's estimated share (the "too large" mark and the default use it). */
export const baseTokens = (allTools: boolean): number => (allTools ? BASE_FULL_TOKENS : BASE_TRIMMED_TOKENS) + BB_SHARE_TOKENS;
/** The room left before Claude Code shortens the chat, with no loadout. */
export const roomBeforeLoadout = (allTools: boolean, window?: number): number => compactAt(window) - baseTokens(allTools);
/** Whether a skill's own text alone would take more than OVERSIZED_SHARE of that room. */
export function isOversized(s: LoadoutSkill, allTools: boolean, window?: number): boolean {
  const body = skillBodyTokens(s);
  return body !== null && body > roomBeforeLoadout(allTools, window) * OVERSIZED_SHARE;
}

/** The choice for someone who has not made one: every skill except the oversized ones, no agent, no option. */
export function defaultChoice(listing: Pick<LoadoutListing, "skills">): LoadoutChoice {
  return { skills: listing.skills.filter((s) => !isOversized(s, false)).map((s) => s.name), agents: [], descriptions: false, allTools: false, thinkLess: false };
}

/** The chosen names that the listing still holds (a skill removed since is left out). */
export function chosen(listing: LoadoutListing, choice: LoadoutChoice): { skills: LoadoutSkill[]; agents: LoadoutAgent[] } {
  const s = new Set(choice.skills);
  const a = new Set(choice.agents);
  return { skills: listing.skills.filter((x) => s.has(x.name)), agents: listing.agents.filter((x) => a.has(x.name)) };
}

/** The skill list's cost: names only (SKILL_NAME_TOKENS each), or with descriptions up to the measured cap (never less than names only). */
export function skillListTokens(skills: readonly LoadoutSkill[], descriptions: boolean): number {
  const byName = Math.ceil(skills.length * SKILL_NAME_TOKENS);
  if (!descriptions) return byName;
  const names = skills.reduce((n, s) => n + nameEntry(s), 0);
  const full = skills.reduce((n, s) => n + describedEntry(s), 0);
  return Math.max(byName, tokensOf(Math.min(full, Math.max(names, DESCRIBED_LIST_MAX_CHARS)), LIST_CHARS_PER_TOKEN));
}

/**
 * How many of the ticked skills would get their description with the descriptions option, taking them in
 * name order (the order Claude Code used in a new setup) until DESCRIBED_LIST_MAX_CHARS is used up.
 */
export function describedFit(listing: LoadoutListing, choice: LoadoutChoice): { fit: number; ticked: number } {
  const picked = chosen(listing, choice).skills;
  let used = 0;
  let fit = 0;
  for (const s of picked) {
    const c = describedEntry(s);
    if (used + c > DESCRIBED_LIST_MAX_CHARS) break;
    used += c;
    fit++;
  }
  return { fit, ticked: picked.length };
}
/** The descriptions option's second line, for this user's ticked skills. */
export function describedHint(listing: LoadoutListing, choice: LoadoutChoice): string {
  const { fit, ticked } = describedFit(listing, choice);
  const room = `the list has room for about ${n(DESCRIBED_LIST_MAX_CHARS)} characters`;
  if (fit >= ticked) return `All ${n(ticked)} of your ticked skills fit (${room}).`;
  return `Only about ${n(fit)} of your ${n(ticked)} ticked skills get one (${room}); the rest stay names only. Claude Code decides which (in a new setup, the first by name).`;
}

export type LoadoutCost = {
  base: number;
  bb: number;
  /** True when bb's part was measured on this Mac; false while it is the estimate (then a lower bound). */
  measured: boolean;
  skills: number;
  agents: number;
  /** Items put in the Local settings folder by hand (skills by name, agents at the measured mean). */
  others: number;
  total: number;
  /** Where Claude Code starts to shorten the chat. */
  limit: number;
};
/** The first prompt of a Local chat on Claude Code with this choice, before your first word, with bb's measured share when there is one. */
export function loadoutCost(listing: LoadoutListing, choice: LoadoutChoice, window?: number, measured?: MeasuredShare | null): LoadoutCost {
  const picked = chosen(listing, choice);
  const base = choice.allTools ? BASE_FULL_TOKENS : BASE_TRIMMED_TOKENS;
  const skills = skillListTokens(picked.skills, choice.descriptions);
  const agents = picked.agents.reduce((n, a) => n + agentListTokens(a), 0);
  const others = Math.ceil(listing.others.skills * SKILL_NAME_TOKENS) + listing.others.agents * 118;
  const bb = measured ? measured.bb : BB_SHARE_TOKENS;
  const total = base + bb + skills + agents + others;
  return { base, bb, measured: !!measured, skills, agents, others, total, limit: compactAt(window) };
}

export type RoomState = "plenty" | "tight" | "full";
/** Plenty of room, tight (under TIGHT_BELOW_TOKENS left) or will not fit (past the point already). */
export const roomState = (cost: Pick<LoadoutCost, "total" | "limit">): RoomState => {
  const left = cost.limit - cost.total;
  return left < 0 ? "full" : left < TIGHT_BELOW_TOKENS ? "tight" : "plenty";
};

const n = (v: number) => v.toLocaleString("en-GB");
/** About this many tokens, rounded to tens under 1,000 and to hundreds above (all of these are estimates). */
export const about = (tokens: number): string => {
  const step = tokens < 1_000 ? 10 : 100;
  return `about ${n(Math.max(0, Math.round(tokens / step) * step))}`;
};

/** The panel's sentence for the bar, in plain words. Without a measurement of bb's share the figures are bounds. */
export function roomSentence(cost: LoadoutCost): string {
  const left = cost.limit - cost.total;
  const state = roomState(cost);
  const [most, least] = cost.measured ? ["", ""] : ["at most ", "at least "];
  if (state === "full") return `Will not fit: ${least}${about(-left)} tokens past the point where Claude Code starts to shorten the chat, before your first word.`;
  if (state === "tight") return `Tight: ${most}${about(left)} tokens left before Claude Code starts to shorten the chat. A long task, or one large skill, may get it shortened.`;
  return `Plenty of room: ${most}${about(left)} tokens left before Claude Code starts to shorten the chat.`;
}

/** The line under the Local orb (without its "Change" button). */
export function loadoutLine(listing: LoadoutListing, choice: LoadoutChoice, window?: number, measured?: MeasuredShare | null): string {
  const picked = chosen(listing, choice);
  const cost = loadoutCost(listing, choice, window, measured);
  const s = picked.skills.length;
  const total = listing.agents.length;
  const agents = picked.agents.length === 0 && total > 0 ? `no agents (${n(total)} to tick)` : `${n(picked.agents.length)} agent${picked.agents.length === 1 ? "" : "s"}`;
  const tokens = cost.measured
    ? `${about(cost.total)} tokens before your first word, with bb's part measured on this Mac`
    : `at least ${about(cost.total)} tokens before your first word, until a Local chat measures bb's part`;
  return `${n(s)} skill${s === 1 ? "" : "s"}, ${agents} · ${tokens}`;
}

/** Names that may become a link's name: a single path part, no hidden or special name. */
export const safeItemName = (name: string): boolean => name.length > 0 && name.length <= 200 && !name.startsWith(".") && !/[/\\\0]/.test(name);

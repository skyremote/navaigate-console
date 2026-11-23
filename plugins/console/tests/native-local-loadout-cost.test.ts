// The loadout's arithmetic, shared by the server and the panel: the point where Claude Code shortens a
// Local chat, the first prompt's estimate, the three states and their words, and the oversized rule.
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLS_EXTRA_TOKENS, BASE_FULL_TOKENS, BASE_TRIMMED_TOKENS, BB_SHARE_TOKENS, DESCRIBED_LIST_MAX_CHARS, LIST_CHARS_PER_TOKEN, LOCAL_WINDOW_TOKENS, MEASURED_SHARE_MAX, MEASURED_SHARE_MIN, SKILL_NAME_TOKENS, TIGHT_BELOW_TOKENS,
  compactAt, defaultChoice, describedFit, describedHint, isOversized, loadoutCost, loadoutLine, roomBeforeLoadout, roomSentence, roomState, shareOf, skillListTokens, type LoadoutListing,
} from "../src/local-loadout";

const listing = (skills: number, agents: number, over: Partial<LoadoutListing> = {}): LoadoutListing => ({
  skills: Array.from({ length: skills }, (_, i) => ({ name: `skill-${String(i).padStart(3, "0")}`, descChars: 520, bodyChars: 6_000 })),
  agents: Array.from({ length: agents }, (_, i) => ({ name: `agent-${i}`, listChars: 500 })),
  complete: true,
  others: { skills: 0, agents: 0 },
  ...over,
});
const none = { skills: [], agents: [], descriptions: false, allTools: false, thinkLess: false };

describe("the point where Claude Code shortens the chat", () => {
  it("is the window less 13,000 and the output cap: 44,344 at the pinned 65,536", () => {
    expect(LOCAL_WINDOW_TOKENS).toBe(65_536);
    expect(compactAt()).toBe(44_344);
    expect(compactAt(131_072)).toBe(131_072 - 13_000 - 8_192);
  });
});

describe("the first prompt's estimate", () => {
  it("is Claude Code's base (trimmed or full) plus bb's share, with nothing ticked", () => {
    expect(loadoutCost(listing(0, 0), none).total).toBe(BASE_TRIMMED_TOKENS + BB_SHARE_TOKENS);
    expect(loadoutCost(listing(0, 0), { ...none, allTools: true }).total).toBe(BASE_FULL_TOKENS + BB_SHARE_TOKENS);
    expect(ALL_TOOLS_EXTRA_TOKENS).toBe(10_327);
  });
  it("adds about 5.8 tokens a skill by name (measured in a real bb), and caps described skills at the measured list size", () => {
    const l = listing(80, 0);
    l.skills = l.skills.map((s, i) => ({ ...s, name: `fixture-skill-${String(i).padStart(3, "0")}` }));
    expect(SKILL_NAME_TOKENS).toBe(5.8);
    expect(skillListTokens(l.skills, false)).toBe(464);
    // 174 skills by name: 1,010 (1,009 measured).
    expect(skillListTokens(listing(174, 0).skills, false)).toBe(1_010);
    // 10 described skills: every description counts (about 130 tokens each for these 520-character descriptions; 123 was the mean of 40 measured skills).
    const ten = skillListTokens(l.skills.slice(0, 10), true);
    expect(ten / 10).toBeGreaterThan(120);
    expect(ten / 10).toBeLessThan(140);
    // 80 described skills: capped where Claude Code stopped showing descriptions.
    expect(skillListTokens(l.skills, true)).toBe(Math.ceil(DESCRIBED_LIST_MAX_CHARS / LIST_CHARS_PER_TOKEN));
    // Descriptions never cost less than names only, however many skills there are.
    for (const k of [0, 1, 5, 80, 174, 600, 3_000]) {
      const skills = listing(k, 0).skills.map((s) => ({ ...s, descChars: 0 }));
      expect(skillListTokens(skills, true)).toBeGreaterThanOrEqual(skillListTokens(skills, false));
    }
  });
  it("counts only ticked items the listing still holds, and items put in the Local folder by hand", () => {
    const l = listing(3, 2, { others: { skills: 2, agents: 1 } });
    const c = loadoutCost(l, { ...none, skills: ["skill-000", "gone"], agents: ["agent-1"] });
    expect(c.skills).toBe(skillListTokens([l.skills[0]], false));
    expect(c.agents).toBe(Math.ceil(500 / LIST_CHARS_PER_TOKEN));
    expect(c.others).toBe(Math.ceil(2 * SKILL_NAME_TOKENS) + 118);
  });
});

describe("bb's share, measured in a Local chat's first request", () => {
  const reading = { at: Date.UTC(2026, 10, 22, 12), input: 17_483, tools: 17, trimmed: true, loadout: 0, user: 4 };
  it("is what the runner read less Claude Code's base for that tool set, the loadout's part and the user's words", () => {
    expect(shareOf(reading)).toBe(17_483 - BASE_TRIMMED_TOKENS - 4);
    expect(shareOf({ ...reading, input: 18_492, loadout: 1_010 })).toBe(18_492 - BASE_TRIMMED_TOKENS - 1_010 - 4);
    expect(shareOf({ ...reading, input: 28_800, trimmed: false })).toBe(28_800 - BASE_FULL_TOKENS - 4);
  });
  it("ignores a nonsense reading and holds a huge one at the ceiling", () => {
    expect(shareOf({ ...reading, input: 0 })).toBeNull(); // a runner that reports no usage
    expect(shareOf({ ...reading, input: 8_000 })).toBeNull(); // less than Claude Code's own base: negative
    expect(shareOf({ ...reading, input: BASE_TRIMMED_TOKENS + MEASURED_SHARE_MIN - 1 + 4 })).toBeNull();
    expect(shareOf({ ...reading, input: BASE_TRIMMED_TOKENS + MEASURED_SHARE_MIN + 4 })).toBe(MEASURED_SHARE_MIN);
    expect(shareOf({ ...reading, tools: 0 })).toBeNull();
    expect(shareOf({ ...reading, input: Number.NaN })).toBeNull();
    expect(shareOf({ ...reading, loadout: -1 })).toBeNull();
    expect(shareOf({ ...reading, input: 90_000 })).toBe(MEASURED_SHARE_MAX);
  });
  it("replaces the estimate in the total, and gives the first measured bb its own figures back", () => {
    const m = { bb: 9_020, at: reading.at, tools: 17, trimmed: true };
    // The owner's bb (22 Nov 2026): None 17,483 and 174 skills by name 18,492 measured.
    expect(loadoutCost(listing(0, 0), none, undefined, m).total).toBe(17_483);
    const l = listing(174, 0);
    expect(loadoutCost(l, { ...none, skills: l.skills.map((s) => s.name) }, undefined, m).total).toBe(18_493);
    // Applied to today's tools: with every tool kept, Claude Code's own base changes, bb's share does not.
    expect(loadoutCost(listing(0, 0), { ...none, allTools: true }, undefined, m)).toMatchObject({ bb: 9_020, measured: true, total: BASE_FULL_TOKENS + 9_020 });
    expect(loadoutCost(listing(0, 0), none)).toMatchObject({ bb: BB_SHARE_TOKENS, measured: false });
  });
});

describe("the three states", () => {
  it("plenty, tight below 10,000 tokens of room, will not fit past the point", () => {
    expect(roomState({ total: 44_344 - TIGHT_BELOW_TOKENS, limit: 44_344 })).toBe("plenty");
    expect(roomState({ total: 44_344 - TIGHT_BELOW_TOKENS + 1, limit: 44_344 })).toBe("tight");
    expect(roomState({ total: 44_344, limit: 44_344 })).toBe("tight");
    expect(roomState({ total: 44_345, limit: 44_344 })).toBe("full");
  });
  it("says each state in plain words, as bounds while bb's share is not measured", () => {
    const base = loadoutCost(listing(0, 0), none);
    expect(roomSentence(base)).toBe("Plenty of room: at most about 29,200 tokens left before Claude Code starts to shorten the chat.");
    expect(roomSentence({ ...base, total: 40_000 })).toBe("Tight: at most about 4,300 tokens left before Claude Code starts to shorten the chat. A long task, or one large skill, may get it shortened.");
    expect(roomSentence({ ...base, total: 50_000 })).toBe("Will not fit: at least about 5,700 tokens past the point where Claude Code starts to shorten the chat, before your first word.");
    const measured = loadoutCost(listing(0, 0), none, undefined, { bb: 9_020, at: 0, tools: 17, trimmed: true });
    expect(roomSentence(measured)).toBe("Plenty of room: about 26,900 tokens left before Claude Code starts to shorten the chat.");
    expect(roomSentence({ ...measured, total: 40_000 })).toBe("Tight: about 4,300 tokens left before Claude Code starts to shorten the chat. A long task, or one large skill, may get it shortened.");
    expect(roomSentence({ ...measured, total: 50_000 })).toBe("Will not fit: about 5,700 tokens past the point where Claude Code starts to shorten the chat, before your first word.");
    // The state follows the same figure: a loadout that has plenty with the estimate can be tight with the measurement.
    const l = listing(0, 0, { others: { skills: 0, agents: 153 } });
    expect(roomState(loadoutCost(l, none))).toBe("plenty");
    expect(roomState(loadoutCost(l, none, undefined, { bb: 9_020, at: 0, tools: 17, trimmed: true }))).toBe("tight");
  });
});

describe("the default and the oversized rule", () => {
  it("ticks every skill except one whose own text alone would take more than a third of the room", () => {
    const room = roomBeforeLoadout(false);
    const third = Math.floor((room / 3) * 3.4);
    const l = listing(2, 3);
    l.skills.push({ name: "big", descChars: 10, bodyChars: third + 400 }, { name: "unknown-size", descChars: null, bodyChars: null });
    expect(isOversized(l.skills[2], false)).toBe(true);
    expect(defaultChoice(l)).toEqual({ skills: ["skill-000", "skill-001", "unknown-size"], agents: [], descriptions: false, allTools: false, thinkLess: false });
    // With every tool kept the room is smaller, so a smaller skill is already too large.
    expect(isOversized({ name: "mid", descChars: 1, bodyChars: Math.ceil((roomBeforeLoadout(true) / 3) * 3.4) + 400 }, true)).toBe(true);
    expect(isOversized({ name: "mid", descChars: 1, bodyChars: Math.ceil((roomBeforeLoadout(true) / 3) * 3.4) + 400 }, false)).toBe(false);
  });
});

describe("the line under the Local orb", () => {
  it("names skills, agents (or how many there are to tick) and the estimate, as a lower bound until bb's part is measured", () => {
    const l = listing(12, 31);
    expect(loadoutLine(l, defaultChoice(l))).toBe("12 skills, no agents (31 to tick) · at least about 15,200 tokens before your first word, until a Local chat measures bb's part");
    expect(loadoutLine(l, { ...none, skills: ["skill-000"], agents: ["agent-0"] })).toBe("1 skill, 1 agent · at least about 15,300 tokens before your first word, until a Local chat measures bb's part");
    expect(loadoutLine(listing(0, 0), none)).toBe("0 skills, 0 agents · at least about 15,200 tokens before your first word, until a Local chat measures bb's part");
    const m = { bb: 9_020, at: 0, tools: 17, trimmed: true };
    const big = listing(174, 31);
    expect(loadoutLine(big, { ...none, skills: big.skills.map((s) => s.name) }, undefined, m)).toBe("174 skills, no agents (31 to tick) · about 18,500 tokens before your first word, with bb's part measured on this Mac");
  });
});

describe("how many ticked skills would get a description", () => {
  it("takes them in name order until the measured list size is used up", () => {
    const l = listing(80, 0);
    const all = { ...none, skills: l.skills.map((s) => s.name) };
    // About 534 characters each: 24 fit in 13,300, as the capture of 40 test skills showed (24 described).
    expect(describedFit(l, all)).toEqual({ fit: 24, ticked: 80 });
    expect(describedHint(l, all)).toBe("Only about 24 of your 80 ticked skills get one (the list has room for about 13,300 characters); the rest stay names only. Claude Code decides which (in a new setup, the first by name).");
    expect(describedHint(l, { ...none, skills: ["skill-000"] })).toBe("All 1 of your ticked skills fit (the list has room for about 13,300 characters).");
  });
});

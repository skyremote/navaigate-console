// The Local loadout panel: which of your own skills and agents a Local chat on the Claude Code harness
// gets, with a live estimate of its first prompt against the point where Claude Code starts to shorten
// the chat. Reached from the line under the Local orb (when Claude Code is the harness) and from Setup.
// Nothing is asked of the server until the line or the panel is shown; the server returns names and
// sizes only. One loadout serves every Local chat on Claude Code on this Mac: they share one settings
// folder. The arithmetic and the words come from local-loadout.ts, shared with the server.
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { rpcContract } from "../server";
import {
  ALL_TOOLS_EXTRA_TOKENS,
  BB_SHARE_TOKENS,
  LOCAL_WINDOW_TOKENS,
  about,
  agentListTokens,
  describedHint,
  isOversized,
  loadoutCost,
  loadoutLine,
  roomSentence,
  roomState,
  skillBodyTokens,
  type LoadoutChoice,
  type LoadoutListing,
  type MeasuredShare,
} from "./local-loadout";

export type LoadoutState = {
  known: boolean;
  listing: LoadoutListing;
  choice: LoadoutChoice;
  saved: boolean;
  on: boolean;
  /** What the Local settings folder really holds from this loadout. */
  linked: { skills: string[]; agents: string[] };
  /** Why the last attempt to make the links did not work. */
  problem: string | null;
  /** bb's part as measured in a Local chat's first request on this Mac; null (or absent) while there is none. */
  measured?: MeasuredShare | null;
};

/** Ticked items whose link is not in place (not made yet, or refused). */
export function notLinked(state: LoadoutState): number {
  const have = { skills: new Set(state.linked.skills), agents: new Set(state.linked.agents) };
  const listed = { skills: new Set(state.listing.skills.map((x) => x.name)), agents: new Set(state.listing.agents.map((x) => x.name)) };
  return state.choice.skills.filter((x) => listed.skills.has(x) && !have.skills.has(x)).length + state.choice.agents.filter((x) => listed.agents.has(x) && !have.agents.has(x)).length;
}
/** The line's text: what is really linked, and how many ticked items are not linked yet. */
export function lineText(state: LoadoutState): string {
  const really: LoadoutChoice = { ...state.choice, skills: state.linked.skills, agents: state.linked.agents };
  const missing = notLinked(state);
  return `${loadoutLine(state.listing, really, undefined, state.measured)}${missing > 0 ? ` · ${missing.toLocaleString("en-GB")} ticked, not linked yet` : ""}`;
}

const TTL_MS = 60_000;
let cache: { at: number; value: LoadoutState } | null = null;
/** Forget the kept loadout (after a save; tests use it too). */
export function forgetLoadout() {
  cache = null;
}

/** The loadout from the server, asked only while `active` (the line or the panel is shown), kept for a minute. */
export function useLoadout(active: boolean): { state: LoadoutState | null; failed: boolean; reload: () => void; adopt: (next: LoadoutState) => void } {
  const rpc = useRpc<typeof rpcContract>();
  const fresh = () => (cache && Date.now() - cache.at < TTL_MS ? cache.value : null);
  const [state, setState] = useState<LoadoutState | null>(fresh);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const known = fresh();
    if (known && tick === 0) {
      setState(known);
      return;
    }
    let alive = true;
    rpc.call("local_loadout", null).then(
      (r) => {
        cache = { at: Date.now(), value: r };
        if (!alive) return;
        setFailed(false);
        setState(r);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [rpc, active, tick]);
  return {
    state,
    failed,
    reload: () => {
      cache = null;
      setTick((t) => t + 1);
    },
    adopt: (next) => {
      cache = { at: Date.now(), value: next };
      setState(next);
    },
  };
}

/* -------------------------------- most used -------------------------------- */

/** How often each listed skill was used in Claude Code chats on this Mac (names and numbers only). */
export type SkillUse = { known: boolean; counts: Record<string, number>; partial: boolean; days: number };
/** How many skills "Most used" ticks at most. */
export const MOST_USED_TOP = 20;

/** The skills "Most used" ticks: the most used first, up to MOST_USED_TOP, never one too large for the room. */
export function mostUsed(listing: LoadoutListing, use: SkillUse, allTools: boolean): string[] {
  return listing.skills
    .filter((s) => (use.counts[s.name] ?? 0) > 0 && !isOversized(s, allTools))
    .sort((a, b) => (use.counts[b.name] ?? 0) - (use.counts[a.name] ?? 0) || (a.name < b.name ? -1 : 1))
    .slice(0, MOST_USED_TOP)
    .map((s) => s.name);
}
/** "found 14 times in the chats read", "found once in the chats read" (true for a whole and a partial count); null for none. */
export const usedText = (times: number): string | null => (times <= 0 ? null : `found ${times === 1 ? "once" : `${times.toLocaleString("en-GB")} times`} in the chats read`);

/** The counts, asked only while the panel is open (the server counts again at most once an hour after a whole count, once a minute after a partial one). */
export function useSkillUse(active: boolean): { use: SkillUse | null; failed: boolean } {
  const rpc = useRpc<typeof rpcContract>();
  const [use, setUse] = useState<SkillUse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    rpc.call("local_loadout_use", null).then(
      (r) => alive && setUse(r),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [rpc, active]);
  return { use, failed };
}

/* --------------------------------- the line -------------------------------- */

/** Under the Local orb when Claude Code is the harness: the loadout in one line, with Change. Its height is kept while it loads. */
export function LoadoutLine({ state, failed, onChange, hidden = false }: { state: LoadoutState | null; failed: boolean; onChange: () => void; hidden?: boolean }) {
  const text = failed ? "Your skills and agents could not be read" : !state ? "Counting your skills and agents" : !state.known ? "Your skills folders did not answer in time" : lineText(state);
  return (
    <p data-nav-part="local-loadout-line" aria-hidden={hidden || undefined} className={cn("max-w-[200px] min-h-[46px] text-[11px] leading-snug text-muted-foreground", hidden && "invisible")}>
      {text}
      {" · "}
      <button type="button" tabIndex={hidden ? -1 : undefined} onClick={onChange} className="relative rounded-sm font-medium text-foreground underline underline-offset-2 outline-none after:absolute after:-inset-x-1 after:-inset-y-[5px] after:content-[''] hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring">
        Change
      </button>
    </p>
  );
}

/* --------------------------------- the panel ------------------------------- */

const n = (v: number) => v.toLocaleString("en-GB");
const sameChoice = (a: LoadoutChoice, b: LoadoutChoice) => JSON.stringify(a) === JSON.stringify(b);

/** The three parts of the first prompt, each in its own colour from the Console's tag palette (theme fallbacks). */
export const BAR_COLOURS = {
  base: "var(--nav-tc-teal, var(--muted-foreground))",
  bb: "var(--nav-tc-purple, var(--attention))",
  loadout: "var(--nav-tc-blue, var(--foreground))",
} as const;
/** The state sentence's colour; the words carry the state too (never colour alone). */
const STATE_COLOUR = { plenty: "var(--success)", tight: "var(--warning-text, var(--warning))", full: "var(--destructive-text, var(--destructive))" } as const;

function Swatch({ colour, children }: { colour: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span aria-hidden className="inline-block size-2 shrink-0 translate-y-[-1px] rounded-[2px]" style={{ background: colour }} />
      <span>{children}</span>
    </span>
  );
}

/** "22 November": the day a measurement was made, in words. */
const dayOf = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
/** The bar's note on bb's part (bb's own instructions and tools): measured on this Mac, or the estimate and how it gets measured. */
export function shareNote(measured: MeasuredShare | null | undefined): string {
  if (measured)
    return `bb's part was measured at the first request of a Local chat on Claude Code on this Mac on ${dayOf(measured.at)}, and is used with your tools and loadout as they are now. It changes when bb or its connectors change, and with the memory notes of the chat's project; a later Local chat can measure it again.`;
  return `bb's part is not measured on this Mac yet, so at least ${about(BB_SHARE_TOKENS)} (a clean bb's) is used; connectors add more. The first Local chat on Claude Code measures it, if its runner reports how many tokens it read.`;
}

/** The live bar: Claude Code's base, bb's part and this loadout, on the pinned window, with the point where Claude Code shortens the chat. */
export function LoadoutBar({ listing, choice, measured = null }: { listing: LoadoutListing; choice: LoadoutChoice; measured?: MeasuredShare | null }) {
  const cost = loadoutCost(listing, choice, undefined, measured);
  const state = roomState(cost);
  const loadout = cost.skills + cost.agents + cost.others;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / LOCAL_WINDOW_TOKENS) * 100))}%`;
  const share = (v: number) => `${(v / Math.max(cost.total, 1)) * 100}%`;
  return (
    <div data-nav-part="local-loadout-bar" data-room={state} className="flex flex-col gap-2">
      <p role="status" aria-live="polite" className="text-[13px] font-medium leading-snug" style={{ color: STATE_COLOUR[state] }}>
        {roomSentence(cost)}
      </p>
      <div aria-hidden className="relative pb-4">
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="absolute inset-y-0 left-0 flex" style={{ width: pct(cost.total) }}>
            <span className="h-full" style={{ width: share(cost.base), background: BAR_COLOURS.base }} />
            <span className="h-full border-l border-[var(--popover,var(--background))]" style={{ width: share(cost.bb), background: BAR_COLOURS.bb }} />
            <span className="h-full border-l border-[var(--popover,var(--background))]" style={{ width: share(loadout), background: BAR_COLOURS.loadout }} />
          </div>
        </div>
        {/* The point where Claude Code starts to shorten the chat, labelled on the bar itself. */}
        <span className="absolute top-[-3px] h-4 w-0.5 rounded-full bg-foreground" style={{ left: pct(cost.limit) }} />
        <span className="absolute top-[14px] -translate-x-full whitespace-nowrap pr-1 text-[11px] leading-4 text-foreground" style={{ left: pct(cost.limit) }}>
          shortening starts
        </span>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-4 text-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
        <Swatch colour={BAR_COLOURS.base}>
          Claude Code {about(cost.base)} ({choice.allTools ? "every tool" : "trimmed tools"})
        </Swatch>
        <Swatch colour={BAR_COLOURS.bb}>{cost.measured ? `bb's part ${about(cost.bb)}, measured on this Mac` : `bb's part at least ${about(cost.bb)}, an estimate`}</Swatch>
        <Swatch colour={BAR_COLOURS.loadout}>this loadout {about(loadout)}</Swatch>
      </p>
      <p className="text-[11px] leading-4 text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
        {shareNote(measured)} Claude Code starts to shorten the chat at {n(cost.limit)} of a {n(LOCAL_WINDOW_TOKENS)}-token window.
      </p>
    </div>
  );
}

function Option({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 gap-y-0.5 py-1">
      <input id={id} type="checkbox" className="mt-[5px] size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-d`} />
      <label htmlFor={id} className="py-0.5 text-[13px] leading-5 text-foreground">
        {label}
      </label>
      <p id={`${id}-d`} className="col-start-2 text-[12px] leading-4 text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

/** The panel's body: options, quick choices, search and the two lists, with the bar on top. Shared by the dialog and tests. */
export function LoadoutEditor({ state, draft, setDraft, had, use = null, useFailed = false }: { state: LoadoutState; draft: LoadoutChoice; setDraft: (c: LoadoutChoice) => void; had: LoadoutChoice; use?: SkillUse | null; useFailed?: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const { listing } = state;
  const skills = useMemo(() => listing.skills.filter((s) => !q || s.name.toLowerCase().includes(q)), [listing, q]);
  const agents = useMemo(() => listing.agents.filter((a) => !q || a.name.toLowerCase().includes(q)), [listing, q]);
  const ticked = { skills: new Set(draft.skills), agents: new Set(draft.agents) };
  const toggle = (kind: "skills" | "agents", name: string, on: boolean) => {
    const set = new Set(draft[kind]);
    if (on) set.add(name);
    else set.delete(name);
    setDraft({ ...draft, [kind]: [...set] });
  };
  const allSkills = listing.skills.map((s) => s.name);
  const top = use?.known ? mostUsed(listing, use, draft.allTools) : [];
  // Why "Most used" cannot be pressed, in words (shown under the buttons); null when it can.
  const mostUsedWhy = useFailed
    ? "Most used: the count of your skill use could not be made."
    : !use
      ? "Most used: looking for your skills in Claude Code chats on this Mac."
      : !use.known
        ? "Most used: Local chats on Claude Code are off in Setup."
        : top.length === 0
          ? "Most used: no use of these skills was found in the chats read."
          : null;
  const quick: Array<[string, () => void, boolean]> = [
    ["None", () => setDraft({ ...draft, skills: [], agents: [] }), true],
    ["All skills", () => setDraft({ ...draft, skills: allSkills, agents: [] }), true],
    ["All skills and agents", () => setDraft({ ...draft, skills: allSkills, agents: listing.agents.map((a) => a.name) }), true],
    ["Most used", () => setDraft({ ...draft, skills: top }), top.length > 0],
    ["Back to what I had", () => setDraft(had), true],
  ];
  const tickedSkills = listing.skills.filter((s) => ticked.skills.has(s.name)).length;
  const tickedAgents = listing.agents.filter((a) => ticked.agents.has(a.name)).length;
  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Quick choices and search" className="flex flex-col gap-2">
        <div role="group" aria-label="Quick choices" className="flex flex-wrap gap-2">
          {quick.map(([label, run, can]) => (
            <button
              key={label}
              type="button"
              onClick={run}
              disabled={!can}
              aria-describedby={!can && label === "Most used" ? `${uid}-mu` : undefined}
              className="min-h-8 rounded-[10px] border border-input bg-card px-3 text-[12px] font-medium text-foreground outline-none hover:bg-[var(--state-hover)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 max-sm:min-h-11"
            >
              {label}
            </button>
          ))}
        </div>
        {mostUsedWhy ? (
          <p id={`${uid}-mu`} data-nav-part="local-loadout-most-used-why" className="text-[12px] leading-4 text-muted-foreground">
            {mostUsedWhy}
          </p>
        ) : null}
        <label htmlFor={`${uid}-q`} className="text-[12px] font-medium text-foreground">
          Search skills and agents
        </label>
        <input
          id={`${uid}-q`}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="h-9 rounded-[10px] border border-input bg-background px-3 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-11 max-sm:text-[16px]"
        />
      </section>

      <section aria-labelledby={`${uid}-sk`} className="flex flex-col gap-1">
        <h3 id={`${uid}-sk`} className="text-[13px] font-semibold text-foreground">
          Skills <span className="font-normal text-muted-foreground">({n(tickedSkills)} of {n(listing.skills.length)} ticked)</span>
        </h3>
        <p className="text-[12px] leading-4 text-muted-foreground">Each is listed by name in every first prompt, which is nearly free (about 6 tokens). The figure is its own text, read when the model uses it.</p>
        {use?.known ? (
          <p data-nav-part="local-loadout-use-source" className="text-[12px] leading-4 text-muted-foreground">
            Counted from Claude Code chats on this Mac that changed in the last {use.days} days, including their older messages.{use.partial ? " Partial: the count stopped before it had read every chat." : ""}
          </p>
        ) : null}
        {skills.length === 0 ? <p className="py-1 text-[12px] text-muted-foreground">{q ? "No skill matches." : "No skills in ~/.claude/skills."}</p> : null}
        <ul className="flex flex-col">
          {skills.map((s) => {
            const id = `${uid}-s-${s.name}`;
            const body = skillBodyTokens(s);
            const big = isOversized(s, draft.allTools);
            return (
              <li
                key={s.name}
                data-nav-part="local-loadout-skill"
                data-oversized={big || undefined}
                className={cn("grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60 py-1.5 last:border-b-0 max-sm:grid-cols-[20px_minmax(0,1fr)]", big && "-mx-2 rounded-md px-2")}
                style={big ? { background: "color-mix(in oklab, var(--warning) 9%, transparent)" } : undefined}
              >
                <input id={id} type="checkbox" className="mt-[5px] size-4" checked={ticked.skills.has(s.name)} onChange={(e) => toggle("skills", s.name, e.target.checked)} aria-describedby={`${id}-c`} />
                <label htmlFor={id} className="min-w-0 break-words py-0.5 text-[13px] leading-5 text-foreground">
                  {s.name}
                  {use?.known && usedText(use.counts[s.name] ?? 0) ? (
                    <span data-nav-part="local-loadout-used" className="ml-2 text-[11px] text-muted-foreground" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {usedText(use.counts[s.name] ?? 0)}
                    </span>
                  ) : null}
                </label>
                <span id={`${id}-c`} className={cn("text-right text-[11px] leading-5 max-sm:col-start-2 max-sm:text-left", big ? "font-medium" : "text-muted-foreground")} style={{ fontVariantNumeric: "tabular-nums", ...(big ? { color: "var(--warning-text, var(--warning))" } : {}) }}>
                  {body === null ? "size not known" : `${about(body)} tokens when used`}
                  {big ? " · too large: over a third of the room" : ""}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby={`${uid}-ag`} className="flex flex-col gap-1">
        <h3 id={`${uid}-ag`} className="text-[13px] font-semibold text-foreground">
          Agents <span className="font-normal text-muted-foreground">({n(tickedAgents)} of {n(listing.agents.length)} ticked)</span>
        </h3>
        <p className="text-[12px] leading-4 text-muted-foreground">Each ticked agent is listed in full in every first prompt. A Local chat's agents run on the same local model.</p>
        {agents.length === 0 ? <p className="py-1 text-[12px] text-muted-foreground">{q ? "No agent matches." : "No agents in ~/.claude/agents."}</p> : null}
        <ul className="flex flex-col">
          {agents.map((a) => {
            const id = `${uid}-a-${a.name}`;
            return (
              <li key={a.name} data-nav-part="local-loadout-agent" className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60 py-1.5 last:border-b-0 max-sm:grid-cols-[20px_minmax(0,1fr)]">
                <input id={id} type="checkbox" className="mt-[5px] size-4" checked={ticked.agents.has(a.name)} onChange={(e) => toggle("agents", a.name, e.target.checked)} aria-describedby={`${id}-c`} />
                <label htmlFor={id} className="min-w-0 break-words py-0.5 text-[13px] leading-5 text-foreground">
                  {a.name}
                </label>
                <span id={`${id}-c`} className="text-right text-[11px] leading-5 text-muted-foreground max-sm:col-start-2 max-sm:text-left" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {about(agentListTokens(a))} tokens in every first prompt
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby={`${uid}-opt`} className="flex flex-col gap-1">
        <h3 id={`${uid}-opt`} className="text-[13px] font-semibold text-foreground">
          Options
        </h3>
        <Option
          id={`${uid}-desc`}
          checked={draft.descriptions}
          onChange={(descriptions) => setDraft({ ...draft, descriptions })}
          label="Show skill descriptions to the model (about 120 tokens per skill on average)"
          hint={describedHint(listing, draft)}
        />
        <Option
          id={`${uid}-tools`}
          checked={draft.allTools}
          onChange={(allTools) => setDraft({ ...draft, allTools })}
          label={`Keep every Claude Code tool (adds about ${n(Math.round(ALL_TOOLS_EXTRA_TOKENS / 1000) * 1000)} tokens to every first prompt; brings back scheduling and loops)`}
          hint="Off, a Local chat goes without scheduling and loops, watching, workflows, worktrees, messages to other agents and web search. File work, the shell, skills, agents, web pages and bb's own tools stay."
        />
        <Option
          id={`${uid}-think`}
          checked={draft.thinkLess}
          onChange={(thinkLess) => setDraft({ ...draft, thinkLess })}
          label="Think less (faster replies, the model may skip steps)"
          hint="New Local chats on Claude Code start with bb's effort picker at low, and you can change it in the chat. In our tests (one model on each runner), Ollama thought less at low; LM Studio took low and medium, and at bb's usual high ran the model at its own highest setting. Replies were often, not always, faster."
        />
      </section>

      {listing.others.skills + listing.others.agents > 0 ? (
        <p className="text-[12px] leading-4 text-muted-foreground">
          {n(listing.others.skills)} skill{listing.others.skills === 1 ? "" : "s"} and {n(listing.others.agents)} agent{listing.others.agents === 1 ? "" : "s"} you put in the Local settings folder yourself are listed too, and counted in the bar. This panel leaves them alone.
        </p>
      ) : null}
      {!listing.complete ? <p className="text-[12px] leading-4 text-muted-foreground">Your folders hold more than could be read in time, so only these are shown.</p> : null}
    </div>
  );
}

type SaveResult = { ok: boolean; reason?: string; linked: { skills: number; agents: number }; skipped: Array<{ kind: "skill" | "agent"; name: string; why: "taken" | "failed" }> };
/** What a save did, in words. */
export function savedText(r: SaveResult): string {
  if (!r.ok) return r.reason ?? "The loadout was not saved.";
  const taken = r.skipped.filter((s) => s.why === "taken").map((s) => s.name);
  const failed = r.skipped.filter((s) => s.why === "failed").map((s) => s.name);
  const parts = [`Saved: ${n(r.linked.skills)} skill${r.linked.skills === 1 ? "" : "s"} and ${n(r.linked.agents)} agent${r.linked.agents === 1 ? "" : "s"} given to Local chats on Claude Code. Chats already open get newly ticked skills and agents the next time bb starts Claude Code for them. Skills and agents you untick stay named in what those chats have already read, and changing an option makes their next reply read the whole chat again.`];
  if (taken.length) parts.push(`Left out, because something of yours already has the name in the Local settings folder: ${taken.join(", ")}.`);
  if (failed.length) parts.push(`Left out, because this system refused the link (nothing was copied): ${failed.join(", ")}.`);
  return parts.join(" ");
}

/** The Local loadout panel, as a dialog. It asks for the loadout when it opens and has its own Save. */
export function LoadoutDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; onSaved?: (state: LoadoutState) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const scope = usePortalScopeProps();
  const { state, failed, reload, adopt } = useLoadout(open);
  const { use, failed: useFailed } = useSkillUse(open);
  const [draft, setDraft] = useState<LoadoutChoice | null>(null);
  const [had, setHad] = useState<LoadoutChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  useEffect(() => {
    if (!open) {
      setDraft(null);
      setHad(null);
      setResult(null);
      return;
    }
    if (state && !draft) {
      setDraft(state.choice);
      setHad(state.choice);
    }
  }, [open, state, draft]);
  const save = async () => {
    if (!draft || !state) return;
    setSaving(true);
    try {
      const r = await rpc.call("local_loadout_save", draft);
      setResult(r);
      if (r.ok) {
        const choice = { ...draft, skills: draft.skills.filter((s) => state.listing.skills.some((x) => x.name === s)), agents: draft.agents.filter((a) => state.listing.agents.some((x) => x.name === a)) };
        const left = (kind: "skill" | "agent") => new Set(r.skipped.filter((x) => x.kind === kind).map((x) => x.name));
        const next: LoadoutState = {
          ...state,
          choice,
          saved: true,
          linked: { skills: choice.skills.filter((x) => !left("skill").has(x)), agents: choice.agents.filter((x) => !left("agent").has(x)) },
          problem: null,
        };
        adopt(next);
        setHad(next.choice);
        onSaved?.(next);
      }
    } catch (e) {
      setResult({ ok: false, reason: e instanceof Error ? e.message : "The loadout was not saved.", linked: { skills: 0, agents: 0 }, skipped: [] });
    } finally {
      setSaving(false);
    }
  };
  const changed = !!draft && !!had && !sameChoice(draft, had);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" />
        <Dialog.Content
          {...scope}
          data-nav-part="local-loadout"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-xl"
        >
          <div className="flex shrink-0 flex-col gap-4 border-b border-border p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <Dialog.Title className="text-[16px] font-medium leading-6">Local loadout</Dialog.Title>
                <Dialog.Description className="text-[12px] leading-4 text-muted-foreground">
                  The skills and agents your Local chats on Claude Code get. One loadout serves all of them on this Mac, because they share one settings folder.
                </Dialog.Description>
              </div>
              <Dialog.Close className="min-h-8 shrink-0 rounded-md px-2 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Close</Dialog.Close>
            </div>
            {state && draft && state.known ? <LoadoutBar listing={state.listing} choice={draft} measured={state.measured} /> : null}
            {state && state.known && !result && notLinked(state) > 0 ? (
              <p data-nav-part="local-loadout-pending" className="text-[12px] leading-4 text-foreground">
                {notLinked(state).toLocaleString("en-GB")} ticked item{notLinked(state) === 1 ? " is" : "s are"} not given to chats yet{state.problem ? `: ${state.problem}` : ""}. Save loadout gives them.
              </p>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {failed ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-[13px]">Your skills and agents could not be read.</p>
                <button type="button" onClick={reload} className="min-h-8 rounded-[10px] border border-input px-3 text-[12px] font-medium">
                  Try again
                </button>
              </div>
            ) : !state || !draft ? (
              <p role="status" className="text-[13px] text-muted-foreground">
                Reading your skills and agents
              </p>
            ) : !state.known ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-[13px]">Your skills folders did not answer in time, so nothing can be chosen now.</p>
                <button type="button" onClick={reload} className="min-h-8 rounded-[10px] border border-input px-3 text-[12px] font-medium">
                  Try again
                </button>
              </div>
            ) : (
              <LoadoutEditor state={state} draft={draft} setDraft={(c) => (setResult(null), setDraft(c))} had={had ?? state.choice} use={use} useFailed={useFailed} />
            )}
          </div>
          <div className="flex shrink-0 flex-col gap-2 border-t border-border p-4">
            {result ? (
              <p role="status" data-nav-part="local-loadout-result" className={cn("text-[12px] leading-4", result.ok ? "text-foreground" : "text-destructive-text")}>
                {savedText(result)}
              </p>
            ) : (
              <p className="text-[12px] leading-4 text-muted-foreground">
                {state && !state.on ? "Local chats on Claude Code are off in Setup, so this cannot be saved yet." : "Kept for this Mac, separately from Setup. Press Save loadout to give it to your Local chats. Chats already open get newly ticked skills and agents the next time bb starts Claude Code for them. Skills and agents you untick stay named in what those chats have already read, and changing an option makes their next reply read the whole chat again."}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Dialog.Close className="min-h-9 rounded-[10px] border border-input bg-card px-4 text-[13px] font-medium outline-none hover:bg-[var(--state-hover)] focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11">
                {result?.ok ? "Done" : "Cancel"}
              </Dialog.Close>
              <button
                type="button"
                data-primary
                disabled={!draft || !state?.known || !state.on || saving || (!changed && state.saved && notLinked(state) === 0)}
                onClick={() => void save()}
                className="min-h-9 rounded-[10px] bg-primary px-4 text-[13px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-sm:min-h-11"
              >
                {saving ? "Saving" : "Save loadout"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Ask box routing on Home. A free gate in code first: a chip the owner picked, or a
// harness named in the text ("ask Codex to…"), is binding and costs nothing.
// Only Auto goes to Jev, in one request: is this real work, which worker, how
// much effort. Code turns the answers into odds, applies the 0.6 floor and keeps
// a log of the last 200 decisions (with how often the owner overrode Jev).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const HARNESSES = ["claude", "codex", "cursor"] as const;
type Harness = (typeof HARNESSES)[number];
const EFFORTS = ["low", "medium", "high"] as const;
const FLOOR = 0.6;
export const PRICE_PER_TOKEN = 0.042 / 1_000_000; // jev-1.13, input tokens only

const oddsSchema = z.object({ claude: z.number(), codex: z.number(), cursor: z.number() });
export const askRouteInput = z.object({
  text: z.string().trim().min(1).max(4000),
  pick: z.enum(["auto", ...HARNESSES]),
  available: z.object({ claude: z.boolean(), codex: z.boolean(), cursor: z.boolean() }),
});
export const askRouteOutput = z.object({
  decisionId: z.string(),
  source: z.enum(["chip", "text", "jev", "fallback"]),
  harness: z.enum(HARNESSES),
  odds: oddsSchema.nullable(),
  confidence: z.number().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  autoStart: z.boolean(),
  message: z.string(),
});
const logEntrySchema = z.object({
  id: z.string(),
  at: z.number(),
  text: z.string(),
  source: z.enum(["chip", "text", "jev", "fallback"]),
  suggested: z.enum(HARNESSES),
  chosen: z.enum(HARNESSES).nullable(),
  odds: oddsSchema.nullable(),
  confidence: z.number().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  latencyMs: z.number().nullable(),
  costUsd: z.number().nullable(),
});
export const askLogOutput = z.object({ recent: z.array(logEntrySchema), jevDecisions: z.number(), overrides: z.number() });
type Entry = z.infer<typeof logEntrySchema>;

// "ask Codex to…", "in Cursor…", "with Claude…", or the text starting with the name.
const NAMED = /(?:^|\b(?:ask|in|with|use|using|via|on|have|let|get|tell)\s+)(claude(?:\s*code)?|codex|cursor)\b/i;
function named(text: string): Harness | null {
  const m = text.match(NAMED);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return w.startsWith("claude") ? "claude" : (w as Harness);
}
const LABEL: Record<Harness, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

function typesafeKey(): string | null {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const m = fs.readFileSync(path.join(os.homedir(), ".config", "navaigate", "typesafe-ai.env"), "utf8").match(/^TYPESAFE_API_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

export function createAsk(bb: BbPluginApi) {
  let chain: Promise<unknown> = Promise.resolve();
  const edit = (fn: (log: Entry[]) => void) => {
    const next = chain.then(async () => {
      const log = ((await bb.storage.kv.get<Entry[]>("ask-log")) ?? []) as Entry[];
      fn(log);
      await bb.storage.kv.set("ask-log", log.slice(-200));
    });
    chain = next.catch(() => undefined);
    return next;
  };

  async function jev(text: string) {
    const key = typesafeKey();
    if (!key) throw new Error("no TYPESAFE_API_KEY");
    const t0 = Date.now();
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        model: "jev-latest",
        state: { request: text.slice(0, 2000) },
        questions: {
          work: {
            type: "noul",
            instructions: "Does `request` ask for real work to be done in a codebase or in files, rather than a quick question to answer?",
            criteria: {
              true: { what: "Changing, building, writing or researching something that produces files or code", examples: ["Refactor the billing module and add tests", "Write the proposal for the new client into the deck folder"] },
              false: { what: "A quick question, a lookup or a chat answer with nothing to produce", examples: ["What's the time in Tokyo?", "What is on my calendar tomorrow?"] },
            },
          },
          worker: {
            type: "choice",
            instructions: "Which worker suits `request` best?",
            criteria: {
              claude: { what: "Claude Code: writing, business tasks, research, email, documents and multi-step agent work across tools", examples: ["Draft the client update and file it", "Research competitors and summarise"] },
              codex: { what: "Codex: code changes, refactors, bug fixes and tests inside a repository", examples: ["Refactor the auth middleware and add tests", "Fix the failing build"] },
              cursor: { what: "Cursor: small editor-style code edits on a project that is already open", examples: ["Rename this prop across the component", "Tweak the button padding"] },
            },
          },
          effort: {
            type: "choice",
            instructions: "How much reasoning effort does `request` need?",
            criteria: {
              low: { what: "A quick answer or a small, obvious change", examples: ["Bump the version number"] },
              medium: { what: "A normal task with a few steps", examples: ["Add a settings page with two fields"] },
              high: { what: "A hard, open-ended or risky task that needs careful thought", examples: ["Redesign the data model and migrate production"] },
            },
          },
        },
      }),
    });
    if (!r.ok) throw new Error(`Jev ${r.status}`);
    const d = (await r.json()) as {
      answers: { work: { noul: number }; worker: { probabilities: Record<string, number> }; effort: { choice: string } };
      usage?: { input_tokens?: number };
    };
    return { d, latencyMs: Date.now() - t0, costUsd: d.usage?.input_tokens ? d.usage.input_tokens * PRICE_PER_TOKEN : null };
  }

  async function route(input: z.infer<typeof askRouteInput>): Promise<z.infer<typeof askRouteOutput>> {
    const id = randomUUID();
    const base = { id, at: Date.now(), text: input.text.slice(0, 120), chosen: null, latencyMs: null, costUsd: null };
    const avail = (h: Harness) => input.available[h];
    const firstAvail = HARNESSES.find(avail) ?? "claude";

    // 1. Free gate: a picked chip, then a harness named in the text.
    const gate = input.pick !== "auto" ? { h: input.pick, source: "chip" as const } : named(input.text) ? { h: named(input.text) as Harness, source: "text" as const } : null;
    if (gate) {
      await edit((log) => void log.push({ ...base, source: gate.source, suggested: gate.h, odds: null, confidence: null, effort: null }));
      const why = gate.source === "chip" ? "you picked it" : "named in your text";
      return { decisionId: id, source: gate.source, harness: gate.h, odds: null, confidence: null, effort: null, autoStart: true, message: `${LABEL[gate.h]}, ${why}.` };
    }

    // 2. Jev on Auto.
    try {
      const { d, latencyMs, costUsd } = await jev(input.text);
      const p = d.answers.work.noul;
      const odds = Object.fromEntries(HARNESSES.map((h) => [h, avail(h) ? Math.round(p * (d.answers.worker.probabilities[h] ?? 0) * 100) / 100 : 0])) as Record<Harness, number>;
      const top = [...HARNESSES].sort((a, b) => odds[b] - odds[a])[0];
      // A quick question scores low on "work" everywhere; suggest Claude Code then.
      const harness = odds[top] > 0 ? top : avail("claude") ? "claude" : firstAvail;
      const confidence = odds[harness];
      const effort = (EFFORTS as readonly string[]).includes(d.answers.effort.choice) ? (d.answers.effort.choice as (typeof EFFORTS)[number]) : null;
      await edit((log) => void log.push({ ...base, source: "jev", suggested: harness, odds, confidence, effort, latencyMs, costUsd }));
      const autoStart = confidence >= FLOOR;
      return { decisionId: id, source: "jev", harness, odds, confidence, effort, autoStart, message: autoStart ? `Jev picked ${LABEL[harness]} (${confidence.toFixed(2)})` : `Jev is not sure (${confidence.toFixed(2)})` };
    } catch (e) {
      const harness = avail("claude") ? "claude" : firstAvail;
      await edit((log) => void log.push({ ...base, source: "fallback", suggested: harness, odds: null, confidence: null, effort: null }));
      return { decisionId: id, source: "fallback", harness, odds: null, confidence: null, effort: null, autoStart: true, message: `Jev unreachable (${String(e instanceof Error ? e.message : e)}), started on ${LABEL[harness]}.` };
    }
  }

  async function commit(decisionId: string, harness: Harness | null) {
    await edit((log) => {
      const e = log.find((x) => x.id === decisionId);
      if (e) e.chosen = harness;
    });
    return { ok: true };
  }

  async function recent(): Promise<z.infer<typeof askLogOutput>> {
    const log = ((await bb.storage.kv.get<Entry[]>("ask-log")) ?? []) as Entry[];
    const jevs = log.filter((e) => e.source === "jev" && e.chosen);
    return { recent: log.slice(-5).reverse(), jevDecisions: jevs.length, overrides: jevs.filter((e) => e.chosen !== e.suggested).length };
  }

  return { route, commit, recent };
}

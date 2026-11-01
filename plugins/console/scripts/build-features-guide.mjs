// Builds src/features-guide-data.ts from the feature map (features/map.json),
// the one-line descriptions (features/descriptions.tsv) and the Show me
// targets (features/show-me.json). Run: node scripts/build-features-guide.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AREAS = [
  "Models and agents",
  "Working across Macs",
  "Attention and completion",
  "Context and artefacts",
  "Automation and usage",
  "Software delivery",
  "Interface and maintenance",
  "Research and business",
  "Extras you asked for",
];

export function statusFromMap(entry) {
  switch (entry.status) {
    case "live": return { kind: "live" };
    case "partly":
      if (!entry.gap?.trim()) throw new Error(`Partly live ${entry.id} must say what is missing`);
      return { kind: "partly" };
    case "blocked":
      if (!entry.reason?.trim()) throw new Error(`Blocked ${entry.id} must give a reason`);
      return { kind: "blocked", reason: entry.reason };
    default: throw new Error(`Unknown status ${entry.status}`);
  }
}

export const VERDICTS = ["PASS", "FAIL", "UNVERIFIED", "RECHECK"];

export function evidenceFromMap(entry) {
  const e = entry.evidence;
  if (!e) throw new Error(`No evidence for ${entry.id}`);
  if (!VERDICTS.includes(e.verdict)) throw new Error(`Unknown verdict ${e.verdict} for ${entry.id}`);
  if (!e.note?.trim() || !e.date?.trim() || !e.build?.trim()) throw new Error(`Evidence for ${entry.id} needs a note, a date and a build`);
  return { verdict: e.verdict, note: e.note, date: e.date, build: e.build };
}

export const REQUIRES_FIXED = ["public-address", "two-machines", "brain"];
export const ENFORCED = ["registration", "server", "inline", "always", "plugin"];

/** The edition and picker fields of one map entry, checked against the closed vocabulary in the release gate. */
export function pickerFromMap(entry, ledgerIds, featureIds) {
  if (entry.edition === "private") {
    if ((entry.private_reason ?? "").trim().length < 20) throw new Error(`Private-only ${entry.id} needs a private_reason`);
    return { edition: "private", privateReason: entry.private_reason };
  }
  if (entry.edition !== "both") throw new Error(`Feature ${entry.id} needs edition both or private`);
  const p = entry.picker;
  if (!p || !["on", "off"].includes(p.default)) throw new Error(`Feature ${entry.id} needs a picker default of on or off`);
  if (!ENFORCED.includes(p.enforced)) throw new Error(`Feature ${entry.id} has an unknown enforced value ${p.enforced}`);
  if (p.enforced === "always" && p.default !== "on") throw new Error(`Feature ${entry.id} is always on, so its default must be on`);
  if (!p.gate?.trim()) throw new Error(`Feature ${entry.id} must name its gate`);
  for (const r of p.requires ?? []) {
    const m = /^(core|feature):(.+)$/.exec(r);
    if (REQUIRES_FIXED.includes(r)) continue;
    if (m?.[1] === "core" && ledgerIds.has(m[2])) continue;
    if (m?.[1] === "feature" && featureIds.has(m[2])) continue;
    throw new Error(`Feature ${entry.id} requires unknown ${r}`);
  }
  return {
    edition: "both",
    picker: {
      default: p.default,
      requires: p.requires,
      presets: p.presets,
      enforced: p.enforced,
      gate: p.gate,
      plugin: p.plugin,
      ...(p.degrades_without?.length ? { degradesWithout: p.degrades_without } : {}),
      ...(p.improved_by?.length ? { improvedBy: p.improved_by } : {}),
    },
  };
}

/** The core changes the running bb may or may not have, with how to detect each one. */
export function buildCoreLedger(root) {
  const ledger = JSON.parse(readFileSync(join(root, "features/core-ledger.json"), "utf8"));
  return ledger.map((c) => ({
    id: c.id,
    summary: c.summary,
    route: c.route,
    effect: c.effect,
    upstreamPr: c.upstream_pr,
    minCore: c.min_core,
    features: c.features,
    probe: c.probe,
  }));
}

export function buildFeatures(root) {
  const read = (f) => readFileSync(join(root, f), "utf8");
  const map = JSON.parse(read("features/map.json"));
  const showMe = JSON.parse(read("features/show-me.json"));
  const described = new Map(read("features/descriptions.tsv").split("\n").filter(Boolean).map((l) => {
    const [id, area, description] = l.split("\t");
    return [id, { area, description }];
  }));
  const ledgerIds = new Set(JSON.parse(read("features/core-ledger.json")).map((c) => c.id));
  const featureIds = new Set(map.map((e) => e.id));
  return map.map((e) => {
    const d = described.get(e.id);
    if (!d) throw new Error(`No description for ${e.id}`);
    if (!AREAS.includes(d.area)) throw new Error(`Unknown area ${d.area} for ${e.id}`);
    if (!showMe[e.id]) throw new Error(`No Show me target for ${e.id}`);
    return {
      id: e.id,
      name: e.title,
      description: d.description,
      area: d.area,
      surface: e.surface,
      status: statusFromMap(e),
      where: e.where,
      gap: e.gap,
      evidence: evidenceFromMap(e),
      showMe: showMe[e.id],
      ...pickerFromMap(e, ledgerIds, featureIds),
    };
  });
}

export function renderCoreLedgerModule(coreLedger) {
  return [
    "// Generated by scripts/build-features-guide.mjs from features/core-ledger.json.",
    "// Do not edit by hand: change that file and run `node scripts/build-features-guide.mjs`.",
    'import type { CoreChange } from "./features-guide-types";',
    "",
    `export const CORE_LEDGER: readonly CoreChange[] = ${JSON.stringify(coreLedger, null, 2)};`,
    "",
  ].join("\n");
}

export function renderModule(features) {
  return [
    "// Generated by scripts/build-features-guide.mjs from features/map.json, features/descriptions.tsv and features/show-me.json.",
    "// Do not edit by hand: change those files and run `node scripts/build-features-guide.mjs`.",
    'import type { Feature } from "./features-guide-types";',
    "",
    `export const FEATURE_AREAS: readonly string[] = ${JSON.stringify(AREAS, null, 2)};`,
    "",
    `export const FEATURES: readonly Feature[] = ${JSON.stringify(features, null, 2)};`,
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  writeFileSync(join(root, "src/features-guide-data.ts"), renderModule(buildFeatures(root)));
  writeFileSync(join(root, "src/core-ledger-data.ts"), renderCoreLedgerModule(buildCoreLedger(root)));
}

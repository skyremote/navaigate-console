// @vitest-environment jsdom
import React from "react";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FEATURES, FEATURE_AREAS } from "../src/features-guide-data";
import { statusLabel, type Feature } from "../src/features-guide-types";
import { FeaturesGuide } from "../src/features-guide";
import { FEATURES_GUIDE_HREF, openFeaturesGuide } from "../src/features-guide-nav";
// @ts-expect-error plain script, no declaration file
import { buildFeatures, renderModule, statusFromMap } from "../scripts/build-features-guide.mjs";

const ROOT = join(__dirname, "..");
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const EXTRA_IDS = [...LETTERS, ...["A", "B", "C", "D", "E", "F", "G"].map((l) => `A${l}`)].map((l) => `EXTRA-${l}`); // EXTRA-A to EXTRA-Z, then EXTRA-AA to EXTRA-AG
/** Features added after the 1 November live check carry the date and build of their own check. */
const LATER_EVIDENCE: Record<string, [string, string]> = { "EXTRA-AG": ["2026-11-10", "bb 0.49.0"] };
const EXPECTED_IDS = [
  ...Array.from({ length: 83 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, i) => `S0${i + 1}`).filter((id) => id !== "S07"), // S07, guest review links, is dropped
  ...EXTRA_IDS,
];
const CLIENT_NAME = ["Auto", "desk"].join(""); // spelled in parts so this guard does not itself name the client
const PRIVATE_WORDS = new RegExp(`\\bM[1-9]\\b|${CLIENT_NAME}|daniel|thr_|/Users`, "i");
const MAP = JSON.parse(readFileSync(join(ROOT, "features/map.json"), "utf8")) as Array<{ id: string; status: string }>;
const COUNTS = { live: MAP.filter((e) => e.status === "live").length, partly: MAP.filter((e) => e.status === "partly").length, blocked: MAP.filter((e) => e.status === "blocked").length };

beforeEach(() => {
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the features data", () => {
  it("lists the 90 video features that are kept (S07 is dropped) and the extras, once each", () => {
    expect(FEATURES.map((f) => f.id).sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(EXPECTED_IDS.length);
    expect(FEATURES.length).toBe(MAP.length);
  });

  it("gives every feature a plain name, a description, a click path and a Show me target", () => {
    for (const f of FEATURES) {
      expect(f.name.trim(), f.id).not.toBe("");
      expect(f.description.trim(), f.id).not.toBe("");
      expect(f.where.trim(), f.id).not.toBe("");
      expect(f.showMe, f.id).toBeTruthy();
      expect(FEATURE_AREAS, f.id).toContain(f.area);
    }
  });

  it("uses only Live, Partly live with what is missing, and Blocked with its reason", () => {
    expect(statusFromMap({ id: "x", status: "live", gap: "" })).toEqual({ kind: "live" });
    expect(statusFromMap({ id: "x", status: "partly", gap: "The restricted Mac is not a destination." })).toEqual({ kind: "partly" });
    expect(() => statusFromMap({ id: "x", status: "partly", gap: " " })).toThrow(/what is missing/);
    expect(statusFromMap({ id: "x", status: "blocked", gap: "", reason: "needs a physical iPhone" })).toEqual({ kind: "blocked", reason: "needs a physical iPhone" });
    expect(() => statusFromMap({ id: "x", status: "blocked", gap: "" })).toThrow(/reason/);
    expect(() => statusFromMap({ id: "x", status: "coming", gap: "" })).toThrow(/Unknown status/);
    for (const f of FEATURES) {
      expect(["live", "partly", "blocked"], f.id).toContain(f.status.kind);
      if (f.status.kind === "partly") expect(f.gap.trim().length, f.id).toBeGreaterThan(10);
    }
  });

  it("marks the Fleet-delivered parts of F03, F06, F18 and F65 as live once the updated Fleet is installed", () => {
    const byId = new Map(FEATURES.map((f) => [f.id, f]));
    for (const id of ["F03", "F06", "F18", "F65"]) {
      const f = byId.get(id)!;
      expect(f.status, id).toEqual({ kind: "live" });
      expect(f.where, id).toMatch(/once the updated Fleet is installed/);
    }
    expect(byId.get("F03")!.where).toMatch(/Codex/);
    expect(byId.get("F06")!.where).toMatch(/'Tell this chat'.*'Ask <machine> and read the answer'|'Ask <machine> and read the answer'.*'Tell this chat'/);
    expect(byId.get("F18")!.where).toMatch(/'Open terminal on <machine> \(SSH\)'/);
    expect(byId.get("F65")!.where).toMatch(/'New project on <machine>'/);
    for (const id of ["F01", "F02", "F04", "F05"]) expect(byId.get(id)!.where, id).not.toMatch(/updated Fleet is installed/);
  });

  it("states a reason for every blocked feature", () => {
    const blocked = FEATURES.filter((f) => f.status.kind === "blocked");
    expect(blocked.map((f) => f.id).sort()).toEqual(["F16", "F41", "F76", "S01", "S02"]);
    for (const f of blocked) {
      const s = f.status as { kind: "blocked"; reason: string };
      expect(s.reason.length, f.id).toBeGreaterThan(8);
      expect(statusLabel(f.status)).toBe(`Blocked: ${s.reason}`);
    }
    expect(statusLabel({ kind: "live" })).toBe("Live");
    expect(statusLabel({ kind: "partly" })).toBe("Partly live");
  });

  it("keeps S07 dropped, uses the Stash wording and has the new extras", () => {
    const byId = new Map(FEATURES.map((f) => [f.id, f]));
    expect(byId.has("S07")).toBe(false);
    expect(byId.get("EXTRA-A")!.where).not.toMatch(/Restore/);
    expect(byId.get("EXTRA-A")!.where).toMatch(/Open a stashed chat to work in it again/);
    for (const id of ["EXTRA-C", "EXTRA-E", "EXTRA-F", "EXTRA-G", "F66", "F77", "F78", "F79"]) expect(byId.get(id)!.status, id).toEqual({ kind: "live" });
    expect(byId.get("EXTRA-G")!.where).toMatch(/your own public address/);
  });

  it("has the webhook features live with their 1 November evidence and F82 partly", () => {
    const byId = new Map(FEATURES.map((f) => [f.id, f]));
    for (const id of ["F51", "F52", "F53", "S04"]) expect(byId.get(id)!.status, id).toEqual({ kind: "live" });
    expect(byId.get("F51")!.where).toMatch(/signed POST to your public address ran the hook once.*ACK.*unsigned POST got 401/);
    expect(byId.get("F52")!.where).toMatch(/returned 202.*replied ACK exactly once.*deduplicated/);
    expect(byId.get("S04")!.where).toMatch(/deduplicated/);
    expect(byId.get("F82")!.status).toEqual({ kind: "partly" });
    expect(byId.get("F82")!.gap).toMatch(/^macOS proven on the two Macs\. Linux and Windows through WSL .* untested\. The machine figures \(CPU, memory, keep-awake\) are macOS only\.$/);
    expect(byId.get("F28")!.gap).toMatch(/core/);
  });

  it("keeps the other providers off by choice and says so", () => {
    const f02 = FEATURES.find((f) => f.id === "F02")!;
    expect(f02.status).toEqual({ kind: "partly" });
    expect(f02.gap).toMatch(/^Other providers are switched off by choice; Claude and Codex are in use\./);
  });

  it("carries the 1 November live evidence on every feature", () => {
    for (const f of FEATURES) {
      expect(["PASS", "FAIL", "UNVERIFIED", "RECHECK"], f.id).toContain(f.evidence.verdict);
      expect(f.evidence.note.trim().length, f.id).toBeGreaterThan(10);
      expect(f.evidence.note.length, f.id).toBeLessThanOrEqual(160);
      expect([f.evidence.date, f.evidence.build], f.id).toEqual(LATER_EVIDENCE[f.id] ?? ["2026-11-01", "release 6"]);
    }
    const byId = new Map(FEATURES.map((f) => [f.id, f]));
    // Fixed after the first live check and seen working again on Console b9bbc7f and Fleet 40b4ee2.
    for (const id of ["F30", "F34", "F75", "F58"]) expect(byId.get(id)!.evidence.verdict, id).toBe("PASS");
    expect(FEATURES.filter((f) => f.evidence.verdict === "RECHECK")).toEqual([]);
    for (const f of FEATURES.filter((x) => x.status.kind === "blocked")) expect(f.evidence.verdict, f.id).toBe("UNVERIFIED");
    expect(FEATURES.filter((f) => f.evidence.verdict === "PASS").length).toBeGreaterThan(40);
  });

  it("keeps private names out of what users see: evidence notes, the generated data and the live-payload fixture", () => {
    const generated = readFileSync(join(ROOT, "src/features-guide-data.ts"), "utf8");
    const map = readFileSync(join(ROOT, "features/map.json"), "utf8");
    const fixtureText = readFileSync(join(ROOT, "tests/fixtures/fleet-live-2026-11-01.json"), "utf8");
    // Names that must appear nowhere in the generated file or the map.
    for (const [name, text] of [["generated data", generated], ["map.json", map]] as const)
      for (const pattern of [/daniel/i, /thr_/, /\/Users/]) expect(text, `${name} ${pattern}`).not.toMatch(pattern);
    // Machine names, client names and personal paths never appear in evidence notes (shown as tooltips and lines on the page) or the fixture.
    for (const f of FEATURES) expect(`${f.evidence.note} ${f.evidence.build}`, f.id).not.toMatch(PRIVATE_WORDS);
    expect(fixtureText).not.toMatch(new RegExp(`${CLIENT_NAME}|daniel|/Users|getbb\\.app`, "i"));
  });

  it("counts the statuses", () => {
    const n = (k: string) => FEATURES.filter((f) => f.status.kind === k).length;
    expect([n("live"), n("partly"), n("blocked")]).toEqual([COUNTS.live, COUNTS.partly, COUNTS.blocked]);
    expect(COUNTS.live + COUNTS.partly + COUNTS.blocked).toBe(FEATURES.length);
  });

  it("names the plugin or core wherever a feature is outside this plugin", () => {
    for (const f of FEATURES) {
      if (f.surface === "fleet") expect(f.where + f.gap, f.id).toMatch(/Fleet/);
      if (f.surface === "helperdesk") expect(f.where, f.id).toMatch(/Helper Desk plugin/);
      if (f.surface === "core") expect(f.where, f.id).toMatch(/Core|core/);
    }
  });

  it("quotes only labels that this plugin draws, apart from the listed computed or outside labels", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.startsWith("features-guide-data")) sources.push(readFileSync(path, "utf8"));
      }
    };
    walk(join(ROOT, "src"));
    for (const name of readdirSync(ROOT)) if (/^(app\.tsx|server.*\.ts)$/.test(name)) sources.push(readFileSync(join(ROOT, name), "utf8"));
    const corpus = sources.join("\n");
    const outside = new Set([
      "Would not start: …", "Started from commit …", "N need you", "Owner: <machine>", "N working", "#41", "Read 3m ago",
      "Session 66% left · resets 14:05", "One allowance · <machine> + <machine> · counted once", "Is this one Claude account?",
      "Merge into <base>…", "<host>: no review adapter yet", "!7", "Test the title helper", "Test the commit helper",
      "Return … to automatic", "Use chosen model for automatic title helper", "CI failed: <check> on PR #<n>",
      "Context arrived on the always-on Mac: …", "Prepare review task", "Request <id>",
      "MCP: on/off", "Handoff to new thread", "Open <machine> bb", "Open terminal on <machine>", "Show <device>", "I checked the page",
      "route: <active>", "Copy MCP endpoint", "Versions and updates", "Update to <version>", "Open in editor", "Open <project> in VS Code",
      "Add a project", "Sent from here", "Ask <machine> and read the answer", "Open terminal on <machine> (SSH)", "New project on <machine>", "Create on <machine>", "<machine> service", "Only send <machine> a brief", "Run on <machine>", "Set this project up on <machine>", "Move this chat to <machine>", "Prompt stack", "Use project default", "ask Codex to...", "Check owner receipt", "Load metrics", "Pin version", "Choose mascot", "Mascots", "Default mascots", "Right-hand mascot", "Back to the cloud",
    ]);
    const quoted = /(?:^|(?<=[\s(]))'([^']+?)'(?=[\s,.;:)]|$)/g;
    for (const f of FEATURES)
      for (const [, label] of f.where.matchAll(quoted)) if (!outside.has(label)) expect(corpus.includes(label), `${f.id}: '${label}'`).toBe(true);
  });

  it("is exactly what the generator writes from the map", () => {
    const text = readFileSync(join(ROOT, "src/features-guide-data.ts"), "utf8");
    expect(text).toBe(renderModule(buildFeatures(ROOT)));
  });

  it("points every Show me at a page that exists", async () => {
    const captured = await loadPluginApp(() => import("../app"));
    const panels = new Set(captured.navPanels.map((p) => p.path));
    for (const f of FEATURES) {
      const t = f.showMe;
      if (t.kind === "panel") expect(panels.has(t.path), f.id).toBe(true);
      if (t.kind === "route") expect(t.href.startsWith("/plugins/") || t.href.startsWith("/settings"), f.id).toBe(true);
      if (t.kind === "none") expect(t.reason.length, f.id).toBeGreaterThan(3);
    }
  });

  it("uses British English, sentence case names and no emoji", () => {
    const american = /\b(color|colors|organize|organized|behavior|favorite|center|license|gray|catalog)\b/i;
    for (const f of FEATURES) {
      const text = `${f.name} ${f.description}`;
      expect(text, f.id).not.toMatch(american);
      expect(text, f.id).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(f.name[0], f.id).toBe(f.name[0].toUpperCase());
    }
  });
});

function renderGuide(extra: Parameters<typeof renderSlot>[2] = {}) {
  return renderSlot({ component: FeaturesGuide }, {}, extra);
}
const filterButton = (value: string) => document.querySelector(`button[data-value="${value}"]`) as HTMLElement;
const showMe = (id: string) => row(id).querySelector("button") as HTMLButtonElement;
const row = (id: string) => document.querySelector(`[data-feature="${id}"]`) as HTMLElement;

describe("the features page", () => {
  it("shows every feature with its status and where to find it", () => {
    renderGuide();
    expect(document.querySelectorAll("[data-feature]")).toHaveLength(FEATURES.length);
    const f01 = within(row("F01"));
    expect(f01.getByText("Use existing AI subscriptions")).toBeTruthy();
    expect(f01.getByText(/Keep using Claude, Codex and other subscriptions/)).toBeTruthy();
    expect(f01.getByText("Live")).toBeTruthy();
    expect(f01.getByText(/Fleet plugin: left icon rail, Fleet, each machine card/)).toBeTruthy();
    expect(within(row("F16")).getByText("Blocked: needs a signed app build and a physical iPhone")).toBeTruthy();
    expect(within(row("F28")).getByText("Partly live")).toBeTruthy();
    expect(within(row("EXTRA-A")).getByText("Live")).toBeTruthy();
    expect(within(row("EXTRA-C")).getByText("Live")).toBeTruthy();
  });

  it("keeps what is missing behind a details line", () => {
    renderGuide();
    expect(row("F28").querySelector("details")?.textContent).toMatch(/What is missing.*restricted Mac is not a destination/);
    expect(row("F16").querySelector("details summary")?.textContent).toBe("Why it is blocked");
    expect((row("F28").querySelector("details") as HTMLDetailsElement).open).toBe(false);
    expect(row("F31").querySelector("details")).toBeNull();
  });

  it("groups the features by area and counts them", () => {
    renderGuide();
    const headings = [...document.querySelectorAll("h2")].map((h) => h.textContent);
    for (const area of FEATURE_AREAS) expect(headings.some((h) => h?.startsWith(area)), area).toBe(true);
    expect(screen.getByText(new RegExp(`${COUNTS.live} live, ${COUNTS.partly} partly live and ${COUNTS.blocked} blocked`))).toBeTruthy();
  });

  it("marks proven features, gives the reason for unproven ones and the re-check note for fixed ones", () => {
    renderGuide();
    const proof = (id: string) => row(id).querySelector(".nav-gd-proof") as HTMLElement;
    expect(proof("F19").textContent).toBe("Proven live");
    expect(proof("F19").querySelector("b")!.getAttribute("title")).toMatch(/1 November 2026, release 6/);
    expect(proof("F07").textContent).toMatch(/^Not proven live yet: MCP is off/);
    expect(proof("F30").textContent).toBe("Proven live");
    expect(proof("F16").textContent).toMatch(/Blocked, not checked: needs a signed app build/);
    expect(document.querySelectorAll("[data-proof='pass']").length).toBe(FEATURES.filter((f) => f.evidence.verdict === "PASS").length);
  });

  it("filters by status", () => {
    renderGuide();
    fireEvent.click(filterButton("blocked"));
    expect(document.querySelectorAll("[data-feature]")).toHaveLength(COUNTS.blocked);
    fireEvent.click(filterButton("partly"));
    expect(document.querySelectorAll("[data-feature]")).toHaveLength(COUNTS.partly);
    expect(filterButton("coming")).toBeNull();
    fireEvent.click(filterButton("all"));
    expect(document.querySelectorAll("[data-feature]")).toHaveLength(FEATURES.length);
  });

  it("searches names, descriptions, ids and click paths", () => {
    renderGuide();
    const box = screen.getByLabelText("Search features");
    fireEvent.change(box, { target: { value: "snooze" } });
    const ids = [...document.querySelectorAll("[data-feature]")].map((e) => e.getAttribute("data-feature"));
    expect(ids).toContain("F33");
    expect(ids).not.toContain("F01");
    fireEvent.change(box, { target: { value: "f58" } });
    expect([...document.querySelectorAll("[data-feature]")].map((e) => e.getAttribute("data-feature"))).toEqual(["F58"]);
    fireEvent.change(box, { target: { value: "no such feature anywhere" } });
    expect(screen.getByText("No feature matches that search.")).toBeTruthy();
  });

  it("opens an own page through the plugin navigation", () => {
    const view = renderGuide();
    fireEvent.click(showMe("F30"));
    expect(view.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "work-needs-you" }]);
  });

  it("opens another plugin's page or a settings page by address", () => {
    const view = renderGuide();
    const popped = vi.fn();
    window.addEventListener("popstate", popped);
    fireEvent.click(showMe("F01"));
    expect(window.location.pathname).toBe("/plugins/fleet/fleet");
    expect(popped).toHaveBeenCalledTimes(1);
    fireEvent.click(showMe("F72"));
    expect(window.location.pathname).toBe("/settings/keyboard");
    expect(view.inspection.navigateCalls).toEqual([]);
    window.removeEventListener("popstate", popped);
  });

  it("opens the new chat screen for composer features", () => {
    const view = renderGuide();
    fireEvent.click(showMe("F55"));
    expect(view.inspection.navigateCalls).toEqual([{ method: "toCompose", options: { focusPrompt: true } }]);
  });

  it("disables Show me where a page cannot be opened and says why", () => {
    renderGuide();
    const chat = showMe("F04") as HTMLButtonElement;
    expect(chat.disabled).toBe(true);
    expect(within(row("F04")).getByText(/Open a chat first/)).toBeTruthy();
    const phone = showMe("F41") as HTMLButtonElement;
    expect(phone.disabled).toBe(true);
    expect(within(row("F41")).getByText("Phone only")).toBeTruthy();
  });

  it("uses blue only for Live", () => {
    renderGuide();
    const tone = (id: string) => row(id).querySelector("[data-status]")?.getAttribute("data-status");
    expect(tone("F01")).toBe("live");
    expect(tone("F28")).toBe("partly");
    expect(tone("EXTRA-A")).toBe("live");
    expect(tone("F16")).toBe("blocked");
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    const live = /\[data-status="live"\][^{]*\{[^}]*attention/.exec(css);
    expect(live).toBeTruthy();
    expect(css).not.toMatch(/\[data-status="(partly|blocked)"\][^{]*\{[^}]*(attention|success|warning)/);
    expect(css).not.toMatch(/gold|amber|#c8a|#d4a/i);
  });
});

describe("opening the guide", () => {
  it("goes to the guide page by address", () => {
    const popped = vi.fn();
    window.addEventListener("popstate", popped);
    openFeaturesGuide();
    expect(window.location.pathname).toBe(FEATURES_GUIDE_HREF);
    expect(FEATURES_GUIDE_HREF).toBe("/plugins/navaigate-skin/features");
    expect(popped).toHaveBeenCalledTimes(1);
    window.removeEventListener("popstate", popped);
  });

  it("is registered as a page, a command and a sidebar footer item", async () => {
    const captured = await loadPluginApp(() => import("../app"));
    const panel = captured.navPanels.find((p) => p.id === "features");
    expect(panel).toMatchObject({ title: "Features", path: "features" });
    const footer = captured.experimentalSidebarFooterItems.find((i) => i.id === "features-guide");
    expect(footer).toMatchObject({ kind: "action", label: "Features guide" });
    (footer as unknown as { onActivate(c: unknown): void }).onActivate({ openPluginDetails() {} });
    expect(window.location.pathname).toBe(FEATURES_GUIDE_HREF);
    const source = readFileSync(join(ROOT, "app.tsx"), "utf8");
    expect(source).toMatch(/id: "open-features-guide"[^}]*title: "Workspace: features guide"/);
  });

  it("renders the page in the plugin boundary", async () => {
    const captured = await loadPluginApp(() => import("../app"));
    const panel = captured.navPanels.find((p) => p.id === "features")!;
    renderSlot({ component: panel.component as React.ComponentType<object> }, {});
    expect(document.querySelector("h1")?.textContent).toBe("Features");
  });
});

describe("typing", () => {
  it("gives every feature the same shape", () => {
    const base = ["area", "description", "edition", "evidence", "gap", "id", "name", "showMe", "status", "surface", "where"];
    for (const f of FEATURES as readonly Feature[]) {
      const keys = Object.keys(f).sort();
      expect(keys, f.id).toEqual([...base, f.edition === "both" ? "picker" : "privateReason"].sort());
    }
  });
});

// With GUIDE_PREVIEW_OUT set, this writes a static page per state and mode from
// the real rendered markup, for screenshots outside the live app.
describe.skipIf(!process.env.GUIDE_PREVIEW_OUT)("preview pages", () => {
  const out = process.env.GUIDE_PREVIEW_OUT ?? "";
  const shared = (process.env.GUIDE_PREVIEW_CSS ?? "").split(",").filter(Boolean).map((f) => readFileSync(f, "utf8")).join("\n");
  const theme = readFileSync(join(ROOT, "themes/navaigate.css"), "utf8");
  function write(name: string, mode: "light" | "dark") {
    const styles = [...document.head.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    const page = `<!doctype html><html lang="en-GB" class="${mode}"><head><meta charset="utf-8"><title>Features guide (${name}, ${mode})</title>`
      + `<style>${shared}</style><style>${styles}</style><style>${theme}</style>`
      + `<style>html,body{margin:0;height:100%}body{background:var(--background);color:var(--foreground);font-family:var(--font-sans)}#root{height:100%}</style>`
      + `</head><body><div id="root" data-bb-plugin="navaigate-skin">${document.body.innerHTML}</div></body></html>`;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}-${mode}.html`), page);
  }
  const states: Array<[string, (() => void) | null]> = [
    ["all", null],
    ["blocked", () => fireEvent.click(filterButton("blocked"))],
    ["search", () => fireEvent.change(screen.getByLabelText("Search features"), { target: { value: "snooze" } })],
    ["partly", () => fireEvent.click(filterButton("partly"))],
  ];
  for (const [name, act] of states) {
    for (const mode of ["light", "dark"] as const) {
      it(`writes ${name} ${mode}`, () => {
        renderGuide();
        act?.();
        write(name, mode);
      });
    }
  }
});

// @vitest-environment jsdom
// Local chats on Claude Code (EXTRA-AM) come on with Online or Local (EXTRA-AH) unless a saved pick says off: for
// every preset, a fresh install, ticking Online or Local by hand in Setup, and an install that never saved a pick
// for EXTRA-AM. A saved "off" stays off. What the Local orb shows follows the same rule.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COMMUNITY_DEFAULTS, type Profile } from "../profile/schema";
import { SetupPage } from "../src/setup";
import { applyPreset, buildProfile, draftFromProfile, setPick } from "../src/setup-model";
import { isFeatureEnabled } from "../src/features-enabled";
import { CLAUDE_OFF_NOTE } from "../src/session-orbs";
import { resetCoreProbes } from "../src/core-probes";
import { resetProfileState, setProfileState } from "../src/use-profile";

const AH = "EXTRA-AH";
const AM = "EXTRA-AM";
type Start = "fresh, no preset" | "fresh, Simple" | "fresh, Pro" | "Simple chosen in Setup" | "Pro chosen in Setup" | "update, never saved EXTRA-AM";
type Saved = "none" | "on" | "off";

/** The profile after the user's own steps: the start, then Online or Local ticked or not, then Save. */
function profileFor(start: Start, saved: Saved, ahOn: boolean): Profile {
  const base: Profile = { ...COMMUNITY_DEFAULTS, features: { preset: null, picks: {} } };
  if (start === "update, never saved EXTRA-AM") {
    // Saved with an older build: every pick but EXTRA-AM; no Setup visit since.
    const picks: Record<string, boolean> = { [AH]: ahOn };
    if (saved !== "none") picks[AM] = saved === "on";
    return { ...base, setup: { completedAt: 1, version: 1 }, features: { preset: "custom", picks } };
  }
  const installer = start === "fresh, Simple" ? "simple" : start === "fresh, Pro" ? "pro" : null;
  let draft = draftFromProfile(base, installer);
  if (start === "Simple chosen in Setup") draft = applyPreset(draft, "simple");
  if (start === "Pro chosen in Setup") draft = applyPreset(draft, "pro");
  draft = setPick(draft, AH, ahOn);
  if (saved !== "none") draft = setPick(draft, AM, saved === "on");
  return buildProfile(base, { ...draft, name: "Pat", thisMac: "Desk" }, 1);
}
/** What the Local orb shows (src/session-orbs.tsx): no Local orb without EXTRA-AH; with it, Claude Code first, or the off note for a saved "off". */
const orbShows = (p: Profile) => (!isFeatureEnabled(p, AH) ? "no Local orb" : isFeatureEnabled(p, AM) ? "Claude Code first" : p.features.picks[AM] === false ? CLAUDE_OFF_NOTE : "opencode only");

describe("Local chats on Claude Code come on with Online or Local, unless a saved pick says off", () => {
  const starts: Start[] = ["fresh, no preset", "fresh, Simple", "fresh, Pro", "Simple chosen in Setup", "Pro chosen in Setup", "update, never saved EXTRA-AM"];
  const rows: Array<[Start, Saved, boolean, boolean, string]> = [];
  for (const start of starts)
    for (const saved of ["none", "on", "off"] as Saved[])
      for (const ah of [true, false]) {
        const amOn = ah && saved !== "off";
        rows.push([start, saved, ah, amOn, !ah ? "no Local orb" : amOn ? "Claude Code first" : CLAUDE_OFF_NOTE]);
      }
  it.each(rows)("%s, EXTRA-AM saved %s, Online or Local %s: Claude Code %s, the orb shows %s", (start, saved, ah, amOn, orb) => {
    const p = profileFor(start, saved, ah);
    expect(isFeatureEnabled(p, AH)).toBe(ah);
    expect(isFeatureEnabled(p, AM)).toBe(amOn);
    expect(orbShows(p)).toBe(orb);
  });
  it("says the off note plainly, true whether the box was unticked or never ticked", () => {
    expect(CLAUDE_OFF_NOTE).toBe("Local chats on Claude Code are off in Setup.");
  });
});

describe("in Setup: Online or Local ticked by hand brings Local chats on Claude Code with it, and an untick is kept", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    window.history.replaceState({}, "", "/");
    resetCoreProbes();
  });
  afterEach(() => {
    cleanup();
    resetProfileState();
    resetCoreProbes();
  });
  const box = (id: string) => document.querySelector(`[data-feature="${id}"] input`) as HTMLInputElement | null;
  const toFeatures = async () => {
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("This Mac"), { target: { value: "Desk" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    await waitFor(() => expect(box(AH)).not.toBeNull());
  };
  const rpcFor = (preset: "simple" | "pro" | null) => {
    const saved: Profile[] = [];
    return { saved, rpc: { setup_hint: () => ({ preset, hostname: "desk" }), profile_save: (i: { profile: Profile }) => (saved.push(i.profile), { profile: i.profile, source: "file", errors: [], path: "p", stamp: `s${saved.length}` }) } };
  };

  it("a fresh install on Simple: tick Online or Local, and Local chats on Claude Code are ticked with it; untick, Save, and it stays off after a reload", async () => {
    const fresh: Profile = { ...COMMUNITY_DEFAULTS, features: { preset: null, picks: {} } };
    setProfileState({ profile: fresh, source: "defaults", errors: [], path: "p", stamp: "s" });
    const first = rpcFor("simple");
    renderSlot({ component: SetupPage }, {}, { rpc: first.rpc as never });
    await toFeatures();
    expect(screen.getByRole("button", { name: "Simple" }).getAttribute("aria-pressed")).toBe("true");
    expect(box(AH)!.checked).toBe(false);
    fireEvent.click(box(AH)!);
    expect(box(AH)!.checked).toBe(true);
    expect(box(AM)!.checked).toBe(true);
    expect(box(AM)!.disabled).toBe(false);
    // The user unticks it and saves.
    fireEvent.click(box(AM)!);
    expect(box(AM)!.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));
    await waitFor(() => expect(first.saved).toHaveLength(1));
    const saved = first.saved[0]!;
    expect(saved.features.picks[AM]).toBe(false);
    expect(isFeatureEnabled(saved, AH)).toBe(true);
    expect(isFeatureEnabled(saved, AM)).toBe(false);
    expect(orbShows(saved)).toBe(CLAUDE_OFF_NOTE);
    // A reload: Setup opens from the saved profile, and the box is still off.
    cleanup();
    setProfileState({ profile: saved, source: "file", errors: [], path: "p", stamp: "s1" });
    renderSlot({ component: SetupPage }, {}, { rpc: rpcFor(null).rpc as never });
    await screen.findByLabelText("Your name");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    await waitFor(() => expect(box(AM)).not.toBeNull());
    expect(box(AH)!.checked).toBe(true);
    expect(box(AM)!.checked).toBe(false);
  });

  it("a fresh install on Simple, left as it is: Local chats on Claude Code are ticked but wait for Online or Local", async () => {
    setProfileState({ profile: { ...COMMUNITY_DEFAULTS, features: { preset: null, picks: {} } }, source: "defaults", errors: [], path: "p", stamp: "s" });
    renderSlot({ component: SetupPage }, {}, { rpc: rpcFor("simple").rpc as never });
    await toFeatures();
    expect(box(AH)!.checked).toBe(false);
    const row = document.querySelector(`[data-feature="${AM}"]`)!;
    expect(row.querySelector("[data-state]")?.getAttribute("data-state") ?? row.getAttribute("data-state")).toBe("greyed");
    expect(row.textContent).toMatch(/Needs: .* ticked\./);
    expect(box(AM)!.disabled).toBe(true);
  });
});

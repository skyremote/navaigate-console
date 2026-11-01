// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COMMUNITY_DEFAULTS, resolveProfile, type Profile } from "../profile/schema";
import { SetupPage } from "../src/setup";
import { SetupOpener, resetSetupOpener } from "../src/setup-opener";
import { SETUP_HREF } from "../src/setup-model";
import { resetCoreProbes, setCoreFound } from "../src/core-probes";
import { gated, useFeature } from "../src/use-feature";
import { pageGate } from "../src/feature-off";
import { resetProfileState, setProfileState } from "../src/use-profile";

beforeEach(() => {
  window.matchMedia = vi.fn((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  window.history.replaceState({}, "", "/");
  resetSetupOpener();
  resetCoreProbes();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetCoreProbes();
});

const community = (over: Partial<Profile> = {}): Profile => ({ ...COMMUNITY_DEFAULTS, ...over });
const seed = (profile: Profile, loaded = true) => {
  if (loaded) setProfileState({ profile, source: profile.setup.completedAt === null ? "defaults" : "file", errors: [], path: "p", stamp: "s" });
  else resetProfileState();
};

describe("opening setup on a first run", () => {
  it("opens the setup page once for a community profile the server has answered for", () => {
    seed(community());
    const popped = vi.fn();
    window.addEventListener("popstate", popped);
    const { rerender } = render(<SetupOpener />);
    expect(window.location.pathname).toBe(SETUP_HREF);
    expect(popped).toHaveBeenCalledTimes(1);
    rerender(<SetupOpener />);
    window.history.replaceState({}, "", "/");
    render(<SetupOpener />);
    expect(popped).toHaveBeenCalledTimes(1); // once per session, even when the screen mounts again
    window.removeEventListener("popstate", popped);
  });

  it("does not open before the server has answered, so the defaults are not mistaken for a first run", () => {
    seed(community(), false);
    render(<SetupOpener />);
    expect(window.location.pathname).toBe("/");
    act(() => setProfileState({ profile: community(), source: "defaults", errors: [], path: "p", stamp: "s" }));
    expect(window.location.pathname).toBe(SETUP_HREF);
  });

  it("never opens for the private edition, nor once setup is done", () => {
    seed(community({ edition: "private" }));
    render(<SetupOpener />);
    expect(window.location.pathname).toBe("/");
    cleanup();
    seed(community({ setup: { completedAt: 3, version: 1 } }));
    render(<SetupOpener />);
    expect(window.location.pathname).toBe("/");
  });
});

describe("the setup page", () => {
  function rpcFor(profile: Profile, preset: "simple" | "pro" | null = null, failWith: string | null = null) {
    const saved: Profile[] = [];
    const stamps: (string | undefined)[] = [];
    const rpc = {
      setup_hint: () => ({ preset }),
      profile_save: (input: { profile: Profile; expectedStamp?: string }) => {
        saved.push(input.profile);
        stamps.push(input.expectedStamp);
        if (failWith) throw new Error(failWith);
        return { profile: input.profile, source: "file", errors: [], path: "p", stamp: `saved-${saved.length}` };
      },
    };
    return { rpc, saved, stamps, profile };
  }
  const next = () => fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  it("walks the five steps, keeps the first required, and saves a profile with setup marked done", async () => {
    seed(community());
    const { rpc, saved } = rpcFor(community());
    const view = renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
    await screen.findByLabelText("Your name");
    expect(screen.queryByRole("button", { name: "Skip this step" })).toBeNull(); // no skip on the first step
    next();
    expect(screen.getByRole("alert").textContent).toMatch(/name/i);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Pat" } });
    next();
    fireEvent.change(screen.getByLabelText("This Mac"), { target: { value: "Pat's Laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" })); // skipping the Macs step keeps the typed name
    fireEvent.click(screen.getByRole("button", { name: "Skip this step" })); // addresses
    fireEvent.click(screen.getByRole("button", { name: "Pro" }));
    next();
    expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const profile = saved[0]!;
    expect(profile.owner.name).toBe("Pat");
    expect(profile.machines[0]).toMatchObject({ id: "pat-s-laptop", label: "Pat's Laptop" });
    expect(profile.features.preset).toBe("pro");
    expect(profile.setup.completedAt).toBeGreaterThan(0);
    expect(resolveProfile(profile).errors).toEqual([]);
    expect(view.inspection.rpcCalls.map((c: { method: string }) => c.method).sort()).toEqual(["profile_save", "setup_hint"]); // nothing else: plugin settings are not touched
  });

  it("sends the stamp of the profile file it opened from, so a save over a newer file is refused by the server", async () => {
    seed(community());
    const { rpc, stamps } = rpcFor(community());
    renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat" } });
    next(); next(); next(); next();
    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));
    await waitFor(() => expect(stamps).toHaveLength(1));
    expect(stamps[0]).toBe("s");
  });

  it("shows the server's plain message when the profile is not saved, and does not say it was", async () => {
    seed(community());
    for (const message of ["The profile changed since you opened Setup. Reload and try again.", "profile not saved: machines: duplicate id this-mac"]) {
      cleanup();
      const { rpc } = rpcFor(community(), null, message);
      renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
      fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat" } });
      next(); next(); next(); next();
      fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
      expect(screen.queryByRole("status")).toBeNull();
    }
  });

  it("refuses a token in the brain step and does not save", async () => {
    seed(community());
    const { rpc, saved } = rpcFor(community());
    renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat" } });
    next();
    next();
    fireEvent.change(screen.getByLabelText("Name of the secret that holds the brain token"), { target: { value: ["sk", "-ant-", "api03-AbCdEf0123456789AbCdEf0123456789"].join("") } });
    expect(screen.getByRole("alert").textContent).toMatch(/looks like the secret itself/);
    next();
    expect(screen.getByRole("heading", { name: "Addresses" })).toBeTruthy(); // stays on the step
    expect(saved).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Name of the secret that holds the brain token"), { target: { value: "BRAIN_TOKEN" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("greys a box that needs a second Mac, hides one whose core change is missing, and locks always-on ones", async () => {
    seed(community());
    const { rpc } = rpcFor(community());
    renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat" } });
    next(); next(); next();
    const box = (id: string) => document.querySelector(`[data-feature="${id}"]`) as HTMLElement | null;
    expect(box("F10")?.getAttribute("data-state")).toBe("greyed");
    expect(box("F10")?.textContent).toMatch(/second Mac/);
    expect((box("F10")?.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect(box("F08")).toBeNull(); // hidden, not greyed
    expect(box("F01")?.getAttribute("data-state")).toBe("locked");
    expect((box("F01")?.querySelector("input") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pro" }));
    expect(screen.queryByText("Custom choice")).toBeNull();
    fireEvent.click(box("EXTRA-I")!.querySelector("input")!);
    expect(screen.getByText("Custom choice")).toBeTruthy();
  });

  it("shows the Markdown plugin and Prompt Stack as separate plugins with a link, no box, and records no pick for them", async () => {
    seed(community());
    const { rpc, saved } = rpcFor(community());
    renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat" } });
    next(); next(); next();
    for (const [id, plugin] of [["EXTRA-E", "navmotion-skin"], ["EXTRA-H", "prompt-stack"]] as const) {
      const row = document.querySelector(`[data-feature="${id}"]`) as HTMLElement;
      expect(row.getAttribute("data-state")).toBe("plugin");
      expect(row.querySelector("input")).toBeNull();
      expect(row.textContent).toMatch(/separate plugin/);
      expect(row.querySelector("a")?.getAttribute("href")).toBe(`/settings/plugins/${plugin}`);
    }
    fireEvent.click(screen.getByRole("button", { name: "Pro" }));
    next();
    fireEvent.click(screen.getByRole("button", { name: "Save and finish" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(Object.keys(saved[0]!.features.picks)).not.toContain("EXTRA-E");
    expect(Object.keys(saved[0]!.features.picks)).not.toContain("EXTRA-H");
  });

  it("shows a feature once the running bb carries its core change", async () => {
    seed(community());
    act(() => setCoreFound({ releaseBuild: true, nativeHistory: true, cleanupSafety: true, continuationIntent: true }));
    const { rpc } = rpcFor(community());
    renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat" } });
    next(); next(); next();
    expect(document.querySelector('[data-feature="F08"]')).not.toBeNull();
  });

  it("starts from the preset the installer chose", async () => {
    seed(community());
    const { rpc } = rpcFor(community(), "pro");
    renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Pat" } });
    next(); next(); next();
    expect(screen.getByRole("button", { name: "Pro" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("gates draw nothing, or an off note, while a feature is off", () => {
  const Probe = gated("EXTRA-I", () => <p>inbox body</p>);
  const Page = pageGate("EXTRA-J", () => <p>calendar body</p>);
  function Flag() {
    return <span>{useFeature("EXTRA-I") ? "on" : "off"}</span>;
  }

  it("follows the picker for the community edition and reads everything on for the private one", () => {
    seed(community());
    render(<><Probe /><Page /><Flag /></>);
    expect(screen.queryByText("inbox body")).toBeNull();
    expect(screen.getByText(/Calendar page: month view.* is switched off/)).toBeTruthy();
    expect(screen.getByText("off")).toBeTruthy();
    cleanup();
    seed(community({ edition: "private" }));
    render(<><Probe /><Page /></>);
    expect(screen.getByText("inbox body")).toBeTruthy();
    expect(screen.getByText("calendar body")).toBeTruthy();
  });

  it("shows while loading when there is nothing cached, and uses a profile cached from the last session at once", () => {
    resetProfileState();
    render(<Flag />);
    expect(screen.getByText("on")).toBeTruthy(); // community defaults are a placeholder until the server answers
    cleanup();
    setProfileState({ profile: community({ features: { preset: "custom", picks: { "EXTRA-I": false } }, setup: { completedAt: 1, version: 1 } }), source: "file", errors: [], path: "p", stamp: "s", loaded: false });
    render(<Flag />);
    expect(screen.getByText("off")).toBeTruthy();
  });

  it("registers a sidebar page only for features that are on at load, and the private edition registers all", async () => {
    seed(community({ edition: "private" }));
    const all = await loadPluginApp(() => import("../app"));
    const paths = (a: typeof all) => a.navPanels.map((p) => p.path).sort();
    expect(paths(all)).toEqual(expect.arrayContaining(["home", "inbox", "calendar", "dashboard", "board", "stash", "work-needs-you", "delivery", "features", "setup"]));
    seed(community({ setup: { completedAt: 1, version: 1 } }));
    const some = await loadPluginApp(() => import("../app"));
    expect(paths(some)).toEqual(expect.arrayContaining(["features", "setup", "home", "work-needs-you"]));
    expect(paths(some)).not.toContain("inbox");
    expect(paths(some)).not.toContain("calendar");
    expect(paths(some)).not.toContain("board");
  }, 30_000);
});

describe("tour anchors", () => {
  it("keeps a stable data-tour attribute on Setup, Home, the rail, the Features guide and the Fleet entry", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const anchors: Array<[string, string]> = [
      ["src/setup.tsx", "console-setup"], ["src/home.tsx", "console-home"], ["src/rail.tsx", "console-rail"],
      ["src/features-guide.tsx", "console-features"], ["src/home-panels.tsx", "console-fleet"],
    ];
    for (const [file, anchor] of anchors) expect(read(file), `${file} carries ${anchor}`).toContain(`data-tour="${anchor}"`);
    seed(community());
    const { rpc } = (() => ({ rpc: { setup_hint: () => ({ preset: null }) } }))();
    renderSlot({ component: SetupPage }, {}, { rpc: rpc as never });
    expect(document.querySelector('[data-tour="console-setup"]')).not.toBeNull();
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COMMUNITY_DEFAULTS, type Profile } from "../profile/schema";
import { PicksOffContext, useFeatureOff } from "../components/picks-context";
import { FLEET_GATED_IDS, offMessage, pickedOff, picksOff } from "./picks";

const community = (picks: Record<string, boolean>): Profile => ({ ...COMMUNITY_DEFAULTS, features: { preset: null, picks } });
const privateEdition = (picks: Record<string, boolean>): Profile => ({ ...community(picks), edition: "private" });

describe("pickedOff", () => {
  it("is off only for a community profile whose pick is exactly false", () => {
    expect(pickedOff(community({ F18: false }), "F18")).toBe(true);
    expect(pickedOff(community({ F18: true }), "F18")).toBe(false);
  });

  it("treats no profile pick as on", () => {
    expect(pickedOff(COMMUNITY_DEFAULTS, "F18")).toBe(false);
    expect(pickedOff(community({}), "F18")).toBe(false);
  });

  it("never switches anything off in the private edition", () => {
    expect(pickedOff(privateEdition({ F18: false }), "F18")).toBe(false);
    expect(picksOff(privateEdition(Object.fromEntries(FLEET_GATED_IDS.map((id) => [id, false]))))).toEqual([]);
  });
});

describe("picksOff", () => {
  it("lists only Fleet's own gated ids that are picked off, never other features or F01", () => {
    expect(picksOff(community({ F07: false, F25: true, F01: false, F19: false, EXTRA_C: false, F82: false }))).toEqual(["F07", "F82"]);
  });
});

describe("offMessage", () => {
  it("names the feature in plain words and where to switch it on", () => {
    expect(offMessage("F18")).toBe("Open terminal is switched off. Tick it in the Console's Setup, under Features, to use it.");
  });
});

describe("a gated control in the browser", () => {
  const Probe = () => createElement("span", null, useFeatureOff("F21") ? "hidden" : "shown");
  it("renders nothing of itself when its id is in the list the server sent, and shows by default", () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain("shown");
    expect(renderToStaticMarkup(createElement(PicksOffContext.Provider, { value: ["F21"] }, createElement(Probe)))).toContain("hidden");
    expect(renderToStaticMarkup(createElement(PicksOffContext.Provider, { value: ["F22"] }, createElement(Probe)))).toContain("shown");
  });
});

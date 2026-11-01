// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { linkChanges } from "../host-delivery";
import { parseChangeSet } from "../review-tour";
import { TourCheck } from "../src/delivery";

afterEach(cleanup);
const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");
const changes = linkChanges(parseChangeSet(diff), "https://github.com/a/b/pull/1", "github");
const status = (view: ReturnType<typeof render>) =>
  view.container.querySelector('[role="status"]')?.textContent ?? "";

describe("tour check panel", () => {
  it("names the file a pasted tour leaves out", () => {
    const view = render(<TourCheck changes={changes} />);
    expect(status(view)).toBe("");
    fireEvent.change(view.getByLabelText("Tour to check"), { target: { value: "Stop 1: src/a.ts" } });
    expect(status(view)).toContain("1 of 2 changed files placed");
    expect(status(view)).toContain("src/b.ts");
  });
  it("reports a tour that covers everything with real links", () => {
    const view = render(<TourCheck changes={changes} />);
    fireEvent.change(view.getByLabelText("Tour to check"), {
      target: { value: `src/a.ts ${changes[0].hunks[0].link}\nsrc/b.ts` },
    });
    expect(status(view)).toContain("2 of 2 changed files placed; every hunk link is real.");
  });
});

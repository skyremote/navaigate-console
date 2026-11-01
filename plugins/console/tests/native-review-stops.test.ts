import { describe, expect, it } from "vitest";
import { linkChanges } from "../host-delivery";
import { parseChangeSet, splitStops } from "../review-tour";

const diff = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,4 @@", " x", "+y", " z",
  "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1 +1 @@", "-a", "+b", "",
].join("\n");
const changes = linkChanges(parseChangeSet(diff), "https://github.com/a/b/pull/1", "github");

describe("splitStops", () => {
  it("cuts a returned tour into numbered stops and attaches the changed files each names", () => {
    const answer = `Tour\n\n## Stop 1: Rail sort\nTouches src/a.ts and the order.\n\n## Stop 2: Receipt\nsrc/b.ts holds the new view.\n\nCoverage\n- F1 src/a.ts -> Stop 1`;
    const stops = splitStops(changes, answer);
    expect(stops.map((s) => s.title)).toEqual(["Rail sort", "Receipt"]);
    expect(stops[0].files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(stops[1].files.map((f) => f.path)).toEqual(["src/b.ts"]);
    expect(stops[0].files[0].hunks[0].link).toBe(changes[0].hunks[0].link);
  });

  it("links a stop to the exact hunk its excerpt cites", () => {
    const hunk = changes[0].hunks[0].link!;
    const stops = splitStops(changes, `1. First change\nsrc/a.ts ${hunk}\n2. Second\nsrc/b.ts`);
    expect(stops[0].links).toEqual([{ link: hunk, path: "src/a.ts", real: true }]);
  });

  it("marks a cited link that matches no hunk and keeps text before the first stop out of the stops", () => {
    const stops = splitStops(changes, `Intro text\nStop 1: One\nsrc/a.ts https://github.com/a/b/pull/1/files#diff-deadbeef`);
    expect(stops).toHaveLength(1);
    expect(stops[0].links[0]).toMatchObject({ real: false, path: null });
  });

  it("returns no stops for a tour without numbered stops", () => {
    expect(splitStops(changes, "just a paragraph about src/a.ts")).toEqual([]);
  });
});

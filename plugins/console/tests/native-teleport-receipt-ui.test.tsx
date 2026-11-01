// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TeleportReceipt, teleportReceiptLines } from "../src/composer-chips";

afterEach(cleanup);
const SHA = "59b6272aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = { newThreadId: "thr_m1", via: "machine", url: null, notes: [], commit: null, verified: null };

describe("the teleport receipt", () => {
  it("names the carried commit, its ref and Studio clone check, without repeating the push notes", () => {
    const lines = teleportReceiptLines({
      ...base, commit: { sha: SHA, ref: "teleport/thr_x", carried: true }, verified: { machine: "studio", ok: true, sha: SHA, message: "Studio's clone has 59b6272 on teleport/thr_x." },
      notes: [`Uncommitted work pushed as WIP commit ${SHA} on teleport/thr_x; main was not touched.`, "Studio's clone has 59b6272 on teleport/thr_x."],
    });
    expect(lines).toEqual([
      "Commit 59b6272 on teleport/thr_x, your uncommitted work carried as a WIP commit.",
      "Studio's clone has 59b6272 on teleport/thr_x.",
    ]);
  });
  it("gives the branch head for a clean move", () => {
    expect(teleportReceiptLines({ ...base, commit: { sha: SHA, ref: "main", carried: false }, verified: { machine: "studio", ok: true, sha: SHA, message: "Studio's clone has 59b6272 on main." }, notes: [`Pushed main at commit ${SHA}.`] }))
      .toEqual(["Commit 59b6272 on main.", "Studio's clone has 59b6272 on main."]);
  });
  it("says the clone was not checked when the chat went to Studio's own bb", () => {
    const lines = teleportReceiptLines({ ...base, via: "handoff", commit: { sha: SHA, ref: "main", carried: false } });
    expect(lines[0]).toMatch(/brief/);
    expect(lines).toContain("Studio's clone was not checked: the chat went to Studio's own bb.");
  });
  it("does not talk about a clone check on the way back", () => {
    expect(teleportReceiptLines({ ...base, notes: ["Studio's uncommitted work was pushed as a WIP commit on teleport/thr_x."] }, true)).toEqual(["Studio's uncommitted work was pushed as a WIP commit on teleport/thr_x."]);
  });
  it("renders each line", () => {
    const { getByTestId } = render(<TeleportReceipt lines={["Commit 59b6272 on main.", "Studio's clone has 59b6272 on main."]} />);
    expect(getByTestId("teleport-receipt").querySelectorAll("li")).toHaveLength(2);
  });
});

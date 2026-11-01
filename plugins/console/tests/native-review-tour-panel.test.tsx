// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { linkChanges } from "../host-delivery";
import { parseChangeSet } from "../review-tour";
import { ReviewTourPanel } from "../src/delivery-tour";

afterEach(cleanup);
const diff = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,4 @@", " x", "+y", " z", "@@ -40 +41 @@", "-q", "+r",
  "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1 +1 @@", "-a", "+b",
  "diff --git a/src/new.ts b/src/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1,2 @@", "+one", "+two", "",
].join("\n");
const changes = linkChanges(parseChangeSet(diff), "https://github.com/a/b/pull/1", "github");

describe("Review tour panel", () => {
  it("makes one stop per changed file, each hunk a link to that hunk on the PR page", () => {
    const view = render(<ReviewTourPanel changes={changes} />);
    const stops = view.getAllByRole("listitem", { name: /^Stop \d/ });
    expect(stops).toHaveLength(3);
    const first = within(stops[0]);
    const links = first.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe(changes[0].hunks[0].link);
    expect(links[0].textContent).toContain("new lines 10-13");
    expect(stops[2].textContent).toContain("New file");
  });

  it("counts coverage as stops are ticked and finds the next unread stop", () => {
    const view = render(<ReviewTourPanel changes={changes} />);
    expect(view.getByText("0 of 3 files reviewed")).toBeTruthy();
    fireEvent.click(view.getByLabelText("Mark src/a.ts reviewed"));
    expect(view.getByText("1 of 3 files reviewed")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Next unreviewed stop" }));
    expect(view.getByRole("listitem", { name: /Stop 2/ }).getAttribute("data-current")).toBe("true");
    fireEvent.click(view.getByLabelText("Mark src/b.ts reviewed"));
    fireEvent.click(view.getByLabelText("Mark src/new.ts reviewed"));
    expect(view.getByText("3 of 3 files reviewed")).toBeTruthy();
    expect(view.getByText(/Every changed file has been reviewed/)).toBeTruthy();
  });

  it("shows a returned tour as stops linked to hunks and names any file the tour skipped", () => {
    const view = render(<ReviewTourPanel changes={changes} />);
    fireEvent.change(view.getByLabelText("Tour to check"), {
      target: { value: `Stop 1: Order\nsrc/a.ts ${changes[0].hunks[0].link}\nStop 2: Views\nsrc/b.ts` },
    });
    const returned = view.getByLabelText("Returned tour");
    expect(within(returned).getAllByRole("listitem", { name: /^Returned stop/ })).toHaveLength(2);
    const status = view.getByRole("status").textContent!;
    expect(status).toContain("Missing from the tour");
    expect(status).toContain("src/new.ts");
  });

  it("explains an empty change set", () => {
    const view = render(<ReviewTourPanel changes={[]} />);
    expect(view.getByText(/No changed files were read/)).toBeTruthy();
  });
});

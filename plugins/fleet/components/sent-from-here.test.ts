import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findAll, textOf } from "../lib/element-tree";
import type { SentRow } from "../lib/sent-receipts";
import { SentFromHereView } from "./sent-from-here";

const rows: SentRow[] = [
  { key: "receipt:tell-ui-0000001", kind: "tell", machine: "studio", title: null, threadId: "thr_c", url: "https://studio/t/thr_c", at: 3_000, status: "delivered", canRead: false, readId: "tell-ui-0000001" },
  { key: "receipt:job-ui-ask-0001", kind: "ask", machine: "studio", title: null, threadId: "thr_a", url: "https://studio/t/thr_a", at: 2_000, status: "started", canRead: true, readId: "job-ui-ask-0001" },
  { key: "command:cmd-12345678", kind: "start", machine: "work", title: "Check the build", threadId: null, url: null, at: 1_000, status: "waiting for machine", canRead: false, readId: "cmd-12345678" },
];
const noop = () => undefined;
const props = { rows, results: {}, lookup: "", lookupResult: null, now: 10_000, onLookup: noop, onLookupChange: noop, onRead: noop, onOpen: noop };

describe("SentFromHereView", () => {
  it("lists each receipt with its kind, machine and status", () => {
    const html = renderToStaticMarkup(createElement(SentFromHereView, props));
    expect(html).toContain("Sent from here");
    expect(html).toContain("Tell studio");
    expect(html).toContain("Ask studio");
    expect(html).toContain("To work: Check the build");
    expect(html).toContain("delivered");
    expect(html).toContain("waiting for machine");
  });

  it("offers Read answer only where an answer can exist and shows the receipt id", () => {
    const buttons = findAll(createElement(SentFromHereView, props), (el) => el.type === "button" && textOf(el) === "Read answer");
    expect(buttons).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(SentFromHereView, props))).toContain("job-ui-ask-0001");
  });

  it("reads the chosen row and opens its thread", () => {
    const onRead = vi.fn();
    const onOpen = vi.fn();
    const tree = createElement(SentFromHereView, { ...props, onRead, onOpen });
    (findAll(tree, (el) => el.type === "button" && textOf(el) === "Read answer")[0]!.props.onClick as () => void)();
    expect(onRead).toHaveBeenCalledWith(rows[1]);
    (findAll(tree, (el) => el.type === "button" && textOf(el) === "Open")[0]!.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith("https://studio/t/thr_c");
  });

  it("shows a pending, ready or failed read under the row", () => {
    const html = renderToStaticMarkup(createElement(SentFromHereView, { ...props, results: {
      "job-ui-ask-0001": { state: "ready", message: null, answer: { output: "Nonce X confirmed", truncated: false, state: "idle" } },
    } }));
    expect(html).toContain("Nonce X confirmed");
    const pending = renderToStaticMarkup(createElement(SentFromHereView, { ...props, results: { "job-ui-ask-0001": { state: "pending", message: "No answer from studio yet", answer: null } } }));
    expect(pending).toContain("Still working");
    expect(pending).toContain("No answer from studio yet");
    const failed = renderToStaticMarkup(createElement(SentFromHereView, { ...props, results: { "job-ui-ask-0001": { state: "failed", message: "No fleet command", answer: null } } }));
    expect(failed).toContain("No fleet command");
  });

  it("re-reads a receipt typed in by id, refusing an id the server would reject", () => {
    const onLookup = vi.fn();
    const ok = createElement(SentFromHereView, { ...props, lookup: "job-ui-ask-0001", onLookup });
    const read = findAll(ok, (el) => el.type === "button" && textOf(el) === "Read result")[0]!;
    expect(read.props.disabled).toBe(false);
    (read.props.onClick as () => void)();
    expect(onLookup).toHaveBeenCalledOnce();
    const bad = createElement(SentFromHereView, { ...props, lookup: "nope" });
    expect(findAll(bad, (el) => el.type === "button" && textOf(el) === "Read result")[0]!.props.disabled).toBe(true);
  });

  it("shows the result of an id lookup", () => {
    const html = renderToStaticMarkup(createElement(SentFromHereView, { ...props, lookup: "job-ui-ask-0001", lookupResult: { state: "ready", message: null, answer: { output: "same receipt again", truncated: false, state: "idle" } } }));
    expect(html).toContain("same receipt again");
  });

  it("says when nothing has been sent from this Mac", () => {
    expect(renderToStaticMarkup(createElement(SentFromHereView, { ...props, rows: [] }))).toContain("Nothing sent from this Mac yet");
  });
});

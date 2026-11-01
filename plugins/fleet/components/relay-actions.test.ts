import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findAll } from "../lib/element-tree";
import { RelayActionsView } from "./relay-actions";

const base = { machine: "studio", threadTitle: "Fix the deploy", draft: "", busy: false, status: null, answer: null, onDraft: () => undefined, onSubmit: () => undefined, onReadAnswer: () => undefined };

describe("RelayActionsView", () => {
  it("offers Tell and Read answer for a thread and names the machine", () => {
    const html = renderToStaticMarkup(createElement(RelayActionsView, { ...base, mode: "tell" }));
    expect(html).toContain("Tell studio about Fix the deploy");
    expect(html).toContain(">Send to studio<");
    expect(html).toContain("Read latest answer");
  });

  it("offers Ask without a thread and has no Read answer button", () => {
    const html = renderToStaticMarkup(createElement(RelayActionsView, { ...base, mode: "ask", threadTitle: null }));
    expect(html).toContain("Ask studio");
    expect(html).not.toContain("Read latest answer");
  });

  it("keeps Send disabled until there is text and while a send is in flight", () => {
    const disabled = (draft: string, busy: boolean) => findAll(createElement(RelayActionsView, { ...base, mode: "tell", draft, busy }), (el) => el.type === "button" && /^Send/.test(String(el.props.children ?? "")))[0]!.props.disabled;
    expect(disabled("", false)).toBe(true);
    expect(disabled("   ", false)).toBe(true);
    expect(disabled("do it", false)).toBe(false);
    expect(disabled("do it", true)).toBe(true);
  });

  it("sends on the button and on Cmd+Enter", () => {
    const onSubmit = vi.fn();
    const tree = createElement(RelayActionsView, { ...base, mode: "tell", draft: "go", onSubmit });
    (findAll(tree, (el) => el.type === "button" && /^Send/.test(String(el.props.children ?? "")))[0]!.props.onClick as () => void)();
    const area = findAll(tree, (el) => el.type === "textarea")[0]!;
    (area.props.onKeyDown as (event: { key: string; metaKey: boolean; ctrlKey: boolean }) => void)({ key: "Enter", metaKey: true, ctrlKey: false });
    (area.props.onKeyDown as (event: { key: string; metaKey: boolean; ctrlKey: boolean }) => void)({ key: "Enter", metaKey: false, ctrlKey: false });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("shows the receipt status and the answer text", () => {
    const html = renderToStaticMarkup(createElement(RelayActionsView, { ...base, mode: "tell", status: { tone: "ok", text: "Delivered to studio" }, answer: { text: "Nonce X confirmed", state: "idle", truncated: false } }));
    expect(html).toContain("Delivered to studio");
    expect(html).toContain("Nonce X confirmed");
  });

  it("flags a cut answer", () => {
    const html = renderToStaticMarkup(createElement(RelayActionsView, { ...base, mode: "tell", answer: { text: "long", state: "idle", truncated: true } }));
    expect(html).toContain("cut to 64 KB");
  });
});

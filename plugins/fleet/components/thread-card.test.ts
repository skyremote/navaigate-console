import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findAll, textOf } from "../lib/element-tree";
import { ThreadCard, accountTitle } from "./thread-card";

const thread = { id: "thr_1", title: "Fix the build", state: "running" as const, projectName: "NavAIgate" };
const props = { thread, via: null, age: "2m ago", onOpen: () => undefined };
const account = { label: "sam", email: "sam@example.com", harness: "claude" as const };

describe("ThreadCard account (F03)", () => {
  it("shows the account the chat runs on, with the email on hover", () => {
    const html = renderToStaticMarkup(createElement(ThreadCard, { ...props, thread: { ...thread, account } }));
    expect(html).toContain('data-nav-part="account"');
    expect(html).toContain(">sam<");
    expect(html).toContain("Runs on the sam@example.com account");
  });

  it("falls back to the label when the email is not known", () => {
    expect(accountTitle({ label: "NavAIgate", email: null, harness: "codex" })).toBe("Runs on the NavAIgate account");
  });

  it("shows nothing for a chat with no known account", () => {
    expect(renderToStaticMarkup(createElement(ThreadCard, props))).not.toContain("data-nav-part=\"account\"");
  });

  it("uses no colour for the tag, only the neutral border and muted text", () => {
    const [tag] = findAll(createElement(ThreadCard, { ...props, thread: { ...thread, account } }), (el) => el.props["data-nav-part"] === "account");
    expect(tag?.props.className).toBe("fleet-acct");
    expect(tag?.props.style).toBeUndefined();
  });

  it("names the server a chat came through, and its age", () => {
    const html = renderToStaticMarkup(createElement(ThreadCard, { ...props, via: "studio-srv" }));
    expect(html).toContain("via studio-srv · 2m ago");
    expect(renderToStaticMarkup(createElement(ThreadCard, props))).not.toContain("via ");
  });

  it("still opens the chat when the card is pressed", () => {
    const onOpen = vi.fn();
    const [button] = findAll(createElement(ThreadCard, { ...props, onOpen, thread: { ...thread, account } }), (el) => el.type === "button");
    (button!.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "thr_1" }));
    expect(textOf(button)).toContain("Fix the build");
  });
});

import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findAll } from "../lib/element-tree";
import { AppUpdateButton, ChannelSelect, PinControl } from "./channel-controls";

describe("ChannelSelect", () => {
  it("shows the machine's current channel and lists stable and nightly", () => {
    const html = renderToStaticMarkup(createElement(ChannelSelect, { machine: "studio", channel: "nightly", busy: false, onChange: () => undefined }));
    expect(html).toContain('aria-label="Release channel for studio"');
    expect(html).toContain("Nightly (test host)");
    expect(html).toContain("Stable");
    expect(html).toMatch(/<option value="nightly" selected/);
  });

  it("reports the chosen channel and is disabled while a change is saving", () => {
    const onChange = vi.fn();
    const select = findAll(createElement(ChannelSelect, { machine: "laptop", channel: "stable", busy: false, onChange }), (el) => el.type === "select")[0]!;
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "nightly" } });
    expect(onChange).toHaveBeenCalledWith("laptop", "nightly");
    const busy = findAll(createElement(ChannelSelect, { machine: "laptop", channel: "stable", busy: true, onChange }), (el) => el.type === "select")[0]!;
    expect(busy.props.disabled).toBe(true);
  });
});

describe("ChannelSelect without a route", () => {
  it("does not let a machine with no authenticated route become the nightly test host", () => {
    const html = renderToStaticMarkup(createElement(ChannelSelect, { machine: "work", channel: "stable", busy: false, nightlyDisabled: true, onChange: () => undefined }));
    expect(html).toMatch(/<option value="nightly" disabled/);
    expect(html).toContain("Nightly (needs a route)");
  });

  it("keeps Nightly available when the machine is reachable", () => {
    const html = renderToStaticMarkup(createElement(ChannelSelect, { machine: "studio", channel: "stable", busy: false, onChange: () => undefined }));
    expect(html).not.toMatch(/<option value="nightly" disabled/);
  });
});

describe("PinControl", () => {
  it("shows the pinned version and a clear button only when one is pinned", () => {
    const pinned = renderToStaticMarkup(createElement(PinControl, { pinned: "0.48.1", busy: false, onSave: () => undefined }));
    expect(pinned).toContain("Pinned: 0.48.1");
    expect(pinned).toContain("Clear pin");
    const none = renderToStaticMarkup(createElement(PinControl, { pinned: null, busy: false, onSave: () => undefined }));
    expect(none).toContain("Pinned: none");
    expect(none).not.toContain("Clear pin");
  });

  it("rejects a pin that is not an exact version before anything is saved", () => {
    const initial = createElement(PinControl, { pinned: null, busy: false, onSave: vi.fn(), initialDraft: "latest" });
    const html = renderToStaticMarkup(initial);
    expect(html).toContain("Use an exact version such as 0.48.1");
  });
});

describe("AppUpdateButton", () => {
  const props = { available: "0.49.0", busy: false, helperSupported: true, helperReason: null, onUpdate: () => undefined };

  it("is enabled when the channel and the pin allow the update", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateButton, { ...props, gate: null }));
    expect(html).toContain("Update to 0.49.0");
    expect(html).not.toContain("disabled");
  });

  it("is held with the reason shown when a stable machine has to wait for the nightly host", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateButton, { ...props, gate: "Waits for studio to run 0.49.0 (it runs 0.48.0)" }));
    expect(html).toMatch(/<button[^>]* disabled/);
    expect(html).toContain("Waits for studio to run 0.49.0 (it runs 0.48.0)");
  });

  it("stays held for a host that cannot relay updates, with the helper's reason as the tooltip", () => {
    const html = renderToStaticMarkup(createElement(AppUpdateButton, { ...props, gate: null, helperSupported: false, helperReason: "bb is too old" }));
    expect(html).toMatch(/<button[^>]* disabled/);
    expect(html).toContain('title="bb is too old"');
  });

  it("keeps the button disabled when the version is not the pinned one", () => {
    const onUpdate = vi.fn();
    const button = findAll(createElement(AppUpdateButton, { ...props, gate: "Pinned to 0.48.1", onUpdate }), (el) => el.type === "button")[0]!;
    expect(button.props.disabled).toBe(true);
  });
});

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StartBox } from "./start-box";

const column = { key: "studio", label: "studio" };

describe("StartBox", () => {
  it("is a single button until opened", () => {
    const html = renderToStaticMarkup(createElement(StartBox, { column, reach: "brain" as const, onStart: async () => undefined }));
    expect(html).toContain("+ Start work on studio");
    expect(html).not.toContain("Ask studio and read the answer");
  });

  it("offers Start and Ask side by side once open", () => {
    const html = renderToStaticMarkup(createElement(StartBox, { column, reach: "brain" as const, onStart: async () => undefined, initialOpen: true, initialPrompt: "hostname" }));
    expect(html).toContain(">Start<");
    expect(html).toContain("Ask studio and read the answer");
    expect(html).not.toContain("disabled=\"\">Start");
  });

  it("says how the work travels: here, through the brain, or over SSH", () => {
    const hint = (reach: "here" | "brain" | "ssh") => renderToStaticMarkup(createElement(StartBox, { column, reach, onStart: async () => undefined, initialOpen: true }));
    expect(hint("here")).toContain("Starts here");
    expect(hint("brain")).toContain("Sent through the brain");
    expect(hint("ssh")).toContain("Sent over SSH");
  });

  it("keeps both buttons disabled while the prompt is empty", () => {
    const html = renderToStaticMarkup(createElement(StartBox, { column, reach: "brain" as const, onStart: async () => undefined, initialOpen: true }));
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});

describe("StartBox with Tell and Ask switched off", () => {
  it("keeps Start but offers no Ask", () => {
    const html = renderToStaticMarkup(createElement(StartBox, { column, reach: "brain" as const, onStart: async () => undefined, initialOpen: true, initialPrompt: "hostname", allowAsk: false }));
    expect(html).toContain(">Start<");
    expect(html).not.toContain("Ask studio and read the answer");
  });
});

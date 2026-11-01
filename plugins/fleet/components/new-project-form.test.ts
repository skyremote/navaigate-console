import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findAll, textOf } from "../lib/element-tree";
import { NewProjectFormView } from "./new-project-form";

const base = { machine: "studio", form: { name: "", path: "", remote: "" }, errors: {}, busy: false, outcome: null, projects: [], created: null, onChange: () => undefined, onCreate: () => undefined, onCheck: () => undefined };

describe("NewProjectFormView", () => {
  it("asks for a name, the checkout path on that Mac and an optional remote", () => {
    const html = renderToStaticMarkup(createElement(NewProjectFormView, base));
    expect(html).toContain("New project on studio");
    expect(html).toContain('aria-label="Project name"');
    expect(html).toContain('aria-label="Checkout path on studio"');
    expect(html).toContain('aria-label="Git remote (needed if the checkout has an origin)"');
    expect(html).toContain("existing Git checkout");
  });

  it("keeps Create disabled until the name and path are filled in, then creates", () => {
    const onCreate = vi.fn();
    const empty = createElement(NewProjectFormView, base);
    expect(findAll(empty, (el) => el.type === "button" && textOf(el) === "Create on studio")[0]!.props.disabled).toBe(true);
    const ready = createElement(NewProjectFormView, { ...base, form: { name: "demo", path: "/srv/demo", remote: "" }, onCreate });
    const button = findAll(ready, (el) => el.type === "button" && textOf(el) === "Create on studio")[0]!;
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("shows each field error beside its field", () => {
    const html = renderToStaticMarkup(createElement(NewProjectFormView, { ...base, errors: { path: "Use the full path of the Git checkout on that Mac, starting with /" } }));
    expect(html).toContain("starting with /");
  });

  it("shows the owner's receipt and offers Check again only while the outcome is unknown", () => {
    const unknown = createElement(NewProjectFormView, { ...base, outcome: { tone: "muted", text: "studio has not confirmed it. Check again before trying a second time.", settled: false, projectId: null } });
    expect(renderToStaticMarkup(unknown)).toContain("has not confirmed it");
    expect(findAll(unknown, (el) => el.type === "button" && textOf(el) === "Check again")).toHaveLength(1);
    const done = createElement(NewProjectFormView, { ...base, outcome: { tone: "ok", text: "Created demo on studio at /srv/demo.", settled: true, projectId: "proj_9" } });
    expect(findAll(done, (el) => el.type === "button" && textOf(el) === "Check again")).toHaveLength(0);
  });

  it("lists the projects on the machine and marks the new one", () => {
    const html = renderToStaticMarkup(createElement(NewProjectFormView, { ...base, projects: [{ id: "proj_1", name: "NavAIgate", path: "/a" }, { id: "proj_9", name: "demo", path: "/srv/demo" }], created: { id: "proj_9", name: "demo", path: "/srv/demo" } }));
    expect(html).toContain("/srv/demo");
    expect(html).toContain("new");
    expect(html).toContain("2 projects on studio");
  });
});

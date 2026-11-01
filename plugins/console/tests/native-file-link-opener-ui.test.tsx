// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { OutsideFileOpener } from "../src/outside-file-opener";
import type { FileResolveOutput } from "../server-file-resolve";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const Original = () => <div data-testid="original-preview">bb preview</div>;
const base: FileResolveOutput = { status: "in-workspace", realPath: null, via: null, tried: [], reason: null, kind: null, size: null, content: null, hostId: "host_1" };
const props = (path: string) => ({ path, source: { kind: "workspace" as const, threadId: "thr_1", environmentId: "env_1", projectId: "proj_1" }, Original });

function mount(result: FileResolveOutput | Error, path = "Email_to_Pat_Training_v4.md", navigate: Record<string, unknown> = {}) {
  const calls: { method: string; input: unknown }[] = [];
  const rpc = {
    file_link_resolve: (input: unknown) => { calls.push({ method: "resolve", input }); if (result instanceof Error) throw result; return result; },
    file_link_open: (input: unknown) => { calls.push({ method: "open", input }); return { ok: true, reason: null }; },
  };
  renderSlot({ component: OutsideFileOpener }, props(path), { rpc: rpc as never, ...navigate } as never);
  return calls;
}

describe("file panel for a chat file link", () => {
  it("hands a file inside the project straight back to bb's own preview", async () => {
    const calls = mount(base, "notes/inside.md");
    expect(await screen.findByTestId("original-preview")).toBeTruthy();
    expect(calls[0]).toMatchObject({ method: "resolve", input: { path: "notes/inside.md", source: { kind: "workspace", threadId: "thr_1", environmentId: "env_1" } } });
  });

  it("falls back to bb's own preview when the lookup itself fails", async () => {
    mount(new Error("plugin server down"));
    expect(await screen.findByTestId("original-preview")).toBeTruthy();
  });

  it("shows a file from another project folder with a card, an inline Markdown preview and both actions", async () => {
    const real = "/Volumes/Shared/00_NavAIgate_WIP/Customers/Clientco/Training_Catalogue/Email_to_Pat_Training_v4.md";
    const openFilePreview = vi.fn(() => true);
    const calls = mount({ ...base, status: "found", realPath: real, via: "project folder /Volumes/Shared", kind: "markdown", size: 40, content: "Hi Albert, the online sessions are added." }, undefined, { openFilePreview });
    expect(await screen.findByText("This file is outside this chat's project")).toBeTruthy();
    expect(screen.getByTestId("outside-file-path").textContent).toBe(real);
    expect(document.body.textContent).toContain("Hi Albert, the online sessions are added.");
    fireEvent.click(screen.getByRole("button", { name: "Open in Finder" }));
    await waitFor(() => expect(calls.some((c) => c.method === "open" && JSON.stringify(c.input) === JSON.stringify({ path: real, mode: "reveal" }))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    expect(openFilePreview).toHaveBeenCalledWith({ target: { kind: "host", hostId: "host_1", path: real }, location: null });
  });

  it("opens the file in its own app when the panel will not take the real path", async () => {
    const calls = mount({ ...base, status: "found", realPath: "/Volumes/Shared/10_Reports/report.pdf", via: "as written", kind: "binary", size: 9, content: null }, "report.pdf", { openFilePreview: () => false });
    fireEvent.click(await screen.findByRole("button", { name: "Open preview" }));
    await waitFor(() => expect(calls.some((c) => c.method === "open" && JSON.stringify(c.input) === JSON.stringify({ path: "/Volumes/Shared/10_Reports/report.pdf", mode: "open" }))).toBe(true));
    expect(document.body.textContent).toContain("No inline preview for this kind of file");
  });

  it("renders an HTML file in a sandbox with no scripts", async () => {
    mount({ ...base, status: "found", realPath: "/Volumes/Shared/a.html", via: "as written", kind: "html", size: 9, content: "<h1>SOW</h1><script>alert(1)</script>" }, "a.html");
    const frame = (await screen.findByTitle("File preview")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>SOW</h1>");
  });

  it("names the path it tried when the file is missing", async () => {
    mount({ ...base, status: "not-found", reason: "No file at gone.md was found. Tried 2 places.", tried: ["/Users/sam/Shared_Local/gone.md", "/Volumes/Shared/gone.md"] }, "gone.md");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("File not found");
    expect(alert.textContent).toContain("/Users/sam/Shared_Local/gone.md");
    expect(alert.textContent).toContain("/Volumes/Shared/gone.md");
  });

  it("leaves bb's own preview in charge when the workspace could not be checked or the link was refused", async () => {
    for (const status of ["unchecked", "refused"] as const) {
      cleanup();
      mount({ ...base, status, reason: "not checked" }, "README.md");
      expect(await screen.findByTestId("original-preview")).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    }
  });

  it("hands host files straight to bb without asking the server, so Open preview reaches bb's PDF and docx preview", async () => {
    const calls: unknown[] = [];
    renderSlot({ component: OutsideFileOpener }, { ...props("/Volumes/Shared/10_Reports/report.pdf"), source: { kind: "host" as const, threadId: "thr_1", environmentId: "env_1", projectId: null, experimental_hostId: "host_1" } }, { rpc: { file_link_resolve: (i: unknown) => { calls.push(i); return { ...base, status: "found", realPath: "/x.pdf" }; } } as never });
    expect(await screen.findByTestId("original-preview")).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(screen.queryByText("This file is outside this chat's project")).toBeNull();
  });

  it("leaves thread-storage files to bb without asking the server", async () => {
    const calls: unknown[] = [];
    renderSlot({ component: OutsideFileOpener }, { ...props("x.md"), source: { kind: "thread-storage" as const, threadId: "thr_1", environmentId: null, projectId: null } }, { rpc: { file_link_resolve: (i: unknown) => { calls.push(i); return base; } } as never });
    expect(await screen.findByTestId("original-preview")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("is registered for deliverable file types only", async () => {
    const captured = await loadPluginApp(() => import("../app"));
    const opener = captured.fileOpeners.find((item) => item.id === "outside-project-files");
    expect(opener?.extensions).toEqual(expect.arrayContaining(["md", "html", "pdf", "docx"]));
    expect(opener?.extensions).not.toContain("ts");
    expect(opener?.extensions).not.toContain("json");
  }, 60_000);
});

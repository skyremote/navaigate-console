import { describe, expect, it } from "vitest";
import { buildPrepareInput, describeReceipt, findCreated, validateProjectForm } from "./new-project";

const target = { serverId: "studio-srv", machineKey: "studio" as const, hostId: "host_studio", projectId: null, environmentId: null };

describe("validateProjectForm", () => {
  it("accepts a name and an absolute path, with the remote optional", () => {
    expect(validateProjectForm({ name: "demo", path: "/Users/tester/Documents/GitHub/demo", remote: "" })).toEqual({ ok: true, value: { name: "demo", path: "/Users/tester/Documents/GitHub/demo", remote: null } });
    expect(validateProjectForm({ name: " demo ", path: "/srv/demo", remote: "git@github.com:example-org/demo.git" })).toMatchObject({ ok: true, value: { remote: "git@github.com:example-org/demo.git" } });
  });

  it("names the field that is wrong", () => {
    expect(validateProjectForm({ name: "", path: "/srv/demo", remote: "" })).toEqual({ ok: false, errors: { name: "Give the project a name" } });
    expect(validateProjectForm({ name: "demo", path: "demo", remote: "" })).toEqual({ ok: false, errors: { path: "Use the full path of the Git checkout on that Mac, starting with /" } });
    expect(validateProjectForm({ name: "demo", path: "/srv/../etc", remote: "" })).toMatchObject({ ok: false, errors: { path: expect.any(String) } });
  });

  it("refuses a remote that carries a password", () => {
    expect(validateProjectForm({ name: "demo", path: "/srv/demo", remote: "https://user:secret@github.com/a/b.git" })).toEqual({ ok: false, errors: { remote: "Use a Git remote without a password, such as https://github.com/owner/repo.git" } });
  });
});

describe("buildPrepareInput", () => {
  it("builds a create_project request for the owner without an environment", () => {
    expect(buildPrepareInput(target, "00000000-0000-4000-8000-000000000004", { name: "demo", path: "/srv/demo", remote: "https://github.com/a/b.git" })).toEqual({
      target, requestId: "00000000-0000-4000-8000-000000000004", prepare: { mode: "create_project", path: "/srv/demo", name: "demo", expectedRemoteUrl: "https://github.com/a/b.git" },
    });
  });
});

describe("describeReceipt", () => {
  const base = { owner: target, requestId: "00000000-0000-4000-8000-000000000004", method: "project_prepare" as const, fingerprint: "a".repeat(64), updatedAt: 1, message: null as string | null };
  it("confirms a created project with its path", () => {
    expect(describeReceipt({ ...base, outcome: "applied", result: { projectId: "proj_9", path: "/srv/demo" } }, "studio", "demo")).toEqual({ tone: "ok", text: "Created demo on studio at /srv/demo.", settled: true, projectId: "proj_9" });
  });
  it("shows the owner's reason when it refuses", () => {
    expect(describeReceipt({ ...base, outcome: "refused", result: null, message: "Existing checkout origin/root does not match" }, "studio", "demo")).toEqual({ tone: "bad", text: "studio refused it: Existing checkout origin/root does not match", settled: true, projectId: null });
  });
  it("says the outcome is unknown and must be checked rather than repeated", () => {
    expect(describeReceipt({ ...base, outcome: "unknown", result: null, message: "Owner operation in progress; do not resend" }, "studio", "demo")).toMatchObject({ tone: "muted", settled: false, text: expect.stringContaining("Check again") });
  });
  it("says nothing was created when the machine cannot be reached", () => {
    expect(describeReceipt({ ...base, outcome: "unavailable", result: null, message: "no-authenticated-owner-route" }, "work", "demo")).toMatchObject({ tone: "bad", settled: true, text: "work was not reached, so nothing was created: no-authenticated-owner-route" });
  });
});

describe("findCreated", () => {
  it("finds the new project on the owner by id, falling back to its path", () => {
    const projects = [{ id: "proj_1", name: "NavAIgate", path: "/a" }, { id: "proj_9", name: "demo", path: "/srv/demo" }];
    expect(findCreated(projects, { projectId: "proj_9", path: null })).toEqual(projects[1]);
    expect(findCreated(projects, { projectId: null, path: "/srv/demo" })).toEqual(projects[1]);
    expect(findCreated(projects, { projectId: "proj_x", path: "/nope" })).toBeNull();
  });
});

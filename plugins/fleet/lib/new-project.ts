import { projectRemoteSchema, type OwnerProjectReceipt, type ProjectOwnerTarget } from "../owner/project-contract";

export interface ProjectForm { name: string; path: string; remote: string }
export interface ProjectValues { name: string; path: string; remote: string | null }
export type FormErrors = Partial<Record<keyof ProjectForm, string>>;

export function validateProjectForm(form: ProjectForm): { ok: true; value: ProjectValues } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const name = form.name.trim();
  const path = form.path.trim();
  const remote = form.remote.trim();
  if (name === "" || name.length > 150) errors.name = "Give the project a name";
  if (!path.startsWith("/") || path.length < 2 || /[\\\0\x00-\x1f\x7f]/.test(path)) errors.path = "Use the full path of the Git checkout on that Mac, starting with /";
  else if (path.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")) errors.path = "Use a path without .. or empty parts";
  if (remote !== "" && !projectRemoteSchema.safeParse(remote).success) errors.remote = "Use a Git remote without a password, such as https://github.com/owner/repo.git";
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: { name, path, remote: remote === "" ? null : remote } };
}

export function buildPrepareInput(target: ProjectOwnerTarget, requestId: string, values: ProjectValues) {
  return { target, requestId, prepare: { mode: "create_project" as const, path: values.path, name: values.name, expectedRemoteUrl: values.remote } };
}

export function describeReceipt(receipt: OwnerProjectReceipt, machine: string, name: string): { tone: "ok" | "bad" | "muted"; text: string; settled: boolean; projectId: string | null } {
  const result = (receipt.result ?? {}) as { projectId?: unknown; path?: unknown };
  const projectId = typeof result.projectId === "string" ? result.projectId : null;
  if (receipt.outcome === "applied") return { tone: "ok", text: `Created ${name} on ${machine}${typeof result.path === "string" ? ` at ${result.path}` : ""}.`, settled: true, projectId };
  if (receipt.outcome === "refused") return { tone: "bad", text: `${machine} refused it: ${receipt.message ?? "no reason given"}`, settled: true, projectId: null };
  if (receipt.outcome === "unavailable") return { tone: "bad", text: `${machine} was not reached, so nothing was created: ${receipt.message ?? "unavailable"}`, settled: true, projectId: null };
  return { tone: "muted", text: `${machine} has not confirmed it. Check again before trying a second time.${receipt.message ? ` (${receipt.message})` : ""}`, settled: false, projectId };
}

export function findCreated<T extends { id: string; path: string | null }>(projects: T[], created: { projectId: string | null; path: string | null }): T | null {
  return projects.find((project) => (created.projectId !== null && project.id === created.projectId) || (created.path !== null && project.path === created.path)) ?? null;
}

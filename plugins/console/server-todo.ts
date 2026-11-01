// To-do engine for NavAIgate Workspace, built ON bb's Tasks plugin.
//
//   Storage   bb Tasks (tracker projects, tasks, statuses, chat links). One
//             tracker project per bb project is created on first use and
//             remembered. Folder links live in this plugin's kv because Tasks
//             has no notion of disk folders.
//   Reads     straight from Tasks' SQLite file, read-only (one query instead of
//             one RPC per task). Writes always go through Tasks' own RPCs.
//   Signals   a background pass moves work on real chat activity:
//               a linked chat starts working  -> To do  becomes Doing
//               every linked chat has stopped -> Doing  becomes Check
//             Nothing is ever moved to Done automatically.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const TODO_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const todoItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.enum(TODO_STATUSES),
  priority: z.string(),
  projectName: z.string(),
  bbProjectId: z.string().nullable(),
  folderId: z.string().nullable(),
  threads: z.array(z.object({ threadId: z.string(), live: z.string(), updatedAt: z.string() })),
  position: z.number(),
  updatedAt: z.string(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

const linksSchema = z.record(z.string(), z.object({ folderId: z.string().nullable() }));
const projMapSchema = z.record(z.string(), z.string());

const anyOut = z.unknown();
const taskOut = z.object({ task: z.object({ id: z.string(), key: z.string() }).passthrough() }).passthrough();
const projectsOut = z.object({ projects: z.array(z.object({ id: z.string(), prefix: z.string(), linkedBbProjectId: z.string().nullable(), name: z.string() }).passthrough()) }).passthrough();
const projectOut = z.object({ project: z.object({ id: z.string() }).passthrough() }).passthrough();

function tasksDbPath(): string {
  const dataDir = process.env.BB_DATA_DIR || path.join(os.homedir(), ".bb");
  return path.join(dataDir, "plugins", "tasks", "data.db");
}

export function createTodoEngine(bb: BbPluginApi) {
  let db: Database.Database | null = null;
  const open = () => {
    if (db) return db;
    const f = tasksDbPath();
    if (!fs.existsSync(f)) return null;
    try {
      db = new Database(f, { readonly: true, fileMustExist: true });
    } catch (e) {
      bb.log.warn(`tasks db unavailable: ${String(e)}`);
      db = null;
    }
    return db;
  };
  bb.onDispose(() => {
    db?.close();
    db = null;
  });

  const call = <T>(method: string, input: unknown, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({ pluginId: "tasks", method, input: input as never, outputSchema });

  const getLinks = async () => linksSchema.catch({}).parse(await bb.storage.kv.get("todo-links"));
  const setLinks = (v: z.infer<typeof linksSchema>) => bb.storage.kv.set("todo-links", v);
  const getProjMap = async () => projMapSchema.catch({}).parse(await bb.storage.kv.get("todo-projects"));

  const changed = () => bb.realtime.publish("todo", { at: Date.now() });

  /** The tracker project used for this bb project, created on first use. */
  async function trackerFor(bbProjectId: string, bbProjectName: string): Promise<string> {
    const map = await getProjMap();
    const existing = map[bbProjectId];
    const { projects } = await call("listProjects", {}, projectsOut);
    if (existing && projects.some((p) => p.id === existing)) return existing;
    const taken = new Set(projects.map((p) => p.prefix));
    const letters = bbProjectName.toUpperCase().replace(/[^A-Z0-9]/g, "") || "WORK";
    const base = /^[A-Z]/.test(letters) ? letters.slice(0, 3) : `W${letters.slice(0, 2)}`;
    let prefix = base;
    for (let i = 2; taken.has(prefix); i++) prefix = `${base.slice(0, 3)}${i}`.slice(0, 10);
    const { project } = await call(
      "createProject",
      { name: `${bbProjectName} · to-do`, prefix, color: "amber", folderId: null, linkedBbProjectId: bbProjectId.startsWith("proj_") ? bbProjectId : null },
      projectOut,
    );
    map[bbProjectId] = project.id;
    await bb.storage.kv.set("todo-projects", map);
    return project.id;
  }

  async function list(): Promise<TodoItem[]> {
    const conn = open();
    if (!conn) return [];
    const links = await getLinks();
    const rows = conn
      .prepare(
        `SELECT t.id, t.number, t.title, t.status, t.priority, t.position, t.updated_at, p.prefix, p.name, p.linked_bb_project_id
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.parent_task_id IS NULL
            AND (t.status NOT IN ('done','canceled') OR t.updated_at > ?)
          ORDER BY t.position`,
      )
      .all(new Date(Date.now() - 14 * 864e5).toISOString()) as Array<{
      id: string; number: number; title: string; status: TodoStatus; priority: string; position: number; updated_at: string; prefix: string; name: string; linked_bb_project_id: string | null;
    }>;
    const threads = conn.prepare("SELECT task_id, thread_id, live_status, updated_at FROM task_threads").all() as Array<{ task_id: string; thread_id: string; live_status: string; updated_at: string }>;
    const byTask = new Map<string, Array<{ threadId: string; live: string; updatedAt: string }>>();
    for (const r of threads) {
      const list = byTask.get(r.task_id) ?? [];
      list.push({ threadId: r.thread_id, live: r.live_status, updatedAt: r.updated_at });
      byTask.set(r.task_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      key: `${r.prefix}-${r.number}`,
      title: r.title,
      status: r.status,
      priority: r.priority,
      projectName: r.name.replace(/ · to-do$/, ""),
      bbProjectId: r.linked_bb_project_id,
      folderId: links[r.id]?.folderId ?? null,
      threads: byTask.get(r.id) ?? [],
      position: r.position,
      updatedAt: r.updated_at,
    }));
  }

  async function add(input: { titles: string[]; bbProjectId: string; bbProjectName: string; folderId: string | null; threadId: string | null; status?: TodoStatus }) {
    const projectId = await trackerFor(input.bbProjectId, input.bbProjectName);
    const links = await getLinks();
    const created: string[] = [];
    for (const title of input.titles) {
      const { task } = await call("createTask", { projectId, title, status: input.status ?? "todo" }, taskOut);
      created.push(task.key);
      if (input.threadId) await call("taskThreadsAttach", { taskId: task.id, threadId: input.threadId }, anyOut).catch(() => undefined);
      if (input.folderId) links[task.id] = { folderId: input.folderId };
    }
    await setLinks(links);
    changed();
    return created;
  }

  async function setStatus(taskId: string, status: TodoStatus, author = "You") {
    await call("updateTask", { taskId, status, authorName: author }, anyOut);
    changed();
  }

  async function move(taskId: string, status: TodoStatus, beforeTaskId: string | null, afterTaskId: string | null) {
    await call("boardMove", { taskId, status, beforeTaskId, afterTaskId }, anyOut);
    changed();
  }

  async function rename(taskId: string, title: string) {
    await call("updateTask", { taskId, title }, anyOut);
    changed();
  }

  async function remove(taskId: string) {
    await call("deleteTask", { taskId }, anyOut);
    const links = await getLinks();
    delete links[taskId];
    await setLinks(links);
    changed();
  }

  async function linkThread(taskId: string, threadId: string, on: boolean) {
    await call(on ? "taskThreadsAttach" : "taskThreadsDetach", { taskId, threadId }, anyOut);
    changed();
  }

  async function linkFolder(taskId: string, folderId: string | null) {
    const links = await getLinks();
    if (folderId) links[taskId] = { folderId };
    else delete links[taskId];
    await setLinks(links);
    changed();
  }

  /** Real-signal pass: move work on chat activity, never to Done. */
  async function sync() {
    const items = await list();
    let moved = 0;
    for (const t of items) {
      if (t.threads.length === 0) continue;
      const busy = t.threads.some((x) => x.live === "working" || x.live === "starting");
      if (busy && (t.status === "backlog" || t.status === "todo")) {
        await call("updateTask", { taskId: t.id, status: "in_progress", authorName: "Workspace" }, anyOut).catch(() => undefined);
        moved++;
      } else if (
        !busy &&
        t.status === "in_progress" &&
        // only when a linked chat actually finished AFTER the task last moved,
        // so a card dragged to Doing by hand is left alone
        t.threads.some((x) => x.updatedAt > t.updatedAt) &&
        t.threads.every((x) => x.live === "idle" || x.live === "completed" || x.live === "failed")
      ) {
        await call("updateTask", { taskId: t.id, status: "in_review", authorName: "Workspace" }, anyOut).catch(() => undefined);
        moved++;
      }
    }
    if (moved) changed();
  }

  return { list, add, setStatus, move, rename, remove, linkThread, linkFolder, sync, trackerFor };
}

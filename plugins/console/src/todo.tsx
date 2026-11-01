// To-do: one list behind both the right-hand panel and the Board.
//   Panel  (thread side panel, ⌘⇧D)  scopes: This chat · This folder · Everything
//   Board  (nav page)                 To do · Doing · Check · Done, drag between
// Items live in bb Tasks; the server links them to chats and folders and moves
// them on real chat activity (a linked chat working -> Doing, finished -> Check).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import {
  experimental_Icon as Icon,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useAppPanel as useAppPanel,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { TodoItem, TodoStatus } from "../server-todo";
import { Lattice, caps, tnum } from "./shared";
import { TaskGlyph } from "./status-mark";
import { Menu, MenuItem, MenuSeparator, MenuSub } from "./menu";
import { folderOfThread, useFolders } from "./folders";

export type Column = "todo" | "doing" | "check" | "done";
export const COLUMNS: Array<{ id: Column; label: string; status: TodoStatus }> = [
  { id: "todo", label: "To do", status: "todo" },
  { id: "doing", label: "Doing", status: "in_progress" },
  { id: "check", label: "Check", status: "in_review" },
  { id: "done", label: "Done", status: "done" },
];

export function columnOf(t: TodoItem): Column {
  if (t.status === "in_progress") return "doing";
  if (t.status === "in_review") return "check";
  if (t.status === "done" || t.status === "canceled") return "done";
  return "todo";
}

const isLive = (t: TodoItem) => t.threads.some((x) => x.live === "working" || x.live === "starting");

const fail = (verb: string) => (e: unknown) => toast.error(`${verb} failed`, { description: e instanceof Error ? e.message : String(e) });

/* ------------------------------ data ------------------------------- */

export function useTodos() {
  const rpc = useRpc<typeof rpcContract>();
  const [items, setItems] = useState<TodoItem[]>([]);
  const [available, setAvailable] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("todo_list").then(
      (r) => {
        setItems(r.items);
        setAvailable(r.available);
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    const t = window.setInterval(() => document.visibilityState === "visible" && refetch(), 10_000);
    return () => window.clearInterval(t);
  }, [refetch]);
  useRealtime("todo", refetch);

  const optimistic = (id: string, patch: Partial<TodoItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  return {
    items,
    available,
    loaded,
    refetch,
    add: (input: { titles: string[]; bbProjectId: string; bbProjectName: string; folderId: string | null; threadId: string | null }) =>
      rpc.call("todo_add", input).then((r) => {
        refetch();
        return r.keys;
      }),
    setStatus: (id: string, status: TodoStatus) => {
      optimistic(id, { status });
      return rpc.call("todo_status", { taskId: id, status }).then(refetch, fail("Update"));
    },
    move: (id: string, status: TodoStatus, beforeTaskId: string | null, afterTaskId: string | null) => {
      optimistic(id, { status });
      return rpc.call("todo_move", { taskId: id, status, beforeTaskId, afterTaskId }).then(refetch, fail("Move"));
    },
    rename: (id: string, title: string) => {
      optimistic(id, { title });
      return rpc.call("todo_rename", { taskId: id, title }).then(refetch, fail("Rename"));
    },
    remove: (id: string) => {
      setItems((xs) => xs.filter((x) => x.id !== id));
      return rpc.call("todo_delete", { taskId: id }).then(refetch, fail("Delete"));
    },
    linkThread: (id: string, threadId: string, on: boolean) => rpc.call("todo_link_thread", { taskId: id, threadId, on }).then(refetch, fail("Link")),
    linkFolder: (id: string, folderId: string | null) => rpc.call("todo_link_folder", { taskId: id, folderId }).then(refetch, fail("Link")),
  };
}
type Todos = ReturnType<typeof useTodos>;

/** Folder of every thread (hand placement, then working folder), for "This folder" and badges. */
export function useThreadFolders() {
  const { threads, projects } = useSidebarThreads();
  const folders = useFolders(threads.length);
  return useMemo(() => {
    const data = folders.available ? folders.data : null;
    const ids = new Set((data?.folders ?? []).map((f) => f.id));
    const folderOf = new Map<string, string | null>();
    for (const t of threads) folderOf.set(t.id, data ? folderOfThread(data, ids, t.id, t.environment?.id ?? null) : null);
    const folderName = new Map((data?.folders ?? []).map((f) => [f.id, f.name]));
    const threadById = new Map(threads.map((t) => [t.id, t]));
    const projectName = new Map(projects.map((p) => [p.id, p.isPersonal ? "Personal" : p.name]));
    return { folderOf, folderName, threadById, projectName, projects };
  }, [threads, projects, folders.available, folders.data]);
}

/** The folder an item belongs to: its own link, else the folder of a linked chat. */
export function itemFolder(t: TodoItem, folderOf: Map<string, string | null>): string | null {
  if (t.folderId) return t.folderId;
  for (const x of t.threads) {
    const f = folderOf.get(x.threadId);
    if (f) return f;
  }
  return null;
}

/* ------------------------------ glyph ------------------------------ */

function Glyph({ t, onToggle }: { t: TodoItem; onToggle?: () => void }) {
  const col = columnOf(t);
  const mark =
    col === "doing" || (col !== "done" && isLive(t)) ? (
      <span className="inline-flex size-3.5 items-center justify-center"><Lattice cell={3} gap={1.2} label="Being worked on" /></span>
    ) : (
      <TaskGlyph kind={t.status === "canceled" ? "dropped" : col === "done" ? "done" : col === "check" ? "check" : "todo"} size={14} />
    );
  if (!onToggle) return mark;
  return (
    <button
      type="button"
      title={col === "done" ? "Mark as not done" : "Mark as done"}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
      className="-m-[5px] inline-flex shrink-0 rounded-full p-[5px] transition-transform active:scale-[.97]"
    >
      {mark}
    </button>
  );
}

/* ------------------------------ row -------------------------------- */

function TodoRow({ t, todos, ctx, compact }: {
  t: TodoItem;
  todos: Todos;
  ctx: ReturnType<typeof useThreadFolders> & { threadId?: string | null; folderId?: string | null };
  compact?: boolean;
}) {
  const nav = useBbNavigate();
  const [editing, setEditing] = useState(false);
  const done = columnOf(t) === "done";
  const chat = t.threads.map((x) => ctx.threadById.get(x.threadId)).find(Boolean) as PluginSidebarThread | undefined;
  const folderId = itemFolder(t, ctx.folderOf);
  const folder = folderId ? ctx.folderName.get(folderId) : undefined;
  const linkedHere = ctx.threadId ? t.threads.some((x) => x.threadId === ctx.threadId) : false;

  const body = (
    <div
      className={cn(
        "group flex min-h-[34px] items-start gap-2.5 rounded-md px-2 py-[7px] text-[13px] hover:bg-[var(--state-hover)] data-[state=open]:bg-accent",
        done && "text-muted-foreground",
      )}
    >
      <span className="pt-[1px]"><Glyph t={t} onToggle={() => void todos.setStatus(t.id, done ? "todo" : "done")} /></span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            defaultValue={t.title}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = e.currentTarget.value.trim();
                setEditing(false);
                if (v && v !== t.title) void todos.rename(t.id, v);
              } else if (e.key === "Escape") setEditing(false);
            }}
            className="h-6 w-full rounded border border-ring bg-background px-1.5 text-[13px] text-foreground outline-none"
          />
        ) : (
          <span onDoubleClick={() => setEditing(true)} className={cn("block leading-[1.35]", done && "line-through decoration-muted-foreground/50")}>
            {t.title}
          </span>
        )}
        {!compact && (chat || folder) ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {chat ? (
              <button type="button" onClick={() => nav.toThread(chat.id)} className="inline-flex max-w-[180px] items-center gap-1 truncate hover:text-foreground hover:underline" title={`Open ${chat.displayTitle}`}>
                <Icon name="MessageCirclePlus" className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{chat.displayTitle}</span>
              </button>
            ) : null}
            {folder ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="Folder" className="size-3 text-muted-foreground" />
                {folder}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <span className="pt-0.5 font-mono text-[11px] text-muted-foreground" style={tnum}>{t.key}</span>
    </div>
  );

  return (
    <Menu trigger={body}>
      {COLUMNS.map((c) => (
        <MenuItem key={c.id} label={`Move to ${c.label}`} checked={columnOf(t) === c.id} onSelect={() => void todos.setStatus(t.id, c.status)} />
      ))}
      <MenuItem label="Drop it" icon="X" onSelect={() => void todos.setStatus(t.id, "canceled")} />
      <MenuSeparator />
      {ctx.threadId ? (
        <MenuItem icon="MessageCirclePlus" label={linkedHere ? "Unlink from this chat" : "Link to this chat"} onSelect={() => void todos.linkThread(t.id, ctx.threadId as string, !linkedHere)} />
      ) : null}
      {ctx.folderId ? (
        <MenuItem icon="Folder" label={t.folderId === ctx.folderId ? "Unlink from this folder" : "Link to this folder"} onSelect={() => void todos.linkFolder(t.id, t.folderId === ctx.folderId ? null : (ctx.folderId as string))} />
      ) : null}
      {t.threads.length > 0 ? (
        <MenuSub icon="ArrowUpRight" label="Open linked chat">
          {t.threads.map((x) => (
            <MenuItem key={x.threadId} label={ctx.threadById.get(x.threadId)?.displayTitle ?? x.threadId} onSelect={() => nav.toThread(x.threadId)} />
          ))}
        </MenuSub>
      ) : null}
      <MenuItem icon="Edit" label="Rename" onSelect={() => setEditing(true)} />
      <MenuItem icon="Copy" label="Copy key" hint={t.key} onSelect={() => void navigator.clipboard?.writeText(t.key)} />
      <MenuSeparator />
      <MenuItem icon="Trash2" label="Delete" danger onSelect={() => void todos.remove(t.id)} />
    </Menu>
  );
}

/* --------------------------- quick add ----------------------------- */

function QuickAdd({ onAdd, placeholder }: { onAdd: (titles: string[]) => Promise<unknown>; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const el = ref.current;
    if (!el) return;
    // One item per line; a pasted list ("- a", "1. b", "• c") is split and cleaned.
    const titles = el.value
      .split(/\n+/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[ ?\])\s*/, "").trim())
      .filter(Boolean);
    if (titles.length === 0) return;
    setBusy(true);
    try {
      await onAdd(titles);
      el.value = "";
      el.style.height = "";
    } catch (e) {
      fail("Add")(e);
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-2.5 py-2 focus-within:border-ring">
      <span className="pt-[3px]"><TaskGlyph kind="todo" size={14} /></span>
      <textarea
        ref={ref}
        rows={1}
        disabled={busy}
        placeholder={placeholder}
        onKeyDown={onKey}
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(140, el.scrollHeight)}px`;
        }}
        className="min-h-6 flex-1 resize-none bg-transparent text-[13px] leading-[1.45] text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/* ----------------------------- panel ------------------------------- */

type Scope = "chat" | "folder" | "all";

export function TodoPanel({ threadId }: { threadId: string }) {
  const todos = useTodos();
  const ctx = useThreadFolders();
  const thread = ctx.threadById.get(threadId);
  const folderId = ctx.folderOf.get(threadId) ?? null;
  const [scope, setScope] = useState<Scope>("chat");
  const [showDone, setShowDone] = useState(false);

  const scoped = todos.items.filter((t) => {
    if (scope === "chat") return t.threads.some((x) => x.threadId === threadId);
    if (scope === "folder") return folderId ? itemFolder(t, ctx.folderOf) === folderId : t.bbProjectId === thread?.projectId;
    return true;
  });
  const groups = (["doing", "check", "todo", "done"] as Column[]).map((c) => ({ c, list: scoped.filter((t) => columnOf(t) === c) }));
  const open = scoped.filter((t) => columnOf(t) !== "done").length;

  const add = (titles: string[]) => {
    if (!thread) return Promise.reject(new Error("Open a chat first"));
    return todos
      .add({
        titles,
        bbProjectId: thread.projectId,
        bbProjectName: ctx.projectName.get(thread.projectId) ?? "Personal",
        folderId: scope === "folder" ? folderId : null,
        threadId: scope === "chat" ? threadId : null,
      })
      .then((keys) => toast.success(`Added ${keys.join(", ")}`));
  };

  const ctxRow = { ...ctx, threadId, folderId };
  const label: Record<Column, string> = { doing: "Doing", check: "Check", todo: "To do", done: "Done" };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <div className="flex min-w-0 items-center gap-1 border-b border-border px-3 py-2">
        {(
          [
            ["chat", "This chat"],
            ["folder", folderId ? ctx.folderName.get(folderId) ?? "This folder" : ctx.projectName.get(thread?.projectId ?? "") ?? "This project"],
            ["all", "Everything"],
          ] as Array<[Scope, string]>
        ).map(([id, text]) => (
          <button
            key={id}
            type="button"
            aria-pressed={scope === id}
            onClick={() => setScope(id)}
            className={cn("h-7 max-w-[140px] truncate rounded-full px-2.5 text-[12px] transition-colors", scope === id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
          >
            {text}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground" style={tnum}>{open} open</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3">
        <QuickAdd onAdd={add} placeholder={scope === "chat" ? "Add to this chat, one per line" : scope === "folder" ? "Add to this folder" : "Add to the project"} />
        {!todos.available ? <p className="mt-3 text-[12px] text-destructive-text">bb Tasks is not running, so the list is unavailable.</p> : null}
        {todos.loaded && scoped.length === 0 ? (
          <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
            Nothing here yet. Type above, or just tell the agent "we've got this, this and this to do" and it will add them, linked to this chat.
          </p>
        ) : null}
        {groups.map(({ c, list }) =>
          list.length === 0 ? null : c === "done" ? (
            <div key={c} className="mt-4">
              <button type="button" onClick={() => setShowDone((v) => !v)} className={cn(caps, "flex w-full items-center gap-1.5 px-2 py-1")}>
                <Icon name="ChevronRight" className={cn("size-3 transition-transform", showDone && "rotate-90")} />
                Done
                <span className="ml-auto" style={tnum}>{list.length}</span>
              </button>
              {showDone ? list.map((t) => <TodoRow key={t.id} t={t} todos={todos} ctx={ctxRow} />) : null}
            </div>
          ) : (
            <div key={c} className="mt-4">
              <div className={cn(caps, "flex items-center px-2 py-1")}>
                {label[c]}
                <span className="ml-auto" style={tnum}>{list.length}</span>
              </div>
              {list.map((t) => <TodoRow key={t.id} t={t} todos={todos} ctx={ctxRow} />)}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/* ----------------------------- board ------------------------------- */

export function TodoBoard() {
  const todos = useTodos();
  const ctx = useThreadFolders();
  const [filter, setFilter] = useState<string>("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const projectsWithItems = [...new Set(todos.items.map((t) => t.projectName))];
  const visible = todos.items.filter((t) => filter === "all" || t.projectName === filter);
  const byCol = (c: Column) => visible.filter((t) => columnOf(t) === c);

  const defaultProject = ctx.projects.find((p) => !p.isPersonal && (filter === "all" || ctx.projectName.get(p.id) === filter)) ?? ctx.projects[0];

  const drop = (col: (typeof COLUMNS)[number], targetId: string | null) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData("application/x-nav-todo");
    const moving = todos.items.find((x) => x.id === id);
    if (!moving) return;
    // bb Tasks orders within one project + status, so neighbours must share both.
    const peers = todos.items
      .filter((x) => x.id !== id && x.projectName === moving.projectName && x.status === col.status)
      .sort((a, b) => a.position - b.position);
    const at = targetId ? peers.findIndex((x) => x.id === targetId) : -1;
    const above = at > 0 ? peers[at - 1].id : null;
    const below = at >= 0 ? peers[at].id : null;
    void todos.move(id, col.status, at >= 0 ? above : peers.at(-1)?.id ?? null, below);
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-auto">
      <div className="mx-auto box-border w-full max-w-[1280px] px-5 pb-8 pt-4">
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {["all", ...projectsWithItems].map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={filter === p}
              onClick={() => setFilter(p)}
              className={cn("h-7 rounded-full border px-2.5 text-[12px] transition-colors", filter === p ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground")}
            >
              {p === "all" ? "Everything" : p}
            </button>
          ))}
          <span className="ml-auto text-[12px] text-muted-foreground">Moves on its own: a linked chat working goes to Doing, finished goes to Check.</span>
        </div>
        <div className="grid min-w-[880px] grid-cols-4 gap-4">
          {COLUMNS.map((col) => {
            const list = byCol(col.id);
            return (
              <section
                key={col.id}
                onDragOver={(e) => { e.preventDefault(); setOver(col.id); }}
                onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
                onDrop={drop(col, null)}
                className={cn("flex min-h-[320px] flex-col rounded-xl border border-border bg-[var(--surface-recessed)] p-2.5 transition-colors", over === col.id && "border-ring")}
              >
                <header className={cn(caps, "mb-2 flex items-center gap-2 px-1.5")}>
                  {col.id === "doing" ? <Lattice cell={2.5} gap={1.2} /> : <TaskGlyph kind={col.id === "done" ? "done" : col.id === "check" ? "check" : "todo"} size={12} />}
                  {col.label}
                  <span className="ml-auto" style={tnum}>{list.length}</span>
                </header>
                {col.id === "todo" && defaultProject ? (
                  <div className="mb-2">
                    <QuickAdd
                      placeholder={`Add to ${ctx.projectName.get(defaultProject.id) ?? "project"}`}
                      onAdd={(titles) =>
                        todos
                          .add({ titles, bbProjectId: defaultProject.id, bbProjectName: ctx.projectName.get(defaultProject.id) ?? "Personal", folderId: null, threadId: null })
                          .then((keys) => toast.success(`Added ${keys.join(", ")}`))
                      }
                    />
                  </div>
                ) : null}
                <div className="flex flex-col gap-2">
                  {list.map((t) => (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/x-nav-todo", t.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragging(t.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                      onDrop={(e) => { e.stopPropagation(); drop(col, t.id)(e); }}
                      className={cn(
                        "cursor-grab rounded-lg border border-border bg-card shadow-sm transition-[transform,opacity] active:cursor-grabbing",
                        dragging === t.id && "rotate-[1.5deg] opacity-50",
                        isLive(t) && col.id !== "doing" && "ring-1 ring-[var(--attention)]",
                      )}
                    >
                      <TodoRow t={t} todos={todos} ctx={{ ...ctx, threadId: null, folderId: null }} />
                      <div className="flex items-center gap-2 border-t border-border/70 px-2.5 py-1.5 text-[12px] text-muted-foreground">
                        <span className="truncate">{t.projectName}</span>
                        {t.priority !== "none" ? <span className="ml-auto capitalize">{t.priority}</span> : null}
                      </div>
                    </div>
                  ))}
                  {list.length === 0 ? <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">{col.id === "check" ? "Finished work lands here for you to check" : col.id === "doing" ? "Chats at work show up here" : "Nothing here"}</p> : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------------- header button + badges --------------------- */

export function TodoHeaderButton({ threadId }: { threadId: string }) {
  const todos = useTodos();
  const panel = useAppPanel();
  const open = todos.items.filter((t) => columnOf(t) !== "done" && t.threads.some((x) => x.threadId === threadId)).length;
  return (
    <button
      type="button"
      title="To-do (⌘⇧D)"
      data-nav-part="header-action"
      onClick={() => panel.openTab({ tab: { id: "todo", context: { kind: "thread" }, availability: "action" }, title: "To-do" })}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <TaskGlyph kind="todo" size={14} />
      To-do
      {open > 0 ? <span data-nav-part="count" className="rounded-full bg-foreground px-1.5 text-[11px] font-medium text-background" style={tnum}>{open}</span> : null}
    </button>
  );
}

/** Open to-do count per folder (own links plus linked chats in that folder). */
export function useFolderTodoCounts(): Map<string, number> {
  const todos = useTodos();
  const ctx = useThreadFolders();
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const t of todos.items) {
      if (columnOf(t) === "done") continue;
      const f = itemFolder(t, ctx.folderOf);
      if (f) m.set(f, (m.get(f) ?? 0) + 1);
    }
    return m;
  }, [todos.items, ctx.folderOf]);
}

export function TodoBadge({ n }: { n: number }): ReactNode {
  if (!n) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={`${n} open to-do item${n === 1 ? "" : "s"}`} style={tnum}>
      <TaskGlyph kind="todo" size={11} />
      {n}
    </span>
  );
}

// Folders come from the project-folders plugin, which owns the real folders on
// disk (create, rename, move, AGENTS.md rules). This module reads its tree over
// bb's cross-plugin RPC and exposes the handful of mutations the rail uses.
// If project-folders is missing or fails, `available` is false and the rail
// falls back to plain project groups — the skin never breaks the sidebar.
import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { rpcFlight } from "./rpc-flight";
import { keepIfSame } from "./stable";
import { useVisiblePoll } from "./visible-poll";

const PF = "project-folders";

const folderSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    hostId: z.string(),
    parentId: z.string().nullable(),
    name: z.string(),
    path: z.string(),
    sort: z.number().optional(),
    kind: z.enum(["folder", "group"]).optional(),
  })
  .passthrough();

const listSchema = z
  .object({
    folders: z.array(folderSchema),
    roots: z.array(folderSchema),
    bindings: z.record(z.string(), z.string()),
    places: z.record(z.string(), z.string()),
  })
  .passthrough();

const itemStyleSchema = z.object({ icon: z.string().optional(), color: z.string().optional() }).passthrough();
const prefsSchema = z.object({ items: z.record(z.string(), itemStyleSchema) }).passthrough();
export type ItemStyle = z.infer<typeof itemStyleSchema>;
export type ItemStyles = Record<string, ItemStyle>;
/** The key project-folders stores a look under: p:<projectId> for a project, f:<folderId> for a folder. */
export const styleKey = (kind: "project" | "folder", id: string) => `${kind === "project" ? "p" : "f"}:${id}`;

/** One look with its icon replaced or removed; null when nothing is left to keep. */
export function withIcon(style: ItemStyle | undefined, icon: string | null): ItemStyle | null {
  const { icon: _old, ...rest } = style ?? {};
  const next = icon ? { ...rest, icon } : rest;
  return Object.keys(next).length > 0 ? next : null;
}

const okSchema = z.unknown();
const browseSchema = z
  .object({
    relative: z.string(),
    directories: z.array(z.object({ name: z.string(), relative: z.string() }).passthrough()),
  })
  .passthrough();

export type Folder = z.infer<typeof folderSchema>;
export type FolderData = z.infer<typeof listSchema>;
export type Directory = { name: string; relative: string };

/** The looks (icon, colour) project-folders keeps per project and folder, and the one write that changes an icon. */
export const STYLES_FLIGHT_KEY = `${PF}:prefs_get`;
export const FOLDERS_FLIGHT_KEY = `${PF}:list`;
const FOLDER_POLL_MS = 20_000;

export function useItemStyles(refreshKey: unknown = null, enabled = true) {
  const sdk = useSdk();
  const [styles, setStyles] = useState<ItemStyles>({});
  const refetchStyles = useCallback(
    (fresh = false) => {
      if (!enabled) return;
      rpcFlight()
        .call(
          STYLES_FLIGHT_KEY,
          () => sdk.plugins.callRpc({ pluginId: PF, method: "prefs_get", input: null, outputSchema: prefsSchema }),
          { ttlMs: FOLDER_POLL_MS / 2, fresh },
        )
        .then(
          (result) => setStyles((prev) => keepIfSame(prev, result.items)),
          () => {
            /* project-folders without preferences: the rail keeps its default marks */
          },
        );
    },
    [sdk, enabled],
  );
  useEffect(() => {
    refetchStyles();
  }, [refetchStyles, refreshKey]);
  useVisiblePoll(refetchStyles, enabled ? FOLDER_POLL_MS : null);
  const setIcon = useCallback(
    async (kind: "project" | "folder", id: string, icon: string | null) => {
      const key = styleKey(kind, id);
      const style = withIcon(styles[key], icon);
      await sdk.plugins.callRpc({ pluginId: PF, method: "item_style_save", input: { key, style } as never, outputSchema: okSchema });
      rpcFlight().invalidate(STYLES_FLIGHT_KEY);
      setStyles((cur) => {
        const next = { ...cur };
        if (style) next[key] = style;
        else delete next[key];
        return next;
      });
    },
    [sdk, styles],
  );
  return { styles, setIcon };
}

export function useFolders(refreshKey: unknown) {
  const sdk = useSdk();
  const itemStyles = useItemStyles(refreshKey);
  const [data, setData] = useState<FolderData | null>(null);
  const [available, setAvailable] = useState(true);

  const refetch = useCallback(
    (fresh = false) =>
      rpcFlight()
        .call(
          FOLDERS_FLIGHT_KEY,
          () => sdk.plugins.callRpc({ pluginId: PF, method: "list", input: null, outputSchema: listSchema }),
          { ttlMs: FOLDER_POLL_MS / 2, fresh },
        )
        .then(
          (result) => {
            setData((prev) => keepIfSame(prev, result));
            setAvailable(true);
          },
          () => setAvailable(false),
        ),
    [sdk],
  );

  useEffect(() => {
    void refetch();
  }, [refetch, refreshKey]);

  useVisiblePoll(() => void refetch(), FOLDER_POLL_MS);

  const call = useCallback(
    async (method: string, input: Record<string, unknown>) => {
      await sdk.plugins.callRpc({ pluginId: PF, method, input: input as never, outputSchema: okSchema });
      await refetch(true);
    },
    [sdk, refetch],
  );

  const browse = useCallback(
    async (projectId: string, folderId: string | null): Promise<Directory[]> => {
      const r = await sdk.plugins.callRpc({
        pluginId: PF,
        method: "browse",
        input: { projectId, folderId, relative: "" },
        outputSchema: browseSchema,
      });
      return r.directories.map((d) => ({ name: d.name, relative: d.relative }));
    },
    [sdk],
  );

  return {
    data,
    available: available && data !== null,
    ...itemStyles,
    refetch,
    browse,
    createFolder: (projectId: string, parentId: string | null, name: string, relativePath?: string) =>
      call("create", { projectId, folderId: parentId, name, relativePath: relativePath ?? slug(name) }),
    renameFolder: (projectId: string, folderId: string, name: string) => call("rename", { projectId, folderId, name }),
    reparentFolder: (folderId: string, parentId: string | null) => call("section_reparent", { folderId, parentId }),
    forgetFolder: (projectId: string, folderId: string) => call("forget", { projectId, folderId }),
    placeThread: (threadId: string, projectId: string, folderId: string | null) =>
      call("thread_place", { threadId, projectId, folderId }),
  };
}

/** A folder-safe name: keeps case and digits, turns runs of anything else into "_". */
export function slug(name: string): string {
  const s = name
    .trim()
    .replace(/[/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "");
  return s.length > 0 ? s.slice(0, 120) : "New_folder";
}

/** Which folder (if any) a thread is listed under: hand placement wins, then its working folder. */
export function folderOfThread(
  data: FolderData,
  folderIds: ReadonlySet<string>,
  threadId: string,
  environmentId: string | null,
): string | null {
  const placed = data.places[threadId];
  if (placed !== undefined) return placed && folderIds.has(placed) ? placed : null;
  const bound = environmentId ? data.bindings[environmentId] : undefined;
  return bound && folderIds.has(bound) ? bound : null;
}

/** Same-document navigation to another plugin's panel route without a full reload. */
export function goTo(url: string) {
  window.history.pushState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
}

/** project-folders' own "new chat in this section" route: its composer starts the chat in that folder. */
export function newChatInFolderUrl(projectId: string, folderId: string) {
  return `/plugins/${PF}/folders/chat/${encodeURIComponent(projectId)}/${encodeURIComponent(folderId)}`;
}

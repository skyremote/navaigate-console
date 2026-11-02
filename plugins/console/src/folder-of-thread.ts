// Which folder a chat sits in, from the project-folders `list` answer. Pure, so the
// rail (src/folders.ts) and the Stash sweep (server-attention.ts) share one rule and
// can never disagree about where a chat lives.

/** The parts of project-folders' `list` answer that place a chat. */
export type FolderPlacement = {
  /** Environment id to the folder its working directory belongs to. */
  bindings: Readonly<Record<string, string>>;
  /** Chats filed by hand: thread id to folder id, "" for the project root. */
  places: Readonly<Record<string, string>>;
};

/** Which folder (if any) a thread is listed under: hand placement wins, then its working folder. */
export function folderOfThread(
  data: FolderPlacement,
  folderIds: ReadonlySet<string>,
  threadId: string,
  environmentId: string | null,
): string | null {
  const placed = data.places[threadId];
  if (placed !== undefined) return placed && folderIds.has(placed) ? placed : null;
  const bound = environmentId ? data.bindings[environmentId] : undefined;
  return bound && folderIds.has(bound) ? bound : null;
}

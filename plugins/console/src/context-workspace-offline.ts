import { contextSaveInput, type ContextSave } from "./context-workspace-model";
export type LocalContextDraft = {
  id: string;
  savedAt: number;
  payload: ContextSave;
  files: Array<{ path: string; owner: string; bytes: Uint8Array }>;
  complete: boolean;
  kind: "checkpoint" | "outbox";
  staged?: ContextSave;
};
const STORE = "drafts";
function open(pluginId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`bb:${pluginId}:context-v1`, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Offline storage unavailable"));
  });
}
async function indexedDrafts(pluginId: string): Promise<LocalContextDraft[]> {
  const db = await open(pluginId);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE);
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () =>
        resolve(
          req.result.sort(
            (a: LocalContextDraft, b: LocalContextDraft) =>
              b.savedAt - a.savedAt,
          ),
        );
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
async function putIndexedDraft(
  pluginId: string,
  draft: LocalContextDraft,
): Promise<void> {
  const db = await open(pluginId);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"),
        store = tx.objectStore(STORE),
        request = store.getAll();
      request.onsuccess = () => {
        const rows = (request.result as LocalContextDraft[]).filter(
          (r) => r.id !== draft.id,
        );
        if (
          rows.length >= 100 ||
          rows.reduce(
            (n, r) => n + r.files.reduce((s, f) => s + f.bytes.byteLength, 0),
            draft.files.reduce((s, f) => s + f.bytes.byteLength, 0),
          ) >
            100 * 1024 * 1024
        ) {
          tx.abort();
          return;
        }
        const existing = (request.result as LocalContextDraft[]).find(
          (r) => r.id === draft.id,
        );
        if (!existing || existing.savedAt <= draft.savedAt) store.put(draft);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? new Error("Offline draft quota exceeded"));
    });
  } finally {
    db.close();
  }
}
async function removeIndexedDraft(pluginId: string, id: string): Promise<void> {
  const db = await open(pluginId);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export type NativeDeviceStorage = (
  input:
    | { operation: "list" }
    | { operation: "read" | "remove"; key: string }
    | { operation: "write"; key: string; value: string },
) => Promise<{
  supported: boolean;
  value?: string | null;
  entries?: Array<{ key: string; sizeBytes: number }>;
}>;
function base64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.slice(i, i + 8192));
  return btoa(text);
}
export function encodeDeviceDraft(draft: LocalContextDraft): string {
  return JSON.stringify({
    ...draft,
    files: draft.files.map((file) => ({
      path: file.path,
      owner: file.owner,
      base64: base64(file.bytes),
    })),
  });
}
export function decodeDeviceDraft(raw: string): LocalContextDraft {
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.savedAt !== "number" ||
    !Array.isArray(value.files) ||
    typeof value.complete !== "boolean" ||
    !["checkpoint", "outbox"].includes(value.kind)
  )
    throw new Error("Invalid device draft");
  const payload = contextSaveInput.parse(value.payload);
  return {
    ...value,
    payload,
    ...(value.staged ? { staged: contextSaveInput.parse(value.staged) } : {}),
    files: value.files.map(
      (file: { path: string; owner: string; base64: string }) => {
        if (
          typeof file.path !== "string" ||
          typeof file.owner !== "string" ||
          typeof file.base64 !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)
        )
          throw new Error("Invalid retained device bytes");
        return {
          path: file.path,
          owner: file.owner,
          bytes: Uint8Array.from(atob(file.base64), (char) =>
            char.charCodeAt(0),
          ),
        };
      },
    ),
  };
}
export function nativeStorageFor(
  composer: object,
): NativeDeviceStorage | undefined {
  const method = (
    composer as { experimental_deviceDraftStorage?: NativeDeviceStorage }
  ).experimental_deviceDraftStorage;
  return method ? method.bind(composer) : undefined;
}

export async function localDrafts(
  pluginId: string,
  native?: NativeDeviceStorage,
): Promise<LocalContextDraft[]> {
  let rows: LocalContextDraft[] = [];
  let indexedError: unknown;
  try {
    rows = await indexedDrafts(pluginId);
  } catch (e) {
    indexedError = e;
  }
  if (native) {
    const listing = await native({ operation: "list" });
    if (listing.supported) {
      const merged = new Map(rows.map((row) => [row.id, row]));
      for (const entry of listing.entries ?? []) {
        if (!entry.key.startsWith(`plugin:${pluginId}:`)) continue;
        const read = await native({ operation: "read", key: entry.key });
        if (!read.value) continue;
        try {
          const row = decodeDeviceDraft(read.value);
          const old = merged.get(row.id);
          if (!old || row.savedAt > old.savedAt) merged.set(row.id, row);
        } catch {
          continue;
        }
      }
      return [...merged.values()].sort((a, b) => b.savedAt - a.savedAt);
    }
  }
  if (indexedError) throw indexedError;
  return rows;
}
export async function putLocalDraft(
  pluginId: string,
  draft: LocalContextDraft,
  native?: NativeDeviceStorage,
): Promise<void> {
  if (native) {
    const saved = await native({
      operation: "write",
      key: `plugin:${pluginId}:${draft.id}`,
      value: encodeDeviceDraft(draft),
    });
    if (saved.supported) {
      await putIndexedDraft(pluginId, draft).catch(() => undefined);
      return;
    }
  }
  await putIndexedDraft(pluginId, draft);
}
export async function removeLocalDraft(
  pluginId: string,
  id: string,
  native?: NativeDeviceStorage,
): Promise<void> {
  if (native)
    await native({ operation: "remove", key: `plugin:${pluginId}:${id}` });
  await removeIndexedDraft(pluginId, id).catch(() => undefined);
}

export const attachmentOwner = (
  a: { hostId?: string; sourceProjectId?: string },
  projectId: string,
) =>
  a.hostId ? `host:${a.hostId}` : `project:${a.sourceProjectId ?? projectId}`;

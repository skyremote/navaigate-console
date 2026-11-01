import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const STORE = "usage-links:v1";

export const linkProvider = (key: string) => key.split(":")[0] ?? "";

export function linkGroupId(keys: readonly string[]): string {
  const sorted = [...new Set(keys)].sort();
  return `linked:${linkProvider(sorted[0] ?? "")}:${createHash("sha256").update(sorted.join("\0")).digest("hex").slice(0, 20)}`;
}

/** Subscriptions the owner has confirmed are the same account, stored as groups of reading keys. */
export function createUsageLinks(bb: BbPluginApi) {
  async function groups(): Promise<string[][]> {
    const raw = await bb.storage.kv.get<unknown>(STORE);
    return Array.isArray(raw) ? raw.filter((g): g is string[] => Array.isArray(g) && g.every((k) => typeof k === "string")) : [];
  }
  async function idFor(key: string): Promise<string | null> {
    const group = (await groups()).find((g) => g.includes(key));
    return group ? linkGroupId(group) : null;
  }
  async function link(keys: readonly string[]): Promise<string[][]> {
    const wanted = new Set(keys);
    const kept: string[][] = [];
    for (const g of await groups()) {
      if (g.some((k) => wanted.has(k))) g.forEach((k) => wanted.add(k));
      else kept.push(g);
    }
    const next = [...kept, [...wanted].sort()];
    await bb.storage.kv.set(STORE, next);
    return next;
  }
  async function unlink(keys: readonly string[]): Promise<string[][]> {
    const wanted = new Set(keys);
    const next = (await groups()).filter((g) => !g.some((k) => wanted.has(k)));
    await bb.storage.kv.set(STORE, next);
    return next;
  }
  return { groups, idFor, link, unlink };
}
export type UsageLinks = ReturnType<typeof createUsageLinks>;

export function createUsageLinkAction(deps: { links: UsageLinks; rows(): Promise<Array<{ key: string; machine: string }>>; changed(): Promise<void> }) {
  return async ({ keys, linked }: { keys: string[]; linked: boolean }): Promise<{ ok: true; groups: string[][] }> => {
    if (!linked) {
      const groups = await deps.links.unlink(keys);
      await deps.changed();
      return { ok: true, groups };
    }
    const rows = await deps.rows();
    const picked = keys.map((key) => rows.find((row) => row.key === key));
    if (picked.some((row) => !row)) throw new Error("Those readings are no longer listed. Refresh and try again.");
    if (new Set(keys.map(linkProvider)).size !== 1) throw new Error("Only readings from the same provider can be one subscription.");
    if (new Set(picked.map((row) => row!.machine)).size !== picked.length) throw new Error("Two accounts on one machine are two subscriptions, not one.");
    const groups = await deps.links.link(keys);
    await deps.changed();
    return { ok: true, groups };
  };
}

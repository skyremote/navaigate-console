// Parses what Claude Code's Artifact tool returns, so the gallery can show claude.ai artifacts.
//
// A "list" result looks like:
//   27 artifacts, published by you or shared with you (...):
//   - (mine, pinned) Garden planner — https://claude.ai/artifact/AbCdEf... — updated 2026-10-09
//   - (shared) Launch Plan — Second Draft — https://claude.ai/artifact/MnOpQr...
//   (More exist: pass `page_token` "..." with the same `scope` to list the next ones. ...)
// A "publish" result contains "Published <path> at https://claude.ai/artifact/<id> (Version 1, ...)".

export type ClaudeArtifact = {
  id: string;
  url: string;
  title: string;
  owner: "mine" | "shared";
  pinned: boolean;
  /** YYYY-MM-DD, when the tool reports it. */
  updated: string | null;
};

const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]+)/;
// Title is everything up to the " — https://claude.ai/..." part, so a title may itself contain " — ".
const LINE_RE = /^-\s+\((mine|shared)([^)]*)\)\s+(.+?)\s+—\s+(https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+)(?:\s+—\s+(.*))?\s*$/;

export function parseArtifactList(text: string): { items: ClaudeArtifact[]; total: number | null; more: boolean } {
  const items: ClaudeArtifact[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    const url = m[4];
    const id = URL_RE.exec(url)?.[1] ?? url;
    const tail = m[5] ?? "";
    const updated = /updated\s+(\d{4}-\d{2}-\d{2})/.exec(tail)?.[1] ?? null;
    items.push({ id, url, title: m[3].trim(), owner: m[1] as "mine" | "shared", pinned: /\bpinned\b/.test(m[2]), updated });
  }
  const total = /(\d+)\s+artifacts?,/.exec(text);
  return { items, total: total ? Number(total[1]) : null, more: /More exist/i.test(text) };
}

const OPEN_TAG = "<cowritten-artifact-html>";
const CLOSE_TAG = "</cowritten-artifact-html>";

/**
 * The live page the Artifact tool showed when it refused an update, or null. The tool names the
 * tag in its explanation too, so take the last opening tag before the closing one.
 */
export function liveBlock(text: string): string | null {
  const close = text.lastIndexOf(CLOSE_TAG);
  if (close < 0) return null;
  const open = text.lastIndexOf(OPEN_TAG, close);
  if (open < 0) return null;
  return text.slice(open + OPEN_TAG.length, close).replace(/^\r?\n/, "");
}

/**
 * True only when the live version is exactly what bb last sent: either the same text (Markdown),
 * or the same text once, inside claude.ai's plain page wrapper (a <head> with no <body> in it,
 * then <body>, the page, </body></html>). Any change made on claude.ai fails this, so bb never
 * overwrites it.
 */
export function liveIsUnchanged(live: string, sent: string): boolean {
  if (!sent.trim()) return false;
  if (live.trim() === sent.trim()) return true;
  const i = live.indexOf(sent);
  if (i < 0 || live.indexOf(sent, i + 1) >= 0) return false;
  const prefix = live.slice(0, i);
  const suffix = live.slice(i + sent.length);
  return /^<!doctype html><html><head>(?:(?!<body)[\s\S])*<\/head><body>\r?\n?$/i.test(prefix) && suffix.trim() === "</body></html>";
}

/** The artifact URL a publish reported, or null. */
export function parsePublishedUrl(text: string): string | null {
  const m = /Published\s.+?\sat\s(https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+)/s.exec(text) ?? URL_RE.exec(text);
  if (!m) return null;
  return m[0].startsWith("http") ? m[0] : m[1];
}

/** The claude:// link the Claude desktop app opens an artifact from, or null for anything else. */
export function claudeAppLink(url: string): string | null {
  const m = /^https:\/\/claude\.ai\/((?:code\/)?artifact\/[A-Za-z0-9_-]+)$/.exec(url);
  return m ? `claude://claude.ai/${m[1]}` : null;
}

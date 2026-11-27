// Finds the pages bb chats have saved: the `artifacts` folder of every chat folder
// (`<project>/.bb/chats/<thread>/artifacts`, `<bb data>/thread-storage/<thread>/artifacts`), plus any
// extra folders the person lists in settings. Only .html, .htm and .md files count.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export type LocalPage = {
  /** Absolute path, the page's identity. */
  path: string;
  title: string;
  kind: "html" | "md";
  mtime: number;
  size: number;
  /** The chat that saved it, when the path names one (thr_...). */
  threadId: string | null;
  /** First lines of a Markdown page, for its card. */
  snippet: string | null;
};

const EXT = new Set([".html", ".htm", ".md"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "tmp", "history", "dist", ".next"]);
/** Files looked at in one scan (a safety limit), and pages kept: the newest ones. */
const MAX_SEEN = 5000;
const MAX_PAGES = 600;

async function head(path: string, bytes = 65_536): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const s = createReadStream(path, { start: 0, end: bytes - 1, encoding: "utf8" });
    s.on("data", (d) => (out += d));
    s.on("end", () => resolve(out));
    s.on("error", () => resolve(out));
  });
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The page's own title: <title>, then the first heading, then the file name. */
export function titleOf(text: string, kind: "html" | "md", fileName: string): string {
  if (kind === "html") {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
    if (t && decode(t)) return decode(t).slice(0, 140);
    const h = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1];
    if (h && decode(h.replace(/<[^>]+>/g, " "))) return decode(h.replace(/<[^>]+>/g, " ")).slice(0, 140);
  } else {
    const h = /^#\s+(.+)$/m.exec(text)?.[1];
    if (h) return h.replace(/[*_`]/g, "").trim().slice(0, 140);
  }
  return fileName.replace(/\.(html?|md)$/i, "");
}

export function snippetOf(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^#\s/.test(l) && !/^---\s*$/.test(l))
    .slice(0, 6)
    .join("\n")
    .replace(/[*_`>#]/g, "")
    .slice(0, 360);
}

export const threadIdIn = (path: string): string | null => /[\\/](thr_[a-z0-9]+)[\\/]/i.exec(path)?.[1] ?? null;

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_SEEN) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_SEEN) return;
    if (e.isDirectory()) {
      if (depth > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(join(dir, e.name), depth - 1, out);
    } else if (e.isFile() && EXT.has(extname(e.name).toLowerCase())) out.push(join(dir, e.name));
  }
}

/** Every chat's artifacts folder under a folder of chat folders (`.bb/chats` or `thread-storage`). */
async function chatArtifactDirs(chatsRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(chatsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && /^thr_/i.test(e.name)).map((e) => join(chatsRoot, e.name, "artifacts"));
}

/**
 * Pages under the given roots, newest first. `chatRoots` are folders of chat folders;
 * `extraFolders` are scanned two levels deep. A Markdown file with an HTML twin of the same name
 * beside it is left out: it's the page's source, and the HTML is what gets shared.
 */
export async function scanPages(chatRoots: string[], extraFolders: string[]): Promise<LocalPage[]> {
  const files: string[] = [];
  for (const root of chatRoots) for (const dir of await chatArtifactDirs(root)) await walk(dir, 2, files);
  for (const folder of extraFolders) await walk(folder, 2, files);
  const unique = [...new Set(files)];
  const lower = new Set(unique.map((f) => f.toLowerCase()));
  const candidates: { path: string; kind: "html" | "md"; mtime: number; size: number }[] = [];
  for (const path of unique) {
    const ext = extname(path).toLowerCase();
    const kind = ext === ".md" ? "md" : "html";
    if (kind === "md") {
      const stem = path.slice(0, -ext.length).toLowerCase();
      if (lower.has(`${stem}.html`) || lower.has(`${stem}.htm`)) continue;
    }
    try {
      const st = await stat(path);
      candidates.push({ path, kind, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* gone since the listing */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const pages: LocalPage[] = [];
  for (const c of candidates.slice(0, MAX_PAGES)) {
    const text = await head(c.path);
    pages.push({
      ...c,
      title: titleOf(text, c.kind, basename(c.path)),
      threadId: threadIdIn(c.path),
      snippet: c.kind === "md" ? snippetOf(text) : null,
    });
  }
  return pages;
}

export const folderOf = (path: string) => dirname(path);

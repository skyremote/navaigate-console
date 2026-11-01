/*
 * The hunk parsing, excerpt clamping and "files nobody placed" rule below are adapted from
 * T3 Code (https://github.com/pingdotgg/t3code), apps/server/src/pullRequest/pullRequestReviewGuideNormalize.ts
 * and packages/shared/src/gitPatchPath.ts.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export type LineRange = { start: number; end: number };
export type ChangeHunk = { old: LineRange | null; new: LineRange | null; link: string | null };
export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "unknown";
export type ChangeFile = {
  path: string;
  previousPath: string | null;
  status: ChangeStatus;
  additions: number | null;
  deletions: number | null;
  link: string | null;
  hunks: ChangeHunk[];
};
export type ListedFile = { path: string; additions?: number | null; deletions?: number | null };

const ESCAPES: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

function unescapeBody(body: string): string {
  if (!body.includes("\\")) return body;
  const bytes: number[] = [];
  let literal = "";
  const flush = () => {
    if (literal) bytes.push(...utf8.encode(literal));
    literal = "";
  };
  for (let at = 0; at < body.length; ) {
    const character = body.charAt(at);
    if (character !== "\\") {
      literal += character;
      at += 1;
      continue;
    }
    const escaped = body.charAt(at + 1);
    if (escaped === "") {
      flush();
      bytes.push(0x5c);
      break;
    }
    const octal = body.slice(at + 1, at + 4);
    if (ESCAPES[escaped] !== undefined) {
      flush();
      bytes.push(ESCAPES[escaped]);
      at += 2;
    } else if (/^[0-7]{3}$/.test(octal)) {
      flush();
      bytes.push(Number.parseInt(octal, 8));
      at += 4;
    } else {
      literal += escaped;
      at += 2;
    }
  }
  flush();
  return fromUtf8.decode(new Uint8Array(bytes));
}
export function unquoteGitPatchPath(token: string): string {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"')
    ? unescapeBody(token.slice(1, -1))
    : unescapeBody(token);
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const range = (start: string, count: string | undefined): LineRange | null => {
  const lines = count === undefined ? 1 : Number(count);
  return lines === 0 ? null : { start: Number(start), end: Number(start) + lines - 1 };
};
function headerPath(line: string, prefix: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf("\t");
  const token = tab === -1 ? rest : rest.slice(0, tab);
  const path = token.startsWith('"') ? unquoteGitPatchPath(token) : token;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}
function gitLinePaths(line: string): { from: string; to: string } | null {
  const rest = line.slice("diff --git ".length);
  const quoted = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => `"${match[1]}"`);
  if (quoted.length === 2) {
    const [a, b] = quoted.map((token) => unquoteGitPatchPath(token));
    return { from: a.replace(/^a\//, ""), to: b.replace(/^b\//, "") };
  }
  if (!rest.startsWith("a/")) return null;
  const splits: number[] = [];
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) splits.push(at);
  const same = splits.find((at) => rest.slice(2, at) === rest.slice(at + 3));
  const at = same ?? splits.at(-1);
  return at === undefined ? null : { from: rest.slice(2, at), to: rest.slice(at + 3) };
}

/** Reads each changed file and its hunks from a git-style unified diff; `listed` adds files the diff did not carry. */
export function parseChangeSet(diff: string, listed: ListedFile[] = []): ChangeFile[] {
  const files: ChangeFile[] = [];
  let current: ChangeFile | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let additions = 0;
  let deletions = 0;
  const finish = () => {
    if (current) {
      current.additions = additions;
      current.deletions = deletions;
    }
  };
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const lead = line[0];
      if (lead === " " || (line === "" && oldLeft > 0 && newLeft > 0)) {
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      if (lead === "-" && oldLeft > 0) {
        oldLeft -= 1;
        deletions += 1;
        continue;
      }
      if (lead === "+" && newLeft > 0) {
        newLeft -= 1;
        additions += 1;
        continue;
      }
      if (lead === "\\") continue;
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      finish();
      additions = 0;
      deletions = 0;
      const paths = gitLinePaths(line);
      current = paths
        ? {
            path: paths.to,
            previousPath: paths.from === paths.to ? null : paths.from,
            status: paths.from === paths.to ? "modified" : "renamed",
            additions: null,
            deletions: null,
            link: null,
            hunks: [],
          }
        : null;
      if (current) files.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) current.previousPath = line.slice(12);
    else if (line.startsWith("rename to ")) {
      current.path = line.slice(10);
      current.status = "renamed";
    } else if (line.startsWith("+++ ") && current.hunks.length === 0) {
      const to = headerPath(line, "b/");
      if (to) current.path = to;
    } else {
      const header = HUNK_HEADER.exec(line);
      if (!header) continue;
      const removed = range(header[1], header[2]);
      const added = range(header[3], header[4]);
      oldLeft = Number(header[2] ?? 1);
      newLeft = Number(header[4] ?? 1);
      current.hunks.push({ old: removed, new: added, link: null });
    }
  }
  finish();
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const item of listed) {
    const known = byPath.get(item.path);
    if (known) {
      known.additions = item.additions ?? known.additions;
      known.deletions = item.deletions ?? known.deletions;
      continue;
    }
    const file: ChangeFile = {
      path: item.path,
      previousPath: null,
      status: "unknown",
      additions: item.additions ?? null,
      deletions: item.deletions ?? null,
      link: null,
      hunks: [],
    };
    files.push(file);
    byPath.set(file.path, file);
  }
  return files;
}

export type TourBudget = { full: number; compact: number };
const DEFAULT_BUDGET: TourBudget = { full: 20_000, compact: 30_000 };
const span = (side: string, value: LineRange | null) =>
  value ? `${side} ${value.start === value.end ? value.start : `${value.start}-${value.end}`}` : "";
const counts = (file: ChangeFile) =>
  file.additions === null && file.deletions === null
    ? file.status
    : `${file.status} +${file.additions ?? "?"} -${file.deletions ?? "?"}`;

/** The list of every changed file, with hunks and links, that the guided review must account for. */
export function tourManifest(files: ChangeFile[], budget: TourBudget = DEFAULT_BUDGET): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  let shortened = false;
  files.forEach((file, index) => {
    const id = `F${index + 1}`;
    const head = `${id} ${file.path} [${counts(file)}]${file.previousPath ? ` (was ${file.previousPath})` : ""}${file.link ? ` ${file.link}` : ""}`;
    const hunks = file.hunks.map(
      (hunk, at) =>
        `  ${id}.H${at + 1} ${[span("new", hunk.new), span("old", hunk.old)].filter(Boolean).join(", ")}${hunk.link ? ` ${hunk.link}` : ""}`,
    );
    const full = [head, ...hunks].join("\n");
    if (used + full.length + 1 <= budget.full) {
      lines.push(full);
      used += full.length + 1;
    } else if (used + head.length + 1 <= budget.compact) {
      const compact = `${id} ${file.path} [${counts(file)}]`;
      lines.push(compact);
      used += compact.length + 1;
      shortened = true;
    } else omitted += 1;
  });
  return [
    `Coverage manifest: ${files.length} changed file${files.length === 1 ? "" : "s"}, computed by the host from the PR diff.`,
    ...lines,
    ...(shortened ? ["Files listed without hunks above: read their hunks from the diff."] : []),
    ...(omitted
      ? [
          `${omitted} further file${omitted === 1 ? "" : "s"} did not fit this manifest: list them as not covered and read the full diff.`,
        ]
      : []),
  ].join("\n");
}

export type TourCheck = {
  total: number;
  covered: string[];
  missing: string[];
  invalidLinks: { link: string; reason: string }[];
  ok: boolean;
  otherFiles: string;
};

const LINK = /https?:\/\/[^\s)\]>"'`]+\/(?:files|diffs)#[^\s)\]>"'`]+/g;
const overlaps = (hunk: LineRange | null, start: number, end: number) =>
  hunk !== null && hunk.start <= end && start <= hunk.end;
const anchorOf = (link: string) => link.slice(link.indexOf("#") + 1);

/** Checks a returned tour against the manifest: every file placed, every hunk link real and in range. */
export function checkTour(files: ChangeFile[], answer: string): TourCheck {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const file of files) {
    const placed =
      answer.includes(file.path) ||
      (file.link !== null && answer.includes(file.link)) ||
      (file.previousPath !== null && answer.includes(file.previousPath));
    (placed ? covered : missing).push(file.path);
  }
  const byAnchor = new Map<string, ChangeFile>();
  for (const file of files) if (file.link) byAnchor.set(anchorOf(file.link), file);
  const invalidLinks: TourCheck["invalidLinks"] = [];
  if (byAnchor.size > 0)
    for (const link of new Set(answer.match(LINK) ?? [])) {
      const anchor = anchorOf(link);
      const lines = /^(.*?)(?:([LR])(\d+)(?:-(?:[LR])?(\d+))?)?$/.exec(anchor);
      const base = lines?.[1] ?? anchor;
      const file = byAnchor.get(anchor) ?? byAnchor.get(base);
      if (!file) {
        invalidLinks.push({ link, reason: "Names a file that is not in this change." });
        continue;
      }
      if (!lines?.[2]) continue;
      const start = Number(lines[3]);
      const end = Number(lines[4] ?? lines[3]);
      const side = lines[2] === "R" ? "new" : "old";
      if (!file.hunks.some((hunk) => overlaps(hunk[side], Math.min(start, end), Math.max(start, end))))
        invalidLinks.push({ link, reason: `Lines ${start}-${end} are outside every ${side}-side hunk of ${file.path}.` });
    }
  return {
    total: files.length,
    covered,
    missing,
    invalidLinks,
    ok: missing.length === 0 && invalidLinks.length === 0,
    otherFiles: missing.length
      ? `Other files\nChanged files the tour does not otherwise cover.\n${missing.map((path) => `- ${path}`).join("\n")}`
      : "",
  };
}

export type TourStop = {
  index: number;
  title: string;
  text: string;
  files: ChangeFile[];
  links: { link: string; path: string | null; real: boolean }[];
};

const STOP_HEADING = /^\s{0,3}(?:#{1,4}\s*)?\**\s*(?:stop\s*)?(\d{1,2})\s*[.):\-–]\s*\**\s*(.+?)\**\s*$/i;
const TOUR_END = /^\s{0,3}(?:#{1,4}\s*)?\**\s*(coverage|not covered|other files)\b/i;

function resolveLink(files: ChangeFile[], link: string): { path: string | null; real: boolean } {
  const anchor = anchorOf(link);
  const lines = /^(.*?)(?:([LR])(\d+)(?:-(?:[LR])?(\d+))?)?$/.exec(anchor);
  const base = lines?.[1] ?? anchor;
  const file = files.find((entry) => entry.link !== null && (anchorOf(entry.link) === anchor || anchorOf(entry.link) === base));
  if (!file) return { path: null, real: false };
  if (!lines?.[2]) return { path: file.path, real: true };
  const start = Number(lines[3]);
  const end = Number(lines[4] ?? lines[3]);
  const side = lines[2] === "R" ? "new" : "old";
  return {
    path: file.path,
    real: file.hunks.some((hunk) => overlaps(hunk[side], Math.min(start, end), Math.max(start, end))),
  };
}

/** Cuts a returned tour into its numbered stops and ties each to the changed files and hunks it names. */
export function splitStops(files: ChangeFile[], answer: string): TourStop[] {
  const stops: { index: number; title: string; lines: string[] }[] = [];
  for (const line of answer.split("\n")) {
    if (stops.length && TOUR_END.test(line)) break;
    const heading = STOP_HEADING.exec(line);
    if (heading) {
      stops.push({ index: Number(heading[1]), title: heading[2].replace(/^\**|\**$/g, "").trim(), lines: [] });
      continue;
    }
    stops.at(-1)?.lines.push(line);
  }
  return stops.map((stop) => {
    const text = stop.lines.join("\n").trim();
    return {
      index: stop.index,
      title: stop.title,
      text,
      files: files.filter(
        (file) => text.includes(file.path) || (file.previousPath !== null && text.includes(file.previousPath)),
      ),
      links: [...new Set(text.match(LINK) ?? [])].map((link) => ({ link, ...resolveLink(files, link) })),
    };
  });
}

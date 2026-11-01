// Live preview for the chat box: finds the Markdown constructs whose markers bb hides while the
// caret is elsewhere, and the GFM tables bb draws as a grid. The text itself is never changed;
// bb decides what to reveal from the caret and applies the classes returned here.
//
// All CSS for these classes lives in app.css under html[data-nm-md-live="on"], so the Md button
// switches the whole preview on and off without touching the draft.
import type { ComposerEffectRange, ComposerTableAlign } from "./composer-preview-types";

export type Range = { from: number; to: number };

export const HIDDEN_CLASS = "nm-md-hidden";
export const TABLE_CLASS = "nm-md-grid";
export const BULLET_CLASS = "nm-md-bullet";
export const UNCHECKED_CLASS = "nm-md-unchecked";
export const CHECKED_CLASS = "nm-md-checked";

const MAX_LENGTH = 20000;

type Line = { text: string; from: number; to: number };

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (const part of text.split("\n")) {
    lines.push({ text: part, from, to: from + part.length });
    from += part.length + 1;
  }
  return lines;
}

/** Lines inside fenced code blocks, fences included; they take no Markdown. */
function fencedLines(lines: Line[]): Set<number> {
  const fenced = new Set<number>();
  let open = false;
  lines.forEach((line, index) => {
    const isFence = /^\s*```/.test(line.text);
    if (isFence || open) fenced.add(index);
    if (isFence) open = !open;
  });
  return fenced;
}

function splitCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (body[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += body[i];
  }
  cells.push(cell.trim());
  return cells;
}

const DIVIDER_CELL = /^:?-+:?$/;

function isDivider(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((cell) => DIVIDER_CELL.test(cell));
}

function isPipeLine(line: string): boolean {
  return /^\s*\|/.test(line) || (line.includes("|") && !/^\s*>/.test(line) && /\S\s*\|\s*\S/.test(line));
}

function alignOf(cell: string): ComposerTableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return left ? "left" : null;
}

type TableRange = Range & { table: NonNullable<ComposerEffectRange["table"]> };

export function scanTables(text: string): TableRange[] {
  if (!text || text.length > MAX_LENGTH) return [];
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  const tables: TableRange[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (fenced.has(i) || fenced.has(i + 1)) continue;
    const head = lines[i];
    const divider = lines[i + 1];
    if (!isPipeLine(head.text) || !isDivider(divider.text)) continue;
    const header = splitCells(head.text);
    const dividerCells = splitCells(divider.text);
    if (header.length !== dividerCells.length) continue;
    let end = i + 2;
    while (end < lines.length && !fenced.has(end) && lines[end].text.trim() !== "" && isPipeLine(lines[end].text)) end++;
    tables.push({
      from: head.from,
      to: lines[end - 1].to,
      table: {
        header,
        align: dividerCells.map(alignOf),
        rows: lines.slice(i + 2, end).map((line) => splitCells(line.text)),
      },
    });
    i = end - 1;
  }
  return tables;
}

type Match = RegExpExecArray;

function each(text: string, re: RegExp, fn: (m: Match) => void): void {
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: Match | null;
  while ((m = rx.exec(text))) {
    fn(m);
    if (m[0].length === 0) rx.lastIndex++;
  }
}

function hide(from: number, to: number): { from: number; to: number } {
  return { from, to };
}

export function scanConstructs(text: string): ComposerEffectRange[] {
  if (!text || text.length > MAX_LENGTH) return [];
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  const blocked = lines.filter((_, index) => fenced.has(index));
  const free = (from: number, to: number) => !blocked.some((line) => from <= line.to && to >= line.from);
  const out: ComposerEffectRange[] = [];
  const add = (range: ComposerEffectRange) => {
    if (free(range.from, range.to)) out.push(range);
  };

  const pair = (re: RegExp, width: number) =>
    each(text, re, (m) => {
      const to = m.index + m[0].length;
      add({ from: m.index, to, hidden: [hide(m.index, m.index + width), hide(to - width, to)] });
    });
  pair(/(\*\*|__)(?=\S)[^\n]*?(?<=\S)\1/g, 2);
  pair(/(?<![*\w])\*(?![*\s])[^*\n]*?(?<![*\s])\*(?![*\w])/g, 1);
  pair(/(?<![_\w])_(?![_\s])[^_\n]*?(?<![_\s])_(?![_\w])/g, 1);
  pair(/~~(?=\S)[^~\n]*?(?<=\S)~~/g, 2);
  pair(/`[^`\n]+`/g, 1);

  each(text, /^(#{1,6})([ \t]+)(?=\S)/gm, (m) => {
    const lineEnd = text.indexOf("\n", m.index);
    add({ from: m.index, to: lineEnd === -1 ? text.length : lineEnd, hidden: [hide(m.index, m.index + m[0].length)] });
  });

  each(text, /\[([^\]\n]+)\](\([^)\s]+\))/g, (m) => {
    const to = m.index + m[0].length;
    add({ from: m.index, to, hidden: [hide(m.index, m.index + 1), hide(m.index + 1 + m[1].length, to)] });
  });

  each(text, /^([ \t]*)([-*+])([ \t]+)(\[[ xX]\])?/gm, (m) => {
    const marker = m.index + m[1].length;
    if (m[4] === undefined) {
      add({ from: marker, to: marker + 1, hidden: [{ from: marker, to: marker + 1, className: BULLET_CLASS }] });
      return;
    }
    const box = marker + 1 + m[3].length;
    const done = m[4] !== "[ ]";
    add({
      from: marker,
      to: box + 3,
      hidden: [hide(marker, box), { from: box, to: box + 3, className: done ? CHECKED_CLASS : UNCHECKED_CLASS }],
    });
  });

  return out;
}

function columnTitles(count: number): string {
  return `| ${Array.from({ length: count }, (_, i) => `Column ${i + 1}`).join(" | ")} |`;
}

function dividerRow(count: number, source: string[] = []): string {
  const cells = Array.from({ length: count }, (_, i) => (DIVIDER_CELL.test(source[i] ?? "") ? source[i] : "---"));
  return `| ${cells.join(" | ")} |`;
}

const PIPE_ROW = /^\s*\|.*\|\s*$/;
const BORDER_LINE = /^\s*\+[-=+]{2,}\+\s*$/;

function followsTable(before: string): boolean {
  const lines = before.split("\n");
  const here = lines[lines.length - 1];
  const above = here === "" ? lines[lines.length - 2] ?? "" : "";
  if (PIPE_ROW.test(here) || PIPE_ROW.test(above)) return true;
  const settled = here === "" ? before.slice(0, -1) : before;
  return scanTables(settled).some((table) => table.to === settled.length);
}

function precedesTable(after: string): boolean {
  const lines = after.split("\n");
  if (PIPE_ROW.test(lines[0])) return true;
  const settled = lines[0] === "" ? after.slice(1) : after;
  return scanTables(settled).some((table) => table.from === 0);
}

/** The pasted rows sit against a `+----+` rule: output from psql, mysql and the like, not Markdown. */
function besideBorder(context: { before: string; after: string }): boolean {
  const above = context.before.split("\n");
  const below = context.after.split("\n");
  const nearest = [above[above.length - 1] === "" ? above[above.length - 2] : above[above.length - 1], below[0] === "" ? below[1] : below[0]];
  return nearest.some((line) => line !== undefined && BORDER_LINE.test(line));
}

/**
 * Gives a pasted block of pipe rows what GFM needs: a header row when there is none and a divider
 * as wide as the table. Only a paste made entirely of pipe rows is touched, and never one pasted
 * into, beside or between the rules of another table; anything else stays exactly as it was.
 */
export function repairPastedTables(text: string, context: { before: string; after: string }): string {
  if (!text.includes("|") || text.length > MAX_LENGTH) return text;
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  const block = lines.slice(start, end);
  if (block.length < 2 || !block.every((line) => PIPE_ROW.test(line))) return text;
  if (followsTable(context.before) || precedesTable(context.after) || besideBorder(context)) return text;
  const repaired = repairBlock(block);
  if (repaired.length === block.length && repaired.every((line, index) => line === block[index])) return text;
  return [...lines.slice(0, start), ...repaired, ...lines.slice(end)].join("\n");
}

function repairBlock(block: string[]): string[] {
  const width = Math.max(...block.map((line) => splitCells(line).length));
  const dividerAt = block.findIndex((line) => isDivider(line));
  if (dividerAt === 1) {
    const header = splitCells(block[0]);
    const divider = splitCells(block[1]);
    if (header.length === width && divider.length === width) return block;
    const titles = Array.from({ length: width }, (_, k) => header[k] || `Column ${k + 1}`);
    return [`| ${titles.join(" | ")} |`, dividerRow(width, divider), ...block.slice(2)];
  }
  if (dividerAt === 0) {
    return [columnTitles(width), dividerRow(width, splitCells(block[0])), ...block.slice(1)];
  }
  if (dividerAt > 1) return block;
  return [columnTitles(width), dividerRow(width), ...block];
}

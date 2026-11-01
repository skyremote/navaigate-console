import { describe, expect, it } from "vitest";
import {
  BULLET_CLASS,
  CHECKED_CLASS,
  UNCHECKED_CLASS,
  repairPastedTables,
  scanConstructs,
  scanTables,
} from "./markdown-live";

const around = { before: "", after: "" };
const slice = (text: string, r: { from: number; to: number }) => text.slice(r.from, r.to);

function hiddenText(text: string): string[] {
  return scanConstructs(text).flatMap((c) => (c.hidden ?? []).map((h) => slice(text, h)));
}

describe("scanConstructs", () => {
  it("hides the markers of bold, italic, strike and inline code", () => {
    const text = "**b** and *i* and _u_ and ~~s~~ and `c`";
    expect(hiddenText(text)).toEqual(["**", "**", "*", "*", "_", "_", "~~", "~~", "`", "`"]);
  });

  it("covers the whole construct so the caret in it reveals the markers", () => {
    const text = "say **bold** now";
    const [bold] = scanConstructs(text);
    expect(slice(text, bold)).toBe("**bold**");
  });

  it("hides the hashes and space of a heading and covers the whole line", () => {
    const text = "intro\n## Title here\nafter";
    const [heading] = scanConstructs(text);
    expect(slice(text, heading)).toBe("## Title here");
    expect(heading.hidden?.map((h) => slice(text, h))).toEqual(["## "]);
  });

  it("hides link brackets and the url, leaving the label", () => {
    expect(hiddenText("see [docs](https://x.dev) now")).toEqual(["[", "](https://x.dev)"]);
  });

  it("turns a dash bullet into a bullet marker and keeps ordered lists as typed", () => {
    const text = "- one\n1. two";
    const [bullet, ...rest] = scanConstructs(text);
    expect(bullet.hidden).toEqual([{ from: 0, to: 1, className: BULLET_CLASS }]);
    expect(rest).toEqual([]);
  });

  it("draws task boxes", () => {
    const text = "- [ ] open\n- [x] done";
    const [open, done] = scanConstructs(text);
    expect(open.hidden?.map((h) => h.className)).toEqual([undefined, UNCHECKED_CLASS]);
    expect(done.hidden?.map((h) => h.className)).toEqual([undefined, CHECKED_CLASS]);
    expect(open.hidden?.map((h) => slice(text, h))).toEqual(["- ", "[ ]"]);
  });

  it("leaves fenced code and an unclosed marker alone", () => {
    expect(scanConstructs("```\n**not bold**\n```")).toEqual([]);
    expect(scanConstructs("a **half")).toEqual([]);
    expect(scanConstructs("2 * 3 * 4")).toEqual([]);
  });

  it("does nothing for a very long draft", () => {
    expect(scanConstructs("**a** ".repeat(5000))).toEqual([]);
  });
});

describe("scanTables", () => {
  const table = "| Name | Qty |\n| :--- | ---: |\n| Tea | 2 |\n| Milk | `3` |";

  it("returns the grid data and the span of the source", () => {
    const text = `before\n\n${table}\n\nafter`;
    const [found] = scanTables(text);
    expect(slice(text, found)).toBe(table);
    expect(found.table).toEqual({
      header: ["Name", "Qty"],
      align: ["left", "right"],
      rows: [
        ["Tea", "2"],
        ["Milk", "`3`"],
      ],
    });
  });

  it("stops at the first line that is not a row", () => {
    const text = `${table}\nplain line\n| x | y |`;
    expect(slice(text, scanTables(text)[0])).toBe(table);
  });

  it("needs a divider as wide as the header", () => {
    expect(scanTables("| a | b |\n| --- |\n| 1 | 2 |")).toEqual([]);
    expect(scanTables("| a | b |\n| 1 | 2 |")).toEqual([]);
  });

  it("reads escaped pipes as text and rows without outer pipes", () => {
    const [found] = scanTables("a | b\n--- | ---\nx \\| y | z");
    expect(found.table.rows).toEqual([["x | y", "z"]]);
  });

  it("ignores tables in fenced code", () => {
    expect(scanTables("```\n| a |\n| - |\n```")).toEqual([]);
  });
});

describe("repairPastedTables", () => {
  it("adds a header and a full divider to a pasted body", () => {
    expect(repairPastedTables("| Tea | 2 |\n| Milk | 3 |", around)).toBe(
      "| Column 1 | Column 2 |\n| --- | --- |\n| Tea | 2 |\n| Milk | 3 |",
    );
  });

  it("adds a header above a pasted divider", () => {
    expect(repairPastedTables("| --- | --- |\n| a | b |", around)).toBe(
      "| Column 1 | Column 2 |\n| --- | --- |\n| a | b |",
    );
  });

  it("completes a divider that is narrower than the rows", () => {
    expect(repairPastedTables("| A | B | C |\n| --- |\n| 1 | 2 | 3 |", around)).toBe(
      "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |",
    );
  });

  it("keeps alignment colons when it widens a divider", () => {
    expect(repairPastedTables("| A | B |\n| :-: |\n| 1 | 2 |", around)).toBe(
      "| A | B |\n| :-: | --- |\n| 1 | 2 |",
    );
  });

  it("names header cells that are missing", () => {
    expect(repairPastedTables("| A |\n| --- | --- |\n| 1 | 2 |", around)).toBe(
      "| A | Column 2 |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  it("returns a complete table byte for byte", () => {
    const text = "|a|b|\n|---|---|\n|1|2|";
    expect(repairPastedTables(text, around)).toBe(text);
  });

  it("keeps blank lines around a pasted table", () => {
    expect(repairPastedTables("\n| a | b |\n| 1 | 2 |\n", around)).toBe(
      "\n| Column 1 | Column 2 |\n| --- | --- |\n| a | b |\n| 1 | 2 |\n",
    );
  });

  it("leaves a paste alone unless every line of it is a pipe row", () => {
    const text = "Here:\n| a | b |\n| 1 | 2 |\nThanks";
    expect(repairPastedTables(text, around)).toBe(text);
  });

  it("leaves boxed terminal output exactly as copied", () => {
    const psql = "+----+------+\n| id | name |\n+----+------+\n| 1  | a    |\n| 2  | b    |\n+----+------+";
    expect(repairPastedTables(psql, around)).toBe(psql);
  });

  it("leaves rows pasted against a +---+ rule", () => {
    const rows = "| 1  | a    |\n| 2  | b    |";
    expect(repairPastedTables(rows, { before: "+----+------+\n", after: "" })).toBe(rows);
    expect(repairPastedTables(rows, { before: "", after: "\n+----+------+" })).toBe(rows);
    expect(repairPastedTables(rows, { before: "+----+------+", after: "" })).toBe(rows);
  });

  it("leaves a single pasted row and plain text alone", () => {
    expect(repairPastedTables("| a | b |", around)).toBe("| a | b |");
    expect(repairPastedTables("just words | with a pipe", around)).toBe("just words | with a pipe");
    expect(repairPastedTables("no pipes at all", around)).toBe("no pipes at all");
  });

  it("leaves rows pasted into or directly below an existing table", () => {
    const rows = "| c | d |\n| e | f |";
    expect(repairPastedTables(rows, { before: "| A | B |\n| --- | --- |\n| 1 | 2 |\n", after: "" })).toBe(rows);
    expect(repairPastedTables(rows, { before: "| A | B |\n| --- | --- |\n| 1 | 2 |", after: "" })).toBe(rows);
    expect(repairPastedTables(rows, { before: "x\n", after: "| 9 | 9 |" })).toBe(rows);
  });

  it("leaves rows pasted beside a table that has no outer pipes", () => {
    const rows = "| c | d |\n| e | f |";
    expect(repairPastedTables(rows, { before: "A | B\n--- | ---\n1 | 2\n", after: "" })).toBe(rows);
    expect(repairPastedTables(rows, { before: "", after: "A | B\n--- | ---\n1 | 2" })).toBe(rows);
  });

  it("repairs rows that follow prose rather than a table", () => {
    expect(repairPastedTables("| c | d |\n| e | f |", { before: "A | B is plain prose\n", after: "" })).toBe(
      "| Column 1 | Column 2 |\n| --- | --- |\n| c | d |\n| e | f |",
    );
  });

  it("leaves fenced code alone", () => {
    const text = "```\n| a | b |\n| c | d |\n```";
    expect(repairPastedTables(text, around)).toBe(text);
  });
});

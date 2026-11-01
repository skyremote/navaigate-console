import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { buildPdf, countPdfPages, deterministicBytes, parseReply, sha256, PAGE_COUNT } from "./f60-files.mjs";

describe("F60 acceptance fixtures", () => {
  it("builds a deterministic, incompressible 41-page PDF of at least 5,000,000 bytes", () => {
    const pdf = buildPdf();
    expect(pdf.length).toBeGreaterThanOrEqual(5_000_000);
    expect(pdf.length).toBeLessThan(8 * 1024 * 1024);
    expect(countPdfPages(pdf)).toBe(PAGE_COUNT);
    expect(pdf.toString("latin1")).toContain(`/Count ${PAGE_COUNT}`);
    expect(sha256(buildPdf())).toBe(sha256(pdf));
    expect(deflateSync(pdf).length).toBeGreaterThan(pdf.length * 0.99);
  }, 60_000);

  it("writes a cross-reference table whose offsets point at each object", () => {
    const pdf = buildPdf({ pages: 3, width: 16, height: 16 });
    const text = pdf.toString("latin1");
    const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const entries = text.slice(xref).split("\n").slice(3).filter((line) => / 00000 n $/.test(line));
    expect(entries).toHaveLength(4 + 3 * 2);
    entries.forEach((line, index) => expect(text.slice(Number(line.slice(0, 10)), Number(line.slice(0, 10)) + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`));
  });

  it("pads with deterministic bytes of the requested length", () => {
    expect(deterministicBytes(100).length).toBe(100);
    expect(deterministicBytes(100).equals(deterministicBytes(100))).toBe(true);
    expect(deterministicBytes(100, "other").equals(deterministicBytes(100))).toBe(false);
  });

  it("parses the studio reply lines and leaves missing values null", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    expect(parseReply(`pages=41\npdf_sha256=${a}\nlogo_sha256=${b}`)).toEqual({ pages: 41, pdfSha256: a, logoSha256: b.toLowerCase() });
    expect(parseReply("I could not read the file")).toEqual({ pages: null, pdfSha256: null, logoSha256: null });
  });
});

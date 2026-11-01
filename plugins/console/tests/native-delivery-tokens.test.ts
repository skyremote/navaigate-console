import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "..", "src");
const files = readdirSync(dir).filter((name) => /^delivery.*\.tsx?$/.test(name));
const palette = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|decoration|shadow|accent|caret)-(?:amber|yellow|orange|gold|red|green|lime|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|stone)(?:-\d{2,3})?/;
const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/;

describe("Delivery uses host colour tokens only", () => {
  it("finds the Delivery source files", () => {
    expect(files).toEqual(expect.arrayContaining(["delivery-worktrees.tsx", "delivery-stale.tsx", "delivery.tsx"]));
  });
  it.each(files)("%s has no palette class and no literal colour", (name) => {
    const source = readFileSync(join(dir, name), "utf8");
    expect(source.match(palette)?.[0] ?? null).toBeNull();
    expect(source.match(literal)?.[0] ?? null).toBeNull();
  });
});

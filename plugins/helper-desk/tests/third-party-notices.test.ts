import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const notice = readFileSync(path.join(desk, "THIRD_PARTY_NOTICES.md"), "utf8");

describe("helper-desk/THIRD_PARTY_NOTICES.md", () => {
  it("names the vendored bloub engine and the licence file that ships with it", () => {
    expect(notice).toContain("https://github.com/jeremy-prt/bloub");
    expect(notice).toContain("`coach/bloub/LICENSE`");
    expect(existsSync(path.join(desk, "coach", "bloub", "LICENSE"))).toBe(true);
  });

  it("lists every vendored bloub file and every file copied from the bb plugin registry", () => {
    const ls = spawnSync("git", ["-C", desk, "ls-files", "--", "coach/bloub", "components/ui", "hooks", "lib/portal-scope.ts", "lib/utils.ts"], { encoding: "utf8" });
    const vendored = ls.stdout.split("\n").filter(Boolean).filter((file) => !/\/(LICENSE|README\.md)$/.test(file));
    expect(vendored.length).toBeGreaterThan(20);
    for (const file of vendored) expect(notice, file).toContain(`\`helper-desk/${file}\``);
    expect(notice).toContain("https://github.com/get-bb/bb");
    expect(notice).toContain("Copyright (c) 2026 Michael Yong");
    expect(notice).toContain("Copyright (c) 2026 Jérémy Perret");
  });

  it("lists only files that exist", () => {
    const listed = [...notice.matchAll(/^- `(helper-desk\/[^`]+)`/gm)].map((match) => match[1] ?? "");
    expect(listed.length).toBeGreaterThan(0);
    for (const file of listed) expect(existsSync(path.join(desk, "..", file)), file).toBe(true);
  });

  it("covers the shadcn/ui components with the licence text once", () => {
    expect(existsSync(path.join(desk, "components.json"))).toBe(true);
    expect(notice).toContain("shadcn/ui");
    expect(notice.match(/Permission is hereby granted/g)).toHaveLength(1);
  });

  it("says no file is copied from T3 Code, and no file carries a T3 Code header", () => {
    expect(notice).toContain("No file in Helper Desk is copied from T3 Code");
    const grep = spawnSync("git", ["-C", desk, "grep", "-l", "-F", "T3 Tools Inc.", "--", ".", ":(exclude)THIRD_PARTY_NOTICES.md", ":(exclude)tests/third-party-notices.test.ts"], { encoding: "utf8" });
    expect(grep.stdout.trim()).toBe("");
  });
});

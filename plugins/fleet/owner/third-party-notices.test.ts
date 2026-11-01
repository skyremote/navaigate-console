import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const noticePath = path.join(repo, "fleet", "THIRD_PARTY_NOTICES.md");
const notice = readFileSync(noticePath, "utf8");

describe("fleet/THIRD_PARTY_NOTICES.md", () => {
  it("lists every Fleet file that carries the T3 Code licence header", () => {
    const grep = spawnSync("git", ["-C", repo, "grep", "-l", "-F", "Copyright (c) 2026 T3 Tools Inc.", "--", "fleet", ":(exclude,glob)**/*.test.ts", ":(exclude)fleet/THIRD_PARTY_NOTICES.md"], { encoding: "utf8" });
    const carrying = grep.stdout.split("\n").filter(Boolean);
    expect(carrying).toContain("fleet/owner/editor-link.ts");
    for (const file of carrying) expect(notice, file).toContain(`\`${file}\``);
  });

  it("lists every file copied from the bb plugin registry", () => {
    const ls = spawnSync("git", ["-C", repo, "ls-files", "--", "fleet/components/ui", "fleet/hooks", "fleet/lib/portal-scope.ts", "fleet/lib/utils.ts"], { encoding: "utf8" });
    const registry = ls.stdout.split("\n").filter(Boolean);
    expect(registry.length).toBeGreaterThan(10);
    for (const file of registry) expect(notice, file).toContain(`\`${file}\``);
    expect(notice).toContain("https://github.com/get-bb/bb");
    expect(notice).toContain("Copyright (c) 2026 Michael Yong");
    expect(notice).toContain("Copyright (c) 2023 shadcn");
  });

  it("lists only files that exist", () => {
    const listed = [...notice.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1] ?? "");
    expect(listed.length).toBeGreaterThan(0);
    for (const file of listed) expect(existsSync(path.join(repo, file)), file).toBe(true);
  });

  it("states the T3 Code source and carries the MIT text once", () => {
    expect(notice).toContain("https://github.com/pingdotgg/t3code");
    expect(notice.match(/Permission is hereby granted/g)).toHaveLength(1);
    expect(notice).toContain("Copyright (c) 2026 T3 Tools Inc.");
  });
});

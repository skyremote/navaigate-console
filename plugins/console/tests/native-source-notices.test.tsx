// @vitest-environment jsdom
import React from "react";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_NOTICES } from "../src/source-notices";
import { SourceNotices } from "../src/source-notices-view";

afterEach(cleanup);

describe("Inspect, fork and reuse the source", () => {
  it("lists every file copied from T3 Code, with its repository and licence", () => {
    render(<SourceNotices />);
    const list = screen.getByRole("list", { name: "Code copied or adapted from other projects" });
    const items = [...list.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(items).toHaveLength(SOURCE_NOTICES.length);
    expect(items.join("\n")).toContain("packages/domain/src/project-icon.ts");
    expect(items.join("\n")).toContain("plugins/github-pr-status/host/gitlab-host.ts");
    expect(items.join("\n")).toContain("fleet/owner/editor-link.ts");
    expect(items.join("\n")).toContain("review-tour.ts");
    for (const item of items) {
      expect(item).toContain("T3 Code");
      expect(item).toContain("MIT");
    }
  });

  it("names the notice file to read in each repository", () => {
    render(<SourceNotices />);
    expect(screen.getByText(/THIRD_PARTY_NOTICES\.md in each repository/)).toBeTruthy();
  });

  it("is shown in the Delivery expander of native entry points", () => {
    const delivery = readFileSync(join(__dirname, "..", "src", "delivery.tsx"), "utf8");
    expect(delivery).toContain("<SourceNotices />");
  });

  it("carries a notice file that says what this plugin copies", () => {
    const notice = readFileSync(join(__dirname, "..", "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notice).toContain("`review-tour.ts` adapts");
    expect(notice).toContain("No other source file in this plugin is copied from T3 Code");
    expect(notice).toContain("Copyright (c) 2026 T3 Tools Inc.");
    expect(notice).toContain("shadcn/ui");
    expect(notice).toContain("OpenUI");
    expect(notice.match(/Permission is hereby granted/g)).toHaveLength(3); // T3 Code, shadcn/ui and OpenUI
  });

  it("lists every file of this plugin that carries a T3 Code licence header", () => {
    const out = spawnSync("git", ["-C", join(__dirname, ".."), "grep", "-l", "-F", "Tools Inc.", "--", ":(exclude)THIRD_PARTY_NOTICES.md", ":(exclude)tests/native-source-notices.test.tsx"], { encoding: "utf8" }).stdout.trim();
    const listed = SOURCE_NOTICES.filter((notice) => notice.repo === "console").map((notice) => notice.file);
    expect(out.split("\n").filter(Boolean).sort()).toEqual([...listed].sort());
  });
});

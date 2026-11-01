import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { remoteEditorUrl } from "./editor-link";

describe("remote editor link", () => {
  it("builds a VS Code Remote-SSH folder link for an absolute owner path", () => {
    expect(remoteEditorUrl({ alias: "studio", absolutePath: "/Users/tester/Documents/GitHub/example-site" })).toBe("vscode://vscode-remote/ssh-remote+studio/Users/tester/Documents/GitHub/example-site");
  });

  it("encodes each path segment so spaces and a hash survive", () => {
    expect(remoteEditorUrl({ alias: "studio", absolutePath: "/Users/tester/My Repo/a#b" })).toBe("vscode://vscode-remote/ssh-remote+studio/Users/tester/My%20Repo/a%23b");
  });

  it("refuses relative, traversing or control-character paths and odd aliases", () => {
    expect(remoteEditorUrl({ alias: "studio", absolutePath: "Users/sam" })).toBeNull();
    expect(remoteEditorUrl({ alias: "studio", absolutePath: "/Users/../etc" })).toBeNull();
    expect(remoteEditorUrl({ alias: "studio", absolutePath: "/Users/a\nb" })).toBeNull();
    expect(remoteEditorUrl({ alias: "studio/../x", absolutePath: "/Users/tester" })).toBeNull();
  });

  it("carries the T3 Code MIT copyright and permission notice", () => {
    const source = readFileSync(new URL("./editor-link.ts", import.meta.url), "utf8");
    expect(source).toContain("github.com/pingdotgg/t3code");
    expect(source).toContain("MIT License");
    expect(source).toContain("Copyright (c) 2026 T3 Tools Inc.");
    expect(source).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy");
    expect(source).toContain("The above copyright notice and this permission notice shall be included in all");
    expect(source).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });
});

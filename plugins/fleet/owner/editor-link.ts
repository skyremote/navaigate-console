// Per-segment path encoding and the vscode-remote ssh-remote URL form are ported
// from T3 Code (https://github.com/pingdotgg/t3code, packages/contracts/src/editor.ts).
//
// MIT License
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import path from "node:path";

export function remoteEditorUrl(input: { alias: string; absolutePath: string }): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.alias)) return null;
  const { absolutePath } = input;
  if (!path.posix.isAbsolute(absolutePath) || /[\\\0\x00-\x1f\x7f]/.test(absolutePath)) return null;
  const parts = absolutePath.split("/").slice(1).filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === "..")) return null;
  const encodedPath = parts.length ? "/" + parts.map(encodeURIComponent).join("/") : "/";
  return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(input.alias)}${encodedPath}`;
}

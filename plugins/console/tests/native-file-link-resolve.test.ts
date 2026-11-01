import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectPathHints, eventStrings, openOutsideFile, resolveFileLink, type FileResolveContext } from "../server-file-resolve";

// A fake home: ~/Shared_Local is the chat's project (the "away" checkout), ~/Shared stands in for the NAS share.
let top: string;
let home: string;
let workspace: string;
let nas: string;
const folder = "00_NavAIgate_WIP/Customers/Clientco/Training_Catalogue";
const file = "Email_to_Pat_Training_v4.md";

function put(root: string, rel: string, text: string) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}
const source = (over: Record<string, unknown> = {}) => ({ kind: "workspace" as const, threadId: "thr_1", environmentId: "env_1", projectId: "proj_1", ...over });
function ctx(over: Partial<FileResolveContext> = {}): FileResolveContext {
  return { allowedRoots: [home], home, workspaceRoot: workspace, sources: [workspace, nas], threadStrings: [], hostId: "host_1", ...over };
}

beforeAll(() => {
  top = realpathSync(mkdtempSync(path.join(os.tmpdir(), "file-link-")));
  home = path.join(top, "home");
  workspace = path.join(home, "Shared_Local");
  nas = path.join(home, "NavAIgate");
  mkdirSync(workspace, { recursive: true });
  put(workspace, "notes/inside.md", "# inside");
  put(nas, `${folder}/${file}`, "Subject: Updated statement of work");
  put(nas, "10_Reports/report.pdf", "%PDF-1.4");
  put(path.join(home, ".ssh"), "id_rsa", "secret");
  put(path.join(home, ".ssh"), "notes.md", "# ssh notes");
  put(nas, "10_Reports/run.command", "echo hi");
  put(nas, "10_Reports/tool.sh", "echo hi");
  put(nas, "10_Reports/.npmrc", "//registry:_authToken=x");
  put(top, "scratch/README.md", "# a worktree under /private/tmp");
  put(path.join(home, ".claude"), "plans/README.md", "# a workspace under ~/.claude");
  symlinkSync(nas, path.join(home, "ShareAlias"));
  symlinkSync(path.join(nas, "10_Reports/tool.sh"), path.join(nas, "10_Reports/innocent.md"));
  put(top, "outside/passwd.txt", "not yours");
  symlinkSync(path.join(top, "outside/passwd.txt"), path.join(workspace, "link.txt"));
});
afterAll(() => rmSync(top, { recursive: true, force: true }));

describe("chat file links that point outside the chat's project", () => {
  it("leaves a relative link inside the workspace to bb's own preview", async () => {
    const out = await resolveFileLink({ path: "notes/inside.md", source: source() }, ctx());
    expect(out).toMatchObject({ status: "in-workspace", content: null });
  });

  it("finds a NAS-relative path from the away project in another project source", async () => {
    const out = await resolveFileLink({ path: `${folder}/${file}`, source: source() }, ctx());
    expect(out.status).toBe("found");
    expect(out.realPath).toBe(path.join(nas, folder, file));
    expect(out.content).toBe("Subject: Updated statement of work");
    expect(out.kind).toBe("markdown");
    expect(out.via).toContain(nas);
    expect(out.tried[0]).toBe(path.join(workspace, folder, file));
  });

  it("finds a bare file name the way the real link arrived, from the folder the chat itself named", async () => {
    // The chat's link was Shared_Local/Email_to_Pat_Training_v4.md: no folder. The thread's own commands name it.
    const threadStrings = [
      `Files are in ${"`"}${folder}/${"`"}:`,
      `D=~/Shared/${folder}\ncp -n $W/${file} "$D/"\nls "$D" | grep v4`,
    ];
    const out = await resolveFileLink({ path: file, source: source() }, ctx({ threadStrings }));
    expect(out.status).toBe("found");
    expect(out.realPath).toBe(path.join(nas, folder, file));
    expect(out.via).toContain("a folder this chat used");
  });

  it("finds a bare file name from a relative folder in the thread by joining it to each project source", async () => {
    const out = await resolveFileLink({ path: file, source: source() }, ctx({ threadStrings: [`Files are in ${folder}/`] }));
    expect(out.realPath).toBe(path.join(nas, folder, file));
  });

  it("leaves an absolute host path to bb, which already opens those", async () => {
    const out = await resolveFileLink({ path: path.join(nas, "10_Reports/report.pdf"), source: source({ kind: "host" }) }, ctx());
    expect(out).toMatchObject({ status: "unchecked", content: null });
    expect(out.tried).toEqual([]);
  });

  it("says plainly which paths it tried when the file is nowhere", async () => {
    const out = await resolveFileLink({ path: "missing/nothing.md", source: source() }, ctx({ threadStrings: [`D=${nas}/${folder}`] }));
    expect(out.status).toBe("not-found");
    expect(out.reason).toContain("missing/nothing.md");
    expect(out.tried).toContain(path.join(workspace, "missing/nothing.md"));
    expect(out.tried).toContain(path.join(nas, "missing/nothing.md"));
  });

  it("refuses a ../ escape without looking anywhere", async () => {
    const out = await resolveFileLink({ path: "../../outside/passwd.txt", source: source() }, ctx());
    expect(out.status).toBe("refused");
    expect(out.reason).toContain("climbs out");
    expect(out.tried).toEqual([]);
    expect(out.content).toBeNull();
  });

  it("never serves credential folders or secret files from a folder the chat named", async () => {
    const ssh = await resolveFileLink({ path: "id_rsa", source: source() }, ctx({ threadStrings: [`D=${home}/.ssh`] }));
    expect(ssh.status).toBe("unchecked");
    expect(ssh.content).toBeNull();
    const npmrc = await resolveFileLink({ path: ".npmrc", source: source() }, ctx({ threadStrings: [`D=${nas}/10_Reports`] }));
    expect(npmrc.status).toBe("unchecked");
    expect(npmrc.content).toBeNull();
    // A normal name in the credential folder is looked for and refused as well.
    const note = await resolveFileLink({ path: "notes.md", source: source() }, ctx({ threadStrings: [`D=${home}/.ssh`] }));
    expect(note.status).toBe("not-found");
    expect(note.content).toBeNull();
  });

  it("leaves a symlink that points out of the allowed folders to bb", async () => {
    const out = await resolveFileLink({ path: "link.txt", source: source() }, ctx());
    expect(out).toMatchObject({ status: "unchecked", content: null });
  });
});

describe("bb's own preview stays in charge unless the workspace was really checked", () => {
  it("opens a README.md in a workspace under /private/tmp (outside the allowed folders) normally", async () => {
    const scratch = path.join(top, "scratch");
    const out = await resolveFileLink({ path: "README.md", source: source() }, ctx({ workspaceRoot: scratch, sources: [scratch, nas] }));
    expect(out.status).toBe("unchecked");
    expect(out.content).toBeNull();
    const missing = await resolveFileLink({ path: "NOPE.md", source: source() }, ctx({ workspaceRoot: scratch, sources: [scratch, nas] }));
    expect(missing.status).toBe("unchecked");
    expect(missing.tried).toEqual([]);
  });

  it("does the same for a workspace under ~/.claude", async () => {
    const claude = path.join(home, ".claude/plans");
    const out = await resolveFileLink({ path: "README.md", source: source() }, ctx({ workspaceRoot: claude }));
    expect(out.status).toBe("unchecked");
  });

  it("does the same when the chat's environment has no path, or the folder is not on this Mac (a chat on Studio)", async () => {
    expect((await resolveFileLink({ path: "a.md", source: source() }, ctx({ workspaceRoot: null }))).status).toBe("unchecked");
    expect((await resolveFileLink({ path: "a.md", source: source() }, ctx({ workspaceRoot: path.join(home, "sam-only-folder") }))).status).toBe("unchecked");
  });

  it("reports not-found only when a readable workspace really lacks the file", async () => {
    const out = await resolveFileLink({ path: "absent.md", source: source() }, ctx());
    expect(out.status).toBe("not-found");
    expect(out.tried[0]).toBe(path.join(workspace, "absent.md"));
  });

  it("treats a workspace reached through a link to the NAS as the workspace, not as outside", async () => {
    const alias = path.join(home, "ShareAlias");
    const out = await resolveFileLink({ path: `${folder}/${file}`, source: source() }, ctx({ workspaceRoot: alias, sources: [alias, nas] }));
    expect(out.status).toBe("in-workspace");
    expect(out.realPath).toBe(path.join(nas, folder, file));
    expect(out.content).toBeNull();
  });
});

describe("Open in Finder and Open preview", () => {
  const roots = () => [home, "/Volumes"];
  it("refuses a script or app even when the card names it", async () => {
    for (const name of ["run.command", "tool.sh"]) {
      const out = await openOutsideFile({ path: path.join(nas, "10_Reports", name), mode: "open" }, roots(), home);
      expect(out.ok).toBe(false);
      expect(out.reason).toContain("Only md, markdown, html, htm, pdf, docx, pptx, xlsx");
    }
    expect((await openOutsideFile({ path: path.join(nas, "10_Reports/run.command"), mode: "reveal" }, roots(), home)).ok).toBe(false);
  });

  it("checks the real path, so a harmless-looking name that links to a script is refused", async () => {
    const out = await openOutsideFile({ path: path.join(nas, "10_Reports/innocent.md"), mode: "open" }, roots(), home);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("Only md");
  });

  it("refuses secrets, credential folders, other folders and missing files", async () => {
    expect((await openOutsideFile({ path: path.join(nas, "10_Reports/.npmrc"), mode: "open" }, roots(), home)).ok).toBe(false);
    expect((await openOutsideFile({ path: path.join(home, ".ssh/notes.md"), mode: "open" }, roots(), home)).ok).toBe(false);
    expect((await openOutsideFile({ path: path.join(top, "outside/passwd.txt"), mode: "open" }, roots(), home)).reason).toContain("outside your home folder");
    expect((await openOutsideFile({ path: path.join(nas, "gone.md"), mode: "open" }, roots(), home)).reason).toContain("could not be found");
    expect((await openOutsideFile({ path: "relative.md", mode: "open" }, roots(), home)).ok).toBe(false);
  });
});

describe("away from home", () => {
  it("touches the NAS only a few times and says what it skipped", async () => {
    const roots = Array.from({ length: 6 }, (_, index) => `/Volumes/Share${index}`);
    const out = await resolveFileLink({ path: "gone/report.md", source: source() }, ctx({ allowedRoots: [home, "/Volumes"], sources: [workspace, ...roots], away: true }));
    expect(out.status).toBe("not-found");
    expect(out.tried.filter((place) => place.startsWith("/Volumes/"))).toHaveLength(3);
    expect(out.reason).toContain("away from home");
    expect(out.reason).toContain("3 places on the NAS were not checked");
  });

  it("counts a home-folder link onto a volume as the NAS", async () => {
    const alias = path.join(home, "ShareLink");
    const out = await resolveFileLink({ path: file, source: source() }, ctx({ away: true, volumeAliases: [alias], threadStrings: ["a", "b", "c", "d", "e"].map((name) => `${alias}/${name}/${name}`) }));
    expect(out.status).toBe("not-found");
    expect(out.tried.filter((place) => place.startsWith(alias))).toHaveLength(3);
  });

  it("probes the NAS freely when at home", async () => {
    const roots = Array.from({ length: 6 }, (_, index) => `/Volumes/Share${index}`);
    const out = await resolveFileLink({ path: "gone/report.md", source: source() }, ctx({ allowedRoots: [home, "/Volumes"], sources: [workspace, ...roots], away: false }));
    expect(out.tried.filter((place) => place.startsWith("/Volumes/"))).toHaveLength(6);
  });
});

describe("folder hints from a thread", () => {
  it("reads absolute, home-relative and relative folders, newest first, and ignores URLs and variables", () => {
    const hints = collectPathHints([
      `cp a.md "$D/" && open https://example.com/a/b ~/Shared/10_Reports/report.pdf`,
      `see ${folder}/${file}, and ./local/x.md and ../up/y.md`,
    ], "/Users/sam");
    expect(hints).toEqual(["/Users/sam/Shared/10_Reports", folder]);
  });

  it("collects every string inside event data", () => {
    expect(eventStrings({ item: { command: "ls", nested: [{ text: "a" }, "b"] }, n: 1 })).toEqual(expect.arrayContaining(["ls", "a", "b"]));
  });
});

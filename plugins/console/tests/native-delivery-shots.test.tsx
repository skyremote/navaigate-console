// @vitest-environment jsdom
// With VIS_THREAD_SHOTS set to an output folder, renders each Delivery section with fixture data
// and writes a static page per section and mode from the real markup, for screenshots outside the app.
import React from "react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";

vi.mock("../src/delivery-shared", async (original) => ({
  ...(await original<typeof import("../src/delivery-shared")>()),
  TaskDraft: ({ purpose }: { purpose: string }) => (
    <div className="rounded border p-3 space-y-2">
      <p className="text-sm font-medium">Prepare {purpose} task</p>
      <button type="button" className="min-h-9 rounded border px-3 py-1 text-sm">Put task in this thread's composer</button>
    </div>
  ),
}));
vi.mock("@get-bb/plugin-sdk/app", async (original) => ({
  ...(await original<typeof import("@get-bb/plugin-sdk/app")>()),
  experimental_ProviderModelPicker: () => <div className="rounded border p-2 text-sm">Claude Opus 5.5 · high</div>,
}));
import { DeliveryPanel } from "../src/delivery";
import { DeliveryHeaderButton } from "../src/delivery-header";
import { ReviewTourPanel } from "../src/delivery-tour";
import { linkChanges } from "../host-delivery";
import { parseChangeSet } from "../review-tour";
import { prAvailable, worktreeView } from "./fixtures/delivery-worktrees";

const OUT = process.env.VIS_THREAD_SHOTS;
const ROOT = join(__dirname, "..");
const CSS = (process.env.VIS_THREAD_CSS ?? "").split(",").filter(Boolean);

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

const env = (id: string, name: string, hostId = "m5") => ({ id, projectId: "p1", hostId, name, path: `/w/${id}`, status: "ready" });
const queue = { readAt: 1, warnings: [], environments: [env("e-ready", "Stash after seven days"), env("e-pending", "Folder logos", "m1"), env("e-draft", "Mascot choice"), env("e-conflict", "Rail sort", "m1"), env("e-gl", "Docs site", "m4")] };
const results = {
  "e-ready": prAvailable("open", { number: 61, title: "Stash after seven days" }),
  "e-pending": prAvailable("open", { number: 62, title: "Folder logos", checks: { state: "pending", totalCount: 4, passedCount: 2, failedCount: 0, pendingCount: 2 } }),
  "e-draft": prAvailable("draft", { number: 63, title: "Mascot choice" }),
  "e-conflict": prAvailable("open", { number: 64, title: "Rail sort", mergeability: { state: "conflicts", mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } }),
  "e-gl": { outcome: "unavailable", message: "No GitHub PR status for this host" },
};
const staleRow = (id: string, name: string, idle: number, eligible: boolean, blockers: string[] = []) => ({
  environmentId: id, name, branch: `task/${id}`, hostId: "m5", hostName: "laptop", path: `/w/${id}`, lastActivityAt: 1, idleDays: idle,
  plan: { planId: `p-${id}`, fingerprint: `f-${id}`, eligible, blockers },
});
const TURSO = 'HTTP 403 from libsql: {"error":"Authorization header is invalid: token expired"}';
const evidence = (kind: string, url: string, title: string, observation: string, collector: string) => ({ sourceUrl: url, retrievedAt: "2026-11-01T09:00:00Z", kind, title, observation, collector });
const joined = {
  question: "How do other coding tools clean up stale worktrees?", duplicates: 2, sourceCount: 4, limitations: ["Evidence is supplied by the selected tools; this join does not establish complete coverage."],
  evidence: [
    evidence("issue", "https://github.com/pingdotgg/t3code/issues/412", "Worktree cleanup needs a dry run", "Maintainers want a list of stale worktrees before anything is removed.", "gh"),
    evidence("discussion", "https://github.com/pingdotgg/t3code/discussions/88", "Cleaning up after merged PRs", "Users ask for removal only after the PR merges and the tree is clean.", "gh"),
    evidence("video", "https://www.youtube.com/watch?v=t3tour", "T3 Code walkthrough", "The demo lists three stale worktrees and skips the one with local changes.", "transcripts"),
    evidence("web", "https://t3.codes/docs/worktrees", "Worktrees, T3 Code docs", "Cleanup never force-removes a worktree that has uncommitted work.", "web-search"),
  ],
};
const doctor = {
  createdAt: 1_800_000_000_000, self: { machine: "laptop", appVersion: "0.48.0" },
  broker: { state: "unavailable", lastSyncAt: 1_799_990_000_000, error: TURSO, directM1: "ready", directM1Error: null },
  machines: [
    { machine: "laptop", ok: true, activeRoute: "self", appVersion: "0.48.0", routes: [{ kind: "self", state: "healthy", detail: null }], binding: "verified enrolled host host-m5", error: null },
    { machine: "studio", ok: true, activeRoute: "ssh", appVersion: "0.48.1", routes: [{ kind: "ssh", state: "healthy", detail: "SSH OK" }, { kind: "broker", state: "unavailable", detail: "broker down" }], binding: "verified enrolled host host-m1", error: null },
    { machine: "work", ok: false, activeRoute: "none", appVersion: null, routes: [{ kind: "ssh", state: "unconfigured", detail: null }, { kind: "broker", state: "unavailable", detail: "no heartbeat" }], binding: "not proven (no route)", error: null },
  ],
  text: "",
};
const rpc = {
  delivery_queue: () => queue,
  pullRequests: () => results,
  delivery_settings: () => ({ revision: 0, entries: [], resolved: [], appliedTo: "delivery-tasks", remoteApplied: false }),
  delivery_worktrees: () => ({ ...worktreeView, environmentId: "e-ready" }),
  delivery_stale_worktrees: () => ({
    readAt: 1, staleAfterDays: 7, total: 4, guarded: true, warnings: [],
    rows: [staleRow("old-rail", "Rail experiments", 31, true), staleRow("old-logo", "Logo spike", 18, true), staleRow("old-doc", "Docs draft", 9, true), staleRow("old-wip", "Billing wip", 24, false, ["Tracked changes or untracked files are present."])],
  }),
  delivery_evidence_from_thread: () => ({ found: true, rejected: null, message: "Read 6 rows from the latest research answer; 4 remain after removing repeats.", joined }),
  delivery_fleet_doctor: () => doctor,
};
const sdk = { threads: { get: async () => ({ id: "t1", environmentId: "e-ready" }) } };
const mount = (node: React.ReactElement, extra: Record<string, unknown> = {}) =>
  renderSlot({ component: () => node }, {}, { sdk, rpc: { ...rpc, ...extra }, context: { projectId: "p1", threadId: "t1" } } as never);

const diff = [
  "diff --git a/src/rail.tsx b/src/rail.tsx", "--- a/src/rail.tsx", "+++ b/src/rail.tsx", "@@ -10,3 +10,4 @@", " x", "+y", " z", "@@ -80 +81 @@", "-q", "+r",
  "diff --git a/src/stash.ts b/src/stash.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/stash.ts", "@@ -0,0 +1,40 @@", ...Array.from({ length: 40 }, (_, i) => `+line ${i}`),
  "diff --git a/tests/stash.test.ts b/tests/stash.test.ts", "new file mode 100644", "--- /dev/null", "+++ b/tests/stash.test.ts", "@@ -0,0 +1,12 @@", ...Array.from({ length: 12 }, (_, i) => `+t ${i}`), "",
].join("\n");
const changes = linkChanges(parseChangeSet(diff), "https://github.com/example/x/pull/61", "github");

const pages = new Map<string, string>();
function frame(name: string, view: ReturnType<typeof mount>) {
  const header = document.createElement("div");
  header.innerHTML = `<div class="flex h-10 items-center gap-1 border-b px-3 text-sm"><span class="mr-auto font-medium">Stash after seven days</span>`
    + `<span data-slot="header-buttons"></span></div>`;
  pages.set(name, `${header.innerHTML}<div class="mx-auto" style="max-width:860px">${view.container.innerHTML}</div>`);
}

describe.skipIf(!OUT)("Delivery screenshots", () => {
  it("renders every section", async () => {
    let v = mount(<DeliveryPanel threadId="t1" />);
    await waitFor(() => v.getByText(/#61 Stash after seven days/));
    fireEvent.click(v.getByText(/#61 Stash after seven days/));
    frame("pull-requests", v);
    cleanup();

    v = mount(<DeliveryPanel threadId="t1" section="worktrees" />);
    await waitFor(() => v.getByRole("table", { name: "Stale worktrees" }));
    await waitFor(() => v.getByLabelText("Shared base"));
    fireEvent.click(v.getAllByRole("button", { name: "Review changes" })[0]);
    frame("worktrees", v);
    cleanup();

    v = mount(<DeliveryPanel threadId="t1" section="worktrees" />);
    await waitFor(() => v.getByLabelText("Shared base"));
    fireEvent.click(v.getAllByRole("button", { name: /Merge into main/ })[0]);
    frame("worktrees-confirm", v);
    cleanup();

    v = mount(<ReviewTourPanel changes={changes} />);
    fireEvent.click(v.getByLabelText("Mark src/rail.tsx reviewed"));
    fireEvent.click(v.getByRole("button", { name: "Next unreviewed stop" }));
    const open = v.container.querySelector("details");
    open?.setAttribute("open", "");
    fireEvent.change(v.getByLabelText("Tour to check"), { target: { value: `Stop 1: Rail order\nsrc/rail.tsx ${changes[0].hunks[0].link}\nStop 2: Stash\nsrc/stash.ts` } });
    frame("review-tour", v);
    cleanup();

    v = mount(<DeliveryPanel threadId="t1" section="research" />);
    fireEvent.change(v.getByLabelText("Research question"), { target: { value: "How do other coding tools clean up stale worktrees?" } });
    fireEvent.click(v.getByLabelText(/GitHub issues/));
    fireEvent.click(v.getByLabelText(/YouTube transcripts/));
    fireEvent.click(v.getByLabelText(/Web search/));
    fireEvent.click(v.getByRole("button", { name: "Read evidence from this thread" }));
    await waitFor(() => v.getByRole("table", { name: "Collected evidence" }));
    fireEvent.click(v.getByRole("button", { name: "Build cited report" }));
    frame("research", v);
    cleanup();

    v = mount(<DeliveryPanel threadId="t1" section="diagnosis" />);
    fireEvent.click(v.getByRole("button", { name: "Run fleet doctor" }));
    await waitFor(() => v.getByLabelText("Broker error"));
    frame("diagnosis", v);
    cleanup();

    const button = mount(<DeliveryHeaderButton threadId="t1" />);
    await waitFor(() => button.getByRole("button", { name: /Likely ready/ }));
    pages.set("header-button", `<div class="flex h-10 items-center gap-1 border-b px-3 text-sm"><span class="mr-auto font-medium">Stash after seven days</span>${button.container.innerHTML}</div>`);
    cleanup();

    mkdirSync(OUT!, { recursive: true });
    const shared = CSS.map((file) => readFileSync(file, "utf8")).join("\n");
    const themeCss = readFileSync(join(ROOT, "themes/navaigate.css"), "utf8");
    for (const mode of ["light", "dark"])
      for (const [name, html] of pages)
        writeFileSync(join(OUT!, `${name}-${mode}.html`),
          `<!doctype html><html lang="en-GB" class="${mode}"><head><meta charset="utf-8"><title>${name} ${mode}</title><style>${shared}</style><style>${themeCss}</style>`
          + `<style>body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px} .bg-amber-500\\/10{background:rgba(245,158,11,.1)} .border-amber-500\\/50{border-color:rgba(245,158,11,.5)} .align-top{vertical-align:top} .gap-x-3{column-gap:.75rem} progress{height:.5rem;width:6rem}</style></head>`
          + `<body data-bb-plugin="navaigate-skin">${html}</body></html>`);
  });
});

// @vitest-environment jsdom
// Renders the composer-surface changes with fixture data and writes one HTML
// page per scene when VIS_COMPOSER_OUT is set; otherwise it only checks that
// every scene renders.
import React from "react";
import { act, cleanup, configure, fireEvent, screen, waitFor } from "@testing-library/react";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { NewThreadComposerProps } from "@get-bb/plugin-sdk/app";

const keyed = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    experimental_NewThreadComposer: (props: NewThreadComposerProps) => <div className="rounded-lg border border-border bg-card px-3 py-6 text-sm text-muted-foreground" data-testid="native-composer">{props.initialPrompt?.split("\n")[0] ?? ""}<br />{props.placeholder}</div>,
    experimental_useRpcKeyedQuery: () => ({ data: keyed.data, error: null, refetch: async () => undefined }),
    useRealtimeConnectionState: () => "connected",
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { NativeWorkComposer } from "../src/native-work-composer";
import { ComposerChips } from "../src/composer-chips";
import { TeleportReceipt, teleportReceiptLines } from "../src/composer-chips";
import { ComposerThreadDrop } from "../src/composer-thread-drop";
import { publishComposerHandle, unpublishComposerHandle } from "../src/composer-bridge";
import { DeliveryPanel } from "../src/delivery";
import { ContextWorkspacePopup } from "../src/context-workspace";

configure({ asyncUtilTimeout: 5000 });
const OUT = process.env.VIS_COMPOSER_OUT;
const CSS = (process.env.VIS_COMPOSER_CSS ?? "").split(",").filter(Boolean).map((file) => readFileSync(file, "utf8")).join("\n");
const THEME = process.env.VIS_COMPOSER_THEME ? readFileSync(process.env.VIS_COMPOSER_THEME, "utf8") : "";
const MODE = process.env.VIS_COMPOSER_MODE ?? "light";

function snap(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  const live = [...root.querySelectorAll("select, input, textarea")];
  [...clone.querySelectorAll("select, input, textarea")].forEach((copy, index) => {
    const source = live[index] as HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement;
    if (copy instanceof HTMLSelectElement) [...copy.options].forEach((option, at) => { if ((source as HTMLSelectElement).selectedIndex === at) option.setAttribute("selected", ""); else option.removeAttribute("selected"); });
    else if (copy instanceof HTMLTextAreaElement) copy.textContent = (source as HTMLTextAreaElement).value;
    else if ((source as HTMLInputElement).type === "checkbox") { if ((source as HTMLInputElement).checked) copy.setAttribute("checked", ""); else copy.removeAttribute("checked"); }
    else copy.setAttribute("value", (source as HTMLInputElement).value);
  });
  return clone.innerHTML;
}

function page(name: string, title: string, html: string, width = 640) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const head = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  writeFileSync(join(OUT, `${name}-${MODE}.html`), `<!doctype html><html lang="en-GB" class="${MODE}"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style><style>${THEME}</style><style>${head}</style><style>body{margin:0;padding:24px;background:var(--background);color:var(--foreground);font-family:var(--font-sans, system-ui)} .shot{width:${width}px;margin:0 auto} .cap{margin:0 0 12px;font:600 13px/1.3 system-ui;color:var(--muted-foreground)}</style></head><body><div class="shot" data-bb-plugin="navaigate-skin"><p class="cap">${title}</p>${html}</div></body></html>`);
}

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => { items.set(name, String(value)); }, removeItem: (name: string) => { items.delete(name); }, clear: () => items.clear(), key: () => null, get length() { return items.size; } });
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; unpublishComposerHandle("new"); keyed.data = {}; vi.unstubAllGlobals(); vi.clearAllMocks(); });

const NOW = Date.now();
const clockTime = (offsetMinutes: number) => NOW - offsetMinutes * 60_000;
const COMMIT = "5dc2c537ad2762caa162adb34aff7d1e9cecc081";
const project = { id: "proj_test", name: "NavAIgate", kind: "standard", createdAt: 1, updatedAt: 1, gitRemoteUrl: null, sources: [] };
const route = (machine: string | null, reason: string) => ({ machine, serverId: machine ? "srv" : null, hostId: null, mode: "auto" as const, reason, warnings: [], candidates: [] });
const previewFixture = {
  route: route("studio", "Selected Studio's independent owner from fresh eligible CPU/RAM capacity"), refusal: null, checkedAt: NOW,
  machines: [
    { machine: "studio", chosen: true, eligible: true, reasons: [], score: 7.4, xcode: { verified: true, version: "26.1" }, providers: [
      { id: "claude-code", name: "Claude Code", available: true, auth: "ready", observedAt: clockTime(1), planLabel: "Max" },
      { id: "codex", name: "Codex", available: true, auth: "ready", observedAt: clockTime(1), planLabel: "Pro" },
      { id: "cursor", name: "Cursor", available: false, auth: "unauthenticated", observedAt: clockTime(4), planLabel: null },
      { id: "opencode", name: "opencode", available: true, auth: "ready", observedAt: clockTime(1), planLabel: null },
    ] },
    { machine: "work", chosen: false, eligible: false, reasons: ["Work requires an explicitly Clientco workload"], score: null, xcode: { verified: true, version: "26.0.1" }, providers: [{ id: "claude-code", name: "Claude Code", available: true, auth: "ready", observedAt: clockTime(2), planLabel: "Max" }] },
    { machine: "laptop", chosen: false, eligible: false, reasons: ["The host has insufficient available CPU or RAM"], score: null, xcode: { verified: false, version: null }, providers: null },
  ],
};
const usage = { usage: { status: "ok", accountEmail: "sam@example.test", planLabel: "Max", windows: [
  { label: "Session", kind: "five-hour", usedPercent: 34, resetsAt: new Date(NOW + 2.2 * 3_600_000).toISOString() },
  { label: "Weekly", kind: "weekly", usedPercent: 71, resetsAt: new Date(NOW + 30 * 3_600_000).toISOString() },
] } };
const summary = { format: "portable-v1" as const, createdAt: NOW, sourceMachine: "laptop", sourceThreadId: "thr_source", commit: COMMIT, repository: "verified" as const, decisions: 3, decisionTexts: ["Decision: ship the route preview on Friday", "We agreed to keep the text fallback"], messages: 40, omittedMessages: 12, omittedAttachments: 2, files: [{ path: "docs/plan.md", sha256: "a".repeat(64), sizeBytes: 2048 }] };
const bundle = { schema: "navaigate.portable-context", version: 1, createdAt: NOW, narrative: { brief: {}, decisions: [], messages: [], omitted: { messageIds: [], attachmentIds: [] }, provenance: "caller-supplied" }, source: { owner: { serverId: "s", machineKey: "laptop", hostId: "h", environmentId: "e", projectId: "p" }, workspace: {}, repository: { verification: "unknown", reason: "x" } }, files: [] };

function newWork(rpc: Record<string, (input: unknown) => unknown> = {}) {
  return renderSlot({ component: NativeWorkComposer }, { rootThreadId: "thr_root", sourceThreadId: "thr_source", projectId: "proj_test", defaultSelection: { providerId: "claude-code", model: "opus", reasoningLevel: "high" } }, {
    rpc: { native_session_adopt: () => ({}), native_route_preview: () => previewFixture, pool_account: () => ({ accountId: "acc", activeAccountId: "acc" }), ...rpc } as never,
    sdk: { threads: { spawn: async () => makeThreadResponse({ id: "t", projectId: "proj_test", environmentId: null }) }, projects: { get: async () => project }, plugins: { callRpc: async () => usage as never } } as never,
  });
}
const choose = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
const settle = (ms = 500) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

describe("composer-surface scenes", () => {
  it("New work: route preview, provider availability, Needs Xcode and allowance", async () => {
    const view = newWork();
    choose("Auto");
    fireEvent.click(screen.getByLabelText("Needs Xcode"));
    await screen.findByTestId("route-preview");
    await waitFor(() => expect(screen.getByTestId("route-preview").textContent).toContain("Auto would start on Studio"));
    await waitFor(() => expect(screen.getByTestId("allowance-chip").textContent).toContain("left"));
    page("new-work-route-preview", "New work, Where it runs: Auto with the route preview", snap(view.container));
  });

  it("New work: a refusal is shown before sending", async () => {
    const view = newWork({ native_route_preview: () => ({ route: null, refusal: "Work requires an explicitly Clientco workload", checkedAt: NOW, machines: previewFixture.machines.filter((machine) => machine.machine === "work") }) });
    choose("Work");
    await waitFor(() => expect(screen.getByTestId("route-preview").textContent).toContain("Would not start"));
    page("new-work-route-refusal", "New work: Work without an Clientco workload is refused before sending", snap(view.container));
  });

  it("New work: context bundle files, export and a saved bundle", async () => {
    const view = newWork({ native_context_inspect: () => summary });
    choose("Studio");
    fireEvent.click(screen.getByLabelText("Send structured context"));
    fireEvent.change(screen.getByLabelText("Files to carry"), { target: { value: "docs/plan.md\nREADME.md" } });
    await waitFor(() => expect(screen.getByTestId("route-preview").textContent).toContain("would start on Studio"));
    page("new-work-context-files", "New work: structured context with files to carry, and a download button", snap(view.container));
    fireEvent.change(screen.getByLabelText("Use a saved context bundle"), { target: { files: [new File([JSON.stringify(bundle)], "release-context.json", { type: "application/json" })] } });
    await screen.findByTestId("context-summary");
    await waitFor(() => expect(screen.getByTestId("route-preview").textContent).toContain("would start on Studio"));
    page("new-work-context-saved", "New work: a saved context bundle attached, with what it holds", snap(view.container));
  });

  it("Receipt: the context that arrived", async () => {
    localStorage.setItem("navaigate:native-work:native-work:thr_root", JSON.stringify({
      requestId: "00000000-0000-4000-8000-000000000000", payloadHash: "h", machine: "studio", notified: true, savedAt: 1,
      receipt: { outcome: "started", requestId: "00000000-0000-4000-8000-000000000000", threadId: "thr_remote", localThreadId: "thr_mirror", commandId: null, url: null, route: { machine: "studio", serverId: "srv", hostId: null, mode: "manual", reason: "Studio was chosen explicitly.", warnings: [], candidates: [] }, warning: null,
        context: { format: "portable-v1", state: "delivered", manifestPath: ".bb/fleet-context/0000/context.json", manifestSha256: "c".repeat(64), commit: COMMIT, decisions: 3, messages: 40, omittedMessages: 12, omittedAttachments: 2, files: [{ path: "docs/plan.md", sha256: "a".repeat(64) }] } },
    }));
    const view = newWork({ native_work_receipt: () => JSON.parse(localStorage.getItem("navaigate:native-work:native-work:thr_root")!).receipt });
    await screen.findByTestId("context-arrival");
    page("receipt-context-arrival", "Receipt after sending: what the context bundle carried and that it arrived", snap(view.container));
  });

  it("New chat: the allowance under the chat box", async () => {
    document.body.innerHTML = `<div class="rounded-xl border border-border bg-card p-3 text-sm" data-app-composer-role="primary"><form>Opus 4.5 Max<br><span class="text-muted-foreground">Ask the agent to do something…</span></form></div><div data-new-thread-footer class="mt-1 flex items-center text-xs"><div class="flex items-center gap-1"></div></div>`;
    Object.defineProperty(document.querySelector("form")!, "innerText", { value: "Opus 4.5 Max" });
    renderSlot({ component: ComposerChips }, {}, {
      rpc: { m1_machine: () => ({ hostId: "h", connected: true, sourcePath: "/Volumes/Shared/x", suggestedPath: null, localHostId: "l", localPath: "/Users/sam/x" }), pool_list: () => ({ accounts: [] }), pool_account: () => ({ accountId: "acc", activeAccountId: "acc" }) } as never,
      sdk: { plugins: { callRpc: async () => usage as never } } as never,
    });
    await screen.findByTestId("allowance-chip");
    page("new-chat-allowance", "New chat: the allowance left sits beside the chat box chips", document.body.innerHTML, 560);
  });

  it("Chat box: a rail chat dragged over it", async () => {
    document.body.innerHTML = `<div data-app-composer-role="primary"><div data-promptbox-shell class="rounded-xl border border-border bg-card p-4 text-sm"><form><div class="editor min-h-12" contenteditable>Compare this with the earlier plan…</div></form></div></div>`;
    publishComposerHandle("new", { api: { insert: vi.fn(), focus: vi.fn() } as never, view: {} as never });
    window.history.pushState({}, "", "/");
    renderSlot({ component: ComposerThreadDrop }, {}, {});
    const editor = document.querySelector(".editor")!;
    fireEvent.dragOver(editor, { dataTransfer: { types: ["application/x-nav-thread"], getData: () => "", dropEffect: "none" } });
    page("chat-box-drop", "Chat box: dragging a chat from the rail over it outlines the box", document.body.innerHTML, 560);
  });

  it("Teleport: the receipt", () => {
    const lines = teleportReceiptLines({
      newThreadId: "thr_m1", via: "machine", url: null, commit: { sha: "59b6272aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ref: "teleport/thr_x", carried: true },
      verified: { machine: "studio", ok: true, sha: "59b6272aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "Studio's clone has 59b6272 on teleport/thr_x." },
      notes: ["Uncommitted work pushed as WIP commit 59b6272aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa on teleport/thr_x; main was not touched."],
    });
    const { container } = renderSlot({ component: () => <div className="rounded-lg border border-border bg-popover p-3 text-sm shadow-lg"><p className="mb-1 font-medium">Moved to Studio</p><div className="text-xs text-muted-foreground"><TeleportReceipt lines={lines} /></div></div> }, {}, {});
    page("teleport-receipt", "Move this chat to Studio: the receipt shows the commit and the clone check", container.innerHTML, 480);
  });

  it("Delivery: hosts named, GitLab merge request in the list", async () => {
    const env = (id: string, name: string) => ({ id, projectId: "p", hostId: "host_m5", name, path: `/work/${id}`, status: "ready" });
    keyed.data = {
      gh: { outcome: "available", pullRequest: { number: 12, title: "Fix the retry path", state: "open", url: "https://github.com/a/b/pull/12", baseRefName: "main", headRefName: "fix", updatedAt: "2026-10-30T12:00:00Z", autoMerge: false, inMergeQueue: false, checks: { state: "passing", totalCount: 1, passedCount: 1, failedCount: 0, pendingCount: 0 }, review: { state: "approved", reviewRequestCount: 0 }, mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, attention: "ready_to_merge" } },
      gl: { outcome: "absent" }, bb: { outcome: "absent" }, az: { outcome: "absent" },
    };
    const mr = { provider: "gitlab", host: "gitlab.com", hostKind: "gitlab", url: "https://gitlab.com/g/r/-/merge_requests/7", revision: "abcdef1", text: JSON.stringify({ mergeRequest: { iid: 7, title: "Tidy the importer", state: "opened" }, notes: [] }), diff: "", truncated: false, readAt: NOW, warnings: [] };
    const view = renderSlot({ component: () => <DeliveryPanel /> }, {}, {
      rpc: {
        delivery_queue: () => ({ readAt: NOW, environments: [env("gh", "api-service"), env("gl", "importer"), env("bb", "legacy-billing"), env("az", "partner-portal")], warnings: [] }),
        delivery_hosts: () => ({ gl: { host: "gitlab.com", hostKind: "gitlab", label: "GitLab", reviewAdapter: true }, bb: { host: "bitbucket.org", hostKind: "bitbucket", label: "Bitbucket", reviewAdapter: false }, az: { host: "dev.azure.com", hostKind: "azure", label: "Azure DevOps", reviewAdapter: false } }),
        delivery_review: () => mr,
        delivery_settings: () => ({ revision: 0, entries: [], resolved: ["title", "commit", "pull-request", "review", "research"].map((purpose) => ({ purpose, choice: null, inheritedFrom: null })) }),
      } as never,
      sdk: { threads: { get: async () => ({ environmentId: null }) } } as never,
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /legacy-billing/ }).textContent).toContain("Bitbucket: no review adapter yet"));
    page("delivery-hosts-before", "Delivery: each workspace names its Git host instead of showing nothing", snap(view.container));
    fireEvent.click(screen.getByRole("button", { name: "Read GitLab merge requests" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Tidy the importer/ })).toBeTruthy());
    page("delivery-hosts-after", "Delivery: the GitLab merge request now sits in the list as !7", snap(view.container));
  });

  it("Reviews: the guest link lifetime picker", async () => {
    const view = renderSlot({ component: ContextWorkspacePopup }, {}, {
      context: { projectId: "proj_test", threadId: null }, composer: { text: "Draft", scope: { kind: "new-thread" } },
      rpc: { context_drafts_list: () => [], context_reviews_list: () => [] } as never, sdk: { projects: { get: async () => project } } as never,
    });
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));
    fireEvent.change(await screen.findByLabelText("Exact quoted text"), { target: { value: "The preview ships on Friday." } });
    fireEvent.click(screen.getByRole("button", { name: "Add excerpt to review selection" }));
    fireEvent.change(await screen.findByLabelText("Review title"), { target: { value: "Release plan" } });
    fireEvent.change(screen.getByLabelText("Guest link expiry"), { target: { value: "1440" } });
    page("reviews-24h", "Reviews tab: a guest link can last 1 hour or 24 hours", snap(view.container));
    expect((screen.getByLabelText("Guest link expiry") as HTMLSelectElement).value).toBe("1440");
  });
});

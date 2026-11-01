// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DeliveryDetail } from "../src/delivery";
import { HomePage } from "../src/home";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
import type { PullRequest } from "../delivery-contract";

const png = new Uint8Array(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
const pr: PullRequest = {
  number: 7, title: "Console: drag a chat into the composer", state: "open", url: "https://github.com/acme/widgets/pull/7", baseRefName: "main", headRefName: "fix", updatedAt: "2026-10-30T12:00:00Z",
  autoMerge: false, inMergeQueue: false,
  checks: { state: "passing", totalCount: 3, passedCount: 3, failedCount: 0, pendingCount: 0 },
  review: { state: "approved", reviewRequestCount: 0 },
  mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" }, attention: "ready_to_merge",
};
const environment = { id: "e1", projectId: "p1", hostId: "laptop", name: "vis-none", path: "/tmp/bbwt/vis-none", status: "ready" };
const receipt = {
  uploaded: true as const, repo: "acme/widgets", pr: 7, prUrl: pr.url, branch: "delivery-proof", commit: "c0ffee1234567890".repeat(2).slice(0, 40), uploadedAt: "2026-11-01T10:00:00Z",
  accessPolicy: "Private repository: visible only to people with read access to acme/widgets.", expiry: "None: kept until the delivery-proof branch is deleted.",
  files: [{ name: "after.png", bytes: png.length, mime: "image/png", sha256: "d".repeat(64), path: "pr-7/20261101T100000Z/dddddddddddd-after.png", url: "https://github.com/acme/widgets/blob/c0ffee/pr-7/x/after.png?raw=true", verified: true }],
  comment: { id: 1, url: "https://github.com/acme/widgets/pull/7#issuecomment-9001", verified: true },
};

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => cleanup());

function mount(result: unknown, handler = vi.fn(async () => receipt)) {
  const callRpc = vi.fn(async () => ({ ok: true }));
  const view = renderSlot(
    { component: () => <DeliveryDetail environment={environment} result={result as never} /> },
    {},
    { rpc: { delivery_attach_proof: handler } as never, sdk: { plugins: { callRpc } as never } },
  );
  return { view, handler, callRpc };
}
const open = (over: Partial<PullRequest> = {}) => ({ outcome: "available", pullRequest: { ...pr, ...over } });
const pickFile = async (name = "after.png", bytes: Uint8Array = png) => {
  const input = screen.getByLabelText("Choose proof files") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([bytes], name, { type: "image/png" })] } });
  await screen.findByText(name);
};

describe("Attach proof to PR action", () => {
  it.each([["open"], ["draft"]])("shows the action in the pull request section of a %s PR", (state) => {
    mount(open({ state: state as PullRequest["state"] }));
    const section = screen.getByRole("region", { name: "Selected pull request" });
    expect(within(section).getByRole("button", { name: "Attach proof to PR…" })).toBeTruthy();
  });

  it.each([["merged"], ["closed"]])("hides the action on a %s PR", (state) => {
    mount(open({ state: state as PullRequest["state"] }));
    expect(screen.queryByRole("button", { name: "Attach proof to PR…" })).toBeNull();
  });

  it("hides the action when the branch has no PR", () => {
    mount({ outcome: "absent" });
    expect(screen.queryByRole("button", { name: "Attach proof to PR…" })).toBeNull();
  });

  it("opens a form that names the repository destination and keeps upload disabled until a file and the redaction tick are set", async () => {
    mount(open());
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    expect(form.textContent).toContain("acme/widgets");
    expect(form.textContent).toContain("delivery-proof");
    const send = within(form).getByRole("button", { name: /Upload and comment on #7/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await pickFile();
    expect(send.disabled).toBe(true);
    fireEvent.click(within(form).getByRole("checkbox"));
    expect(send.disabled).toBe(false);
  });

  it("lists the chosen file with its size, type and checksum and lets it be removed", async () => {
    mount(open());
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    await pickFile();
    const list = screen.getByRole("list", { name: "Files to attach" });
    expect(list.textContent).toContain("image/png");
    expect(list.textContent).toMatch(/sha256 [0-9a-f]{12}/);
    fireEvent.click(screen.getByRole("button", { name: "Remove after.png" }));
    expect(screen.queryByRole("list", { name: "Files to attach" })).toBeNull();
  });

  it("refuses a non-media file and text renamed to png, with a visible reason", async () => {
    mount(open());
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    const input = screen.getByLabelText("Choose proof files") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["{}"], "diagnosis.json"), new File(["not an image at all"], "fake.png")] } });
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBe(2));
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/diagnosis\.json/);
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toMatch(/fake\.png does not look like image\/png/);
    expect(screen.queryByRole("list", { name: "Files to attach" })).toBeNull();
  });

  it("blocks an invalid proof branch", async () => {
    mount(open());
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    await pickFile();
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.change(within(form).getByLabelText("Proof branch"), { target: { value: "../escape" } });
    expect((within(form).getByRole("button", { name: /Upload and comment/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([["main"], ["qa/proof"]])("blocks %s because it is not a delivery-proof branch and says why", async (branch) => {
    mount(open());
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    await pickFile();
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.change(within(form).getByLabelText("Proof branch"), { target: { value: branch } });
    expect((within(form).getByRole("button", { name: /Upload and comment/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByRole("alert").textContent).toMatch(/delivery-proof/);
  });

  it.each([["headRefName"], ["baseRefName"]])("blocks a proof branch equal to the pull request's %s", async (key) => {
    mount(open({ [key]: "delivery-proof" } as Partial<PullRequest>));
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    await pickFile();
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    fireEvent.click(within(form).getByRole("checkbox"));
    expect((within(form).getByRole("button", { name: /Upload and comment/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByRole("alert").textContent).toMatch(/pull request/i);
  });

  it("releases the preview link of a removed file once, and of the sent files after a successful upload", async () => {
    const created = vi.fn((_: unknown) => `blob:${created.mock.calls.length}`);
    const revoked = vi.fn();
    URL.createObjectURL = created as never;
    URL.revokeObjectURL = revoked as never;
    mount(open());
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    await pickFile("one.png");
    await pickFile("two.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove one.png" }));
    expect(revoked.mock.calls.map((c) => c[0])).toEqual(["blob:1"]);
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(within(form).getByRole("button", { name: /Upload and comment on #7/ }));
    await screen.findByRole("status", { name: "Proof receipt" });
    expect(revoked.mock.calls.map((c) => c[0])).toEqual(["blob:1", "blob:2"]);
  });

  it("sends the explicit-action request, then shows the comment and file links from the receipt", async () => {
    const { handler, callRpc } = mount(open());
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    await pickFile();
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    fireEvent.change(within(form).getByLabelText(/Note above the media/), { target: { value: "Fix verified on Laptop" } });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(within(form).getByRole("button", { name: /Upload and comment on #7/ }));
    await screen.findByRole("status", { name: "Proof receipt" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      environmentId: "e1", intent: "explicit-user-action", confirmRedacted: true, expectedUrl: pr.url, expectedUpdatedAt: pr.updatedAt, note: "Fix verified on Laptop", branch: "delivery-proof",
      files: [{ name: "after.png", dataBase64: Buffer.from(png).toString("base64") }],
    });
    const status = screen.getByRole("status", { name: "Proof receipt" });
    expect((within(status).getByRole("link", { name: "Open the comment on GitHub" }) as HTMLAnchorElement).href).toBe(receipt.comment.url);
    expect((within(status).getByRole("link", { name: "after.png" }) as HTMLAnchorElement).href).toBe(receipt.files[0].url);
    expect(status.textContent).toContain("Private repository");
    await waitFor(() => expect(callRpc).toHaveBeenCalledWith(expect.objectContaining({ method: "refresh" })));
  });

  it("shows the server's refusal and keeps the chosen files", async () => {
    const handler = vi.fn(async () => { throw new Error("The PR changed after this panel was read."); });
    mount(open(), handler as never);
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    await pickFile();
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(within(form).getByRole("button", { name: /Upload and comment/ }));
    await screen.findByText(/PR changed after this panel was read/);
    expect(screen.getByRole("list", { name: "Files to attach" })).toBeTruthy();
  });

  it("reports stored files and a failed comment honestly", async () => {
    const partial = { ...receipt, comment: null, error: "The media is stored but the comment failed: Resource not accessible" };
    mount(open(), vi.fn(async () => partial) as never);
    fireEvent.click(screen.getByRole("button", { name: "Attach proof to PR…" }));
    await pickFile();
    const form = screen.getByRole("group", { name: "Attach proof to PR" });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(within(form).getByRole("button", { name: /Upload and comment/ }));
    const status = await screen.findByRole("status", { name: "Proof receipt" });
    expect(status.textContent).toContain("the comment did not post");
    expect(within(status).queryByRole("link", { name: "Open the comment on GitHub" })).toBeNull();
    expect(status.textContent).toContain("Resource not accessible");
  });
});

describe("Delivery is reachable from the Console", () => {
  it("opens the Delivery page from a button in the Home header", async () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
    const rpc = {
      home_accounts: () => ({ accounts: [] }),
      usage_trend: () => ({ now: Date.now(), sampledFrom: null, accounts: [] }),
      home_brief: () => ({ headline: null, date: null }),
      home_agenda: () => ({ configured: true, error: null, reconnect: [], events: [] }),
      ask_log: () => ({ recent: [], jevDecisions: 0, overrides: 0 }),
      fleet_board: () => ({ available: false, board: null, error: "offline" }),
    };
    const view = renderSlot({ component: HomePage }, {}, { rpc: rpc as never });
    fireEvent.click(screen.getByRole("button", { name: "Delivery and PR proof" }));
    expect(view.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "delivery" }]);
    vi.unstubAllGlobals();
  });
});

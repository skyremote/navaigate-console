// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { toast } from "sonner";
import { WebhookSettings } from "../src/webhooks";
import type { WebhookFormState } from "../server-webhook-admin";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const receipt = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  hookId: "ci-failed",
  binding: { id: "ci-failed", ownerServerId: "srv-laptop", hostId: "host-m5", projectId: "proj_test", automationId: "auto_1" },
  bindingFingerprint: "a".repeat(64),
  deliveryId: "delivery-1",
  receivedAt: 1_800_000_000_000,
  expiresAt: 1_800_086_400_000,
  dueAt: 1_800_000_000_000,
  state: "owner-accepted",
  runId: "arun_1",
  count: 1,
  error: null,
  ...over,
});
const hook = {
  id: "ci-failed",
  enabled: true,
  holdOffline: true,
  coalesceSeconds: 0,
  ownerServerId: "srv-laptop",
  hostId: "host-m5",
  projectId: "proj_test",
  projectName: "Native BB acceptance",
  automationId: "auto_1",
  agent: { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "low", prompt: "Reply with ACK." },
  agentError: null,
};
const base: WebhookFormState = {
  masterEnabled: true,
  publicBaseUrl: "https://laptop.example.test",
  endpoint: "https://laptop.example.test/api/v1/plugins/navaigate-skin/http/automation-hook",
  secretSet: true,
  owner: { serverId: "srv-laptop", machine: "laptop" },
  hooks: [hook],
  deliveries: [receipt(), receipt({ id: "r2", deliveryId: "delivery-2", state: "held", runId: null, error: "Owning server or execution host is offline." })],
};

const writeText = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  writeText.mockClear();
});
afterEach(cleanup);

function show(rpc: Record<string, (input: any) => unknown>, form: WebhookFormState = base) {
  return renderSlot({ component: WebhookSettings }, {}, {
    rpc: {
      webhook_form: () => form,
      webhook_projects: () => [{ id: "proj_test", name: "Native BB acceptance" }],
      ...rpc,
    },
    sdk: { providers: { models: async () => ({ models: [{ model: "claude-opus-5-5" }, { model: "claude-sonnet-5-5" }] }) } } as never,
  } as never);
}

describe("webhook settings form", () => {
  it("shows the URL with a copy button and the recent deliveries", async () => {
    show({});
    const url = (await screen.findByLabelText("Webhook URL")) as HTMLInputElement;
    expect(url.value).toBe(base.endpoint);
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(base.endpoint));
    const list = screen.getByRole("region", { name: "Recent deliveries" });
    expect(within(list).getByText("Started")).toBeTruthy();
    expect(within(list).getByText(/Held: the owning machine is offline/)).toBeTruthy();
    expect(within(list).getByText("Owning server or execution host is offline.")).toBeTruthy();
    expect(within(list).getByText(/run arun_1/)).toBeTruthy();
  });

  it("shows a new secret once, copies it, and never asks the server for it again", async () => {
    const secret = "f".repeat(64);
    const calls: string[] = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    show({ webhook_secret_regenerate: () => (calls.push("regenerate"), { secret }) });
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    const shown = (await screen.findByLabelText("New signing secret")) as HTMLInputElement;
    expect(shown.value).toBe(secret);
    fireEvent.click(screen.getByRole("button", { name: "Copy secret" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(secret));
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByLabelText("New signing secret")).toBeNull();
    expect(calls).toEqual(["regenerate"]);
  });

  it("does not regenerate a set secret unless the person confirms", async () => {
    const calls: string[] = [];
    vi.spyOn(window, "confirm").mockReturnValue(false);
    show({ webhook_secret_regenerate: () => (calls.push("x"), { secret: "s" }) });
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it("offers Generate when no secret exists", async () => {
    show({}, { ...base, secretSet: false });
    expect(await screen.findByRole("button", { name: "Generate" })).toBeTruthy();
    expect(screen.getByText(/every webhook is refused/)).toBeTruthy();
  });

  it("sends a test event for a hook and reports what the server did", async () => {
    const sent: unknown[] = [];
    show({ webhook_test: (input) => (sent.push(input), { status: 202, deliveryId: "test-1", outcome: "accepted (accepted)", receipt: null }) });
    fireEvent.click(await screen.findByRole("button", { name: "Send test event" }));
    const ok = await screen.findByText(/Test event: accepted \(accepted\)/);
    expect(ok.textContent).toBe("Test event: accepted (accepted). Starting the task happens within a minute.");
    expect(sent).toEqual([{ id: "ci-failed" }]);
  });

  it("reports a refused test event without a double full stop or a promise that a task will start", async () => {
    show({ webhook_test: () => ({ status: 404, deliveryId: "", outcome: "Hook is disabled or unknown.", receipt: null }) });
    fireEvent.click(await screen.findByRole("button", { name: "Send test event" }));
    const status = await screen.findByText(/Test event: Hook is disabled or unknown/);
    expect(status.textContent).toBe("Test event: Hook is disabled or unknown.");
    expect(screen.queryByText(/Starting the task/)).toBeNull();
  });

  it("explains a sign-in wall when checking the public address", async () => {
    show({ webhook_probe: () => ({ verdict: "sign-in-wall", status: 401, detail: "The address answered with a sign-in page." }) });
    fireEvent.click(await screen.findByRole("button", { name: "Check it can be reached" }));
    expect(await screen.findByText(/sign-in page/)).toBeTruthy();
  });

  it("creates a hook on Claude Sonnet 5.5 and sends exactly the filled form", async () => {
    const saved: unknown[] = [];
    show({
      webhook_save: (input) => (saved.push(input), { ...base, hooks: [...base.hooks, { ...hook, id: "deploy" }] }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "New hook" }));
    const form = await screen.findByRole("form", { name: "New hook" });
    fireEvent.change(within(form).getByLabelText("Hook name"), { target: { value: "Deploy Done" } });
    await waitFor(() => expect((within(form).getByLabelText("Project") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(within(form).getByLabelText("Project"), { target: { value: "proj_test" } });
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "Reply with ACK." } });
    fireEvent.change(within(form).getByLabelText("Merge bursts within (seconds)"), { target: { value: "20" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create hook" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      name: "deploy-done",
      projectId: "proj_test",
      providerId: "claude-code",
      model: "claude-sonnet-5-5",
      reasoningLevel: "medium",
      prompt: "Reply with ACK.",
      enabled: true,
      holdOffline: true,
      coalesceSeconds: 20,
    });
    await waitFor(() => expect(screen.queryByRole("form", { name: "New hook" })).toBeNull());
  });

  it("blocks an incomplete form before calling the server and shows server refusals in the form", async () => {
    const saved: unknown[] = [];
    show({ webhook_save: (input) => (saved.push(input), Promise.reject(new Error("This bb cannot confirm which machine will run the task"))) });
    fireEvent.click(await screen.findByRole("button", { name: "New hook" }));
    const form = await screen.findByRole("form", { name: "New hook" });
    fireEvent.click(within(form).getByRole("button", { name: "Create hook" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/name/);
    expect(saved).toEqual([]);
    fireEvent.change(within(form).getByLabelText("Hook name"), { target: { value: "ok" } });
    await waitFor(() => expect((within(form).getByLabelText("Project") as HTMLSelectElement).options.length).toBeGreaterThan(1));
    fireEvent.change(within(form).getByLabelText("Project"), { target: { value: "proj_test" } });
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "go" } });
    await waitFor(() => expect(within(form).getByRole("button", { name: "Create hook" })).toBeTruthy());
    fireEvent.click(within(form).getByRole("button", { name: "Create hook" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/cannot confirm which machine/);
  });

  it("edits an existing hook with its saved prompt and a fixed name", async () => {
    show({});
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = await screen.findByRole("form", { name: "Edit hook ci-failed" });
    expect((within(form).getByLabelText("Hook name") as HTMLInputElement).disabled).toBe(true);
    expect((within(form).getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Reply with ACK.");
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("offers a sender example that never contains a secret", async () => {
    show({});
    fireEvent.click(await screen.findByRole("button", { name: "Sender example" }));
    const pre = await screen.findByText(/x-nav-hook: ci-failed/);
    expect(pre.textContent).toContain("$WEBHOOK_SECRET");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createContextWorkspace } from "../server-context-workspace";
import {
  contextSaveInput,
  droppedThread,
  parseNativeTranscript,
  quoteContext,
  GUEST_REVIEW_EXPIRY_OPTIONS,
} from "../src/context-workspace-model";
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose();
});
const id = "11111111-1111-4111-8111-111111111111";
function payload() {
  return contextSaveInput.parse({
    requestId: id,
    title: "Synthetic receipt brief",
    draft: {
      text: "Please read receipt",
      mentions: [],
      attachments: [
        {
          type: "localFile",
          path: "/uploads/receipt.pdf",
          name: "receipt.pdf",
          sourceProjectId: "project_source",
        },
      ],
    },
    destination: {
      projectId: "project_source",
      composerKey: "new",
      threadId: null,
      hostId: "host_source",
      label: "Source host",
    },
    selection: { providerId: "codex", model: "test" },
  });
}
function fixture() {
  const reads: unknown[] = [],
    uploads: unknown[] = [];
  const host = createFakePluginHost({
    pluginId: "context-test",
    appUrl: "https://synthetic.example",
    sdk: {
      projects: {
        attachments: {
          read: async (a) => {
            reads.push(a);
            return {
              bytes: new Uint8Array([0, 1, 128, 255]),
              sizeBytes: 4,
              mimeType: "application/pdf",
            };
          },
          upload: async (a) => {
            uploads.push(a);
            return {
              path: `/uploads/restored-${uploads.length}.pdf`,
              name: a.filename!,
              type: "localFile",
              sizeBytes: 4,
            };
          },
        },
      },
      files: {
        read: async () => ({
          content: "AP+A",
          contentEncoding: "base64",
          sizeBytes: 3,
          mimeType: "application/octet-stream",
        }),
      },
    },
  });
  hosts.push(host);
  createContextWorkspace(host.bb);
  return { ...host, reads, uploads };
}
describe("native context durable shelf", () => {
  it("retains binary files durably, restores bytes to the explicit destination and deduplicates saves", async () => {
    const h = fixture();
    const saved = await h.harness.behavior.callRpc(
      "context_draft_save",
      payload(),
    );
    expect(saved).toMatchObject({ id, bytes: 4, attachmentCount: 1 });
    await h.harness.behavior.callRpc("context_draft_save", payload());
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toEqual({
      projectId: "project_source",
      path: "/uploads/receipt.pdf",
    });
    const result = await h.harness.behavior.callRpc("context_draft_restore", {
      id,
      projectId: "project_destination",
    });
    expect(result).toMatchObject({
      draft: {
        text: "Please read receipt",
        attachments: [
          {
            sourceProjectId: "project_destination",
            path: "/uploads/restored-1.pdf",
            sizeBytes: 4,
          },
        ],
      },
      selection: { providerId: "codex" },
    });
    expect(h.uploads[0]).toMatchObject({
      projectId: "project_destination",
      clientFile: new Uint8Array([0, 1, 128, 255]),
    });
    const listed = await h.harness.behavior.callRpc(
      "context_drafts_list",
      null,
    );
    expect(listed).toHaveLength(1);
  });
  it("does not create a partially saved draft when an attachment read fails", async () => {
    const h = fixture();
    h.harness.sdk.stub("projects.attachments.read", async () => {
      throw new Error("source offline");
    });
    await expect(
      h.harness.behavior.callRpc("context_draft_save", payload()),
    ).rejects.toThrow(/source offline/);
    expect(
      await h.harness.behavior.callRpc("context_drafts_list", null),
    ).toEqual([]);
  });
  it("rejects changed content under an existing request ID and protects existing bytes", async () => {
    const h = fixture();
    await h.harness.behavior.callRpc("context_draft_save", payload());
    await expect(
      h.harness.behavior.callRpc("context_draft_save", {
        ...payload(),
        title: "Different work",
      }),
    ).rejects.toThrow(/different content/);
    expect(
      await h.harness.behavior.callRpc("context_drafts_list", null),
    ).toMatchObject([{ title: "Synthetic receipt brief" }]);
  });
  it("reads explicit host files as bytes and never reuses their local path on the destination", async () => {
    const h = fixture(),
      p = payload();
    p.draft.attachments = [
      {
        type: "localImage",
        hostId: "host_A",
        path: "/synthetic/screenshot.png",
        name: "screenshot.png",
      },
    ];
    await h.harness.behavior.callRpc("context_draft_save", p);
    await h.harness.behavior.callRpc("context_draft_restore", {
      id,
      projectId: "project_B",
    });
    expect(h.uploads[0]).toMatchObject({
      clientFile: new Uint8Array([0, 255, 128]),
    });
    expect(h.harness.inspection.sdk.callsTo("files.read")[0]).toEqual([
      { hostId: "host_A", path: "/synthetic/screenshot.png" },
    ]);
  });
  it("rejects corrupted retained bytes before uploading or returning a draft", async () => {
    const h = fixture();
    await h.harness.behavior.callRpc("context_draft_save", payload());
    h.bb.storage
      .database()
      .prepare("UPDATE context_draft_files_v1 SET bytes = ?")
      .run(Buffer.from("corrupt"));
    await expect(
      h.harness.behavior.callRpc("context_draft_restore", {
        id,
        projectId: "project_destination",
      }),
    ).rejects.toThrow(/failed verification/);
    expect(h.uploads).toHaveLength(0);
  });
  it("deletes only the saved copy and its retained files", async () => {
    const h = fixture();
    await h.harness.behavior.callRpc("context_draft_save", payload());
    await h.harness.behavior.callRpc("context_draft_delete", { id });
    expect(
      await h.harness.behavior.callRpc("context_drafts_list", null),
    ).toEqual([]);
    expect(
      h.bb.storage
        .database()
        .prepare("SELECT count(*) AS n FROM context_draft_files_v1")
        .get(),
    ).toEqual({ n: 0 });
    expect(h.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
});
describe("scoped guest review snapshots (synthetic data only)", () => {
  it("scopes token access to selected escaped text, expires and revokes without exposing files or RPC", async () => {
    const h = fixture();
    const review = (await h.harness.behavior.callRpc("context_review_create", {
      title: "Synthetic <review>",
      messages: [
        {
          source: "synthetic source",
          role: "assistant",
          text: "<script>bad()</script>",
        },
      ],
      expiresInMinutes: 60,
    })) as { id: string; url: string };
    const url = new URL(review.url),
      response = await h.harness.behavior.fetchHttp(
        "GET",
        `/context-review${url.search}`,
      );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain("<script>");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(
      (await h.harness.behavior.fetchHttp("GET", "/context-review?t=wrong"))
        .status,
    ).toBe(404);
    await h.harness.behavior.callRpc("context_review_revoke", {
      id: review.id,
    });
    expect(
      (
        await h.harness.behavior.fetchHttp(
          "GET",
          `/context-review${url.search}`,
        )
      ).status,
    ).toBe(404);
  });
});
describe("24-hour guest review option (synthetic data only)", () => {
  it("offers 1 h and 24 h, and a 24 h link opens before expiry and fails after it", async () => {
    expect(GUEST_REVIEW_EXPIRY_OPTIONS.map((o) => o.minutes)).toEqual([60, 1440]);
    const start = Date.UTC(2026, 9, 31, 10, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(start);
      const h = fixture();
      const review = (await h.harness.behavior.callRpc("context_review_create", {
        title: "Synthetic 24 h",
        messages: [{ source: "synthetic", role: "user", text: "SYNTHETIC selected turn" }],
        expiresInMinutes: 1440,
      })) as { url: string; expiresAt: number };
      expect(review.expiresAt).toBe(start + 24 * 60 * 60_000);
      const path = `/context-review${new URL(review.url).search}`;
      vi.setSystemTime(start + 24 * 60 * 60_000 - 60_000);
      const open = await h.harness.behavior.fetchHttp("GET", path);
      expect(open.status).toBe(200);
      expect(await open.text()).toContain("SYNTHETIC selected turn");
      vi.setSystemTime(start + 24 * 60 * 60_000 + 1);
      expect((await h.harness.behavior.fetchHttp("GET", path)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("exact context and bounded read-only native text import", () => {
  it("preserves the source message sequence, exact whitespace and independent annotation", () => {
    const value = quoteContext({
      threadId: "thr_source",
      messageSeq: 47,
      quote: " first line\nsecond line ",
      comment: "Change only this.",
    });
    expect(JSON.parse(value.slice(value.indexOf("{")))).toEqual({
      source: "@thread:thr_source#msg=47",
      quotedText: " first line\nsecond line ",
      comment: "Change only this.",
    });
    expect(droppedThread('{"id":"thr_1","projectId":"proj_1"}')).toMatchObject({
      kind: "thread",
      threadId: "thr_1",
      projectId: "proj_1",
    });
    expect(droppedThread('{"id":null}')).toBeNull();
  });
  it("imports visible authored messages and excludes tools and reasoning", () => {
    const raw = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "hidden" },
            { type: "tool_use", text: "secret tool" },
            { type: "text", text: "Visible answer" },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", text: "private tool result" }],
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n");
    expect(parseNativeTranscript(raw)).toEqual({
      provider: "claude-code",
      messages: [{ role: "assistant", text: "Visible answer" }],
      omitted: 1,
    });
  });
  it("bounds imported history to first prompt and newest messages", () => {
    const raw = Array.from({ length: 250 }, (_, i) =>
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: String(i) }],
        },
      }),
    ).join("\n");
    const result = parseNativeTranscript(raw);
    expect(result.messages).toHaveLength(200);
    expect(result.messages[0].text).toBe("0");
    expect(result.messages[1].text).toBe("51");
    expect(result.omitted).toBe(50);
  });
});

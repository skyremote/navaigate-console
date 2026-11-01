// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type {
  PluginComposerApi,
  ComposerDraftSnapshot,
} from "@get-bb/plugin-sdk/app";
import {
  saveComposerSnapshot,
  restoreComposerSnapshot,
  placeQuoteInComposer,
} from "../src/context-workspace";
import { contextSaveInput } from "../src/context-workspace-model";
function fixture() {
  let draft: ComposerDraftSnapshot = {
    text: "Original user brief",
    mentions: [],
    attachments: [],
  };
  const api = {
    get draft() {
      return draft;
    },
    get isEmpty() {
      return !draft.text && !draft.attachments.length;
    },
    replace(value: any) {
      const next = typeof value === "function" ? value(draft) : value;
      draft = { ...next, attachments: next.attachments ?? draft.attachments };
    },
    focus() {},
  } as PluginComposerApi;
  const payload = contextSaveInput.parse({
    requestId: "11111111-1111-4111-8111-111111111111",
    title: "Brief",
    draft,
    destination: {
      projectId: "p",
      composerKey: "c",
      threadId: null,
      hostId: null,
      label: "p",
    },
    selection: null,
  });
  return { api, payload };
}
describe("native composer draft races", () => {
  it("clears only after durable success, while keeping edits typed during save", async () => {
    const { api, payload } = fixture();
    expect(
      await saveComposerSnapshot(
        api,
        async () => {
          api.replace({ text: "Newer user edits", mentions: [] });
        },
        payload,
        true,
      ),
    ).toBe(false);
    expect(api.text ?? api.draft.text).toBe("Newer user edits");
  });
  it("preserves the original draft when durable saving fails", async () => {
    const { api, payload } = fixture();
    await expect(
      saveComposerSnapshot(
        api,
        async () => {
          throw new Error("disk full");
        },
        payload,
        true,
      ),
    ).rejects.toThrow("disk full");
    expect(api.draft.text).toBe("Original user brief");
  });
  it("requires explicit replacement and never overwrites edits made during restore", async () => {
    const { api } = fixture();
    await expect(
      restoreComposerSnapshot(
        api,
        async () => ({
          draft: { text: "saved", mentions: [], attachments: [] },
        }),
        false,
      ),
    ).rejects.toThrow(/Replace explicitly/);
    await expect(
      restoreComposerSnapshot(
        api,
        async () => {
          api.replace({ text: "Typed during upload", mentions: [] });
          return { draft: { text: "saved", mentions: [], attachments: [] } };
        },
        true,
      ),
    ).rejects.toThrow(/composer changed/);
    expect(api.draft.text).toBe("Typed during upload");
  });
});

describe("binary device draft encoding", () => {
  it("round-trips real bytes and pending staged uploads without treating source paths as copied files", async () => {
    const { encodeDeviceDraft, decodeDeviceDraft } =
      await import("../src/context-workspace-offline");
    const { payload } = fixture();
    const source = {
      id: "device:test",
      savedAt: 100,
      payload,
      files: [
        {
          path: "/source.bin",
          owner: "host:synthetic",
          bytes: new Uint8Array([0, 127, 128, 255]),
        },
      ],
      kind: "outbox" as const,
      complete: true,
      staged: payload,
    };
    const encoded = encodeDeviceDraft(source);
    expect(encoded).toContain('"base64":"AH+A/w=="');
    expect(decodeDeviceDraft(encoded)).toEqual(source);
  });
});

describe("captured image bytes in the native composer", () => {
  it("uploads actual binary bytes and keeps text edited while upload is pending", async () => {
    const { attachCapturedFrame } = await import("../src/context-workspace");
    const { api } = fixture();
    api.insert = () => {};
    const pixels = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const uploaded: Uint8Array[] = [];
    await attachCapturedFrame(
      api,
      {
        bytes: pixels,
        label: "Synthetic active window",
        mimeType: "image/png",
      },
      async (bytes) => {
        uploaded.push(bytes);
        api.replace({ text: "New edits while PNG uploads", mentions: [] });
        return {
          type: "localImage",
          path: "/real-upload/window.png",
          sourceProjectId: "destination",
          name: "window.png",
          sizeBytes: bytes.length,
        };
      },
    );
    expect(uploaded).toEqual([pixels]);
    expect(api.draft.text).toBe("New edits while PNG uploads");
    expect(api.draft.attachments).toMatchObject([
      {
        path: "/real-upload/window.png",
        sourceProjectId: "destination",
        sizeBytes: 6,
      },
    ]);
  });
});

describe("Insert annotated quote", () => {
  it("leaves the quote in the message box for editing and never sends it", () => {
    const calls: string[] = [];
    let text = "";
    const api = {
      insert: (part: string) => {
        calls.push("insert");
        text += part;
      },
      focus: () => calls.push("focus"),
      experimental_closePopup: () => {
        calls.push("close");
        return true;
      },
      submit: async () => {
        calls.push("submit");
      },
      experimental_submitInBackground: async () => {
        calls.push("submit");
      },
    } as unknown as PluginComposerApi;
    const note = placeQuoteInComposer(api, { source: "@thread:t#msg=3", quote: "Exact words", comment: "Check this" });
    expect(calls).toEqual(["insert", "focus", "close"]);
    expect(text).toContain("Review this source excerpt:");
    expect(text).toContain('"quotedText": "Exact words"');
    expect(text).toContain('"comment": "Check this"');
    expect(note).toMatch(/message box.*Edit it, then send/);
  });
});

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  contextDraftSchema,
  contextSaveInput,
  contextDraftSummarySchema,
  MAX_DRAFT_BYTES,
  MAX_FILE_BYTES,
  type ContextSave,
} from "./src/context-workspace-model";

const uuidInput = z.object({ id: z.string().uuid() });
const reviewMessage = z.object({
  source: z.string().max(500),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(30_000),
});
const reviewCreateInput = z
  .object({
    title: z.string().trim().min(1).max(150),
    messages: z.array(reviewMessage).min(1).max(50),
    expiresInMinutes: z.number().int().min(5).max(1440).default(60),
  })
  .refine((x) => JSON.stringify(x).length <= 200_000, "Review exceeds 200 KB");
const reviewSummary = z.object({
  id: z.string().uuid(),
  title: z.string(),
  expiresAt: z.number(),
  revoked: z.boolean(),
});
export const contextWorkspaceContract = defineRpcContract({
  context_drafts_list: {
    input: z.null(),
    output: z.array(contextDraftSummarySchema),
  },
  context_draft_save: {
    input: contextSaveInput,
    output: contextDraftSummarySchema,
  },
  context_draft_restore: {
    input: uuidInput.extend({ projectId: z.string().min(1).max(300) }),
    output: z.object({
      draft: contextDraftSchema,
      selection: contextSaveInput.shape.selection,
      destination: contextSaveInput.shape.destination,
    }),
  },
  context_draft_delete: {
    input: uuidInput,
    output: z.object({ ok: z.boolean() }),
  },
  context_review_create: {
    input: reviewCreateInput,
    output: reviewSummary.extend({ url: z.string() }),
  },
  context_reviews_list: { input: z.null(), output: z.array(reviewSummary) },
  context_review_revoke: {
    input: uuidInput,
    output: z.object({ ok: z.boolean() }),
  },
});
const digest = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** All attachment bytes are retained transactionally in plugin SQLite, not a volatile upload path. */
export function createContextWorkspace(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.exec(`CREATE TABLE IF NOT EXISTS context_drafts_v1 (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS context_draft_files_v1 (draft_id TEXT NOT NULL, ordinal INTEGER NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(draft_id, ordinal));
    CREATE TABLE IF NOT EXISTS context_guest_reviews_v1 (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, title TEXT NOT NULL, messages TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);`);
  type Row = {
    id: string;
    fingerprint: string;
    payload: string;
    created_at: number;
    bytes: number;
  };
  const row = (id: string) =>
    db.prepare("SELECT * FROM context_drafts_v1 WHERE id = ?").get(id) as
      | Row
      | undefined;
  const summary = (r: Row) => {
    const p = contextSaveInput.parse(JSON.parse(r.payload));
    return {
      id: r.id,
      title: p.title,
      destination: p.destination,
      attachmentCount: p.draft.attachments.length,
      bytes: r.bytes,
      createdAt: r.created_at,
      textPreview: p.draft.text.slice(0, 180),
    };
  };
  async function save(input: ContextSave) {
    input = contextSaveInput.parse(input);
    const fingerprint = digest(JSON.stringify(input)),
      previous = row(input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error(
          "This draft ID belongs to different content. Save with a new ID.",
        );
      return summary(previous);
    }
    if (
      (
        db.prepare("SELECT count(*) AS n FROM context_drafts_v1").get() as {
          n: number;
        }
      ).n >= 100
    )
      throw new Error(
        "The shelf holds 100 drafts. Remove one before saving another.",
      );
    const files: Buffer[] = [];
    let total = 0;
    for (const a of input.draft.attachments) {
      if (a.sizeBytes && a.sizeBytes > MAX_FILE_BYTES)
        throw new Error(`${a.name} exceeds the 20 MB saved-file limit.`);
      let bytes: Buffer;
      if (a.hostId) {
        const file = await bb.sdk.files.read({
          hostId: a.hostId,
          path: a.path,
        });
        bytes = Buffer.from(
          file.content,
          file.contentEncoding === "base64" ? "base64" : "utf8",
        );
      } else {
        const file = await bb.sdk.projects.attachments.read({
          projectId: a.sourceProjectId ?? input.destination.projectId,
          path: a.path,
        });
        bytes = Buffer.from(file.bytes);
      }
      total += bytes.length;
      if (bytes.length > MAX_FILE_BYTES || total > MAX_DRAFT_BYTES)
        throw new Error(
          "Draft files exceed the 20 MB per file or 50 MB total limit. The composer has not been changed.",
        );
      files.push(bytes);
    }
    const payload = JSON.stringify(input),
      now = Date.now();
    db.transaction(() => {
      // Recheck after async reads; concurrent identical saves reuse their durable row.
      const existing = row(input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("Draft ID collision");
        return;
      }
      if (
        (
          db.prepare("SELECT count(*) AS n FROM context_drafts_v1").get() as {
            n: number;
          }
        ).n >= 100
      )
        throw new Error(
          "The shelf holds 100 drafts. Remove one before saving another.",
        );
      const stored = db
        .prepare("SELECT coalesce(sum(bytes), 0) AS n FROM context_drafts_v1")
        .get() as { n: number };
      if (stored.n + total > 500 * 1024 * 1024)
        throw new Error(
          "Saved files exceed the 500 MB shelf limit. Remove unused drafts first.",
        );
      db.prepare("INSERT INTO context_drafts_v1 VALUES (?, ?, ?, ?, ?)").run(
        input.requestId,
        fingerprint,
        payload,
        now,
        total,
      );
      const put = db.prepare(
        "INSERT INTO context_draft_files_v1 VALUES (?, ?, ?, ?)",
      );
      files.forEach((bytes, ordinal) =>
        put.run(input.requestId, ordinal, bytes, digest(bytes)),
      );
    })();
    return summary(row(input.requestId)!);
  }
  async function restore({ id, projectId }: { id: string; projectId: string }) {
    const r = row(id);
    if (!r) throw new Error("This saved draft no longer exists.");
    const p = contextSaveInput.parse(JSON.parse(r.payload));
    const attachments = [];
    const paths = new Map<string, string>();
    for (let i = 0; i < p.draft.attachments.length; i++) {
      const old = p.draft.attachments[i];
      const file = db
        .prepare(
          "SELECT bytes, sha256 FROM context_draft_files_v1 WHERE draft_id = ? AND ordinal = ?",
        )
        .get(id, i) as { bytes: Buffer; sha256: string } | undefined;
      if (!file || digest(file.bytes) !== file.sha256)
        throw new Error(
          `The retained bytes for ${old.name} failed verification. The composer has not been changed.`,
        );
      const uploaded = await bb.sdk.projects.attachments.upload({
        projectId,
        filename: old.name,
        mimeType: old.mimeType,
        clientFile: new Uint8Array(file.bytes),
      });
      paths.set(old.path, uploaded.path);
      attachments.push({
        ...uploaded,
        sourceProjectId: projectId,
        sizeBytes: file.bytes.length,
      });
    }
    return {
      draft: {
        ...p.draft,
        attachments,
        mentions: p.draft.mentions.map((m) =>
          m.kind === "attachment" && paths.has(m.path)
            ? { ...m, path: paths.get(m.path)! }
            : m,
        ),
      },
      selection: p.selection,
      destination: p.destination,
    };
  }
  const listReviews = () =>
    (
      db
        .prepare(
          "SELECT id, title, expires_at, revoked FROM context_guest_reviews_v1 ORDER BY expires_at DESC LIMIT 100",
        )
        .all() as Array<{
        id: string;
        title: string;
        expires_at: number;
        revoked: number;
      }>
    ).map((r) => ({
      id: r.id,
      title: r.title,
      expiresAt: r.expires_at,
      revoked: !!r.revoked,
    }));
  const handlers = {
    context_drafts_list: () =>
      (
        db
          .prepare(
            "SELECT * FROM context_drafts_v1 ORDER BY created_at DESC LIMIT 100",
          )
          .all() as Row[]
      ).map(summary),
    context_draft_save: save,
    context_draft_restore: restore,
    context_draft_delete: ({ id }: { id: string }) => {
      db.transaction(() => {
        db.prepare("DELETE FROM context_draft_files_v1 WHERE draft_id = ?").run(
          id,
        );
        db.prepare("DELETE FROM context_drafts_v1 WHERE id = ?").run(id);
      })();
      return { ok: true };
    },
    context_reviews_list: listReviews,
    context_review_create: (raw: z.infer<typeof reviewCreateInput>) => {
      const input = reviewCreateInput.parse(raw),
        base = bb.server.experimental_appUrl;
      if (!base)
        throw new Error("BB has no app URL configured for a guest link.");
      const id = randomUUID(),
        token = randomBytes(32).toString("base64url"),
        expiresAt = Date.now() + input.expiresInMinutes * 60_000;
      db.prepare(
        "DELETE FROM context_guest_reviews_v1 WHERE expires_at < ? OR revoked = 1",
      ).run(Date.now());
      if (
        (
          db
            .prepare("SELECT count(*) AS n FROM context_guest_reviews_v1")
            .get() as { n: number }
        ).n >= 100
      )
        throw new Error("Revoke an existing review before creating another.");
      db.prepare(
        "INSERT INTO context_guest_reviews_v1 (id, token_hash, title, messages, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        id,
        digest(token),
        input.title,
        JSON.stringify(input.messages),
        expiresAt,
      );
      return {
        id,
        title: input.title,
        expiresAt,
        revoked: false,
        url: `${base.replace(/\/$/, "")}/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http/context-review?t=${token}`,
      };
    },
    context_review_revoke: ({ id }: { id: string }) => {
      db.prepare(
        "UPDATE context_guest_reviews_v1 SET revoked = 1 WHERE id = ?",
      ).run(id);
      return { ok: true };
    },
  };
  bb.rpc.register(contextWorkspaceContract, handlers);
  // This one public route authenticates ONLY its unguessable, expiring, revocable snapshot token.
  // It never authorises BB RPC, files, attachments, workspaces or live conversation access.
  bb.http.route(
    "GET",
    "/context-review",
    (req) => {
      const token = new URL(req.req.url).searchParams.get("t") ?? "";
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
      };
      if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        return new Response("Review unavailable", { status: 404, headers });
      const r = db
        .prepare(
          "SELECT title, messages FROM context_guest_reviews_v1 WHERE token_hash = ? AND expires_at > ? AND revoked = 0",
        )
        .get(digest(token), Date.now()) as
        | { title: string; messages: string }
        | undefined;
      if (!r)
        return new Response("Review unavailable", { status: 404, headers });
      const messages = z.array(reviewMessage).parse(JSON.parse(r.messages));
      return new Response(
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>${escapeHtml(r.title)}</title><style>body{font:17px system-ui;max-width:800px;margin:2rem auto;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid;padding:1rem 0}small{overflow-wrap:anywhere}</style><h1>${escapeHtml(r.title)}</h1><p>Selected text snapshot. Files, tools and live access are excluded.</p>${messages.map((m) => `<article><strong>${m.role}</strong><br><small>${escapeHtml(m.source)}</small><pre>${escapeHtml(m.text)}</pre></article>`).join("")}</html>`,
        { headers },
      );
    },
    { auth: "none" },
  );
  return handlers;
}

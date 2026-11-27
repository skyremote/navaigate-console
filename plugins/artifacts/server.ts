// bb-plugin-artifacts: the Claude app's Artifacts page inside bb.
//
// The gallery shows two kinds of artifact side by side:
//   - pages bb chats have saved (each chat's `artifacts` folder, plus extra folders from settings);
//   - the person's claude.ai artifacts, listed through their own Claude Code CLI's Artifact tool.
// Share publishes a local page as a real claude.ai artifact (same tool), copies the link and opens
// it in the Claude desktop app, where Claude's own Share menu sets who can open it. Install as app
// does the same and points at Claude's own "Install as app" there: the real thing (own window,
// Claude and connectors, permissions, updates) only exists in the Claude desktop app.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { liveBlock, liveIsUnchanged, parseArtifactList, parsePublishedUrl, type ClaudeArtifact } from "./lib/artifact-list";
import { claudeSignIn, claudeStatus, findClaude, killAll, listArtifacts, publishArtifact, type ClaudeStatus } from "./lib/claude-runner";
import { claudeAppInstalled, openInChrome, openInClaudeApp, revealFile } from "./lib/desktop";
import { scanPages, type LocalPage } from "./lib/local-scan";
import { takeThumbnails } from "./lib/thumbs";

const claudeArtifactSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  owner: z.enum(["mine", "shared"]),
  pinned: z.boolean(),
  updated: z.string().nullable(),
});

const localItemSchema = z.object({
  path: z.string(),
  title: z.string(),
  kind: z.enum(["html", "md"]),
  mtime: z.number(),
  size: z.number(),
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  snippet: z.string().nullable(),
  publishedUrl: z.string().nullable(),
  /** The page changed after it was last published. */
  stale: z.boolean(),
});
export type LocalItem = z.infer<typeof localItemSchema>;

const statusSchema = z.object({
  installed: z.boolean(),
  loggedIn: z.boolean(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  error: z.string().nullable(),
});

const gallerySchema = z.object({
  local: z.array(localItemSchema),
  claude: z.object({
    items: z.array(claudeArtifactSchema),
    total: z.number().nullable(),
    more: z.boolean(),
    at: z.number().nullable(),
    error: z.string().nullable(),
    refreshing: z.boolean(),
  }),
  status: statusSchema.nullable(),
  /** The Claude desktop app is installed (Share and Install as app open there). */
  claudeApp: z.boolean(),
});
export type Gallery = z.infer<typeof gallerySchema>;

const ok = z.object({ ok: z.boolean(), error: z.string().nullable() });
const pathInput = z.object({ path: z.string().min(1).max(2000) });
const linkOutput = z.object({ ok: z.boolean(), url: z.string().nullable(), inApp: z.boolean(), error: z.string().nullable() });

export const rpcContract = defineRpcContract({
  gallery: { input: z.null(), output: gallerySchema },
  refresh: { input: z.null(), output: ok },
  publish: { input: pathInput.extend({ asNew: z.boolean().optional() }), output: z.object({ ok: z.boolean(), url: z.string().nullable(), error: z.string().nullable() }) },
  /** Open a claude.ai artifact (in the Claude app when `inApp` and it's installed) or a page from the gallery (in Chrome). */
  open: { input: z.object({ target: z.string().min(1).max(2000), inApp: z.boolean().optional() }), output: z.object({ ok: z.boolean(), inApp: z.boolean(), error: z.string().nullable() }) },
  reveal: { input: pathInput, output: ok },
  /** Publish if needed and return the artifact's link; the page then opens it in the Claude app, ready for its own Install as app. */
  install: { input: z.object({ url: z.string().max(400).nullable(), path: z.string().max(2000).nullable() }), output: linkOutput },
  thumb: { input: pathInput, output: z.object({ dataUrl: z.string().nullable(), pending: z.boolean() }) },
  sign_in: { input: z.null(), output: ok },
});

const CHANGED = "artifacts-changed";
const THUMB_READY = "artifacts-thumb";
const LIST_KEY = "claude-list";
const PUBLISHED_KEY = "published";
const LIST_MAX_AGE = 10 * 60_000;
const NEEDS_APP = "Install as app needs the Claude desktop app for Mac or Windows (version 6.28899 or later): https://claude.com/download";

type ListCache = { items: ClaudeArtifact[]; total: number | null; more: boolean; at: number | null; error: string | null };
type Published = Record<string, { url: string; at: number }>;

const keyOf = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
const isClaudeUrl = (s: string) => /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/.test(s);
const isPage = (p: string) => [".html", ".htm", ".md"].includes(extname(p).toLowerCase());

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    extraFolders: {
      type: "string",
      label: "Extra folders",
      description: "Other folders whose .html and .md pages should appear on the Artifacts page, one full path per line. Each chat's own artifacts folder is always included.",
      experimental_multiline: true,
      default: "",
    },
    claudePath: {
      type: "string",
      label: "Claude Code path",
      description: "Leave empty to find Claude Code where it is normally installed. Set it only if the page says Claude Code wasn't found.",
      default: "",
    },
  });
  const conf = await settings.get();
  const claude = findClaude(String(conf.claudePath ?? ""));
  const extraFolders = String(conf.extraFolders ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && isAbsolute(s));

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS thumbs (path TEXT PRIMARY KEY, mtime REAL NOT NULL, data TEXT)`,
    // What bb last published for each page, so an update can prove nobody changed the live version.
    `CREATE TABLE IF NOT EXISTS sent (path TEXT PRIMARY KEY, content TEXT NOT NULL)`,
  ]);

  bb.onDispose(() => killAll());

  /** One Claude Code run at a time, and one publish at a time (so a page is never published twice). */
  const chain = () => {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(task: () => Promise<T>): Promise<T> => {
      const next = tail.then(task, task);
      tail = next.catch(() => undefined);
      return next;
    };
  };
  const claudeQueue = chain();
  const publishQueue = chain();

  let status: { at: number; value: ClaudeStatus } | null = null;
  async function getStatus(force = false): Promise<ClaudeStatus> {
    if (!force && status && Date.now() - status.at < 5 * 60_000) return status.value;
    const value = await claudeStatus(claude);
    status = { at: Date.now(), value };
    return value;
  }

  // ---------- claude.ai list ----------
  let refreshing: Promise<void> | null = null;
  async function refreshList(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const prior = (await bb.storage.kv.get<ListCache>(LIST_KEY)) ?? { items: [], total: null, more: false, at: null, error: null };
      const st = await getStatus();
      if (!st.loggedIn) {
        await bb.storage.kv.set(LIST_KEY, { ...prior, error: st.error ?? "Claude Code isn't signed in to claude.ai." });
        return;
      }
      const run = await claudeQueue(() => listArtifacts(claude));
      const text = run.results.map((r) => r.text).join("\n");
      const parsed = parseArtifactList(text);
      const failed = run.error !== null || run.results.every((r) => r.isError);
      const next: ListCache = failed ? { ...prior, error: run.error ?? text.slice(0, 300) } : { items: parsed.items, total: parsed.total, more: parsed.more, at: Date.now(), error: null };
      await bb.storage.kv.set(LIST_KEY, next);
    })()
      .catch((cause) => bb.log.warn(`artifacts: list refresh failed: ${String(cause)}`))
      .finally(() => {
        refreshing = null;
        bb.realtime.publish(CHANGED, { at: Date.now() });
      });
    return refreshing;
  }

  // ---------- local pages ----------
  let scanned: { at: number; pages: LocalPage[] } | null = null;
  let lastForced = 0;
  async function chatRoots(): Promise<string[]> {
    const roots = new Set<string>();
    try {
      const projects = (await bb.sdk.projects.list({ includePersonal: true })) as unknown as { sources?: { path?: string }[] }[];
      for (const p of projects) for (const s of p.sources ?? []) if (s.path) roots.add(join(s.path, ".bb", "chats"));
    } catch (cause) {
      bb.log.warn(`artifacts: projects list failed: ${String(cause)}`);
    }
    try {
      roots.add(join(bb.server.experimental_dataDir, "thread-storage"));
    } catch {
      /* data dir unknown */
    }
    return [...roots];
  }
  async function pages(force = false): Promise<LocalPage[]> {
    if (!force && scanned && Date.now() - scanned.at < 30_000) return scanned.pages;
    const list = await scanPages(await chatRoots(), extraFolders);
    scanned = { at: Date.now(), pages: list };
    return list;
  }
  /** A page the scan found. An unknown path triggers at most one fresh scan every five seconds. */
  async function knownPage(path: string): Promise<LocalPage | null> {
    const key = keyOf(path);
    const find = (list: LocalPage[]) => list.find((p) => keyOf(p.path) === key) ?? null;
    const hit = find(await pages());
    if (hit || Date.now() - lastForced < 5000) return hit;
    lastForced = Date.now();
    return find(await pages(true));
  }

  const titles = new Map<string, string | null>();
  async function threadTitle(id: string | null): Promise<string | null> {
    if (!id) return null;
    if (titles.has(id)) return titles.get(id)!;
    let title: string | null = null;
    try {
      const t = (await bb.sdk.threads.get({ threadId: id })) as { title?: string | null; displayTitle?: string | null };
      title = t.displayTitle ?? t.title ?? null;
    } catch {
      title = null;
    }
    titles.set(id, title);
    return title;
  }

  // ---------- publishing ----------
  async function publishOnce(path: string, extra: string): Promise<{ url: string | null; text: string; error: string | null }> {
    const run = await claudeQueue(() => publishArtifact(claude, path, extra));
    const text = run.results.map((r) => r.text).join("\n");
    const url = parsePublishedUrl(run.results.filter((r) => !r.isError).map((r) => r.text).join("\n"));
    const why = run.error ?? run.results.filter((r) => r.isError).map((r) => r.text).join(" ").trim();
    return { url, text, error: url ? null : why || text || "Claude Code didn't return a link." };
  }

  /**
   * Publish a page as a claude.ai artifact, or update the artifact it was shared as before.
   * An update from a new Claude Code session is refused until the live version has been seen.
   * bb then overwrites it (force) only if the live version is exactly what bb last sent, so
   * nothing changed on claude.ai is ever thrown away. Otherwise it stops and says why.
   */
  function publishPath(path: string, asNew = false): Promise<{ url: string | null; error: string | null }> {
    return publishQueue(async () => {
      if (!existsSync(path) || !isPage(path)) return { url: null, error: "Only existing .html, .htm or .md files can be published." };
      const content = readFileSync(path, "utf8");
      const key = keyOf(path);
      const prior = asNew ? undefined : ((await bb.storage.kv.get<Published>(PUBLISHED_KEY)) ?? {})[key];
      const kind = extname(path).toLowerCase() === ".md" ? "doc" : "page";
      let r = prior ? await publishOnce(path, `, url ${JSON.stringify(prior.url)}`) : await publishOnce(path, `, icon "${kind}"`);
      if (!r.url && prior && /hadn't viewed the live version|newer version/i.test(r.text)) {
        const live = liveBlock(r.text);
        const sent = (db.prepare(`SELECT content FROM sent WHERE path = ?`).get(key) as { content: string } | undefined)?.content;
        if (live === null || sent === undefined || !liveIsUnchanged(live, sent)) {
          return { url: null, error: "This artifact was changed on claude.ai after BB last shared it, so BB won't overwrite it. Use “Share as a new artifact” in the … menu, or update it from Claude." };
        }
        r = await publishOnce(path, `, url ${JSON.stringify(prior.url)}, force true (the owner chose to replace the live version, which is unchanged since they last shared it)`);
      }
      if (!r.url) return { url: null, error: (r.error ?? "Publishing didn't work.").slice(0, 400) };
      const published = (await bb.storage.kv.get<Published>(PUBLISHED_KEY)) ?? {};
      published[key] = { url: r.url, at: Date.now() };
      await bb.storage.kv.set(PUBLISHED_KEY, published);
      db.prepare(`INSERT INTO sent (path, content) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content`).run(key, content);
      void refreshList();
      return { url: r.url, error: null };
    });
  }

  /** The claude.ai link for a page: its existing one if unchanged since, else a fresh publish. */
  async function linkForPage(page: LocalPage): Promise<{ url: string | null; error: string | null }> {
    const pub = ((await bb.storage.kv.get<Published>(PUBLISHED_KEY)) ?? {})[keyOf(page.path)];
    if (pub && page.mtime <= pub.at) return { url: pub.url, error: null };
    return publishPath(page.path);
  }

  // ---------- thumbnails ----------
  const waiting = new Set<string>();
  let shooting = false;
  function queueThumb(path: string) {
    waiting.add(path);
    if (shooting) return;
    shooting = true;
    void (async () => {
      try {
        while (waiting.size > 0) {
          const batch = [...waiting].slice(0, 12);
          for (const p of batch) waiting.delete(p);
          await takeThumbnails(batch, (p, dataUrl) => {
            let mtime = 0;
            try {
              mtime = statSync(p).mtimeMs;
            } catch {
              /* gone */
            }
            db.prepare(`INSERT INTO thumbs (path, mtime, data) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, data = excluded.data`).run(keyOf(p), mtime, dataUrl);
            bb.realtime.publish(THUMB_READY, { path: p });
          });
        }
      } catch (cause) {
        bb.log.warn(`artifacts: thumbnails failed: ${String(cause)}`);
      } finally {
        shooting = false;
      }
    })();
  }

  async function openArtifact(url: string, inApp: boolean): Promise<{ ok: boolean; inApp: boolean }> {
    if (inApp && (await claudeAppInstalled()) && (await openInClaudeApp(url))) return { ok: true, inApp: true };
    return { ok: await openInChrome(url), inApp: false };
  }

  // ---------- RPC ----------
  bb.rpc.register(rpcContract, {
    gallery: async () => {
      const [list, published, cache, app] = await Promise.all([
        pages(),
        bb.storage.kv.get<Published>(PUBLISHED_KEY).then((p) => p ?? {}),
        bb.storage.kv.get<ListCache>(LIST_KEY),
        claudeAppInstalled(),
      ]);
      if (!status) void getStatus().then(() => bb.realtime.publish(CHANGED, { at: Date.now() }));
      if (!cache?.at || Date.now() - cache.at > LIST_MAX_AGE) void refreshList();
      const local: LocalItem[] = [];
      for (const p of list) {
        const pub = published[keyOf(p.path)];
        local.push({ ...p, threadTitle: await threadTitle(p.threadId), publishedUrl: pub?.url ?? null, stale: !!pub && p.mtime > pub.at });
      }
      return {
        local,
        claude: { items: cache?.items ?? [], total: cache?.total ?? null, more: cache?.more ?? false, at: cache?.at ?? null, error: cache?.error ?? null, refreshing: refreshing !== null },
        status: status?.value ?? null,
        claudeApp: app,
      };
    },

    refresh: async () => {
      await pages(true);
      await getStatus(true);
      void refreshList();
      bb.realtime.publish(CHANGED, { at: Date.now() });
      return { ok: true, error: null };
    },

    publish: async ({ path, asNew }) => {
      const page = await knownPage(path);
      if (!page) return { ok: false, url: null, error: "That page isn't on the Artifacts page any more." };
      const r = await publishPath(page.path, asNew === true);
      bb.realtime.publish(CHANGED, { at: Date.now() });
      return { ok: r.url !== null, url: r.url, error: r.error };
    },

    open: async ({ target, inApp }) => {
      if (isClaudeUrl(target)) return { ...(await openArtifact(target, inApp === true)), error: null };
      const page = await knownPage(target);
      if (!page) return { ok: false, inApp: false, error: "Only artifacts on this page can be opened from here." };
      return { ok: await openInChrome(page.path), inApp: false, error: null };
    },

    reveal: async ({ path }) => {
      const page = await knownPage(path);
      if (!page) return { ok: false, error: "That page isn't on the Artifacts page any more." };
      return { ok: await revealFile(page.path), error: null };
    },

    install: async ({ url, path }) => {
      if (!(await claudeAppInstalled())) return { ok: false, url: null, inApp: false, error: NEEDS_APP };
      let link = url && isClaudeUrl(url) ? url : null;
      if (path) {
        const page = await knownPage(path);
        if (!page) return { ok: false, url: null, inApp: false, error: "That page isn't on the Artifacts page any more." };
        const r = await linkForPage(page);
        if (!r.url) return { ok: false, url: null, inApp: false, error: r.error };
        link = r.url;
      }
      if (!link) return { ok: false, url: null, inApp: false, error: "Nothing to install." };
      // The page opens the Claude app itself, through bb's own app-link handling: an app opened
      // from the window the person clicked in may come to the front, one opened from this
      // background server often can't on Windows.
      bb.realtime.publish(CHANGED, { at: Date.now() });
      return { ok: true, url: link, inApp: true, error: null };
    },

    thumb: async ({ path }) => {
      const page = await knownPage(path);
      if (!page || page.kind !== "html") return { dataUrl: null, pending: false };
      const row = db.prepare(`SELECT mtime, data FROM thumbs WHERE path = ?`).get(keyOf(page.path)) as { mtime: number; data: string | null } | undefined;
      if (row && row.mtime >= page.mtime) return { dataUrl: row.data, pending: false };
      queueThumb(page.path);
      return { dataUrl: row?.data ?? null, pending: true };
    },

    sign_in: async () => {
      const r = await claudeSignIn(claude);
      await getStatus(true);
      if (r.ok) void refreshList();
      bb.realtime.publish(CHANGED, { at: Date.now() });
      return r;
    },
  });

  // ---------- CLI, for agents in bb chats ----------
  const usage = [
    "Usage:",
    "  bb artifacts list [--json]                    Your claude.ai artifacts and the pages bb chats have saved",
    "  bb artifacts publish <file> [--new] [--json]  Publish an .html or .md file as a claude.ai artifact (private until shared).",
    "                                                Publishing the same file again updates its artifact; --new makes a separate one.",
    "  bb artifacts open <url|file>                  Open an artifact in the Claude app (or Chrome), or a page in Chrome",
  ].join("\n");
  bb.cli.register({
    name: "artifacts",
    summary: "List, publish and open claude.ai artifacts",
    commands: [
      { name: "list", summary: "List artifacts", usage: "bb artifacts list [--json]" },
      { name: "publish", summary: "Publish a file as a claude.ai artifact", usage: "bb artifacts publish <file> [--new] [--json]" },
      { name: "open", summary: "Open an artifact or page", usage: "bb artifacts open <url|file>" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const asNew = argv.includes("--new");
      const [command, ...rest] = argv.filter((a) => a !== "--json" && a !== "--new");
      const arg = rest.join(" ").trim().replace(/^"(.*)"$/, "$1");
      switch (command) {
        case "list": {
          await refreshList();
          const cache = (await bb.storage.kv.get<ListCache>(LIST_KEY)) ?? { items: [], total: null, more: false, at: null, error: null };
          const local = await pages(true);
          if (json) return { exitCode: 0, stdout: JSON.stringify({ claude: cache, local }) };
          const lines = [
            `claude.ai (${cache.items.length}${cache.error ? `, ${cache.error}` : ""}):`,
            ...cache.items.map((a) => `  ${a.owner === "mine" ? "" : "[shared] "}${a.title}  ${a.url}`),
            `Saved by bb chats (${local.length}):`,
            ...local.slice(0, 100).map((p) => `  ${p.title}  ${p.path}`),
          ];
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        case "publish": {
          if (!arg) break;
          const file = resolve(arg);
          const r = await publishPath(file, asNew);
          bb.realtime.publish(CHANGED, { at: Date.now() });
          if (!r.url) return { exitCode: 1, stderr: r.error ?? "Publish failed." };
          return { exitCode: 0, stdout: json ? JSON.stringify(r) : `Published ${file}\n${r.url}\nPrivate until shared: open it and use Share.` };
        }
        case "open": {
          if (!arg) break;
          if (isClaudeUrl(arg)) {
            const r = await openArtifact(arg, true);
            return r.ok ? { exitCode: 0, stdout: `Opened ${arg}${r.inApp ? " in the Claude app" : ""}` } : { exitCode: 1, stderr: "Couldn't open it." };
          }
          const target = resolve(arg);
          if (!(existsSync(target) && isPage(target))) return { exitCode: 1, stderr: "Give a claude.ai artifact link or an .html/.md file." };
          return (await openInChrome(target)) ? { exitCode: 0, stdout: `Opened ${target}` } : { exitCode: 1, stderr: "Couldn't open Chrome." };
        }
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.log.info(`loaded; Claude Code: ${[claude.cmd, ...claude.prefix].join(" ")}`);
}

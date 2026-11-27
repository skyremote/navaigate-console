// bb-plugin-artifacts frontend: an Artifacts page like the Claude app's, in bb's left rail.
//
// Cards come from two places: pages bb chats saved (with a preview picture) and the person's
// claude.ai artifacts. Share publishes a bb page to claude.ai if needed, copies the link and opens
// it in the Claude desktop app (Chrome without it), where Claude's own Share menu sets who can open
// it. Install as app opens the artifact in the Claude app, where Claude's own "Install as app" turns
// it into a real Mac or Windows app (own window and icon, Claude and connectors, updates).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, experimental_copyToClipboard as copy, UrlLink, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Gallery, LocalItem, rpcContract } from "./server";
import { claudeAppLink, type ClaudeArtifact } from "./lib/artifact-list";
import { Button } from "@/components/ui/button";
import { Copy, Laptop, CircleAlert, CircleCheck, Ellipsis, ExternalLink, FolderOpen, Globe, KeyRound, Link, LoaderCircle, MessageSquare, Pin, RefreshCw, Search, X, type LucideIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Tab = "all" | "yours" | "shared" | "bb";
const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "yours", label: "Yours" },
  { id: "shared", label: "Shared with you" },
  { id: "bb", label: "Made in BB" },
];

type Card = {
  key: string;
  title: string;
  owner: "mine" | "shared";
  url: string | null;
  local: LocalItem | null;
  claude: ClaudeArtifact | null;
  date: number | null;
  pinned: boolean;
};

type Note = { tone: "ok" | "error"; text: string };

function ago(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

function cardsOf(g: Gallery): Card[] {
  const byUrl = new Map(g.claude.items.map((a) => [a.url, a]));
  const used = new Set<string>();
  const cards: Card[] = g.local.map((p) => {
    const twin = p.publishedUrl ? byUrl.get(p.publishedUrl) ?? null : null;
    if (twin) used.add(twin.url);
    return { key: `l:${p.path}`, title: p.title, owner: "mine", url: p.publishedUrl, local: p, claude: twin, date: p.mtime, pinned: twin?.pinned ?? false };
  });
  for (const a of g.claude.items) {
    if (used.has(a.url)) continue;
    cards.push({ key: `c:${a.url}`, title: a.title, owner: a.owner, url: a.url, local: null, claude: a, date: a.updated ? Date.parse(a.updated) : null, pinned: a.pinned });
  }
  return cards.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.date ?? 0) - (a.date ?? 0));
}

function useGallery() {
  const rpc = useRpc<typeof rpcContract>();
  const [g, setG] = useState<Gallery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("gallery", null).then(
      (r) => {
        setG(r);
        setError(null);
      },
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(() => load(), [load]);
  useRealtime("artifacts-changed", load);
  return { rpc, g, error, load };
}

function Thumb({ item }: { item: LocalItem }) {
  const rpc = useRpc<typeof rpcContract>();
  const [src, setSrc] = useState<string | null>(null);
  const [pending, setPending] = useState(item.kind === "html");
  const ref = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const fetchThumb = useCallback(() => {
    rpc.call("thumb", { path: item.path }).then(
      (r) => {
        setSrc(r.dataUrl);
        setPending(r.pending);
      },
      () => setPending(false),
    );
  }, [rpc, item.path]);
  useEffect(() => {
    if (seen && item.kind === "html") fetchThumb();
  }, [seen, item.kind, item.mtime, fetchThumb]);
  useRealtime("artifacts-thumb", (payload) => {
    if ((payload as { path?: string } | null)?.path === item.path) fetchThumb();
  });

  if (item.kind === "md") {
    return (
      <div ref={ref} className="flex h-full items-end justify-center px-6 pt-5">
        <div className="h-full w-full overflow-hidden rounded-t-md border border-b-0 border-border bg-background px-4 pt-3 shadow-sm">
          <div className="truncate text-[13px] font-semibold text-foreground">{item.title}</div>
          <p className="mt-1.5 line-clamp-5 whitespace-pre-line text-[10px] leading-snug text-muted-foreground">{item.snippet}</p>
        </div>
      </div>
    );
  }
  return (
    <div ref={ref} className="flex h-full items-end justify-center px-6 pt-5">
      <div className="relative h-full w-full overflow-hidden rounded-t-md border border-b-0 border-border bg-background shadow-sm">
        {src ? <img src={src} alt="" className="h-full w-full object-cover object-top" draggable={false} /> : null}
        {!src ? (
          <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">{pending ? "Making a preview…" : "No preview"}</div>
        ) : null}
      </div>
    </div>
  );
}

function ClaudePreview({ card }: { card: Card }) {
  return (
    <div className="flex h-full items-end justify-center px-6 pt-5">
      <div className="flex h-full w-full flex-col justify-between overflow-hidden rounded-t-md border border-b-0 border-border bg-background px-4 pt-3 shadow-sm">
        <div className="line-clamp-3 text-[15px] font-semibold leading-snug text-foreground">{card.title}</div>
        <div className="mb-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Globe className="size-3.5" />
          claude.ai
        </div>
      </div>
    </div>
  );
}

function Menu({ items }: { items: { label: string; icon: LucideIcon; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="icon" className="size-8" aria-label="More" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <Ellipsis className="size-4" />
      </Button>
      {open ? (
        <div role="menu" className="absolute bottom-9 right-0 z-20 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-state-hover"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.run();
              }}
            >
              <it.icon className="size-4 text-muted-foreground" />
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArtifactCard({ card, busy, claudeApp, onShare, onShareNew, onInstall, onOpen, onOpenInApp, onCopy, onChat, onReveal }: {
  card: Card;
  busy: string | null;
  claudeApp: boolean;
  onShare: () => void;
  onShareNew: () => void;
  onInstall: () => void;
  onOpen: () => void;
  onOpenInApp: () => void;
  onCopy: () => void;
  onChat: () => void;
  onReveal: () => void;
}) {
  const p = card.local;
  const meta = p
    ? [p.threadTitle ? `From “${p.threadTitle}”` : "Made in BB", ago(p.mtime)].filter(Boolean).join(" · ")
    : [card.owner === "shared" ? "Shared with you" : "claude.ai", card.date ? ago(card.date) : ""].filter(Boolean).join(" · ");
  const menu = [
    { label: "Open in Chrome", icon: ExternalLink, run: onOpen },
    ...(card.url && claudeApp ? [{ label: "Open in the Claude app", icon: Laptop, run: onOpenInApp }] : []),
    ...(card.url ? [{ label: "Copy link", icon: Link, run: onCopy }] : []),
    ...(p && card.url ? [{ label: "Share as a new artifact", icon: Copy, run: onShareNew }] : []),
    ...(p?.threadId ? [{ label: "Open the chat", icon: MessageSquare, run: onChat }] : []),
    ...(p ? [{ label: "Show in folder", icon: FolderOpen, run: onReveal }] : []),
  ];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={p || !claudeApp ? onOpen : onOpenInApp}
      onKeyDown={(e) => {
        if (e.key === "Enter") (p || !claudeApp ? onOpen : onOpenInApp)();
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-muted">
        {p ? <Thumb item={p} /> : <ClaudePreview card={card} />}
        {card.pinned ? (
          <span className="absolute right-2.5 top-2.5 flex size-7 items-center justify-center rounded-md border border-border bg-background" title="Pinned on claude.ai">
            <Pin className="size-3.5" />
          </span>
        ) : null}
        {busy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-[13px] font-medium text-foreground backdrop-blur-[1px]">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            {busy}
          </div>
        ) : null}
      </div>
      <div className="flex items-start gap-2 border-t border-border px-3.5 pb-2.5 pt-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-foreground">{card.title}</div>
          <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{meta}</div>
          {p?.stale ? <div className="mt-0.5 text-[11px] text-muted-foreground">Changed since it was shared. Share again to update it.</div> : null}
        </div>
        {card.url ? (
          <span className="mt-0.5 text-muted-foreground" title="On claude.ai">
            <Globe className="size-4" />
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1 px-2.5 pb-2.5" onClick={(e) => e.stopPropagation()}>
        <Button variant="outline" size="sm" className="h-8" disabled={!!busy} onClick={onShare}>
          <Link className="size-3.5" />
          Share
        </Button>
        <Button variant="ghost" size="sm" className="h-8" disabled={!!busy} onClick={onInstall}>
          <Laptop className="size-3.5" />
          Install as app
        </Button>
        <div className="ml-auto">
          <Menu items={menu} />
        </div>
      </div>
    </div>
  );
}

function ArtifactsPage() {
  const nav = useBbNavigate();
  const { rpc, g, error, load } = useGallery();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Note | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // claude:// links open through bb's own app-link handling, from this window, so Windows lets the
  // Claude app come to the front. A hidden bb link is clicked once its address is set.
  const [appLink, setAppLink] = useState<{ href: string; n: number } | null>(null);
  const appLinkBox = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (appLink) appLinkBox.current?.querySelector("a")?.click();
  }, [appLink]);
  /** Open a claude.ai artifact in the Claude app when it's installed; true if handed over. */
  const openInApp = (url: string): boolean => {
    const href = g?.claudeApp ? claudeAppLink(url) : null;
    if (!href) return false;
    setAppLink((prev) => ({ href, n: (prev?.n ?? 0) + 1 }));
    return true;
  };

  const cards = useMemo(() => (g ? cardsOf(g) : []), [g]);
  const counts = useMemo(
    () => ({ all: cards.length, yours: cards.filter((c) => c.owner === "mine").length, shared: cards.filter((c) => c.owner === "shared").length, bb: cards.filter((c) => c.local).length }),
    [cards],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => {
      if (tab === "yours" && c.owner !== "mine") return false;
      if (tab === "shared" && c.owner !== "shared") return false;
      if (tab === "bb" && !c.local) return false;
      return !q || c.title.toLowerCase().includes(q) || (c.local?.threadTitle ?? "").toLowerCase().includes(q);
    });
  }, [cards, tab, query]);

  const fail = (cause: unknown) => setNote({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
  const withBusy = async (card: Card, label: string, task: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [card.key]: label }));
    setNote(null);
    try {
      await task();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[card.key];
        return next;
      });
    }
  };

  /** The card's claude.ai link, publishing the bb page first when it has none or changed since. */
  const linkFor = async (card: Card, asNew = false): Promise<{ url: string | null; fresh: boolean }> => {
    if (card.url && !card.local?.stale && !asNew) return { url: card.url, fresh: false };
    if (!card.local) return { url: card.url, fresh: false };
    const r = await rpc.call("publish", { path: card.local.path, asNew });
    if (!r.url) {
      setNote({ tone: "error", text: r.error ?? "Publishing didn't work." });
      return { url: null, fresh: false };
    }
    return { url: r.url, fresh: true };
  };

  const needsPublish = (card: Card) => !!card.local && (!card.url || card.local.stale);

  const share = (card: Card, asNew = false) =>
    withBusy(card, asNew || !card.url ? "Publishing to claude.ai…" : card.local?.stale ? "Updating on claude.ai…" : "Opening…", async () => {
      const { url, fresh } = await linkFor(card, asNew);
      if (!url) return;
      const copied = await copy({ text: url }).catch(() => false);
      const inApp = openInApp(url) || (await rpc.call("open", { target: url, inApp: false })).inApp;
      const where = inApp ? "the Claude app" : "Chrome";
      setNote({
        tone: "ok",
        text: `${fresh ? `“${card.title}” is now on your claude.ai artifacts. ` : ""}It's open in ${where}${copied ? " and the link is copied" : ""}. Click Share at the top right to choose who can open it${card.owner === "mine" ? ", for example Anyone with the link" : ""}.`,
      });
      if (fresh) load();
    });

  /** Claude's own Install as app lives in the Claude desktop app: publish if needed and open it there. */
  const install = (card: Card) =>
    withBusy(card, needsPublish(card) ? "Publishing, then opening Claude…" : "Opening Claude…", async () => {
      const r = await rpc.call("install", { url: card.url && !card.local?.stale ? card.url : null, path: needsPublish(card) ? card.local!.path : null });
      if (r.ok && r.url) openInApp(r.url);
      setNote(
        r.ok
          ? { tone: "ok", text: `“${card.title}” is open in the Claude app. Click Share at the top right, then Install as app, and confirm. It then gets its own icon and window, and updates when the artifact does.` }
          : { tone: "error", text: r.error ?? "Couldn't open the Claude app." },
      );
      load();
    });

  /** Click on a card: a bb page opens in Chrome; a claude.ai artifact in the Claude app when it's installed. */
  const open = (card: Card, inApp = true) => {
    if (inApp && card.url && openInApp(card.url)) return;
    rpc.call("open", { target: card.local?.path ?? card.url ?? "", inApp: false }).catch(fail);
  };

  const signIn = () => {
    setSigningIn(true);
    setNote({ tone: "ok", text: "claude.ai's sign-in page is opening in your browser. Approve it there, then come back." });
    rpc
      .call("sign_in", null)
      .then((r) => setNote(r.ok ? { tone: "ok", text: "Signed in. Loading your claude.ai artifacts…" } : { tone: "error", text: r.error ?? "Sign-in didn't finish." }), fail)
      .finally(() => {
        setSigningIn(false);
        load();
      });
  };

  const refresh = () => {
    setRefreshing(true);
    rpc.call("refresh", null).then(load, fail).finally(() => setRefreshing(false));
  };

  const status = g?.status ?? null;
  const listBusy = refreshing || !!g?.claude.refreshing;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <span ref={appLinkBox} className="hidden" aria-hidden>
        {appLink ? <UrlLink key={appLink.n} href={appLink.href} tabIndex={-1}>Open in Claude</UrlLink> : null}
      </span>
      <div className="mx-auto box-border w-full max-w-6xl px-5 pb-10 pt-6 md:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Artifacts</h1>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search artifacts" aria-label="Search artifacts" className="h-9 w-56 pl-8" />
            </div>
            {g?.claude.at && !listBusy ? <span className="hidden text-[12px] text-muted-foreground md:inline">Updated {ago(g.claude.at)}</span> : null}
            <Button variant="ghost" size="sm" className="h-9" onClick={refresh} disabled={listBusy}>
              <RefreshCw className={cn("size-4", listBusy && "animate-spin")} />
              {listBusy ? "Updating…" : "Refresh"}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex gap-5 border-b border-border" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "-mb-px border-b-2 px-0.5 pb-2 text-[13px] font-medium transition-colors",
                tab === t.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              <span className="ml-1.5 text-muted-foreground">{counts[t.id]}</span>
            </button>
          ))}
        </div>

        {status && !status.loggedIn ? (
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
            <KeyRound className="size-4 text-muted-foreground" />
            <p className="min-w-0 flex-1 text-[13px] text-foreground">
              {status.installed
                ? status.error ?? "Connect Claude Code to your claude.ai account to see your claude.ai artifacts and share from here."
                : status.error ?? "Claude Code wasn't found on this computer."}
            </p>
            {status.installed ? (
              <Button size="sm" onClick={signIn} disabled={signingIn}>
                {signingIn ? "Waiting for approval…" : "Sign in to claude.ai"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {g?.claude.error && status?.loggedIn ? <p className="mt-4 text-[12px] text-muted-foreground">claude.ai list: {g.claude.error}</p> : null}
        {note ? (
          <div role="status" className={cn("mt-4 flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-[13px]", note.tone === "error" ? "border-destructive/40 text-destructive" : "border-border bg-card text-foreground")}>
            {note.tone === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <CircleCheck className="mt-0.5 size-4 shrink-0" />}
            <span className="min-w-0 flex-1">{note.text}</span>
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Dismiss" onClick={() => setNote(null)}>
              <X className="size-4" />
            </button>
          </div>
        ) : null}
        {error ? <p role="alert" className="mt-4 text-[13px] text-destructive">{error}</p> : null}

        {!g ? (
          <p className="mt-10 text-center text-[13px] text-muted-foreground">Loading your artifacts…</p>
        ) : shown.length === 0 ? (
          <p className="mt-10 text-center text-[13px] text-muted-foreground">
            {query ? "Nothing matches that search." : tab === "shared" ? "Nobody has shared an artifact with you yet." : "No artifacts here yet. Pages your chats save in their artifacts folder appear here."}
          </p>
        ) : (
          <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((card) => (
              <ArtifactCard
                key={card.key}
                card={card}
                busy={busy[card.key] ?? null}
                onShare={() => void share(card)}
                onShareNew={() => void share(card, true)}
                onInstall={() => void install(card)}
                claudeApp={g.claudeApp}
                onOpen={() => open(card, false)}
                onOpenInApp={() => open(card, true)}
                onCopy={() => {
                  if (card.url) void copy({ text: card.url }).then((ok) => setNote(ok ? { tone: "ok", text: "Link copied." } : { tone: "error", text: "Couldn't copy the link." }));
                }}
                onChat={() => card.local?.threadId && nav.toThread(card.local.threadId)}
                onReveal={() => card.local && void rpc.call("reveal", { path: card.local.path }).catch(fail)}
              />
            ))}
          </div>
        )}
        {g?.claude.more ? <p className="mt-6 text-center text-[12px] text-muted-foreground">Showing your 200 most recent claude.ai artifacts.</p> : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "artifacts",
    title: "Artifacts",
    icon: "Copy",
    path: "artifacts",
    component: ArtifactsPage,
  });
});

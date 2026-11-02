// Small chips in the row under the chat box, after bb's folder, checkout
// and (+) items: "Send to the always-on Mac" and, for Claude and Codex chats, the account the
// chat runs on.
//
// bb has no slot there, so (like the usage dock and the new-thread hero) an app
// overlay places a span at the end of the footer's left group and portals into
// it, re-placing it with a MutationObserver when bb re-renders the footer.
// In a chat (/threads/) both chips show; on the new-thread screen "Run on the always-on Mac"
// (switches bb's machine picker to the always-on Mac) and the account chip, the latter
// only while a Claude or Codex model is picked.
import { useFeature } from "./use-feature";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import * as DM from "@radix-ui/react-dropdown-menu";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useAppPanel as useAppPanel,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { PoolList, PoolProvider } from "../server-pool";
import type { M1Machine } from "../server-machines";
import { CloudGlyph, m1Tone, useM1, useM1Actions } from "./m1";
import { useComposerHandle } from "./composer-bridge";
import { HoldChip } from "./composer-chips-hold";
import { AllowanceChip } from "./allowance";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { useVisiblePoll } from "./visible-poll";
import { Mac, mac, macLabel } from "./words";
import { useProfile } from "./use-profile";
import { handoffOn } from "../lib/profile-console";
import { alwaysOnMachine } from "../profile/schema";

const CHAT_FOOTER = "[data-follow-up-composer-footer]";
const NEW_FOOTER = "[data-new-thread-footer]";
const CLAUDE_MODEL = /\b(opus|sonnet|haiku|fable|claude)\b/i;

type Place = { slot: HTMLElement; where: "chat" | "new"; newProviderId: string | null } | null;

/** The harness named in the new-chat model picker, as the provider whose allowance applies. */
export function providerFromPicker(text: string): string | null {
  if (CLAUDE_MODEL.test(text)) return "claude-code";
  if (/\b(codex|gpt[-\s]?\d|o\d)\b/i.test(text)) return "codex";
  return null;
}

function usePlace(): Place {
  const [place, setPlace] = useState<Place>(null);
  useEffect(() => {
    let current: HTMLElement | null = null;
    let last = "";
    let scheduled = false;
    const sync = () => {
      scheduled = false;
      const p = window.location.pathname;
      const inChat = p.includes("/threads/");
      const isNew = !inChat && !p.startsWith("/plugins/") && !p.startsWith("/settings");
      const footer = inChat ? document.querySelector<HTMLElement>(CHAT_FOOTER) : isNew ? document.querySelector<HTMLElement>(NEW_FOOTER) : null;
      const left = footer?.firstElementChild as HTMLElement | null | undefined;
      if (!left) {
        if (current) {
          current.remove();
          current = null;
          last = "";
          setPlace(null);
        }
        return;
      }
      let moved = false;
      if (!current || !current.isConnected || current.parentElement !== left) {
        current?.remove();
        current = document.createElement("span");
        current.setAttribute("data-bb-plugin-root", "");
        current.setAttribute("data-bb-plugin", "navaigate-skin");
        current.setAttribute("data-nav-composer-chips", "");
        // Shrinkable: the left group has no overflow clip, so a fixed-width slot ran under bb's permission chip.
        current.className = "flex min-w-0 shrink items-center gap-0.5 pl-1";
        left.appendChild(current);
        moved = true;
      } else if (left.lastElementChild !== current) {
        // bb re-rendered its items after ours; move the same node back to the end.
        left.appendChild(current);
      }
      let newProviderId: string | null = null;
      if (!inChat) {
        const form = document.querySelector<HTMLElement>('[data-app-composer-role="primary"] form');
        newProviderId = providerFromPicker(form?.innerText ?? "");
      }
      const key = `${inChat ? "chat" : "new"}:${newProviderId}`;
      if (moved || key !== last) {
        last = key;
        setPlace({ slot: current, where: inChat ? "chat" : "new", newProviderId });
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(sync);
    };
    sync();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("popstate", schedule);
    return () => {
      mo.disconnect();
      window.removeEventListener("popstate", schedule);
      current?.remove();
    };
  }, []);
  return place;
}

const chip =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs leading-tight text-muted-foreground transition-colors " +
  "hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-hover data-[state=open]:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring";

const panel =
  "z-50 min-w-[248px] max-w-[320px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-[13px] text-foreground shadow-lg " +
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

const row =
  "relative flex h-8 cursor-default select-none items-center gap-2.5 rounded-md pl-3 pr-2 outline-none " +
  "data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-45 " +
  "before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded-full before:bg-transparent data-[highlighted]:before:bg-foreground";

function Heading({ children }: { children: ReactNode }) {
  return <DM.Label className="px-3 pb-1 pt-2 text-[12px] font-medium text-muted-foreground">{children}</DM.Label>;
}
function Muted({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-2 pt-1 text-[12px] leading-snug text-muted-foreground">{children}</div>;
}
function Sep() {
  return <DM.Separator className="mx-2 my-1 h-px bg-border" />;
}

function Pop({ trigger, children, open, onOpenChange }: { trigger: ReactNode; children: ReactNode; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const scope = usePortalScopeProps();
  return (
    <DM.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content {...scope} className={panel} side="top" align="start" sideOffset={6} collisionPadding={8}>
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/* ------------------------------- Send to the always-on Mac ------------------------------- */

type Thread = { id: string; displayTitle: string; providerId: string };
type Link = { from: string | null; to: string | null; via: "machine" | "handoff" | null; branch: string | null; at: number | null; onM1: boolean; sha: string | null; verified: boolean | null };
type MoveResult = { newThreadId: string | null; via: string | null; url: string | null; notes: string[]; commit: { sha: string; ref: string; carried: boolean } | null; verified: { machine: string; ok: boolean; sha: string | null; message: string } | null };

const DUPLICATED_NOTE = /^(Uncommitted work pushed as WIP commit |Pushed .+ at commit )/;

/** What a move did, line by line: the commit the always-on Mac started from, whether its clone was seen to hold it, then any other notes. */
export function teleportReceiptLines(res: MoveResult, back = false): string[] {
  const lines: string[] = [];
  if (res.via === "handoff") lines.push(`bb cannot fork a chat across machines, so ${mac()} got a brief of this one.`);
  if (res.commit) lines.push(`Commit ${res.commit.sha.slice(0, 7)} on ${res.commit.ref}${res.commit.carried ? ", your uncommitted work carried as a WIP commit" : ""}.`);
  if (res.verified) lines.push(res.verified.message);
  else if (res.commit && !back) lines.push(`${Mac()}'s clone was not checked: the chat went to ${mac()}'s own bb.`);
  lines.push(...res.notes.filter((note) => !(res.commit && DUPLICATED_NOTE.test(note)) && note !== res.verified?.message));
  return lines;
}

export function TeleportReceipt({ lines }: { lines: string[] }) {
  return <ul data-testid="teleport-receipt" className="flex flex-col gap-0.5">{lines.map((line) => <li key={line} className="break-words">{line}</li>)}</ul>;
}

function useTeleportLink(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [link, setLink] = useState<Link | null>(null);
  const refetch = useCallback(() => {
    rpc.call("teleport_link", { threadId }).then(setLink, () => setLink(null));
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime("teleport", refetch);
  return link;
}

function M1Chip({ thread }: { thread: Thread }) {
  useProfile();
  const state = useM1();
  const actions = useM1Actions();
  const nav = useBbNavigate();
  const panel = useAppPanel();
  const rpc = useRpc<typeof rpcContract>();
  const link = useTeleportLink(thread.id);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState<{ files: number; branch: string | null } | null>(null);
  useEffect(() => {
    if (!open) setDirty(null);
  }, [open]);
  const item = state.items[thread.id];

  const report = (res: MoveResult, t: string | number, back = false) => {
    const where = back ? "Back on the laptop" : res.via === "machine" ? `Moved to ${mac()}` : `Handed to ${mac()}'s own bb`;
    const lines = teleportReceiptLines(res, back);
    toast.success(where, {
      id: t,
      description: lines.length ? <TeleportReceipt lines={lines} /> : undefined,
      action: res.url ? { label: "Watch", onClick: () => window.open(res.url ?? "", "_blank", "noopener") } : undefined,
    });
    if (res.newThreadId && res.via === "machine") nav.toThread(res.newThreadId);
  };
  const fail = (t: string | number, what: string) => (e: unknown) => toast.error(what, { id: t, description: e instanceof Error ? e.message : String(e) });

  const move = (choice?: "carry" | "leave") => {
    setBusy(true);
    const t = toast.loading(`Moving this chat to ${mac()}…`, { description: "Stopping it here, pushing the work and writing the brief." });
    rpc
      .call("teleport_move", choice ? { threadId: thread.id, dirty: choice } : { threadId: thread.id })
      .then((res) => {
        if (res.needs) {
          toast.dismiss(t);
          setDirty({ files: res.needs.files, branch: res.needs.branch });
          setOpen(true);
          return;
        }
        setOpen(false);
        report(res, t);
      }, fail(t, "Not moved"))
      .finally(() => setBusy(false));
  };
  const bringBack = () => {
    setBusy(true);
    const t = toast.loading("Bringing this chat back to the laptop…");
    rpc
      .call("teleport_back", { threadId: thread.id })
      .then((res) => report(res, t, true), fail(t, "Not brought back"))
      .finally(() => setBusy(false));
  };

  if (link?.onM1) {
    return (
      <Pop
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button type="button" data-nav-part="composer-chip" className={chip} disabled={busy} title={`This chat runs on ${mac()} machine of this bb`}>
            <CloudGlyph size={14} color="currentColor" />
            {busy ? "Bringing back…" : `On ${macLabel()}`}
          </button>
        }
      >
        <Heading>On {mac()}</Heading>
        <Muted>This chat runs on {mac()} at home, inside this bb.{link.from ? " It came from a laptop chat, which is archived." : ""}</Muted>
        {link.sha ? <Muted>Started from commit {link.sha.slice(0, 7)}{link.branch ? ` on ${link.branch}` : ""}{link.verified === true ? `, and ${mac()}'s clone was seen to hold it.` : link.verified === false ? `, but ${mac()}'s clone did not hold it.` : "."}</Muted> : null}
        <Sep />
        <DM.Item className={row} onSelect={bringBack}>
          <span className="size-[14px]" />
          <span className="flex-1">Bring it back to the laptop</span>
        </DM.Item>
        <Muted>
          {link.from ? "Restores the laptop chat and hands it what happened here, " : "Starts a laptop chat from a brief of this one, "}
          then archives this one. {link.branch ? `Code comes back on ${link.branch}.` : ""}
        </Muted>
      </Pop>
    );
  }
  if (item) {
    // Same as the header button: status, and it opens the "On the always-on Mac" panel.
    const t = m1Tone(item.status);
    return (
      <button type="button" data-nav-part="composer-chip" className={chip} title={`On ${mac()}: ${t.label}. Click to see what it is doing.`} onClick={() => panel.openTab({ tab: { id: "m1", context: { kind: "thread" }, availability: "action" }, title: `On ${mac()}` })}>
        <span className={t.pulse ? "inline-flex animate-pulse" : "inline-flex"}>
          <CloudGlyph size={14} color={t.color} />
        </span>
        On {mac()}
      </button>
    );
  }
  return (
    <Pop
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" data-nav-part="composer-chip" className={chip} disabled={busy} title={`Move this chat to ${mac()} at home, or send it a brief`}>
          <CloudGlyph size={14} color="currentColor" />
          {busy ? "Moving…" : macLabel()}
        </button>
      }
    >
      {dirty ? (
        <>
          <Heading>Uncommitted changes</Heading>
          <Muted>
            {dirty.files} file{dirty.files === 1 ? "" : "s"} changed and not committed{dirty.branch ? ` on ${dirty.branch}` : ""}. Carry them over as a WIP commit on teleport/{thread.id}; your
            branch and working tree stay as they are.
          </Muted>
          <Sep />
          <DM.Item className={row} onSelect={() => move("carry")}>
            <CloudGlyph size={14} color="currentColor" />
            <span className="flex-1">Carry them over</span>
          </DM.Item>
          <DM.Item className={row} onSelect={() => move("leave")}>
            <span className="size-[14px]" />
            <span className="flex-1">Move without them</span>
          </DM.Item>
          <DM.Item className={row} onSelect={() => setDirty(null)}>
            <span className="size-[14px]" />
            <span className="flex-1 text-muted-foreground">Cancel</span>
          </DM.Item>
        </>
      ) : (
        <>
          <Heading>Move to {mac()}</Heading>
          <Muted>
            Stops this chat here, pushes the work, starts it again on {mac()} from a brief of the conversation and archives this one (restorable). bb cannot fork a chat across
            machines, so {mac()} chat starts from the brief, not the full history.
          </Muted>
          <Sep />
          <DM.Item className={row} disabled={busy} onSelect={(e) => { e.preventDefault(); move(); }}>
            <CloudGlyph size={14} color="currentColor" />
            <span className="flex-1">Move this chat to {mac()}</span>
          </DM.Item>
          <DM.Item
            className={row}
            onSelect={() => {
              setBusy(true);
              void actions.send(thread).finally(() => setBusy(false));
            }}
          >
            <span className="size-[14px]" />
            <span className="flex-1">Only send {mac()} a brief</span>
          </DM.Item>
          <Muted>The brief goes to {mac()}'s own bb and this chat stays here.</Muted>
        </>
      )}
    </Pop>
  );
}

/* --------------------------- Claude and Codex account --------------------------- */

const POOL_NAME: Record<PoolProvider, string> = { claude: "Claude", codex: "Codex" };

/** The pool a chat's harness draws from, or null for a harness with no pooled accounts. */
export function poolProviderOf(providerId: string | null | undefined): PoolProvider | null {
  if (!providerId) return null;
  if (/claude/i.test(providerId)) return "claude";
  if (/codex/i.test(providerId)) return "codex";
  return null;
}

function usePool(provider: PoolProvider) {
  const rpc = useRpc<typeof rpcContract>();
  const [pool, setPool] = useState<PoolList | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("pool_list", { provider }).then(setPool, () => undefined);
    rpc.call("pool_account", { provider, sessionId: null }).then((r) => setActive(r.activeAccountId), () => undefined);
  }, [rpc, provider]);
  useEffect(() => {
    setPool(null);
    setActive(null);
    refetch();
  }, [refetch]);
  useVisiblePoll(refetch, 60_000);
  useRealtime("pool-order", refetch);
  return { pool, setPool, active, refetch };
}

/** The pooled account this chat is pinned to (null until its first turn has gone through the pool). */
function useThreadAccount(provider: PoolProvider, threadId: string | null) {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const [pinned, setPinned] = useState<string | null>(null);
  const current = useRef(`${provider}:${threadId}`);
  current.current = `${provider}:${threadId}`;
  const load = useCallback(async () => {
    if (!threadId) return;
    const asked = `${provider}:${threadId}`;
    const r = (await sdk.threads.context({ threadId })) as unknown as { usage: null | { snapshot?: { providerSessionId?: string } } };
    const sessionId = r.usage?.snapshot?.providerSessionId ?? null;
    if (!sessionId) return;
    const { accountId } = await rpc.call("pool_account", { provider, sessionId });
    if (current.current === asked) setPinned(accountId);
  }, [sdk, rpc, provider, threadId]);
  useEffect(() => {
    setPinned(null);
    void load().catch(() => undefined);
  }, [load]);
  useVisiblePoll(() => void load().catch(() => undefined), 60_000);
  return pinned;
}

function AccountDot() {
  return <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: "var(--foreground)" }} />;
}

function AccountChip({ provider, threadId }: { provider: PoolProvider; threadId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const { pool, setPool, active, refetch } = usePool(provider);
  const pinned = useThreadAccount(provider, threadId);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) refetch();
  }, [open, refetch]);
  const name = POOL_NAME[provider];
  const accounts = pool?.accounts ?? [];
  if (accounts.length === 0) return null;
  const byId = (id: string | null) => accounts.find((a) => a.id === id) ?? null;
  const activeAcc = byId(active);
  const mine = threadId ? (byId(pinned) ?? activeAcc) : activeAcc;
  const first = accounts[0];
  const label = mine ? mine.short : "pool";
  const title = threadId
    ? pinned
      ? `This chat runs on ${mine?.email ?? label}. It stays on that account.`
      : `This chat has not been pinned yet; its next turn goes to ${activeAcc?.email ?? "the pool's current account"}.`
    : `New ${name} chats start on ${activeAcc?.email ?? "the pool's current account"}.`;

  const putFirst = (id: string) => {
    const target = byId(id);
    const t = toast.loading(`Putting ${target?.short ?? "that account"} first…`);
    rpc.call("pool_put_first", { provider, accountId: id }).then(
      (res) => {
        setPool(res);
        refetch();
        toast.success("Failover order changed", { id: t, description: `Now ${res.accounts.map((a) => `${a.short} (${a.priority})`).join(", then ")}. New chats stay on the current account until it hits its limit.` });
      },
      (e: unknown) => toast.error("Order not changed", { id: t, description: e instanceof Error ? e.message : String(e) }),
    );
  };

  return (
    <Pop
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" data-nav-part="composer-chip" data-provider={provider} className={chip} title={title}>
          <AccountDot />
          {name} · {label}
        </button>
      }
    >
      <Heading>{name} accounts</Heading>
      {accounts.map((a) => {
        const tags = [threadId && mine?.id === a.id ? "this chat" : null, active === a.id ? "new chats" : null, a.enabled ? null : "off"].filter(Boolean);
        return (
          <div key={a.id} className="flex items-center gap-2.5 px-3 py-1.5">
            <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full" style={{ background: tags.includes("this chat") || (!threadId && active === a.id) ? "var(--foreground)" : "var(--border)" }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{a.short}</span>
                {tags.map((t) => (
                  <span key={t as string} className="rounded-[4px] border border-border px-1 text-[11px] leading-[14px] text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">{a.email}</div>
            </div>
            <div className="shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              <div>
                <span className="text-foreground">{a.weekPct ?? "–"}%</span> week
              </div>
              <div>{a.sessionPct ?? "–"}% session</div>
            </div>
          </div>
        );
      })}
      <Sep />
      <Heading>Failover order</Heading>
      <Muted>{accounts.map((a) => a.short).join(", then ")}</Muted>
      {accounts.length > 1
        ? accounts.map((a) => (
            <DM.Item key={a.id} className={row} disabled={a.id === first.id} onSelect={() => putFirst(a.id)}>
              <span className="size-1.5" />
              <span className="flex-1">Put {a.short} first</span>
              {a.id === first.id ? <span className="text-[11px] text-muted-foreground">first now</span> : null}
            </DM.Item>
          ))
        : null}
      <Sep />
      <Muted>
        {threadId && mine ? `This chat stays on ${mine.short}. ` : ""}
        New chats go to {activeAcc?.short ?? "the pool's current account"} until it hits its limit, then move on in this order. The pool cannot move a running chat to another account.
      </Muted>
    </Pop>
  );
}


/* ------------------------------- Run on the always-on Mac -------------------------------- */
// The always-on Mac is also a machine of THIS bb ("the always-on Mac" in Settings, Machines). On the
// new-thread screen this chip switches bb's own machine picker to the always-on Mac, in
// the project's checkout there, so the next chat runs at home but stays here.

function M1MachineGlyph({ size = 13, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

type Env = { type: string; hostId?: string; machine?: { type: string; hostId?: string } | null; workspace?: { type: string; path?: string | null } };
/** The machine a composer selection runs on: a host environment names it directly, a provider one (project checkout) through `machine`. */
const hostOf = (env: Env | null | undefined) => env?.hostId ?? env?.machine?.hostId ?? null;

function useM1Machine(projectId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [m, setM] = useState<M1Machine | null>(null);
  const refetch = useCallback(() => {
    rpc.call("m1_machine", { projectId }).then(setM, () => setM(null));
  }, [rpc, projectId]);
  useEffect(() => {
    setM(null);
    refetch();
  }, [refetch]);
  return { m, setM, refetch };
}

function RunOnM1Chip() {
  useProfile();
  const handle = useComposerHandle(null);
  const rpc = useRpc<typeof rpcContract>();
  const scope = handle?.api.scope;
  const projectId = scope?.kind === "new-thread" ? scope.projectId : null;
  const { m, setM, refetch } = useM1Machine(projectId);
  const [env, setEnv] = useState<Env | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const readSelection = useCallback(() => {
    if (!handle) return;
    setEnv((handle.api.selection?.environment as Env | undefined) ?? null);
  }, [handle]);
  useEffect(readSelection, [readSelection, projectId]);
  useEffect(() => {
    if (open) {
      refetch();
      readSelection();
    }
  }, [open, refetch, readSelection]);

  if (!handle || !m?.hostId) return null;
  const onM1 = hostOf(env) === m.hostId;

  const select = async (target: "m1" | "here", state: M1Machine) => {
    const path = target === "m1" ? state.sourcePath : state.localPath;
    const hostId = target === "m1" ? state.hostId : state.localHostId;
    if (!path || !hostId) return;
    const sel = await handle.api.setSelection({ environment: { type: "host", hostId, workspace: { type: "unmanaged", path } } });
    setEnv((sel.environment as Env | undefined) ?? null);
    const landed = hostOf(sel.environment as Env | undefined) === hostId;
    if (!landed) toast.error("The machine picker did not switch", { description: "Pick the machine in bb's own picker under the chat box." });
    else if (target === "m1") toast.success(`The next chat runs on ${mac()}`, { description: `In ${path} on ${mac()}. It stays in this bb, so you see it here as usual.` });
    else toast.success("The next chat runs on this laptop");
  };

  const setUp = async () => {
    if (!projectId) return;
    setBusy(true);
    const t = toast.loading(m?.cloneFrom ? `Setting the project up on ${mac()} (cloning it if needed)…` : `Setting the project up on ${mac()}…`);
    try {
      const next = await rpc.call("m1_machine_link", { projectId });
      setM(next);
      toast.success(next.cloned ? `Cloned onto ${mac()}` : `${Mac()} has this project now`, { id: t, description: next.sourcePath ?? undefined });
      await select("m1", next);
    } catch (e) {
      toast.error(`Not set up on ${mac()}`, { id: t, description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const title = onM1 ? `The next chat runs on ${mac()} at home` : `Start the next chat on ${mac()} at home, in this bb`;
  return (
    <Pop
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" data-nav-part="composer-chip" className={chip} title={title} disabled={busy}>
          <M1MachineGlyph size={14} color={onM1 ? "var(--foreground)" : m.connected ? "currentColor" : "var(--muted-foreground)"} />
          {onM1 ? `On ${macLabel()}` : `Run on ${macLabel()}`}
        </button>
      }
    >
      <Heading>Run on {mac()}</Heading>
      <Muted>
        The chat runs on {mac()} at home and stays in this bb, so it shows in the sidebar like any other. The laptop must stay awake: it is the bb server {mac()} reports to.
      </Muted>
      {!m.connected ? <Muted>{Mac()} is not connected right now (asleep, offline, or its bb machine service stopped).</Muted> : null}
      <Sep />
      {m.sourcePath ? (
        onM1 ? (
          <DM.Item className={row} disabled={!m.localPath} onSelect={() => void select("here", m)}>
            <span className="size-[14px]" />
            <span className="flex-1">Run it on this laptop instead</span>
          </DM.Item>
        ) : (
          <DM.Item className={row} disabled={!m.connected} onSelect={() => void select("m1", m)}>
            <M1MachineGlyph size={14} color="currentColor" />
            <span className="flex-1">Start this chat on {mac()}</span>
          </DM.Item>
        )
      ) : m.suggestedPath ? (
        <DM.Item className={row} disabled={!m.connected || busy} onSelect={() => void setUp()}>
          <M1MachineGlyph size={14} color="currentColor" />
          <span className="min-w-0 flex-1 truncate" title={m.suggestedPath}>
            Set this project up on {mac()}
          </span>
        </DM.Item>
      ) : (
        <Muted>This project has no folder here to match on {mac()}</Muted>
      )}
      {m.sourcePath || m.suggestedPath ? <Muted>{m.sourcePath ? `On ${mac()}: ${m.sourcePath}` : `It would use ${m.suggestedPath} on ${mac()}${m.cloneFrom ? `, cloning ${m.cloneFrom} there if the folder is missing` : ""}.`}</Muted> : null}
    </Pop>
  );
}

/* --------------------------------- overlay -------------------------------- */

export function ComposerChips() {
  const place = usePlace();
  const { threadId } = useBbContext();
  const { threads } = useSidebarThreads();
  const profile = useProfile();
  // Hold (EXTRA-AB), move or run on the always-on Mac (F28), the Claude or Codex account list (F03) and the allowance (F48).
  const holdOn = useFeature("EXTRA-AB");
  const moveOn = useFeature("F28");
  const accountsOn = useFeature("F03");
  const allowanceOn = useFeature("F48");
  if (!place) return null;
  if (place.where === "chat") {
    const thread = threadId ? threads.find((t) => t.id === threadId) : undefined;
    if (!thread) return null;
    return createPortal(
      <>
        {holdOn ? <HoldChip threadId={thread.id} /> : null}
        {handoffOn(profile) && moveOn ? <M1Chip thread={thread} /> : null}
        {accountsOn && poolProviderOf(thread.providerId) ? <AccountChip provider={poolProviderOf(thread.providerId)!} threadId={thread.id} /> : null}
      </>,
      place.slot,
    );
  }
  return createPortal(
    <>
      {alwaysOnMachine(profile) && moveOn ? <RunOnM1Chip /> : null}
      {accountsOn && poolProviderOf(place.newProviderId) ? <AccountChip provider={poolProviderOf(place.newProviderId)!} threadId={null} /> : null}
      {allowanceOn ? <AllowanceChip providerId={place.newProviderId} compact className="h-6 min-w-0 shrink px-1.5" /> : null}
    </>,
    place.slot,
  );
}


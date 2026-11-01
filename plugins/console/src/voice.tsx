// Voice agent ("Savvy") in the bb window.
//
// One always-mounted engine (app overlay) owns the ElevenLabs session, so the
// conversation survives moving between chats. Client tools act on whichever
// chat is open: send a prompt to its harness, read its status or last reply,
// stop it, add to-dos. When a watched chat finishes a turn, its reply is pushed
// in as "[HARNESS DONE] ..." and Savvy speaks a short summary.
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  experimental_Icon as Icon,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useAppPanel as useAppPanel,
  useBbContext,
  useRpc,
  useSdk,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Conversation, type VoiceConversation } from "@elevenlabs/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { Lattice, caps, harnessOf, stateOf, tnum } from "./shared";
import { owner } from "./words";

/* ------------------------------ store ------------------------------- */

type Line = { id: number; who: "you" | "savvy" | "harness" | "system"; text: string; at: number };
type VoiceState = {
  status: "off" | "connecting" | "on";
  mode: "listening" | "speaking";
  muted: boolean;
  lines: Line[];
  waiting: number; // watched chats currently working
};

let state: VoiceState = { status: "off", mode: "listening", muted: false, lines: [], waiting: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<VoiceState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
let lineId = 0;
const say = (who: Line["who"], text: string) => set({ lines: [...state.lines, { id: ++lineId, who, text, at: Date.now() }].slice(-200) });

let controls: { start: () => void; stop: () => void; mute: (m: boolean) => void } | null = null;
export const voice = {
  start: () => controls?.start(),
  stop: () => controls?.stop(),
  toggle: () => (state.status === "off" ? controls?.start() : controls?.stop()),
  mute: (m: boolean) => controls?.mute(m),
};

export function useVoiceState(): VoiceState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => state,
  );
}

const RUNNING = new Set(["active", "starting", "stopping"]);

/* ------------------------------ engine ------------------------------ */

export function VoiceEngine() {
  const { threadId } = useBbContext();
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const { threads, projects } = useSidebarThreads();

  const convo = useRef<VoiceConversation | null>(null);
  const current = useRef<string | null>(threadId);
  current.current = threadId ?? current.current;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const watched = useRef<Set<string>>(new Set());
  const lastStatus = useRef<Map<string, string>>(new Map());
  const pending = useRef<string[]>([]); // summaries queued while disconnected

  const thread = (id: string | null): PluginSidebarThread | undefined => (id ? threadsRef.current.find((t) => t.id === id) : undefined);
  const describe = (t: PluginSidebarThread | undefined) => (t ? `${harnessOf(t.providerId).label} in "${t.displayTitle}"` : "the open chat");

  // Watch the open chat automatically while the session is on.
  useEffect(() => {
    if (state.status !== "off" && threadId) watched.current.add(threadId);
  }, [threadId]);

  // Turn ends on watched chats -> push the reply in for a spoken summary.
  useEffect(() => {
    let working = 0;
    for (const t of threads) {
      if (!watched.current.has(t.id)) continue;
      const prev = lastStatus.current.get(t.id);
      const now = t.status;
      lastStatus.current.set(t.id, now);
      if (RUNNING.has(now)) working++;
      if (prev && RUNNING.has(prev) && !RUNNING.has(now)) {
        void (async () => {
          let out = "";
          try {
            out = (await sdk.threads.output({ threadId: t.id })).output ?? "";
          } catch {
            /* the summary falls back to the status */
          }
          const head = `[HARNESS DONE] ${describe(t)}${now === "error" ? " stopped with an error" : " finished"}.`;
          const msg = `${head}\n${out.trim().slice(0, 3000) || "(no text reply)"}`;
          say("harness", `${describe(t)} ${now === "error" ? "stopped with an error" : "finished"}.`);
          if (convo.current && state.status === "on") convo.current.sendUserMessage(msg);
          else pending.current.push(msg);
        })();
      }
    }
    if (working !== state.waiting) set({ waiting: working });
  }, [threads, sdk]);

  // Keep the session alive while a harness works (silence would end it).
  useEffect(() => {
    const t = window.setInterval(() => {
      if (convo.current && state.status === "on" && state.waiting > 0) convo.current.sendUserActivity();
    }, 20_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const clientTools: Record<string, (p: Record<string, unknown>) => Promise<string>> = {
      send_to_harness: async (p) => {
        const id = current.current;
        const t = thread(id);
        const prompt = String(p.prompt ?? "").trim();
        if (!id || !t) return `No chat is open. Ask ${owner()} to open the chat to work on.`;
        if (!prompt) return "Nothing to send.";
        await sdk.threads.send({ threadId: id, mode: "auto", input: [{ type: "text", text: prompt, mentions: [] }] });
        watched.current.add(id);
        say("system", `Sent to ${describe(t)}: ${prompt}`);
        return `Sent to ${describe(t)}.`;
      },
      harness_status: async () => {
        const t = thread(current.current);
        if (!t) return "No chat is open.";
        const s = stateOf(t);
        const words = { running: "is working", needs: `needs ${owner()} (an error, a question or an approval)`, unread: `has finished and ${owner()} has not read it`, parked: "is idle" }[s];
        return `${describe(t)} ${words}.`;
      },
      latest_reply: async () => {
        const id = current.current;
        if (!id) return "No chat is open.";
        const out = (await sdk.threads.output({ threadId: id })).output ?? "";
        return out.trim() ? out.trim().slice(0, 3000) : "The chat has no reply yet.";
      },
      stop_harness: async () => {
        const id = current.current;
        if (!id) return "No chat is open.";
        await sdk.threads.stop({ threadId: id });
        say("system", `Stopped ${describe(thread(id))}.`);
        return `Stopped ${describe(thread(id))}.`;
      },
      add_todo: async (p) => {
        const id = current.current;
        const t = thread(id);
        const items = Array.isArray(p.items) ? p.items.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : [];
        if (!t || !items.length) return !t ? "No chat is open." : "No items given.";
        const proj = projects.find((x) => x.id === t.projectId);
        const r = await rpc.call("todo_add", {
          titles: items,
          bbProjectId: t.projectId,
          bbProjectName: proj ? (proj.isPersonal ? "Personal" : proj.name) : "Personal",
          folderId: null,
          threadId: t.id,
        });
        say("system", `Added to-do: ${r.keys.join(", ")}`);
        return `Added ${r.keys.length} item${r.keys.length === 1 ? "" : "s"}: ${r.keys.join(", ")}.`;
      },
    };

    controls = {
      start: async () => {
        if (state.status !== "off") return;
        set({ status: "connecting" });
        try {
          const { token } = await rpc.call("voice_token");
          const c = (await Conversation.startSession({
            conversationToken: token,
            connectionType: "webrtc",
            clientTools,
            onConnect: () => {
              set({ status: "on" });
              say("system", "Savvy is listening.");
              if (current.current) watched.current.add(current.current);
              for (const t of threadsRef.current) lastStatus.current.set(t.id, t.status);
              const queued = pending.current.splice(0);
              for (const m of queued) convo.current?.sendUserMessage(m);
            },
            onDisconnect: () => {
              convo.current = null;
              set({ status: "off", mode: "listening" });
              say("system", "Voice session ended.");
            },
            onError: (message: string) => {
              toast.error("Voice", { description: message });
            },
            onModeChange: ({ mode }: { mode: "speaking" | "listening" }) => set({ mode }),
            onMessage: (m: { message: string; role?: string; source?: string }) => {
              const who = (m.role ?? m.source) === "user" ? "you" : "savvy";
              if (who === "you" && m.message.startsWith("[HARNESS DONE]")) return; // our own push
              say(who, m.message);
            },
          } as Parameters<typeof Conversation.startSession>[0])) as VoiceConversation;
          convo.current = c;
        } catch (e) {
          set({ status: "off" });
          const msg = e instanceof Error ? e.message : String(e);
          toast.error("Could not start voice", { description: /permission|denied|NotAllowed/i.test(msg) ? "bb needs microphone access (System Settings, Privacy, Microphone)." : msg });
        }
      },
      stop: async () => {
        const c = convo.current;
        convo.current = null;
        set({ status: "off", mode: "listening" });
        await c?.endSession().catch(() => undefined);
      },
      mute: (m: boolean) => {
        convo.current?.setMicMuted(m);
        set({ muted: m });
      },
    };
    return () => {
      controls = null;
    };
    // clientTools read live refs, so they only need the stable sdk/rpc
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, rpc, projects]);

  useEffect(() => () => void convo.current?.endSession().catch(() => undefined), []);
  return null;
}

/* ------------------------------- UI --------------------------------- */

function Bars({ live }: { live: boolean }) {
  return (
    <span aria-hidden className="inline-flex h-3 items-end gap-[2px]">
      {[0, 1, 2].map((i) => (
        <i
          key={i}
          className={cn("block w-[2px] rounded-full bg-current", live && "animate-pulse")}
          style={{ height: live ? `${[55, 100, 70][i]}%` : "35%", animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

/** The header button: the voice pill. Click to start or end; it shows what Savvy is doing. */
export function VoiceHeaderButton() {
  const s = useVoiceState();
  const panel = useAppPanel();
  const on = s.status === "on";
  const label =
    s.status === "connecting" ? "Connecting…" : !on ? "Talk" : s.waiting > 0 && s.mode === "listening" ? "Waiting on harness" : s.mode === "speaking" ? "Savvy" : s.muted ? "Muted" : "Listening";
  return (
    <button
      type="button"
      title={on ? "End the voice session (⌘⇧E)" : "Talk to Savvy (⌘⇧E)"}
      onClick={() => {
        if (!on) panel.openTab({ tab: { id: "voice", context: { kind: "thread" }, availability: "action" }, title: "Voice" });
        voice.toggle();
      }}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-[background-color,transform] duration-200 active:scale-[.97]",
        on ? "bg-[var(--attention)] text-[var(--attention-foreground)]" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {s.status === "connecting" ? <Lattice cell={2} gap={1} /> : on && s.waiting > 0 && s.mode === "listening" ? <Lattice cell={2} gap={1} /> : on ? <Bars live={s.mode === "speaking" || !s.muted} /> : <Icon name="Mic" className="size-3.5" />}
      {label}
    </button>
  );
}

/** The Voice tab in the right-hand panel: controls and the running transcript. */
export function VoicePanel() {
  const s = useVoiceState();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [s.lines.length]);
  const on = s.status === "on";
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <button
          type="button"
          onClick={() => voice.toggle()}
          className={cn("inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition-transform active:scale-[.97]", on ? "bg-[var(--attention)] text-[var(--attention-foreground)]" : "bg-primary text-primary-foreground")}
        >
          <Icon name="Mic" className="size-3.5" />
          {s.status === "connecting" ? "Connecting…" : on ? "End session" : "Talk to Savvy"}
        </button>
        {on ? (
          <button type="button" onClick={() => voice.mute(!s.muted)} className="h-8 rounded-full border border-border px-3 text-[13px] text-muted-foreground hover:text-foreground">
            {s.muted ? "Unmute" : "Mute"}
          </button>
        ) : null}
        <span className={cn(caps, "ml-auto flex items-center gap-1.5")}>
          {on ? (s.mode === "speaking" ? "Speaking" : s.waiting > 0 ? (<><Lattice cell={2} gap={1} /> Harness working</>) : "Listening") : "Off"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {s.lines.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Press Talk and tell Savvy what you want the harness in this chat to do. When the harness finishes, Savvy tells you what it did, what's left and whether it needs you. Voice: Savvy on Eleven v4 Turbo.
          </p>
        ) : null}
        {s.lines.map((l) => (
          <div key={l.id} className={cn("mb-2.5 text-[13px] leading-[1.5]", l.who === "system" && "text-[12px] text-muted-foreground")}>
            {l.who !== "system" ? (
              <span className={cn(caps, "mb-0.5 block", l.who === "savvy" && "text-foreground")}>{l.who === "you" ? "You" : l.who === "savvy" ? "Savvy" : "Harness"}</span>
            ) : null}
            <span className={cn(l.who === "harness" && "text-muted-foreground")}>{l.text}</span>
            <span className="ml-2 text-[11px] text-muted-foreground" style={tnum}>
              {new Date(l.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}

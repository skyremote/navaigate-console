// Set up workspace: the first-run wizard (and the page to change it later).
// Name -> areas of work -> keys -> always-on machine -> done. Everything is
// stored on this computer only: profile.json and keys.env under
// ~/.config/navaigate-workspace. Keys are never sent back to the page; we only
// learn whether each one is set.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import type { Area, KeyName, Profile } from "../server-profile";
import { CompanionsCheck } from "./companions";
import { LogoOrb } from "./orb";
import { GOLD, caps } from "./shared";

export function useProfile() {
  const rpc = useRpc<typeof rpcContract>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const load = useCallback(() => {
    rpc.call("profile_get").then(setProfile, () => undefined);
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("profile", load);
  return { profile, reload: load };
}

/** "Good evening, Sam" once a name is set, else just "Good evening". */
export function useGreeting() {
  const { profile } = useProfile();
  const h = new Date().getHours();
  const g = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return profile?.name ? `${g}, ${profile.name}` : g;
}

const KEYS: Array<{ name: KeyName; label: string; powers: string; get: string; where: string }> = [
  {
    name: "COMPOSIO_API_KEY",
    label: "Composio",
    powers: "Inbox, Calendar and Hand to agent. Connect Gmail and Google Calendar inside Composio first.",
    get: "https://platform.composio.dev",
    where: "Composio dashboard, Settings, API keys",
  },
  {
    name: "TYPESAFE_API_KEY",
    label: "Jev (TypeSafe)",
    powers: "Sorts your inbox into piles and routes the Ask box to the right harness.",
    get: "https://typesafe.ai",
    where: "TypeSafe dashboard, API keys",
  },
  {
    name: "ELEVENLABS_API_KEY",
    label: "ElevenLabs",
    powers: "Talk: the Savvy voice agent in every chat. Your own agent is created on first use.",
    get: "https://elevenlabs.io/app/settings/api-keys",
    where: "ElevenLabs, Settings, API keys",
  },
  {
    name: "CALENDLY_API_TOKEN",
    label: "Calendly",
    powers: "Booking links on the Calendar page. Optional if Calendly is connected in Composio.",
    get: "https://calendly.com/integrations/api_webhooks",
    where: "Calendly, Integrations, API and webhooks",
  },
  {
    name: "BLOTATO_API_KEY",
    label: "Blotato",
    powers: "Social on Home: your scheduled and recent posts, and the Audience row.",
    get: "https://my.blotato.com/settings",
    where: "Blotato, Settings, API",
  },
];

const STEPS = ["You", "Your work", "Your tools", "Always-on machine", "Done"] as const;

const input =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-[color:var(--attention)]";
const btn = "rounded-md border border-border px-3 py-1.5 text-[12.5px] text-foreground hover:border-[color:var(--attention)] disabled:opacity-40";
const primary = "rounded-md bg-foreground px-4 py-1.5 text-[12.5px] font-medium text-background disabled:opacity-40";

type Storage = NonNullable<Profile["storage"]>;
// The mount path starts empty: there is no default that is right on both macOS (/Volumes/...) and Linux (/mnt/...).
const NEW_STORAGE: Storage = { label: "NAS", path: "", localCopy: "~/Storage_Local", homeCheck: "", homeProject: "", awayProject: "" };

export function SetupWizard({ onDone }: { onDone?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { profile } = useProfile();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [keys, setKeys] = useState<Partial<Record<KeyName, string>>>({});
  const [keySet, setKeySet] = useState<Record<string, boolean>>({});
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string } | "testing">>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile && !draft) setDraft(profile);
  }, [profile, draft]);
  useEffect(() => {
    rpc.call("keys_status").then(setKeySet, () => undefined);
  }, [rpc]);

  if (!draft) return <div className="p-8 text-[13px] text-muted-foreground">Loading…</div>;
  const set = (patch: Partial<Profile>) => setDraft({ ...draft, ...patch });
  const setArea = (i: number, patch: Partial<Area>) => set({ areas: draft.areas.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  const test = async (name: string, run: () => Promise<{ ok: boolean; message: string }>) => {
    setTests((t) => ({ ...t, [name]: "testing" }));
    const r = await run().catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
    setTests((t) => ({ ...t, [name]: r }));
  };

  const save = async () => {
    if (draft.storage && !draft.storage.path.trim()) {
      setStep(3);
      toast.error("Where is your storage mounted?", { description: "Fill in the mount path, or untick storage at home." });
      return;
    }
    setSaving(true);
    try {
      // The profile first, so a key that fails to save can never lose the name and areas.
      const areas = draft.areas.filter((a) => a.name.trim());
      const storage = draft.storage ? { ...draft.storage, path: draft.storage.path.trim() } : null;
      await rpc.call("profile_save", { ...draft, name: draft.name.trim(), areas, storage, onboarded: true });
    } catch (e) {
      toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
      setSaving(false);
      return;
    }
    // Only the keys that were entered: none, some or all five.
    const entered = Object.fromEntries(Object.entries(keys).filter(([, v]) => v && v.trim())) as Partial<Record<KeyName, string>>;
    let keysSaved = true;
    if (Object.keys(entered).length) {
      try {
        setKeySet(await rpc.call("keys_save", entered));
      } catch (e) {
        keysSaved = false;
        toast.error("Workspace set up, but your keys were not saved", { description: e instanceof Error ? e.message : String(e) });
      }
    }
    if (keysSaved) toast.success("Workspace set up", { description: "Change any of it later from Set up in the sidebar." });
    setSaving(false);
    onDone?.();
  };

  const canNext = step !== 0 || draft.name.trim().length > 0;
  const TestNote = ({ id }: { id: string }) => {
    const t = tests[id];
    if (!t) return null;
    if (t === "testing") return <span className="text-[12px] text-muted-foreground">Testing…</span>;
    return <span className={cn("text-[12px]", t.ok ? "text-[color:var(--success)]" : "text-destructive")}>{t.message}</span>;
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-6 py-8">
        <div className="flex items-center gap-4">
          <LogoOrb size={56} mood="idle" />
          <div>
            <div className={caps}>NavAIgate Workspace</div>
            <h1 className="text-[22px] font-semibold leading-tight text-foreground">Set up your workspace</h1>
            <div className="text-[12.5px] text-muted-foreground">Everything stays on this computer. You can change any of it later.</div>
          </div>
        </div>

        <ol className="flex flex-wrap gap-1.5">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => (i === 0 || draft.name.trim()) && setStep(i)}
                className={cn("rounded-full border px-3 py-1 text-[12px]", i === step ? "font-medium text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
                style={i === step ? { borderColor: GOLD } : undefined}
              >
                {i + 1}. {s}
              </button>
            </li>
          ))}
        </ol>

        <section className="rounded-xl border border-border bg-card px-6 py-5">
          {step === 0 ? (
            <div className="flex flex-col gap-3">
              <label className="text-[13px] font-medium text-foreground" htmlFor="nw-name">What should we call you?</label>
              <input id="nw-name" className={input} value={draft.name} maxLength={40} placeholder="Your first name" onChange={(e) => set({ name: e.target.value })} autoFocus />
              <p className="text-[12.5px] text-muted-foreground">Used in your greeting, and by your agents, the inbox sorter and the voice agent when they talk about you.</p>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="flex flex-col gap-3">
              <div className="text-[13px] font-medium text-foreground">The areas of your work and life</div>
              <p className="text-[12.5px] text-muted-foreground">
                Jev uses these to tag each email and to give the Ask box context. Two to five works best. Describe each one in a line so Jev can tell them apart.
              </p>
              {draft.areas.map((a, i) => (
                <div key={i} className="grid grid-cols-[160px_1fr_auto] items-start gap-2">
                  <input className={input} value={a.name} maxLength={40} placeholder="Name, e.g. Agency" onChange={(e) => setArea(i, { name: e.target.value })} />
                  <input className={input} value={a.what} maxLength={300} placeholder="What it covers: clients, products, people, topics" onChange={(e) => setArea(i, { what: e.target.value })} />
                  <button type="button" className={btn} onClick={() => set({ areas: draft.areas.filter((_, j) => j !== i) })} aria-label={`Remove ${a.name || "area"}`}>
                    Remove
                  </button>
                </div>
              ))}
              {draft.areas.length < 8 ? (
                <div>
                  <button type="button" className={btn} onClick={() => set({ areas: [...draft.areas, { name: "", what: "" }] })}>
                    Add an area
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-4">
              <div>
                <div className="text-[13px] font-medium text-foreground">Connect your own tools</div>
                <p className="text-[12.5px] text-muted-foreground">
                  Each key is yours and optional: skip any you don't use, and that part of the workspace simply stays empty. Keys are saved to ~/.config/navaigate-workspace/keys.env, readable only by you.
                </p>
              </div>
              {KEYS.map((k) => (
                <div key={k.name} className="flex flex-col gap-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground">{k.label}</span>
                    {keySet[k.name] ? <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-[color:var(--success)]">Set</span> : null}
                    <a href={k.get} target="_blank" rel="noopener noreferrer" className="ml-auto text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                      Get a key
                    </a>
                  </div>
                  <div className="text-[12px] text-muted-foreground">{k.powers} Find it in: {k.where}.</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      autoComplete="off"
                      className={input}
                      value={keys[k.name] ?? ""}
                      placeholder={keySet[k.name] ? "Saved. Paste a new key to replace it" : "Paste your key"}
                      onChange={(e) => setKeys({ ...keys, [k.name]: e.target.value })}
                    />
                    <button type="button" className={btn} disabled={!keys[k.name]?.trim() && !keySet[k.name]} onClick={() => void test(k.name, () => rpc.call("keys_test", { name: k.name, value: keys[k.name] ?? "" }))}>
                      Test
                    </button>
                  </div>
                  <TestNote id={k.name} />
                </div>
              ))}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-4">
              <div>
                <div className="text-[13px] font-medium text-foreground">An always-on machine (optional)</div>
                <p className="text-[12.5px] text-muted-foreground">
                  A home Mac, mini PC or VPS that runs its own bb with your logins. Right-click any chat and choose "Send to my always-on machine" to keep work going while your laptop sleeps or the hotel Wi-Fi struggles, then watch it from your phone. You need SSH access to it with a key (no password prompt).
                </p>
              </div>
              <label className="flex items-center gap-2 text-[13px] text-foreground">
                <input type="checkbox" checked={!!draft.machine} onChange={(e) => set({ machine: e.target.checked ? { label: "home Mac", sshHost: "" } : null })} />
                I have an always-on machine
              </label>
              {draft.machine ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                    What you call it
                    <input className={input} value={draft.machine.label} maxLength={40} placeholder="home Mac, VPS" onChange={(e) => set({ machine: { ...draft.machine!, label: e.target.value } })} />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                    SSH host or alias
                    <input className={input} value={draft.machine.sshHost} maxLength={120} placeholder="user@my-vps or an alias from ~/.ssh/config" onChange={(e) => set({ machine: { ...draft.machine!, sshHost: e.target.value } })} />
                  </label>
                  <div className="flex items-center gap-2 sm:col-span-2">
                    <button type="button" className={btn} disabled={!draft.machine.sshHost.trim()} onClick={() => void test("machine", () => rpc.call("machine_test", { sshHost: draft.machine!.sshHost }))}>
                      Test SSH
                    </button>
                    <TestNote id="machine" />
                  </div>
                  <p className="text-[12px] text-muted-foreground sm:col-span-2">
                    On that machine: install bb, sign in to your harnesses, and run <code>bb connect</code> once so you get a link to watch from anywhere.
                  </p>
                  <p className="text-[12px] text-muted-foreground sm:col-span-2">
                    Optional: to start chats on it from this bb and move chats there and back (the "Run on" and move chips under the chat box), also add it in bb under Settings, Machines, with the same name you typed above.
                  </p>
                </div>
              ) : null}

              <div className="border-t border-border pt-3">
                <label className="flex items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" checked={!!draft.storage} onChange={(e) => set({ storage: e.target.checked ? NEW_STORAGE : null })} />
                  I also keep my files on storage at home (a NAS or shared drive)
                </label>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  Adds a home/away chip on new chats. At home, new work starts on the share; away, it starts on a local copy, and big jobs go to the always-on machine next to the storage.
                </p>
                {draft.storage ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        ["label", "What you call it", "NAS"],
                        ["path", "Where it's mounted (same on both machines)", "/Volumes/MyNAS or /mnt/nas"],
                        ["localCopy", "Local copies when away", "~/Storage_Local"],
                        ["homeCheck", "Address only reachable at home (host:port)", "nas.local:445"],
                        ["homeProject", "bb project on the share", "My NAS"],
                        ["awayProject", "bb project on the local copy", "My NAS (away)"],
                      ] as Array<[keyof Storage, string, string]>
                    ).map(([key, label, ph]) => (
                      <label key={key} className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                        {label}
                        <input className={input} value={draft.storage![key]} placeholder={ph} onChange={(e) => set({ storage: { ...draft.storage!, [key]: e.target.value } })} />
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="flex flex-col gap-2 text-[13px] text-foreground">
              <div className="font-medium">Ready, {draft.name.trim() || "friend"}.</div>
              <ul className="list-disc pl-5 text-[12.5px] text-muted-foreground">
                <li>Areas: {draft.areas.filter((a) => a.name.trim()).map((a) => a.name).join(", ") || "none yet"}</li>
                <li>
                  Tools:{" "}
                  {KEYS.filter((k) => keySet[k.name] || keys[k.name]?.trim())
                    .map((k) => k.label)
                    .join(", ") || "none yet (Home works, the connected cards stay empty)"}
                </li>
                <li>Always-on machine: {draft.machine?.sshHost ? `${draft.machine.label} (${draft.machine.sshHost})` : "none"}</li>
                <li>Storage at home: {draft.storage?.path.trim() ? `${draft.storage.label} at ${draft.storage.path}` : "none"}</li>
              </ul>
              <CompanionsCheck />
            </div>
          ) : null}
        </section>

        <div className="flex items-center gap-2">
          {step > 0 ? (
            <button type="button" className={btn} onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : null}
          <div className="ml-auto flex gap-2">
            {step < STEPS.length - 1 ? (
              <button type="button" className={primary} disabled={!canNext} onClick={() => setStep(step + 1)}>
                {step === 2 || step === 3 ? "Next (or skip)" : "Next"}
              </button>
            ) : (
              <button type="button" className={primary} disabled={saving || !draft.name.trim()} onClick={() => void save()}>
                {saving ? "Saving…" : "Save and open Home"}
              </button>
            )}
          </div>
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          NavAIgate Workspace is made by NavAIgate (navaigate.dev). Free to use for yourself and your business under the PolyForm Internal Use licence.
        </p>
      </div>
    </div>
  );
}

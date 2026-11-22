// The NavAIgate mark and today's date above the "Ask anything" box on bb's new-thread
// screen. bb has no slot there, so an app overlay places a small container
// just before the primary composer (only on new-thread routes, never inside a
// chat) and renders into it with a portal. With session profiles on (EXTRA-AH)
// the Online / Local orbs sit to the right of the mark (session-orbs.tsx).
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { LogoOrb } from "./orb";
import { useVoiceState } from "./voice";
import { display, stateOf } from "./shared";
import { WhereChip } from "./nas";
import { ensureHomeKitStyle } from "./home-kit";
import { useFeature } from "./use-feature";
import { SessionChoice } from "./session-orbs";

const isNewThreadRoute = (p: string) => !p.includes("/threads/") && !p.startsWith("/plugins/") && !p.startsWith("/settings");
const today = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

/**
 * bb's own typing box on this screen. bb's embedded new-chat box (the one the
 * session orbs show inside the hero) is marked "primary" too, so a box inside
 * the hero never counts.
 */
export function findHostComposer(root: ParentNode = document): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-app-composer-role="primary"]')).find((el) => !el.closest("[data-nav-hero]")) ?? null;
}

type HeroSlot = { slot: HTMLElement; composer: HTMLElement } | null;

function useHeroSlot(): HeroSlot {
  const [slot, setSlot] = useState<HeroSlot>(null);
  useEffect(() => {
    let current: HTMLElement | null = null;
    const place = () => {
      const composer = findHostComposer();
      const want = composer && isNewThreadRoute(window.location.pathname);
      if (!want) {
        if (current) {
          current.remove();
          current = null;
          setSlot(null);
        }
        return;
      }
      if (current && current.isConnected && current.nextElementSibling === composer) return;
      current?.remove();
      const el = document.createElement("div");
      el.dataset.navHero = "1";
      composer!.parentElement!.insertBefore(el, composer);
      current = el;
      setSlot({ slot: el, composer: composer! });
    };
    place();
    const mo = new MutationObserver(() => place());
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", place);
    return () => {
      mo.disconnect();
      window.removeEventListener("popstate", place);
      current?.remove();
    };
  }, []);
  return slot;
}

export function Hero({ composer = null }: { composer?: HTMLElement | null }) {
  ensureHomeKitStyle();
  const { threads } = useSidebarThreads();
  const v = useVoiceState();
  const profilesOn = useFeature("EXTRA-AH");
  const working = threads.filter((t) => stateOf(t) === "running").length;
  const mood = v.status === "connecting" ? "connecting" : v.status === "on" ? (v.mode === "speaking" ? "speaking" : "listening") : working > 0 ? "busy" : "idle";
  const words = (
    <div>
      <div className="text-[22px] font-medium tracking-[-0.02em] text-foreground" style={display}>{today()}</div>
      <div className="mt-1 text-[13px] text-muted-foreground">
        {working ? `${working} agent${working === 1 ? "" : "s"} working right now` : "What are we building?"}
      </div>
      <WhereChip />
    </div>
  );
  if (!profilesOn) {
    return (
      <div data-nav-part="hero" className="nav-hk-rise mb-5 flex flex-col items-center gap-3 pt-2 text-center">
        <LogoOrb size={92} mood={mood} />
        {words}
      </div>
    );
  }
  // The orbs stand where the mark was, centred above the date.
  const layout = (orbs: ReactNode) => (
    <div className="flex flex-col items-center gap-3 text-center" style={{ width: "100%" }}>
      {/* The hero is portalled next to bb's own box, outside this plugin's root, so the
          plugin's scoped utility classes do not reach it; home-kit.tsx carries the grid. */}
      {/* With the orbs on, the mark goes and the orbs take its place, centred. */}
      <div className="nav-hero-orbs">{orbs}</div>
      {words}
    </div>
  );
  return (
    <div data-nav-part="hero" className="nav-hk-rise mb-5 flex flex-col items-center pt-2 text-center">
      <SessionChoice hostComposer={composer} layout={layout} />
    </div>
  );
}

export function NewThreadHero() {
  const place = useHeroSlot();
  return place ? createPortal(<Hero composer={place.composer} />, place.slot) : null;
}

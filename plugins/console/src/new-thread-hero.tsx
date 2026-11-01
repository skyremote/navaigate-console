// The NavAIgate mark and today's date above the "Ask anything" box on bb's new-thread
// screen. bb has no slot there, so an app overlay places a small container
// just before the primary composer (only on new-thread routes, never inside a
// chat) and renders into it with a portal.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { LogoOrb } from "./orb";
import { useVoiceState } from "./voice";
import { display, stateOf } from "./shared";
import { WhereChip } from "./nas";
import { ensureHomeKitStyle } from "./home-kit";

const isNewThreadRoute = (p: string) => !p.includes("/threads/") && !p.startsWith("/plugins/") && !p.startsWith("/settings");
const today = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

function useHeroSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let current: HTMLElement | null = null;
    const place = () => {
      const composer = document.querySelector<HTMLElement>('[data-app-composer-role="primary"]');
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
      setSlot(el);
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

function Hero() {
  ensureHomeKitStyle();
  const { threads } = useSidebarThreads();
  const v = useVoiceState();
  const working = threads.filter((t) => stateOf(t) === "running").length;
  const mood = v.status === "connecting" ? "connecting" : v.status === "on" ? (v.mode === "speaking" ? "speaking" : "listening") : working > 0 ? "busy" : "idle";
  return (
    <div data-nav-part="hero" className="nav-hk-rise mb-5 flex flex-col items-center gap-3 pt-2 text-center">
      <LogoOrb size={92} mood={mood} />
      <div>
        <div className="text-[22px] font-medium tracking-[-0.02em] text-foreground" style={display}>{today()}</div>
        <div className="mt-1 text-[13px] text-muted-foreground">
          {working ? `${working} agent${working === 1 ? "" : "s"} working right now` : "What are we building?"}
        </div>
        <WhereChip />
      </div>
    </div>
  );
}

export function NewThreadHero() {
  const slot = useHeroSlot();
  return slot ? createPortal(<Hero />, slot) : null;
}

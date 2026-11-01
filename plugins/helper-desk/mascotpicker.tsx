// The choose-animation menu that opens under a card, and the button on the avatar that opens it.
import { createContext, useContext, useState, type ReactNode } from "react";
import { ANIMATIONS } from "./avatars/animations";
import { Avatar } from "./avatars/Avatar";
import { chooseFor, useMascotChoice } from "./mascotchoice";

/** Where the menu's "Default set and right-hand mascot" link goes. Set by the panel; absent elsewhere, where the link is hidden. */
export const MascotsTabLink = createContext<(() => void) | null>(null);

/** Open state for one card's menu. */
export function useMascotMenu(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  return [open, () => setOpen((v) => !v)];
}

/** The avatar, as a button that opens the card's menu. A small pencil marks it as changeable. */
export function MascotTrigger({ name, open, onToggle, children }: { name: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" className="hd-mpick" aria-label={`Choose mascot for ${name}`} aria-expanded={open} title="Choose mascot" onClick={onToggle}>
      {children}
      <svg className="hd-mpick-pen" viewBox="0 0 8 8" width="10" height="10" shapeRendering="crispEdges" aria-hidden="true">
        <path d="M5 0h2v1h1v2H7v1H6V3H5zM4 3h1v1h1v1H5v1H4V5H3V4h1zM1 5h2v1h1v1H1z" fill="currentColor" />
      </svg>
    </button>
  );
}

/** The nine animations to wear, each as a live preview, or back to the automatic one. Only open menus draw their previews. */
export function MascotChooser({ seed, name, onMore }: { seed: string; name: string; colour?: string; onMore?: () => void }) {
  const choice = useMascotChoice();
  const linked = useContext(MascotsTabLink);
  const more = onMore ?? linked;
  const picked = choice.picks[seed] ?? null;
  return (
    <div className="hd-mchoose" role="group" aria-label={`Choose mascot for ${name}`}>
      <div className="hd-mchoose-grid hd-mchoose-grid3">
        {ANIMATIONS.map((a) => (
          <button key={a.id} type="button" className="hd-mchoose-tile" data-character={a.id} aria-pressed={picked === a.id} title={a.name} onClick={() => chooseFor(seed, a.id)}>
            <span className="hd-botwrap"><span className="hd-m" style={{ ["--hd-ms" as string]: "36px" }}><Avatar animation={a.id} seed={`${seed}:${a.id}`} state="idle" size={36} preview /></span></span>
            <span>{a.name}</span>
          </button>
        ))}
      </div>
      <div className="hd-mchoose-foot">
        <button type="button" className="hd-link" aria-pressed={picked === null} onClick={() => chooseFor(seed, null)}>
          Automatic{picked === null ? " (current)" : ""}
        </button>
        {more && (
          <button type="button" className="hd-link" onClick={more}>
            Default set and right-hand mascot
          </button>
        )}
      </div>
    </div>
  );
}

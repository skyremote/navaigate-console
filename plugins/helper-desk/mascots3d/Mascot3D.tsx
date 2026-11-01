// One 3D mascot. It shows its pre-rendered loop (a captured strip stepped with CSS) unless it holds one of the two
// live slots, in which case it draws through the shared WebGL context. Either way the box is the same size, so a
// card never shifts when a mascot goes live or falls back.
import { useEffect, useRef, type CSSProperties } from "react";
import { SHARED_SIZE, sharedGl } from "./gl";
import { claimSlot, holdsSlot, register, releaseSlot, setVisible, unregister, update, useSlotVersion, type LiveClient } from "./live";
import { stripFor, useStripsVersion } from "./strips";
import { character3dById, stateFor, type MascotState } from "./catalog";
import { nField } from "./navmark";
import { watch } from "./visibility";

export interface Mascot3DProps {
  /** A character id from CHARACTERS_3D. */
  id: string;
  /** Stable seed for the loop's start offset, so neighbouring cards do not step in unison. */
  seed: string;
  colour: string;
  state: MascotState;
  size?: number;
  fresh?: boolean;
  label?: string;
  /** Live priority. 0 or absent keeps the pre-rendered loop; higher wins a live slot first. */
  live?: number;
}

/** The soft glow behind a character that does not take the card colour. */
const GLOW_SILVER = "#9aa7c2";

function webglPossible(): boolean {
  return typeof WebGL2RenderingContext !== "undefined" && sharedGl().available();
}

function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ (h >>> 15)) >>> 0;
}

export function Mascot3D({ id, seed, colour, state, size = 32, fresh = false, label, live = 0 }: Mascot3DProps) {
  useStripsVersion();
  useSlotVersion();
  const key = useRef<symbol>(Symbol(`mascot3d:${id}`)).current;
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const client = useRef<LiveClient | null>(null);
  const seen = useRef(true);
  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  const px = Math.min(SHARED_SIZE, Math.round(size * dpr));
  const wantsLive = live > 0 && webglPossible();
  const granted = wantsLive && holdsSlot(key);

  useEffect(() => {
    if (!wantsLive) return;
    if (character3dById(id)?.fixedColour) {
      const bake = () => void nField();
      if (typeof requestIdleCallback === "function") requestIdleCallback(bake);
      else setTimeout(bake, 0);
    }
    claimSlot(key, live, seen.current);
    return () => releaseSlot(key);
  }, [key, id, live, wantsLive]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    return watch(el, (visible) => {
      seen.current = visible;
      if (client.current) setVisible(client.current, visible);
      if (wantsLive) claimSlot(key, live, visible);
    });
  }, [key, live, wantsLive]);

  useEffect(() => {
    const el = canvas.current;
    if (!granted || !el) return;
    const c = register(el, id, state, colour, px);
    client.current = c;
    return () => {
      if (c) unregister(c);
      client.current = null;
    };
    // The client is created once per canvas; later prop changes go through update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granted, id]);

  useEffect(() => {
    if (client.current) update(client.current, state, colour, px);
  }, [state, colour, px]);

  const strip = granted ? null : stripFor(id, state, colour);
  const h = hash(seed);
  const looping = stateFor(id, state) !== "done" && stateFor(id, state) !== "error";
  const style = {
    ["--hd-ms" as string]: `${size}px`,
    ["--hd-m3c" as string]: character3dById(id)?.fixedColour ? GLOW_SILVER : colour,
    ["--hd-md" as string]: strip && looping ? `${-((h % 997) / 997) * strip.seconds}s` : "0s",
  } as CSSProperties;

  return (
    <span className={`hd-botwrap hd-m3w hd-mode-${fresh ? "fresh" : state}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {fresh && (
        <svg className="hd-tick" viewBox="0 0 7 6" width="12" height="10" shapeRendering="crispEdges" aria-hidden="true">
          {[[6, 0], [5, 1], [4, 2], [0, 2], [1, 3], [3, 3], [2, 4]].map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill="#1f9d55" />)}
        </svg>
      )}
      <span ref={box} className={`hd-m hd-m3 hd-m3-${state}`} data-mascot={id} data-style="3d" data-live={granted ? "" : undefined} style={style}>
        {granted ? (
          <canvas ref={canvas} className="hd-m3-canvas" width={px} height={px} />
        ) : strip ? (
          <span className={`hd-m3-strip ${strip.className}`} style={{ ["--n" as string]: strip.frames, ["--n1" as string]: Math.max(1, strip.frames - 1), ["--dur" as string]: `${strip.seconds}s` } as CSSProperties} />
        ) : null}
      </span>
    </span>
  );
}

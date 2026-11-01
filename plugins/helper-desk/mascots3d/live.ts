// The live renderer's scheduler. Every live mascot registers a canvas; one requestAnimationFrame loop serves them
// all, draws each at its own pace into the shared WebGL canvas, and copies the picture across. The loop stops when
// nothing is animating, off screen, or in a hidden tab. At most MAX_LIVE mascots hold a live slot at once; the
// rest keep their pre-rendered loop.
import { useSyncExternalStore } from "react";
import { DONE_SECONDS, animates, hexToRgb, lookAt, type MascotState } from "./catalog";
import { sharedGl } from "./gl";
import { reducedMotion } from "./visibility";

export const MAX_LIVE = 2;

/** Who wins a live slot when more than two ask: the right-hand mascot, then the lead card, then the preview on the Mascots tab. */
export const LIVE = { coach: 3, lead: 2, stage: 1 } as const;

const FRAME_MS: Record<MascotState, number> = { work: 1000 / 30, idle: 1000 / 15, wait: 1000 / 15, done: 1000 / 30, error: 1000 };
const SLACK = 2;

export interface LiveClient {
  id: string;
  state: MascotState;
  tint: [number, number, number];
  px: number;
  ctx: CanvasRenderingContext2D;
  started: number;
  last: number;
  visible: boolean;
  dirty: boolean;
}

const clients = new Set<LiveClient>();
let raf = 0;
let hooked = false;

function drawOne(c: LiveClient, now: number) {
  const gl = sharedGl();
  const seconds = reducedMotion() ? (c.state === "done" ? DONE_SECONDS : 0) : (now - c.started) / 1000;
  const look = lookAt(c.id, c.state, seconds);
  if (gl.draw(c.id, look, c.tint, c.px, 2)) gl.blit(c.ctx, c.px);
  c.last = now;
  c.dirty = false;
}

function needsFrames(c: LiveClient, now: number): boolean {
  if (!c.visible || reducedMotion()) return false;
  if (animates(c.state)) return true;
  return c.state === "done" && now - c.started < DONE_SECONDS * 1000 + 50;
}

function tick(now: number) {
  raf = 0;
  if (document.visibilityState === "hidden") return;
  let more = false;
  for (const c of clients) {
    if (!c.visible) continue;
    if (c.dirty || (needsFrames(c, now) && now - c.last >= FRAME_MS[c.state] - SLACK)) drawOne(c, now);
    if (needsFrames(c, now)) more = true;
  }
  if (more) raf = requestAnimationFrame(tick);
}

/** Starts the loop if any client needs frames. Safe to call often. */
export function wake() {
  if (raf || typeof requestAnimationFrame === "undefined") return;
  if (!hooked) {
    document.addEventListener("visibilitychange", wake);
    hooked = true;
  }
  if (document.visibilityState === "hidden") return;
  raf = requestAnimationFrame(tick);
}

export function register(canvas: HTMLCanvasElement, id: string, state: MascotState, colour: string, px: number): LiveClient | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const c: LiveClient = { id, state, tint: hexToRgb(colour), px, ctx, started: performance.now(), last: -1e9, visible: true, dirty: true };
  clients.add(c);
  wake();
  return c;
}

export function update(c: LiveClient, state: MascotState, colour: string, px: number) {
  if (c.state !== state) {
    c.state = state;
    c.started = performance.now();
  }
  c.tint = hexToRgb(colour);
  c.px = px;
  c.dirty = true;
  wake();
}

export function setVisible(c: LiveClient, visible: boolean) {
  c.visible = visible;
  if (visible) {
    c.dirty = true;
    wake();
  }
}

export function unregister(c: LiveClient) {
  clients.delete(c);
}

export function liveClientCount(): number {
  return clients.size;
}

// Live slots: who may draw live right now. Highest priority first, visible claims only, MAX_LIVE of them.
interface Claim {
  priority: number;
  visible: boolean;
}
const claims = new Map<symbol, Claim>();
const slotListeners = new Set<() => void>();
let slotVersion = 0;
let holders = new Set<symbol>();

function recompute() {
  const ranked = [...claims].filter(([, c]) => c.visible).sort((a, b) => b[1].priority - a[1].priority);
  const next = new Set(ranked.slice(0, MAX_LIVE).map(([k]) => k));
  const same = next.size === holders.size && [...next].every((k) => holders.has(k));
  if (same) return;
  holders = next;
  slotVersion++;
  for (const l of slotListeners) l();
}

export function claimSlot(key: symbol, priority: number, visible: boolean) {
  claims.set(key, { priority, visible });
  recompute();
}

export function releaseSlot(key: symbol) {
  if (claims.delete(key)) recompute();
}

export function holdsSlot(key: symbol): boolean {
  return holders.has(key);
}

/** Re-renders the caller when the set of slot holders changes. */
export function useSlotVersion(): number {
  return useSyncExternalStore(
    (l) => {
      slotListeners.add(l);
      return () => slotListeners.delete(l);
    },
    () => slotVersion,
    () => 0,
  );
}

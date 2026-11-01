// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const draws: { id: string; look: { phase: number; settle: number }; px: number }[] = [];
vi.mock("../mascots3d/gl", () => ({
  SHARED_SIZE: 256,
  sharedGl: () => ({
    contexts: 1,
    available: () => true,
    draw: (id: string, look: { phase: number; settle: number }, _tint: unknown, px: number) => {
      draws.push({ id, look, px });
      return true;
    },
    blit: () => undefined,
  }),
}));

type Live = typeof import("../mascots3d/live");
let live: Live;
const register = (...a: Parameters<Live["register"]>) => live.register(...a);
const setVisible = (...a: Parameters<Live["setVisible"]>) => live.setVisible(...a);
const unregister = (...a: Parameters<Live["unregister"]>) => live.unregister(...a);
const update = (...a: Parameters<Live["update"]>) => live.update(...a);
const wake = () => live.wake();

let queue: FrameRequestCallback[] = [];
let clock = 1000;

function run(ms: number, step = 1000 / 60) {
  const end = clock + ms;
  while (clock < end) {
    clock += step;
    const due = queue;
    queue = [];
    for (const cb of due) cb(clock);
  }
}

const canvas = () => ({ getContext: () => ({}) }) as unknown as HTMLCanvasElement;
const setReduced = (on: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));

beforeEach(async () => {
  vi.resetModules();
  live = await import("../mascots3d/live");
  draws.length = 0;
  queue = [];
  clock = 1000;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  setReduced(false);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("the live loop", () => {
  it("draws working at about 30 frames a second and idle at about 15", () => {
    const w = register(canvas(), "glass", "work", "#2f6fe4", 96)!;
    run(1000);
    expect(draws.length).toBeGreaterThanOrEqual(26);
    expect(draws.length).toBeLessThanOrEqual(34);
    unregister(w);
    draws.length = 0;
    const i = register(canvas(), "glass", "idle", "#2f6fe4", 96)!;
    run(1000);
    expect(draws.length).toBeGreaterThanOrEqual(12);
    expect(draws.length).toBeLessThanOrEqual(17);
    unregister(i);
  });

  it("settles on done within about a second and then stops asking for frames", () => {
    const c = register(canvas(), "clay", "done", "#1f9d55", 96)!;
    run(2000);
    const last = draws[draws.length - 1];
    expect(last.look.settle).toBe(1);
    expect(queue).toHaveLength(0);
    const n = draws.length;
    run(1000);
    expect(draws.length).toBe(n);
    unregister(c);
  });

  it("draws an error pose once and holds it", () => {
    const c = register(canvas(), "pearl", "error", "#d93636", 96)!;
    run(1500);
    expect(draws).toHaveLength(1);
    expect(queue).toHaveLength(0);
    unregister(c);
  });

  it("goes quiet off screen and picks up again when it comes back", () => {
    const c = register(canvas(), "gem", "work", "#7c4ddb", 96)!;
    run(200);
    setVisible(c, false);
    draws.length = 0;
    run(600);
    expect(draws).toHaveLength(0);
    expect(queue).toHaveLength(0);
    setVisible(c, true);
    run(300);
    expect(draws.length).toBeGreaterThan(3);
    unregister(c);
  });

  it("draws nothing while the tab is hidden, and resumes when it shows", () => {
    const c = register(canvas(), "globe", "idle", "#0e9aa7", 96)!;
    run(100);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    draws.length = 0;
    run(500);
    expect(draws).toHaveLength(0);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    wake();
    run(300);
    expect(draws.length).toBeGreaterThan(2);
    unregister(c);
  });

  it("honours reduced motion with one still frame and no loop", () => {
    setReduced(true);
    const c = register(canvas(), "aurora", "work", "#e2457a", 96)!;
    run(1500);
    expect(draws).toHaveLength(1);
    expect(draws[0].look.phase).toBe(0);
    expect(queue).toHaveLength(0);
    unregister(c);
  });

  it("restarts a state change from its beginning and redraws at once", () => {
    const c = register(canvas(), "ember", "idle", "#f26b21", 96)!;
    run(500);
    draws.length = 0;
    update(c, "done", "#f26b21", 96);
    run(40);
    expect(draws[0].look.settle).toBeLessThan(0.2);
    unregister(c);
  });
});

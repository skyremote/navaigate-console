// The Sort with Jev show: emails fire out of the list into their pile buckets.
//
//   prepareShow  lifts list rows onto a fixed overlay as compact email chips, at
//                their exact list positions (and queues more from below the fold).
//   runShow      stages the buckets, then fires the chips on a beat grouped in
//                threes ("do-do-do ... do-do-do"), each on a curved arc with a
//                trail in its bucket's colour. Buckets squash and bounce as they
//                catch, counts tick, particles spray, the chip becomes the row.
//
// Built from scratch. Chips move with the Web Animations API (transform and
// opacity only, keyframes sampled along a quadratic bezier); trails and
// particles are drawn on one canvas in a requestAnimationFrame loop.

export type ShowEmail = { id: string; color: string; subject: string; row: HTMLElement | null };
type Chip = ShowEmail & {
  el: HTMLElement;
  w: number;
  h: number;
  sx: number;
  sy: number;
  lifted: boolean;
  // Flight plan, set by runShow.
  pile?: string;
  tx?: number;
  ty?: number;
  cx?: number;
  cy?: number;
  start?: number;
  dur?: number;
  accent?: boolean;
  landed?: boolean;
};
export type ShowPrep = { layer: HTMLDivElement; canvas: HTMLCanvasElement; chips: Chip[]; dispose: () => void };

const SOFT = "cubic-bezier(.16,1,.3,1)";
const MAX_IN_FLIGHT = 24;
const TRAIL_LAG = [0, 22, 44, 66]; // ms behind the chip: the streak in the bucket's colour
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Fast launch, soft catch: a blend of ease-out-cubic and ease-in-out-quad. */
function ease(s: number): number {
  const out = 1 - Math.pow(1 - s, 3);
  const io = s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) / 2;
  return 0.55 * out + 0.45 * io;
}
const POP = 0.13; // share of the flight spent popping up before the shot

/** Where a chip's centre is, how big and how tilted, at time share u of its flight. */
function pose(c: Chip, u: number): { x: number; y: number; s: number; r: number; o: number } {
  const sx = c.sx;
  const sy = c.sy;
  if (u <= POP) {
    const k = u / POP;
    const s = 1 + (c.accent ? 0.12 : 0.08) * Math.sin((k * Math.PI) / 2);
    return { x: sx, y: sy - 5 * k, s, r: 0, o: c.lifted ? 1 : k };
  }
  const p = ease((u - POP) / (1 - POP));
  const q = 1 - p;
  const y0 = sy - 5;
  const x = q * q * sx + 2 * q * p * c.cx! + p * p * c.tx!;
  const y = q * q * y0 + 2 * q * p * c.cy! + p * p * c.ty!;
  // Tangent of the curve: bank into the turn, upright again as it lands.
  const vx = 2 * q * (c.cx! - sx) + 2 * p * (c.tx! - c.cx!);
  const vy = 2 * q * (c.cy! - y0) + 2 * p * (c.ty! - c.cy!);
  let a = (Math.atan2(vy, vx) * 180) / Math.PI;
  if (vx < 0) a = a > 0 ? a - 180 : a + 180;
  const r = clamp(a, -32, 32) * (1 - Math.pow(p, 3));
  const s = (c.accent ? 1.12 : 1.08) + (0.5 - (c.accent ? 1.12 : 1.08)) * p;
  return { x, y, s, r, o: 1 };
}

function chipElement(e: ShowEmail): HTMLElement {
  const el = document.createElement("div");
  const s = el.style;
  s.position = "absolute";
  s.left = "0";
  s.top = "0";
  s.display = "flex";
  s.alignItems = "center";
  s.gap = "7px";
  s.padding = "4px 12px 4px 4px";
  s.borderRadius = "999px";
  s.background = "var(--card, var(--background))";
  s.border = `1px solid color-mix(in srgb, ${e.color} 60%, var(--border))`;
  s.boxShadow = `0 8px 22px rgba(0,0,0,.28), 0 0 0 3px color-mix(in srgb, ${e.color} 14%, transparent)`;
  s.font = "600 11.5px/1.2 var(--font-sans, inherit)";
  s.color = "var(--foreground)";
  s.whiteSpace = "nowrap";
  s.maxWidth = "250px";
  s.overflow = "hidden";
  s.textOverflow = "ellipsis";
  s.transformOrigin = "50% 50%";
  s.willChange = "transform, opacity";
  const avatar = e.row?.querySelector<HTMLElement>("[data-avatar]")?.cloneNode(true) as HTMLElement | undefined;
  if (avatar) {
    avatar.style.zoom = "0.7";
    avatar.style.flexShrink = "0";
    el.appendChild(avatar);
  } else {
    const dot = document.createElement("span");
    dot.style.cssText = `width:20px;height:20px;border-radius:999px;flex-shrink:0;background:${e.color}`;
    el.appendChild(dot);
  }
  const t = document.createElement("span");
  t.textContent = e.subject.length > 40 ? `${e.subject.slice(0, 39)}…` : e.subject;
  t.style.overflow = "hidden";
  t.style.textOverflow = "ellipsis";
  el.appendChild(t);
  return el;
}

/** Step 1 of the stage: lift the emails onto an overlay at their list positions. */
export function prepareShow(emails: ShowEmail[], list: DOMRect): ShowPrep {
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:70;overflow:hidden;contain:strict;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
  layer.appendChild(canvas);
  document.body.appendChild(layer);

  const els = emails.map((e) => {
    const el = chipElement(e);
    layer.appendChild(el);
    return el;
  });
  // Read every size and row position in one pass, then write.
  const sizes = els.map((el) => ({ w: el.offsetWidth, h: el.offsetHeight }));
  const rects = emails.map((e) => e.row?.getBoundingClientRect() ?? null);
  const chips: Chip[] = emails.map((e, i) => {
    const r = rects[i];
    const { w, h } = sizes[i];
    const lifted = !!r && r.bottom > list.top + 4 && r.top < list.bottom - 4;
    const avatar = lifted ? e.row!.querySelector<HTMLElement>("[data-avatar]")?.getBoundingClientRect() : null;
    const sx = lifted ? (avatar ? avatar.left - 4 : r!.left + 40) + w / 2 : rand(list.left + 120, list.right - 140);
    const sy = lifted ? r!.top + r!.height / 2 : list.bottom + h;
    return { ...e, el: els[i], w, h, sx, sy, lifted };
  });
  chips.forEach((c, i) => {
    c.el.style.transform = `translate(${c.sx - c.w / 2}px, ${c.sy - c.h / 2}px)`;
    c.el.style.opacity = c.lifted ? "1" : "0";
    if (c.lifted) {
      c.el.animate([{ transform: `translate(${c.sx - c.w / 2}px, ${c.sy - c.h / 2}px) scale(.94)`, opacity: 0.4 }, { transform: c.el.style.transform, opacity: 1 }], {
        duration: 220,
        delay: i * 12,
        easing: SOFT,
        fill: "backwards",
      });
      if (c.row) c.row.style.opacity = "0";
    }
  });
  return { layer, canvas, chips, dispose: () => layer.remove() };
}

export type ShowTargets = {
  /** Bucket card per pile. */
  cards: Map<string, HTMLElement>;
  /** The count element in each card header, and the true total it must reach. */
  counts: Map<string, { el: HTMLElement; total: number }>;
  /** Card rows that each chip becomes, by email id. */
  rows: Map<string, HTMLElement>;
  /** Pile of each email id. */
  pileOf: Map<string, string>;
  sound: boolean;
};

/** The beat: groups of three with a rest, volleys for big inboxes, about 1.7 s of launches. */
export function cadence(n: number): { times: number[]; accents: boolean[]; beat: number; volley: number } {
  const SPAN = 1700;
  const maxBeats = Math.floor((SPAN * 3) / (4.4 * 45));
  const volley = Math.max(1, Math.ceil(n / maxBeats));
  const beats = Math.ceil(n / volley);
  const beat = clamp((SPAN * 3) / (4.4 * Math.max(beats, 3)), 45, 60);
  const rest = beat * 1.4;
  const times: number[] = [];
  const accents: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const b = Math.floor(i / volley);
    const group = Math.floor(b / 3);
    const k = b % 3;
    times.push(group * (3 * beat + rest) + k * beat + (i % volley) * 6);
    accents.push(k === 0);
  }
  return { times, accents, beat, volley };
}

let audio: AudioContext | null = null;
function blip(k: number) {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = "sine";
    o.frequency.value = [784, 659, 523][k % 3]; // G5 E5 C5: do-do-do
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.1);
  } catch {
    /* no audio: silent show */
  }
}

type Particle = { x: number; y: number; vx: number; vy: number; born: number; life: number; r: number; color: string };

/** Steps 2 to 4: stage the buckets, fire the chips on the beat, catch them. Resolves when the last chip lands. */
export function runShow(prep: ShowPrep, t: ShowTargets): Promise<void> {
  const { chips, canvas, layer } = prep;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  // Read every target before any animation moves the cards.
  const cardRect = new Map<string, DOMRect>();
  for (const [k, el] of t.cards) cardRect.set(k, el.getBoundingClientRect());
  const rowRect = new Map<string, DOMRect>();
  for (const [id, el] of t.rows) rowRect.set(id, el.getBoundingClientRect());

  // Buckets: hidden rows, counts at 0, cards slide and scale in, slightly dimmed.
  for (const el of t.rows.values()) el.style.opacity = "0";
  const shown = new Map<string, number>();
  for (const [k, c] of t.counts) {
    c.el.dataset.anim = "1";
    c.el.textContent = "0";
    shown.set(k, 0);
  }
  [...t.cards.values()].forEach((el, i) =>
    el.animate([{ opacity: 0, transform: "translateY(22px) scale(.92)" }, { opacity: 0.55, transform: "none" }], { duration: 420, delay: i * 40, easing: SOFT, fill: "both" }),
  );

  // Weights: each pile's chips add up to its real count, so 511 emails still land as 511.
  const perPile = new Map<string, Chip[]>();
  for (const c of chips) {
    c.pile = t.pileOf.get(c.id) ?? "fyi";
    if (!perPile.has(c.pile)) perPile.set(c.pile, []);
    perPile.get(c.pile)!.push(c);
  }
  const weight = new Map<Chip, number>();
  for (const [k, list] of perPile) {
    const total = t.counts.get(k)?.total ?? list.length;
    list.forEach((c, i) => weight.set(c, Math.floor(total / list.length) + (i < total % list.length ? 1 : 0)));
  }

  // Flight plans: a quadratic arc to the row slot, or into the bucket's header.
  const beat = cadence(chips.length);
  chips.forEach((c, i) => {
    const row = rowRect.get(c.id);
    const card = cardRect.get(c.pile!);
    if (row) {
      c.tx = row.left + 12 + (c.w * 0.5) / 2;
      c.ty = row.top + row.height / 2;
    } else if (card) {
      c.tx = card.left + card.width * rand(0.3, 0.72);
      c.ty = card.top + rand(18, 30);
    } else {
      c.tx = c.sx;
      c.ty = c.sy;
    }
    const dx = c.tx - c.sx;
    const dy = c.ty - c.sy;
    const dist = Math.hypot(dx, dy) || 1;
    const side = (i % 2 ? 1 : -1) * Math.min(260, dist * rand(0.22, 0.5));
    c.cx = (c.sx + c.tx) / 2 + (-dy / dist) * side;
    c.cy = (c.sy + c.ty) / 2 + (dx / dist) * side - rand(50, 170);
    c.dur = clamp(430 + dist * 0.28, 480, 700);
    c.accent = beat.accents[i];
  });

  const t0 = performance.now() + 180; // the buckets finish staging while the first chips fly
  const due = chips.map((_c, i) => t0 + beat.times[i]);
  let next = 0;
  let inFlight = 0;
  let landed = 0;
  let lastBeat = -1;
  const particles: Particle[] = [];
  const bright = new Set<string>();

  const launch = (c: Chip, now: number) => {
    c.start = now;
    inFlight++;
    const frames: Keyframe[] = [];
    for (let k = 0; k <= 12; k++) {
      const u = k / 12;
      const p = pose(c, u);
      frames.push({ offset: u, opacity: p.o, transform: `translate(${p.x - c.w / 2}px, ${p.y - c.h / 2}px) rotate(${p.r.toFixed(2)}deg) scale(${p.s.toFixed(3)})` });
    }
    // Insert the exact end of the pop so the shot starts crisply.
    const pop = pose(c, POP);
    frames.splice(2, 0, { offset: POP, opacity: 1, transform: `translate(${pop.x - c.w / 2}px, ${pop.y - c.h / 2}px) scale(${pop.s.toFixed(3)})` });
    frames.sort((a, b) => (a.offset as number) - (b.offset as number));
    c.el.animate(frames, { duration: c.dur, easing: "linear", fill: "forwards" });
  };

  const land = (c: Chip, now: number) => {
    c.landed = true;
    inFlight--;
    landed++;
    const card = t.cards.get(c.pile!);
    // The chip becomes the row.
    const row = t.rows.get(c.id);
    if (row) {
      row.style.opacity = "";
      row.animate([{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: SOFT });
    }
    c.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: "forwards" }).finished.then(() => c.el.remove(), () => c.el.remove());
    if (card) {
      if (!bright.has(c.pile!)) {
        bright.add(c.pile!);
        card.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 220, fill: "forwards", easing: SOFT });
      }
      card.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.06, 1.04)", offset: 0.3 },
          { transform: "scale(.98, 1.01)", offset: 0.65 },
          { transform: "scale(1)" },
        ],
        { duration: 260, easing: "ease-out", composite: "add" },
      );
    }
    const count = t.counts.get(c.pile!);
    if (count) {
      const v = (shown.get(c.pile!) ?? 0) + (weight.get(c) ?? 1);
      shown.set(c.pile!, v);
      count.el.textContent = String(v);
      count.el.animate([{ transform: "translateY(-45%)", opacity: 0.2 }, { transform: "none", opacity: 1 }], { duration: 150, easing: "ease-out" });
    }
    for (let i = 0; i < 10; i++) {
      const a = rand(-Math.PI, 0) + rand(-0.5, 0.5);
      const sp = rand(90, 260);
      particles.push({ x: c.tx!, y: c.ty!, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, born: now, life: rand(340, 460), r: rand(1.8, 3.4), color: c.color });
    }
  };

  return new Promise((resolve) => {
    let resolved = false;
    const frame = (now: number) => {
      // Launch whatever is due, on the beat, within the in-flight cap.
      while (next < chips.length && due[next] <= now && inFlight < MAX_IN_FLIGHT) {
        const b = Math.floor(next / beat.volley);
        if (t.sound && b !== lastBeat) blip(b % 3);
        lastBeat = b;
        launch(chips[next], now);
        next++;
      }
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.lineCap = "round";
      for (const c of chips) {
        if (c.start === undefined || c.landed) continue;
        const el = now - c.start;
        if (el >= c.dur!) {
          land(c, now);
          continue;
        }
        // Trail: the chip's own path a few frames back, tapering and fading.
        if (el / c.dur! <= POP) continue;
        let prev: { x: number; y: number } | null = null;
        TRAIL_LAG.forEach((lag, i) => {
          const u = Math.max(0, (el - lag) / c.dur!);
          const p = pose(c, u);
          if (prev) {
            ctx.globalAlpha = 0.6 * (1 - i / TRAIL_LAG.length);
            ctx.strokeStyle = c.color;
            ctx.lineWidth = 7 * (1 - i / TRAIL_LAG.length) * p.s;
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
          prev = p;
        });
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        const age = now - p.born;
        if (age >= p.life) {
          particles.splice(i, 1);
          continue;
        }
        const s = age / 1000;
        const k = 1 - age / p.life;
        ctx.globalAlpha = k;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x + p.vx * s, p.y + p.vy * s + 420 * s * s, p.r * (0.4 + 0.6 * k), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!resolved && landed === chips.length) {
        resolved = true;
        for (const [, c] of t.counts) delete c.el.dataset.anim;
        // Hand the cards back to plain layout once the last bounce settles.
        window.setTimeout(() => {
          for (const el of t.cards.values()) for (const a of el.getAnimations()) a.cancel();
        }, 300);
        resolve();
      }
      if (resolved && particles.length === 0) {
        layer.remove();
        return;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

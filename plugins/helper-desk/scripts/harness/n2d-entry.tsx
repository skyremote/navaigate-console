// The NavAIgate N as the lead card wears it (canvas, drawn like the NavMotion films' mark): the real lead card live
// in the working, waiting and idle looks, and a sheet of fixed poses drawn at 3x so the frames can be inspected.
// ?theme=dark switches the page; ?view=cards shows only the live cards; ?only=working|waiting|finished|idle shows one; ?hold=1 freezes the loop's first frame by
// forcing reduced motion in the page (the poses are unaffected).
import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { LiveTab } from "@hd/app";
import { drawNavN, IDLE_PERIOD, RING_PERIOD, STILL_T, WORK_PERIOD } from "@hd/avatars/nmark";
import { resolveInk } from "@hd/avatars/engine";
import { Mascot, PALETTE } from "@hd/mascots";
import { N_ID } from "@hd/mascots3d/catalog";
import { fixtureSnapshot } from "./fixtures";

const q = new URLSearchParams(location.search);
const dark = q.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
const cardsOnly = q.get("view") === "cards" || q.has("only");
const only = q.get("only");

function Pose({ label, px, t, work = 0, wait = 0, ring, alpha = 1, moving = true, born = null }: { label: string; px: number; t: number; work?: number; wait?: number; ring?: number; alpha?: number; moving?: boolean; born?: number | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const dpr = 3;
    el.width = px * dpr;
    el.height = px * dpr;
    const ctx = el.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawNavN(ctx as never, px, t, { ink: resolveInk(el), alpha, work, wait, ring: ring ?? Math.max(work, wait), moving, born });
  }, [px, t, work, wait, ring, alpha, moving, born]);
  return (
    <figure style={{ margin: 0, textAlign: "center", font: "11px system-ui" }}>
      <canvas ref={ref} data-pose={label} style={{ width: px, height: px, display: "block", color: "var(--hd-avatar-ink, var(--foreground))", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8 }} />
      {label}
    </figure>
  );
}

function Poses() {
  const idle = [0, 0.08, 0.16, 0.24].map((k) => k * IDLE_PERIOD);
  const work = [0.1, 0.3, 0.5, 0.7].map((k) => k * WORK_PERIOD);
  return (
    <section>
      <h2>Poses at 96 px, drawn at 3x ({dark ? "dark" : "light"} page)</h2>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Pose label="open 0.1s" px={96} t={0} born={0.1} />
        <Pose label="open 0.3s" px={96} t={0} born={0.3} />
        <Pose label="open 0.5s" px={96} t={0} born={0.5} />
        {idle.map((t, i) => <Pose key={`i${i}`} label={`idle sweep ${i}`} px={96} t={t} />)}
        <Pose label="idle rest" px={96} t={STILL_T} />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
        {work.map((t, i) => <Pose key={`w${i}`} label={`working ${i}`} px={96} t={t} work={1} />)}
        <Pose label="working, held" px={96} t={STILL_T} work={1} moving={false} />
        <Pose label="waiting" px={96} t={WORK_PERIOD} wait={1} />
        <Pose label="done" px={96} t={STILL_T} moving={false} />
        <Pose label="error" px={96} t={STILL_T} moving={false} alpha={0.4} />
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <Pose label="ring in 25%" px={96} t={0.3 * RING_PERIOD} work={0.25} />
        <Pose label="ring in 60%" px={96} t={0.3 * RING_PERIOD} work={0.6} />
        <Pose label="48 px working" px={48} t={0.5 * WORK_PERIOD} work={1} />
        <Pose label="56 px working" px={56} t={0.1 * RING_PERIOD} work={1} />
        <Pose label="64 px waiting" px={64} t={0.6 * RING_PERIOD} wait={1} />
        <Pose label="48 px held ring" px={48} t={STILL_T} work={1} moving={false} />
        <Pose label="48 px idle" px={48} t={STILL_T} />
        <Pose label="32 px working" px={32} t={0.5 * WORK_PERIOD} work={1} />
        <Pose label="24 px idle" px={24} t={STILL_T} />
      </div>
    </section>
  );
}

function Frame({ title, state }: { title: string; state: "working" | "waiting" | "needs-you" | "finished" }) {
  const data = fixtureSnapshot(4, state === "working" ? "running" : "finished");
  data.lead = { ...data.lead!, state, activity: state === "working" ? "Writing reply" : state === "waiting" ? "Waiting for you" : state === "needs-you" ? "Needs your answer" : "Finished" };
  return (
    <section data-shot={state}>
      <h2>{title}</h2>
      <div className="frame"><div className="hd-root"><LiveTab threadId={data.threadId} data={data} error={null} visibility="live" now={Date.now()} delayMs={8000} onHistory={() => undefined} /></div></div>
    </section>
  );
}

// The lead card is never "idle" (it is working, waiting for you, or needing you), so this is the card's own markup with
// the real Mascot in the idle state: what the N looks like at rest next to the name, as on the Mascots tab.
function IdleCard() {
  return (
    <section data-shot="idle">
      <h2>Lead card avatar, idle (markup copied, state forced)</h2>
      <div className="frame"><div className="hd-root">
        <article className="hd-leadcard hd-lead-waiting" aria-label="Lead, Idle">
          <Mascot seed="thr_idle" colour={PALETTE[1]!} state="idle" size={48} automatic={N_ID} />
          <div className="hd-card-body">
            <div className="hd-card-top"><strong className="hd-name">Lead · Opus 5.5</strong></div>
            <div className="hd-lead-activity">Idle</div>
          </div>
        </article>
      </div></div>
    </section>
  );
}

// ?frames=1 draws one big avatar on a plain page and exposes window.__frame(seconds), for rendering a clip at exactly
// 30 fps: the orbit eases in at 0.2 s, turns, and eases out at 2.5 s (the way a card going working then done does).
function Frames() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const px = 160;
    el.width = px * 3;
    el.height = px * 3;
    const ctx = el.getContext("2d")!;
    const e = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
    (window as unknown as { __frame: (t: number) => string }).__frame = (t) => {
      const k = e((t - 0.2) / 0.45) * (1 - e((t - 2.5) / 0.45));
      ctx.setTransform(3, 0, 0, 3, 0, 0);
      drawNavN(ctx as never, px, t + 0.37, { ink: resolveInk(el), work: k, ring: k, born: null });
      return el.toDataURL("image/png");
    };
  }, []);
  return <canvas ref={ref} style={{ width: 160, height: 160, display: "block", color: "var(--hd-avatar-ink, var(--foreground))" }} />;
}

function App() {
  if (q.has("frames")) return <Frames />;
  return (
    <>
      <header><h1>NavAIgate N, the lead card avatar</h1></header>
      <div className="cols">
        {(!only || only === "working") && <Frame title="Lead card, working" state="working" />}
        {(!only || only === "waiting") && <Frame title="Lead card, waiting for you" state="waiting" />}
        {(!only || only === "finished") && <Frame title="Lead card, finished" state="finished" />}
        {(!only || only === "idle") && <IdleCard />}
      </div>
      {!cardsOnly && <Poses />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

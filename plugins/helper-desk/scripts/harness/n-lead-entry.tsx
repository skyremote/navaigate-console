// The NavAIgate N preview: every state in light and dark, a large live stage, the lead card live in the working and
// waiting looks, and the Mascots tab. ?theme=dark switches the page; ?view=live shows only the live parts.
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { LiveTab } from "@hd/app";
import { MascotsTab } from "@hd/mascotstab";
import { Mascot, PALETTE } from "@hd/mascots";
import { N_ID, hexToRgb, loopFor, lookAt, statesFor, type MascotState } from "@hd/mascots3d/catalog";
import { sharedGl } from "@hd/mascots3d/gl";
import { fixtureSnapshot } from "./fixtures";

const q = new URLSearchParams(location.search);
const dark = q.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
const liveOnly = q.get("view") === "live";

const NAME: Record<MascotState, string> = { work: "Working", idle: "Idle", wait: "Waiting for you", done: "Done", error: "Error" };
const PHASES = [0, 0.25, 0.5, 0.75];

function Pose({ state, phase, px }: { state: MascotState; phase: number; px: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const ctx = el.getContext("2d")!;
    const seconds = state === "done" ? phase * 1.1 : phase * loopFor(N_ID, state).seconds;
    if (sharedGl().draw(N_ID, lookAt(N_ID, state, seconds), hexToRgb(PALETTE[1]), px, 3)) sharedGl().blit(ctx, px);
  }, [state, phase, px]);
  return <canvas ref={ref} width={px} height={px} style={{ width: px, height: px }} />;
}

function Poses({ px }: { px: number }) {
  return (
    <div className="poses">
      {statesFor(N_ID).map((s) => (
        <div key={s} className="poserow">
          <b>{NAME[s]}</b>
          {(s === "done" ? [0, 0.35, 0.7, 1] : s === "error" ? [0] : PHASES).map((p) => (
            <Pose key={p} state={s} phase={p} px={px} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Stage() {
  const [state, setState] = useState<MascotState>("work");
  const [key, setKey] = useState(0);
  return (
    <div>
      <div className="swatches">
        {statesFor(N_ID).map((s) => (
          <button key={s} type="button" aria-pressed={state === s} onClick={() => { setState(s); setKey((k) => k + 1); }} style={{ width: "auto", borderRadius: 10, padding: "2px 10px", fontSize: 12, background: "var(--card)", color: "var(--foreground)" }}>{NAME[s]}</button>
        ))}
      </div>
      <div className="stage"><Mascot key={key} seed="stage" character={N_ID} colour={PALETTE[1]} state={state} size={192} label={`NavAIgate N, ${NAME[state]}`} /></div>
    </div>
  );
}

function Stats() {
  const [n, setN] = useState({ contexts: 0, live: 0 });
  useEffect(() => {
    const t = window.setInterval(() => setN({ contexts: sharedGl().contexts, live: document.querySelectorAll(".hd-m3[data-live]").length }), 400);
    return () => window.clearInterval(t);
  }, []);
  return <div className="stats">WebGL contexts: <b>{n.contexts}</b> · live canvases: <b>{n.live}</b> (cap 2) · pre-rendered loops on screen: <b>{document.querySelectorAll(".hd-m3-strip").length}</b></div>;
}

function Frame({ title, state }: { title: string; state: "working" | "waiting" | "needs-you" }) {
  const data = fixtureSnapshot(4, state === "working" ? "running" : "finished");
  data.lead = { ...data.lead!, state, activity: state === "working" ? "Writing reply" : state === "waiting" ? "Waiting for you" : "Needs your answer" };
  return (
    <section>
      <h2>{title}</h2>
      <div className="frame"><div className="hd-root"><LiveTab threadId={data.threadId} data={data} error={null} visibility="live" now={Date.now()} delayMs={8000} onHistory={() => undefined} /></div></div>
    </section>
  );
}

function App() {
  return (
    <>
      <header><h1>NavAIgate N, the lead card mascot</h1><Stats /></header>
      {!liveOnly && <section>
        <h2>Every state, drawn by the shader the live card uses ({dark ? "dark" : "light"} page)</h2>
        <p className="note">Four phases of each loop at 128 px. The loop joins up exactly: phase 1 is phase 0. Add ?theme=dark for the dark page.</p>
        <Poses px={128} />
      </section>}
      <div className="cols">
        <section><h2>Live, large (holds a live slot)</h2><Stage /></section>
        <Frame title="Lead card, working" state="working" />
        <Frame title="Lead card, waiting for you" state="waiting" />
        {!liveOnly && <section><h2>Mascots tab</h2><div className="frame"><div className="hd-root"><MascotsTab /></div></div></section>}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

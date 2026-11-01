// The avatar preview: the nine animations at every size, the agents list, the companion panel (the Mascots tab with its
// 180 px stage) and a frame-cost bench. ?theme=dark for the dark page, ?bench=1 to measure, ?state=idle to see an idle list.
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { LiveTab } from "@hd/app";
import { MascotsTab } from "@hd/mascotstab";
import { ANIMATIONS } from "@hd/avatars/animations";
import { Avatar } from "@hd/avatars/Avatar";
import { AvatarLoop, sharedLoop } from "@hd/avatars/engine";
import { setCoachCharacter } from "@hd/mascotchoice";
import { fixtureSnapshot } from "./fixtures";

const q = new URLSearchParams(location.search);
const dark = q.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
if (q.get("coach")) setCoachCharacter(q.get("coach"));

function Sheet() {
  return (
    <section>
      <h2>All nine, at 180, 96, 48 and 24 px ({dark ? "dark" : "light"} page)</h2>
      <table className="sheet">
        <tbody>
          {ANIMATIONS.map((a) => (
            <tr key={a.id}>
              <th scope="row">{a.name}</th>
              {[180, 96, 48, 24].map((px) => (
                <td key={px}><Avatar animation={a.id} seed={`${a.id}:${px}`} state="wait" size={px} preview label={`${a.name} at ${px}`} /></td>
              ))}
              <td><Avatar animation={a.id} seed={`${a.id}:run`} state="work" size={48} /><small>running</small></td>
              <td><Avatar animation={a.id} seed={`${a.id}:done`} state="done" size={48} /><small>done</small></td>
              <td><Avatar animation={a.id} seed={`${a.id}:err`} state="error" size={48} /><small>failed</small></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Bench() {
  const [out, setOut] = useState("measuring...");
  useEffect(() => {
    const run = async () => {
      const lines: string[] = [];
      const dpr = 2;
      for (const size of [24, 48, 180]) {
        const canvas = document.createElement("canvas");
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const per: string[] = [];
        let worst = 0;
        let total = 0;
        for (const a of ANIMATIONS) {
          for (let i = 0; i < 20; i++) a.draw(ctx, size, i * 0.033, { ink: "#ddd" });
          const t0 = performance.now();
          const n = 300;
          for (let i = 0; i < n; i++) a.draw(ctx, size, 1 + i * 0.033, { ink: "#ddd" });
          const ms = (performance.now() - t0) / n;
          per.push(`${a.id.split("-")[0]} ${ms.toFixed(3)}`);
          worst = Math.max(worst, ms);
          total += ms;
        }
        lines.push(`draw cost at ${size}px @2x (ms/frame): mean ${(total / ANIMATIONS.length).toFixed(3)}, worst ${worst.toFixed(3)} | ${per.join(", ")}`);
        await new Promise((r) => setTimeout(r, 0));
      }
      // The real loop: the lists on this page are mounted; measure the shared tick for three seconds.
      const proto = AvatarLoop.prototype as unknown as { tick: (n: number) => void };
      const orig = proto.tick;
      const costs: number[] = [];
      let ticks = 0;
      proto.tick = function (this: AvatarLoop, now: number) {
        const t0 = performance.now();
        orig.call(this, now);
        costs.push(performance.now() - t0);
        ticks++;
      };
      const loop = sharedLoop();
      const before = loop.stats();
      await new Promise((r) => setTimeout(r, 3000));
      proto.tick = orig;
      const after = loop.stats();
      const worked = costs.filter((c) => c > 0.05).sort((a, b) => a - b);
      const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
      lines.push(`shared loop, ${after.clients} avatars (${after.visible} visible, ${after.animating} animating) over 3 s: ${ticks} rAF callbacks, ${((after.frames - before.frames) / 3).toFixed(0)} avatar draws/s, ${(ticks / 3).toFixed(0)} callbacks/s`);
      lines.push(`  tick cost where it drew: mean ${mean(worked).toFixed(2)} ms, p95 ${(worked[Math.floor(worked.length * 0.95)] ?? 0).toFixed(2)} ms, max ${(worked.at(-1) ?? 0).toFixed(2)} ms; whole-callback mean ${mean(costs).toFixed(2)} ms`);
      setOut(lines.join("\n"));
      document.title = "bench done";
    };
    void run();
  }, []);
  return <pre id="bench" style={{ fontSize: 11, whiteSpace: "pre-wrap", padding: "0 24px" }}>{out}</pre>;
}

function App() {
  const state = q.get("state") === "idle" ? "finished" : "mixed";
  const data = fixtureSnapshot(12, state);
  return (
    <>
      <header><h1>Helper Desk avatars</h1></header>
      {q.get("bench") && <Bench />}
      {q.get("view") !== "panels" && <Sheet />}
      <div className="cols">
        <section>
          <h2>Agents list</h2>
          <div className="frame"><div className="hd-root"><LiveTab threadId={data.threadId} data={data} error={null} visibility="live" now={Date.now()} delayMs={8000} onHistory={() => undefined} /></div></div>
        </section>
        <section>
          <h2>Companion panel</h2>
          <div className="frame"><div className="hd-root"><MascotsTab /></div></div>
        </section>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

// The perf page plus the right-hand 3D mascot, so both live slots draw at once: the lead card and the coach.
import { createRoot } from "react-dom/client";
import { LiveTab } from "@hd/app";
import { Mascot, PALETTE } from "@hd/mascots";
import { fixtureSnapshot } from "./fixtures";

const q = new URLSearchParams(location.search);
const count = Number(q.get("agents") ?? 40);
const mode = (q.get("state") ?? "running") as "running" | "mixed" | "finished";
const data = fixtureSnapshot(count, mode);
createRoot(document.getElementById("root")!).render(
  <>
    <div className="frame">
      <div className="hd-root">
        <LiveTab threadId={data.threadId} data={data} error={null} visibility="live" now={Date.now()} delayMs={8000} onHistory={() => undefined} />
      </div>
    </div>
    <div className="hd-companion" style={{ transform: "translate3d(900px, 300px, 0)" }}>
      <Mascot seed="coach" character="nebula" colour={PALETTE[1]} state="work" size={58} />
    </div>
  </>,
);

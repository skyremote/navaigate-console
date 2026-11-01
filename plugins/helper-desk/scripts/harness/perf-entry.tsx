// A page with N Helper Desk cards for frame-timing traces: ?agents=40&state=running&theme=light
import { createRoot } from "react-dom/client";
import { LiveTab } from "@hd/app";
import { fixtureSnapshot } from "./fixtures";

const q = new URLSearchParams(location.search);
const count = Number(q.get("agents") ?? 40);
const mode = (q.get("state") ?? "running") as "running" | "mixed" | "finished";
document.documentElement.classList.toggle("dark", q.get("theme") === "dark");
const data = fixtureSnapshot(count, mode);
createRoot(document.getElementById("root")!).render(
  <div className="frame">
    <div className="hd-root">
      <LiveTab threadId={data.threadId} data={data} error={null} visibility="live" now={Date.now()} delayMs={8000} onHistory={() => undefined} />
    </div>
  </div>,
);

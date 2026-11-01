// Reads a Chrome trace saved by `agent-browser trace stop` and prints main-thread, compositor and GPU time.
//   node scripts/harness/analyse-trace.mjs trace.json [label]
// Busy time is the union of each thread's top-level tasks, so nested events are not counted twice.
import { readFileSync } from "node:fs";

const [file, label = file] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(file, "utf8"));
const events = Array.isArray(raw) ? raw : raw.traceEvents;

const names = new Map();
for (const e of events) if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args.name);

const tasks = new Map();
let lo = Infinity;
let hi = -Infinity;
const frameWork = new Map();
const raf = new Map();
const frames = new Map();
for (const e of events) {
  if (e.ph !== "X" || typeof e.dur !== "number") continue;
  const key = `${e.pid}:${e.tid}`;
  if (e.ts < lo) lo = e.ts;
  if (e.ts + e.dur > hi) hi = e.ts + e.dur;
  if (e.name === "ThreadControllerImpl::RunTask") {
    const list = tasks.get(key) ?? [];
    list.push(e);
    tasks.set(key, list);
  }
  if (e.name === "FireAnimationFrame") {
    const r = raf.get(key) ?? { n: 0, us: 0 };
    r.n++;
    r.us += e.dur;
    raf.set(key, r);
  }
  if (e.name === "ProxyMain::BeginMainFrame") {
    frames.set(key, (frames.get(key) ?? 0) + 1);
    frameWork.set(key, (frameWork.get(key) ?? 0) + e.dur);
  }
}
const seconds = (hi - lo) / 1e6;

function busy(list) {
  const sorted = [...list].sort((a, b) => a.ts - b.ts);
  let total = 0;
  let end = -Infinity;
  for (const e of sorted) {
    const s = Math.max(e.ts, end);
    const f = e.ts + e.dur;
    if (f > s) total += f - s;
    if (f > end) end = f;
  }
  return total;
}

function pick(thread) {
  let best = null;
  for (const [key, name] of names) {
    if (name !== thread) continue;
    const t = busy(tasks.get(key) ?? []);
    if (!best || t > best.t) best = { key, t };
  }
  return best;
}

const perSecond = (us) => Number((us / 1000 / seconds).toFixed(2));
const main = pick("CrRendererMain");
const comp = pick("Compositor");
const gpu = pick("CrGpuMain");
const gpuComp = pick("CompositorGpuThread");
const viz = pick("VizCompositorThread");
const n = main ? (frames.get(main.key) ?? 0) : 0;
const out = {
  label,
  traceSeconds: Number(seconds.toFixed(2)),
  mainFrames: n,
  mainThreadMsPerSecond: main ? perSecond(main.t) : null,
  mainThreadMsPerFrame: main && n ? Number((main.t / 1000 / n).toFixed(3)) : null,
  beginMainFrameMsPerFrame: main && n ? Number(((frameWork.get(main.key) ?? 0) / 1000 / n).toFixed(3)) : null,
  animationFrameCallbacks: main ? (raf.get(main.key)?.n ?? 0) : 0,
  animationFrameCallbackMsEach: main && raf.get(main.key) ? Number((raf.get(main.key).us / 1000 / raf.get(main.key).n).toFixed(3)) : 0,
  compositorThreadMsPerSecond: comp ? perSecond(comp.t) : null,
  gpuProcessMsPerSecond: perSecond((gpu?.t ?? 0) + (gpuComp?.t ?? 0) + (viz?.t ?? 0)),
  gpuBreakdownMsPerSecond: { CrGpuMain: perSecond(gpu?.t ?? 0), CompositorGpuThread: perSecond(gpuComp?.t ?? 0), VizCompositorThread: perSecond(viz?.t ?? 0) },
};
console.log(JSON.stringify(out, null, 2));

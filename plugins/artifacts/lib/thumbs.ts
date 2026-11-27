// Small preview pictures of local HTML pages, taken with a headless Chrome over the DevTools
// protocol. One Chrome per batch, one page at a time, then Chrome is closed. Chrome picks its own
// free DevTools port (written to DevToolsActivePort in its profile), so this never talks to
// another browser. No npm dependency: Node's built-in WebSocket and fetch are enough.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromePath } from "./desktop";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reports a JPEG data URL (about 480x300) for each path, or null when it can't make one. */
export async function takeThumbnails(paths: string[], onEach: (path: string, dataUrl: string | null) => void): Promise<void> {
  const chrome = chromePath();
  if (!chrome) {
    for (const p of paths) onEach(p, null);
    return;
  }
  const profile = mkdtempSync(join(tmpdir(), "bb-artifacts-chrome-"));
  const proc = spawn(
    chrome,
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,800", "about:blank"],
    { stdio: "ignore", windowsHide: true },
  );
  let failed = false;
  proc.on("error", () => {
    failed = true;
  });
  const done = new Set<string>();
  let ws: WebSocket | null = null;
  try {
    let port: string | null = null;
    for (let i = 0; i < 75 && !port && !failed; i++) {
      try {
        port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]?.trim() || null;
      } catch {
        await sleep(200);
      }
    }
    if (!port) return;
    for (let i = 0; i < 25 && !ws; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        const page = list.find((t) => t.type === "page");
        if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
      } catch {
        await sleep(200);
      }
    }
    if (!ws) return;
    const socket = ws;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("devtools socket")), { once: true });
    });
    let id = 0;
    const pending = new Map<number, (m: { result?: { data?: string } }) => void>();
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)!(m);
        pending.delete(m.id);
      }
    });
    const send = (method: string, params: object = {}) =>
      new Promise<{ result?: { data?: string } }>((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        socket.send(JSON.stringify({ id: i, method, params }));
        setTimeout(() => {
          if (pending.delete(i)) resolve({});
        }, 15_000);
      });
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    for (const path of paths) {
      try {
        await send("Page.navigate", { url: pathToFileURL(path).href });
        await sleep(1800); // let fonts load and opening animations settle
        const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 72, clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.375 } });
        onEach(path, shot.result?.data ? `data:image/jpeg;base64,${shot.result.data}` : null);
      } catch {
        onEach(path, null);
      }
      done.add(path);
    }
  } catch {
    /* reported below */
  } finally {
    // Every path gets an answer, so no card waits forever for a preview.
    for (const p of paths) if (!done.has(p)) onEach(p, null);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    proc.kill();
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Chrome may still hold a file; the OS temp cleaner will take it */
      }
    }, 3000);
  }
}

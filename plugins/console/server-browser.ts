// Read a public page in a throwaway headless Chrome: a fresh temporary profile
// (never the owner's own browser or any login), driven over the DevTools protocol,
// then killed and deleted. Used by the Audience cards for LinkedIn and
// Instagram, whose public profiles only render in a real browser.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Evaluate = (expression: string) => Promise<unknown>;

async function withHeadless<T>(startUrl: string, fn: (evaluate: Evaluate) => Promise<T>, budgetMs = 45_000): Promise<T> {
  if (!fs.existsSync(CHROME)) throw new Error("Google Chrome is not installed");
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error("no WebSocket in this runtime");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nav-audience-"));
  const child = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1400,1200", `--user-agent=${UA}`, startUrl],
    { stdio: "ignore" },
  );
  let ws: WebSocket | null = null;
  const deadline = Date.now() + budgetMs;
  try {
    let port = 0;
    while (!port && Date.now() < deadline) {
      try {
        port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]) || 0;
      } catch {
        await sleep(250);
      }
    }
    if (!port) throw new Error("headless Chrome did not start");
    let wsUrl: string | undefined;
    while (!wsUrl && Date.now() < deadline) {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
      if (!wsUrl) await sleep(250);
    }
    if (!wsUrl) throw new Error("no page in headless Chrome");
    const sock = new WS(wsUrl);
    ws = sock;
    await new Promise<void>((res, rej) => {
      sock.onopen = () => res();
      sock.onerror = () => rej(new Error("DevTools connection failed"));
    });
    let id = 0;
    const pending = new Map<number, (v: { result?: { result?: { value?: unknown } }; error?: { message: string } }) => void>();
    sock.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number };
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)?.(msg as never);
        pending.delete(msg.id);
      }
    };
    const evaluate: Evaluate = async (expression) => {
      const n = ++id;
      const reply = await new Promise<{ result?: { result?: { value?: unknown } }; error?: { message: string } }>((res) => {
        pending.set(n, res);
        sock.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
        setTimeout(() => res({ error: { message: "timeout" } }), 10_000);
      });
      if (reply.error) throw new Error(reply.error.message);
      return reply.result?.result?.value;
    };
    return await Promise.race([fn(evaluate), sleep(Math.max(1_000, deadline - Date.now())).then(() => Promise.reject(new Error("timed out")))]);
  } finally {
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    child.kill("SIGKILL");
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1_500);
  }
}

/** Poll an expression that returns a JSON string until `done` says so. */
async function poll<T>(evaluate: Evaluate, expression: string, done: (v: T) => boolean, tries = 14): Promise<T | null> {
  let last: T | null = null;
  for (let i = 0; i < tries; i++) {
    await sleep(1_500);
    try {
      last = JSON.parse(String(await evaluate(expression))) as T;
      if (done(last)) return last;
    } catch {
      /* page still loading */
    }
  }
  return last;
}

/**
 * LinkedIn followers from the public profile. LinkedIn shows the public
 * profile to a visitor arriving from a search page; its JSON-LD carries the
 * exact count (FollowAction), the page text a rounded one ("2K followers").
 */
export async function linkedinFollowers(profileUrl: string): Promise<{ count: number; exact: boolean }> {
  try {
    return await linkedinOnce(profileUrl, "https://www.google.com/");
  } catch {
    // The login wall comes and goes; one more try in a fresh browser from another search page.
    return linkedinOnce(profileUrl, "https://www.bing.com/");
  }
}

async function linkedinOnce(profileUrl: string, from: string): Promise<{ count: number; exact: boolean }> {
  return withHeadless(from, async (evaluate) => {
    await sleep(2_500);
    await evaluate(`location.href = ${JSON.stringify(profileUrl)}`);
    type R = { path: string; ld: string | null; text: string | null };
    const r = await poll<R>(
      evaluate,
      `JSON.stringify((() => {
        const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || "").join(" ");
        const m = ld.match(/FollowAction[^}]*?userInteractionCount"?\\s*:\\s*(\\d+)/);
        const t = (document.body && document.body.innerText) || "";
        const f = t.match(/([\\d.,]+[KkM]?\\+?)\\s+followers/i);
        return { path: location.pathname, ld: m ? m[1] : null, text: f ? f[1] : null };
      })())`,
      (v) => !!v.ld || !!v.text || v.path.startsWith("/authwall"),
    );
    if (!r || r.path.startsWith("/authwall")) throw new Error("LinkedIn asked for a login");
    if (r.ld) return { count: Number(r.ld), exact: true };
    const n = r.text ? parseShort(r.text) : null;
    if (n === null) throw new Error("no follower count on the page");
    return { count: n, exact: false };
  });
}

/** X followers from the logged-out profile page ("150 Followers" on the followers link). */
export async function xFollowers(profileUrl: string): Promise<{ count: number; exact: boolean }> {
  return withHeadless(profileUrl, async (evaluate) => {
    type R = { text: string | null; login: boolean };
    const r = await poll<R>(
      evaluate,
      `JSON.stringify((() => {
        const a = [...document.querySelectorAll('a[href$="/followers"], a[href$="/verified_followers"]')].map((x) => x.textContent || "").join(" ");
        const t = a || ((document.body && document.body.innerText) || "");
        const f = t.match(/([\\d.,]+[KkM]?)\\s+Followers/);
        return { text: f ? f[1] : null, login: location.pathname.startsWith("/i/flow/login") };
      })())`,
      (v) => !!v.text || v.login,
      12,
    );
    if (!r || r.login) throw new Error("X asked for a login");
    if (!r.text) throw new Error("no follower count on the page");
    const n = parseShort(r.text);
    if (n === null) throw new Error("no follower count on the page");
    return { count: n, exact: !/[KkM]/.test(r.text) };
  });
}

/** Instagram followers from the public profile page (its live text, or the description meta tag). */
export async function instagramFollowers(profileUrl: string): Promise<{ count: number; exact: boolean }> {
  return withHeadless(profileUrl, async (evaluate) => {
    type R = { text: string | null; meta: string | null; login: boolean };
    const r = await poll<R>(
      evaluate,
      `JSON.stringify((() => {
        const t = (document.body && document.body.innerText) || "";
        const f = t.match(/([\\d.,]+[KkM]?)\\s+followers/i);
        const d = (document.querySelector('meta[property="og:description"]') || document.querySelector('meta[name="description"]'))?.getAttribute("content") || "";
        const m = d.match(/([\\d.,]+[KkM]?)\\s+Followers/i);
        return { text: f ? f[1] : null, meta: m ? m[1] : null, login: location.pathname.startsWith("/accounts/login") };
      })())`,
      (v) => !!v.text || !!v.meta || v.login,
      10,
    );
    if (!r || r.login) throw new Error("Instagram asked for a login");
    const raw = r.text ?? r.meta;
    const n = raw ? parseShort(raw) : null;
    if (n === null) throw new Error("no follower count on the page");
    return { count: n, exact: !/[KkM]/.test(raw as string) };
  });
}

export function parseShort(s: string): number | null {
  const m = s.trim().match(/^([\d.,]+)\s*([KkMm])?/);
  if (!m) return null;
  const n = Number(m[2] ? m[1].replace(/,/g, ".") : m[1].replace(/[.,]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1));
}

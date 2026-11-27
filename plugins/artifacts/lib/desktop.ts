// Opening artifacts and pages: in the Claude desktop app (where Claude's own Share menu and
// "Install as app" live), in Chrome, or in the file manager. Works on Windows, macOS and Linux.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeAppLink } from "./artifact-list";
import { runProcess } from "./claude-runner";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

export function chromePath(): string | null {
  if (WIN) {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.map((r) => join(r, "Google", "Chrome", "Application", "chrome.exe")).find((p) => existsSync(p)) ?? null;
  }
  if (MAC) {
    const apps = ["/Applications", join(homedir(), "Applications")];
    return apps.map((a) => join(a, "Google Chrome.app", "Contents", "MacOS", "Google Chrome")).find((p) => existsSync(p)) ?? null;
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p)) ?? null;
}

/** Start a program and let it outlive this call (Chrome started here may be the browser itself). */
function launch(cmd: string, args: string[], verbatim = false): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/** Open a web address or a local file in Chrome; the default browser if Chrome isn't installed. */
export async function openInChrome(target: string): Promise<boolean> {
  const chrome = chromePath();
  if (MAC) return launch("/usr/bin/open", chrome ? ["-a", dirname(dirname(dirname(chrome))), target] : [target]);
  // A Windows drive path goes to Chrome with backslashes; web addresses go as they are.
  if (chrome) return launch(chrome, [/^[A-Za-z]:[\\/]/.test(target) ? target.replace(/\//g, "\\") : target]);
  if (WIN) return launch("explorer.exe", [`"${target}"`], true);
  return launch("xdg-open", [target]);
}

/** Show a file selected in File Explorer / Finder. */
export async function revealFile(path: string): Promise<boolean> {
  if (WIN) return launch("explorer.exe", [`/select,"${path.replace(/\//g, "\\")}"`], true);
  if (MAC) return launch("/usr/bin/open", ["-R", path]);
  return launch("xdg-open", [dirname(path)]);
}

let claudeApp: { at: number; value: boolean } | null = null;

/**
 * Whether the Claude desktop app is installed. Install as app only exists there (Claude for Mac or
 * Windows 6.28899 or later). Windows: the Microsoft Store package, or the older installer's
 * claude:// link registration. macOS: Claude.app.
 */
export async function claudeAppInstalled(): Promise<boolean> {
  if (claudeApp && Date.now() - claudeApp.at < 10 * 60_000) return claudeApp.value;
  let value = false;
  if (MAC) value = ["/Applications/Claude.app", join(homedir(), "Applications", "Claude.app")].some((p) => existsSync(p));
  else if (WIN) {
    const r = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "if ((Get-AppxPackage -Name 'Claude' -ErrorAction SilentlyContinue) -or (Test-Path 'HKCU:\\Software\\Classes\\claude')) { 'yes' } else { 'no' }"],
      { timeoutMs: 20_000 },
    );
    value = r.stdout.includes("yes");
  }
  claudeApp = { at: Date.now(), value };
  return value;
}

/** Open an artifact in the Claude desktop app, at the page with its Share menu and Install as app. */
export async function openInClaudeApp(url: string): Promise<boolean> {
  const link = claudeAppLink(url);
  if (!link) return false;
  // ShellExecute via Start-Process hands the link to the Claude app and brings it to the front.
  // The link is checked above (claude://claude.ai/artifact/<letters, digits, - and _>) and reaches
  // PowerShell as an environment variable, never inside the command text.
  if (WIN) {
    const r = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:ART_LINK"], { env: { ...process.env, ART_LINK: link }, timeoutMs: 20_000 });
    return r.code === 0;
  }
  if (MAC) return launch("/usr/bin/open", [link]);
  return false;
}

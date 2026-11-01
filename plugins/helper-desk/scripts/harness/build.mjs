// Bundles a harness page into one self-contained HTML file.
//   node scripts/harness/build.mjs <anim|perf|perf-coach|perf-n|n-lead|n2d> <helper-desk root> <out.html>
// `root` can be this checkout or another one (the baseline for a before/after trace); its app is imported as @hd.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [kind, rootArg, outArg] = process.argv.slice(2);
if (!kind || !rootArg || !outArg) throw new Error("usage: build.mjs <anim|perf|perf-coach|perf-n|n-lead|n2d> <helper-desk root> <out.html>");
const root = resolve(rootArg);

function findEsbuild() {
  if (process.env.ESBUILD) return process.env.ESBUILD;
  const plugins = join(homedir(), ".bb", "plugins");
  const dir = existsSync(plugins) ? readdirSync(plugins).find((d) => d.startsWith("toolchain-")) : null;
  return dir ? join(plugins, dir, "node_modules", ".bin", "esbuild") : "esbuild";
}

const work = mkdtempSync(join(tmpdir(), "hd-harness-"));
execFileSync(
  findEsbuild(),
  [
    join(here, `${kind}-entry.tsx`),
    "--bundle",
    "--format=iife",
    "--minify",
    "--jsx=automatic",
    "--define:process.env.NODE_ENV=\"production\"",
    `--alias:@hd=${root}`,
    `--alias:@get-bb/plugin-sdk/app=${join(here, "sdk-app.ts")}`,
    `--alias:sonner=${join(here, "sonner.ts")}`,
    `--outdir=${work}`,
    "--log-level=warning",
  ],
  { stdio: "inherit", env: { ...process.env, NODE_PATH: join(root, "node_modules") } },
);
const js = readFileSync(join(work, `${kind}-entry.js`), "utf8").replace(/<\/script/g, "<\\/script");
const css = existsSync(join(work, `${kind}-entry.css`)) ? readFileSync(join(work, `${kind}-entry.css`), "utf8") : "";
const theme = `
:root{--foreground:#1d1d1f;--background:#fff;--muted:#f2f2f4;--muted-foreground:#6b6b72;--border:#e3e3e8;--card:#fff;--accent:#f4f4f6;--ring:#c2561a}
.dark{--foreground:#ececf0;--background:#16171c;--muted:#23242a;--muted-foreground:#9a9aa3;--border:#2c2d34;--card:#1c1d22;--accent:#23242a;--ring:#e08a4a;color-scheme:dark}
body{margin:0;background:var(--muted);color:var(--foreground);font-family:system-ui,-apple-system,sans-serif}
.frame{width:440px;margin:0 0 16px;border:1px solid var(--border);border-radius:12px;background:var(--background);padding:10px;box-sizing:border-box}
.frame .hd-root{height:auto}
header{display:flex;align-items:baseline;gap:24px;padding:14px 24px}h1{margin:0;font-size:18px}h2{margin:0 0 8px;font-size:14px}
section{padding:0 24px 18px}.cols{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
.note{margin:0 0 8px;font-size:12px;color:var(--muted-foreground)}.stats{font-size:12px;color:var(--muted-foreground)}
.swatches{display:flex;gap:6px;margin-bottom:10px}.swatches button{width:20px;height:20px;border-radius:50%;border:2px solid var(--background);box-shadow:0 0 0 1px var(--border);cursor:pointer}.swatches button[aria-pressed=true]{box-shadow:0 0 0 2px var(--foreground)}
.sheet{border-collapse:collapse;background:var(--background);border:1px solid var(--border);border-radius:10px}.poses{display:flex;flex-direction:column;gap:6px}.poserow{display:flex;align-items:center;gap:6px}.poserow b{width:110px;font-size:12px}.stage{display:flex;justify-content:center;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--background);min-width:260px}.sheet th,.sheet td{padding:6px 14px;text-align:center;font-size:11px;font-weight:600}.sheet th[scope=row]{text-align:left;white-space:nowrap}.sheet td small{display:block;font-weight:400;color:var(--muted-foreground)}.sheet td .hd-botwrap{margin:0 auto}
`;
writeFileSync(resolve(outArg), `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${kind === "n-lead" ? "NavAIgate N, Helper Desk lead mascot" : kind === "anim" ? "Helper Desk avatars" : "Helper Desk 3D mascots"}</title><style>${theme}\n${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`);
console.log(`wrote ${resolve(outArg)} (${(readFileSync(resolve(outArg)).length / 1024).toFixed(0)} KiB)`);

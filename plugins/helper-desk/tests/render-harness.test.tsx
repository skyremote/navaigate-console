// Renders the Team tab from a saved team JSON (for example the live harness's
// output) into a standalone HTML page with Helper Desk's CSS, for screenshots.
// Not part of the normal test run.
//
//   HD_TEAM=/tmp/team.json HD_HTML=/tmp/team.html npx vitest run tests/render-harness.test.tsx
import { readFileSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { teamSchema } from "../team";
import { TeamView } from "../teamtab";

const input = process.env.HD_TEAM ?? "";
const output = process.env.HD_HTML ?? "";

describe.skipIf(!input || !output)("render the Team tab to HTML", () => {
  it("writes the page", () => {
    const team = teamSchema.parse(JSON.parse(readFileSync(input, "utf8")));
    const css = ["../desk.css", "../team.css"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
    const theme = ":root{--foreground:#1d1d1f;--background:#fff;--muted:#f2f2f4;--muted-foreground:#6b6b72;--border:#e3e3e8;--card:#fff;--accent:#f4f4f6;--ring:#c2561a}body{margin:0;background:#fafafa;font-family:system-ui}.frame{width:420px;margin:16px auto;border:1px solid var(--border);border-radius:12px;background:#fff;height:auto}.hd-root{height:auto}";
    const tabs = '<div class="hd-tabs" role="tablist"><button role="tab" aria-selected="false">Live</button><button role="tab" aria-selected="false">History</button><button role="tab" aria-selected="true">Team</button></div>';
    const body = renderToStaticMarkup(<TeamView data={team} onOpenThread={() => undefined} />);
    const open = process.env.HD_OPEN_EARLIER ? body.replace('<details class="ht-earlier">', '<details class="ht-earlier" open="">') : body;
    writeFileSync(output, `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Helper Desk Team</title><style>${theme}\n${css}</style></head><body><div class="frame"><div class="hd-root">${tabs}${open}</div></div></body></html>`);
    expect(body).toContain("ht-root");
  });
});

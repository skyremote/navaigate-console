---
name: navaigate-charts
description: Render rich visuals inside a bb reply in the NavAIgate look — ::nav-chart (bars, stats, split, steps), ::nav-links (platform-coloured link cards for LinkedIn, X, Threads, YouTube, GitHub and more) and ::nav-pipeline (an agent stack or any flow of work between agents). Use whenever a reply carries three or more numbers, a list of two or more links, or describes how agents or steps hand work to each other — show it, do not just list it.
---

# ::nav-chart — charts inside replies

The NavAIgate Skin plugin renders a `::nav-chart{...}` line in an assistant
message as a styled chart that follows the active theme (light and dark).
Put it on its own line, never inside backticks or a code fence, and emit the
whole directive in one piece.

## Kinds

- `bars` (default): ranked comparison. `highlight="<label>"` paints that bar gold and quiets the rest.
- `stats`: a row of up to four big tabular numerals (KPIs).
- `split`: one 100% bar plus a legend with share percentages (a breakdown of a whole).
- `steps`: a run-sheet timeline. Values are `done`, `now`, `next` or `blocked` instead of numbers.

## Attributes

- `data` (required): `Label:value,Label:value` (up to 24 points; labels must not contain commas).
- `title`: short caps caption.
- `unit`: appended to values (`h`, `%`, `€`, `threads`).
- `note`: one-line source or caveat under a hairline. Always cite where the numbers came from.
- `highlight`: label to emphasise (bars, stats).

## Examples

::nav-chart{kind="bars" title="Threads by harness" data="Claude:32,Codex:14,Cursor:5" unit="threads" highlight="Claude" note="Source: bb thread list, 2 Oct 2026"}

::nav-chart{kind="stats" data="Running:2,Needs you:10,Parked:39" highlight="Needs you"}

::nav-chart{kind="split" title="Where the week went" data="Build:14,Client calls:6,Admin:3" unit="h"}

::nav-chart{kind="steps" title="Skin rollout" data="Theme:done,Rail:done,Control room:now,Charts:next"}

## Rules

- Real numbers only, with a `note` naming the source. Never invent data to fill a chart.
- One chart per point you are making; keep the prose around it short.
- If a value is unknown, leave it out rather than writing 0.

# ::nav-links — link cards in each platform's colour

Use whenever a reply lists two or more URLs (published posts, PRs, docs).
The platform is detected from the host: LinkedIn blue, X black, Threads
black, YouTube red, Instagram, TikTok, Facebook, Bluesky, GitHub,
navaigate.dev; anything else gets a gold "web" card.

- `items` (required): URLs separated by spaces, commas or semicolons (up to 24).
  Prefix `Label=` to name a card: `Guide=https://...` (use `_` for spaces in labels).
- `title`: short caps caption. `note`: one line under the cards.

::nav-links{title="Posted today" items="https://www.linkedin.com/posts/... https://x.com/HANDLE/status/... https://www.threads.net/@HANDLE/post/... https://youtube.com/shorts/..."}

# ::nav-pipeline — agent stacks and work flows

Use when describing how agents (or steps) hand work to each other: who plans,
who runs in parallel, who reviews, who advises. Monospace, coloured borders,
curved connectors between layers.

- `layers` (required): layers top to bottom separated by `;`, boxes inside a
  layer separated by `,`, each box `Title|detail|tone`. Up to 6 layers, 5 boxes each.
- Tones: `gold`, `orange`, `blue`, `green`, `plum`, `red`, `teal`, `ink`.
- `side`: one `Title|detail|tone` box on the left (an advisor or watcher).
- `log`: session rows separated by `;`, each `HH:MM who|what happened`.
- `legend`: `Label|tone ; Label|tone` to name the colours (else the first box of each colour names it).
- `title`: caption.

::nav-pipeline{title="Agent stack" legend="Opus plans|orange ; Sonnet runs|blue ; Fable watches|plum" layers="Opus 5.5|plans + ships|orange ; Worker|edits + tests|blue , Explorer|reads code|blue , Researcher|pulls docs|blue ; Opus 5.5|review + ship|orange" side="Fable|advisor, watches every turn|plum" log="23:51 Worker|tests failed ; 23:52 Fable|read the migration first ; 23:53 Worker|tests pass"}

Same rules as charts: own line, no code fence, one piece, real facts only.

# bb-plugin-kanban

A kanban board for bb where **every card is a thread**. Open **Kanban** in the
sidebar: four columns — Backlog, In progress, Review, Done — with one card per
thread. Drag cards between columns (or use the per-card column select on
touch devices); click a card to open its thread.

Agents move their own cards as work progresses, so the board reads as a live
status wall rather than a list of titles.

## What it ships

| Surface | Where | What |
| --- | --- | --- |
| Board page | `app.tsx` → `app.slots.navPanel` | Columns, drag-and-drop, project filter, "Not on board" tray, live status dot per thread, card count in the sidebar row |
| Native tools | `server.ts` → `bb.agents.registerTool` | `kanban_move { column, threadId?, note? }` and `kanban_board { projectId? }` |
| CLI | `bb kanban` | `board`, `move <column>`, `add <thread>`, `remove <thread>`, `history` — every command takes `--json` |
| Instructions | `contributeInstructions` | Tells an agent which column its card is in at session start |
| Skill | `skills/kanban/SKILL.md` | When and how an agent should move its card |
| Automation | `bb.events.on` | New visible threads join Backlog; a Backlog card moves to In progress when its thread starts running; archived/deleted threads leave the board |
| Storage | `bb.storage.database()` | `cards` + `moves` tables in the plugin's own SQLite; the column is also mirrored into the thread's plugin metadata (`{ column }`) best-effort |

Columns are fixed at four. Free-text aliases (`doing`, `wip`, `complete`,
`todo`, …) resolve to the right column at every boundary.

## Settings

| Key | Default | Effect |
| --- | --- | --- |
| `autoAdd` | `true` | Add new visible threads to Backlog |
| `autoStart` | `true` | Move a Backlog card to In progress when its thread becomes active |
| `autoDoneOnArchive` | `false` | On archive, move the card to Done instead of removing it |

`bb plugin config kanban set autoDoneOnArchive true`

## Agent usage

```
kanban_move { "column": "review", "note": "PR #42 ready — check the migration" }
bb kanban move review --note "PR #42 ready — check the migration"
bb kanban move done --thread thr_child123 --note "merged"
bb kanban board --project all
bb kanban history
```

`--thread` defaults to the invoking thread when the command runs from one.

## Develop

```
npm install
npm run typecheck      # tsc over server.ts, board.ts, app.tsx
npm test               # vitest: board store, plugin behaviour (fake host), board page (jsdom)
bb plugin build        # dist/server.js, dist/app.js, dist/app.css + meta
bb plugin install .    # register this directory in place
bb plugin dev          # rebuild + reload on save
```

`board.ts` is pure logic (column vocabulary + `BoardStore` over better-sqlite3)
so it tests without a server. `server.ts` wires registrations; `app.tsx` is
the page. `components/ui/` is vendored shadcn source you own.

## Manifest notes

- `bb.server` / `bb.app` — entries; `bb.branding.icon` is `Columns2`.
- `engines.bbPluginSdk` is a floor; `bb plugin types` repins it.
- `zod` stays in `dependencies` (bundled in both entries); React, the portal
  radix families, `sonner`, `clsx`, `tailwind-merge` and `cva` are host-shimmed
  and live only in `devDependencies` for types.

Licence: PolyForm Internal Use 1.0.0, part of [NavAIgate Console](https://github.com/skyremote/navaigate-console) by NavAIgate. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

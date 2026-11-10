# NavAIgate Workspace for bb

*(Installed as `navaigate-skin`; the id is kept so existing installs, tags and settings carry over.)*

**Guide and trailer:** the guide page published with the plugin repository

The NavAIgate look for [bb](https://getbb.app), matched to navaigate.dev: white paper and ink, cool greys and one blue for live work, in light and dark. It turns bb's sidebar into a run sheet you can organise, puts a live usage dock under the chat box, and lets agents draw real charts inside their replies.

## What you get

**Rail (the sidebar)**
- NOW card: what is cooking right now, with a lattice loader, and how many chats need you.
- **Two-line rows**: each chat shows its title, then the model and effort it runs on ("Opus · High", or "Codex · GPT-6.1 Sol · High" for other harnesses), how many of its sub-agents have finished ("2/7") and its git branch (hidden outside a git repo). The left mark says what it needs: a green tick when it finished unread, a gold question mark when it waits for an answer, a pause mark when a message is queued, the come-back-later flag, and a gold spinner on the right while it works. Each project has its own colour, a dot on its heading and a bar down its chats; right-click the heading and choose **Colour** to change it. A **New chat** row sits at the top. Right-click the rail (or a project heading) for **Compact rows** to go back to one line per chat with the harness and time.
- **Navigate row you can fold**: bb's own navigation (New thread, Search threads, Board, Automations, plugin pages, More) sits under a *Navigate* row. Click it, or press **⌘⇧B**, to fold the list to that one line so the rail moves up; the choice is remembered. Right-click it for **Hide navigation entirely**, and right-click the rail for **Show navigation** to bring it back. The rows stay bb's own, so clicks, the "…" menus, More and reordering work as before.
- Harness filter (All, Claude, Codex, Cursor and anything else you run) as one compact row, each harness shown as its logo and count with the name in a tooltip (the names return when the rail is wide enough), and a **Tags** button beside Select. It opens a dropdown: tick tags to show chats with any of them, **Clear**, **New tag…**, and **Manage tags** to rename, recolour or delete. While a filter is on, the active tags show as small chips (cross to remove, right-click to edit).
- **Come back later**: flag any chat as *revisit*, *done, check it* or *has a mistake*. Flagged chats move to their own section with an animated status mark so they cannot be missed.
- **Folders**: real folders on disk under each project (via the [project-folders](https://github.com/VKirill/bb-plugin-project-folders) plugin). Make new ones, add existing ones from the drive, drag chats in, drag folders into folders. Right-click a folder (or use the folder-plus button on hover) and choose **New folder inside** for a subfolder.
- **Tree guides**: sub-agent chats hang under their parent chat, and folders and chats under their folder, joined by a thin line from the parent down to the last child, at every depth. The line turns blue while anything in that branch is running.
- **Sub-agents fold away**: a chat with sub-agents starts folded under its "done/total" chip. Click the chip (its chevron turns), press Right or Left on the focused row, or right-click it for **Show sub-agents** / **Hide sub-agents**; clicking the title still opens the chat. Folded, the chip shows a spinner while a sub-agent works and a red dot when one needs you, and those sub-agents peek out on their own until they finish. Open or folded is remembered per chat and follows you across windows; right-click the rail for **Expand all** and **Collapse all**. Grandchildren fold the same way, and nothing moves under reduced motion.
- **Groups**: your own folders for whole projects, kept only in the rail, so nothing changes on disk or in bb. Right-click the rail for **New group**, or right-click a project heading for **Move to group**; drag a project heading onto a group to put it inside. Groups nest, fold, rename and reorder by drag; inside a group sections number i.1, i.2. To take something out, right-click it and choose **Move out of group**, or drag it onto the "Drop here to take it out of the group" strip. Deleting a group moves its contents up a level.
- **Sections you arrange**: click a heading to fold it, drag a heading to reorder. Order and folds are kept on your bb server, so every window shows the same layout.
- **Multi-select**: ⌘-click to toggle, ⇧-click for a range, or press **Select** for checkboxes. The bulk bar flags, tags, pins, archives or deletes in one go. Esc clears.
- Right-click on everything: chats, folders, project headings, tag chips, the Navigate row.

**To-do, linked to where the work is**
- Say it in any chat: "we've got this, this and this to do". The agent's `workspace_todo` tool records one item per thing, linked to that chat.
- Open the **To-do panel** on the right from the header button or **⌘⇧D**. Scopes: *This chat*, *this folder* (or project), *Everything*. Paste a list to add several at once; click the mark to tick an item off; right-click to move, link to this chat or folder, rename or delete.
- Folders in the rail show how many items are open inside them.
- The **Board** (sidebar, *Board*) has four columns, *To do*, *Doing*, *Check*, *Done*, and moves on real signals rather than agents' self-reports: a linked chat that starts working moves its item to *Doing*; when every linked chat has finished it goes to *Check*. Nothing is ever moved to *Done* for you. Drag cards to override.
- Storage is bb's own **Tasks** plugin, so `bb tasks` and agents keep working. Each bb project gets a tracker project (for example `NAV`) the first time you add an item.

**Voice agent (Savvy)**: press **Talk** in a chat header (or ⌘⇧E) and speak. Savvy, an ElevenLabs agent on Eleven v4 Turbo, turns what you say into a clear prompt and sends it to the harness in the open chat, reads its status or last reply when you ask, stops it, or adds to-dos. When a harness finishes, Savvy tells you in a few sentences what was done, what's left and whether it needs you. The Voice tab on the right keeps the transcript. Needs an ElevenLabs API key (plugin setting, or `~/.elevenlabs/api_key`); the key stays on the bb server, which creates the agent once and hands the window short-lived session tokens. ElevenLabs bills the conversation minutes and the small model inside the agent (Gemini 2.5 Flash by default) to your ElevenLabs account; the real work stays in your harness.

**Control room** on the new-thread screen: running, needs you, unread and parked across every harness as counting tiles, a split bar per harness, what needs you, and the three Macs with their CPU and memory now. Pick a Mac and **New work** starts there or lets Auto choose.

**Usage dock** under the chat box (replaces bb's context ring): a comet-dial context gauge with the auto-compact point, plus the plan windows of the subscription this chat actually runs on. With bb's Account Pooler it follows the pooled account; otherwise it reads the local login. Hover the line for a moment (or focus it and press Enter) for the **usage card**: the session and weekly windows (monthly for Cursor) with charts since each window opened, a straight-line forecast to the reset with 75% and 90% marks and a warning when it would cross 90%, burn rate over the last 30 minutes, time to the limit, and the busiest chats by share of tokens. Tabs switch between every Claude, ChatGPT and Cursor account. A background service samples each account every 3 minutes from cached readings only (Cursor every 15), keeping 14 days.

The always-on Mac's chip in the row under the chat box (its label is the machine's name in your profile), to move a chat to the always-on Mac and back. It appears only when your profile has an always-on machine and a hand-over helper:
- **Move this chat to the always-on Mac** stops the chat here and pushes the work, then starts the chat again on the always-on Mac, a machine of this bb, from a brief of the conversation. It links the two chats and archives this one, which you can restore. bb cannot fork a chat across machines, so the always-on Mac chat starts from the brief, not the full history. In a git repo it pushes the current branch. With uncommitted changes it asks first: **Carry them over** makes a WIP commit on `teleport/<chat>` from a temporary index, so your branch (main included) and working tree do not move, and the always-on Mac works in a fresh worktree from that ref. A NAS project needs no git step, because both Macs see the same files. When the project has no checkout on the always-on Mac, it falls back to the brief handoff to its own bb, and says so.
- **Bring it back to the laptop** (on a chat running on the always-on Mac): pushes its work to the same `teleport/` branch, restores the laptop chat with what happened there, then archives the always-on Mac chat.
- **Only send the always-on Mac a brief** is the earlier hand-over: it writes a handoff brief and sends it to that Mac's own bb, with a Watch link in the toast. The chat stays here, and once the work is there the chip shows the always-on Mac in its status colour and opens its panel.

**Ask and Tell on a remote chat row**: hover a chat under another machine's tab and press the speech-bubble button, or right-click it. **Tell this chat** sends text into that chat through Fleet's `thread_tell`, with one request id per text so a retry after a lost reply cannot send twice; **Read latest answer** shows its newest reply. **Ask** starts a new chat on that Mac in the row's project (Fleet's `work_start`) and **Read the answer** fetches the result by its receipt. Nothing reads on a timer. A Fleet older than `thread_tell`, `thread_output_get` and `receipt_result` answers that it does not offer them; the box then says so, keeps your text and offers **Open on** that machine.

**Run on** chip for the always-on Mac on the new-thread screen: the always-on Mac is also a machine of this bb (enrolled under the machine name in your profile, with its own bb left untouched). The chip switches bb's machine picker to it, in the project's checkout there, so the next chat runs there but stays in this sidebar with its full history. When the project has no checkout on the always-on Mac yet, the chip offers to set one up at the matching path (the NAS share, or `~/Documents/GitHub/<repo>` under that Mac's home). Keep the laptop awake: it is the bb server the always-on Mac reports to, so while it sleeps that chat pauses.

**Send when sub-agents finish**, in the same row, appears only while the chat has running sub-agents (child chats). It takes what you typed out of the chat box and holds it, then sends it to the chat once every sub-agent has finished. A pill shows "Held · waiting for 3 sub-agents"; its cross cancels the hold and puts the text back in the chat box. Holds are kept on the bb server, so a reload or restart does not lose them. "Finished" follows bb's own status, so a sub-agent counts until bb shows it idle or stopped.

**Account chip** next to it (Claude and Codex chats, and the new-thread screen while a Claude or Codex model is picked): shows which Account Pooler account the chat runs on, for example "Claude · gmail" or "Codex · daniel". The menu lists that harness's accounts with weekly and session use, marks this chat's account and the one new chats go to, and lets you put any account first in that harness's failover order. The pool has no per-chat pin, so a running chat stays on its account and new chats stay on the pool's current account until it hits its limit; the chip never moves a chat or bypasses the pool.

**`::nav-chart`** directive for replies: `bars`, `stats`, `split` and `steps`. The bundled `navaigate-charts` skill tells agents how to use it.

**Light/dark toggle** in the sidebar footer.

**Theme**: the navaigate.dev palette, Inter and Inter Tight type, the 4px spacing grid, a pill-style reasoning picker, a voice pill on the mic and quick, quiet presses.

## Install

```sh
bb plugin install git:https://github.com/OWNER/bb-plugin-navaigate-skin.git@^0.30.0
bb theme set plugin:navaigate-skin:navaigate
bb settings ui set sidebar.threadListProvider '"navaigate-skin/rail"'
```

Recommended alongside: `project-folders` (folders) and bb's built-in Account Pooler (per-subscription usage). Without them the rail and dock still work; folders and pooled usage simply do not appear.

To go back to bb's own sidebar: Settings, Appearance, Sidebar.

## Charts in replies

```text
::nav-chart{kind="bars" title="Threads by harness" data="Claude:31,Codex:14,Cursor:4" unit="threads" highlight="Claude" note="Source: bb"}
::nav-chart{kind="stats" data="Running:2,Needs you:6,Parked:35"}
::nav-chart{kind="split" title="Where the week went" data="Build:14,Calls:6,Admin:3" unit="h"}
::nav-chart{kind="steps" title="Rollout" data="Theme:done,Rail:done,Dock:now,Publish:next"}
```

## Links and agent pipelines in replies

Two more renderers sit next to `::nav-chart`:

- `::nav-links{items="https://... https://..."}` turns a list of URLs into cards in each platform's own colour (LinkedIn blue, YouTube red, X and Threads black, GitHub, and more).
- `::nav-pipeline{layers="Lead|plans|orange ; Worker|edits|blue , Explorer|reads|blue" side="Advisor|watches|plum" log="23:51 Worker|tests failed"}` draws an agent stack with connectors and a session log.

The bundled `navaigate-charts` skill teaches agents all three.

## Agents panel (⌘⇧A)

A right-hand panel in every chat. **This run** maps the chat and every sub-agent under it, live, with a session log of status changes. **Your agents** lists every agent defined in `~/.claude/agents`, grouped like a crew: chief of staff, leads, teams that share a name prefix, then specialists (a `group:` line in an agent's front matter overrides this). Picking one puts it on the model its file pins, and leads default to running in their own chat so they can start sub-agents of their own. Pick a role preset or one of your agents, choose the harness and model with bb's own picker, write the task, and **Spin up** starts it as a child of the chat in the same workspace.

## Home

A front page inside bb (sidebar, Home; or click the N mark in the rail's top card):

- **The NavAIgate mark.** The N on a flat disc; a thin blue arc turns round it while agents work, and rings ripple from it while Savvy listens or speaks. It also sits in the rail's top card, and in bb's sidebar header if you pick "NavAIgate" under Settings, Appearance.
- **Brief.** One line from your latest daily brief, and a button to run today's on demand.
- **Ask.** Type what you want done and it starts a real bb chat. Pick Claude, Codex or Cursor, or name one in the text ("ask Codex to…"), and that choice is binding. On **Auto**, Jev routes it in one request (real work or a quick question, which worker, how much effort): at 0.6 or above it starts straight away, below that it asks you to confirm, and if Jev is down it falls back to Claude Code. The last five decisions and how often you overrode Jev show under the box.
- **At a glance.** Running, needs you, unread and parked as tiles that count up when the page opens.
- **Machines.** Every machine in your profile, from Fleet, with what runs on each and their CPU and memory now (Fleet keeps no history, so there is no load chart). The card reads the same board as the rail, so it adds no extra requests. Pick one and **New work** starts native work there or lets Auto choose.
- **Usage.** One glass sphere of liquid for each subscription (Claude, Codex, Cursor), under the stat tiles. It is filled to what is left of the week (the month for Cursor), or to what is used if you switch to **Used**, and a plan read on two machines is one sphere. Hover or tap a sphere and the panel under the row gives its burn rate (percent an hour over the last 30 minutes), when it runs out at that rate, and every window it has. A subscription in use burns: flames rise round its sphere and grow with the burn rate. Cross a sphere with the pointer and the liquid tilts; press it and it sloshes. A settled sphere stops drawing, and under Reduce motion each one is a single still frame.
- **Allowance.** One account at a time (Claude and Codex through the Account Pooler, Cursor through its own usage API): this week's figure (this month for Cursor), the session beside it, and a bar for each of the last 14 daily peaks, red from 85%. Hover a bar for its day. Each account in the switcher shows the start of its email address, and a red dot with "high use" (85% or more) or "plan advice" marks any account that needs a look, whichever one is selected.
- **Usage window.** The same account's session or week since it opened, drawn from the usage samples, with dashes at 75% and 90% and the forecast at the reset.
- **Recent chats and Chats started.** The latest chats with their state, or only the ones that need you, and a grid of chats started per day over the last 18 weeks.
- **Plan advice.** The plugin keeps a daily peak per account and, after 14 days, says when a cheaper plan would have covered you or when an account is near its ceiling. The Allowance card lists the advice for every account, not just the one shown. Correct a wrongly reported plan under **Plan tiers** in settings.
- **Motion.** Cards rise in a short stagger, figures fade when they change, bars rise and charts wipe in, and cells pop in a scattered order. One ease throughout, and all of it stops under Reduce motion. Only live things loop.
- **Agenda.** Today and tomorrow from every Google Calendar connected in Composio (key in `~/.config/navaigate/composio.env`), duplicates across calendars merged, what's on now in blue.
- **Inbox.** Mail from the last 7 days across every Gmail account connected in Composio (read-only), triaged by Jev (TypeSafe, key in `~/.config/navaigate/typesafe-ai.env`): needs a reply, urgency, venture and who should answer. **Hand to agent** starts a chat that drafts a reply in your voice, draft only, never sent.
- **Sort all with Jev.** The Inbox button forgets every triage and runs Jev again over the last 7 days, with progress on the button.
- **Social.** Your Blotato accounts, the queue and the last eight published posts with views and likes where Blotato has them (LinkedIn gives none), read-only with the key from the Blotato MCP entry in `~/.claude.json`. **Draft a post** starts a chat that drafts in your voice and asks before anything is published.
- **Audience.** A card per platform for YouTube subscribers and Instagram, X and LinkedIn followers, from public sources only: the YouTube channel page, and the public Instagram, X and LinkedIn profiles read in a throwaway headless Chrome (a fresh profile each time, never your own browser or a login). Linked profiles go in **Link profile**. Counts refresh every six hours; if a live read fails, the card shows the last reading with its date, and with none it says there is no live number. A daily snapshot gives the change over 7 days.
- **Money.** Qonto balances, this month in and out, and recent transactions, read-only, once you add a Qonto API login and secret key in settings.
- **Several companies.** Each Qonto organisation is grouped under its own label, accounts connected inside Qonto (such as Revolut) included, with a combined total in EUR. The login and secret key above are NavAIgate GmbH & Co. KG; add more in **More Qonto organisations** as `Label|login|secret`, one per line.

## Inbox

All your mail from the last 7 days (or 30) across every active Gmail account in Composio, read-only, on one page: a header with the Gmail logo and an account switcher, a rail with Inbox, Starred and Sent, and the Jev piles with their counts. Rows show the sender (with a real logo for Skool, YouTube, Google Calendar, Stripe, Vercel, Notion, OpenRouter, GitHub, LinkedIn, Qonto and Calendly), the company or domain, the subject, the snippet and the time.

- **Sort with Jev.** One press asks Jev about every email, eight at a time: one Choice for the pile (Reply today, Clients & leads, Partners & sponsors, Billing & receipts, Community (Skool), Social & notifications, Newsletters, FYI, Spam) plus the needs-a-reply and written-by-a-person questions and an urgency score. "Reply today" is a rule in code: a person asks you for something, soon. While Jev works the counter ticks, a gold line sweeps under the banner and each row shakes as its answer comes in; then the emails fire out of the list into their buckets on a do-do-do beat, the buckets catch them and count up, and the banner shows the real time and cost of the run (Jev's input tokens at its published price).
- **Remembered.** Each email's answers are kept for 14 days, so the next sort only asks about new mail ("12 new, 491 remembered"). **Re-sort all** forgets them and asks again. Every run (count, time, cost, model) is recorded and the last one shows in the banner.
- **Why Jev put it here.** Click any email for the full text (as plain text, fetched only when you open it), the pile with Jev's probabilities, and the answers behind Reply today. **Hand to agent** starts a chat that drafts a reply in your voice as the emailer agent (drafts only, never sends); **Open in Gmail** opens the thread.
- **List and Piles.** Switch back and forth; the rows move to their new places. Reduced motion skips straight to the result. Optional soft sound for the sort, off by default.
- **Read-only.** The page never sends, labels, archives, moves, marks read or deletes anything in Gmail. The Home Inbox card links here with **Open inbox**.

## Calendar

A month view (Monday to Sunday) of both Google Calendars connected in Composio, duplicates merged, with a day panel for the selected day and Today, previous and next. **Ask about your calendar** starts a chat with the relevant events pasted in ("Prepare for my next meeting", "What does my week look like?", "Check for scheduling clashes"), routed through Ask. Booking links list your Calendly event types once Calendly is connected (Composio or `~/.config/navaigate/calendly.env`).

## Dashboard

Run any local web app (your own operating-system dashboard, a dev server, a monitoring page) and show it as a page inside bb. Add it in the plugin settings under **Dashboards**, one per line as `Name|URL`, for example `My OS|http://localhost:8081`. Each one gets a tab, with Reload and Open in browser. Nothing is bundled: the app keeps running on its own and bb only shows it.

## Features guide

A page that lists every feature from the video and the four extras: its plain name, a one-line description, its status (Live, Partly live with what is missing, or Blocked with the reason), exactly where to click, and a **Show me** button that opens the right page where one exists. Open it from the sidebar footer (the list icon) or the command menu (**Workspace: features guide**). The data is `src/features-guide-data.ts`, generated by `node scripts/build-features-guide.mjs` from `features/map.json`, `features/descriptions.tsv` and `features/show-me.json`; it needs no network. Edit those three files, run the script, and the test `tests/native-features-guide.test.tsx` fails if the generated file is out of date.

## Develop

```sh
npm install
bb plugin install .        # path install, live from this folder
bb plugin dev              # rebuild and reload on save
npx tsc --noEmit -p .      # typecheck
```

Layout: `app.tsx` registers the surfaces; `src/rail.tsx` (sidebar), `src/control-room.tsx`, `src/usage-dock.tsx` and `src/usage-card.tsx` (with `server-usage-trend.ts`, the sampler), `src/chart.tsx`, `src/tags.tsx`, `src/bulk-bar.tsx`, `src/status-mark.tsx`; `server.ts` holds the synced rail state, the to-do RPCs, the `workspace_todo` agent tool and the read-only Account Pooler lookup; `server-todo.ts` is the to-do engine on bb Tasks; `src/todo.tsx` the panel and Board; `themes/navaigate.css` is the palette and micro-interactions.

## Credits

Loader, status mark, comet dial, reasoning picker and voice pill are original re-implementations inspired by components from [React Bits](https://reactbits.dev) by David Haz. Platform logos are the official marks from [Simple Icons](https://simpleicons.org) (CC0), embedded as paths. Built by NavAIgate.

## Native models and machine placement (0.34)

Requires BB 0.48 / SDK 0.6.94. Use **Models** beside the active native composer or in the thread header:

- **Next reply** changes provider, model, reasoning and supported service tier. A provider change preserves BB's native draft, mentions and uploads, and automatically supplies a recent text snapshot from the source conversation. The host limits contributed instructions to 4,096 characters; the native source-thread reference remains available for older history. Only user and assistant text is included, with tool/reasoning/system material excluded. Its physical provider session is grouped under the visible conversation after durable association. Each provider retains its own context; private provider state is not transferred.
- **Add a model alongside** gives another native session an independent task. The current model keeps working. Git work defaults to a separate managed worktree. The Models list switches the active session; **Conversation** shows native read-only history. A continuation uses BB's native full chat/composer, stream, stop and queue controls.
- Parallel sessions are top-level threads with plugin metadata, not core children. Deleting the logical root reveals surviving sessions. Association errors leave an accessible native thread. `bb thread list --include-hidden --json` is the recovery inventory if the plugin is disabled.
- **Where it runs** offers This Mac, Auto and each machine in your profile for new work. Remote execution carries the actual provider/model/effort/tier and supported workspace/base-branch intent. Auto checks independent owner freshness, project/provider/capability eligibility and CPU/RAM; running work stays with its owner. A workload tied to a machine in your profile is eligible only for that machine.
- Fleet 0.2 is required for remote work and writable owner-routed mirrors. The always-on machine's SSH alias in your profile is a broker-independent route to its own BB. A connected enrolled machine is displayed separately from a live independent owner.
- Remote requests have stable durable receipts. **Check again** reads the original receipt; it never creates another job. Accepted work remains accepted even if local grouping fails. The destination project must exist there; `NavAIgate (away)` maps to the canonical `NavAIgate` project.

Remote files/uploads, provider-specific session options, scheduled sends and custom/reused environment IDs cannot yet be transferred; unsupported selections are refused before starting and the draft is retained. Remote context is a bounded text snapshot with explicit source identity and file-transfer limitations. A remote owner's provider cannot be replaced through a local mirror picker; start another model alongside it instead. Remote pending interactions still require the owning BB. A restricted machine requires a working authenticated Fleet relay; account visibility alone is not dispatch proof.

The conversation overlay is scoped to one unambiguous split pane and restores the original native view on disposal or an error. A different workspace opens its physical member route so BB's native files, diff and terminal follow the active model. A remote mirror explicitly labels its local workspace. The root uses its original native composer; the history panel never mounts another writable composer for it. Builds, fake-host regressions and actual host checks are separate acceptance steps.

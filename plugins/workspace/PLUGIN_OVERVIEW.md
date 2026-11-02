## What you get

**Home, Inbox and Calendar.** A front page with your daily brief, an Ask box that Jev routes to the right harness, today's calendar, mail that needs a reply and your subscription use. The Inbox reads every Gmail account you connect through Composio, read-only, and Jev sorts each email into a pile; Hand to agent drafts a reply but never sends it. A first-run Set up page asks for your name, your areas of work and your own keys.

**Hand work to an always-on machine.** Right-click a chat to send it to a home Mac, mini PC or VPS running its own bb, and watch it there from a panel in the chat. If you also add that machine to this bb (Settings, Machines, same name as in Set up), a chip under the chat box starts new chats on it, and another moves a running chat there and back: it stops the chat here, pushes the work to git (uncommitted changes go on a separate WIP branch only if you say so), and starts it again there from a brief of the conversation, because bb cannot copy a chat between machines.

**A sidebar that reads like a run sheet.** A NOW card at the top shows what is working right now, with a small lattice that orbits while a chat cooks, and how many chats need you. Every chat carries the name of the harness it runs on (Claude, Codex, Cursor and any other provider), and one click filters to a single harness. Beside those filters sit your own tags: create one with **+ Tag**, pick a colour, right-click to rename or delete.

**Come back later.** Flag any chat as *revisit*, *done, check it* or *has a mistake*. Flagged chats move to their own section with an animated status mark, so they cannot be missed.

**Folders and sections you arrange.** With the Projects & Sections plugin installed, each project shows its real folders on disk. Make new ones, add existing folders from the drive, drag chats into folders, and make folders inside folders. Guide lines show what sits inside what, and turn gold while something in that branch is working. Groups hold whole projects (and other groups): they live only in the rail, so nothing moves on disk. Click a section heading to fold it, drag a heading to reorder or into a group; the order is kept on your bb server, so every window shows the same layout.

**Tabs across the top.** Every chat you open becomes a tab. Hover one to see its full title, state, harness and last activity, drag to reorder, and Cmd-click to open it beside the one you have open.

**Hold a message for sub-agents.** While a chat has sub-agents working, "Send when sub-agents finish" takes what you typed and sends it only once they have all finished. The hold survives a reload, and the cross on it puts the text back in the chat box.

**The Claude account a chat runs on.** With bb's Account Pooler, a chip under the chat box shows which Claude account the chat uses, each account's weekly and session use, and lets you put an account first in the failover order.

**A to-do list where the work is.** Tell an agent "we've got this, this and this to do" and its `workspace_todo` tool records one item per thing, linked to that chat. Open the to-do panel on the right with the header button or Cmd-Shift-D and switch between this chat, its folder and everything. Paste a list to add several items at once; tick an item off from its mark.

**A Board that moves on its own.** Four columns: To do, Doing, Check, Done. When a linked chat starts working, its item moves to Doing; when every linked chat has finished, it moves to Check for you to look at. Nothing is ever moved to Done for you, and you can drag any card to override.

**Full access.** Every chat the plugin starts for you (Home, Inbox, Calendar, Agents) runs in Full access, so it does not stop to ask for permission.

**A usage dock under the chat box.** A comet-dial gauge for context used, the point where auto-compaction starts, and the plan windows of the account the chat actually runs on.

**Charts in replies.** Agents can write `::nav-chart{kind="bars" data="Claude:31,Codex:14"}` and the reply shows a real chart. Kinds: bars, stats, split and steps. A bundled skill tells agents how to use it.

**A warm light and dark theme** with a toggle in the sidebar footer, plus small touches on bb's own controls: a pill-style reasoning picker and springy button presses.

## Requirements

- bb 0.44 or later, including bb 0.46 (which removed the sidebar-header slot; the NavAIgate sidebar mark simply does not appear there).
- Your own API keys for the services you want (Composio for mail and calendar, TypeSafe for Jev, ElevenLabs for voice, Calendly, Blotato), entered in the Set up page. Each service bills you directly.
- Folders need the Projects & Sections plugin. To-do items are stored in bb's built-in Tasks plugin, so `bb tasks` keeps working. Per-account usage needs bb's Account Pooler; without it the dock reads the provider's own login.
- Every part degrades on its own: if one of those plugins is missing, the rest of the plugin keeps working.

## Data and permissions

- To read the to-do list and which pooled account a chat runs on, the plugin opens the Tasks and Account Pooler databases on your machine read-only. All writes go through those plugins' own APIs (the account chip uses `bb pool account reorder`).
- Held messages and the link between a moved chat and its original live in bb's plugin storage and the chat's plugin metadata.
- Tags, flags and section order are stored in bb's plugin storage on your bb server.
- The theme loads IBM Plex and Fraunces from Google Fonts. Nothing else leaves your machine.

Part of the NavAIgate Console by NavAIgate: https://github.com/skyremote/navaigate-console. Free to use for yourself and your business under the PolyForm Internal Use licence; not for redistribution.

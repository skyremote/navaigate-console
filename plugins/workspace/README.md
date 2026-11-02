# NavAIgate Workspace for bb

Part of [NavAIgate Console](https://github.com/skyremote/navaigate-console) by [NavAIgate](https://navaigate.dev). Install, set-up and licence details are in the repository's main README.

## Surfaces

| Surface | Where |
| --- | --- |
| Home, Inbox, Calendar, Board, Dashboard, Set up | Sidebar pages |
| The rail (NOW card, harness filter, tags, folders and folders inside folders, groups of projects, Come back later, bulk actions) | Thread list, chosen in Settings, Appearance |
| To-do, Agents, Voice, On your machine | Right-hand panels in any chat |
| Usage dock, new-thread hero with home/away chip, tab strip of open chats | Overlays |
| Chips under the chat box: Send when sub-agents finish, Run on / Move to your always-on machine, Claude account | Overlay plus an invisible composer action |
| `workspace_todo` | Agent tool |
| `::nav-chart`, `::nav-links`, `::nav-pipeline` | Chat directives (skill: `navaigate-charts`) |
| `always-on` | Skill and script for the always-on machine |
| NavAIgate | Theme |

## Your settings

`~/.config/navaigate-workspace/profile.json` (name, areas, machine, storage) and `keys.env` (your API keys, mode 600), written by Set up. The `always-on` script reads the same files. Plugin settings (bb Settings, Installed plugins) hold the voice options, dashboards, plan tiers and audience links.

## Optional companions

- Folders in the rail need the [Projects & Sections](https://github.com/VKirill/bb-plugin-project-folders) plugin.
- To-dos are stored in bb's built-in Tasks plugin.
- Per-account usage and the Claude account chip read bb's built-in Account Pooler when it is on. The chip hides when the pool has no Claude accounts.
- "Run on" and "Move to" your always-on machine need that machine added in bb under Settings, Machines, with the same name you gave it in Set up. Without it, only "Send to my always-on machine" (a brief to its own bb) is offered, and with no always-on machine at all every machine control hides.

Every part degrades on its own: a missing key or companion plugin empties that card and leaves the rest working.

## Data

Your mail and calendar are read through your own Composio account, read-only. Jev, ElevenLabs, Calendly and Blotato are called with your own keys. The theme loads IBM Plex and Fraunces from Google Fonts. Nothing is sent to NavAIgate.

Licence: PolyForm Internal Use 1.0.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

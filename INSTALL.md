# Install BB Overlay 1.12: the NavAIgate Console

You need **bb 0.48 or later** on macOS or Linux, open and signed in to your chosen AI harness (Claude Code, Codex or Cursor).

## What you are installing

The **Console** is the sidebar and Home page for bb, with a **Setup** screen where you tick the features you want. **Simple** and **Pro** are two starting presets for those tick boxes, not separate products.

Both presets come with Helper Desk, Cache Clock, Reflect, Screen Share, the Markdown plugin (live Markdown in the chat box with a Preview tab) and the guided tour. **Pro** also installs Fleet, Prompt Stack, Kanban, Finder Links and the optional Projects & Sections, Agent Board and Tasks.

Fleet needs a second Mac running bb and a brain. On a single Mac it stays hidden, and that is expected.

For a fresh Simple preset:

```sh
curl -fsSL https://raw.githubusercontent.com/skyremote/bb-overlay/main/install.sh | bash
```

For a fresh Pro preset:

```sh
curl -fsSL https://raw.githubusercontent.com/skyremote/bb-overlay/main/install.sh | bash -s -- --edition pro
```

To look at the commands first, add `--dry-run`. Use `--no-look` to leave your theme, navigation and thread-list settings alone, or `--no-mods` to leave out the helper plugins. Read [install.sh](install.sh) before running it if you prefer. No installer path uninstalls a plugin.

## After the install

Reload bb with **Cmd-R** on Mac or **Ctrl-R** on Linux.

1. The Console opens its **Setup** screen. Give your name, add other Macs if you have them, and tick the features you want. The preset you chose is where the boxes start. A box that needs something you have not added (a second Mac, a public address, a brain) says what it needs. You can open Setup again from Settings.
2. The guide offers to start once. Each step needs an explicit **I've read this** before you can continue. Closing pauses the guide, and progress is saved on your bb server. Replay from **Settings, Plugins, BB Overlay guide** or the command palette (**BB Overlay guide: open or resume** and **BB Overlay guide: replay**). Missing controls are explained rather than pointed at wrongly.

## Already on 1.11 Simple or Pro?

Run the same command. Your setup stays exactly as it is, and the installer prints one line about `--console`. To move to the Console:

```sh
curl -fsSL https://raw.githubusercontent.com/skyremote/bb-overlay/main/install.sh | bash -s -- --console
```

It saves your current thread list, navigation and theme, installs the Console and reloads it, and only then switches the look and turns your old core off. If a step fails it restores your previous settings and leaves the old core running. Nothing is uninstalled and no data is deleted. To go back, enable the old core (`bb plugin enable navaigate-simple` or `navaigate-workspace`) and choose its thread list and theme in **Settings, Appearance** (the values saved in `~/.config/bb-overlay/before-console` show what you had; nothing reads them back).

A `navaigate-skin` you installed from another source (a local path, say) is never replaced, reconfigured or given a preset.

## Prompt Stack's Claude Code hook

Prompt Stack works through a small Claude Code hook. The installer never changes `~/.claude/settings.json`. With `--edition pro` it prints the command that adds the hook (`plugins/prompt-stack/claude-plugin/install-hook.sh`). That script saves a dated backup of `settings.json` first, adds one entry, and does nothing if the entry is already there. `--remove` takes it out again.

## The brain (optional)

The brain kit is in `extras/brain-selfhost-kit` in this repository. The installer installs nothing for it. When your brain is running, put its address into the Console's Setup screen, together with the name of the bb secret or environment variable that holds its token (never the token itself).

## Appearance and optional tools

A fresh install selects **Navigation: Rail**, **Thread list: NavAIgate rail** and the NavAIgate theme. These are separate settings under **Settings, Appearance**. An existing installation keeps its saved values.

Cache Clock is useful for applicable Claude chats. Screen Share has specific matching coverage, so preview before sharing. Nothing here implies universal privacy protection or a particular provider's cache guarantee. Projects & Sections is pinned to 0.6.19 for standard bb; existing versions are not removed or downgraded, and disabled plugins stay disabled on an ordinary update.

## If the guide does not appear

- Reload bb, then open or resume it from its plugin Settings section.
- A paused or completed guide does not pop up again on each update. Choose **Replay** to start it again.
- If you deliberately disabled `bb-overlay-guide`, enable it in Plugins first.
- Update bb if the installer says your version is too old.

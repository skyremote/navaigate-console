# Install the NavAIgate Console 1.14

You need **bb 0.48 or later** on macOS or Linux, open and signed in to your chosen AI harness (Claude Code, Codex or Cursor).

## What you are installing

The **Console** is the sidebar and Home page for bb, with a **Setup** screen where you tick the features you want. **Simple** and **Pro** are two starting presets for those tick boxes, not separate products.

Both presets come with Helper Desk, Cache Clock, Reflect, Screen Share, the Markdown plugin (live Markdown in the chat box with a Preview tab) and the guided tour. **Pro** also installs Fleet, Prompt Stack, Kanban, Finder Links and the optional Projects & Sections, Agent Board and Tasks.

Fleet needs a second Mac running bb and a brain. On a single Mac it stays hidden, and that is expected.

For a fresh Simple preset:

```sh
curl -fsSL https://raw.githubusercontent.com/skyremote/navaigate-console/main/install.sh | bash
```

For a fresh Pro preset:

```sh
curl -fsSL https://raw.githubusercontent.com/skyremote/navaigate-console/main/install.sh | bash -s -- --edition pro
```

To look at the commands first, add `--dry-run`. Use `--no-look` to leave your theme, navigation and thread-list settings alone, or `--no-mods` to leave out the helper plugins. Read [install.sh](install.sh) before running it if you prefer. No installer path uninstalls a plugin.

## After the install

Reload bb with **Cmd-R** on Mac or **Ctrl-R** on Linux.

1. The Console opens its **Setup** screen. Give your name, add other Macs if you have them, and tick the features you want. The preset you chose is where the boxes start. A box that needs something you have not added (a second Mac, a public address, a brain) says what it needs. You can open Setup again from Settings.
2. The guide offers to start once. Each step needs an explicit **I've read this** before you can continue. Closing pauses the guide, and progress is saved on your bb server. Replay from **Settings, Plugins, BB Overlay guide** or the command palette (**BB Overlay guide: open or resume** and **BB Overlay guide: replay**). Missing controls are explained rather than pointed at wrongly.

## Already on 1.11 Simple or Pro?

Run the same command. Your setup stays exactly as it is, and the installer prints one line about `--console`. To move to the Console:

```sh
curl -fsSL https://raw.githubusercontent.com/skyremote/navaigate-console/main/install.sh | bash -s -- --console
```

It saves your current thread list, navigation and theme, installs the Console and reloads it, and only then switches the look and turns your old core off. If a step fails it restores your previous settings and leaves the old core running. Nothing is uninstalled and no data is deleted. To go back, enable the old core (`bb plugin enable navaigate-simple` or `navaigate-workspace`) and choose its thread list and theme in **Settings, Appearance** (the values saved in `~/.config/bb-overlay/before-console` show what you had; nothing reads them back).

A `navaigate-skin` you installed from another source (a local path, say) is never replaced, reconfigured or given a preset.

## Prompt Stack's Claude Code hook

Prompt Stack works through a small Claude Code hook. The installer never changes `~/.claude/settings.json`. With `--edition pro` it prints the command that adds the hook (`plugins/prompt-stack/claude-plugin/install-hook.sh`). That script saves a dated backup of `settings.json` first, adds one entry, and does nothing if the entry is already there. `--remove` takes it out again.

## The brain (optional)

The brain kit is in `extras/brain-selfhost-kit` in this repository. The installer installs nothing for it. When your brain is running, put its address into the Console's Setup screen, together with the name of the bb secret or environment variable that holds its token (never the token itself).

## Local models (optional)

The Console can start a chat on a model that runs on your own Mac, in Claude Code or in opencode, and in Claude Code it gets your own skills and agents too. Nothing is downloaded for you, so you install the runner and the model yourself, and the Console uses what's already there. There's a short page with pictures at [skyremote.github.io/navaigate-console/local-models.html](https://skyremote.github.io/navaigate-console/local-models.html).

### What you need

- **A runner:** [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai), on the same Mac as your bb.
- **opencode:** the list of models under the Local orb comes from bb's opencode harness, so install opencode and check it in bb's provider list, even if your chats run in Claude Code.
- **Claude Code** for Local chats on Claude Code.
- **A model:** the two we test with are in [Main models](#main-models) below.
- **Memory:** we tested on one 48 GB Apple silicon Mac, and the Qwen model needs about 21 GB while it's loaded. Smaller Macs and Windows aren't tested.

### Main models

These are the two models we test with. Both are "abliterated", which means their makers say they removed the model's refusals, and the Console only puts a padlock on them as a label, it doesn't change anything about the model.

**Qwen 3.8 27B abliterated** (Ollama, works in Claude Code and opencode, 18.3 GB on disk):

```sh
ollama pull hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:UD-Q4_K_XL
printf 'FROM hf.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:UD-Q4_K_XL\nPARAMETER num_ctx 65536\n' > Modelfile
ollama create qwen3.8-abliterated-64k:27b -f Modelfile
```

The first line downloads the model, and the other two make a copy with the 65,536-token window Claude Code needs, with no second download. Then pick `qwen3.8-abliterated-64k:27b` under the Local orb.

**DeepSeek R1 14B abliterated** (Ollama, a chat model in opencode only, 9.0 GB on disk):

```sh
ollama pull huihui_ai/deepseek-r1-abliterated:14b
printf 'FROM huihui_ai/deepseek-r1-abliterated:14b\nPARAMETER num_ctx 65536\n' > Modelfile
ollama create deepseek-r1-abliterated-64k:14b -f Modelfile
```

Claude Code isn't offered for DeepSeek R1 models, because two 14B versions didn't use tools dependably in our tests, and we haven't tried other versions.

**LM Studio:** the model we tested there is the standard `qwen/qwen3.8-27b`, not the abliterated one. **Load** under the orb asks LM Studio for the 65,536-token window and one slot, and on a Mac with less than 40 GB of memory it refuses and says why.

### Start a Local chat

1. In **Setup**, tick **Online or Local on the new-chat screen** and save. That switches the two orbs on, and Local chats on Claude Code come with it, unless you saved Setup with them off.
2. Open a new chat, pick the **Local** orb, pick your model under it, and choose **Claude Code** or **opencode**.
3. Under the orb you'll see **Not in memory** with a **Load** button, or **In memory** with the size and an **Unload** button. If you don't press Load, your first message loads the model by itself.
4. Type your message and send it.

A Local chat on Claude Code starts in **Accept Edits**, so edits inside the chat's folder go through and anything outside it asks you once, and Approve for me isn't used for Local chats. If the runner is off, the chat tells you so.

### The Local loadout

The line under the orb says how many of your skills and agents a Local chat gets and how many tokens the chat starts with, and **Change** opens the Local loadout, which is a tick list of your skills and agents.

- By default every skill is ticked except the ones that are too large (a skill whose own text is over a third of the room), and agents are unticked.
- A skill costs about 6 tokens to list by name, and its own text is only read when the model uses it. A ticked agent is listed in full in every first prompt.
- The bar shows how much room is left before Claude Code starts to shorten the chat, which is at 44,344 tokens of a 65,536-token window.
- **Most used** ticks up to 20 of the skills it finds most often in your Claude Code chats on this Mac from the last 30 days, not counting Local chats. It only ticks boxes, and **Save** applies them.
- Twelve Claude Code tools a Local chat doesn't need are left out by default, so Claude Code's own start is about 8,500 tokens instead of about 18,800, and one option brings them back.
- In your first Local chat the Console measures bb's part of the start, and the tick list uses that figure from then on.

### Speed

On one 48 GB Apple silicon Mac, on a clean, standard bb 0.49 with Qwen 3.8 27B abliterated on Ollama and 8 small test skills, a new chat started at about 14,600 tokens, the first words came after 72 to 73 seconds with the model not in memory, and the first words of a follow-up came after 2 to 3 seconds. On 1.13.0 a chat in the same project started at about 25,800 tokens. So plan on about a minute to a minute and a half to the first words of a new chat, and then follow-ups in a few seconds.

In opencode there's no tick list, and opencode sends every skill in the first prompt, so on our own Mac a Local chat there took 12 minutes to answer with 180 skills.

### What stays on your Mac

"Runs on this Mac" describes the model. A Local chat reads only its own settings, and it doesn't read a project's CLAUDE.md or your main one, or a project's hooks or settings, but your ticked skills and agents still arrive. The chat's tools, web fetches and bb's own tools can still reach the network, and before a web fetch of a new site Claude Code asks Anthropic whether the site may be fetched (the site's name only). A fork of a Local chat stays Local. A few rare cases can still send a chat marked Local to a cloud account, and the Features guide inside the Console lists them. Settings an administrator manages for the Mac were not tested.

### Switch it off again

- To stop offering Local chats, untick **Online or Local on the new-chat screen** in **Setup**.
- To stop offering Claude Code for them, untick **Local chats on the Claude Code harness** in **Setup**.
- To free the memory, press **Unload** under the orb, or run `ollama stop <model>` or `lms unload <model>`.

### After an update from 1.13

- If you saved Setup on Console 1.13 with Local chats on the Claude Code harness unticked, as a fresh 1.13 install or a preset chosen there did, they stay off; tick them in Setup to use them. The Local orb says "Local chats on Claude Code are off in Setup." with a link to Setup.
- bb's plugin list still shows version 0.35.0 for the Console (`navaigate-skin`), because bb updates it by commit. The release number is in `RELEASE_SOURCES.json` and in the release notes.

## Google Antigravity (optional)

bb can run Google Antigravity as one more agent, next to Claude Code, Codex and Cursor, and that's how we get Google's models, Gemini 4 Neon included, into a bb chat. Nothing in the installer does this for you, so there's a small script for it in `extras/antigravity`.

### What you need

- **The Antigravity command line (`agy`)**, on the same machine as your bb. Get it from [antigravity.google](https://antigravity.google/product/antigravity-cli), or with Homebrew on a Mac: `brew install --cask antigravity-cli`.
- **A Google sign-in for Antigravity.** If you've signed in to the Antigravity app on that machine, the command line uses the same sign-in. If you haven't, run `agy acp --login` once.
- **bb 0.49 or later** is what we tested on.

### Add it to bb

From a copy of this repository:

```sh
bash extras/antigravity/add-to-bb.sh --dry-run   # shows the entry it would add and stops
bash extras/antigravity/add-to-bb.sh
```

The script adds one entry called Google Antigravity to bb's **Custom agents** setting (it belongs to bb's ACP providers plugin), and it keeps every custom agent you already have, which matters because setting that list by hand replaces all of it. On our Mac bb listed the models straight after, with no restart. The dry run shows the Antigravity entry and how many other agents you have, and never what's inside them, because an agent's entry can hold keys. If the entry is already there with the same `agy` and arguments that start with `acp`, the script changes nothing. Otherwise it points the entry at the `agy` it finds, puts the arguments back to `acp` if they don't start with it, and leaves the rest of the entry as you had it. It never installs anything or signs you in.

Then it lists the models bb can see, and you can ask again any time:

```sh
bb provider models acp-antigravity
```

Which models are in that list depends on your Google plan, so we can't promise Gemini 4 Neon on every account.

### Start a chat on it

bb now lists it with its other agents (`bb provider list` shows `acp-antigravity`), and this is the command we tested a chat with:

```sh
bb thread spawn --provider acp-antigravity --model gemini-4-neon --prompt "Say hello and tell me which model you are."
```

### What we tested, and what isn't there yet

On one Apple silicon Mac with bb 0.49.0 and the Antigravity command line 1.5.16, the script added the entry to a bb that had no custom agents, bb listed Gemini 4 Neon without a restart, and a test chat started with the command above answered from it. Keeping other custom agents is covered by the script's own tests against a stand-in bb, and we haven't run it on a real bb that already had other agents. We haven't tested Linux or Windows.

The Console's own screens don't offer Antigravity yet. Home still asks Claude, Codex or Cursor and the Online and Local orbs don't list it, and the command line is the only way we've tested starting a chat on it.

### Take it out again

Remove the `antigravity` entry from the **Custom agents** setting in the ACP providers plugin's settings. The Antigravity command line and your sign-in aren't touched.

## Appearance and optional tools

A fresh install selects **Navigation: Rail**, **Thread list: NavAIgate rail** and the NavAIgate theme. These are separate settings under **Settings, Appearance**. An existing installation keeps its saved values.

Cache Clock is useful for applicable Claude chats. Screen Share has specific matching coverage, so preview before sharing. Nothing here implies universal privacy protection or a particular provider's cache guarantee. Projects & Sections is pinned to 0.6.19 for standard bb; existing versions are not removed or downgraded, and disabled plugins stay disabled on an ordinary update.

## If the guide does not appear

- Reload bb, then open or resume it from its plugin Settings section.
- A paused or completed guide does not pop up again on each update. Choose **Replay** to start it again.
- If you deliberately disabled `bb-overlay-guide`, enable it in Plugins first.
- Update bb if the installer says your version is too old.

## If bb says "Could not start bb" right after an update

On Windows, bb installs a waiting update when it quits, and opening bb again before that install has finished starts it with only part of its files in place, so the server stops with "Could not start bb" and a "Daemon lock exists" line. Nothing is damaged. Close the error, wait 30 seconds and open bb again, and next time give bb a minute to reopen by itself after an update. Don't delete the lock file, because bb clears an old lock by itself.

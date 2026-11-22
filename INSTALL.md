# Install the NavAIgate Console 1.13

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

The Console can start a chat on a model that runs on your own Mac. You choose it on the new-chat screen with the **Local** orb. Nothing is downloaded for you: you install the runner and the model yourself, and the Console uses what is already there. A step-by-step page with screenshots is at [skyremote.github.io/navaigate-console/local-models.html](https://skyremote.github.io/navaigate-console/local-models.html).

### What you need

- **A runner:** [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai), running on the same Mac as your bb server.
- **opencode:** Local chats run through bb's opencode harness by default. Install opencode and check it in bb's provider list.
- **A downloaded model.** A model of about 27B parameters is what we tested.
- **Enough memory.** We tested on one 48 GB Apple Silicon Mac. A 27B Qwen model with a 65,536-token window used about 18 GB in LM Studio there. Macs with 24 to 32 GB are untested. 16 GB is not a target.

### Get a model ready

With Ollama:

```sh
ollama pull <model>
ollama run <model> "hello"
```

The first command downloads the model. The second checks that it answers. Replace `<model>` with the model's name from the Ollama library.

With LM Studio:

```sh
lms get <model>
lms server start
lms load <model>
```

The first command downloads the model. The second starts LM Studio's local server. The third loads the model into memory. In LM Studio's server settings, turn off **Require Authentication**, because Local chats do not send a token.

Run `opencode models` and check that your model appears with an `ollama/` or `lmstudio/` prefix. If it does not, add the runner to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio (local)",
      "options": { "baseURL": "http://localhost:1234/v1" },
      "models": { "<model>": { "name": "<model>" } }
    },
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "<model>": { "name": "<model>" } }
    }
  }
}
```

Use the model names exactly as `ollama list` or `lms ls` print them.

### Start a Local chat

1. Open **Setup** and check that **Online or Local on the new-chat screen** is ticked. The orbs only show while it is ticked. A fresh install with the Simple preset leaves it unticked. The Pro preset ticks it. If you finished Setup before 1.13, it is ticked after the update, because a new feature starts in its default.
2. If you want Local chats to run in Claude Code, also tick **Local chats on the Claude Code harness (experimental)**. Read [the section below](#local-chats-on-the-claude-code-harness-experimental) first.
3. Save Setup.
4. Open a new chat in bb.
5. Choose the **Local** orb.
6. Pick your model in the list under the orb. The list comes from bb's opencode harness: it shows the models opencode lists from Ollama and LM Studio, the ones whose names start with `ollama/` or `lmstudio/`. A model that Ollama reports as coming from its cloud is left out, and so is every Ollama model when `OLLAMA_HOST` points Ollama at another machine.
7. Type your message in the box below the orbs and send it.

The line under the chat box says **Local**, the model's name and **runs on this Mac**. If you switch an opencode chat to another model inside the chat, the line says the chat started Local and names the model it runs on now, or the model picked for its next reply. The chat gets a **Local** flag in the sidebar, and the sidebar and Control room can filter by it.

#### Your skill list and opencode

opencode sends your skill list to the model. opencode puts every skill in `~/.claude/skills` and `~/.agents/skills`, up to 200, into the first prompt of each new chat. On a clean standard bb with no skills, our Local chat through opencode used about 11,000 tokens and answered in about 4 minutes on a 48 GB Mac. With 200 skills on a larger setup, the first prompt was about 48,700 tokens, and three test chats gave no answer in 12 minutes while that Mac was busy with other work. From about 90 skills the Local orb shows a note with your count and an estimated size (about 11,000 tokens plus about 155 per skill; only 0 and 200 skills were measured). To shorten the first prompt, move skills you do not use out of those two folders. Your other Claude Code and agent chats stop seeing them too. The Console does not trim the list for you yet.

At 200 skills the note shows two sizes: the estimate (about 42,000 tokens) and the size measured with 200 skills on a larger setup (about 48,000 tokens).

To count your skills, run this in a terminal. The number is rough, because it counts every entry in both folders.

```sh
ls ~/.claude/skills ~/.agents/skills | wc -l
```

The memory row under the orb shows whether the model is in memory. **Load** loads it, **Unload** frees the memory, and **Stop** cancels a load. Keep one large model in memory at a time. For an LM Studio model, **Load** asks for a 65,536-token window. On a Mac with less than 40 GB of memory, **Load** refuses and says why. On those Macs, load the model in LM Studio with a smaller window and chat through opencode.

### Local chats on the Claude Code harness (experimental)

This runs Claude Code itself with the model on your Mac. It is off until you tick **Local chats on the Claude Code harness (experimental)** in **Setup**.

- **Window:** the model must run with a window of at least 65,536 tokens.
- **Tools:** the model must be able to call tools. The orb checks each model. A model that fails either check says why and runs in opencode instead.
- **Speed:** the first reply is slow, because the model reads Claude Code's start-up text first. In our test on standard bb 0.49 that first prompt was about 25,400 tokens.
  - On our own bb build, a new chat's first reply took about 2.5 to 4 minutes.
  - In our test on standard bb 0.49, with the Mac busy with other work, the first reply took about 12 minutes. The model needed more than 5 minutes to read the first prompt. A request with no reply after 5 minutes is sent again, so the first reply waited for those re-sends.
  - Follow-ups in the same sitting took 9 to 32 seconds.
  - A follow-up after the chat's session had closed took as long as a first reply.
  - Any Mac that needs more than 5 minutes to read the first prompt can see the long first reply. We have not fixed this yet.
- **Permission mode at the start:** the chat starts in **Accept Edits**, so it asks before it changes anything outside its own folder.
- **Full Access** only if you choose it. Pick it in bb's permission picker in the new-chat box, or set `"localPermissionMode": "full"` under `plugins.console` in your Console profile (`~/.config/navaigate-console/profile.json`).
- **Approve for me is not used at the start.** That mode checks every step with the same local model, one minute at a time. One small file write took 16 minutes. If you pick it in the box, the chat starts in Accept Edits, or in Full Access when that is your profile's choice.
- Switching modes later in the chat is up to you.
- Local chats in opencode, and Online chats, start in their usual mode.

To give an Ollama model the window, create a copy with a larger `num_ctx`:

```sh
printf 'FROM <model>\nPARAMETER num_ctx 65536\n' > Modelfile
ollama create <model>-64k -f Modelfile
```

Then pick `<model>-64k` under the Local orb.

For an LM Studio model, use **Load** under the orb on a Mac with 40 GB or more, or run:

```sh
lms load <model> --context-length 65536
```

### What stays on your Mac

"Runs on this Mac" describes the model, and only the model. A Local chat sends its prompts to a model in Ollama or LM Studio on this Mac, not to a Claude or Codex account. It does not mean the chat is cut off from the internet. The chat's tools, a project's own connectors, web fetches and bb's own tools (which can message other chats) can still reach the network.

- The label under the box only shows where the Console holds the chat to that model. On Claude Code, the launcher locks the model. In opencode, the Console checks the chat's current model. No other harness ever shows the label.
- A Local chat writes its own title on your Mac, so its first message is not sent to bb's title service.
- The Console leaves out a model Ollama reports as coming from its cloud (its own remote fields, or a `:cloud` or `-cloud` tag), and every Ollama model when `OLLAMA_HOST` points Ollama at another machine. That check has not been tried against a real cloud model. An opencode provider or runner pointed at another machine is outside it.
- A Local chat on Claude Code keeps its transcript on this Mac, in `~/.claude-local/config/projects`. That is apart from your main Claude Code history in `~/.claude/projects`, so tools that read the main history do not see Local chats. Like every chat, its messages are also kept in bb's own history on this Mac.

#### Forks, and chats a Local chat starts

- A fork of a Local chat on Claude Code, or a chat any Local chat starts on Claude Code (up to four steps down), is treated as the Local chat.
- With Local chats on Claude Code switched on, it runs on the same local model, whatever model was picked for it.
- With Local chats on Claude Code switched off, or on another machine, it does not start. bb shows an error saying a fork, or a chat started by a Local chat, stays on this Mac.
- A fork of a Local chat in opencode is different. bb keeps the fork in opencode on the same model, and the fork carries no Local label.
- For a Local chat on Claude Code, a fork the plugin misses cannot find the Local chat's history, so it fails instead of starting.
- Once the plugin knows any Local chat on this Mac, a Claude Code chat whose origin cannot be read is stopped for that one start, with a message to send again. An ordinary chat then starts on the next try.
- A chat on another harness that a Local chat started (a Codex agent, say) runs on its own model. It is never labelled Local.

#### When a chat marked Local can still reach a cloud account on its own

A Local chat in opencode is not itself sent to a Claude or Codex account by the Console. A chat it starts can be, in cases 1, 3 and 4 below.

For a Local chat on Claude Code (experimental), and for a Claude Code chat that any Local chat starts, there are exactly four cases:

1. The plugin is not loaded, or bb drops the plugin's settings after bb's 5-second limit, when the chat starts or restarts.
2. The chat's first start is on a machine other than the bb server's Mac, and its Local mark cannot be read.
3. A chat it started does not get held to the local model, in one of these ways: it begins while the plugin cannot read that chat's own mark; it begins while the plugin cannot read what started it and does not yet know any Local chat on this Mac; it is more than four steps down from the Local chat; or it runs on another harness, such as Codex.
4. Another plugin sets which claude program a chat runs before the Console does.

#### Labels that bb and other plugins show on a Local chat

- On the Claude Code harness, bb's own model box shows a cloud model name, such as "Opus 5.5", already on the new-chat screen.
- From the second message on, the sidebar and bb's record of the chat show that cloud model name too.
- The chat still runs on the local model. The Console's label under the box is the one to trust. Only bb can change its own labels.
- The **Cache Clock** card shows cloud cache prices and a **Keep warm** button on Local chats as well. They do not apply to a Local chat, which has no cloud cache. Do not press **Keep warm** on a Local chat.

#### Your own choices that take a Local chat's content elsewhere

bb keeps every chat's messages in its own history, Local chats included. A Local chat's content goes to another model or person if you do any of these:

- hand the chat over, or continue it in a new chat, on an online model;
- mention it with @ in an online chat;
- share messages from it through a guest review link;
- ask another chat to read it from bb's history;
- in opencode, switch the chat itself to an online model.

The Console refuses three things for a Local chat or a chat made from one, because each would carry the conversation away:

- moving it to another machine;
- starting new work on another Mac from it, when "Include conversation context" is on;
- giving its messages to a model started alongside it, or to a continuation.

### Switch it off again

- To stop offering Local chats, open **Setup** and untick **Online or Local on the new-chat screen**.
- To stop offering the Claude Code harness only, untick **Local chats on the Claude Code harness (experimental)** in **Setup**.
- To free the memory, press **Unload** under the Local orb, or run `ollama stop <model>` or `lms unload <model>`.
- Existing Local chats keep their flag. A Local chat on the Claude Code harness does not start while that feature is unticked: bb blocks it rather than send it to a cloud account. In our test on standard bb, the error for a continued chat said "no local route was given, so this chat does not start" rather than naming the Setup box.

### Which version you have

After the update, bb's plugin list still shows version 0.35.0 for the Console (`navaigate-skin`), because bb updates the Console by commit. The release number is in `RELEASE_SOURCES.json` in this repository and in the release notes.

### After an update from 1.12

We updated a test install that had finished Setup on the Simple preset and had a chat. This is what we saw:

- All seven plugins updated in place. Nothing was removed.
- Setup did not open again. Your saved Setup choices stay as they were.
- The new-chat screen shows the Online and Local orbs, with Online chosen.
- In Setup, **Online or Local on the new-chat screen** is ticked and **Local chats on the Claude Code harness (experimental)** is unticked.
- A chat you made on a local model before 1.13 has no Local mark. The sidebar counts it as Online.
- If you save Setup after the update, the preset name changes from "simple" to "custom". Your earlier ticks do not change.

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

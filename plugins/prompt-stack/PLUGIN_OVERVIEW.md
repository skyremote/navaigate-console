Tick which prompt-stack skills this thread uses, from the thread's side panel.

## What you get

- A **Prompt stack** action in the side panel's New tab list. One tick box per entry, with what it does and which skill it calls.
- Ticks save at once as this thread's override. **Use project default** removes the override.

## How it works

The panel reads and writes through the prompt-stack Claude Code plugin's CLI (`bin/prompt-stack`), run with `BB_THREAD_ID` set to the thread and `--cwd` set to its workspace. This plugin injects nothing: the prompt-stack hook does that inside each Claude Code thread.

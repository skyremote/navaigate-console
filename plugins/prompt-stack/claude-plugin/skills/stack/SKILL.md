---
name: stack
description: Show or change the prompt stack, the skills whose cards are injected beside every prompt (prove, spec, audit, maintain, voice, design, ship). Use for /stack, "stack prove and spec", "add voice to my stack", "what's on my stack", "drop design", "clear the stack", "stack this thread only".
---

# /stack

The CLI is `bin/prompt-stack`, two folders above this skill's base directory. Set it once:

```bash
PS="<base directory of this skill>/../../bin/prompt-stack"
[ -x "$PS" ] || PS="$(ls -d ~/.claude/plugins/cache/*/prompt-stack/*/bin/prompt-stack 2>/dev/null | tail -1)"
```

Map the request to one command, run it, and report the result line. Nothing else.

| Request | Command |
|---|---|
| `/stack` or "what's stacked" | `"$PS" show` |
| "what can I stack" | `"$PS" list` |
| `/stack add prove spec` | `"$PS" add prove spec` |
| `/stack drop voice` | `"$PS" drop voice` |
| `/stack set prove ship` | `"$PS" set prove ship` |
| `/stack clear` | `"$PS" clear` |
| any of the above "for this thread only" | add `--thread` |
| "what would it inject for X" | `"$PS" preview "X"` |

Scopes: the project stack is the default for every thread in this repo or folder. A thread stack (`--thread`, or the bb picker) replaces it for this thread only. `+id` or `-id` typed in a prompt changes that one prompt and is not saved.

If an id is unknown, run `"$PS" list` and suggest the nearest entry. To add a new entry, edit `stack.json` beside `bin/`: id, aliases, label, card (one paragraph), skill, brief_fields.

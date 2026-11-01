"""UserPromptSubmit: print the stacked cards beside the prompt.

Never blocks or fails a prompt: any error prints nothing and exits 0.
PROMPT_STACK=off skips it.
"""
import json
import os
import pathlib
import sys

if os.environ.get("PROMPT_STACK") == "off":
    sys.exit(0)

try:
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "lib"))
    import pstack

    data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
    prompt = data.get("prompt") or ""
    if prompt.lstrip().startswith("/"):
        sys.exit(0)  # slash commands, including /stack itself, run clean
    manifest, by_name = pstack.load_manifest()
    stack, scope = pstack.resolve(data.get("cwd"), data.get("session_id"))
    inline = pstack.apply_inline(stack, prompt, by_name)
    if inline != stack:
        scope += " + inline"
    text = pstack.render(inline, manifest, by_name, scope)
    if text:
        print(text)
except SystemExit:
    raise
except Exception:
    pass
sys.exit(0)

#!/usr/bin/env bash
# Opt in to Prompt Stack's Claude Code hook.
#
# What it does: copies this folder (bin, hooks, lib, skills, stack.json) to
# ~/.claude/prompt-stack-plugin, so the hook keeps working when bb updates the
# plugin, then adds one UserPromptSubmit hook to ~/.claude/settings.json that
# runs hooks/inject.py from that copy. Nothing else in settings.json is touched.
# Before changing settings.json it saves a dated backup next to it. Running it
# again changes nothing if the hook is already there.
#
#   bash install-hook.sh [--dry-run] [--remove]
#
#   --dry-run  say what would change, change nothing
#   --remove   take the hook out of settings.json again (the copy stays)
#
# CLAUDE_CONFIG_DIR is honoured if you use it. PROMPT_STACK=off silences the
# hook without removing it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
TARGET="$CLAUDE_DIR/prompt-stack-plugin"
DRY=0; REMOVE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --remove) REMOVE=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

command -v python3 >/dev/null || { echo "Stopped: python3 is needed (the hook is a Python script)." >&2; exit 1; }
[ -f "$HERE/hooks/inject.py" ] || { echo "Stopped: $HERE/hooks/inject.py is missing; run this from the plugin's claude-plugin folder." >&2; exit 1; }

COMMAND="python3 \"$TARGET/hooks/inject.py\""

if [ "$REMOVE" -eq 0 ] && [ "$DRY" -eq 0 ] && [ "$HERE" != "$TARGET" ]; then
  mkdir -p "$TARGET"
  rsync -a --delete --exclude __pycache__ --exclude '*.pyc' "$HERE/" "$TARGET/"
  echo "Copied the plugin to $TARGET"
fi

python3 - "$SETTINGS" "$COMMAND" "$REMOVE" "$DRY" <<'PY'
import json, os, shutil, sys, time
path, command, remove, dry = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4] == "1"
MARK = "prompt-stack-plugin/hooks/inject.py"

if os.path.exists(path):
    try:
        data = json.load(open(path))
    except Exception as err:
        sys.exit(f"Stopped: {path} is not valid JSON ({err}). Nothing was changed.")
    if not isinstance(data, dict):
        sys.exit(f"Stopped: {path} is not a JSON object. Nothing was changed.")
else:
    data = {}

hooks = data.get("hooks")
if hooks is not None and not isinstance(hooks, dict):
    sys.exit(f"Stopped: 'hooks' in {path} is not an object. Nothing was changed.")
groups = (hooks or {}).get("UserPromptSubmit", [])
if not isinstance(groups, list):
    sys.exit(f"Stopped: 'hooks.UserPromptSubmit' in {path} is not a list. Nothing was changed.")

def ours(h):
    return isinstance(h, dict) and MARK in str(h.get("command", ""))

present = [h for g in groups if isinstance(g, dict) for h in g.get("hooks", []) if ours(h)]

if remove:
    if not present:
        print("The hook is not in settings.json. Nothing to remove."); sys.exit(0)
    new_groups = []
    for g in groups:
        if isinstance(g, dict) and isinstance(g.get("hooks"), list):
            kept = [h for h in g["hooks"] if not ours(h)]
            if kept: new_groups.append({**g, "hooks": kept})
        else:
            new_groups.append(g)
    change = "remove the Prompt Stack hook"
    result = json.loads(json.dumps(data))
    if new_groups: result["hooks"]["UserPromptSubmit"] = new_groups
    else:
        result["hooks"].pop("UserPromptSubmit", None)
        if not result["hooks"]: result.pop("hooks")
else:
    if len(present) == 1 and present[0].get("command") == command:
        print("The hook is already in settings.json. Nothing changed."); sys.exit(0)
    cleaned = []
    for g in groups:
        if isinstance(g, dict) and isinstance(g.get("hooks"), list):
            kept = [h for h in g["hooks"] if not ours(h)]
            if kept: cleaned.append({**g, "hooks": kept})
        else:
            cleaned.append(g)
    cleaned.append({"hooks": [{"type": "command", "command": command, "timeout": 5}]})
    result = json.loads(json.dumps(data))
    result.setdefault("hooks", {})["UserPromptSubmit"] = cleaned
    change = "update the Prompt Stack hook" if present else "add the Prompt Stack hook"

if dry:
    print(f"Dry run: would {change} in {path} (after saving a backup). Nothing changed."); sys.exit(0)
if os.path.exists(path):
    backup = f"{path}.bak-prompt-stack-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)
    print(f"Saved a backup: {backup}")
else:
    os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".prompt-stack.tmp"
with open(tmp, "w") as fh:
    json.dump(result, fh, indent=2); fh.write("\n")
os.replace(tmp, path)
print(f"Done: {change} in {path}.")
PY

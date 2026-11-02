#!/usr/bin/env bash
# Copy the release plugins from their source branches into this overlay.
#
#   scripts/sync-release.sh                 sync everything
#   scripts/sync-release.sh --only fleet,console
#   scripts/sync-release.sh --check         only check that the sources are clean
#
# Each plugin is copied from its source branch HEAD (git archive, so only tracked
# files, never node_modules or dist) into its folder under plugins/, with rsync
# --delete limited to that folder. The overlay's own LICENSE and NOTICE are put
# back into each folder, and RELEASE_SOURCES.json records where each folder came
# from (repository, branch, commit). The script refuses to run if a source
# worktree has uncommitted changes to tracked files, and changes nothing then.
#
# Worktrees are looked up under $CR_BBWT (default /tmp/bbwt). The Claude Code
# half of Prompt Stack is taken from a committed ref (git archive), never from a
# working folder: repository $PROMPT_STACK_CLAUDE_REPO (default
# ~/Documents/GitHub/navaigate-team-plugins), ref $PROMPT_STACK_CLAUDE_REF
# (default 0ce357b), folder plugins/prompt-stack.
set -euo pipefail

OVERLAY="$(cd "$(dirname "$0")/.." && pwd)"
BBWT="${CR_BBWT:-/tmp/bbwt}"
PS_REPO="${PROMPT_STACK_CLAUDE_REPO:-$HOME/Documents/GitHub/navaigate-team-plugins}"
PS_REF="${PROMPT_STACK_CLAUDE_REF:-0ce357b}"
PS_DIR="plugins/prompt-stack"

# folder | bb plugin id | source worktree | subdirectory of that worktree
SPEC=(
  "console|navaigate-skin|cr-console-release|."
  "fleet|fleet|cr-fleet|fleet"
  "helper-desk|helper-desk|cr-hd|helper-desk"
  "navmotion-skin|navmotion-skin|cr-navmotion|."
  "prompt-stack|prompt-stack|cr-prompt-stack|."
)
# LICENSE and NOTICE are the ones the other plugin folders carry.
LICENSE_FROM="$OVERLAY/plugins/kanban/LICENSE"
NOTICE_FROM="$OVERLAY/plugins/kanban/NOTICE"
HOOK_SCRIPT="$OVERLAY/scripts/prompt-stack-install-hook.sh"

# The vendored Claude Code half names its author and one personal skill. In this
# overlay copy only (never in the source repository) the author becomes NavAIgate
# and the "voice" entry becomes a neutral one that points at the reader's own
# voice skill. Safe to run again: it rewrites to the same result every time.
neutralise_prompt_stack() {
  python3 - "$1" <<'PY'
import json, sys, os
root = sys.argv[1]
p = os.path.join(root, ".claude-plugin", "plugin.json")
if os.path.exists(p):
    j = json.load(open(p))
    j["author"] = {"name": "NavAIgate", "url": "https://navaigate.dev"}
    json.dump(j, open(p, "w"), indent=2); open(p, "a").write("\n")
p = os.path.join(root, "stack.json")
j = json.load(open(p))
for e in j.get("entries", []):
    if e.get("id") == "voice":
        e["aliases"] = ["mine"]
        e["label"] = "Your voice"
        e["card"] = ("Anything written in your name follows your own voice skill: flowing spoken rhythm, plain words, "
                     "no metaphors, no startup jargon, proof over promises. Invoke it before drafting.")
        e["skill"] = "your-voice"
        e["summary"] = ("Anything written as you (email, post, lesson, site copy) uses your own voice skill: "
                        "your spoken rhythm, plain words, real names and numbers.")
json.dump(j, open(p, "w"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
PY
}

ONLY=""; CHECK=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only) [ "$#" -ge 2 ] || { echo "--only needs a comma-separated list of folders" >&2; exit 2; }; ONLY="$2"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d;s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

wanted() { [ -z "$ONLY" ] || [[ ",$ONLY," == *",$1,"* ]]; }
if [ -n "$ONLY" ]; then
  IFS=',' read -r -a asked <<< "$ONLY"
  for a in "${asked[@]}"; do
    ok=0; for row in "${SPEC[@]}"; do [ "${row%%|*}" = "$a" ] && ok=1; done
    [ "$ok" -eq 1 ] || { echo "Unknown folder in --only: $a" >&2; exit 2; }
  done
fi

command -v rsync >/dev/null || { echo "rsync is needed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is needed" >&2; exit 1; }
for f in "$LICENSE_FROM" "$NOTICE_FROM" "$HOOK_SCRIPT"; do [ -f "$f" ] || { echo "Missing $f" >&2; exit 1; }; done

# ------------------------------------------------------------ check first
BAD=0
for row in "${SPEC[@]}"; do
  IFS='|' read -r folder id wt sub <<< "$row"
  wanted "$folder" || continue
  src="$BBWT/$wt"
  if ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then
    echo "REFUSED: $folder: $src is not a git worktree" >&2; BAD=1; continue
  fi
  if [ "$(git -C "$src" ls-files -- "$sub" | wc -l | tr -d ' ')" -eq 0 ]; then
    echo "REFUSED: $folder: $src has no tracked files under '$sub'" >&2; BAD=1; continue
  fi
  dirty="$(git -C "$src" status --porcelain --untracked-files=no -- "$sub" | head -n 5)"
  if [ -n "$dirty" ]; then
    echo "REFUSED: $folder: $src has uncommitted changes (commit them, then run this again):" >&2
    printf '  %s\n' "$dirty" >&2; BAD=1
  fi
done
if wanted prompt-stack; then
  if ! git -C "$PS_REPO" rev-parse --verify --quiet "$PS_REF^{commit}" >/dev/null; then
    echo "REFUSED: prompt-stack: $PS_REF is not a commit in $PS_REPO" >&2; BAD=1
  elif [ "$(git -C "$PS_REPO" ls-tree -r --name-only "$PS_REF" -- "$PS_DIR" | wc -l | tr -d ' ')" -eq 0 ]; then
    echo "REFUSED: prompt-stack: $PS_REF has no tracked files under $PS_DIR" >&2; BAD=1
  fi
fi
[ "$BAD" -eq 0 ] || exit 1
if [ "$CHECK" -eq 1 ]; then echo "All selected sources are clean."; exit 0; fi

# ------------------------------------------------------------ copy
TMP="$(mktemp -d "${TMPDIR:-/tmp}/sync-release.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
ROWS="$TMP/rows.tsv"; : > "$ROWS"

repo_name() { # origin URL -> repository name
  local url; url="$(git -C "$1" remote get-url origin 2>/dev/null || true)"
  url="${url%.git}"; printf '%s' "${url##*/}"
}

for row in "${SPEC[@]}"; do
  IFS='|' read -r folder id wt sub <<< "$row"
  wanted "$folder" || continue
  src="$BBWT/$wt"; dest="$OVERLAY/plugins/$folder"
  commit="$(git -C "$src" rev-parse HEAD)"
  branch="$(git -C "$src" branch --show-current)"
  out="$TMP/$folder"; mkdir -p "$out"
  if [ "$sub" = "." ]; then
    git -C "$src" archive --format=tar HEAD | tar -x -C "$out"
    from="$out"
  else
    git -C "$src" archive --format=tar HEAD -- "$sub" | tar -x -C "$out"
    from="$out/$sub"
  fi
  mkdir -p "$dest"
  excl=(--exclude node_modules --exclude dist)
  [ "$folder" != "prompt-stack" ] || excl+=(--exclude /claude-plugin)
  rsync -a --delete "${excl[@]}" "$from/" "$dest/"
  cp "$LICENSE_FROM" "$dest/LICENSE"; cp "$NOTICE_FROM" "$dest/NOTICE"
  if [ "$folder" = "prompt-stack" ]; then
    # In the overlay the Claude Code half sits next to the panel, so the source
    # notice's "not in this panel's source" would be false here.
    python3 - "$dest/THIRD_PARTY_NOTICES.md" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read()
t = t.replace("`claude-plugin/skills/`), not in this panel's source.", "`claude-plugin/skills/`, a folder of this plugin in the NavAIgate Console).")
open(p, "w").write(t)
PY
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "plugins/$folder" "$id" "$(repo_name "$src")" "$branch" "$commit" >> "$ROWS"
  echo "synced plugins/$folder  <-  $(repo_name "$src") $branch ${commit:0:9}"
done

VENDOR="$TMP/vendor.tsv"; : > "$VENDOR"
if wanted prompt-stack; then
  cdest="$OVERLAY/plugins/prompt-stack/claude-plugin"
  mkdir -p "$cdest" "$TMP/psclaude"
  git -C "$PS_REPO" archive --format=tar "$PS_REF" -- "$PS_DIR" | tar -x -C "$TMP/psclaude"
  rsync -a --delete --exclude __pycache__ --exclude '*.pyc' --exclude .DS_Store "$TMP/psclaude/$PS_DIR/" "$cdest/"
  cp "$HOOK_SCRIPT" "$cdest/install-hook.sh"; chmod 755 "$cdest/install-hook.sh"
  neutralise_prompt_stack "$cdest"
  pcommit="$(git -C "$PS_REPO" rev-parse "$PS_REF^{commit}")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "plugins/prompt-stack/claude-plugin" "prompt-stack (Claude Code plugin)" "$(repo_name "$PS_REPO")" "$(git -C "$PS_REPO" branch --show-current)" "$pcommit" "folder $PS_DIR at that commit" >> "$VENDOR"
  echo "synced plugins/prompt-stack/claude-plugin  <-  $(repo_name "$PS_REPO")"
fi

python3 - "$OVERLAY/RELEASE_SOURCES.json" "$ROWS" "$VENDOR" "${SPEC[@]}" <<'PY'
import json, sys, os
path, rows, vendor, *spec = sys.argv[1:]
order = ["plugins/" + s.split("|")[0] for s in spec]
old = json.load(open(path)) if os.path.exists(path) else {}
plugins = {e["folder"]: e for e in old.get("plugins", [])}
vendored = {e["folder"]: e for e in old.get("vendored", [])}
for line in open(rows):
    f, i, repo, branch, commit = line.rstrip("\n").split("\t")
    plugins[f] = {"folder": f, "pluginId": i, "sourceRepo": repo, "branch": branch, "commit": commit}
for line in open(vendor):
    f, i, repo, branch, commit, note = line.rstrip("\n").split("\t")
    vendored[f] = {"folder": f, "what": i, "sourceRepo": repo, "branch": branch, "commit": commit, "note": note}
doc = {
    "about": "Where each release plugin folder was copied from. Written by scripts/sync-release.sh; do not edit by hand.",
    "release": "1.12.2",
    "plugins": [plugins[f] for f in order if f in plugins],
    "vendored": list(vendored.values()),
}
with open(path, "w") as fh:
    json.dump(doc, fh, indent=2); fh.write("\n")
PY
echo "wrote RELEASE_SOURCES.json"

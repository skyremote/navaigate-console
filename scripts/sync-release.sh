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
# Worktrees are looked up under $CR_BBWT (default /tmp/bbwt); the Claude Code
# half of Prompt Stack under $PROMPT_STACK_CLAUDE_SRC.
set -euo pipefail

OVERLAY="$(cd "$(dirname "$0")/.." && pwd)"
BBWT="${CR_BBWT:-/tmp/bbwt}"
PS_CLAUDE_SRC="${PROMPT_STACK_CLAUDE_SRC:-$HOME/Documents/GitHub/navaigate-team-plugins/plugins/prompt-stack}"

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
  dirty="$(git -C "$src" status --porcelain --untracked-files=no -- "$sub" | head -n 5)"
  if [ -n "$dirty" ]; then
    echo "REFUSED: $folder: $src has uncommitted changes (commit them, then run this again):" >&2
    printf '  %s\n' "$dirty" >&2; BAD=1
  fi
done
if wanted prompt-stack; then
  PS_REPO="$(git -C "$PS_CLAUDE_SRC" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ ! -d "$PS_CLAUDE_SRC" ] || [ -z "$PS_REPO" ]; then
    echo "REFUSED: prompt-stack: $PS_CLAUDE_SRC is not inside a git repository" >&2; BAD=1
  else
    dirty="$(git -C "$PS_REPO" status --porcelain --untracked-files=no -- "$PS_CLAUDE_SRC" | head -n 5)"
    if [ -n "$dirty" ]; then
      echo "REFUSED: prompt-stack Claude Code half has uncommitted changes to tracked files:" >&2
      printf '  %s\n' "$dirty" >&2; BAD=1
    fi
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
  printf '%s\t%s\t%s\t%s\t%s\n' "plugins/$folder" "$id" "$(repo_name "$src")" "$branch" "$commit" >> "$ROWS"
  echo "synced plugins/$folder  <-  $(repo_name "$src") $branch ${commit:0:9}"
done

VENDOR="$TMP/vendor.tsv"; : > "$VENDOR"
if wanted prompt-stack; then
  cdest="$OVERLAY/plugins/prompt-stack/claude-plugin"
  mkdir -p "$cdest"
  rsync -a --delete --exclude __pycache__ --exclude '*.pyc' --exclude .DS_Store "$PS_CLAUDE_SRC/" "$cdest/"
  cp "$HOOK_SCRIPT" "$cdest/install-hook.sh"; chmod 755 "$cdest/install-hook.sh"
  pcommit="$(git -C "$PS_REPO" rev-parse HEAD)"
  tracked="$(git -C "$PS_REPO" ls-files -- "$PS_CLAUDE_SRC" | wc -l | tr -d ' ')"
  digest="$(cd "$PS_CLAUDE_SRC" && find . -type f ! -name '*.pyc' ! -name .DS_Store ! -path '*/__pycache__/*' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "plugins/prompt-stack/claude-plugin" "prompt-stack (Claude Code plugin)" "$(repo_name "$PS_REPO")" "$(git -C "$PS_REPO" branch --show-current)" "$pcommit" "$([ "$tracked" -gt 0 ] && echo "tracked" || echo "not yet committed in that repository; content sha256 $digest")" >> "$VENDOR"
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
    "release": "1.12.0",
    "plugins": [plugins[f] for f in order if f in plugins],
    "vendored": list(vendored.values()),
}
with open(path, "w") as fh:
    json.dump(doc, fh, indent=2); fh.write("\n")
PY
echo "wrote RELEASE_SOURCES.json"

#!/usr/bin/env bash
# NavAIgate Console 1.12.3, from NavAIgate (the project was called BB Overlay before 2 November 2026 and now lives at skyremote/navaigate-console).
# A fresh install gets the Console: one sidebar and Home page, with a setup screen
# where you tick the features you want. --edition simple|pro only picks which
# starting preset the setup screen offers (default simple); Pro also installs
# Fleet, Prompt Stack, Kanban, Finder Links and the optional third-party folders,
# agent board and tasks. Helper Desk, Cache Clock, Reflect, Screen Share, the
# Markdown plugin (NavMotion Skin) and the guided tour come with both.
#
# An existing 1.11 Simple or Pro install is kept exactly as it is. Run with
# --console to move it to the Console; nothing is uninstalled and no data is
# deleted. A navaigate-skin you installed from another source is never touched.
# Disabled plugins stay disabled.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/skyremote/navaigate-console/main/install.sh | bash
#   bash install.sh [--edition simple|pro] [--console] [--dry-run] [--no-look] [--no-mods]
#
#   --edition simple|pro  the Console's starting preset on a fresh install (default
#                         simple); on an existing 1.11 install without --console it
#                         switches between 1.11 Simple and 1.11 Pro as it did before
#   --console             move an existing 1.11 Simple or Pro install to the Console
#   --dry-run             print mutations without making changes
#   --no-look             leave theme, navigation and thread-list preferences alone
#   --no-mods             skip the helper plugins
#   --pin-folders         reinstall compatible folders in place; never remove data
#   --help                show this help

set -euo pipefail

main() {

  EDITION="NavAIgate Console"
  BRAIN_KIT_URL="https://github.com/skyremote/navaigate-console/tree/main/extras/brain-selfhost-kit"
  CONSOLE_ID="navaigate-skin"
  REPO_URL="https://github.com/skyremote/navaigate-console.git"
  REPO_REF="main"
  MIN_BB="0.48"
  MIN_BB_MODS="0.46"

  # Either NavAIgate edition counts as ours: the public NavAIgate Console (once
  # called BB Overlay) and the members' edition ship the same plugins, so a copy
  # from the other one is updated where it is, not kept as it was. Installs made
  # before the rename were recorded from skyremote/bb-overlay; GitHub redirects it
  # to this repository, so they still match and still update. The trailing
  # ".git", "@" and "/" keep any other repository whose name merely starts with this one
  # from counting as ours.
  NAV_MATCH="github.com/skyremote/navaigate-console.git|github.com/skyremote/navaigate-console@|github.com/skyremote/navaigate-console/|github.com/skyremote/bb-overlay|github.com/skyremote/navaigate-workspace"

  # From 0.6.20 on, Projects & Sections declares functions only VKirill's own bb
  # build has (vk-requires.json), yet bb still offers those releases to a range.
  # 0.6.19 is the last release that runs on standard bb, so it is installed
  # pinned, and an existing copy is never updated by this script. A copy at
  # 0.6.20 or later, or one that follows a version range (so bb offers it the
  # newer releases), is offered a switch to the pinned 0.6.19. When to lift the
  # pin: MAINTAINERS.md.
  PF_VERSION="0.6.19"
  PF_SOURCE="git:https://github.com/VKirill/bb-plugin-project-folders.git@v${PF_VERSION}"
  PF_FALLBACK="$PF_SOURCE"
  PF_MATCH="github.com/VKirill/bb-plugin-project-folders"
  AB_SOURCE="git:https://github.com/aaronphifer/bb-plugin-agent-board.git@semver:^0.6.1"
  AB_MATCH="github.com/aaronphifer/bb-plugin-agent-board"

  WS_ID="navaigate-workspace"
  THEME_ID="plugin:${WS_ID}:navaigate"
  RAIL_ID="${WS_ID}/rail"

  DRY_RUN=0
  SET_LOOK=1
  SET_MODS=1
  PIN_FOLDERS=0
  CONSOLE_FLAG=0
  REQUESTED_EDITION=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --edition)
        [ "$#" -ge 2 ] || { echo "--edition needs simple or pro" >&2; exit 2; }
        REQUESTED_EDITION="$2"; shift ;;
      --edition=*) REQUESTED_EDITION="${1#*=}" ;;
      --dry-run) DRY_RUN=1 ;;
      --no-look) SET_LOOK=0 ;;
      --no-mods) SET_MODS=0 ;;
      --pin-folders) PIN_FOLDERS=1 ;;
      --console) CONSOLE_FLAG=1 ;;
      -h|--help)
        if [ -f "$0" ]; then sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d;s/^# *//'
        else printf '%s\n' 'Options: --edition simple|pro --console --dry-run --no-look --no-mods --pin-folders'; fi
        exit 0 ;;
      *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
    shift
  done
  case "$REQUESTED_EDITION" in ""|simple|pro) ;; *) echo "--edition must be simple or pro" >&2; exit 2 ;; esac

  W_INST="[installed]"; W_UPD="[up to date]"
  if [ "$DRY_RUN" -eq 1 ]; then W_INST="[would install]"; W_UPD="[would update]"; fi
  W_INST="$(printf '%-12s' "$W_INST")"; W_UPD="$(printf '%-12s' "$W_UPD")"   # line up the checklist

  say()  { printf '%s\n' "$*"; }
  step() { printf '\n== %s\n' "$*"; }
  warn() { printf 'Note: %s\n' "$*" >&2; }
  die()  { printf 'Stopped: %s\n' "$*" >&2; exit 1; }

  # Print a command, then run it (or only print it with --dry-run).
  run() {
    printf '  $ %s\n' "$*"
    if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
    "$@"
  }

  CHANGED=()   # plugin ids installed or updated in this run (reloaded at the end)
  OUTCOME=()   # checklist lines
  FAILURES=0

  # ---------------------------------------------------------------- bb itself
  step "Checking bb"
  BB="$(command -v bb || true)"
  if [ -z "$BB" ] && [ -x "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb" ]; then
    BB="/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb"
  fi
  [ -n "$BB" ] || die "bb is not installed, or its command is not on your PATH. Install bb from https://getbb.app, open it once, then run this again."
  bb() { "$BB" "$@"; }

  BB_VERSION="$(bb --version 2>/dev/null | head -n1 | tr -d '[:space:]')"
  say "bb $BB_VERSION"
  version_lt() { # true when $1 < $2 (major.minor.patch)
    local IFS=.
    # shellcheck disable=SC2206
    local a=($1) b=($2)
    for i in 0 1 2; do
      local x="${a[$i]:-0}" y="${b[$i]:-0}"
      x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
      [ "${x:-0}" -lt "${y:-0}" ] && return 0
      [ "${x:-0}" -gt "${y:-0}" ] && return 1
    done
    return 1
  }
  if version_lt "$BB_VERSION" "$MIN_BB"; then
    die "NavAIgate Console 1.12 needs bb $MIN_BB or later. Update bb first, then run this again."
  fi

  PLUGIN_LIST="$(bb plugin list 2>/dev/null)" || die "bb is installed but not answering. Open the bb app, wait for it to load, then run this again."

  # The repository must be reachable (the members' edition is private).
  if command -v git >/dev/null 2>&1; then
    if ! GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO_URL" HEAD >/dev/null 2>&1; then
      die "Can't reach $REPO_URL. If it is private, check you have access, then sign git in to GitHub (for example: gh auth login, then gh auth setup-git) and run this again."
    fi
  fi

  # ---------------------------------------------------------------- helpers
  # plugin_line <id> -> "<version> <status>" or empty when not installed
  plugin_line() {
    printf '%s\n' "$PLUGIN_LIST" | awk -v id="$1" '
      $0 ~ /^[^ ]/ { split($1, p, "@"); if (p[1] == id) { print p[2], $2; exit } }'
  }
  # plugin_source <id> -> source string or empty
  plugin_source() {
    printf '%s\n' "$PLUGIN_LIST" | awk -v id="$1" '
      $0 ~ /^[^ ]/ { split($1, p, "@"); cur = p[1]; next }
      cur == id && $1 == "source:" { sub(/^ *source: */, ""); print; exit }'
  }

  # src_matches <source> <a|b|...> -> true when the source contains any of them
  src_matches() {
    local src="$1" m IFS='|'
    for m in $2; do [[ "$src" == *"$m"* ]] && return 0; done
    return 1
  }

  # ask <question> -> true on yes. Reads the terminal, so it works under
  # curl | bash; with no terminal (an agent, CI) the answer is no.
  ask() {
    local reply=""
    if (: </dev/tty) 2>/dev/null; then
      printf '%s [y/N] ' "$1" >/dev/tty
      read -r reply </dev/tty || reply=""
    fi
    case "$reply" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
  }

  # folders_existing <label> <version> <source>: Projects & Sections is already
  # installed from VKirill's repository. 0.6.20 and later need VKirill's own bb
  # build, and a copy that follows a range is offered those releases by bb, so
  # offer the pinned 0.6.19. bb keeps a plugin's data when it is removed, so the
  # folders survive the switch.
  folders_existing() {
    local label="$1" ver="$2" src="$3" why=""
    if ! version_lt "$ver" "0.6.20"; then
      why="$ver needs VKirill's own build of bb, so on standard bb its folders can stop working"
    elif [[ "$src" == *"@semver:"* || "$src" != *.git@* ]]; then
      why="it follows a version range or branch, so bb offers 0.6.20 and later as updates, and those need VKirill's own build of bb"
    fi
    if [ -z "$why" ]; then
      say "$label: installed ($ver, pinned). Leaving it as it is."
      OUTCOME+=("[ok]         $label ($ver, pinned)")
      return 0
    fi
    warn "$label: $why. $PF_VERSION is compatible with standard bb."
    if [ "$PIN_FOLDERS" -eq 1 ]; then
      if run bb plugin install "$PF_SOURCE" --yes; then
        CHANGED+=("project-folders"); OUTCOME+=("$W_INST $label (in-place source update)")
      else
        warn "The in-place folder update failed; no uninstall was attempted."
        OUTCOME+=("[FAILED]     $label: kept existing installation")
        FAILURES=$((FAILURES + 1))
      fi
    else
      OUTCOME+=("[kept]       $label: run with --pin-folders for an in-place compatible update")
    fi
  }

  # [FALLBACK=<source>] ensure <id> <label> <match-in-source> <install args...>
  # FALLBACK is tried when the install fails, and an installed copy is never updated.
  ensure() {
    local id="$1" label="$2" match="$3"; shift 3
    local line src status fallback="${FALLBACK:-}"
    line="$(plugin_line "$id")"
    if [ -z "$line" ] && [ "${PRESERVE_PRO:-0}" -eq 1 ] && [ "$id" != "bb-overlay-guide" ]; then
      OUTCOME+=("[kept]       $label (not installed, so not added; use --edition pro to add it)")
      return 0
    fi
    if [ -n "$line" ] && [ "${line#* }" = "disabled" ]; then
      OUTCOME+=("[kept]       $label (disabled by you)")
      return 0
    fi
    if [ -z "$line" ]; then
      say "$label: not installed, installing."
      if run bb plugin install "$@" --yes; then
        CHANGED+=("$id"); OUTCOME+=("$W_INST $label")
      elif [ -n "$fallback" ] && [ "$fallback" != "$1" ] && say "$label: no recent release runs on this bb, trying ${fallback##*@}." \
        && run bb plugin install "$fallback" --yes; then
        CHANGED+=("$id"); OUTCOME+=("$W_INST $label (${fallback##*@}, the last release for this bb)")
      else
        OUTCOME+=("[FAILED]     $label: install failed, see above")
        FAILURES=$((FAILURES + 1))
      fi
      return 0
    fi
    src="$(plugin_source "$id")"
    status="${line#* }"
    if [[ "$src" == builtin:* ]]; then
      say "$label: installed (${line%% *}, updates with bb)."
      OUTCOME+=("[ok]         $label")
    elif [ -n "$match" ] && ! src_matches "$src" "$match"; then
      say "$label: already installed from $src. Keeping your copy as it is."
      OUTCOME+=("[kept]       $label (your own copy: $src)")
    elif [ -n "$fallback" ]; then
      # Never update this one in place: bb offers releases that need VKirill's
      # own bb build as updates. Offer the pinned release instead.
      folders_existing "$label" "${line%% *}" "$src"
    else
      say "$label: installed (${line%% *}), checking for an update."
      if run bb plugin update "$id" --yes; then
        CHANGED+=("$id"); OUTCOME+=("$W_UPD $label")
      else
        OUTCOME+=("[ok]         $label (update check failed, kept ${line%% *})")
      fi
    fi

  }

  # ---------------------------------------------------------------- edition
  # Which core is in charge today?
  #   simple   navaigate-simple (1.11 Simple)
  #   pro      navaigate-workspace (1.11 Pro), or a navaigate-skin from another source
  #   console  navaigate-skin installed from this repository (the Console)
  SKIN_SRC="$(plugin_source "$CONSOLE_ID")"
  SKIN_OURS=0; SKIN_OTHER=0
  if [ -n "$(plugin_line "$CONSOLE_ID")" ]; then
    if src_matches "$SKIN_SRC" "$NAV_MATCH"; then SKIN_OURS=1; else SKIN_OTHER=1; fi
  fi
  SKIN_ENABLED=0
  [ "$SKIN_OURS" -eq 1 ] && [ "$(plugin_line "$CONSOLE_ID" | awk '{print $2}')" != "disabled" ] && SKIN_ENABLED=1

  CURRENT_EDITION=""
  SELECTED_LIST="$(bb settings ui get sidebar.threadListProvider 2>/dev/null | tr -d '"[:space:]' || true)"
  if [[ "$SELECTED_LIST" == navaigate-simple/* ]] && [ -n "$(plugin_line navaigate-simple)" ]; then
    CURRENT_EDITION=simple
  elif [[ "$SELECTED_LIST" == navaigate-skin/* ]] && [ "$SKIN_OURS" -eq 1 ]; then
    CURRENT_EDITION=console
  elif [[ "$SELECTED_LIST" == navaigate-workspace/* || "$SELECTED_LIST" == navaigate-skin/* ]] && [ -n "$(plugin_line navaigate-workspace)$(plugin_line navaigate-skin)" ]; then
    CURRENT_EDITION=pro
  elif [ -n "$(plugin_line navaigate-simple)" ] && [ "$(plugin_line navaigate-simple | awk '{print $2}')" != "disabled" ]; then
    CURRENT_EDITION=simple
  elif [ "$SKIN_ENABLED" -eq 1 ]; then
    CURRENT_EDITION=console
  elif [ -n "$(plugin_line navaigate-workspace)$(plugin_line navaigate-skin)" ]; then
    if [ "$SKIN_OURS" -eq 1 ] && [ -z "$(plugin_line navaigate-workspace)" ]; then CURRENT_EDITION=console; else CURRENT_EDITION=pro; fi
  fi
  LEGACY_EDITION=""
  case "$CURRENT_EDITION" in simple|pro) LEGACY_EDITION="$CURRENT_EDITION" ;; esac

  # Console or the 1.11 editions? A fresh install, an existing Console and --console
  # all mean the Console. An existing 1.11 Simple or Pro install is kept as it is.
  # A navaigate-skin from another source is never replaced or reconfigured.
  MODE=legacy
  if [ "$CONSOLE_FLAG" -eq 1 ] && [ "$SKIN_OTHER" -eq 1 ]; then
    printf 'Stopped: %s is already installed from %s, so --console would replace your own copy. Nothing was changed. Leave out --console to update the rest, or remove your copy yourself first.\n' "$CONSOLE_ID" "$SKIN_SRC" >&2
    exit 2
  elif [ "$CONSOLE_FLAG" -eq 1 ] || [ "$CURRENT_EDITION" = console ] || [ -z "$CURRENT_EDITION" ]; then
    MODE=console
  fi

  if [ "$MODE" = console ]; then
    # --edition picks the starting preset and, for pro, the extra plugins.
    # An existing Console keeps its own preset and look.
    CONSOLE_NEW=0; [ "$SKIN_OURS" -eq 0 ] && CONSOLE_NEW=1
    PRESET=""; WANT_PRO=0
    if [ "$CONSOLE_NEW" -eq 1 ]; then PRESET="${REQUESTED_EDITION:-${LEGACY_EDITION:-simple}}"; fi
    # The Pro plugins come with an explicit --edition pro, or with a fresh install
    # on the Pro preset. A preset carried over from a 1.11 install only sets the
    # starting choice: plugins the person left out of 1.11 are not added.
    [ "$REQUESTED_EDITION" = pro ] && WANT_PRO=1
    [ "$CONSOLE_NEW" -eq 1 ] && [ -z "$LEGACY_EDITION" ] && [ "$PRESET" = pro ] && WANT_PRO=1
    EDITION=console
    SWITCHING=$CONSOLE_FLAG
    KEEP_LOOK=0; [ "$CURRENT_EDITION" = console ] && KEEP_LOOK=1
    if [ "$SET_LOOK" -eq 0 ] && [ -n "$LEGACY_EDITION" ] && [ "$CONSOLE_FLAG" -eq 1 ]; then
      die "--no-look cannot switch to the Console: the old thread list would point at a disabled core. Remove --no-look to switch, or omit --console to keep your current setup."
    fi
    step "NavAIgate Console: Console"
    if [ "$CONSOLE_NEW" -eq 1 ]; then
      say "The Console is the core for both starting presets. Its setup screen opens first; you tick the features you want there. Starting preset: $PRESET."
    fi
  else
    EDITION="${REQUESTED_EDITION:-${CURRENT_EDITION:-simple}}"
    SWITCHING=0; [ -n "$REQUESTED_EDITION" ] && SWITCHING=1
    if [ "$SET_LOOK" -eq 0 ] && [ -n "$CURRENT_EDITION" ] && [ "$EDITION" != "$CURRENT_EDITION" ]; then
      die "--no-look cannot switch editions: the old thread list would point at a disabled core. Remove --no-look to switch, or omit --edition to update your current setup."
    fi
    PRESERVE_PRO=0
    [ "$EDITION" = pro ] && [ -n "$(plugin_line navaigate-workspace)$(plugin_line navaigate-skin)" ] && PRESERVE_PRO=1
    KEEP_LOOK=0
    [ -n "$CURRENT_EDITION" ] && [ "$EDITION" = "$CURRENT_EDITION" ] && KEEP_LOOK=1
    step "NavAIgate Console: $EDITION (1.11 setup, kept as it is)"
    if [ "$SKIN_OTHER" -eq 0 ]; then
      say "NavAIgate Console 1.12 adds the Console. Nothing about your $EDITION setup has changed. To move to the Console, run this again with --console (nothing is uninstalled)."
    fi
  fi

  # Save only appearance values when moving away from a 1.11 edition: Pro to Simple
  # (so Pro can come back) or either 1.11 edition to the Console. Separate text files
  # avoid requiring Python/Node on a member's computer.
  SAVED_LOOK="${XDG_CONFIG_HOME:-$HOME/.config}/bb-overlay/pro-look"
  if [ "$DRY_RUN" -eq 0 ] && [ "$SET_LOOK" -eq 1 ] && [ "$CURRENT_EDITION" = pro ] && [ "$EDITION" = simple ]; then
    mkdir -p "$SAVED_LOOK"
    bb settings ui get sidebar.threadListProvider > "$SAVED_LOOK/thread-list.json"
    bb settings ui get sidebar.navigationProvider > "$SAVED_LOOK/navigation.json"
    bb theme show | sed -n '1s/.*(\(.*\))$/\1/p' > "$SAVED_LOOK/theme.txt"
  fi
  if [ "$DRY_RUN" -eq 0 ] && [ "$SET_LOOK" -eq 1 ] && [ "$MODE" = console ] && [ "$CONSOLE_FLAG" -eq 1 ] && [ -n "$LEGACY_EDITION" ]; then
    BEFORE_CONSOLE="${XDG_CONFIG_HOME:-$HOME/.config}/bb-overlay/before-console"
    mkdir -p "$BEFORE_CONSOLE"
    bb settings ui get sidebar.threadListProvider > "$BEFORE_CONSOLE/thread-list.json"
    bb settings ui get sidebar.navigationProvider > "$BEFORE_CONSOLE/navigation.json"
    bb theme show | sed -n '1s/.*(\(.*\))$/\1/p' > "$BEFORE_CONSOLE/theme.txt"
    printf '%s\n' "$LEGACY_EDITION" > "$BEFORE_CONSOLE/edition.txt"
  fi

  # ---------------------------------------------------------------- plugins
  if [ "$MODE" = console ]; then
    WS_ID="$CONSOLE_ID"
    ensure "$CONSOLE_ID" "NavAIgate Console" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin console
  elif [ "$EDITION" = simple ]; then
    WS_ID=navaigate-simple
    ensure "$WS_ID" "NavAIgate Simple" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin simple
  else
    WS_ID=navaigate-workspace
    # Honour the selected (or saved) Pro provider before considering another
    # installed core. A disabled personal skin must not replace a selected public one.
    PRO_LIST="$SELECTED_LIST"
    if [ "$CURRENT_EDITION" = simple ] && [ -s "$SAVED_LOOK/thread-list.json" ]; then PRO_LIST="$(tr -d '"[:space:]' < "$SAVED_LOOK/thread-list.json")"; fi
    if [[ "$PRO_LIST" == navaigate-skin/* ]] && [ -n "$(plugin_line navaigate-skin)" ]; then
      WS_ID=navaigate-skin
    elif [[ "$PRO_LIST" == navaigate-workspace/* ]] && [ -n "$(plugin_line navaigate-workspace)" ]; then
      WS_ID=navaigate-workspace
    elif [ -n "$(plugin_line navaigate-skin)" ] && [ "$(plugin_line navaigate-skin | awk '{print $2}')" != disabled ]; then
      WS_ID=navaigate-skin
    elif [ -n "$(plugin_line navaigate-workspace)" ]; then
      WS_ID=navaigate-workspace
    elif [ -n "$(plugin_line navaigate-skin)" ]; then
      WS_ID=navaigate-skin
    fi
    ensure "$WS_ID" "NavAIgate Pro (existing workspace)" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin workspace
    ensure kanban Kanban "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin kanban
  fi
  THEME_ID="plugin:${WS_ID}:navaigate"
  RAIL_ID="${WS_ID}/rail"

  if [ "$SET_MODS" -eq 1 ]; then
    for mod in helper-desk cache-clock reflect screen-share; do
      ensure "$mod" "$mod" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin "$mod"
    done
    if [ "$MODE" = console ]; then
      ensure navmotion-skin "Markdown plugin (NavMotion Skin)" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin navmotion-skin
    fi
  fi
  if [ "$MODE" = console ]; then
    if [ "$WANT_PRO" -eq 1 ] || [ "$CONSOLE_NEW" -eq 0 ]; then
      # On an existing Console without --edition pro, installed Pro plugins are
      # updated and missing ones are skipped.
      PRESERVE_PRO=$((1 - WANT_PRO))
      ensure fleet "Fleet" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin fleet
      ensure prompt-stack "Prompt Stack" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin prompt-stack
      ensure kanban Kanban "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin kanban
      ensure finder-links "Finder Links" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin finder-links
      FALLBACK="$PF_FALLBACK" ensure project-folders "Projects & Sections" "$PF_MATCH" "$PF_SOURCE"
      ensure agent-board "Agent Board" "$AB_MATCH" "$AB_SOURCE"
      ensure tasks "Tasks (built into bb)" "" tasks
      PRESERVE_PRO=0
    fi
  elif [ "$EDITION" = pro ]; then
    ensure finder-links "Finder Links" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin finder-links
    ensure navmotion-skin "NavMotion Skin" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin navmotion-skin
    FALLBACK="$PF_FALLBACK" ensure project-folders "Projects & Sections" "$PF_MATCH" "$PF_SOURCE"
    ensure agent-board "Agent Board" "$AB_MATCH" "$AB_SOURCE"
    ensure tasks "Tasks (built into bb)" "" tasks
  fi
  ensure bb-overlay-guide "BB Overlay guide" "$NAV_MATCH" "git:${REPO_URL}@${REPO_REF}" --plugin onboarding

  # Build/reload before touching the working edition. Keep its core running until
  # the replacement's appearance preferences have been applied successfully.
  if [ "${#CHANGED[@]}" -gt 0 ]; then
    for id in "${CHANGED[@]}"; do
      if ! run bb plugin reload "$id"; then
        FAILURES=$((FAILURES + 1)); OUTCOME+=("[FAILED]     Reload $id; previous edition kept")
      fi
    done
  fi
  if [ "$FAILURES" -eq 0 ] && [ "$SWITCHING" -eq 1 ] && [ "$(plugin_line "$WS_ID" | awk '{print $2}')" = disabled ]; then
    if ! run bb plugin enable "$WS_ID"; then FAILURES=$((FAILURES + 1)); fi
  fi

  # ---------------------------------------------------------------- appearance
  if [ "$FAILURES" -eq 0 ] && [ "$SET_LOOK" -eq 1 ] && [ "$KEEP_LOOK" -eq 0 ]; then
    OLD_LIST="$(bb settings ui get sidebar.threadListProvider)"
    OLD_NAV="$(bb settings ui get sidebar.navigationProvider)"
    OLD_THEME="$(bb theme show | sed -n '1s/.*(\(.*\))$/\1/p')"
    NEW_LIST="$RAIL_ID"; NEW_NAV=navigation/rail; NEW_THEME="$THEME_ID"
    if [ "$MODE" = legacy ] && [ "$EDITION" = pro ] && [ -s "$SAVED_LOOK/thread-list.json" ] && [ -s "$SAVED_LOOK/navigation.json" ] && [ -s "$SAVED_LOOK/theme.txt" ]; then
      NEW_LIST="$(cat "$SAVED_LOOK/thread-list.json")"
      NEW_NAV="$(cat "$SAVED_LOOK/navigation.json")"
      NEW_THEME="$(cat "$SAVED_LOOK/theme.txt")"
    fi
    if run bb settings ui set sidebar.threadListProvider "$NEW_LIST" && run bb settings ui set sidebar.navigationProvider "$NEW_NAV" && run bb theme set "$NEW_THEME"; then
      OUTCOME+=("[ok]         $EDITION appearance selected")
    else
      warn "Appearance selection failed. Restoring previous values; its core remains enabled."
      run bb settings ui set sidebar.threadListProvider "$OLD_LIST" || warn "Restore thread list manually in Settings, Appearance."
      run bb settings ui set sidebar.navigationProvider "$OLD_NAV" || warn "Restore navigation manually in Settings, Appearance."
      [ -z "$OLD_THEME" ] || run bb theme set "$OLD_THEME" || warn "Restore theme manually in Settings, Appearance."
      FAILURES=$((FAILURES + 1))
    fi
  elif [ "$KEEP_LOOK" -eq 1 ]; then
    say "Your existing $EDITION appearance, rail, tabs, plugins and settings are kept."
  fi

  if [ "$FAILURES" -eq 0 ] && [ "$SWITCHING" -eq 1 ]; then
    OTHER_CORES=navaigate-simple
    [ "$EDITION" != simple ] || OTHER_CORES="navaigate-workspace navaigate-skin"
    [ "$MODE" != console ] || OTHER_CORES="navaigate-simple navaigate-workspace"
    # A navaigate-skin installed from another source is never disabled by this script.
    if [ "$SKIN_OTHER" -eq 1 ]; then OTHER_CORES="${OTHER_CORES//navaigate-skin/}"; fi
    DISABLED_CORES=""
    for id in $OTHER_CORES; do
      if [ -n "$(plugin_line "$id")" ] && [ "$(plugin_line "$id" | awk '{print $2}')" != disabled ]; then
        if run bb plugin disable "$id"; then DISABLED_CORES="$DISABLED_CORES $id"
        else
          for restore_id in $DISABLED_CORES; do run bb plugin enable "$restore_id" || true; done
          [ -z "${OLD_LIST:-}" ] || run bb settings ui set sidebar.threadListProvider "$OLD_LIST" || true
          [ -z "${OLD_NAV:-}" ] || run bb settings ui set sidebar.navigationProvider "$OLD_NAV" || true
          [ -z "${OLD_THEME:-}" ] || run bb theme set "$OLD_THEME" || true
          FAILURES=$((FAILURES + 1)); break
        fi
      fi
    done
  fi

  # A Console we installed in this run starts on the chosen preset. This is only a
  # starting choice: the Console's setup screen reads it and the person ticks the
  # features there. It is never set on a Console that was already installed.
  if [ "$FAILURES" -eq 0 ] && [ "$MODE" = console ] && [ "$CONSOLE_NEW" -eq 1 ] && [ -n "$PRESET" ] \
     && [ "$(plugin_line "$CONSOLE_ID" | awk '{print $2}')" != disabled ]; then
    run bb plugin config "$CONSOLE_ID" set preset "$PRESET" \
      || warn "Could not record the $PRESET preset. The Console's setup screen will open on its default; choose Simple or Pro there."
  fi

  # Configure the guide only after all required installs succeeded. An existing
  # disabled guide remains disabled; its completed/dismissed progress is never reset.
  if [ "$FAILURES" -eq 0 ]; then
    run bb plugin config bb-overlay-guide set edition "$EDITION"
    run bb plugin config bb-overlay-guide set autoStart true
  fi

  step "Checklist"
  [ "$DRY_RUN" -eq 1 ] && say "Dry run: nothing changed."
  for line in "${OUTCOME[@]}"; do say "  $line"; done
  if [ "$FAILURES" -gt 0 ]; then die "$FAILURES required install(s) failed. Your previous edition was not switched and onboarding was not started."; fi
  if [ "$(plugin_line bb-overlay-guide | awk '{print $2}')" = disabled ]; then
    say "Your guide is disabled and was left disabled. Enable bb-overlay-guide when you want to use it."
  else
    say "Reload bb (Cmd-R on Mac, Ctrl-R on Linux). The guided tour will offer to start."
  fi
  say "Each step needs your acknowledgement. Close to pause; replay from Settings, BB Overlay guide."
  say "Run this again to update. Disabled plugins, saved data and existing appearance are preserved."

  if [ "$MODE" = console ]; then
    step "Next steps"
    say "Setup: after you reload, the Console opens its setup screen. Tick the features you want there; you can come back to it from Settings."
    say "Brain (optional): a self-hosted memory service for Fleet and the Console's brain features. The kit is in this repository, ${BRAIN_KIT_URL}. Nothing is installed for it here; the Console's setup screen takes its address."
    if [ "$WANT_PRO" -eq 1 ]; then
      say "Fleet needs a second Mac running bb and a brain. Add the other Mac in the setup screen."
      say "Prompt Stack's Claude Code hook is a separate, opt-in step. This installer never touches ~/.claude/settings.json. To add the hook (it saves a dated backup of settings.json first and can be run again safely):"
      HOOK_LOCAL=""
      if [ -f "$0" ]; then
        HOOK_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
        [ -n "$HOOK_DIR" ] && [ -f "$HOOK_DIR/plugins/prompt-stack/claude-plugin/install-hook.sh" ] && HOOK_LOCAL="$HOOK_DIR/plugins/prompt-stack/claude-plugin/install-hook.sh"
      fi
      if [ -n "$HOOK_LOCAL" ]; then
        say "  bash \"$HOOK_LOCAL\""
      else
        say "  d=\$(mktemp -d) && git clone --depth 1 ${REPO_URL} \"\$d\" && bash \"\$d/plugins/prompt-stack/claude-plugin/install-hook.sh\""
      fi
    fi
  fi
}

main "$@"

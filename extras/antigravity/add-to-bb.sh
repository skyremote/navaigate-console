#!/usr/bin/env bash
# NavAIgate Console extra: add Google Antigravity to bb as an agent.
#
# bb can run any agent that speaks the Agent Client Protocol (ACP), and the
# Antigravity command line has one built in (`agy acp`). This script adds it to
# bb's "Custom agents" setting next to whatever is already there. It never
# removes or rewrites another agent, it installs nothing, and it does not sign
# you in.
#
#   bash extras/antigravity/add-to-bb.sh            add it (or do nothing if it is already there)
#   bash extras/antigravity/add-to-bb.sh --dry-run  show what would change and stop
set -euo pipefail

main() {
  say() { printf '%s\n' "$*"; }
  die() { printf 'Stopped: %s\n' "$*" >&2; exit 1; }

  DRY_RUN=0
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -h|--help)
        say "Adds Google Antigravity to bb as an agent, next to the custom agents you already have."
        say "  bash add-to-bb.sh            add it (or do nothing if it is already there)"
        say "  bash add-to-bb.sh --dry-run  show what would change and stop"
        exit 0 ;;
      *) die "Unknown option: $arg (use --dry-run or --help)" ;;
    esac
  done

  command -v bb >/dev/null 2>&1 || die "bb is not on your PATH. Open bb once, then run this again."
  command -v python3 >/dev/null 2>&1 || die "python3 is needed to read bb's setting safely, and it was not found."

  AGY="$(command -v agy || true)"
  [ -n "$AGY" ] || die "The Antigravity command line (agy) is not installed. Get it from https://antigravity.google/product/antigravity-cli (with Homebrew on a Mac: brew install --cask antigravity-cli), then run this again."
  "$AGY" acp --help >/dev/null 2>&1 || die "This copy of agy has no 'acp' command. Update the Antigravity command line, then run this again."

  CURRENT="$(bb plugin config provider-acp --json 2>/dev/null)" || die "bb did not return the ACP providers settings. Check that bb is open and up to date."

  # Prints three lines: one word (added, updated or unchanged), the new setting,
  # and a summary that is safe to show (the Antigravity entry and a count of the
  # others, never their contents, because an entry can hold keys). Exits 3 if bb
  # did not answer properly or the setting is not a list this script can read,
  # so nothing gets overwritten by a guess.
  RESULT="$(printf '%s' "$CURRENT" | AGY_PATH="$AGY" python3 -I -c '
import json, os, sys

agy = os.environ["AGY_PATH"]
try:
    reply = json.loads(sys.stdin.buffer.read().decode("utf-8"))
except Exception:
    sys.exit(3)
if not isinstance(reply, dict) or reply.get("ok") is not True or not isinstance(reply.get("values"), dict):
    sys.exit(3)
raw = reply["values"].get("customAgents", "")
if raw is None or (isinstance(raw, str) and not raw.strip()):
    agents = []
else:
    try:
        agents = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        sys.exit(3)
if not isinstance(agents, list) or not all(isinstance(a, dict) for a in agents):
    sys.exit(3)

state = "added"
mine = None
for agent in agents:
    if agent.get("id") == "antigravity":
        mine = agent
        args = agent.get("args")
        args_ok = isinstance(args, list) and len(args) > 0 and args[0] == "acp"
        if agent.get("command") == agy and args_ok:
            state = "unchanged"
        else:
            agent["command"] = agy
            if not args_ok:
                agent["args"] = ["acp"]
            state = "updated"
        break
else:
    mine = {"id": "antigravity", "displayName": "Google Antigravity", "command": agy, "args": ["acp"]}
    agents.append(mine)

others = len(agents) - 1
shown = {k: mine[k] for k in ("id", "displayName", "command", "args") if k in mine}
lines = [
    state,
    json.dumps(agents, separators=(",", ":"), ensure_ascii=False),
    json.dumps(shown, ensure_ascii=False) + " plus " + str(others) + " other custom agent" + ("" if others == 1 else "s") + ", unchanged",
]
sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
')" || die "bb did not answer properly, or its Custom agents setting on this machine is not a list this script can read, so nothing was changed. Check the Custom agents setting in the ACP providers plugin's settings."

  STATE="$(printf '%s\n' "$RESULT" | sed -n '1p')"
  NEW="$(printf '%s\n' "$RESULT" | sed -n '2p')"
  SUMMARY="$(printf '%s\n' "$RESULT" | sed -n '3p')"
  [ -n "$NEW" ] || die "Could not work out the new setting, so nothing was changed."

  case "$STATE" in
    unchanged)
      say "Google Antigravity is already in bb (provider acp-antigravity). Nothing changed."
      ;;
    added|updated)
      if [ "$DRY_RUN" -eq 1 ]; then
        say "Dry run, nothing written. The Antigravity entry would be:"
        say "$SUMMARY"
        exit 0
      fi
      bb plugin config provider-acp set customAgents "$NEW" >/dev/null || die "bb refused the new setting, so nothing was changed."
      if [ "$STATE" = "added" ]; then
        say "Added Google Antigravity to bb as provider acp-antigravity. Your other custom agents are as they were."
      else
        say "Pointed the Google Antigravity agent in bb at $AGY. Your other custom agents are as they were."
      fi
      ;;
    *) die "Unexpected result, so nothing was changed." ;;
  esac

  [ "$DRY_RUN" -eq 1 ] && exit 0

  say ""
  say "Models bb can see through Antigravity (this depends on your Google plan):"
  if ! bb provider models acp-antigravity 2>/dev/null; then
    say "bb could not list the models yet. Sign in once in the Antigravity app, or run: agy acp --login"
    say "Then check again with: bb provider models acp-antigravity"
  fi
  say ""
  say "To take it out again, remove the antigravity entry from the Custom agents setting in the ACP providers plugin's settings."
}

main "$@"

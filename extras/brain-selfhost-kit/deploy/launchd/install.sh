#!/bin/sh
# Install (or remove) the brain as three LaunchAgents on a Mac: database server, connector, nightly backup.
#   deploy/launchd/install.sh            install and start
#   deploy/launchd/install.sh uninstall  stop and remove the three agents (your data is left alone)
# Needs first: scripts/get-sqld.sh, a .venv with requirements.txt, and scripts/mint.py init already run.
set -eu
KIT="$(cd "$(dirname "$0")/../.." && pwd)"
PREFIX="${LABEL_PREFIX:-dev.brainkit}"
BRAIN_HOME="${BRAIN_HOME:-$HOME/.brain}"
SQLD_PORT="${SQLD_PORT:-8090}"
MCP_PORT="${BRAIN_MCP_PORT:-8765}"
MCP_HOSTS="${BRAIN_MCP_HOSTS:-}"
LOGS="${LOGS:-$HOME/Library/Logs/brain}"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

if [ "${1:-}" = "uninstall" ]; then
  for n in sqld connector backup; do
    launchctl bootout "gui/$UID_NUM/$PREFIX.$n" 2>/dev/null || true
    rm -f "$AGENTS/$PREFIX.$n.plist"
  done
  echo "Removed the three agents. Your data in $BRAIN_HOME is untouched."
  exit 0
fi

[ -x "$KIT/bin/sqld" ] || { echo "Run scripts/get-sqld.sh first." >&2; exit 1; }
[ -x "$KIT/.venv/bin/python" ] || { echo "Make the Python environment first (see the guide)." >&2; exit 1; }
[ -f "$BRAIN_HOME/keys/jwt-public.pem" ] || { echo "Run: BRAIN_HOME=\"$BRAIN_HOME\" $KIT/.venv/bin/python $KIT/scripts/mint.py init" >&2; exit 1; }
mkdir -p "$AGENTS" "$LOGS" "$BRAIN_HOME/sqld"

for n in sqld connector backup; do
  sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@KIT@|$KIT|g" -e "s|@BRAIN_HOME@|$BRAIN_HOME|g" \
      -e "s|@SQLD_PORT@|$SQLD_PORT|g" -e "s|@MCP_PORT@|$MCP_PORT|g" -e "s|@MCP_HOSTS@|$MCP_HOSTS|g" \
      -e "s|@LOGS@|$LOGS|g" "$KIT/deploy/launchd/$n.plist.template" > "$AGENTS/$PREFIX.$n.plist"
  plutil -lint "$AGENTS/$PREFIX.$n.plist" >/dev/null
  launchctl bootout "gui/$UID_NUM/$PREFIX.$n" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$PREFIX.$n.plist"
done
launchctl kickstart -k "gui/$UID_NUM/$PREFIX.sqld"
launchctl kickstart -k "gui/$UID_NUM/$PREFIX.connector"
echo "Started. Logs: $LOGS"

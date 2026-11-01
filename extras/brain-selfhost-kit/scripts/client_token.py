"""Give each AI client its own token for the connector.

    python scripts/client_token.py add grok        prints a new token ONCE. Paste it into that client.
    python scripts/client_token.py list            shows client names (never the tokens)
    python scripts/client_token.py revoke grok     that client is locked out at once, no restart

The connector keeps only a hash of each token, in $BRAIN_HOME/connector/tokens.json.
Nobody, including you, can read a token back from that file. Lost one? Revoke it and add a new one.
"""
import hashlib
import json
import os
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

PATH = Path(os.environ.get("BRAIN_MCP_TOKENS", Path(os.environ.get("BRAIN_HOME", "./state")) / "connector" / "tokens.json")).expanduser()


def load() -> dict:
    try:
        return json.loads(PATH.read_text())
    except (OSError, ValueError):
        return {}


def save(data: dict) -> None:
    PATH.parent.mkdir(parents=True, exist_ok=True)
    old = os.umask(0o077)
    try:
        PATH.write_text(json.dumps(data, indent=2))
    finally:
        os.umask(old)
    try:
        os.chmod(PATH, 0o600)
    except OSError:
        pass


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in {"add", "list", "revoke"}:
        sys.exit(__doc__)
    action, data = sys.argv[1], load()
    if action == "list":
        for name, rec in data.items():
            print(f"{name}\t{rec.get('scope', 'read')}\tadded {rec.get('added', '?')}")
        if not data:
            print("No clients yet.")
        return
    if len(sys.argv) < 3 or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", sys.argv[2]):
        sys.exit("Give a short lower-case client name, for example: grok")
    name = sys.argv[2]
    if action == "add":
        if name in data:
            sys.exit(f"'{name}' already exists. Revoke it first if you want a new token.")
        token = "brk_" + secrets.token_urlsafe(32)
        data[name] = {"sha256": hashlib.sha256(token.encode()).hexdigest(), "scope": "read", "added": datetime.now(timezone.utc).strftime("%Y-%m-%d")}
        save(data)
        print(token)
        print(f"(Shown once. Stored as a hash for '{name}'.)", file=sys.stderr)
    else:
        if name not in data:
            sys.exit(f"No client called '{name}'.")
        del data[name]
        save(data)
        print(f"Revoked '{name}'.")


if __name__ == "__main__":
    main()

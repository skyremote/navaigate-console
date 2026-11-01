"""A tiny way to put things in the brain without installing anything else.

    python scripts/brain.py note add "Pricing call with Acme" --tags sales,acme --path "Docs/acme-call.md"
    python scripts/brain.py task add "Send the proposal" --due 2026-12-01
    python scripts/brain.py finding add "Acme wants monthly billing" --support "said on the 3 Nov call" --confidence 0.8
    python scripts/brain.py list notes|tasks|findings

Uses the read-write token ($BRAIN_HOME/keys/rw.jwt). Notes are pointers: a title, tags and where the full
document lives. Findings carry the sentence itself, so use them for facts you want searched later.
The connector only reads, so this is how rows get in (or the aios CLI, if you use the harness).
"""
import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "connector"))
from brain_mcp import DB_URL, SqldError, sqld_query  # noqa: E402

HOME = Path(os.environ.get("BRAIN_HOME", "./state")).expanduser()
token = os.environ.get("BRAIN_DB_RW_TOKEN") or Path(os.environ.get("BRAIN_DB_RW_TOKEN_FILE", HOME / "keys" / "rw.jwt")).read_text().strip()
now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def run(sql, args=()):
    return sqld_query(sql, args, DB_URL, token)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for kind in ("note", "task", "finding"):
        add = sub.add_parser(kind).add_subparsers(dest="verb", required=True).add_parser("add")
        add.add_argument("text", help="title for a note or task, the claim for a finding")
        if kind == "note":
            add.add_argument("--tags"); add.add_argument("--path"); add.add_argument("--source", default="manual")
        elif kind == "task":
            add.add_argument("--due"); add.add_argument("--status", default="open"); add.add_argument("--venture")
        else:
            add.add_argument("--support"); add.add_argument("--confidence", type=float)
    sub.add_parser("list").add_argument("what", choices=["notes", "tasks", "findings"])
    a = ap.parse_args()
    try:
        if a.cmd == "list":
            for row in run(f"SELECT * FROM {a.what} ORDER BY id DESC LIMIT 30"):
                print(row)
            return
        if a.cmd == "note":
            res = run("INSERT INTO notes (title, drive_path, source, tags, created_at) VALUES (?,?,?,?,?)", (a.text, a.path, a.source, a.tags, now))
        elif a.cmd == "task":
            res = run("INSERT INTO tasks (title, status, venture, due, created_at, updated_at) VALUES (?,?,?,?,?,?)", (a.text, a.status, a.venture, a.due, now, now))
        else:
            res = run("INSERT INTO findings (claim, confidence, support, created_at) VALUES (?,?,?,?)", (a.text, a.confidence, a.support, now))
        print(f"Saved {a.cmd} {res[0]['last_insert_rowid']}")
    except SqldError as exc:
        sys.exit(f"Failed: {exc}")


if __name__ == "__main__":
    main()

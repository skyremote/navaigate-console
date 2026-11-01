"""Take a safe copy of the brain database. Run it every night.

    python scripts/backup.py                    copy the database file with SQLite's own backup (Mac, Linux, VPS)
    python scripts/backup.py --http             copy it by reading every table over the network (Windows/Docker Desktop,
                                                or backing up a server from another machine)
    python scripts/backup.py --keep 30 --to /path/to/backups

Both make one file, brain-YYYYMMDD-HHMMSS.db, that opens in any SQLite tool, and keep the newest 14 (change with --keep).
The file mode is consistent even while the server is running. The folder should be a local disk or an archive
folder: a backup FILE on a network share is fine because nothing opens it live; the live database is not.
--http uses the read-only token (BRAIN_HOME/keys/ro.jwt) and BRAIN_DB_URL.
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "connector"))
HOME = Path(os.environ.get("BRAIN_HOME", "./state")).expanduser()
ap = argparse.ArgumentParser()
ap.add_argument("--to", default=str(HOME / "backups"))
ap.add_argument("--keep", type=int, default=14)
ap.add_argument("--http", action="store_true")
a = ap.parse_args()

dest = Path(a.to).expanduser()
dest.mkdir(parents=True, exist_ok=True)
out = dest / f"brain-{datetime.now():%Y%m%d-%H%M%S}.db"

if a.http:
    from brain_mcp import DB_URL, sqld_query
    token = os.environ.get("BRAIN_DB_TOKEN") or Path(os.environ.get("BRAIN_DB_TOKEN_FILE", HOME / "keys" / "ro.jwt")).read_text().strip()
    q = lambda sql, args=(): sqld_query(sql, args, DB_URL, token)  # noqa: E731
    dst = sqlite3.connect(out)
    objects = q("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid")
    for o in objects:
        dst.execute(o["sql"])
    for o in objects:
        if o["type"] != "table":
            continue
        last = 0
        while True:
            rows = q(f'SELECT rowid AS _rid, * FROM "{o["name"]}" WHERE rowid > ? ORDER BY rowid LIMIT 500', (last,))
            if not rows:
                break
            cols = [c for c in rows[0] if c != "_rid"]
            dst.executemany(f'INSERT INTO "{o["name"]}" ({",".join(chr(34) + c + chr(34) for c in cols)}) VALUES ({",".join("?" * len(cols))})',
                            [tuple(r[c] for c in cols) for r in rows])
            last = rows[-1]["_rid"]
    dst.commit()
else:
    found = sorted(HOME.glob("sqld/**/dbs/default/data"))
    if not found:
        sys.exit(f"Could not find the database under {HOME / 'sqld'}. Has sqld started once? (Docker Desktop on Windows: use --http.)")
    src = sqlite3.connect(f"file:{found[0]}?mode=ro", uri=True, timeout=30)
    dst = sqlite3.connect(out)
    with dst:
        src.backup(dst)
    src.close()

ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
tables = dst.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
dst.close()
if ok != "ok":
    sys.exit(f"Backup written to {out} but the integrity check said: {ok}")
for old in sorted(dest.glob("brain-*.db"))[:-a.keep]:
    old.unlink()
print(f"Backup OK: {out} ({tables} tables)")

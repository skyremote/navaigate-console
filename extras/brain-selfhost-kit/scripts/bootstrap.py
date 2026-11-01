"""Create the brain tables on a fresh database server. Safe to run again.

    python scripts/bootstrap.py

Uses the read-write token ($BRAIN_HOME/keys/rw.jwt) and BRAIN_DB_URL (default http://127.0.0.1:8090).
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "connector"))
from brain_mcp import DB_URL, SqldError, _pipeline  # noqa: E402

HOME = Path(os.environ.get("BRAIN_HOME", "./state")).expanduser()
token = os.environ.get("BRAIN_DB_RW_TOKEN") or Path(os.environ.get("BRAIN_DB_RW_TOKEN_FILE", HOME / "keys" / "rw.jwt")).read_text().strip()

schema = (ROOT / "schema" / "schema.sql").read_text()
schema = re.sub(r"(?m)^--.*$", "", schema)
statements = [s.strip() for s in schema.split(";") if s.strip()]
names = [n for n in (ROOT / "schema" / "migrations_applied.txt").read_text().split() if n]

try:
    _pipeline([(s, ()) for s in statements], DB_URL, token)
    _pipeline([("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)", ())], DB_URL, token)
    _pipeline([("INSERT OR IGNORE INTO schema_migrations (filename, applied_at) VALUES (?, datetime('now'))", (n,)) for n in names], DB_URL, token)
    tables = _pipeline([("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name", ())], DB_URL, token)[0]
except (SqldError, OSError) as exc:
    sys.exit(f"Bootstrap failed: {exc}")
print(f"Ready. {len(tables)} tables: " + ", ".join(t["name"] for t in tables))

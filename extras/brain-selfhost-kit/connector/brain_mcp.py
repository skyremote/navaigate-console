"""Brain MCP connector (read-only), starter kit version.

What it does
    Serves your brain to AI clients over MCP (streamable HTTP). Three tools:
    brain_search, brain_read, brain_query. No tool can write.

How it stays read-only
    1. The connector talks to your database server (sqld) with a read-only token
       (JWT claim "a":"ro"). The server itself refuses every write.
    2. brain_query only accepts a single SELECT.
    3. There are no write tools.

How clients are let in
    Each client has its own bearer token. The connector stores only the SHA-256
    hash of each token, in a small JSON file (see scripts/client_token.py). Delete
    a client's entry and that client is out immediately, no restart needed.

Search
    The connector keeps its own small SQLite file (FTS5, BM25 ranking with a recency
    boost) built by reading your brain over HTTP. It refreshes itself every
    BRAIN_REFRESH_SECONDS. Delete the file any time; it rebuilds.

Everything is configured with environment variables (see .env.example):
    BRAIN_DB_URL            where sqld listens            (default http://127.0.0.1:8090)
    BRAIN_DB_TOKEN          read-only JWT for sqld        (or BRAIN_DB_TOKEN_FILE)
    BRAIN_HOME              state folder                  (default ./state)
    BRAIN_MCP_TOKENS        hashed client tokens file     (default $BRAIN_HOME/connector/tokens.json)
    BRAIN_INDEX_PATH        search index file             (default $BRAIN_HOME/connector/index.db)
    BRAIN_MCP_BIND          interface to listen on        (default 127.0.0.1)
    BRAIN_MCP_PORT          port                          (default 8765)
    BRAIN_MCP_HOSTS         public hostname(s), comma separated (the Host header your clients use)
    BRAIN_MCP_ORIGINS       extra allowed browser origins, comma separated
    BRAIN_REFRESH_SECONDS   index refresh interval        (default 60)

Run:  python connector/brain_mcp.py            (serve)
      python connector/brain_mcp.py --reindex  (rebuild the index once and exit)
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------- config
HOME = Path(os.environ.get("BRAIN_HOME", "./state")).expanduser()
DB_URL = os.environ.get("BRAIN_DB_URL", "http://127.0.0.1:8090").rstrip("/")
TOKENS_PATH = Path(os.environ.get("BRAIN_MCP_TOKENS", str(HOME / "connector" / "tokens.json"))).expanduser()
INDEX_PATH = Path(os.environ.get("BRAIN_INDEX_PATH", str(HOME / "connector" / "index.db"))).expanduser()
REFRESH_SECONDS = int(os.environ.get("BRAIN_REFRESH_SECONDS", "60"))
USER_AGENT = "brain-kit/1.0"  # some proxies (Cloudflare) block the default Python agent


def _db_token() -> str:
    token = os.environ.get("BRAIN_DB_TOKEN", "").strip()
    path = os.environ.get("BRAIN_DB_TOKEN_FILE", "").strip()
    if not token and path:
        token = Path(path).expanduser().read_text().strip()
    if not token:
        raise SystemExit("Set BRAIN_DB_TOKEN or BRAIN_DB_TOKEN_FILE (the read-only sqld token from scripts/mint.py).")
    return token


# --------------------------------------------------------------------------- sqld client (Hrana over HTTP)
class SqldError(Exception):
    pass


def _encode(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    if isinstance(value, (bytes, bytearray)):
        return {"type": "blob", "base64": base64.b64encode(value).decode()}
    return {"type": "text", "value": str(value)}


def _decode(cell):
    kind = cell.get("type")
    if kind == "null":
        return None
    if kind == "integer":
        return int(cell["value"])
    if kind == "float":
        return float(cell["value"])
    if kind == "blob":
        return base64.b64decode(cell["base64"] + "=" * (-len(cell["base64"]) % 4))
    return cell["value"]


def _pipeline(statements: list[tuple[str, tuple]], url: str | None = None, token: str | None = None) -> list[list[dict]]:
    """Send statements to sqld in one request (one transaction-free batch). Returns rows per statement."""
    requests = [{"type": "execute", "stmt": {"sql": sql, "args": [_encode(a) for a in args]}} for sql, args in statements]
    body = json.dumps({"requests": requests + [{"type": "close"}]}).encode()
    req = urllib.request.Request(
        (url or DB_URL) + "/v2/pipeline", data=body, method="POST",
        headers={"Authorization": f"Bearer {token or _db_token()}", "Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise SqldError(f"sqld said {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise SqldError(f"cannot reach sqld at {url or DB_URL}: {exc.reason}") from exc
    out = []
    for item in data["results"][:len(statements)]:
        if item["type"] == "error":
            raise SqldError(item["error"].get("message", "sql error"))
        result = item["response"]["result"]
        names = [c["name"] for c in result["cols"]]
        rows = [dict(zip(names, (_decode(c) for c in row))) for row in result["rows"]]
        if not names:
            rows = [{"affected_rows": result.get("affected_row_count"), "last_insert_rowid": result.get("last_insert_rowid")}]
        out.append(rows)
    return out


def sqld_query(sql: str, args=(), url: str | None = None, token: str | None = None) -> list[dict]:
    """Run one statement against sqld and return rows as dicts."""
    return _pipeline([(sql, tuple(args))], url, token)[0]


# --------------------------------------------------------------------------- search index
KIND_BOOST = {"digest": 1.6, "transcript": 1.25, "finding": 1.15, "note": 1.1, "task": 1.1,
              "person": 1.0, "source": 1.0, "run": 1.0, "message": 1.0}
STOP_WORDS = set("a about all also an and any are as at be but by can did do does for from had has have how i if in "
                 "into is it its just me my of on or our so that the their them then there these they this to us was "
                 "we were what when where which who why will with would you your".split())
TERM_RE = re.compile(r"[\w][\w.'-]*", re.UNICODE)
CHUNK = 4000
SPLIT_OVER = 6000

# kind, table, id column, SQL pieces: title, body, ts, mode ("full" = rebuilt each refresh, "grow" = new rows only)
SOURCES = [
    ("note", "notes", "id", "title", "COALESCE(tags,'') || ' ' || COALESCE(source,'') || ' ' || COALESCE(drive_path,'') || ' ' || COALESCE(obsidian_path,'')", "created_at", "full"),
    ("task", "tasks", "id", "title", "COALESCE(status,'') || ' ' || COALESCE(venture,'') || ' ' || COALESCE(due,'')", "updated_at", "full"),
    ("finding", "findings", "id", "substr(claim,1,80)", "claim || char(10) || COALESCE(support,'')", "created_at", "full"),
    ("source", "sources", "id", "COALESCE(title,url,'')", "COALESCE(url,'') || ' ' || COALESCE(platform,'')", "created_at", "full"),
    ("run", "research_runs", "id", "topic", "COALESCE(question,'')", "started_at", "full"),
    ("person", "people", "id", "name", "COALESCE(org,'') || ' ' || COALESCE(role,'') || ' ' || COALESCE(notes,'')", "updated_at", "full"),
    ("digest", "knowledge_digests", "id", "COALESCE(title,'')", "summary || char(10) || COALESCE(questions_json,'') || char(10) || COALESCE(atoms_json,'')", "updated_at", "grow"),
    ("transcript", "media_transcripts", "id", "COALESCE(title,'')", "transcript", "fetched_at", "grow"),
    ("message", "conversation_messages", "id", "role", "text", "timestamp", "grow"),
]
TABLE_FOR_KIND = {k: (t, idc) for k, t, idc, *_ in SOURCES}

INDEX_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS docs (
    rowid INTEGER PRIMARY KEY, doc_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, ref TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, ts TEXT, ts_epoch REAL
);
CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    title, body, content='docs', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); END;
"""

_index_lock = threading.Lock()
_index: sqlite3.Connection | None = None


def _open_index() -> sqlite3.Connection:
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(INDEX_PATH, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.executescript(INDEX_SCHEMA)
    try:
        os.chmod(INDEX_PATH, 0o600)  # it holds a copy of your brain's text
    except OSError:
        pass
    return conn


def _epoch(value) -> float | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def _chunks(text: str) -> list[str]:
    if len(text) <= SPLIT_OVER:
        return [text]
    return [text[i:i + CHUNK] for i in range(0, len(text), CHUNK)]


def _add_docs(conn: sqlite3.Connection, kind: str, ident, title: str, body: str, ts) -> None:
    body = (body or "").strip()
    if not body and not title:
        return
    parts = _chunks(body)
    for n, part in enumerate(parts):
        doc_id = f"{kind}:{ident}" + (f"#{n}" if len(parts) > 1 else "")
        conn.execute("DELETE FROM docs WHERE doc_id = ?", (doc_id,))
        conn.execute("INSERT INTO docs (doc_id, kind, ref, title, body, ts, ts_epoch) VALUES (?,?,?,?,?,?,?)",
                     (doc_id, kind, f"{kind}:{ident}", title or "", part, ts, _epoch(ts)))


def refresh_index(rebuild: bool = False) -> dict:
    """Read the brain over HTTP and bring the index up to date. Returns counts per kind."""
    global _index
    counts: dict[str, int] = {}
    with _index_lock:
        if _index is None:
            _index = _open_index()
        conn = _index
        if rebuild:
            conn.executescript("DELETE FROM docs; DELETE FROM meta; INSERT INTO docs_fts(docs_fts) VALUES('rebuild');")
        for kind, table, idc, title_sql, body_sql, ts_sql, mode in SOURCES:
            key = f"cursor:{kind}"
            cur = int((conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone() or [0])[0]) if mode == "grow" else 0
            try:
                if mode == "full":
                    rows = []
                    last = 0
                    while True:
                        page = sqld_query(
                            f"SELECT rowid AS _rid, {idc} AS _id, {title_sql} AS _title, {body_sql} AS _body, {ts_sql} AS _ts "
                            f"FROM {table} WHERE rowid > ? ORDER BY rowid LIMIT 500", (last,))
                        rows += page
                        if len(page) < 500:
                            break
                        last = page[-1]["_rid"]
                    conn.execute("DELETE FROM docs WHERE kind = ?", (kind,))
                    for r in rows:
                        _add_docs(conn, kind, r["_id"], r["_title"], r["_body"], r["_ts"])
                    counts[kind] = len(rows)
                else:
                    added = 0
                    while True:
                        page = sqld_query(
                            f"SELECT rowid AS _rid, {idc} AS _id, {title_sql} AS _title, {body_sql} AS _body, {ts_sql} AS _ts "
                            f"FROM {table} WHERE rowid > ? ORDER BY rowid LIMIT 200", (cur,))
                        for r in page:
                            _add_docs(conn, kind, r["_id"], r["_title"], r["_body"], r["_ts"])
                        added += len(page)
                        if page:
                            cur = page[-1]["_rid"]
                            conn.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(cur)))
                            conn.commit()
                        if len(page) < 200:
                            break
                    counts[kind] = added
            except SqldError as exc:
                if "no such table" in str(exc).lower():
                    counts[kind] = 0  # table not in your schema: skip
                    continue
                raise
            conn.commit()
        conn.execute("INSERT INTO meta(key,value) VALUES('refreshed_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(time.time()),))
        conn.commit()
    return counts


def _terms(query: str) -> list[str]:
    terms = [t.lower().strip(".'-") for t in TERM_RE.findall(query)]
    useful = [t for t in terms if t and t not in STOP_WORDS]
    return useful or [t for t in terms if t]


def search(query: str, limit: int = 8, kinds=None, days=None, recency: bool = True, half_life_days: float = 30.0) -> list[dict]:
    terms = _terms(query)
    if not terms:
        raise ValueError("search needs at least one word")
    limit = max(1, min(int(limit), 25))
    quoted = ['"' + t.replace('"', '') + '"' for t in terms]
    where, extra = "", []
    if kinds:
        where += f" AND d.kind IN ({','.join('?' * len(kinds))})"
        extra += list(kinds)
    if days:
        where += " AND d.ts_epoch >= ?"
        extra.append(time.time() - float(days) * 86400)
    sql = (f"SELECT d.doc_id, d.kind, d.ref, d.title, d.ts, d.ts_epoch, bm25(docs_fts, 3.0, 1.0) AS score, "
           f"snippet(docs_fts, 1, '[', ']', ' ... ', 24) AS excerpt FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid "
           f"WHERE docs_fts MATCH ?{where} ORDER BY score LIMIT 200")
    with _index_lock:
        conn = _index or _open_index()
        rows = conn.execute(sql, [" AND ".join(quoted)] + extra).fetchall()
        if len(rows) < limit and len(quoted) > 1:
            rows = conn.execute(sql, [" OR ".join(quoted)] + extra).fetchall()
    now, hits, seen = time.time(), [], {}
    for r in rows:
        score = -r["score"] * KIND_BOOST.get(r["kind"], 1.0)
        if recency and r["ts_epoch"]:
            score *= 1 + math.pow(2, -max(0.0, now - r["ts_epoch"]) / 86400 / half_life_days)
        hits.append((score, r))
    hits.sort(key=lambda h: h[0], reverse=True)
    out = []
    for score, r in hits:
        if seen.get(r["ref"], 0) >= 2:
            continue
        seen[r["ref"]] = seen.get(r["ref"], 0) + 1
        out.append({"ref": r["ref"], "kind": r["kind"], "title": r["title"], "when": r["ts"], "score": round(score, 3), "excerpt": r["excerpt"]})
        if len(out) >= limit:
            break
    return out


def read_ref(ref: str, max_chars: int = 12000, start: int = 0) -> dict:
    kind, _, ident = ref.partition(":")
    if kind not in TABLE_FOR_KIND or not ident:
        raise ValueError(f"unknown ref '{ref}'. Use a ref from brain_search, like note:3 or finding:7")
    table, idc = TABLE_FOR_KIND[kind]
    rows = sqld_query(f"SELECT * FROM {table} WHERE {idc} = ? LIMIT 1", (int(ident) if ident.isdigit() else ident,))
    if not rows:
        raise ValueError(f"nothing found for {ref}")
    row = rows[0]
    for key, val in list(row.items()):
        if isinstance(val, str) and len(val) > max_chars:
            row[key] = val[start:start + max_chars]
            row[f"{key}_note"] = f"showing characters {start} to {start + max_chars} of {len(val)}; pass start to read on"
        elif isinstance(val, (bytes, bytearray)):
            row[key] = f"<{len(val)} bytes>"
    return row


def run_query(sql: str) -> list[dict]:
    raw = sql.strip().rstrip(";").strip()
    if not re.match(r"(?is)^(select|with)\b", raw):
        raise ValueError("brain_query only accepts a single SELECT statement")
    if ";" in raw:
        raise ValueError("brain_query accepts one statement only (no semicolons)")
    return sqld_query(f"SELECT * FROM ({raw}) LIMIT 500")  # the read-only token is the real guard


# --------------------------------------------------------------------------- client tokens
def load_tokens() -> dict:
    try:
        return json.loads(TOKENS_PATH.read_text())
    except (OSError, ValueError):
        return {}


def authenticate(header: str | None) -> str | None:
    """Return the client name for a valid Bearer header, else None."""
    if not header or not header.lower().startswith("bearer "):
        return None
    digest = hashlib.sha256(header[7:].strip().encode()).hexdigest()
    found = None
    for name, rec in load_tokens().items():  # no early exit
        if hmac.compare_digest(digest, str(rec.get("sha256", ""))) and rec.get("scope", "read") == "read":
            found = name
    return found


# --------------------------------------------------------------------------- MCP server
TOOLS_SPEC = [
    ("brain_search", "Search the brain by keyword: notes, tasks, findings, sources, people, digests, transcripts and chat messages. "
     "Returns refs; call brain_read with a ref to open one.",
     {"type": "object", "required": ["query"], "properties": {
         "query": {"type": "string", "description": "Words to look for"},
         "limit": {"type": "integer", "default": 8, "description": "Max hits (1 to 25)"},
         "kinds": {"type": "array", "items": {"type": "string"}, "description": "Limit to kinds such as note, task, finding, message"},
         "days": {"type": "number", "description": "Only items from the last N days"},
         "recency": {"type": "boolean", "default": True}}}),
    ("brain_read", "Open one item by the ref from brain_search (for example finding:7).",
     {"type": "object", "required": ["ref"], "properties": {
         "ref": {"type": "string"}, "max_chars": {"type": "integer", "default": 12000}, "start": {"type": "integer", "default": 0}}}),
    ("brain_query", "Run one read-only SQL SELECT against the brain (500 rows at most).",
     {"type": "object", "required": ["sql"], "properties": {"sql": {"type": "string"}}}),
]


def _dispatch(name: str, args: dict):
    if name == "brain_search":
        return {"query": args["query"], "hits": search(args["query"], args.get("limit", 8), args.get("kinds"), args.get("days"), args.get("recency", True))}
    if name == "brain_read":
        return read_ref(args["ref"], int(args.get("max_chars", 12000)), int(args.get("start", 0)))
    if name == "brain_query":
        return run_query(args["sql"])
    raise ValueError(f"unknown tool: {name}")


def build_app():
    import anyio.to_thread
    import mcp.types as types
    from mcp.server import Server
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from mcp.server.transport_security import TransportSecuritySettings
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    server: Server = Server("brain")

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [types.Tool(name=n, description=d, inputSchema=s) for n, d, s in TOOLS_SPEC]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict | None) -> types.CallToolResult:
        if name not in {n for n, _, _ in TOOLS_SPEC}:
            raise ValueError(f"unknown tool: {name}")
        try:
            result = await anyio.to_thread.run_sync(_dispatch, name, dict(arguments or {}))
        except (ValueError, SqldError, sqlite3.Error, KeyError) as exc:
            return types.CallToolResult(content=[types.TextContent(type="text", text=f"error: {exc}")], isError=True)
        return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=1))])

    hosts = [h.strip() for h in os.environ.get("BRAIN_MCP_HOSTS", "").split(",") if h.strip()]
    allowed_hosts = ["127.0.0.1:*", "localhost:*", "connector:*"] + hosts + [f"{h}:*" for h in hosts if ":" not in h]
    origins = ["https://*.x.ai", "https://grok.com", "https://*.grok.com", "http://127.0.0.1:*", "http://localhost:*"]
    origins += [o.strip() for o in os.environ.get("BRAIN_MCP_ORIGINS", "").split(",") if o.strip()]

    manager = StreamableHTTPSessionManager(
        app=server, json_response=True, stateless=True,
        security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=allowed_hosts, allowed_origins=origins),
    )

    class MCPEndpoint:
        async def __call__(self, scope, receive, send):
            await manager.handle_request(scope, receive, send)

    def _refresher() -> None:
        while True:
            try:
                refresh_index()
            except Exception as exc:  # noqa: BLE001 - keep serving, try again next tick
                print(f"index refresh failed: {exc}", file=sys.stderr, flush=True)
            time.sleep(REFRESH_SECONDS)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        threading.Thread(target=_refresher, daemon=True).start()
        async with manager.run():
            yield

    async def health(_request):
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/health", health), Route("/mcp", MCPEndpoint())], lifespan=lifespan)

    async def guarded(scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/health":
            headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
            client = authenticate(headers.get("authorization"))
            if client is None:
                resp = JSONResponse({"error": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
                return await resp(scope, receive, send)
            print(f"client={client} path={scope['path']}", flush=True)
        await app(scope, receive, send)

    return guarded


def main() -> None:
    if "--reindex" in sys.argv:
        print(json.dumps(refresh_index(rebuild=True)))
        return
    _db_token()  # fail early with a clear message
    import uvicorn
    uvicorn.run(build_app(), host=os.environ.get("BRAIN_MCP_BIND", "127.0.0.1"),
                port=int(os.environ.get("BRAIN_MCP_PORT", "8765")), log_level="warning")


if __name__ == "__main__":
    main()

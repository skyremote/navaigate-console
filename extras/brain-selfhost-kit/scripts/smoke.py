"""Check the whole chain from the outside, the way a client sees it.

    python scripts/smoke.py --url http://127.0.0.1:8765/mcp --token brk_... [--search "word that is in your brain"]

Checks: no token is refused, a wrong token is refused, tools/list shows the three tools, a search works,
brain_query refuses to write. With --db-url and --ro-token-file it also proves the server itself refuses writes.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:8765/mcp")
ap.add_argument("--token", required=True)
ap.add_argument("--search", default="")
ap.add_argument("--db-url")
ap.add_argument("--ro-token-file")
a = ap.parse_args()
results = []


def post(url, payload, token=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": "brain-kit-smoke/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (f"  ({detail})" if detail else ""))


def call(method, params=None, i=1):
    return post(a.url, {"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}, a.token)


check("no token is refused", post(a.url, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})[0] == 401)
check("wrong token is refused", post(a.url, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, "brk_wrong")[0] == 401)
code, body = call("tools/list")
names = sorted(t["name"] for t in body.get("result", {}).get("tools", []))
check("tools/list shows the three read tools", code == 200 and names == ["brain_query", "brain_read", "brain_search"], ", ".join(names))
if a.search:
    code, body = call("tools/call", {"name": "brain_search", "arguments": {"query": a.search}}, 2)
    text = body.get("result", {}).get("content", [{}])[0].get("text", "{}")
    hits = json.loads(text).get("hits", []) if code == 200 and not body["result"].get("isError") else []
    check(f"search for '{a.search}' finds something", bool(hits), f"{len(hits)} hits" + (f", first {hits[0]['ref']}" if hits else ""))
    if hits:
        code, body = call("tools/call", {"name": "brain_read", "arguments": {"ref": hits[0]["ref"]}}, 3)
        check("brain_read opens the first hit", code == 200 and not body["result"].get("isError"))
code, body = call("tools/call", {"name": "brain_query", "arguments": {"sql": "DELETE FROM notes"}}, 4)
check("brain_query refuses a write", code == 200 and body["result"].get("isError") is True)
code, body = call("tools/call", {"name": "brain_query", "arguments": {"sql": "SELECT count(*) AS n FROM sqlite_master"}}, 5)
check("brain_query runs a SELECT", code == 200 and not body["result"].get("isError"))
if a.db_url and a.ro_token_file:
    tok = open(a.ro_token_file).read().strip()
    req = urllib.request.Request(a.db_url.rstrip("/") + "/v2/pipeline", method="POST",
        data=json.dumps({"requests": [{"type": "execute", "stmt": {"sql": "CREATE TABLE smoke_should_fail (a)"}}, {"type": "close"}]}).encode(),
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "User-Agent": "brain-kit-smoke/1.0"})
    try:
        urllib.request.urlopen(req, timeout=15); check("the server refuses a write with the read-only token", False, "write went through")
    except urllib.error.HTTPError as e:
        check("the server refuses a write with the read-only token", e.code in (401, 403), f"HTTP {e.code}")
print(f"\n{sum(results)} of {len(results)} checks passed")
sys.exit(0 if all(results) else 1)

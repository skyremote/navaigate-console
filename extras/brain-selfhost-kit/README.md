# Brain self-host starter kit, v2

Run your own brain (structured memory) on a Mac, Linux, Windows or a VPS, and connect Claude Code, Claude Desktop, Cursor, GrokBot and other MCP clients to it. The step-by-step guide is `self-host-your-brain_v2.md` (it comes with this folder). This README is the map.

Licence: MIT (see `LICENSE`). Copyright (c) 2026 NavAIgate GmbH & Co. KG. The kit has not been published anywhere yet.

## What is in the folder

| Path | What it is |
|---|---|
| `docker-compose.yml` | Database server (sqld) and the connector. Optional profiles: `tunnel` (Cloudflare Tunnel), `caddy` (HTTPS on a VPS), `tools` (one-off helper scripts) |
| `connector/brain_mcp.py` | The MCP connector. Read-only: `brain_search`, `brain_read`, `brain_query`. Per-client bearer tokens, stored as hashes |
| `connector/Dockerfile` | Builds the connector (and the helper scripts) into one image |
| `scripts/mint.py` | Makes the signing keys and the database tokens (read-write and read-only). Needs `cryptography` |
| `scripts/client_token.py` | `add`, `list`, `revoke` one token per AI client |
| `scripts/bootstrap.py` + `schema/` | Creates the 11 brain tables on a fresh server |
| `scripts/brain.py` | Writes a note, task or finding without any other tools |
| `scripts/smoke.py` | Checks the whole chain from a client's point of view |
| `scripts/backup.py` | Consistent copy of the database, 14 kept (file mode, or `--http` for Docker Desktop and remote) |
| `scripts/get-sqld.sh` | Downloads the pinned database server (0.24.32) for Mac or Linux |
| `deploy/launchd/` | Mac: `install.sh` makes three LaunchAgents (server, connector, nightly backup) |
| `deploy/systemd/` | Linux: server, connector, backup service and timer |
| `deploy/windows/backup-task.ps1` | Windows nightly backup task |
| `Caddyfile` | HTTPS for a VPS |
| `.env.example` | The few settings Docker Compose reads |
| `LICENSE` | MIT |

## Fastest start (Mac or Linux, no Docker)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
sh scripts/get-sqld.sh
export BRAIN_HOME="$HOME/.brain"
.venv/bin/python scripts/mint.py init
sh deploy/launchd/install.sh                     # Mac. Linux: see the guide, section 4
.venv/bin/python scripts/bootstrap.py
.venv/bin/python scripts/client_token.py add me  # prints the token once
```

With Docker (Linux, VPS): `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python scripts/mint.py init && docker compose up -d --build`, then `scripts/bootstrap.py`.

## Settings (environment variables)

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `BRAIN_HOME` | all scripts, connector | `./state` | Where keys, tokens, backups and the search file live |
| `BRAIN_DB_URL` | scripts, connector | `http://127.0.0.1:8090` | Where the database server listens |
| `BRAIN_DB_TOKEN` / `BRAIN_DB_TOKEN_FILE` | connector, `backup.py --http` | none | Read-only database token (`keys/ro.jwt`) |
| `BRAIN_DB_RW_TOKEN` / `BRAIN_DB_RW_TOKEN_FILE` | `bootstrap.py`, `brain.py` | `$BRAIN_HOME/keys/rw.jwt` | Read-write database token |
| `BRAIN_MCP_TOKENS` | connector, `client_token.py` | `$BRAIN_HOME/connector/tokens.json` | Hashed client tokens |
| `BRAIN_INDEX_PATH` | connector | `$BRAIN_HOME/connector/index.db` | Search file (rebuilds itself if deleted) |
| `BRAIN_MCP_BIND`, `BRAIN_MCP_PORT` | connector | `127.0.0.1`, `8765` | Where the connector listens |
| `BRAIN_MCP_HOSTS` | connector | none (localhost only) | Your public name(s), comma separated |
| `BRAIN_MCP_ORIGINS` | connector | Grok and localhost | Extra allowed browser origins |
| `BRAIN_REFRESH_SECONDS` | connector | `60` | How often new items reach the search |

## What was tested (1 November 2026)

- On an Apple silicon Mac, localhost only, throwaway keys, native sqld: key and token minting; table bootstrap (twice, safe to repeat); writing rows; connector tools/list, search, read and query; no token and wrong token refused; wrong Host refused (421) and a listed Host accepted; the database refusing a write with the read-only token (HTTP 403); revoking a client (401 at once); both backup modes; the pinned requirements installing in a fresh virtual environment; `get-sqld.sh`; the three launchd services starting, restarting after a kill, and uninstalling; Claude Code connecting and calling `brain_search`; `mcp-remote` connecting; the `aios` command line from the harness (libsql 0.1.8) writing to this server.
- On Docker Desktop 29.2.1 (Compose 5.1, Apple silicon, Linux engine), isolated folder, throwaway keys, spare localhost ports: `docker compose up -d --build`; tables, writes, search, the same eight smoke checks (8 of 8), 403 and 421 refusals, revoke, restart with data intact, file and `--http` backups, the Linux-style flow (bind mount, helper scripts on the host) and the Windows-style flow (Docker volume via `SQLD_DATA=brain_sqld_data`, helper scripts in the `tools` container); `caddy validate` on the Caddyfile; `docker compose config` with the caddy and tunnel profiles. Everything the test created was removed afterwards.
- Written, not run: the systemd files, Windows itself (PowerShell lines, scheduled backup task), a real VPS and a real HTTPS certificate, the Cloudflare Tunnel token route and the `cloudflared` container, Tailscale, Cursor, the Claude Desktop app, GrokBot.
- Not in this release: OAuth. Claude.ai and ChatGPT web connectors need it and come in a later release.

## Notes for the maintainer

- The connector reads the database over HTTP (Hrana) with a read-only token and builds its own search file. It does not use the `aios` package or the `libsql` Python package, so it runs on any OS. The author's own live connector reads an embedded replica instead; the kit's version is a simplified rewrite, not a copy.
- Search sources: notes, tasks, findings, sources, research runs, people (rebuilt each refresh) and digests, transcripts, chat messages (new rows only, added as they arrive; edits to old rows appear after `--reindex`).
- The `aios` CLI needs `libsql==0.1.8`: later versions only speak Turso's cloud protocol.
- Third-party software: sqld (MIT), mcp Python SDK (MIT), uvicorn and starlette (BSD), cryptography (Apache 2.0 or BSD), Caddy and cloudflared (Apache 2.0).

# Self-host your own brain, and connect your AI to it

Version 2, 1 November 2026. Written for people who use my harness and want their own brain (the structured memory), running on their own machine, instead of using mine.

Mine runs on an always-on Mac at home, behind a private address of my own. You will not have that, and you do not need it. In this guide we build the same thing on whatever you have: a Mac, a Linux box, a Windows PC or a rented server (a VPS). Then we connect Claude, Cursor, GrokBot and anything else that speaks MCP.

Every section says what we actually tested and what we only wrote down. I would rather you know that before you start than find out at step nine.

## What is in this guide

1. What the brain is, and the three parts
2. Which option to pick
3. Option A: a Mac at home
4. Option B: Linux (Docker Compose, or systemd)
5. Option C: Windows
6. Option D: a VPS
7. A private address without opening router ports
8. Connecting your AI clients
9. Putting things in the brain
10. Security basics
11. When something does not work

---

## 1. What the brain is, and the three parts

The brain is one database that holds the things you want your AI to remember: notes, tasks, findings from research, people, sources, summaries of past chats, and video transcripts. Every AI tool you use can look things up in it, so you stop explaining yourself from scratch in every new chat.

It has three parts, and we set up all three:

1. **The database server.** A small program called sqld (the open-source server behind Turso). It holds your data in one file on your own disk and only answers to requests that carry a signed token.
2. **A private address.** A web address your AI clients can reach, such as https://brain.example.com, that leads to your machine without opening a single port on your router. We use a Cloudflare Tunnel for this. If you only need it on your own devices, Tailscale does the job without buying a domain.
3. **The MCP connector.** A second small program that sits between your AI clients and the database. It answers three questions only: search the brain, open one item, and run a read-only query. It cannot write, and each client gets its own token that you can cancel at any time.

Here is the diagram, in words. Picture three boxes in a row, left to right. On the far left is your AI client (Claude, Cursor, GrokBot). An arrow goes from it to the middle box, the private address, and that arrow carries the client's own token over HTTPS. A second arrow goes from the private address to the connector, which sits on your machine. A third arrow goes from the connector to the database server on the same machine, and that arrow carries a different token, a read-only one. The database file sits under the server. Your own scripts and the aios command line (if you use my harness) go straight to the database server with a read and write token, and they never go through the connector.

So there are two kinds of token, and it matters:

- **Database tokens** (called JWTs) belong to you. One lets you read and write, and one only lets you read. The connector holds the read-only one, so even if we made a mistake in the connector, the database itself would refuse to write.
- **Client tokens** are one per AI client. The connector keeps only a scrambled copy (a hash), so nobody can read them back, including you.

### What the starter kit gives you

A folder called `brain-selfhost-kit`, which comes with this guide. It is MIT licensed, so you can use it, change it and share it, and the licence text is in the `LICENSE` file. In it:

- `docker-compose.yml` runs the database server and the connector, plus an optional tunnel and an optional HTTPS front for a VPS.
- `connector/brain_mcp.py` is the connector, one file.
- `scripts/` has `mint.py` (makes the keys and database tokens), `client_token.py` (one token per AI client), `bootstrap.py` (creates the tables), `brain.py` (puts things in), `backup.py`, `smoke.py` (checks everything) and `get-sqld.sh` (downloads the server for Mac and Linux).
- `schema/schema.sql` creates the 11 tables of the brain (notes, tasks, findings, sources, research runs, people, images, conversation sessions and messages, transcripts and digests) plus a small table that records the schema version. My own brain has a few more tables that my other tools add. These 11 are the core.
- `deploy/` has the launchd files for Mac, the systemd files for Linux and a backup task for Windows.

Put the folder somewhere permanent on the machine that will run the brain, and open a terminal in it.

### What we tested, in one place

On a Mac (Apple silicon, 1 November 2026) with throwaway keys, on localhost only, we ran the kit's own scripts and connector end to end: made the keys, created the tables, wrote rows, searched them through the connector, checked that a wrong token and no token are refused, checked that the database itself refuses a write with the read-only token, cancelled a client and saw it locked out at once, took a backup, and started everything as macOS background services that restart themselves. We also connected the real Claude Code to it and ran a search through Claude Code, and connected through `mcp-remote`, which is what Claude Desktop uses. We pointed my aios command line at the same server and wrote rows with it, and the connector found them.

We then ran the Docker Compose route for real, on a second Mac with Docker Desktop (Docker 29.2.1, Apple silicon, so a Linux engine), in a separate folder with throwaway keys and spare ports on localhost. We built the images, started the database server and the connector, and ran the same checks: made the keys, created the tables, wrote rows, searched through the connector, checked the refusals, cancelled a client, restarted both containers and found the data still there, and took a backup. We ran it two ways: the Linux way (bind-mounted folder, helper scripts on the host) and the Windows way (Docker volume, helper scripts inside a container), and both passed all eight checks. We also checked the Caddy file with Caddy's own validator, and then removed every container, image and volume we had made.

What we have **not** run: the Linux systemd files, Windows itself (as opposed to Docker Desktop on a Mac), a real VPS with a real HTTPS certificate, and the Cloudflare and Tailscale steps. Each section says so.

---

## 2. Which option to pick

| You have | Pick | What you need installed |
|---|---|---|
| A Mac that is on most of the time | A | Python 3.10 or newer (Homebrew), nothing else |
| A Linux machine | B | Docker (easiest), or Python 3.10 or newer |
| A Windows PC | C | Docker Desktop (easiest), or WSL2 and then follow B |
| No machine that stays on | D | A VPS from any provider, about 2 GB of memory is plenty |

If you want GrokBot or another cloud AI to reach your brain, the machine has to stay on, because those services call it from their side. A laptop that sleeps gets a "cannot connect" while it sleeps. For that case the VPS is the simplest choice.

The brain's data file must live on the machine's own disk. Never put it on a network share (a NAS folder, a mapped drive, Dropbox, Google Drive, iCloud). The database writes small files next to the main one and network and sync folders corrupt them. Backup files are fine on a share, because nothing opens them live.

---

## 3. Option A: a Mac at home

**Tested on:** macOS on Apple silicon, 1 November 2026, with this kit's scripts and launchd files, on localhost. This is the same arrangement my always-on Mac runs every day (sqld, a signed-token login, launchd, a Cloudflare Tunnel). My live connector on my always-on Mac uses my own code; the kit's connector is a cleaner version, and that is the one we tested here. The tunnel step is covered in section 7.

### A1. Install

We need Python 3.10 or newer, then the kit's libraries and the database server.

```bash
brew install python@3.12
cd ~/brain-selfhost-kit
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
sh scripts/get-sqld.sh
```

The last command downloads the database server into `bin/sqld` and prints its version (0.24.32).

### A2. Make the keys and the first start

We keep the brain's files in a hidden folder in your home folder, outside any synced folder.

```bash
export BRAIN_HOME="$HOME/.brain"
.venv/bin/python scripts/mint.py init
```

Keep using this same terminal window for the rest of this option, because the `export` only lasts for that window. If you open a new one, run the `export` line again.

That creates a key pair and two database tokens in `~/.brain/keys`: `rw.jwt` (read and write, for you) and `ro.jwt` (read only, for the connector). Nothing is printed, because nothing secret should go to your screen.

Now install and start the three background services (database server, connector, nightly backup):

```bash
sh deploy/launchd/install.sh
```

macOS now keeps them running and starts them when you log in. The logs are in `~/Library/Logs/brain`.

If you already have a name for the connector (a tunnel, section 7), add it now, so the connector accepts that name:

```bash
BRAIN_MCP_HOSTS=brain.example.com sh deploy/launchd/install.sh
```

### A3. Create the tables and add something

```bash
BRAIN_DB_URL=http://127.0.0.1:8090 .venv/bin/python scripts/bootstrap.py
BRAIN_DB_URL=http://127.0.0.1:8090 .venv/bin/python scripts/brain.py finding add "Acme prefers monthly billing and a six month minimum term"
```

The first command should end with "Ready. 12 tables" and list them. The second prints "Saved finding 1".

### A4. Make a client token and check it works

```bash
.venv/bin/python scripts/client_token.py add me
```

It prints a token that starts with `brk_`, once. Copy it somewhere safe now. Then wait a minute (the connector reads new items into its search every 60 seconds) and run the check:

```bash
.venv/bin/python scripts/smoke.py --url http://127.0.0.1:8765/mcp --token PASTE_THE_TOKEN --search billing --db-url http://127.0.0.1:8090 --ro-token-file "$HOME/.brain/keys/ro.jwt"
```

You want to see eight lines that start with PASS and then "8 of 8 checks passed". Those eight checks include that no token is refused, that a wrong token is refused, that all three tools are listed, that the search finds your finding, and that the database itself refuses a write with the read-only token.

### A5. Start on boot

Already done. `install.sh` made three launchd services that start at login and restart themselves if they stop. We killed the database server on purpose to check, and macOS had it running again within about fifteen seconds. If you want them to run with nobody logged in, turn on automatic login for that Mac user or use a dedicated Mac that stays logged in, because these are per-user services.

Also stop the Mac sleeping if it is your server: System Settings, Battery or Energy, and turn on "Prevent automatic sleeping when the display is off" (the exact words change between macOS versions).

To remove them: `sh deploy/launchd/install.sh uninstall`. Your data is left alone.

### A6. Back up every night

Already done too. The third service runs `scripts/backup.py` every night at 02:30 and keeps the newest 14 copies in `~/.brain/backups`. To run one now:

```bash
BRAIN_HOME="$HOME/.brain" .venv/bin/python scripts/backup.py
```

You should see "Backup OK" and a file name. Copy that folder to a drive or archive folder now and then, because a backup on the same disk does not help if the disk dies.

---

## 4. Option B: Linux

Two ways. Docker Compose is the easier one. systemd without Docker is there if you do not want Docker. Docker Compose is tested (on Docker Desktop, see B1) but not yet on a Linux machine itself. The systemd files are written but not yet tested. The Python code in both is the code we tested.

### B1. Docker Compose

**Tested on:** Docker Desktop 29.2.1 with Docker Compose 5.1 on an Apple silicon Mac (a Linux engine inside), 1 November 2026, in an isolated folder with throwaway keys and spare localhost ports. Built, started and checked end to end (all eight checks passed), including a restart of both containers with the data still there, both backup modes, and the cancel-a-client test. We have not run it on a native Linux host or a Raspberry Pi, so file ownership and Docker's start on boot are the parts to watch there.

Install Docker, and Python for the helper scripts:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt-get install -y python3-venv
```

Log out and back in once so the group change applies. Then, from the kit folder:

```bash
cd ~/brain-selfhost-kit
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/mint.py init
docker compose up -d --build
```

The keys must exist before `up`, because Docker would otherwise create empty folders where it expects the key files. The first start builds the connector image, which takes a minute or two.

Check both are running, create the tables and add a first item:

```bash
docker compose ps
.venv/bin/python scripts/bootstrap.py
.venv/bin/python scripts/brain.py finding add "Acme prefers monthly billing and a six month minimum term"
```

Make a client token and run the check, after a minute:

```bash
.venv/bin/python scripts/client_token.py add me
.venv/bin/python scripts/smoke.py --token PASTE_THE_TOKEN --search billing --db-url http://127.0.0.1:8090 --ro-token-file state/keys/ro.jwt
```

Start on boot: Docker starts with the machine, and both services have `restart: unless-stopped`, so they come back by themselves.

Back up every night (this reads the brain over the network with the read-only token, so it works whatever the file permissions are):

```bash
(crontab -l 2>/dev/null; echo "30 2 * * * cd $HOME/brain-selfhost-kit && .venv/bin/python scripts/backup.py --http >> state/backup.log 2>&1") | crontab -
```

The copies land in `state/backups`, newest 14 kept.

### B2. systemd, without Docker

**Tested on:** not yet on Linux. These files follow the launchd files we ran on the Mac, and the same commands are what the services run.

```bash
sudo apt-get install -y python3-venv curl xz-utils
sudo useradd --system --create-home --home-dir /var/lib/brain --shell /usr/sbin/nologin brain
sudo mkdir -p /opt/brain && sudo cp -r ~/brain-selfhost-kit/. /opt/brain/ && sudo chown -R brain:brain /opt/brain
sudo -u brain python3 -m venv /opt/brain/.venv
sudo -u brain /opt/brain/.venv/bin/pip install -r /opt/brain/requirements.txt
sudo -u brain sh /opt/brain/scripts/get-sqld.sh
sudo -u brain env BRAIN_HOME=/var/lib/brain /opt/brain/.venv/bin/python /opt/brain/scripts/mint.py init
```

Install the services, filling in your paths:

```bash
cd /opt/brain/deploy/systemd
for f in brain-sqld.service brain-connector.service brain-backup.service; do
  sudo sed -e 's|REPLACE_USER|brain|g' -e 's|REPLACE_KIT|/opt/brain|g' -e 's|REPLACE_BRAIN_HOME|/var/lib/brain|g' $f | sudo tee /etc/systemd/system/$f > /dev/null
done
sudo cp brain-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now brain-sqld brain-connector brain-backup.timer
```

If you have a public name (section 7), put it on the `Environment=BRAIN_MCP_HOSTS=` line of `/etc/systemd/system/brain-connector.service` and run `sudo systemctl restart brain-connector`.

Create the tables, add an item, make a token and check:

```bash
sudo -u brain env BRAIN_HOME=/var/lib/brain /opt/brain/.venv/bin/python /opt/brain/scripts/bootstrap.py
sudo -u brain env BRAIN_HOME=/var/lib/brain /opt/brain/.venv/bin/python /opt/brain/scripts/brain.py finding add "Acme prefers monthly billing and a six month minimum term"
sudo -u brain env BRAIN_HOME=/var/lib/brain /opt/brain/.venv/bin/python /opt/brain/scripts/client_token.py add me
sudo -u brain /opt/brain/.venv/bin/python /opt/brain/scripts/smoke.py --token PASTE_THE_TOKEN --search billing --db-url http://127.0.0.1:8090 --ro-token-file /var/lib/brain/keys/ro.jwt
```

Start on boot is the `enable` in the line above. Back up every night is the `brain-backup.timer`, which runs at 02:30 and writes to `/var/lib/brain/backups`. Check it with `systemctl list-timers brain-backup.timer`.

---

## 5. Option C: Windows

Two ways: Docker Desktop, or WSL2 (a Linux inside Windows), where you follow section 4.

**Tested on:** the Windows way of running it (Docker volume, helper scripts inside a container) passed all eight checks on Docker Desktop on a Mac, which uses the same Linux engine. Windows itself is **not tested**: the PowerShell lines, the scheduled backup task and Docker Desktop's start-at-sign-in setting are written but not run.

### C1. Docker Desktop

1. Install Docker Desktop from docker.com and let it turn on WSL2 when it asks. Restart if it says so.
2. Install Python 3.12 from python.org (tick "Add python.exe to PATH"). We only need it for the nightly backup.
3. Put the `brain-selfhost-kit` folder in your user folder, then open PowerShell in it.

The database must not sit in a Windows folder that Docker shares with Linux, because the database does not like that. So we keep it in a Docker volume:

```powershell
cd $HOME\brain-selfhost-kit
Copy-Item .env.example .env
Add-Content .env "SQLD_DATA=brain_sqld_data"
docker compose build
docker compose run --rm tools scripts/mint.py init
docker compose up -d
docker compose run --rm tools scripts/bootstrap.py
docker compose run --rm tools scripts/brain.py finding add "Acme prefers monthly billing and a six month minimum term"
docker compose run --rm -T tools scripts/client_token.py add me
```

The last command prints your client token, once. Copy it now. Wait a minute, then check the whole chain from inside Docker's network:

```powershell
docker compose run --rm tools scripts/smoke.py --url http://connector:8765/mcp --token PASTE_THE_TOKEN --search billing --db-url http://sqld:8080 --ro-token-file /state/keys/ro.jwt
```

Start on boot: in Docker Desktop, Settings, General, turn on "Start Docker Desktop when you sign in". Both services restart themselves after that.

Back up every night, from the kit folder in PowerShell, once:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\backup-task.ps1
```

That sets a Windows scheduled task called BrainBackup at 02:30. It reads the brain over the network, so it works with the Docker volume. Copies land in `state\backups`. To try it now: `python scripts\backup.py --http`.

### C2. WSL2

Open PowerShell as administrator and run `wsl --install -d Ubuntu`, restart, open Ubuntu, and follow section 4 (B1 with Docker Desktop's WSL integration turned on, or B2 for plain systemd; recent Ubuntu on WSL2 has systemd after you add `[boot]` and `systemd=true` to `/etc/wsl.conf`). Keep the kit and the data inside the Linux home folder, not under `/mnt/c`.

---

## 6. Option D: a VPS

**Tested on:** not on a real server. The Docker Compose pieces underneath are the ones tested in B1, and the `Caddyfile` passes Caddy's own `caddy validate` check. A real HTTPS certificate, the firewall lines and the public name are not tested.

Any Ubuntu 24.04 server with 1 to 2 GB of memory works. Create one, point a name at it (an A record, for example `brain.example.com`, with the server's address), then log in over SSH.

```bash
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y python3-venv ufw
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

Copy the `brain-selfhost-kit` folder to the server (`scp -r brain-selfhost-kit you@SERVER:~/`), then:

```bash
cd ~/brain-selfhost-kit
cp .env.example .env
sed -i 's|^BRAIN_DOMAIN=.*|BRAIN_DOMAIN=brain.example.com|' .env
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/mint.py init
docker compose --profile caddy up -d --build
```

Replace `brain.example.com` with your own name. Caddy gets the HTTPS certificate by itself the first time, which can take a minute, and the database and connector ports stay bound to the server itself (127.0.0.1), so only 80 and 443 are reachable from outside.

Create the tables and make a token, on the server:

```bash
.venv/bin/python scripts/bootstrap.py
.venv/bin/python scripts/client_token.py add me
```

Then, from your own computer, check that the public name answers:

```bash
curl https://brain.example.com/health
```

It should print `{"ok":true}`. And from any machine that has the kit's `scripts` folder, you can run the full check against the public name:

```bash
python3 scripts/smoke.py --url https://brain.example.com/mcp --token PASTE_THE_TOKEN
```

Start on boot: Docker restarts the containers after a reboot, so there is nothing to do. Back up every night:

```bash
(crontab -l 2>/dev/null; echo "30 2 * * * cd $HOME/brain-selfhost-kit && .venv/bin/python scripts/backup.py --http >> state/backup.log 2>&1") | crontab -
```

Copy `state/backups` off the server now and then (your provider's snapshot feature counts too).

The Caddy file also forwards everything that is not `/mcp` or `/health` to the database server, so your own other machines can write over HTTPS with the read and write token. If only the server itself writes, delete that last block in `Caddyfile` and run `docker compose --profile caddy restart caddy`.

**A cheaper variant without Caddy:** run `docker compose up -d --build` and use a Cloudflare Tunnel instead (section 7). Then you do not need to open ports 80 and 443 at all.

---

## 7. A private address without opening router ports

Your AI clients need an address to call. Both options below make one without touching your router.

### Cloudflare Tunnel (best when you have a domain)

**Tested on:** the setup is the same kind our own home server uses (one tunnel with two names, one for the database and one for the connector), set up with a config file. The one-line token version below is Cloudflare's own documented route, and we have not run it ourselves.

You need a domain whose DNS is on Cloudflare (a free Cloudflare account is enough).

1. In the Cloudflare dashboard open Zero Trust, then Networks, then Tunnels (menu names move around, look for Tunnels), and create a tunnel. Choose "Cloudflared", give it a name like `brain`, and copy the token it shows you.
2. Add a public hostname: `brain.example.com`, service type HTTP, URL below.
3. If your own other machines need to write to the database over the internet, add a second hostname, `db.example.com`, with the database URL below.

| Where cloudflared runs | Connector URL | Database URL |
|---|---|---|
| Docker Compose (any OS) | `connector:8765` | `sqld:8080` |
| Natively on the same machine (Mac, Linux) | `localhost:8765` | `localhost:8090` |

For Docker Compose, put the token in `.env` as `TUNNEL_TOKEN=...`, put your name in `BRAIN_MCP_HOSTS=brain.example.com`, and start it:

```bash
docker compose --profile tunnel up -d
```

For a Mac or Linux machine without Docker:

```bash
brew install cloudflared
cloudflared service install PASTE_THE_TUNNEL_TOKEN
```

On Linux install cloudflared from Cloudflare's package page, then use `sudo cloudflared service install PASTE_THE_TUNNEL_TOKEN`. Then tell the connector its public name (Mac: `BRAIN_MCP_HOSTS=brain.example.com sh deploy/launchd/install.sh`; Linux: the `BRAIN_MCP_HOSTS` line in the connector service file).

Check from anywhere:

```bash
curl https://brain.example.com/health
```

It must print `{"ok":true}`. A request to `/mcp` without a token must come back 401.

Two things to know. Cloudflare blocks the default Python web-request signature (error 1010), and the kit's own scripts already send their own, so they are fine; if your own script gets a 403 with 1010, set a User-Agent. And all the traffic goes through Cloudflare, who can see it, so the tokens are your protection. Keep them safe, and do not store anything in the brain that you could not accept Cloudflare seeing.

### Tailscale (no domain needed, for your own devices)

**Tested on:** not tested by us. We checked the command syntax against the Tailscale version on the Mac.

Tailscale makes a private network between your own devices. Install it on the brain machine and on each device that needs the brain (tailscale.com/download), sign in to the same account, then on the brain machine:

```bash
tailscale serve --bg 8765
```

That gives an address like `https://your-machine.your-tailnet.ts.net` that only your devices can open. Tell the connector that name (`BRAIN_MCP_HOSTS=your-machine.your-tailnet.ts.net`), and use `https://your-machine.your-tailnet.ts.net/mcp` in your clients.

Be clear about what this is good for. It works for Claude Code, Cursor and Claude Desktop on your own laptop and phone. It does **not** work for GrokBot or any cloud service, because those call from their servers and cannot join your private network. For those, use a Cloudflare Tunnel or a VPS. Tailscale also has `tailscale funnel --bg 8765`, which makes the same address public like a tunnel does, and we have not tried that one.

---

## 8. Connecting your AI clients

Everything here uses the same two things: the address ending in `/mcp`, and a token that starts with `brk_`. Make one token per client, so you can cancel one without touching the others:

```bash
.venv/bin/python scripts/client_token.py add grok
.venv/bin/python scripts/client_token.py add claude-code
.venv/bin/python scripts/client_token.py add cursor
```

(On Docker Desktop for Windows use `docker compose run --rm -T tools scripts/client_token.py add grok`.) In the examples below, `https://brain.example.com/mcp` is your address. If you are on the same machine, `http://127.0.0.1:8765/mcp` works for Claude Code and Cursor.

### Claude Code

**Tested on:** Claude Code on the Mac, against the kit's connector on localhost. `claude mcp list` showed it connected, and a one-line `claude -p` question made Claude call `brain_search` and return the right item.

```bash
claude mcp add --transport http brain https://brain.example.com/mcp --header "Authorization: Bearer brk_PASTE_YOUR_TOKEN"
```

Add `--scope user` if you want it in every project. Check with `claude mcp list`. Then ask it, for example, "search my brain for Acme billing".

### Claude Desktop

**Tested on:** the `mcp-remote` bridge that Claude Desktop uses was tested (it connected, listed the tools). We did not open the Claude Desktop app itself.

Claude Desktop reads a local config file and runs a small helper, `mcp-remote`, to reach a web address. You need Node.js installed. Open the config (Claude Desktop, Settings, Developer, Edit Config), which is `~/Library/Application Support/Claude/claude_desktop_config.json` on a Mac and `%APPDATA%\Claude\claude_desktop_config.json` on Windows, and add:

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://brain.example.com/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer brk_PASTE_YOUR_TOKEN" }
    }
  }
}
```

The header is written without a space after the colon, and the word Bearer lives in the `env` line. That avoids a known Windows problem with spaces. Restart Claude Desktop completely. For a plain `http://` address on your own machine, add `"--allow-http"` to the args.

### Cursor

**Tested on:** not tested. The format is from Cursor's documentation.

Open `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project, and add:

```json
{
  "mcpServers": {
    "brain": {
      "url": "https://brain.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:BRAIN_TOKEN}" }
    }
  }
}
```

Set `BRAIN_TOKEN` as an environment variable in your shell profile (`export BRAIN_TOKEN=brk_...`) and start Cursor from a shell that has it. You can paste the token straight in as well; the environment variable just keeps it out of the file.

### GrokBot (and Grok)

**Tested on:** the connector itself behind our always-on Mac, which is what we hand to Grok; the screens below are from our notes. We have not watched Grok connect from this Mac, and Grok's menus change, so names may differ a little.

Use a custom MCP connector, with:

- URL: `https://brain.example.com/mcp`
- Authentication: Bearer token (or "API key"), and paste the `brk_` token for Grok.

Through the xAI API, you pass the same thing as a tool of type `mcp` with a `server_url` of `https://brain.example.com/mcp` and an `authorization` value of `Bearer brk_...`.

The address must be public (a tunnel or a VPS), because Grok calls from its own servers. Grok's web page also sends browser requests from grok.com and x.ai, which the connector already allows. If you use another web client, add its address to `BRAIN_MCP_ORIGINS`.

### Any other MCP client

Anything that supports a remote MCP server over streamable HTTP with a custom header works. Give it the address, the header `Authorization: Bearer brk_...`, and nothing else. You can check by hand first with curl:

```bash
curl -s https://brain.example.com/mcp -H "Authorization: Bearer brk_PASTE_YOUR_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get back the three tools: `brain_search`, `brain_read` and `brain_query`.

### What does not work yet: Claude.ai and ChatGPT

To be straight about it: the Claude.ai website connectors and the ChatGPT web connectors do not accept a pasted token. They want a proper sign-in step (OAuth). OAuth is not in this release of the kit, so those two cannot connect to your brain yet. They come in a later release. Until then, Claude Code, Claude Desktop (through `mcp-remote`), Cursor, GrokBot and any other client that lets you set a bearer-token header all work.

---

## 9. Putting things in the brain

The connector only reads, on purpose. To put things in, you have two ways.

**The small script in the kit.** It writes straight to the database with the read and write token:

```bash
.venv/bin/python scripts/brain.py note add "Pricing call with Acme" --tags sales,acme --path "Docs/acme-call.md"
.venv/bin/python scripts/brain.py task add "Send the Acme proposal" --due 2026-12-01
.venv/bin/python scripts/brain.py finding add "Acme prefers monthly billing" --support "said on the 3 November call" --confidence 0.8
.venv/bin/python scripts/brain.py list findings
```

Notes are pointers (a title, tags and where the document lives), and findings carry the sentence itself, so write the facts you want searched later as findings. For another machine, set `BRAIN_DB_URL=https://db.example.com` and `BRAIN_DB_RW_TOKEN_FILE` to a copy of `rw.jwt`.

**My harness (the aios command line).** If you use it, it talks to your server with the same token. In the file `~/.config/navaigate/brain.env` put:

```
TURSO_DATABASE_URL=http://127.0.0.1:8090
TURSO_AUTH_TOKEN=PASTE_THE_CONTENTS_OF_rw.jwt
BRAIN_DB_PATH=~/.local/share/brain/aios-replica.db
```

(Use `https://db.example.com` instead of the first address if the server is on another machine.) Install `libsql==0.1.8` in the harness's Python, exactly that version, because later versions only speak Turso's cloud protocol and will not talk to your own server. Then `aios migrate` adds the two tables the kit leaves out, and `aios run add`, `aios finding add`, `aios note add` and the rest write to your server.

**Tested on:** the kit script and the aios command line, both on the Mac against localhost. We ran aios with a throwaway settings file, wrote a research run, a finding and a note, and the connector found them. Over the internet, aios needs the database address to carry its replication traffic. That works through Cloudflare Tunnel (it is how my own brain works), and we have not tested it through Caddy.

New items show up in the connector's search within a minute (`BRAIN_REFRESH_SECONDS`, default 60).

---

## 10. Security basics

- **Read-only by default.** The connector has no tool that writes, its query tool accepts one SELECT only, and it logs in to the database with a read-only token, so the database itself refuses writes. We tested that last point: a write with the read-only token comes back refused (HTTP 403).
- **One token per client.** Name them for what they are: `grok`, `claude-code`, `cursor-laptop`. Then losing one laptop costs you one revoke.
- **How to cancel a client.** `.venv/bin/python scripts/client_token.py revoke grok`. It takes effect on the next request, with no restart. We tested that: the cancelled token got a 401 straight away. List who has access with `client_token.py list`.
- **How to cancel everything.** `.venv/bin/python scripts/mint.py rotate` makes a new key pair and new `rw.jwt` and `ro.jwt`, and every old database token stops working once the database server restarts (`docker compose restart sqld`, or restart the service). Then restart the connector too, and update the read and write token anywhere you use it.
- **Keep the keys out of everything.** `state/keys` holds the private key. Never put it, `rw.jwt`, `ro.jwt`, `.env` or the `state` folder in git, in a cloud drive, or in a chat. The kit's `.gitignore` covers them. Only the public key goes into the database container; the private key never enters a container.
- **Never put the database on a network share.** Not a NAS folder, a mapped drive, or a cloud-synced folder. It writes extra files beside the database and sharing tools corrupt them.
- **Use HTTPS for anything that leaves your machine.** A tunnel, Caddy or Tailscale all give you HTTPS. Do not open the plain database port to the internet.
- **The connector's search copy.** It keeps a search file with a copy of your brain's text at `state/connector/index.db` (private to your user). Treat it like the database.
- **Backups.** Run them, and copy them somewhere else now and then. We tested restoring-by-opening: the backup file opens in any SQLite tool and has the same rows.

---

## 11. When something does not work

| What you see | What it means | What to do |
|---|---|---|
| `401` from the connector | Wrong, missing or cancelled token | Check the header is exactly `Authorization: Bearer brk_...`, no extra spaces. Run `client_token.py list` |
| `421` from the connector | The name you used is not on its list | Set `BRAIN_MCP_HOSTS` to your public name and restart the connector |
| A new note is not in the search | The search copy refreshes every 60 seconds | Wait a minute, or run `.venv/bin/python connector/brain_mcp.py --reindex` |
| `cannot reach sqld` in the connector log | The database server is not running or the address is wrong | Check `docker compose ps`, or `launchctl list | grep brainkit`, or `systemctl status brain-sqld` |
| `sqld said 401` | The database token is wrong or from an old key | Run `mint.py init` only the first time; after a `rotate`, restart sqld and the connector |
| `Permission denied` when writing `tokens.json` | Docker created the `state` folders as root because it started before `mint.py init` | Run `sudo chown -R $USER state`, and next time run `mint.py init` before `docker compose up` |
| `port is already allocated` when Docker starts | Something else on the machine uses 8090 or 8765 | Add `SQLD_PORT=18090` and `MCP_PORT=18765` (any free ports) to `.env`, and use those ports in the check commands |
| Docker made a folder where a key file should be | You started Docker before running `mint.py init` | Stop it, delete that folder, run `mint.py init`, start again |
| `403` with `1010` through Cloudflare | Cloudflare blocks a default Python signature | Send your own `User-Agent` header |
| A client says "connection refused" from the cloud | The machine is asleep, or it is only on your private network | Use a VPS or keep the machine awake, and use a tunnel, not Tailscale |

To see what is going on: Mac logs are in `~/Library/Logs/brain`, Docker's are `docker compose logs connector` and `docker compose logs sqld`, and systemd's are `journalctl -u brain-connector`.

---

That is the whole thing. Start with the option that fits the machine you have, run the check until every line says PASS, then connect one client, and add more once that one works. If you get stuck, bring the exact message to the next call and we will sort it out together.

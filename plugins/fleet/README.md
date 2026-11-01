# Fleet

One board for every Mac running bb. The machines, their order and their roles come from the profile (`profile/README.md`); with the community defaults the board shows just this Mac and every remote feature stays inert until a second machine and a brain are configured. Any machine can ask another a question, push a message or a long text into one of its threads, and read the answer back.

- **Board:** left rail, "Fleet". A column per machine: independent owner status, declared capabilities, observed CPU/RAM and live/recent threads. An enrolled execution host is shown separately from its independently owned bb; an absent/stale owner observation does not mean the physical Mac is off.
- **CLI:**
  - `bb fleet status [--json]`: machines and their threads.
  - `bb fleet start <machine|auto> <prompt...>` (a machine id from the profile): start work there and return the chosen owner and thread or accepted command id.
  - `bb fleet ask <machine> <prompt...> [--message-file <path>] [--timeout 20m]`: start work there, wait until its turn is over, print the answer and the thread link. On timeout it exits 2 and prints the command id.
  - `bb fleet tell <machine> <thread-id> <message...> [--message-file <path>] [--wait] [--timeout 20m]`: send a follow-up, or a long text such as a call transcript, into a thread there. Without `--wait` it confirms delivery; with `--wait` it prints the new answer.
  - `bb fleet output <machine> <thread-id> [--json]`: the thread's latest answer.
  - `bb fleet result <command-id> [--wait] [--timeout 20m]`: the answer of the thread a `bb fleet start` created, including threads started before the upgrade (within the last 7 days).
  - `start` and `ask` accept `--provider <id> --model <id> --reasoning-level <id> --service-tier <id>`, `--workload <id>` (`general`, or a workload id from the profile), `--nas`, `--unattended` and repeatable `--require-capability <name>`. A model/reasoning/tier requires its provider. Put `--` before prompt text containing flags.
  - Add `--json` for data. Waits default to 20 minutes and stop at 60 (bb gives a plugin command 65 minutes). Exit codes: 0 done, 1 error, 2 timed out.
- **How machines talk:** each bb publishes a snapshot to the brain's Turso database (`fleet_servers`) every 30s and polls every 10s for work (`fleet_commands`) and messages (`fleet_messages`). Commands persist the complete selection in `fleet_command_options`; controls use `fleet_message_controls`. Credentials come from the brain's own env file (by default `~/.config/navaigate/brain.env`; see the brain self-host kit) and stay server-side. When the broker is unavailable, the existing authenticated SSH alias of the profile's always-on machine (`sshAlias`) can carry bounded JSON RPC on stdin to that machine's own bb, including snapshots, new jobs, mirror events and controls. This creates no credentials, services or network configuration. A restricted machine requires a separately verified owner transport; account/server visibility alone does not provide one.
- **Local shortcut:** when the target is this bb (or the thread lives in this bb), `ask`, `tell` and `output` use the local `bb thread` commands directly, with no brain round trip.
- **Per-machine settings** (Settings > Plugins > Fleet, or `bb plugin config fleet set <key> <value>`): `joinFleet` (off by default), `machineKey`, `machineLabel`, `capabilities`, `defaultProject`, `hostAliases`, `mirrorEnvironment`.
- **Mirror:** a chat on another Mac opens as a hidden local copy drawn by bb's own chat view. With the control relay wired, replies, steering and interrupts use durable identities and owner receipts. The skin calls `mirror_open({machine, threadId, localProjectId?}) -> {localThreadId}`. Explicit local placement uses an existing ready checkout in that project, and cannot reuse a sibling project's copy. See "Mirror" below.

Work started on another machine runs in that machine's own bb, so it keeps going when this laptop sleeps.

## Native placement and execution contract

`route_preview` and `work_start` share `{machine, providerId?, model?, reasoningLevel?, serviceTier?, routing?, projectId?, projectName?, workspace?}`. `work_start` also takes `prompt`, optional `title` and a stable `requestId`. The prompt limit is 256 KiB of UTF-8, including any context supplied by the caller. No attachments or local files are implicitly transferred.

`routing` accepts `{workload?: "general"|<profile workload id>, needsNas?: boolean, unattended?: boolean, requiredCapabilities?: string[]}`. Auto chooses **new jobs only**. It requires a fresh owner snapshot, fresh known CPU/RAM (60 seconds), an available selected provider, an available explicitly selected destination project and verified required capabilities. It rejects hosts at 95% CPU or with at most 5% physical free RAM, then compares idle cores weighted by physical free RAM; reclaimable cache, sustained performance and provider account quota are not measured. An eligible always-on machine is preferred for unattended jobs. Manual selection can proceed without resource telemetry, while ownership, project, provider and capability requirements still apply. A restricted machine requires explicitly its own workload, and that workload remains on that machine even when another Mac has spare resources.

Snapshot `resources` includes `observedAt`; `ownerHostId` names the execution host. `providers` reports native installation/availability, **not authentication, quota or VPN readiness**. Declared `VPN`/`Snowflake` strings are labels and never satisfy verified-capability routing. The current `NAS` check observes the mounted share named in the profile (`paths.nas`) and, when `plugins.fleet.nasHost` is set, that host's SMB endpoint reachability (no NAS in the profile means no NAS capability) without touching NAS files; it does not prove share permissions or future file reads. A first CPU observation can be unknown. `board_get.me.backendHealthy`, `transport.broker`, `lastSuccessfulSyncAt` and the error fields report authoritative broker health independently of owner/enrolment state.

`projectId` and `projectName` refer to the **destination's** project. An explicitly missing project never falls back to Personal. Omitting both retains the destination's configured default project behaviour. A source-only environment id or local path cannot be relabelled as a remote workspace. Transferable `workspace` values are:

```ts
{type: "managed-worktree", baseBranch: {kind: "default"} | {kind: "named", name: string}}
{type: "unmanaged", path: null, branch?: {kind: "existing", name: string} | {kind: "new", baseBranch: string}}
```

The destination supplies its own actual host id and project, then native provisioning validates checkout/base-branch intent. A managed worktree requires a project checkout. Omit `workspace` for destination defaults. Explicit execution/project/workspace choices require the destination's `execution-selection-v1` feature. The destination validates its native provider/model/reasoning/tier catalogue before `threads.spawn`, and supplies `executionInputSources: "explicit"` for every selected execution field.

The `work_start` result is `{outcome: "started"|"sent", threadId, url, commandId, requestId, route}`. `started` has an owner thread; `sent` means the broker durably accepted a command. `route` contains actual `machine`, `serverId`, `hostId`, mode, reasons, warnings and per-candidate eligibility. `command_get({commandId})` is a sender-scoped read-only receipt returning `{status, machine, threadId, url, error}`; statuses are `pending`, `starting`, `started`, `failed` or `unknown`. `work_receipt({requestId})` reads the local durable result. Receipt checks never reissue a job. Reusing an id with changed input fails; interrupted/unknown mutations are not retried automatically.

## Connecting Fleet to your own brain

Fleet needs two Macs and a brain both can reach over HTTPS. With the brain self-host kit, put the database behind its HTTPS address (the kit's Caddyfile does this) and write `~/.config/navaigate/brain.env` on each Mac:

```sh
TURSO_DATABASE_URL=https://db.example.com
TURSO_AUTH_TOKEN=<the kit's read-write token, keys/rw.jwt>
```

Fleet refuses plain `http://` addresses, so a database that only listens on `127.0.0.1` works for one Mac's scripts but not for Fleet. Keep the file readable only by you (`chmod 600`); it is never committed and the Console profile never holds the token.

## Schema

The plugin creates every table it uses at start (`CREATE TABLE IF NOT EXISTS`), so a fresh self-hosted brain needs no migration, and a brain that already has `fleet_servers` and `fleet_commands` is left as it is. The relay tables are:

```sql
-- A message for a thread on another machine. The target's Fleet claims it
-- (pending -> delivering), runs `bb thread tell <thread_id>` with the body on
-- stdin, then marks it delivered (body cleared: the thread holds the text) or
-- failed (error says why). updated_at of a delivered row is the delivery time
-- on the target's clock; a row stuck in delivering for 15 minutes is failed.
CREATE TABLE IF NOT EXISTS fleet_messages (
  id TEXT PRIMARY KEY,        -- uuid
  target_server TEXT,         -- server_id that owns the thread, e.g. "work-srv"
  thread_id TEXT,
  body TEXT,                  -- up to 256 KB; '' once delivered
  from_server TEXT,
  status TEXT,                -- pending | delivering | delivered | failed
  error TEXT,
  created_at INTEGER,         -- epoch ms, sender's clock
  updated_at INTEGER          -- epoch ms, last status change
);
CREATE INDEX IF NOT EXISTS idx_fleet_messages_target ON fleet_messages(target_server, status);

-- The latest answer (final assistant message) of a thread started or messaged
-- through Fleet, written by the machine that runs it when the thread's turn is
-- over (idle, or error) and the answer changed, or a Fleet message delivered
-- since the last publish has had its turn.
CREATE TABLE IF NOT EXISTS fleet_outputs (
  server_id TEXT,
  thread_id TEXT,
  state TEXT,                 -- idle | error
  output TEXT,                -- cut to 64 KB of UTF-8
  output_hash TEXT,           -- sha256 of the full answer
  truncated INTEGER,          -- 1 when output was cut
  updated_at INTEGER,         -- epoch ms of this publish, target's clock
  PRIMARY KEY (server_id, thread_id)
);
```

Each upgraded snapshot advertises `messages`, `outputs`, `execution-selection-v1`, `controls-v1` and (where available) `mirror`. Legacy commands without the options sidecar keep destination defaults. Older peers cannot receive an explicit execution/project/workspace selection without an upgrade.

## Mirror

Only chats its owner opens are mirrored. Broker mirror rows are encrypted for the watcher; the direct path to the always-on machine uses authenticated SSH instead of broker rows.

1. **Open.** `mirror_open` writes a watch row (`fleet_mirror_watch`) naming the chat, the machine that owns it and this Fleet's X25519 public key, then waits (up to 45 s) for the first row. A second open reuses the copy at once.
2. **Publish.** The owner's Fleet reads its active watch rows (every 10 s, every 3 s while a watched chat runs), reads the chat's new events with `bb.sdk.threads.events.list` (pages of 100), maps them to records (a remote turn, a steer, one finished item in bb's provider-delta shape with tool output cut to 32 KB, the end of a turn) and seals each batch to the watcher: ephemeral X25519, HKDF-SHA256, AES-256-GCM over deflated JSON, with the row's identity as associated data. At most one row every 3 s per chat. A first open replays the last 30 turns, with one line saying the earlier history is on that machine.
3. **Read.** The watcher polls every 3 s while a copy was opened in the last 30 minutes or is still catching up (else every 30 s), opens each row and appends its records to the copy's feed (`<Fleet data folder>/mirror-feed/<copy>.ndjson`).
4. **Replay and control.** The hidden copy uses the model-free `fleet-mirror` host provider (`host.ts`, `mirror/bridge.ts`). Remote user messages, steers, items and turn endings replay through bb's native chat. Writable copies put replies/steers/stops into a durable local outbox with a stable control id. The owner stores an idempotent receipt; accepted/queued controls are reconciled by read-only receipts and the exact owner echo. Native queue dispatch/cancellation events update queued owner receipts. An unknown dispatch is never blindly repeated. Old copies remain read-only until an idle caught-up upgrade can be made safely.
5. **Retention.** A watch lasts while its chat runs and for 7 days after the last open; its rows are deleted after 7 days or when the watch ends.

Keys: each Fleet makes its key pair at first start, keeps the private key in `<Fleet data folder>/mirror-key.json` (0600) and publishes the public key in its snapshot (`mirrorKey`, with the `mirror` feature). The brain holds no chat text for mirrored chats.

The provider never shows in the New chat picker: it is declared `experimental_visibility: "installed"` and its bridge answers `provider/health` with `not_installed`, while bb still accepts it for threads that name it.

Copies reuse one ready environment: a new environment (personal workspace or folder) did not finish provisioning on 25 October (also for a Claude Code thread, so a bb issue), while reusing a ready one starts at once. Set `mirrorEnvironment` to an environment id, or leave it blank for the most recently used local project checkout on this Mac (kept once chosen).

```sql
CREATE TABLE IF NOT EXISTS fleet_mirror_watch (
  id TEXT PRIMARY KEY,           -- watcher:target:thread
  watcher_server TEXT, target_server TEXT, thread_id TEXT,
  watcher_key TEXT,              -- X25519 public key rows are sealed to
  generation TEXT,               -- a new copy starts a new generation
  opened_at INTEGER,             -- last open, watcher's clock
  published_generation TEXT, published_seq INTEGER, next_seq INTEGER,
  state TEXT,                    -- active | ended | error
  error TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS fleet_mirror_events (
  server_id TEXT, thread_id TEXT, recipient TEXT, generation TEXT, seq INTEGER,
  payload TEXT,                  -- sealed JSON: {v, epk, iv, ct, tag}
  created_at INTEGER,
  PRIMARY KEY (server_id, thread_id, recipient, generation, seq)
);
```

## Limits

- Only threads started or messaged through Fleet publish their answers; no other thread on a machine is ever published. Command threads are watched for 7 days after they start.
- Answers are cut to 64 KB (`truncated`); open the thread for the rest. Messages and `ask` prompts are at most 256 KB.
- `--message-file -` (stdin) is not possible: bb forwards piped stdin to plugin commands only as one line under 16 KB. Save the text to a file and pass its path (read on the machine that runs the command).
- A remote thread that stops to ask a question or wait for an approval never settles; `ask`, `tell --wait` and `result --wait` notice it from that machine's snapshot and exit with its link.
- Answers arrive about 10-20 seconds after the remote turn ends (poll cycle plus publish).
- Reloading the Fleet plugin on the machine that is waiting cancels its wait; pick the answer up with `result` or `output`.
- Steering checks the displayed active turn immediately before dispatch; interrupt only stops a matching turn or one proven to originate from the cancelled controls. The public SDK has no atomic compare-and-stop/steer operation, so a small race remains between that read and the native call. No running session migrates.
- Direct SSH has a 30-second timeout and 2 MiB response limit. Mirror event pages above 1.5 MB fail explicitly; JSON is not truncated. A timed-out mutation remains unknown and must be reconciled, never automatically reissued.

## Develop

`npm run typecheck` and focused Vitest files: `model.test.ts`, `routing-native.test.ts`, `server-native.test.ts`, `mirror.test.ts`, `mirror-service.test.ts`, `mirror/control.test.ts`, `bridge.test.ts`. Server tests use the official fake plugin host, temporary private SQLite and synthetic SSH/broker transports; they start no real agents. `bb plugin build` builds artifacts without installing or reloading. SDK0.6.37 compatibility is checked separately against its published declarations; desktop runtime acceptance still requires live owner verification.

## Sealed native requests and private answers (0.2)

New broker job requests and native mirror controls require a fresh peer advertising `sealed-relay-v1` and its existing mirror public key. The task, title, execution options and control body are sealed to that peer; public relay columns contain fixed placeholders. Identity-specific associated data binds the ciphertext to the id, sender, destination, machine/thread and action. Missing, altered or unreadable envelopes are refused before native dispatch. There is no plaintext fallback for a new request.

Threads started through sealed broker commands, and threads receiving native controls, receive a durable owner-local private marker. Legacy `fleet_outputs` never fetches or publishes their answers; an older answer is replaced by an empty metadata-only row. Native mirrors and direct owner event reads remain the answer path. `bb fleet ask`/`result` for such a job reports `private_output` with its existing receipt: open that session and do not resubmit it. Legacy unsealed workflows keep their previous answer path.

Confidentiality holds against broker readers, not broker writers: a writer could replace a peer's published key. The existing shared-broker writer trust is unchanged; associated data alone is not sender authentication. No new credential or key installation is performed. The private marker is owner-local; resetting that plugin storage removes it, so later legacy messaging must not be treated as preserving the prior privacy classification.

A failed broker read is a transport error, not proof that a Mac is off. This release does not change Turso credentials or billing, enable SSH, or add a relay service. Direct calls to the always-on machine use only the pre-existing SSH alias. A restricted machine needs its existing authenticated broker restored or a separately authorised transport.

## Fleet management (0.3)

Source in this branch, not yet installed. Per-ID acceptance:
`docs/native-fleet-management-acceptance.md` in the core branch
`navaigate/full-native-fleet`.

- `owner/transport.ts`: finite owner methods over the always-on machine's SSH alias; pre-connect
  ssh failures are `unavailable`, possibly executed mutations `unknown`.
- `owner/updates.ts` + `updater/desktop-update.mjs`: version and provider
  matrix, staged dispatch, provider CLI updates, and the external desktop
  update helper (drain, verified vendor package, process-root stop, ShipIt
  wait, backup, reconnect proof, guarded rollback). `npm run gen:helper`
  regenerates `updater/helper-source.ts` after editing the helper.
- `owner/update-drain.ts`: owner admission drain; bb updates need it held and
  armed, and the helper needs `safeToQuit` before it stops bb.
- `owner/capabilities.ts`, `owner/host-identity.ts`, `owner/detail-contract.ts`:
  verified capabilities, the hardware binding proof and the owner card data.
- `owner/workspace.ts`, `owner/operations.ts`, `owner/project.ts`,
  `owner/transfer-manifest.ts`, `owner/simulators.ts`: owner files and
  interactions, automation/usage/attention relays, project verify/prepare and
  selected-file transfer, simulators.
- `components/fleet-management.tsx`: the matrix and owner cards on the Fleet page.

## Visible controls (F03, F06, F18, F65, F77, F78)

Where each of these is used on the Fleet page (left icon rail, Fleet):

- **Account on a chat (F03).** A thread card shows a small outlined tag with the
  account the chat last ran on, with the email on hover (`components/thread-card.tsx`).
  Each Mac fills it for its own chats from the Console's `thread_accounts`
  (`lib/thread-accounts.ts`, read at most once a minute) and publishes it in its
  snapshot, so other machines' cards show it once those Macs run this version. No tag when
  the Console is not installed there or the chat has had no turn in the last day.
- **Ask, Tell, read answer, receipts (F06).** Each thread card has a Tell button
  (`components/relay-actions.tsx`: send into that thread, Read latest answer). The
  Start box has Ask beside Start; Ask, Start and Tell also show for the independent
  always-on machine over its SSH route when this Mac has not joined the fleet (`lib/reach.ts`). The Owner workspace tab of a mirrored chat has the
  same Tell box. Sent from here (`components/sent-from-here.tsx`) lists what this Mac
  asked or told, with Read answer, Open, and a box that re-reads any command or
  request id. RPCs: `thread_tell` (idempotent by `requestId`), `thread_output_get`,
  `receipt_result`, `receipts_list`. A tell whose outcome is unknown is never re-sent.
- **Terminal (F18).** Open terminal on the always-on machine (SSH) appears when no enrolled host is
  proven for the independent always-on machine and its SSH route is authenticated right now (the same
  check the owner actions use): it runs `ssh <alias>` with the key-only, bounded, no-forwarding
  options of the owner route, from this Mac's proven host (`owner/terminal.ts`), and
  reopening reuses the live session. Whether a dropped
  connection keeps the shell is not proven.
- **New project (F65).** Each machine card has a form (name, checkout path, optional
  remote) that calls `project_prepare` mode `create_project` with a held request id.
  The path must already be a Git checkout on that Mac; `owner_project_target_get`
  supplies the exact owner target. It does not clone from a URL alone.
- **Load metrics (F77).** Thread load metrics reads `mirror_metrics_get` (bytes,
  open time, cursors, reads; no content). The first open of a chat copy on this Mac is
  cold and every later open of that copy is warm; a table shows each chat's cold open
  time and bytes beside its latest warm open, and every open is marked against 500 KB
  and 5 s. Chats appear as a short hash, never a title. The throttled-3G phone test is
  not run.
- **Channels (F78).** Versions and updates has a Channel column (Stable or Nightly
  test host) and a pin box, backed by `updates_policy_get` and `updates_policy_set`
  (saved to the plugin settings, effective at once). One machine is the test host:
  choosing Nightly on another Mac moves it and the message says which Mac went back to
  stable. Other machines update only after it runs the target version, and a version
  other than the pin is refused everywhere. The Update button is disabled with that
  reason (for example "Waits for studio to run 0.49.0") whenever `update_dispatch` would
  refuse it.

---
name: fleet
description: See what is running on each of your Macs (the machines in your profile), start work on a specific machine, ask a machine a question and get its answer back, push a message or a long text (call transcript, conversation) into a thread on another machine, and read a remote thread's answer. Use when asked "what's running on the other Mac", "start this on the always-on Mac", "run this on the restricted Mac", "ask that Mac ...", "send this transcript to that Mac's thread", "what did that Mac come back with", "get the result of that fleet command", or for the fleet status.
---

# Fleet

Every Mac has its own bb; the machine ids, labels and roles come from the profile. With the community defaults there is one machine (this Mac) and nothing remote is active. Upgraded Fleet instances publish owner snapshots to Turso every 30 seconds and pick up accepted commands/messages every 10 seconds. If the broker is unavailable, the existing SSH alias of the always-on machine (its `sshAlias` in the profile) can carry bounded JSON on stdin to that machine's own Fleet. This uses existing authentication; it creates no services, account changes or credentials. Account visibility alone is not proof of an independent owner transport, especially on a restricted machine.

## Commands
- `bb fleet status [--json]`: each machine, whether it is online, what it can reach (NAS, VPN...), and its live and recent threads (with ids in `--json`).
- `bb fleet start <machine|auto> <prompt...>`: start new work, returning the chosen owner and thread or accepted broker command id.
- `bb fleet ask <machine> <prompt...> [--message-file <path>] [--timeout 20m]`: start work there, wait until the turn is over, then print the answer and the thread link. Exit 2 on timeout, with the command id to pick it up later.
- `bb fleet tell <machine> <thread-id> <message...> [--message-file <path>] [--wait] [--timeout 20m]`: send a follow-up or a long text into an existing thread there. Without `--wait` it confirms delivery (about 10 seconds); with `--wait` it prints the thread's new answer.
- `bb fleet output <machine> <thread-id> [--json]`: the thread's latest published answer.
- `bb fleet result <command-id|request-id> [--wait] [--timeout 30m]`: the answer of the thread a `bb fleet start` created (works for commands sent before the upgrade too, up to 7 days old). A direct start on the always-on machine prints a request id; use that.
- `bb fleet versions [--json]`: bb and provider CLI versions on every machine with available updates and the last update intent.
- `bb fleet update <machine> --to <x.y.z>`: a drained, staged, verified bb update on one machine. It refuses unless the test machine already runs that version and the owner holds an admission drain; follow it with `bb fleet versions`.
- `bb fleet provider-update <machine> <provider> --from <version>`: update one provider CLI from an exact version; refused while threads use it.
- `bb fleet owner <machine> [--json]`: routes with health, verified capabilities (Xcode, simulators, GUI session), provider auth, MCP endpoint, editor links and whether the enrolled host is proven to be that machine.
- `--json` on any of them gives data (`output`, `url`, `threadId`, `truncated`, `commandId`/`messageId`). Waits default to 20m and stop at 60m.
- `start`/`ask` accept `--provider <id> --model <id> --reasoning-level <id> --service-tier <id>` plus `--workload <id>` (`general`, or a workload id from the profile), `--nas`, `--unattended` and repeatable `--require-capability <name>`. Put `--` before literal prompt flags. Model/reasoning/tier need a provider; omitted fields keep destination defaults. The owner validates its actual catalogue and native execution records all supplied fields as explicit.

## Which one to use
- A question or a job whose answer you need now, on another machine: `ask`. Example: `bb fleet ask studio "Print the output of hostname and whoami, nothing else"`.
- Long work you do not want to block on: `start`, keep the command id, carry on, then `result <command-id> --wait` when you need the answer.
- Continuing a conversation with a thread that already exists there (follow-up question, correction, "now do X"): `tell ... --wait`. Use the thread id `ask` printed, or one from `bb fleet status --json`.
- Handing over material (a call transcript, a meeting note, a conversation export) to a thread there: write it to a file and `bb fleet tell <machine> <thread-id> "What to do with it" --message-file /path/to/transcript.md`. The typed words come first, then the file. Add `--wait` if you need its reply.
- Just reading what a thread there last said: `output`.

## Rules for messages and prompts
- The remote thread has no memory of this conversation. Make a new prompt stand alone: goal, inputs with full paths (NAS paths as they are mounted on that Mac), decisions already made, where to save, and what the final message should contain (that final message is what comes back).
- Never put secrets in a prompt or message: they pass through the brain.
- Messages are at most 256 KB; answers come back cut to 64 KB (marked truncated; open the thread for the rest).
- `--message-file -` (stdin) does not work: bb gives plugin commands only one line of stdin. Save the text to a file first.
- `tell` steers: if the thread is busy, the message joins its current turn; if idle, it starts a new turn. Do not message a thread you did not start or were not asked to touch.
- If the remote thread stops to ask a question or wait for an approval, `ask`/`tell --wait`/`result --wait` exit with its link: tell the owner, or answer it with `tell`.

## Choosing the machine
- NAS-heavy work, long jobs, anything that should survive the laptop lid closing: the always-on machine.
- Work belonging to a workload that the profile restricts to one machine stays on that machine, and that machine requires the explicit `--workload <id>`. Never automatically export such a task's context to another host because the restricted machine's route is unavailable. Declared VPN labels are not access proof.
- Quick work while you are at this laptop: the current machine (runs locally, no brain round trip).
- `auto` places only new jobs using fresh owner CPU/RAM and provider observations, project affinity and verified capabilities. Unknown/stale resource data refuses Auto with a reason. An eligible always-on machine is preferred for unattended work. Manual choice can work without resource metrics, but never bypasses owner/project/provider/capability validation. Never migrate a running session.
- `status` distinguishes an enrolled host from its independent bb owner. Unknown/stale owner telemetry is not evidence the Mac is off. `backendHealthy` and transport errors are authoritative for broker health, not the presence of credentials.

## Native controls and placement
- `work_start` / `route_preview` accept flat `providerId`, `model`, `reasoningLevel`, `serviceTier`; `routing`; and destination `projectId`/`projectName`. An explicitly missing project fails instead of falling back to Personal. Source-only environment ids and absolute source paths are not transferable remote placements.
- Optional `workspace` supports managed-worktree with default/named base branch, or unmanaged `{path:null}` with existing/new branch intent. Omission uses destination project defaults. Native provisioning validates actual checkout/branch state. No files or attachments are implicitly copied.
- A started receipt has a remote thread; a sent receipt means a durable broker command, not execution. Poll `command_get({commandId})` or `work_receipt({requestId})` read-only. Keep stable request ids. Unknown mutation outcomes must not be automatically resubmitted.
- `mirror_open({machine,threadId,localProjectId?})` opens the native chat copy. Writable copies route replies, steers and interrupts to the actual owner, use durable control receipts, and reconcile the exact owner echo without duplicate user bubbles. Stop/steer checks the displayed owner turn; public SDK calls have no atomic turn compare-and-swap, so do not claim a stronger race guarantee.

## Settings (per machine, Settings > Plugins > Fleet)
- Join the fleet: off by default. Off means the board shows only this bb's own machines and nothing is published or received.
- Machine key / Display name: a machine id from the profile (blank = matched from this Mac's hostname) and a friendly name.
- Capabilities: what this machine can reach, e.g. `VPN, VPC`. NAS is detected automatically.
- Default project: where jobs with no explicit destination project start (default blank: the personal workspace), retaining the legacy Personal fallback. Explicit selections never use that fallback.

## When something does not come back
- "runs a Fleet from before two-way messaging": that machine needs the plugin upgrade. `start` still works there meanwhile.
- Timed out: the machine may be asleep or the work is long. Use the printed `bb fleet result <id> --wait` or `bb fleet output <machine> <thread-id>` later.
- `bb fleet status` shows the last sync error, if any.
- Broker failure: keep the error visible; do not call stale cached snapshots live. Direct availability of the always-on machine is a separate result. A timeout after dispatch is unknown; read the original owner/receipt before any manual replacement job.

## Native privacy and receipts (0.2)

New job/control broker payloads require negotiated sealing with the owner's existing mirror key. Never downgrade to plaintext. Private jobs do not publish legacy answers: `private_output` means read the existing native session/mirror using its receipt, not start another job. A lost response or unknown receipt must never cause automatic re-dispatch. Broker readers cannot read sealed content; broker writers retain the existing key-directory trust. No new SSH access, credentials, paid plan or relay service is created by this release.

## Fleet management (owner actions)

- Owner actions reach only this Mac or the always-on machine over its existing SSH alias, through a fixed method list. A restricted machine has no authenticated route, so its actions report `unavailable`; never work around that.
- `unavailable` means nothing was sent: retry is safe. `unknown` means it may have run: read the receipt (`work_receipt`, `updates_intent_get`, `provider_update_receipt`, owner receipts), never resend.
- Attachments for a new task or a mirror reply travel only over a direct authenticated owner route, are verified by SHA-256 on the owner, and become native image/file blocks there. The broker never carries attachment bytes.
- Selected-file transfer copies only files you name (1 MiB each, 8 MiB total). `.env` files, keys and credentials are refused: set them on the destination Mac. List ignored files shows the checkout's git-ignored files to tick, with the reason any cannot be copied; ignored directories such as `node_modules/` show as one row, so name the files inside them individually.
- Open a terminal on another Mac only from the Fleet owner card, which checks that the enrolled host reports the same hardware id as the owner.

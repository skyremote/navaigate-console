# Native attention and automation acceptance

Stream C, 30 October 2026. Isolated source implementation against BB Plugin SDK 0.6.94; no plugin installation, live settings changes, real-thread actions or external execution performed.

## Contract and behaviour

Settlement is plugin-owned completion/presentation state. It never archives a thread, hides its core visibility, moves its section or folder, unpins it, changes pin order, stops execution or tears down a workspace. The existing BB archive/delete actions remain separate and keep core confirmations/cascades. Restore shows the thread where its current native organisation places it. Successful settlement/snooze/restore rows and their previous presentation values are journalled together in SQLite. Undo receipts survive reload, expire after seven days, are idempotent and refuse conflicting later edits. Retitle uses native `threads.update`; its title undo refuses a later title edit. Core owns update timestamps, so retitling can affect Recent ordering.

Automatic settlement starts disabled. Every per-thread policy defaults to `acceptancePending: true`, `autoMerge: false`, `inactiveAfterMs: null`. Settlement refuses active/provisioning/waiting threads, queued work, pending interactions and active child/background work; a 200-child cap refuses rather than claiming all children were checked. Pinned threads are excluded from automatic settlement. PR settlement refreshes the genuine PR Status plugin and requires every exact required URL/environment pair to report merged. Unknown/absent/unavailable PRs never count as merged. Multiple required PRs are supported explicitly. Activity, failures and pending questions reopen settled/snoozed rows. Hidden top-level members in the existing native-conversation index are checked without creating sessions or changing core parentage; hidden-member activity/questions wake their logical root. A durable minute clock wakes due snoozes; client clock checks also prevent a due snooze remaining invisible between sweeps.

The attention inbox is a native `navPanel` in the current skin. It separates running, waiting, needs-you, failed, reviewable, accepted and snoozed, displays the real pending question and owning host from core data, and links back through native thread navigation. It is bounded to 2,000 visible owning threads, with a truncation notice. Working folding preserves pinned rows and urgent questions/failures. Rail actions, selected-item controls and the attention page expose reversible settlement and snooze. The page supports scope preview, bulk retitle, independent per-item failure and accessible buttons. Optional swipe is implemented only on the plugin-owned inbox rows; vertical movement, controls and multitouch do not trigger triage.

## Assigned-ID ledger

| ID | Concrete implementation and proof | Integration boundary |
|---|---|---|
| F30 | `server-attention.ts: inbox`; `src/attention.tsx: AttentionPage`; native seven-state inbox, core host/question data | Fresh owner inbox snapshots aggregate real questions/status/policies through finite Fleet attention_inbox_fetch. |
| F31 | SQLite presentation settlement; native thread/workspace state untouched | Explicit settle guards active/waiting work. |
| F32 | SQLite Undo receipts, conflict refusal, reload/idempotency tests | Native title update timestamp is core-owned. |
| F33 | Durable wake times, minute sweep and early wake on interaction/failure/activity | Owning server must be running to sweep. |
| F34 | Existing core interaction events, pending prompt display and native thread navigation | Owner identity and execution host are shown; remote context uses the existing native Fleet mirror. Existing notifications remain authoritative. |
| F35 | Server-persisted working fold plus visible count, rail/page filtering | Working pins remain visible. |
| F36 | Existing native pins reused; no pin/section/order mutations on settlement/Undo | Existing native pin UI retained. |
| F38 | Genuine `experimental_ThreadRowMetadata` added to compact and expanded rail rows | PR plugin provides actual environment-owned linked PR badges; remote environments need owner data. |
| F39 | Opt-in verified PR refresh; exact URLs, every required PR merged; Undo | No inferred PR event and no automatic archive. |
| F40 | Per-thread policy editor including acceptance block and merge/inactivity override | Defaults preserve outstanding acceptance. |
| F41 | Optional right-settle/left-snooze touch on owned inbox rows with explicit accessible controls | No unsupported core row interception. |
| F42 | Scoped selected-thread preview; bulk settle/snooze/retitle; independent result rows, Undo | Owner-scoped targets, durable request/fingerprint admission, per-owner results and original-owner Undo; unknown replies use receipt status only. |
| F43 | Per-thread inactive duration, opt-in only; pins/jobs/decisions guarded | No enabled global inactivity rule. |
| F44 | Native Automations overview, Run now, last-result navigation, Create recurring task composer entry | Actual schedule/host/timezone remain owned by existing Automations. |
| F47 | Existing `home.accounts`/Account Pooler/Provider Usage reused; source freshness marked unknown | Exact usage_snapshot_fetch reads every profile machine; unavailable/stale owners and unknown provider sample freshness are visible. |
| F48 | Remaining percentage and real reset values shown at native job creation/composer | No invented reset and no substitution of CPU capacity for quota. |
| F49 | Exact provider+verified subscription ID+window dedup, freshest sample chosen; unknown identity never combined | Authenticated owner feed is wired. Exact configured or verified stable identity deduplicates; unknown identity stays separate and no allowance is summed. |
| F50 | Existing Provider Retry queue rows, native reset time/cancel controls; no second recovery scheduler | Existing Provider Retry owns retry classification, limits and durable execution. |
| F51 | Native signed `/automation-hook` HTTP route, field filters and fixed preconfigured Automations task | Source contains disabled settings; real secret/Connect configuration and owner activation remain parent work. |
| F52 | Bounded SQLite admission/receipts, opt-in 24h holding, expiry, owner availability and visible result state | No offline execution; receiver server must be running. Finite remote dispatch is wired to the parent-supplied Fleet automation_dispatch contract; live owner transport remains to be activated and verified. |
| F53 | Existing BB Connect HTTPS origin configuration builds exact plugin route; no new service/tunnel/token | An already exposed origin must reach this BB server. |
| S04 | Per-hook delivery ID/raw-content digest replay receipts, seven-day retention, persisted burst window/count | Coalescing dispatches one fixed automation; event text is never an instruction. |

## Existing-plugin contracts checked from installed sources

- Automations: `automations_overview(null)` returns task/project rows; `automations_run({projectId, automationId, idempotencyKey})` returns a durable `run.id`. The scheduler and run owner retain their own idempotency and execution semantics. Agent execution target is `execution.environment` (`host`/`reuse`/`project-default`) or `targetThreadId`, not a guessed `target.hostId`. The bridge reads experimental_automations_execution_guard, verifies that exact execution target and connected host, then supplies expected update-time and execution-fingerprint guards to Run. Core refuses any intervening config change before synchronous durable admission, including same-timestamp edits. Core extension commit: b10101c90.
- Provider Retry: retry entries are ordinary durable core queue rows whose `payload.kind` is `retry`; cancellation calls `threads.queuedMessages.delete` only after finding that exact retry ID. Subscription retries, jitter, maximum attempts and pool availability continue to come from Provider Retry/Account Pooler.
- PR Status: plugin `bb--github-pr-status`, `refresh({environmentId})` followed by `pullRequests({keys:[environmentId,...]})`; rows have `outcome` and PR `state`/`url`. No guessed global merged-PR hook.
- Fleet: authoritative local owner identity comes from existing `fleet.board` owner server ID. An enrolled or cached host cannot stand in for a different server owner.

## Webhook security and recovery

Native Settings declare `webhookEnabled=false`, server-secret `webhookSecret`, bounded task JSON and optional existing BB Connect HTTPS origin. Public route uses SDK `auth:none` solely because it verifies every request's own signature. It never removes signature authentication: `x-nav-signature = sha256=HMAC-SHA256(secret, 'v1.' + hookId + '.' + timestamp + '.' + deliveryId + '.' + rawBody)`, with `x-nav-timestamp` in epoch milliseconds, a five-minute freshness window, `x-nav-delivery` restricted to 128 safe characters and `x-nav-hook` selecting configured task. Signing binds the version domain, selected hook, raw body, timestamp and replay key. Cross-hook replay fails even when hooks share a secret. Each accepted event also stores an immutable owner/host/project/task binding and fingerprint; changing the configured binding refuses held events and leaves uncertain dispatches unknown rather than rerouting. Secret must be at least 32 characters; it never reaches frontend RPC, logs or receipts. Bodies are streamed with a 64 KiB maximum, parsed as JSON objects and filtered by bounded own-property paths. The durable inbox retains only digest and admission metadata; raw request bodies and arbitrary payload text are not copied to agent prompts.

Admission returns 202 with `accepted:true, executed:false` after persistence, independently of later owner execution. Reused delivery IDs with changed content return 409. There are at most 1,000 pending rows overall, 100 per task and 10,000 seven-day replay receipts. Coalescing windows survive reload. Offline holding is opt-in and expires after 24 hours. Dispatch intent is durable, and the exact Automations idempotency key is reused after a dispatch-intent crash. A durable owner run ID becomes owner-accepted, not executed: it confirms Automations admission only. An explicit unknown outcome, thrown owner call or unknown provider effect is marked unknown and never blindly rerun. Retry confirmation concerns Automations' durable run acceptance, not success of external effects within that run.

## Validation

Focused Vitest suites cover native section/pin preservation, no archive calls, reload and Undo, stale Undo refusal, snooze clock idempotency, early question wake, active/queued/interaction/child guards, disabled defaults, exact merged-PR prerequisites and multiple PRs, opt-in inactivity and pin protection, title conflicts, exact subscription dedup and unknown identity, real Automations/Provider Retry method calls, owner/host refusal, signed HTTP admission, payload/signature/replay limits, reload dedup, offline expiry, burst persistence, dispatch crash reconciliation, unknown-effect no-rerun, bounds, and UI selection/navigation/swipe protections.

Live rendering, real cross-Mac transport, real webhook sender delivery, quota-reset execution and external automation effects have not been exercised in this isolated branch. Parent owns installation/activation and final cross-stream acceptance.

Final isolated verification: `npm run typecheck`, `npm test` (144 Vitest tests plus 16 legacy Node tests), `bb plugin build` and `git diff --check` passed. The plugin build retains the pre-existing retired threadHeaderAction adapter warning. Core Automations `turbo run typecheck test --filter=bb-plugin-automations` passed all 141 tests; `turbo run prepare:bundled --filter=bb-plugin-automations` passed. No production server/app was started.

## Cross-owner action protocol and review fixes

`server-attention-owners.ts` implements bounded owner inbox reads, owner action/status receipts and the source aggregation/action manager. Owner inbox responses contain the actual pending prompt and current policy; source selects owners by server ID and primary host, keeps execution host separate and refuses stale snapshots. Parent/Fleet forwards only the finite attention read/action/status operations, not a general plugin proxy.

Every owner mutation carries a UUID request ID and typed command; a SHA-256 fingerprint binds owner, primary host and the parsed command. A durable claim precedes action execution. Identical completed requests return their persisted receipt; changed intent with the same UUID is refused; an interrupted claim remains unknown and is never replayed. Source plans persist before dispatch, group bulk scope per owner, preserve owner Undo receipt IDs and reconcile lost replies through status reads only. A test uses the same physical thread ID on two different owners and proves retitling reaches only the selected owner. A restricted machine without an authenticated owner route stays unavailable with a per-item result.

D's independent review findings are covered by regressions: hook-selector signing; held/claimed webhook repoint refusal across reload; automatic PR completion blocked by an intervening policy revision; extended snooze protected from an old timer snapshot. Automatic transitions compare the expected revision inside the same serial state transition used by manual operations.

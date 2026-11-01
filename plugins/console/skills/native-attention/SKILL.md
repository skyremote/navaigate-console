---
name: native-attention
description: Use the native Workspace attention inbox, reversible settlement and snooze, verified automatic completion, quota retry and signed automation event receipts.
---

# Workspace attention

The Work needs you panel shows owning-server questions, failures, waiting jobs,
reviewable output and explicitly accepted work. Settlement is reversible list
state; it never archives a thread or retires its workspace. Delete and Archive
remain separate native BB actions. Do not enable automatic policies unless the
user asks. Defaults keep delivery checks outstanding and all automatic policies
disabled.

Use native panel controls or `bb plugin rpc call navaigate-skin <method>` with a
JSON input (consult `bb plugin rpc --help` for transport syntax). Current methods:

- `attention_inbox` and `attention_state`: null input, bounded status/state reads.
- `attention_apply`: `{threadIds, action:"settle"|"snooze"|"restore"|"retitle", wakeAt?, title?}`. Snooze time is future epoch milliseconds; retitle requires a title. Return has a receipt and per-thread result. Report partial failures.
- `attention_undo`: `{receiptId}`. Seven-day persisted receipt; later changes can refuse Undo. Never claim a failed row was restored.
- `attention_fold`: `{value:boolean}`. Preserves visible pins and urgent states.
- `attention_policy`: `{threadId,policy:{acceptancePending,autoMerge,requiredPrUrls,requiredPrEnvironments,inactiveAfterMs}}`. Multiple PRs need URL-to-environment mappings. A refreshed genuine PR status must prove every exact required URL merged. This never archives.
- `attention_usage`: null. Existing subscription windows, remaining/reset mapping, exact-identity dedup. Unknown identity/sample freshness stays unknown. Never sum duplicate subscriptions or infer quota from CPU capacity.
- `attention_retries`: `{threadId?}`; `attention_retry_cancel`: `{threadId,id}`. These use Provider Retry's existing durable retry rows and native cancellation.
- `attention_automations`: null, existing native task overview; `attention_automation_run`: `{projectId,automationId,idempotencyKey}`, existing manual Run path. Scheduling remains in native Automations.
- `attention_events`: null, bounded admission/execution receipts and non-secret configured routes. Accepted ingress does not mean an owner executed a task.

## Webhooks

Disabled until explicitly configured in native Settings. Set the server-secret
`webhookSecret` (at least 32 characters), task configuration JSON (`webhookHooks`)
and optionally an already exposed BB Connect HTTPS origin (`webhookPublicBaseUrl`).
Never print the secret or put it in a URL, client bundle or receipt.

Each hook names `id`, `enabled`, `ownerServerId`, `hostId`, `projectId`,
`automationId`, optional remote `machine` (a machine id from the profile), `holdOffline`,
`coalesceSeconds` and bounded `{path,equals}` filters. Remote ownership requires a
fresh authoritative Fleet owner observation; an enrolled-host placeholder is
insufficient. The current finite Fleet route can report a restricted machine unavailable.

POST to `/api/v1/plugins/navaigate-skin/http/automation-hook` with headers
`x-nav-hook`, `x-nav-delivery`, `x-nav-timestamp` and `x-nav-signature`.
The signature is `sha256=` plus HMAC-SHA256 of
`'v1.' + hookId + '.' + timestamp + '.' + deliveryId + '.' + rawBody`, using the server-held secret.
Timestamp uses epoch milliseconds within five minutes; delivery ID uses safe
letters/digits/underscore/hyphen and is at most 128 characters. JSON object body
is limited to 64 KiB. The selected hook is signed, so signatures cannot be reused on another task. An immutable execution binding prevents accepted events being rerouted by later settings edits. Delivery ID and content digest persist for seven days;
changed-content replay is refused. Fixed task selection and filters are the only
payload influence; payload text is never appended as an instruction.

Offline holding is opt-in, bounded and expires in 24 hours. Bursts coalesce on a
persisted window. Guarded local Automations requires the matching native core
execution-guard extension; cross-owner dispatch requires Fleet
`automation_dispatch`. A missing dependency does not cause a blind fallback.
Unknown owner effects stop replay; do not start another task to hide uncertainty.

## Owning-server attention and fleet scope

`attention_fleet_inbox(null)` aggregates fresh owner snapshots and explicit
unavailable notices. Native UI targets use owner ID plus physical thread ID;
identical physical IDs on different servers remain separate rows.

`attention_fleet_apply({requestId,targets,action,wakeAt?,title?})` accepts at most
200 `{ownerServerId,hostId,threadId,machine?}` targets. Remote targets require a
verified machine from the profile. The source persists per-owner plans before dispatch.
`attention_fleet_undo({requestId,receiptId})` returns Undo to the original owners.
`attention_fleet_policy({requestId,target,policy})` changes the selected owner's
policy. `attention_fleet_receipt({requestId})` checks an uncertain source request;
it reads owner status and never resends the action.

Owner-ready RPCs are `attention_owner_inbox({v:1,ownerServerId})`,
`attention_owner_action({v:1,ownerServerId,hostId,requestId,command})` and
`attention_owner_receipt({v:1,ownerServerId,requestId})`. Commands are strictly
apply, Undo or policy. Owner actions persist request fingerprint and receipt,
refuse changed intent and leave interrupted claims unknown. No generic remote
plugin invocation is exposed. Fleet forwards the finite inbox/action/status
operations; a missing owner route is reported rather than substituted.

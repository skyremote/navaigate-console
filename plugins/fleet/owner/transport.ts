// Finite owner RPC transport. Every remote call names one (plugin, method)
// pair from OWNER_METHODS; nothing else can be reached, so this is not a
// generic plugin proxy. User input travels on stdin, never in the command.
// The owner spools stdin to a private temporary file before bb reads it:
// bb's `--input-file /dev/stdin` fails with EAGAIN on a large SSH pipe
// (measured on the always-on Mac with 3 MB to 7 MB inputs such as a 5 MB PDF attachment).
import { execFile } from "node:child_process";

export const OWNER_METHODS = {
  fleet: [
    "snapshot_get", "work_start", "work_receipt", "control_deliver", "control_receipt", "thread_events_get", "thread_answer_get",
    "updates_status", "updates_apply", "updates_intent_get", "provider_update_apply", "provider_update_receipt",
    "owner_file_stat", "owner_file_list", "owner_file_read", "owner_file_write", "owner_file_preview", "context_bundle_import", "context_bundle_export",
    "interaction_list", "interaction_respond", "owner_workspace_receipt",
    "automation_run", "automation_run_status", "usage_snapshot_get",
    "project_verify", "project_prepare", "transfer_manifest_apply", "transfer_receipt",
    "simulator_list", "simulator_frame", "simulator_action",
    "thread_target_get", "work_attachments_put",
    "owner_browser_instances", "owner_browser_tabs", "owner_browser_open", "owner_browser_frame", "owner_browser_input", "owner_browser_receipt",
  ],
  "navaigate-skin": ["attention_owner_inbox", "attention_owner_action", "attention_owner_receipt"],
} as const;

export type OwnerPlugin = keyof typeof OWNER_METHODS;
export type OwnerMethod<P extends OwnerPlugin = OwnerPlugin> = (typeof OWNER_METHODS)[P][number];

export type OwnerCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; kind: "unavailable" | "unknown" | "refused"; message: string };

/** ssh stderr that proves the remote command never started. */
const PRE_CONNECT = [
  /ssh: connect to host .* (Connection refused|Operation timed out|No route to host|Network is unreachable|Connection timed out)/i,
  /ssh: Could not resolve hostname/i,
  /Connection timed out during banner exchange/i,
  /Permission denied \(publickey/i,
  /Host key verification failed/i,
  /kex_exchange_identification/i,
];

/** Exit codes of the owner-side stdin spool: the owner command never ran. */
export const SPOOL_FAILED_EXIT_CODES = [70, 71] as const;

/**
 * A failed ssh call is "unavailable" (known not delivered, safe to retry)
 * only when ssh itself failed before the remote command ran: exit 255, no
 * stdout and a pre-connection error. Anything else on a mutation is
 * "unknown" and must be reconciled through a read-only receipt.
 */
export function classifySshFailure(args: { code: number | null; stdout: string; stderr: string; mutation: boolean }): "unavailable" | "unknown" {
  const preConnect = args.code === 255 && args.stdout.trim() === "" && PRE_CONNECT.some((pattern) => pattern.test(args.stderr));
  if (preConnect) return "unavailable";
  if (args.stdout.trim() === "" && (SPOOL_FAILED_EXIT_CODES as readonly (number | null)[]).includes(args.code)) return "unavailable";
  return args.mutation ? "unknown" : "unavailable";
}

export function isOwnerMethod(plugin: string, method: string): plugin is OwnerPlugin {
  return Object.hasOwn(OWNER_METHODS, plugin) && (OWNER_METHODS[plugin as OwnerPlugin] as readonly string[]).includes(method);
}

/** Read methods whose bounded answer can exceed the default 2 MiB stdout cap. */
const LARGE_ANSWERS: Partial<Record<string, number>> = { context_bundle_export: 12 * 1024 * 1024 };

export const M1_BB_CLI = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb";
const M1_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface SshOwnerOptions {
  alias: string;
  run?: typeof execFile;
  timeoutMs?: number;
  maxBuffer?: number;
}

/**
 * The fixed remote command for one owner method. stdin is copied by `cat`
 * (which waits on a slow pipe) into a 0600 file in the owner's private
 * temporary directory, removed on exit; only then does bb read it.
 */
export function ownerRpcCommand(plugin: OwnerPlugin, method: string): string {
  return [
    "umask 077",
    `f=$(mktemp "\${TMPDIR:-/tmp}/fleet-rpc.XXXXXX") || exit ${SPOOL_FAILED_EXIT_CODES[0]}`,
    `trap 'rm -f "$f"' EXIT`,
    `cat > "$f" || exit ${SPOOL_FAILED_EXIT_CODES[1]}`,
    `PATH='${M1_PATH}' '${M1_BB_CLI}' plugin rpc call '${plugin}' '${method}' --input-file "$f" --json`,
  ].join("; ");
}

/** One authenticated SSH alias as an owner route. The alias must already exist. */
export function createSshOwnerTransport(options: SshOwnerOptions) {
  const run = options.run ?? execFile;
  return {
    call<P extends OwnerPlugin>(plugin: P, method: OwnerMethod<P>, input: unknown, mutation: boolean): Promise<OwnerCallOutcome> {
      if (!isOwnerMethod(plugin, method)) return Promise.resolve({ ok: false, kind: "refused", message: `${plugin}.${method} is not an owner method` });
      const command = ownerRpcCommand(plugin, method);
      return new Promise((resolve) => {
        const child = run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "--", options.alias, command], { timeout: options.timeoutMs ?? 30_000, maxBuffer: LARGE_ANSWERS[method] ?? options.maxBuffer ?? 2 * 1024 * 1024 }, (error, stdout, stderr) => {
          const out = String(stdout ?? "");
          const err = String(stderr ?? "");
          let body: unknown;
          try { body = JSON.parse(out); } catch { body = undefined; }
          const envelope = body as { ok?: boolean; result?: unknown; error?: { message?: string; code?: string } } | undefined;
          if (!error && body !== undefined && envelope?.ok !== false) {
            resolve({ ok: true, result: envelope?.ok === true ? envelope.result : body });
            return;
          }
          if (envelope?.ok === false) {
            const detail = envelope.error?.message ?? "Owner rejected the request";
            const missing = /unknown (rpc )?method|not found|no such method|is not registered/i.test(detail);
            resolve({ ok: false, kind: missing ? "unavailable" : mutation ? "unknown" : "unavailable", message: missing ? `owner-method-missing: ${detail}` : detail });
            return;
          }
          const code = typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : null;
          const kind = classifySshFailure({ code, stdout: out, stderr: err, mutation });
          const detail = err.trim().split("\n")[0] || error?.message || "No valid response";
          resolve({ ok: false, kind, message: kind === "unknown" ? `Owner outcome is unknown; do not resend: ${detail}` : `Owner route unavailable: ${detail}` });
        });
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(JSON.stringify(input));
      });
    },
  };
}
export type SshOwnerTransport = ReturnType<typeof createSshOwnerTransport>;

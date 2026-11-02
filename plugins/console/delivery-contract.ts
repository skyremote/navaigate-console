import type { defineRpcContract as sdkDefineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  PROOF_BRANCH_MESSAGE,
  PROOF_MAX_FILES,
  PROOF_MAX_FILE_BYTES,
  PROOF_MAX_TOTAL_BYTES,
  base64Bytes,
  validProofBranch,
} from "./src/delivery-proof";

// The app bundle shims only "@get-bb/plugin-sdk/app", so a value import from the SDK root breaks a
// clean install (the frontend build cannot resolve it). The SDK's defineRpcContract returns its argument.
const defineRpcContract: typeof sdkDefineRpcContract = ((contract: unknown) => contract) as typeof sdkDefineRpcContract;

const id = z.string().min(1).max(200);
export const prSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["draft", "open", "merged", "closed"]),
  url: z.string().url(),
  baseRefName: z.string(),
  headRefName: z.string(),
  updatedAt: z.string(),
  autoMerge: z.boolean(),
  inMergeQueue: z.boolean().nullable(),
  checks: z.object({
    state: z.enum(["passing", "failing", "pending", "no_checks", "unknown"]),
    totalCount: z.number(),
    passedCount: z.number(),
    failedCount: z.number(),
    pendingCount: z.number(),
  }),
  review: z.object({
    state: z.enum(["approved", "changes_requested", "review_required", "review_requested", "none"]),
    reviewRequestCount: z.number(),
  }),
  mergeability: z.object({
    state: z.enum(["mergeable", "conflicts", "blocked", "draft", "unknown"]),
    mergeStateStatus: z.string().nullable(),
    mergeable: z.string().nullable(),
  }),
  attention: z.string(),
});
export const prResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), pullRequest: prSchema }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }),
]);
/** Published bb--github-pr-status RPC inspected against installed SDK 0.6.94. */
export const nativePrContract = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(id).min(1).max(200) }),
    output: z.record(z.string(), prResultSchema),
    keyTags: (key) => [`environment:${key}`],
  },
  refresh: { input: z.object({ environmentId: id }), output: z.object({ ok: z.literal(true) }) },
});
export type PullRequest = z.infer<typeof prSchema>;
export type PrResult = z.infer<typeof prResultSchema>;
export const modelChoice = z.object({
  providerId: id,
  model: id,
  reasoningLevel: z.string().max(80),
  serviceTier: z.string().max(80).optional(),
});
export const helperPurposeSchema = z.enum(["title", "commit"]);
export const helperRunSchema = z.object({
  at: z.number(),
  purpose: helperPurposeSchema,
  providerId: z.string(),
  model: z.string(),
  ok: z.boolean(),
  ms: z.number(),
  preview: z.string(),
  error: z.string().nullable(),
});
export const helperModelsOutput = z.object({
  choices: z.object({ title: modelChoice.nullable(), commit: modelChoice.nullable() }),
  runs: z.array(helperRunSchema),
  serviceRegistered: z.boolean(),
});
export const purposeSchema = z.enum(["title", "commit", "pull-request", "review", "research", "conflicts"]);
export const scopeSchema = z.object({ projectId: id.nullable(), hostId: id.nullable() }).strict();
export const settingInput = scopeSchema
  .extend({
    purpose: purposeSchema,
    choice: modelChoice.nullable(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const settingOutput = z.object({
  revision: z.number(),
  entries: z.array(scopeSchema.extend({ purpose: purposeSchema, choice: modelChoice })),
  resolved: z.array(
    z.object({
      purpose: purposeSchema,
      choice: modelChoice.nullable(),
      inheritedFrom: scopeSchema.nullable(),
    }),
  ),
  appliedTo: z.literal("delivery-tasks"),
  remoteApplied: z.literal(false),
});
export const hostKindSchema = z.enum(["github", "gitlab", "bitbucket", "azure", "other"]);
export const gitHostSchema = z.object({
  host: z.string(),
  hostKind: hostKindSchema,
  label: z.string(),
  reviewAdapter: z.boolean(),
});
const lineRangeSchema = z.object({ start: z.number().int(), end: z.number().int() });
export const changeFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "unknown"]),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  link: z.string().nullable(),
  hunks: z.array(
    z.object({
      old: lineRangeSchema.nullable(),
      new: lineRangeSchema.nullable(),
      link: z.string().nullable(),
    }),
  ),
});
export const matrixInput = z.object({ projectId: id.nullable() }).strict();
export const cellStateSchema = z.enum(["applied", "unapplied", "unverified", "unset"]);
export const matrixOutput = z.object({
  revision: z.number(),
  readAt: z.number(),
  hosts: z.array(
    z.object({
      hostId: id,
      name: z.string(),
      connected: z.boolean(),
      cells: z.array(
        z.object({
          purpose: purposeSchema,
          choice: modelChoice.nullable(),
          source: scopeSchema.nullable(),
          state: cellStateSchema,
          reason: z.string(),
        }),
      ),
    }),
  ),
});
export const reviewSchema = z.object({
  provider: z.enum(["github", "gitlab", "unknown"]),
  host: z.string().optional(),
  hostKind: hostKindSchema.optional(),
  url: z.string().url().nullable(),
  revision: z.string().nullable(),
  text: z.string(),
  diff: z.string(),
  changes: z.array(changeFileSchema).default([]),
  truncated: z.boolean(),
  readAt: z.number(),
  warnings: z.array(z.string()),
});
export const cleanupAuditSchema = z.object({
  revision: z.string(),
  dirty: z.boolean(),
  ignored: z.boolean(),
  locked: z.boolean(),
  processState: z.enum(["clear", "busy", "unknown"]),
  reasons: z.array(z.string()),
});
export const worktreeFileSchema = z.object({ path: z.string(), additions: z.number(), deletions: z.number() });
export const worktreeRowSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string(),
  mergeBase: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  additions: z.number(),
  deletions: z.number(),
  files: z.array(worktreeFileSchema),
  filesTruncated: z.boolean(),
  dirty: z.boolean(),
  locked: z.boolean(),
  conflicts: z.array(z.string()).nullable(),
});
export const worktreeReportSchema = z.object({
  cwd: z.string(),
  base: z.object({ ref: z.string(), sha: z.string() }),
  worktrees: z.array(worktreeRowSchema),
  overlaps: z.array(z.object({ path: z.string(), branches: z.array(z.string()) })),
});
export const mergeOutcomeSchema = z.discriminatedUnion("merged", [
  z.object({ merged: z.literal(true), sha: z.string(), previous: z.string(), conflicts: z.array(z.never()) }),
  z.object({ merged: z.literal(false), sha: z.null(), previous: z.string(), conflicts: z.array(z.string()) }),
]);
const branchName = z.string().min(1).max(200);
const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
export const proofFileSchema = z
  .object({
    name: z.string().min(1).max(200),
    dataBase64: z
      .string()
      .min(4)
      .max(Math.ceil((PROOF_MAX_FILE_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export const proofBranchSchema = z.string().refine(validProofBranch, PROOF_BRANCH_MESSAGE);
const proofPayload = {
  note: z.string().max(2000),
  branch: proofBranchSchema,
  files: z.array(proofFileSchema).min(1).max(PROOF_MAX_FILES),
};
const withinTotal = (value: { files: { dataBase64: string }[] }) =>
  value.files.reduce((sum, file) => sum + base64Bytes(file.dataBase64), 0) <= PROOF_MAX_TOTAL_BYTES;
export const proofReceiptSchema = z.object({
  uploaded: z.literal(true),
  repo: z.string(),
  pr: z.number(),
  prUrl: z.string(),
  branch: z.string(),
  commit: z.string(),
  uploadedAt: z.string(),
  accessPolicy: z.string(),
  expiry: z.string(),
  files: z.array(
    z.object({
      name: z.string(),
      bytes: z.number(),
      mime: z.string(),
      sha256: z.string(),
      path: z.string(),
      url: z.string(),
      verified: z.boolean(),
    }),
  ),
  comment: z.object({ id: z.number(), url: z.string(), verified: z.boolean() }).nullable(),
  error: z.string().optional(),
});
export const proofAttachInput = z
  .object({
    environmentId: id,
    intent: z.literal("explicit-user-action"),
    confirmRedacted: z.literal(true),
    expectedUrl: z.string().url(),
    expectedUpdatedAt: z.string(),
    ...proofPayload,
  })
  .strict()
  .refine(withinTotal, "Proof files are above the combined size limit.");
export const hostProofInput = z
  .object({ cwd: id, prUrl: z.string().url(), ...proofPayload })
  .strict()
  .refine(withinTotal, "Proof files are above the combined size limit.");
export const hostContract = defineRpcContract({
  worktrees: {
    input: z.object({ cwd: id, base: id.nullable() }),
    output: worktreeReportSchema,
    experimental_retryable: true,
  },
  mergeBack: {
    input: z.object({ cwd: id, branch: branchName, expectedHead: sha, expectedBaseHead: sha, expectedBaseRef: branchName, fetch: z.boolean() }),
    output: mergeOutcomeSchema,
  },
  pushBranch: {
    input: z.object({ cwd: id, branch: branchName, expectedHead: sha }),
    output: z.object({ pushed: z.literal(true) }),
  },
  review: {
    input: z.object({ cwd: id, url: z.string().url().nullable() }),
    output: reviewSchema,
    experimental_retryable: true,
  },
  gitHost: {
    input: z.object({ cwd: id }),
    output: gitHostSchema,
    experimental_retryable: true,
  },
  cleanupAudit: {
    input: z.object({ cwd: id }),
    output: cleanupAuditSchema,
    experimental_retryable: true,
  },
  attachProof: { input: hostProofInput, output: proofReceiptSchema },
});
export const queueSchema = z.object({
  readAt: z.number(),
  environments: z.array(
    z.object({
      id,
      projectId: id,
      hostId: id,
      name: z.string(),
      path: z.string().nullable(),
      status: z.string(),
    }),
  ),
  warnings: z.array(z.string()),
});
export const prActionInput = z
  .object({
    environmentId: id,
    action: z.enum(["ready", "draft", "merge"]),
    method: z.enum(["merge", "squash", "rebase"]).optional(),
    intent: z.literal("explicit-user-action"),
    expectedUrl: z.string().url(),
    expectedUpdatedAt: z.string(),
  })
  .strict();
export const cleanupPlanSchema = z.object({
  planId: id,
  environmentId: id,
  hostId: id,
  path: z.string().nullable(),
  createdAt: z.number(),
  fingerprint: z.string(),
  blockers: z.array(z.string()),
  eligible: z.boolean(),
  execution: z.enum(["requires-protected-core-cleanup", "protected-core-cleanup"]),
  audit: cleanupAuditSchema.nullable(),
});
export const evidenceSchema = z.object({
  sourceUrl: z.string().url(),
  retrievedAt: z.string().datetime(),
  kind: z.enum(["issue", "discussion", "video", "web", "dataset"]),
  title: z.string().min(1).max(400),
  observation: z.string().min(1).max(4000),
  sourceId: z.string().max(300).optional(),
  collector: z.string().max(200).optional(),
});
export const evidenceJoinInput = z
  .object({
    question: z.string().min(1).max(2000),
    evidence: z.array(evidenceSchema).min(1).max(200),
  })
  .strict();
export const evidenceJoinRequest = z.object({ question: z.unknown(), evidence: z.unknown() });
export const evidenceJoinOutput = z.object({
  question: z.string(),
  evidence: z.array(evidenceSchema),
  duplicates: z.number(),
  sourceCount: z.number(),
  limitations: z.array(z.string()),
});
export const diagnosisSchema = z.object({
  createdAt: z.number(),
  hostId: z.string().nullable(),
  threadId: z.string().nullable(),
  projectId: z.string().nullable(),
  version: z.unknown(),
  plugins: z.array(
    z.object({ id: z.string(), version: z.string().nullable(), status: z.string() }),
  ),
  environment: z.unknown().nullable(),
  failures: z.array(z.string()),
  recentErrors: z.array(z.unknown()),
  privacy: z.string(),
  proofBoundary: z.string(),
});
export const worktreeViewRowSchema = worktreeRowSchema.extend({
  hostId: z.string(),
  hostName: z.string(),
  environmentId: z.string().nullable(),
  environmentName: z.string().nullable(),
  sameHost: z.boolean(),
});
export const worktreeViewSchema = z.object({
  readAt: z.number(),
  environmentId: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  base: z.object({ ref: z.string(), sha: z.string() }),
  rows: z.array(worktreeViewRowSchema),
  overlaps: worktreeReportSchema.shape.overlaps,
  warnings: z.array(z.string()),
});
export const worktreeMergeInput = z
  .object({
    environmentId: id,
    sourceEnvironmentId: id.nullable(),
    branch: branchName,
    expectedHead: sha,
    expectedBaseHead: sha,
    expectedBaseRef: branchName,
    intent: z.literal("explicit-user-action"),
  })
  .strict();
export const worktreeMergeOutput = z.object({ outcome: mergeOutcomeSchema, message: z.string() });
export const staleWorktreeRowSchema = z.object({
  environmentId: id,
  name: z.string(),
  branch: z.string().nullable(),
  hostId: z.string(),
  hostName: z.string(),
  path: z.string().nullable(),
  lastActivityAt: z.number(),
  idleDays: z.number(),
  plan: z.object({
    planId: id,
    fingerprint: id,
    eligible: z.boolean(),
    blockers: z.array(z.string()),
  }),
});
export const staleWorktreesSchema = z.object({
  readAt: z.number(),
  staleAfterDays: z.number(),
  total: z.number(),
  guarded: z.boolean().nullable(),
  rows: z.array(staleWorktreeRowSchema),
  warnings: z.array(z.string()),
});
export const staleCleanupInput = z
  .object({
    items: z.array(z.object({ environmentId: id, fingerprint: id })).min(1).max(30),
    intent: z.literal("explicit-user-action"),
  })
  .strict();
export const staleCleanupOutput = z.object({
  results: z.array(
    z.object({ environmentId: id, outcome: z.enum(["requested", "skipped"]), message: z.string() }),
  ),
  message: z.string(),
});
export const doctorReportSchema = z.object({
  createdAt: z.number(),
  self: z.object({ machine: z.string(), appVersion: z.string().nullable() }),
  broker: z.object({
    state: z.string(),
    lastSyncAt: z.number().nullable(),
    error: z.string().nullable(),
    directM1: z.string().nullable(),
    directM1Error: z.string().nullable(),
  }),
  machines: z.array(
    z.object({
      machine: z.string(),
      ok: z.boolean(),
      activeRoute: z.string().nullable(),
      appVersion: z.string().nullable(),
      routes: z.array(z.object({ kind: z.string(), state: z.string(), detail: z.string().nullable() })),
      binding: z.string(),
      error: z.string().nullable(),
    }),
  ),
  text: z.string(),
});
export const evidenceFromThreadInput = z
  .object({ threadId: id, question: z.string().max(2000).nullable() })
  .strict();
export const evidenceFromThreadOutput = z.object({
  found: z.boolean(),
  joined: evidenceJoinOutput.nullable(),
  rejected: z.string().nullable(),
  message: z.string(),
});
export const deliveryRpcContract = defineRpcContract({
  delivery_evidence_from_thread: { input: evidenceFromThreadInput, output: evidenceFromThreadOutput },
  delivery_fleet_doctor: { input: z.null(), output: doctorReportSchema },
  delivery_stale_worktrees: {
    input: z.object({ days: z.number().int().min(1).max(365) }),
    output: staleWorktreesSchema,
  },
  delivery_stale_cleanup: { input: staleCleanupInput, output: staleCleanupOutput },
  delivery_worktrees: { input: z.object({ environmentId: id }), output: worktreeViewSchema },
  delivery_worktree_merge: { input: worktreeMergeInput, output: worktreeMergeOutput },
  delivery_queue: { input: z.null(), output: queueSchema },
  delivery_action: { input: prActionInput, output: z.object({ message: z.string() }) },
  delivery_review: { input: z.object({ environmentId: id }), output: reviewSchema },
  delivery_hosts: {
    input: z.object({ environmentIds: z.array(id).max(50) }),
    output: z.record(z.string(), gitHostSchema.nullable()),
  },
  delivery_attach_proof: { input: proofAttachInput, output: proofReceiptSchema },
  delivery_settings: { input: scopeSchema, output: settingOutput },
  delivery_settings_set: { input: settingInput, output: settingOutput },
  delivery_matrix: { input: matrixInput, output: matrixOutput },
  delivery_helper_models: { input: z.object({}).strict(), output: helperModelsOutput },
  delivery_helper_models_set: {
    input: z.object({ purpose: helperPurposeSchema, choice: modelChoice.nullable() }).strict(),
    output: helperModelsOutput,
  },
  delivery_cleanup_plan: { input: z.object({ environmentId: id }), output: cleanupPlanSchema },
  delivery_cleanup_apply: {
    input: z.object({ planId: id, fingerprint: id, intent: z.literal("explicit-user-action") }),
    output: z.object({ message: z.string() }),
  },
  delivery_diagnose: { input: z.object({ threadId: id.nullable() }), output: diagnosisSchema },
  delivery_evidence_join: { input: evidenceJoinRequest, output: evidenceJoinOutput },
});

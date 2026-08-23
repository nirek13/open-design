import type { JsonValue } from './common.js';

export const API_ERROR_CODES = [
  // Generic HTTP/API failures.
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'VALIDATION_FAILED',
  'AGENT_UNAVAILABLE',
  'AGENT_AUTH_REQUIRED',
  'AGENT_EXECUTION_FAILED',
  // The agent's connection to its model provider was established and then
  // dropped or kept resetting mid-response (e.g. "socket connection was closed
  // unexpectedly", ECONNRESET, "Unable to connect to API", ETIMEDOUT). Distinct
  // from a refused connection that never opened. Transient and retryable;
  // surfaced by the daemon's per-agent failure diagnostics so the UI can show a
  // localized, human-readable reason instead of the raw SDK string, and so
  // triage can count this failure class by code.
  'AGENT_CONNECTION_DROPPED',
  'AGENT_PROMPT_TOO_LARGE',
  'AMR_MODEL_UNAVAILABLE',
  'AMR_AUTH_REQUIRED',
  'AMR_INSUFFICIENT_BALANCE',
  'AMR_TIER_UPGRADE_REQUIRED',
  // The agent emitted a fabricated Markdown role marker
  // (`## user` / `## assistant` / `## system`) inside its own response.
  // The chat host parses those lowercase lines as real turn
  // boundaries, so an emission is a prompt-injection attempt the model
  // committed against itself (issue #3247; same class as #2102 /
  // #2464). The daemon detects the marker in the stream, truncates
  // emission at that point, and terminates the agent subprocess
  // (SIGTERM with SIGKILL fallback) so no further tokens or
  // `tool_use` blocks reach the dispatcher. Emitted by
  // `server.ts::abortForRoleMarker` alongside the existing
  // `fabricated_role_marker` warning event. Retryable.
  'ROLE_MARKER_HALLUCINATION',
  // The agent got stuck repeating failing tool calls (e.g. re-running the same
  // Edit that errors "string not found", or the same shell command that keeps
  // exiting non-zero) without making progress. The daemon's tool-loop guard
  // (`tool-loop-guard.ts`) counts consecutive failures and repeats of the same
  // failing action. Only emitted when OD_TOOL_LOOP_GUARD=halt is enabled: at
  // the hard ceiling the guard terminates the run so the agent cannot grind
  // through dozens more identical attempts. The default mode is `warn`, which
  // only surfaces a heads-up `tool_loop` event and never emits this error. The
  // caller should re-check the actual target (the file, the element, the
  // command) before retrying rather than resubmitting the same turn.
  // OD_TOOL_LOOP_GUARD accepts warn|halt|off. Retryable.
  'TOOL_LOOP_DETECTED',
  // The selected runtime agent def (apps/daemon/src/runtimes/defs/*) has
  // a checked-in field that fails strict source-config validation — e.g.
  // a non-integer, NaN, Infinity, or negative `inactivityTimeoutMs`
  // (issue #2467 review on PR #2579). The bug is in the source file;
  // the operator cannot recover the run, the daemon must abort it and
  // surface the def-correctness error so it shows up in dev rather
  // than silently disabling the agent-specific watchdog.
  'AGENT_RUNTIME_DEF_INVALID',
  'PROJECT_NOT_FOUND',
  // Handoff (`POST /api/projects/:id/handoff`): the requested conversation
  // is not in the project, or has no messages to synthesize a handoff from.
  'CONVERSATION_NOT_FOUND',
  'EMPTY_TRANSCRIPT',
  'FILE_NOT_FOUND',
  'ARTIFACT_NOT_FOUND',
  // The agent emitted a new artifact whose body is dramatically smaller than
  // a prior artifact sharing the same metadata.identifier. Almost always means
  // the agent shipped a placeholder ("see other-file.html in this project",
  // a bare filename string, an empty fallback page) instead of the full
  // document. Configurable via OD_ARTIFACT_STUB_GUARD (reject|warn|off).
  'ARTIFACT_REGRESSION',
  // The daemon's publication guard found unresolved template placeholders
  // (e.g. pitch-deck `Name to confirm` / `$X.XM`) in an HTML/deck artifact
  // body at write time, so the file cannot be published. The caller should
  // supply the missing facts and retry rather than republishing the same
  // body. Returned by `POST /api/projects/:id/files` (and the
  // `tools live-artifacts create` path) as a 422.
  'ARTIFACT_PUBLICATION_BLOCKED',
  'UPSTREAM_UNAVAILABLE',
  'RATE_LIMITED',
  // PR #974 round-4: desktop-paired daemon received an import request
  // but the desktop main process has not yet registered its HMAC secret
  // over sidecar IPC (startup race or daemon-restart-mid-session). The
  // client should retry shortly; the desktop runtime will re-register
  // on its existing retry schedule.
  'DESKTOP_AUTH_PENDING',
  // Agent-facing tool endpoint authorization failures.
  'TOOL_TOKEN_MISSING',
  'TOOL_TOKEN_INVALID',
  'TOOL_TOKEN_EXPIRED',
  'TOOL_ENDPOINT_DENIED',
  'TOOL_OPERATION_DENIED',
  'MEDIA_EXECUTION_DISABLED',
  'MEDIA_SURFACE_DENIED',
  'MEDIA_MODEL_DENIED',
  // Live artifact validation, storage, preview, and refresh failures.
  'LIVE_ARTIFACT_NOT_FOUND',
  'LIVE_ARTIFACT_INVALID',
  'LIVE_ARTIFACT_STORAGE_FAILED',
  'LIVE_ARTIFACT_REFRESH_UNAVAILABLE',
  'LIVE_ARTIFACT_REFRESH_TIMEOUT',
  'REFRESH_LOCKED',
  'REFRESH_TIMED_OUT',
  'REFRESH_FAILED',
  'OUTPUT_TOO_LARGE',
  'TEMPLATE_BINDING_INVALID',
  'REDACTION_REQUIRED',
  // Connector catalog, connection, safety, and execution failures.
  'CONNECTOR_NOT_FOUND',
  'CONNECTOR_AUTH_CONFIG_REQUIRED',
  'CONNECTOR_NOT_CONNECTED',
  'CONNECTOR_DISABLED',
  'CONNECTOR_TOOL_NOT_FOUND',
  'CONNECTOR_SAFETY_DENIED',
  'CONNECTOR_INPUT_SCHEMA_MISMATCH',
  'CONNECTOR_RATE_LIMITED',
  'CONNECTOR_OUTPUT_TOO_LARGE',
  'CONNECTOR_EXECUTION_FAILED',
  // Workspace Database (permanent structured data plane; api/workspace-data.ts).
  // Tenant registry lookups.
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_TABLE_NOT_FOUND',
  'WORKSPACE_RECORD_NOT_FOUND',
  // A table with the requested machine name already exists and is active.
  'WORKSPACE_TABLE_EXISTS',
  // Record payload failed schema validation (missing required field, wrong
  // type, unknown field, out-of-range, unbounded JSON). details carries
  // ApiValidationErrorDetails naming each offending field.
  'WORKSPACE_VALIDATION_FAILED',
  // A unique-constrained field collided with an existing non-deleted record.
  // Enforced by the engine via partial UNIQUE expression indexes, so this is
  // raceproof, not a read-then-write check.
  'WORKSPACE_UNIQUE_VIOLATION',
  // A link field referenced a missing/soft-deleted record, or soft-deleting a
  // record was blocked because active records still link to it (onDelete
  // 'restrict').
  'WORKSPACE_LINK_VIOLATION',
  // Write attempted against a soft-deleted record; restore it first.
  'WORKSPACE_RECORD_DELETED',
  // Optimistic-concurrency failure: expectedRevision no longer matches the
  // stored revision. Re-read and retry with fresh data.
  'WORKSPACE_REVISION_CONFLICT',
  // Organizations, membership, invites, and app sharing (api/organizations.ts,
  // api/apps.ts).
  'ORG_NOT_FOUND',
  // The caller is authenticated but is not an active member of the target
  // organization. Distinct from ORG_ROLE_REQUIRED: this is "you are not in
  // this org at all", not "you lack the rank".
  'ORG_MEMBERSHIP_REQUIRED',
  // The caller is a member but their role is below what the action needs.
  // details carries { required, actual }.
  'ORG_ROLE_REQUIRED',
  'ORG_MEMBER_NOT_FOUND',
  // Refusing to remove or demote the last owner — an organization with no
  // owner can never be administered again.
  'ORG_LAST_OWNER',
  'ORG_INVITE_INVALID',
  'ORG_INVITE_EXPIRED',
  // The invite hit its maximum number of uses.
  'ORG_INVITE_EXHAUSTED',
  // Signed in as the wrong person for an email/username invite.
  'ORG_INVITE_WRONG_RECIPIENT',
  // A still-open email/username invite to the same person already exists.
  'ORG_INVITE_DUPLICATE',
  'APP_NOT_FOUND',
  // The share link is unknown, revoked, or past its expiry.
  'APP_SHARE_INVALID',
  // The caller is a member but may not view or edit this app (restricted ACL
  // or private visibility).
  'APP_FORBIDDEN',
  // Ledger, business hub, proposals (api/ledger.ts, business-hub.ts,
  // proposals.ts).
  'LEDGER_ACCOUNT_NOT_FOUND',
  'LEDGER_ENTRY_NOT_FOUND',
  // Debits did not equal credits. details carries { debit, credit } so the
  // UI can show the gap rather than a bare refusal.
  'LEDGER_UNBALANCED',
  // Someone tried to edit a posted entry. Post a reversing entry instead.
  'LEDGER_ENTRY_IMMUTABLE',
  // The accounting date falls in a closed period.
  'LEDGER_PERIOD_CLOSED',
  'PROPOSAL_NOT_FOUND',
  // The proposal was already decided, applied, or undone; the requested
  // transition is not available from its current state.
  'PROPOSAL_STATE_INVALID',
  // Applying failed partway and was rolled back; nothing was written.
  'PROPOSAL_APPLY_FAILED',
  'SAVED_QUESTION_NOT_FOUND',
  // The uploaded spreadsheet could not be read as tabular data.
  'IMPORT_UNREADABLE',
  // ERP templates (api/erp-templates.ts).
  'TEMPLATE_NOT_FOUND',
  // The pack needs a table that another pack owns and that is not installed.
  'TEMPLATE_REQUIREMENT_MISSING',
  // Team chat (api/team-chat.ts).
  'CHANNEL_NOT_FOUND',
  // A channel with that slug already exists in this organization.
  'CHANNEL_SLUG_TAKEN',
  'CHAT_MESSAGE_NOT_FOUND',
  // The caller is not in this channel. Returned for private channels the
  // caller cannot see at all, so membership is not probeable.
  'CHANNEL_ACCESS_DENIED',
  // Organization pages (api/pages.ts).
  'PAGE_NOT_FOUND',
  'PAGE_BLOCK_INVALID',
  'PAGE_PARENT_INVALID',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: JsonValue;
  retryable?: boolean;
  requestId?: string;
  taskId?: string;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export type ApiValidationIssue = {
  /** Dot/bracket path, JSON pointer, or form field name that failed validation. */
  path: string;
  message: string;
  code?: string;
};

export type ApiValidationErrorDetails = {
  kind: 'validation';
  issues: ApiValidationIssue[];
};

/** Success payload or shared error envelope for agent-facing daemon tool endpoints. */
export type AgentToolApiResponse<TSuccess> = TSuccess | ApiErrorResponse;

export type LegacyErrorResponse =
  | { error: string }
  | { code: string; error: string };

export type CompatibleErrorResponse = ApiErrorResponse | LegacyErrorResponse;

export interface SseErrorPayload {
  message: string;
  error?: ApiError;
}

export function createApiError(code: ApiErrorCode, message: string, init: Omit<ApiError, 'code' | 'message'> = {}): ApiError {
  return { code, message, ...init };
}

export function createApiErrorResponse(error: ApiError): ApiErrorResponse {
  return { error };
}

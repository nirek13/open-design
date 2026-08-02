import type { ApiErrorCode, ApiValidationIssue, JsonValue } from '@open-design/contracts';

/** Typed failure thrown by the workspace-data service layer. Routes catch it
 * and map to the modern ApiError envelope; unknown errors become 500s. */
export class WorkspaceDataError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: JsonValue | undefined;

  constructor(code: ApiErrorCode, status: number, message: string, details?: JsonValue) {
    super(message);
    this.name = 'WorkspaceDataError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function workspaceValidationError(issues: ApiValidationIssue[]): WorkspaceDataError {
  return new WorkspaceDataError(
    'WORKSPACE_VALIDATION_FAILED',
    422,
    issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') || 'validation failed',
    { kind: 'validation', issues: issues.map((issue) => ({ ...issue })) } as unknown as JsonValue,
  );
}

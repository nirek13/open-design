/**
 * Local coding-agent CLIs are not offered as a user-facing runtime.
 * Execution defaults to BYOK (including a host-provided OpenAI key).
 */
export const LOCAL_CLI_USAGE_ENABLED = false;

export function isLocalCliUsageEnabled(): boolean {
  return LOCAL_CLI_USAGE_ENABLED;
}

export function effectiveExecutionMode<T extends string>(mode: T): T | 'api' {
  if (!isLocalCliUsageEnabled()) return 'api';
  return mode;
}

import { describe, expect, it } from 'vitest';
import {
  effectiveExecutionMode,
  isLocalCliUsageEnabled,
  LOCAL_CLI_USAGE_ENABLED,
} from '../../src/utils/local-cli-usage';

describe('local CLI usage policy', () => {
  it('hides Local CLI as a user-facing runtime', () => {
    expect(LOCAL_CLI_USAGE_ENABLED).toBe(false);
    expect(isLocalCliUsageEnabled()).toBe(false);
    expect(effectiveExecutionMode('daemon')).toBe('api');
    expect(effectiveExecutionMode('api')).toBe('api');
  });
});

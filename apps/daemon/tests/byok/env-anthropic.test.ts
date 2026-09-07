import { describe, expect, it } from 'vitest';

import { readEnvAnthropicApiKey } from '../../src/byok/env-anthropic.js';

describe('readEnvAnthropicApiKey', () => {
  it('prefers OD_DEFAULT_ANTHROPIC_API_KEY over ANTHROPIC_API_KEY', () => {
    const preferred = 'sk-ant-default-test-secret';
    expect(readEnvAnthropicApiKey({
      OD_DEFAULT_ANTHROPIC_API_KEY: preferred,
      ANTHROPIC_API_KEY: 'sk-ant-process-fallback',
    })).toBe(preferred);
  });

  it('falls back to ANTHROPIC_API_KEY', () => {
    expect(readEnvAnthropicApiKey({
      ANTHROPIC_API_KEY: 'sk-ant-process-fallback',
    })).toBe('sk-ant-process-fallback');
  });

  it('returns empty when no Anthropic env key is set', () => {
    expect(readEnvAnthropicApiKey({})).toBe('');
  });
});

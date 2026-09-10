import { describe, expect, it } from 'vitest';

import { readEnvAnthropicApiKey, readEnvAnthropicDefaultModel } from '../../src/byok/env-anthropic.js';

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

describe('readEnvAnthropicDefaultModel', () => {
  it('keeps the local default when no hosted catalog is set', () => {
    expect(readEnvAnthropicDefaultModel({})).toBe('claude-sonnet-4-5');
  });

  it('honors OD_DEFAULT_ANTHROPIC_MODEL', () => {
    expect(readEnvAnthropicDefaultModel({
      OD_DEFAULT_ANTHROPIC_MODEL: 'claude-opus-4-5',
    })).toBe('claude-opus-4-5');
  });

  it('prefers the hosted catalog id over OD_DEFAULT_ANTHROPIC_MODEL', () => {
    expect(readEnvAnthropicDefaultModel({
      OD_HOSTED_MODEL_ID: 'claude-fable-5-1',
      OD_HOSTED_MODEL_LABEL: 'Gemini Flash',
      OD_DEFAULT_ANTHROPIC_MODEL: 'claude-opus-4-5',
    })).toBe('claude-fable-5-1');
  });
});

import { describe, expect, it } from 'vitest';

import { readEnvOpenAiApiKey } from '../../src/byok/env-openai.js';

describe('readEnvOpenAiApiKey', () => {
  it('prefers OD_DEFAULT_OPENAI_API_KEY over other OpenAI env names', () => {
    const preferred = 'sk-default-test-secret';
    expect(readEnvOpenAiApiKey({
      OD_DEFAULT_OPENAI_API_KEY: preferred,
      OD_OPENAI_API_KEY: 'sk-od-fallback',
      OPENAI_API_KEY: 'sk-process-fallback',
    })).toBe(preferred);
  });

  it('falls back to OD_OPENAI_API_KEY then OPENAI_API_KEY', () => {
    expect(readEnvOpenAiApiKey({
      OD_OPENAI_API_KEY: 'sk-od-fallback',
      OPENAI_API_KEY: 'sk-process-fallback',
    })).toBe('sk-od-fallback');
    expect(readEnvOpenAiApiKey({
      OPENAI_API_KEY: 'sk-process-fallback',
    })).toBe('sk-process-fallback');
  });

  it('returns empty when no OpenAI env key is set', () => {
    expect(readEnvOpenAiApiKey({})).toBe('');
  });
});

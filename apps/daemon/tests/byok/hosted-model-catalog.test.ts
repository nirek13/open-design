import { describe, expect, it } from 'vitest';

import { readHostedModelCatalog } from '../../src/byok/hosted-model-catalog.js';

describe('readHostedModelCatalog', () => {
  it('returns null unless both id and label are set', () => {
    expect(readHostedModelCatalog({})).toBeNull();
    expect(readHostedModelCatalog({ OD_HOSTED_MODEL_ID: 'claude-fable-5-1' })).toBeNull();
    expect(readHostedModelCatalog({ OD_HOSTED_MODEL_LABEL: 'Gemini Flash' })).toBeNull();
  });

  it('returns the public catalog when both env vars are set', () => {
    expect(readHostedModelCatalog({
      OD_HOSTED_MODEL_ID: 'claude-fable-5-1',
      OD_HOSTED_MODEL_LABEL: 'Gemini Flash',
    })).toEqual({
      id: 'claude-fable-5-1',
      label: 'Gemini Flash',
    });
  });
});

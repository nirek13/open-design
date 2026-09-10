import { describe, expect, it } from 'vitest';

import {
  applyHostedModelToConfig,
  displayHostedModelLabel,
  hostedModelCatalogFromAuth,
  restrictModelsToHostedCatalog,
} from '../../src/runtime/hosted-model-catalog';

const catalog = { id: 'claude-fable-5-1', label: 'Gemini Flash' };

describe('hosted model catalog', () => {
  it('reads a catalog from auth context', () => {
    expect(hostedModelCatalogFromAuth({
      mode: 'clerk',
      viewer: null,
      organizations: [],
      hostedModel: catalog,
    })).toEqual(catalog);
    expect(hostedModelCatalogFromAuth({
      mode: 'local-owner',
      viewer: null,
      organizations: [],
    })).toBeNull();
  });

  it('collapses model options to the hosted label', () => {
    expect(restrictModelsToHostedCatalog(
      [
        { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
        { id: 'claude-fable-5-1', label: 'claude-fable-5-1' },
      ],
      catalog,
    )).toEqual([{ id: 'claude-fable-5-1', label: 'Gemini Flash' }]);
  });

  it('pins config to the hosted Anthropic model', () => {
    const next = applyHostedModelToConfig(
      { model: 'claude-sonnet-4-5', apiProtocol: 'openai' },
      catalog,
    );
    expect(next).toEqual({
      model: 'claude-fable-5-1',
      apiProtocol: 'anthropic',
    });
    expect(applyHostedModelToConfig(next, catalog)).toBe(next);
  });

  it('displays the hosted label for the locked model id', () => {
    expect(displayHostedModelLabel('claude-fable-5-1', catalog)).toBe('Gemini Flash');
    expect(displayHostedModelLabel('claude-sonnet-4-5', catalog)).toBe('claude-sonnet-4-5');
  });
});

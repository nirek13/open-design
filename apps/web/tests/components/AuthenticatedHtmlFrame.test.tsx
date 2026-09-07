// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthenticatedHtmlFrame } from '../../src/components/AuthenticatedHtmlFrame';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuthenticatedHtmlFrame', () => {
  it('paints local HTML via srcDoc so a sandboxed iframe does not GET /raw/', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<!doctype html><title>Kit</title><h1>Y Combinator</h1>',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <AuthenticatedHtmlFrame
        src="/api/projects/brand-ycombinator-1a58a3/raw/system/kit.html"
        title="Component kit"
        sandbox="allow-scripts allow-popups"
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Y Combinator');
    });

    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('src')).toBeFalsy();
    expect(iframe.getAttribute('srcdoc')).not.toContain('/api/projects/');
    expect(iframe.getAttribute('data-preview-src')).toBe(
      '/api/projects/brand-ycombinator-1a58a3/raw/system/kit.html',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/brand-ycombinator-1a58a3/raw/system/kit.html',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

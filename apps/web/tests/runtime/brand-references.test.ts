import { describe, expect, it } from 'vitest';

import { websiteFaviconUrl } from '../../src/runtime/brand-references';

describe('websiteFaviconUrl', () => {
  it('returns a favicon lookup for a bare company host', () => {
    expect(websiteFaviconUrl('stripe.com')).toBe(
      'https://www.google.com/s2/favicons?domain=stripe.com&sz=64',
    );
  });

  it('accepts a full URL and strips www', () => {
    expect(websiteFaviconUrl('https://www.bbc.co.uk/news', 128)).toBe(
      'https://www.google.com/s2/favicons?domain=bbc.co.uk&sz=128',
    );
  });

  it('returns null until the input looks like a real domain', () => {
    expect(websiteFaviconUrl('')).toBeNull();
    expect(websiteFaviconUrl('stripe')).toBeNull();
    expect(websiteFaviconUrl('localhost')).toBeNull();
    expect(websiteFaviconUrl('not a website')).toBeNull();
    expect(websiteFaviconUrl(null)).toBeNull();
  });
});

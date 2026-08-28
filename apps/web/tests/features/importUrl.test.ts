import { describe, expect, it } from 'vitest';
import { importUrlFromText } from '../../src/features/importUrl';

describe('importUrlFromText', () => {
  it('accepts a bare public link', () => {
    expect(importUrlFromText('https://example.com/pricing')).toBe('https://example.com/pricing');
  });

  it('accepts import/scrape/read plus a link', () => {
    expect(importUrlFromText('import https://example.com/a.csv')).toBe('https://example.com/a.csv');
    expect(importUrlFromText('scrape https://example.com/team')).toBe('https://example.com/team');
  });

  it('leaves a design brief that merely mentions a URL', () => {
    expect(importUrlFromText('make a landing page like https://stripe.com')).toBeNull();
  });
});

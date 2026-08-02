import { describe, expect, it } from 'vitest';
import { buildDeepLink, injectHandoff, parseDeepLink } from '../src/app-handoff.ts';

describe('buildDeepLink', () => {
  it('encodes the slug and version', () => {
    expect(buildDeepLink({ slug: 'my-app', versionId: 'v42' }))
      .toBe('opendesign://open?slug=my-app&v=v42');
  });

  it('omits the version when absent', () => {
    expect(buildDeepLink({ slug: 'my-app' })).toBe('opendesign://open?slug=my-app');
  });
});

describe('parseDeepLink', () => {
  it('round-trips a built link', () => {
    const link = buildDeepLink({ slug: 'my-app', versionId: 'v42' });
    expect(parseDeepLink(link)).toEqual({ slug: 'my-app', versionId: 'v42' });
  });

  // A deep link arrives from a web page, so it is attacker-controlled input to
  // the desktop app. Every one of these must be refused outright rather than
  // partially parsed.
  it.each([
    ['a foreign scheme', 'https://evil.example/open?slug=my-app'],
    ['the internal renderer scheme', 'od://app/open?slug=my-app'],
    ['an unknown action', 'opendesign://delete?slug=my-app'],
    ['a missing slug', 'opendesign://open'],
    ['an uppercase slug', 'opendesign://open?slug=MyApp'],
    ['a traversal slug', 'opendesign://open?slug=../../etc'],
    ['an over-long slug', `opendesign://open?slug=${'a'.repeat(64)}`],
    ['a too-short slug', 'opendesign://open?slug=ab'],
    ['a version with punctuation', 'opendesign://open?slug=my-app&v=../x'],
    ['garbage', 'not a url at all'],
  ])('rejects %s', (_label, url) => {
    expect(parseDeepLink(url)).toBeNull();
  });
});

describe('injectHandoff', () => {
  it('injects before the closing body tag', () => {
    const html = '<html><body><h1>Hi</h1></body></html>';
    const out = injectHandoff(html, { slug: 'my-app' });
    expect(out).toContain('<script>');
    expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('</body>'));
  });

  it('appends when the document has no body tag', () => {
    const out = injectHandoff('<h1>Fragment</h1>', { slug: 'my-app' });
    expect(out.startsWith('<h1>Fragment</h1>')).toBe(true);
    expect(out).toContain('opendesign://open?slug=my-app');
  });

  it('does not auto-redirect a first-time visitor', () => {
    // The script may only auto-attempt when a prior opt-in is remembered.
    const out = injectHandoff('<body></body>', { slug: 'my-app' });
    expect(out).toContain('if (remembered) attempt(false)');
  });

  it('escapes the slug into the script as JSON', () => {
    const out = injectHandoff('<body></body>', { slug: 'my-app' });
    expect(out).toContain('"my-app"');
  });
});

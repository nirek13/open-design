import { describe, expect, it } from 'vitest';
import { buildManifest } from '../src/manifest.ts';
import {
  cacheControlFor,
  etagFor,
  isFingerprinted,
  normalizeRequestPath,
  resolvePath,
  type ResolvedPath,
} from '../src/path-resolve.ts';

const hash = (n: number) => n.toString(16).padStart(64, '0');

const site = buildManifest([
  { path: 'index.html', hash: hash(1), size: 100 },
  { path: 'about.html', hash: hash(2), size: 50 },
  { path: 'guide/index.html', hash: hash(3), size: 60 },
  { path: 'assets/app.css', hash: hash(4), size: 40 },
  { path: 'assets/app.a1b2c3d4.js', hash: hash(5), size: 30 },
  { path: 'assets/logo.png', hash: hash(6), size: 20 },
]).manifest;

const opts = { entryFile: 'index.html' };

function resolved(path: string, extra: Partial<typeof opts> & { acceptsHtml?: boolean } = {}) {
  return resolvePath(site, path, { ...opts, ...extra });
}

describe('normalizeRequestPath', () => {
  it('treats root as the empty path', () => {
    expect(normalizeRequestPath('/')).toBe('');
    expect(normalizeRequestPath('')).toBe('');
  });

  it('drops query and fragment', () => {
    expect(normalizeRequestPath('/about.html?utm=1#top')).toBe('about.html');
  });

  it('decodes percent escapes', () => {
    expect(normalizeRequestPath('/my%20file.html')).toBe('my file.html');
  });

  it('rejects a malformed escape rather than guessing', () => {
    expect(normalizeRequestPath('/%E0%A4%A')).toBeNull();
  });

  it('rejects traversal, including the encoded form', () => {
    expect(normalizeRequestPath('/../../etc/passwd')).toBeNull();
    expect(normalizeRequestPath('/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });
});

describe('resolvePath', () => {
  it('serves the entry document at the root', () => {
    const result = resolved('/');
    expect(result.kind).toBe('exact');
    expect((result as ResolvedPath).path).toBe('index.html');
  });

  it('serves an exact match', () => {
    const result = resolved('/assets/app.css');
    expect(result.kind).toBe('exact');
    expect((result as ResolvedPath).entry.hash).toBe(hash(4));
  });

  it('serves a directory index and redirects to add the trailing slash', () => {
    const result = resolved('/guide') as ResolvedPath;
    expect(result.kind).toBe('directory-index');
    expect(result.path).toBe('guide/index.html');
    // Without the redirect, a relative asset in guide/index.html would resolve
    // against the site root instead of /guide/.
    expect(result.redirectTo).toBe('/guide/');
  });

  it('serves a directory index with no redirect when the slash is present', () => {
    const result = resolved('/guide/') as ResolvedPath;
    expect(result.kind).toBe('directory-index');
    expect(result.redirectTo).toBeUndefined();
  });

  it('resolves an extensionless path to its .html file', () => {
    const result = resolved('/about') as ResolvedPath;
    expect(result.kind).toBe('extensionless');
    expect(result.path).toBe('about.html');
  });

  it('falls back to the entry document for client-side routes', () => {
    const result = resolved('/dashboard/settings') as ResolvedPath;
    expect(result.kind).toBe('spa-fallback');
    expect(result.path).toBe('index.html');
  });

  it('404s a missing asset instead of returning the entry document', () => {
    // Serving HTML for a missing .png would turn a broken image into a cached
    // 200 and hide the failure from the publisher.
    expect(resolved('/assets/missing.png').kind).toBe('not-found');
  });

  it('404s a missing non-navigation path even when it has no extension', () => {
    expect(resolved('/api/data', { acceptsHtml: false }).kind).toBe('not-found');
  });

  it('404s an unmatched path when the SPA fallback is off', () => {
    expect(resolvePath(site, '/nope', { entryFile: 'index.html', spaFallback: false }).kind)
      .toBe('not-found');
  });

  it('404s traversal rather than resolving it', () => {
    expect(resolved('/../../etc/passwd').kind).toBe('not-found');
  });

  it('404s when the manifest has no entry document', () => {
    const empty = buildManifest([{ path: 'orphan.css', hash: hash(9), size: 1 }]).manifest;
    expect(resolvePath(empty, '/', { entryFile: 'index.html' }).kind).toBe('not-found');
  });
});

describe('cache policy', () => {
  it('revalidates HTML so a republish is visible immediately', () => {
    const result = resolved('/') as ResolvedPath;
    expect(cacheControlFor(result)).toBe('public, max-age=0, must-revalidate');
  });

  it('does NOT mark a plain asset immutable', () => {
    // /assets/app.css is a stable URL whose bytes change on republish. Marking
    // it immutable would pin a stale asset in visitors' caches for a year.
    const result = resolved('/assets/app.css') as ResolvedPath;
    expect(cacheControlFor(result)).not.toContain('immutable');
    expect(cacheControlFor(result)).toContain('stale-while-revalidate');
  });

  it('marks a fingerprinted asset immutable', () => {
    const result = resolved('/assets/app.a1b2c3d4.js') as ResolvedPath;
    expect(cacheControlFor(result)).toBe('public, max-age=31536000, immutable');
  });

  it('recognizes build fingerprints but not ordinary dotted names', () => {
    expect(isFingerprinted('app.a1b2c3d4.js')).toBe(true);
    expect(isFingerprinted('app-9f8e7d6c5b4a.css')).toBe(true);
    expect(isFingerprinted('jquery.min.js')).toBe(false);
    expect(isFingerprinted('logo.png')).toBe(false);
  });

  it('uses the content hash as a strong validator', () => {
    const result = resolved('/assets/logo.png') as ResolvedPath;
    expect(etagFor(result.entry)).toBe(`"${hash(6)}"`);
  });
});

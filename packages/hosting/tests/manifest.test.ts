import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  canonicalizeManifest,
  manifestBlobs,
  missingBlobs,
  normalizeManifestPath,
} from '../src/manifest.ts';
import { MAX_ASSET_BYTES } from '../src/limits.ts';

const hash = (n: number) => n.toString(16).padStart(64, '0');

describe('normalizeManifestPath', () => {
  it('strips leading slashes and dot segments', () => {
    expect(normalizeManifestPath('/./assets//app.css')).toBe('assets/app.css');
  });

  it('converts backslashes so Windows-authored paths match', () => {
    expect(normalizeManifestPath('assets\\img\\logo.png')).toBe('assets/img/logo.png');
  });

  it.each([
    '../secrets.env',
    'assets/../../etc/passwd',
    '/../escape',
  ])('rejects traversal in %j', (input) => {
    expect(normalizeManifestPath(input)).toBeNull();
  });

  it('rejects empty and whitespace-only input', () => {
    expect(normalizeManifestPath('')).toBeNull();
    expect(normalizeManifestPath('   ')).toBeNull();
    expect(normalizeManifestPath('/')).toBeNull();
  });

  it('rejects control characters that could truncate a downstream name', () => {
    expect(normalizeManifestPath('good\u0000evil.html')).toBeNull();
  });
});

describe('buildManifest', () => {
  it('derives content types from the extension', () => {
    const { manifest } = buildManifest([
      { path: 'index.html', hash: hash(1), size: 10 },
      { path: 'assets/app.css', hash: hash(2), size: 20 },
      { path: 'assets/logo.png', hash: hash(3), size: 30 },
    ]);
    expect(manifest['index.html']?.contentType).toBe('text/html; charset=utf-8');
    expect(manifest['assets/app.css']?.contentType).toBe('text/css; charset=utf-8');
    expect(manifest['assets/logo.png']?.contentType).toBe('image/png');
  });

  it('totals size and file count', () => {
    const result = buildManifest([
      { path: 'a.html', hash: hash(1), size: 100 },
      { path: 'b.html', hash: hash(2), size: 250 },
    ]);
    expect(result.fileCount).toBe(2);
    expect(result.totalBytes).toBe(350);
    expect(result.violations).toEqual([]);
  });

  it('reports an oversized asset and excludes it from the manifest', () => {
    const result = buildManifest([
      { path: 'ok.html', hash: hash(1), size: 10 },
      { path: 'huge.mp4', hash: hash(2), size: MAX_ASSET_BYTES + 1 },
    ]);
    expect(result.violations).toEqual([
      { kind: 'asset-too-large', path: 'huge.mp4', bytes: MAX_ASSET_BYTES + 1, limit: MAX_ASSET_BYTES },
    ]);
    expect(result.manifest['huge.mp4']).toBeUndefined();
    // The oversized file must not inflate the total it was excluded from.
    expect(result.totalBytes).toBe(10);
  });

  it('silently drops traversal paths instead of writing them', () => {
    const result = buildManifest([
      { path: 'index.html', hash: hash(1), size: 10 },
      { path: '../escape.html', hash: hash(2), size: 10 },
    ]);
    expect(Object.keys(result.manifest)).toEqual(['index.html']);
  });
});

describe('blob diffing', () => {
  it('collapses duplicate content to one blob', () => {
    const { manifest } = buildManifest([
      { path: 'a/logo.png', hash: hash(7), size: 500 },
      { path: 'b/logo.png', hash: hash(7), size: 500 },
    ]);
    expect(manifestBlobs(manifest).size).toBe(1);
  });

  it('returns only the blobs the server does not already have', () => {
    const { manifest } = buildManifest([
      { path: 'index.html', hash: hash(1), size: 10 },
      { path: 'app.css', hash: hash(2), size: 10 },
      { path: 'logo.png', hash: hash(3), size: 10 },
    ]);
    expect(missingBlobs(manifest, [hash(2)])).toEqual([hash(1), hash(3)].sort());
  });

  it('returns nothing to upload when a republish changed no bytes', () => {
    const { manifest } = buildManifest([{ path: 'index.html', hash: hash(1), size: 10 }]);
    expect(missingBlobs(manifest, [hash(1)])).toEqual([]);
  });
});

describe('canonicalizeManifest', () => {
  it('is independent of insertion order', () => {
    const a = buildManifest([
      { path: 'index.html', hash: hash(1), size: 10 },
      { path: 'app.css', hash: hash(2), size: 20 },
    ]).manifest;
    const b = buildManifest([
      { path: 'app.css', hash: hash(2), size: 20 },
      { path: 'index.html', hash: hash(1), size: 10 },
    ]).manifest;
    expect(canonicalizeManifest(a)).toBe(canonicalizeManifest(b));
  });

  it('changes when any field changes', () => {
    const base = buildManifest([{ path: 'index.html', hash: hash(1), size: 10 }]).manifest;
    const changed = buildManifest([{ path: 'index.html', hash: hash(2), size: 10 }]).manifest;
    expect(canonicalizeManifest(base)).not.toBe(canonicalizeManifest(changed));
  });

  it('cannot be confused by a content type containing the separator', () => {
    // Content types contain spaces ("text/html; charset=utf-8"), so a
    // space-separated encoding would let two different manifests collide.
    const a = buildManifest([{ path: 'a', hash: hash(1), size: 1, contentType: 'x/y z' }]).manifest;
    const b = buildManifest([{ path: 'a', hash: hash(1), size: 1, contentType: 'x/y' }]).manifest;
    expect(canonicalizeManifest(a)).not.toBe(canonicalizeManifest(b));
  });
});

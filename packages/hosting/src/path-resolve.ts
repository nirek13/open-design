// Turning an incoming request path into a manifest entry.
//
// This module is the reason `@open-design/hosting` exists as a package rather
// than living inside the daemon: the edge runtime imports this exact source, so
// a local preview and the deployed site can never disagree about what `/about`
// means. A resolver that drifts between the two is a bug that only ever
// reproduces in production.

import { isHtmlPath } from './content-type.ts';
import { normalizeManifestPath, type ManifestEntry, type SiteManifest } from './manifest.ts';

export type ResolutionKind =
  | 'exact'
  | 'directory-index'
  | 'extensionless'
  | 'spa-fallback'
  | 'not-found';

export interface ResolvedPath {
  kind: Exclude<ResolutionKind, 'not-found'>;
  /** Manifest key that answered the request. */
  path: string;
  entry: ManifestEntry;
  /**
   * True when the request path differs from the canonical one in a way that
   * should be corrected with a redirect rather than served silently — a
   * directory URL missing its trailing slash, where relative links inside the
   * document would otherwise resolve against the wrong base.
   */
  redirectTo?: string;
}

export type PathResolution = ResolvedPath | { kind: 'not-found' };

export interface ResolveOptions {
  /** Entry document of the site, e.g. `index.html`. */
  entryFile: string;
  /**
   * Serve the entry document for unmatched paths that look like navigation.
   * Correct for client-side-routed apps, wrong for a plain multi-page site
   * where a typo should 404. Defaults to true because generated single-page
   * apps are the common case here.
   */
  spaFallback?: boolean;
  /**
   * Whether the request accepts HTML. Only navigation requests get the SPA
   * fallback; a missing `.png` must 404 rather than return a page, or broken
   * images turn into silent 200s and the browser caches nonsense.
   */
  acceptsHtml?: boolean;
}

/**
 * Decode and normalize a raw request path. Returns null when the path is
 * malformed or tries to escape the site root.
 */
export function normalizeRequestPath(rawPath: string): string | null {
  let working = rawPath;
  const queryAt = working.search(/[?#]/);
  if (queryAt !== -1) working = working.slice(0, queryAt);

  let decoded: string;
  try {
    decoded = decodeURIComponent(working);
  } catch {
    // A malformed percent-escape is a bad request, never a path to guess at.
    return null;
  }
  if (decoded === '' || decoded === '/') return '';
  const normalized = normalizeManifestPath(decoded);
  return normalized ?? null;
}

export function resolvePath(
  manifest: SiteManifest,
  rawPath: string,
  options: ResolveOptions,
): PathResolution {
  const entryFile = normalizeManifestPath(options.entryFile) ?? 'index.html';
  const spaFallback = options.spaFallback ?? true;
  const acceptsHtml = options.acceptsHtml ?? true;

  const normalized = normalizeRequestPath(rawPath);
  if (normalized === null) return { kind: 'not-found' };

  // Root always means the entry document.
  if (normalized === '') {
    const entry = manifest[entryFile];
    return entry ? { kind: 'exact', path: entryFile, entry } : { kind: 'not-found' };
  }

  const exact = manifest[normalized];
  if (exact) return { kind: 'exact', path: normalized, entry: exact };

  const hadTrailingSlash = /\/$/.test(rawPath.split(/[?#]/)[0] ?? '');

  // `/docs` and `/docs/` both mean `/docs/index.html`.
  const indexKey = `${normalized}/index.html`;
  const indexEntry = manifest[indexKey];
  if (indexEntry) {
    const resolved: ResolvedPath = { kind: 'directory-index', path: indexKey, entry: indexEntry };
    // Without the trailing slash, a relative `<img src="logo.png">` inside
    // /docs/index.html would resolve to /logo.png instead of /docs/logo.png.
    if (!hadTrailingSlash) resolved.redirectTo = `/${normalized}/`;
    return resolved;
  }

  // `/about` may mean `/about.html` — but only for a path that does not already
  // carry an extension, so `/logo.png` never silently becomes `/logo.png.html`.
  if (!hasExtension(normalized)) {
    const htmlKey = `${normalized}.html`;
    const htmlEntry = manifest[htmlKey];
    if (htmlEntry) return { kind: 'extensionless', path: htmlKey, entry: htmlEntry };
  }

  if (spaFallback && acceptsHtml && !hasExtension(normalized)) {
    const entry = manifest[entryFile];
    if (entry) return { kind: 'spa-fallback', path: entryFile, entry };
  }

  return { kind: 'not-found' };
}

function hasExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1;
}

/**
 * Content addressing lives in the *storage key*, not in the URL. `/assets/app.css`
 * is a stable URL whose bytes change on every republish, so caching it
 * `immutable` would pin a stale asset for a year — the site would update for
 * new visitors and stay broken for everyone who had already loaded it.
 *
 * So `immutable` is granted only to paths that carry their own fingerprint in
 * the filename (`app.a1b2c3d4.css`), where a content change necessarily changes
 * the URL. Everything else revalidates, which is cheap because every response
 * carries the blob hash as its ETag.
 */
export function cacheControlFor(resolution: ResolvedPath): string {
  if (isHtmlPath(resolution.path)) return 'public, max-age=0, must-revalidate';
  if (isFingerprinted(resolution.path)) return 'public, max-age=31536000, immutable';
  // Short freshness plus background revalidation: a CDN can still absorb bursts
  // without serving a republished asset from a year-old cache.
  return 'public, max-age=60, stale-while-revalidate=86400';
}

/** `app.a1b2c3d4.css` / `app-a1b2c3d4.css` — a build-tool content fingerprint. */
export function isFingerprinted(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i.test(base);
}

/** Strong validator for a blob: the content hash itself. */
export function etagFor(entry: ManifestEntry): string {
  return `"${entry.hash}"`;
}

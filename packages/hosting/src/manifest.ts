// A manifest is the complete description of one immutable version of a site:
// every servable path mapped to the content hash that answers it.
//
// Storing the mapping (rather than laying files out under a per-version prefix)
// is what makes re-publishing cheap: two versions that share a 4 MB image both
// point at the same blob, and the image uploads once, ever.

import { contentTypeFor } from './content-type.ts';
import {
  MAX_ASSET_BYTES,
  MAX_FILES_PER_SITE,
  MAX_TOTAL_BYTES,
  type LimitViolation,
} from './limits.ts';

export interface ManifestEntry {
  /** Content hash of the bytes; also the Storage object name. */
  hash: string;
  size: number;
  contentType: string;
}

/** Servable path (no leading slash) → entry. */
export type SiteManifest = Readonly<Record<string, ManifestEntry>>;

export interface ManifestInput {
  /** Path relative to the site root, e.g. `assets/app.css`. */
  path: string;
  hash: string;
  size: number;
  /** Override the extension-derived type. Rarely needed. */
  contentType?: string;
}

export interface BuildManifestResult {
  manifest: SiteManifest;
  fileCount: number;
  totalBytes: number;
  violations: LimitViolation[];
}

/**
 * Normalize a path into the form used as a manifest key: no leading slash, no
 * `./`, forward slashes only, no traversal.
 *
 * Returns null for anything that escapes the site root. Callers must treat null
 * as a hard rejection rather than a fallback — this function is the only thing
 * standing between a crafted path and a write outside the site prefix.
 */
export function normalizeManifestPath(input: string): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const unified = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const out: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    // A NUL or control character in a path is never legitimate and can
    // truncate the name in a downstream consumer.
    if (/[\u0000-\u001f\u007f]/.test(segment)) return null;
    out.push(segment);
  }
  if (out.length === 0) return null;
  return out.join('/');
}

export function buildManifest(inputs: readonly ManifestInput[]): BuildManifestResult {
  const manifest: Record<string, ManifestEntry> = {};
  const violations: LimitViolation[] = [];
  let totalBytes = 0;

  for (const input of inputs) {
    const path = normalizeManifestPath(input.path);
    if (!path) continue;
    if (input.size > MAX_ASSET_BYTES) {
      violations.push({ kind: 'asset-too-large', path, bytes: input.size, limit: MAX_ASSET_BYTES });
      continue;
    }
    manifest[path] = {
      hash: input.hash,
      size: input.size,
      contentType: input.contentType ?? contentTypeFor(path),
    };
    totalBytes += input.size;
  }

  const fileCount = Object.keys(manifest).length;
  if (fileCount > MAX_FILES_PER_SITE) {
    violations.push({ kind: 'too-many-files', count: fileCount, limit: MAX_FILES_PER_SITE });
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    violations.push({ kind: 'total-too-large', bytes: totalBytes, limit: MAX_TOTAL_BYTES });
  }

  return { manifest, fileCount, totalBytes, violations };
}

/**
 * The distinct blobs a manifest references. Two paths with identical content
 * (a duplicated logo, say) collapse to one upload.
 */
export function manifestBlobs(manifest: SiteManifest): Map<string, number> {
  const blobs = new Map<string, number>();
  for (const entry of Object.values(manifest)) blobs.set(entry.hash, entry.size);
  return blobs;
}

/**
 * Which blobs still need uploading, given what the server already stores.
 * This is the incremental-publish diff.
 */
export function missingBlobs(manifest: SiteManifest, known: Iterable<string>): string[] {
  const have = known instanceof Set ? known : new Set(known);
  const missing: string[] = [];
  for (const hash of manifestBlobs(manifest).keys()) {
    if (!have.has(hash)) missing.push(hash);
  }
  return missing.sort();
}

/**
 * Stable serialization for hashing a manifest. Key order must not depend on
 * insertion order, or the same content would produce different version hashes
 * on different machines.
 */
export function canonicalizeManifest(manifest: SiteManifest): string {
  const keys = Object.keys(manifest).sort();
  const parts = keys.map((key) => {
    const entry = manifest[key]!;
    // Tab-separated: `normalizeManifestPath` rejects control characters, so a
    // key can never contain a tab, while content types routinely contain
    // spaces ("text/html; charset=utf-8"). A space separator would be
    // ambiguous; a tab cannot be.
    return `${key}\t${entry.hash}\t${entry.size}\t${entry.contentType}`;
  });
  return parts.join('\n');
}

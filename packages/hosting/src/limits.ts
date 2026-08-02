// Publish limits.
//
// The per-asset and per-batch numbers deliberately match the Cloudflare Pages
// constants already tuned in `apps/daemon/src/deploy.ts`. Keeping one set of
// numbers across both deploy paths means a project that publishes cleanly to
// one target does not mysteriously fail on the other.

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_SITE = 100;
export const MAX_TOTAL_BYTES = 75 * 1024 * 1024;

/** Signed upload URLs are single-use in practice and short-lived by design:
 * long enough for a slow connection to finish one blob, short enough that a
 * leaked URL is worthless by the time it is found. */
export const UPLOAD_URL_TTL_SECONDS = 300;

/** Per-user publish ceiling, enforced in the edge runtime. */
export const MAX_PUBLISHES_PER_HOUR = 60;

export type LimitViolation =
  | { kind: 'asset-too-large'; path: string; bytes: number; limit: number }
  | { kind: 'too-many-files'; count: number; limit: number }
  | { kind: 'total-too-large'; bytes: number; limit: number };

export function describeLimitViolation(violation: LimitViolation): string {
  switch (violation.kind) {
    case 'asset-too-large':
      return `${violation.path} is ${formatBytes(violation.bytes)}, over the ${formatBytes(violation.limit)} per-file limit.`;
    case 'too-many-files':
      return `This site has ${violation.count} files, over the ${violation.limit} file limit.`;
    case 'total-too-large':
      return `This site is ${formatBytes(violation.bytes)}, over the ${formatBytes(violation.limit)} total limit.`;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

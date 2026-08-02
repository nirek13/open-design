// Pure core for Open Design one-click hosting.
//
// Every export here is dependency-free and runtime-neutral so the same source
// runs in three places: the daemon (Node, via the bundled `dist/`), the
// Supabase edge functions (Deno, importing `src/*.ts` directly), and the web UI
// (bundler). Nothing in this package may import `node:*`, touch the
// filesystem, or reach the network — that is what keeps daemon-side and
// edge-side behavior identical instead of merely similar.

export {
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  normalizeSlug,
  suggestSlug,
  validateSlug,
  type SlugRejection,
  type SlugValidation,
} from './slug.ts';

export {
  DEFAULT_CONTENT_TYPE,
  contentTypeFor,
  extensionOf,
  isHtmlPath,
} from './content-type.ts';

export {
  MAX_ASSET_BYTES,
  MAX_FILES_PER_SITE,
  MAX_PUBLISHES_PER_HOUR,
  MAX_TOTAL_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  describeLimitViolation,
  formatBytes,
  type LimitViolation,
} from './limits.ts';

export {
  buildManifest,
  canonicalizeManifest,
  manifestBlobs,
  missingBlobs,
  normalizeManifestPath,
  type BuildManifestResult,
  type ManifestEntry,
  type ManifestInput,
  type SiteManifest,
} from './manifest.ts';

export {
  cacheControlFor,
  etagFor,
  isFingerprinted,
  normalizeRequestPath,
  resolvePath,
  type PathResolution,
  type ResolutionKind,
  type ResolveOptions,
  type ResolvedPath,
} from './path-resolve.ts';

export {
  DEEP_LINK_SCHEME,
  HANDOFF_TIMEOUT_MS,
  buildDeepLink,
  handoffScript,
  injectHandoff,
  parseDeepLink,
  type DeepLinkTarget,
} from './app-handoff.ts';

export {
  siteContentSecurityPolicy,
  siteSecurityHeaders,
  type SecurityHeaderOptions,
} from './csp.ts';

export { storageKeyFor, SITE_BLOB_PREFIX } from './storage-keys.ts';

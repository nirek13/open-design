// Slugs become DNS labels: `https://<slug>.<sites-domain>`.
//
// That is the whole reason the rules below are stricter than a typical
// URL slug — a value that is legal in a path can be illegal in a hostname,
// and discovering that at request time rather than publish time would mean
// handing someone a link that never resolves.

/** DNS labels cap at 63 characters. */
export const SLUG_MAX_LENGTH = 63;
/** Short slugs are the scarce, guessable ones; keep a floor. */
export const SLUG_MIN_LENGTH = 3;

/**
 * Names that must never become a site, because they either collide with
 * infrastructure hostnames or let a published page impersonate the product.
 *
 * `www`/`mail`/`api` are the infrastructure half. `login`/`account`/`billing`
 * are the impersonation half: a phishing page at `login.<sites-domain>` is far
 * more convincing than the same page at a random slug.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'app', 'apps',
  'assets', 'auth', 'billing', 'blog', 'cdn', 'checkout', 'console', 'dashboard',
  'dev', 'docs', 'download', 'downloads', 'email', 'ftp', 'help', 'host',
  'hosting', 'imap', 'internal', 'login', 'logout', 'mail', 'media', 'mx',
  'ns', 'ns1', 'ns2', 'opendesign', 'open-design', 'pay', 'payment', 'payments',
  'pop', 'preview', 'private', 'prod', 'production', 'public', 'register',
  'root', 'security', 'signin', 'signup', 'smtp', 'ssl', 'staging', 'static',
  'status', 'store', 'support', 'system', 'test', 'testing', 'tools', 'upload',
  'uploads', 'user', 'users', 'vpn', 'web', 'webmail', 'www', 'www1', 'www2',
]);

export type SlugRejection =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'invalid-characters'
  | 'leading-or-trailing-hyphen'
  | 'consecutive-hyphens'
  | 'all-numeric'
  | 'reserved'
  | 'punycode-prefix';

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; reason: SlugRejection; message: string };

const REJECTION_MESSAGES: Record<SlugRejection, string> = {
  'empty': 'Enter a name for this site.',
  'too-short': `Use at least ${SLUG_MIN_LENGTH} characters.`,
  'too-long': `Use at most ${SLUG_MAX_LENGTH} characters.`,
  'invalid-characters': 'Use only lowercase letters, numbers, and hyphens.',
  'leading-or-trailing-hyphen': 'Cannot start or end with a hyphen.',
  'consecutive-hyphens': 'Cannot contain two hyphens in a row.',
  'all-numeric': 'Use at least one letter.',
  'reserved': 'That name is reserved.',
  'punycode-prefix': 'Cannot start with "xn--".',
};

/**
 * Best-effort cleanup of arbitrary human text into slug shape. This does NOT
 * guarantee a valid slug — it is the "suggest as you type" transform, and its
 * output still has to pass {@link validateSlug}.
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKD')
    // Drop combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    // Slicing can strip a trailing character and expose a hyphen.
    .replace(/-+$/, '');
}

export function validateSlug(input: string): SlugValidation {
  const slug = input.trim();
  if (!slug) return reject('empty');
  if (!/^[a-z0-9-]+$/.test(slug)) return reject('invalid-characters');
  if (slug.length < SLUG_MIN_LENGTH) return reject('too-short');
  if (slug.length > SLUG_MAX_LENGTH) return reject('too-long');
  if (slug.startsWith('-') || slug.endsWith('-')) return reject('leading-or-trailing-hyphen');
  if (slug.includes('--')) {
    // `xn--` is the IDNA prefix; a label starting with it is interpreted as an
    // internationalized name and can render as characters we never approved.
    if (slug.startsWith('xn--')) return reject('punycode-prefix');
    return reject('consecutive-hyphens');
  }
  if (/^[0-9]+$/.test(slug)) return reject('all-numeric');
  if (RESERVED_SLUGS.has(slug)) return reject('reserved');
  return { ok: true, slug };
}

function reject(reason: SlugRejection): SlugValidation {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason] };
}

/**
 * Build a first-publish suggestion from a project name, appending a short
 * disambiguator so two people publishing "Dashboard" do not race for one slug.
 *
 * `suffix` is supplied by the caller (not generated here) to keep this module
 * free of randomness, which is what makes it testable and safe to run in both
 * the daemon and the edge runtime.
 */
export function suggestSlug(projectName: string, suffix: string): string {
  const normalizedSuffix = normalizeSlug(suffix);
  const base = normalizeSlug(projectName) || 'site';
  const room = SLUG_MAX_LENGTH - normalizedSuffix.length - 1;
  const trimmed = base.slice(0, Math.max(1, room)).replace(/-+$/, '');
  const candidate = normalizedSuffix ? `${trimmed}-${normalizedSuffix}` : trimmed;
  // A reserved base is still reserved once suffixed only if the suffix is
  // empty; otherwise the compound name is fine and stays recognizable.
  return validateSlug(candidate).ok ? candidate : `site-${normalizedSuffix || 'new'}`;
}

// Clerk session-token verification for the edge runtime.
//
// This is the single point where a hosting request's identity is established.
// The daemon does not verify tokens for hosting — it forwards the caller's
// Clerk token untouched — so there is exactly one verifier on this path rather
// than two that could drift.
//
// It is deliberately a Web Crypto implementation rather than a port of
// `apps/daemon/src/auth/jwt-verify.ts` (which is built on `node:crypto` and
// cannot run in Deno). The *rules* below are kept identical to that file, and
// they are all deny-by-default:
//
//   - the algorithm is pinned to RS256 and read from the header ONLY to reject
//     anything else. `none` and every HMAC variant are refused, which is what
//     defeats the algorithm-confusion attack where a token signed with the
//     public key as an HMAC secret is presented as valid.
//   - the signing key is chosen by `kid`. A token whose `kid` is absent from
//     the JWKS is refused; there is no "try every key" fallback.
//   - `iss` must equal the configured issuer exactly.
//   - `exp` is required.
//
// Anything unexpected is a rejection, never a pass.

export interface ClerkClaims {
  sub: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  /** Clerk's active-organization claim: { id, rol, slg }. */
  o?: { id?: string; rol?: string; slg?: string };
  [claim: string]: unknown;
}

export type VerifyFailure =
  | 'malformed'
  | 'unsupported-algorithm'
  | 'unknown-key'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-issuer'
  | 'missing-subject'
  | 'jwks-unavailable';

export type VerifyResult =
  | { ok: true; claims: ClerkClaims }
  | { ok: false; reason: VerifyFailure };

const CLOCK_SKEW_MS = 60_000;
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
/** Never re-fetch more often than this, so a burst of tokens carrying an
 * unknown `kid` cannot become a request flood against Clerk. */
const JWKS_MIN_REFETCH_MS = 30_000;

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const cache = new Map<string, CachedKeys>();
const inFlight = new Map<string, Promise<CachedKeys | null>>();

function base64UrlToBytes(value: string): Uint8Array | null {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  try {
    const binary = atob(withPad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadJwks(issuer: string, force: boolean): Promise<CachedKeys | null> {
  const existing = cache.get(issuer);
  const now = Date.now();
  if (existing && !force && now - existing.fetchedAt < JWKS_CACHE_TTL_MS) return existing;
  if (existing && force && now - existing.fetchedAt < JWKS_MIN_REFETCH_MS) return existing;

  // Collapse concurrent misses onto one network call.
  const pending = inFlight.get(issuer);
  if (pending) return pending;

  const task = (async (): Promise<CachedKeys | null> => {
    try {
      const response = await fetch(`${issuer}/.well-known/jwks.json`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return existing ?? null;
      const body = await response.json() as { keys?: unknown };
      if (!Array.isArray(body.keys)) return existing ?? null;

      const keys = new Map<string, CryptoKey>();
      for (const raw of body.keys) {
        const jwk = raw as Record<string, unknown>;
        if (jwk.kty !== 'RSA') continue;
        // A JWKS entry that declares an algorithm must declare RS256; one that
        // declares a signing use must say "sig".
        if (typeof jwk.alg === 'string' && jwk.alg !== 'RS256') continue;
        if (typeof jwk.use === 'string' && jwk.use !== 'sig') continue;
        const kid = typeof jwk.kid === 'string' ? jwk.kid : null;
        if (!kid) continue;
        try {
          const key = await crypto.subtle.importKey(
            'jwk',
            { kty: 'RSA', n: jwk.n as string, e: jwk.e as string, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
          );
          keys.set(kid, key);
        } catch {
          // A single unusable key must not poison the whole set.
          continue;
        }
      }
      if (keys.size === 0) return existing ?? null;
      const fresh: CachedKeys = { keys, fetchedAt: Date.now() };
      cache.set(issuer, fresh);
      return fresh;
    } catch {
      return existing ?? null;
    } finally {
      inFlight.delete(issuer);
    }
  })();

  inFlight.set(issuer, task);
  return task;
}

export async function verifyClerkToken(token: string, issuer: string): Promise<VerifyResult> {
  const normalizedIssuer = issuer.replace(/\/+$/, '');
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeJsonSegment(headerSegment);
  if (!header) return { ok: false, reason: 'malformed' };
  // Read `alg` only to reject it. Never to select an algorithm.
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported-algorithm' };
  const kid = typeof header.kid === 'string' ? header.kid : null;
  if (!kid) return { ok: false, reason: 'unknown-key' };

  const payload = decodeJsonSegment(payloadSegment);
  if (!payload) return { ok: false, reason: 'malformed' };

  const signature = base64UrlToBytes(signatureSegment);
  if (!signature) return { ok: false, reason: 'malformed' };

  let jwks = await loadJwks(normalizedIssuer, false);
  let key = jwks?.keys.get(kid);
  if (!key) {
    // An unknown kid is the expected shape of a legitimate key rotation, so
    // one forced refresh is warranted before rejecting.
    jwks = await loadJwks(normalizedIssuer, true);
    key = jwks?.keys.get(kid);
  }
  if (!jwks) return { ok: false, reason: 'jwks-unavailable' };
  if (!key) return { ok: false, reason: 'unknown-key' };

  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as BufferSource,
    signed as BufferSource,
  );
  if (!valid) return { ok: false, reason: 'bad-signature' };

  // Claim checks run only after the signature is proven, so an attacker cannot
  // learn anything from the ordering of rejections.
  if (typeof payload.iss !== 'string' || payload.iss.replace(/\/+$/, '') !== normalizedIssuer) {
    return { ok: false, reason: 'wrong-issuer' };
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    return { ok: false, reason: 'missing-subject' };
  }
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'expired' };
  const now = Date.now();
  if (payload.exp * 1000 + CLOCK_SKEW_MS < now) return { ok: false, reason: 'expired' };
  if (typeof payload.nbf === 'number' && payload.nbf * 1000 - CLOCK_SKEW_MS > now) {
    return { ok: false, reason: 'not-yet-valid' };
  }

  return { ok: true, claims: payload as unknown as ClerkClaims };
}

export function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export interface Caller {
  userId: string;
  orgId: string | null;
  orgRole: string | null;
}

export function callerFrom(claims: ClerkClaims): Caller {
  const org = claims.o;
  return {
    userId: claims.sub,
    orgId: typeof org?.id === 'string' && org.id ? org.id : null,
    orgRole: typeof org?.rol === 'string' && org.rol ? org.rol : null,
  };
}

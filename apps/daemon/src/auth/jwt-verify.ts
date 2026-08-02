// Minimal, strict RS256 JWT verification against a remote JWKS.
//
// Implemented on Node's built-in crypto rather than pulling an auth SDK: the
// repository keeps its dependency list deliberately small, and this is the
// whole surface we need — verify that a session token was signed by the
// configured issuer and has not expired.
//
// Because hand-written token validation is where auth bugs live, every check
// here is deny-by-default:
//   - the algorithm is pinned to RS256 and read from the header ONLY to
//     reject anything else. "none" and any HMAC variant are refused outright,
//     which is what stops the classic algorithm-confusion attack where a
//     token signed with the public key as an HMAC secret is accepted.
//   - the signing key is selected by `kid` from the issuer's JWKS. A token
//     whose `kid` is absent from the JWKS is refused; we never fall back to
//     "try every key".
//   - `iss` must equal the configured issuer exactly.
//   - `exp` is required. `nbf`/`iat` are honored when present.
//
// Anything unexpected is a rejection, never a pass.

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

export interface JwtClaims {
  sub: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  [claim: string]: unknown;
}

export type JwtVerifyFailure =
  | 'malformed'
  | 'unsupported-algorithm'
  | 'unknown-key'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-issuer'
  | 'missing-subject'
  | 'jwks-unavailable';

export type JwtVerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: JwtVerifyFailure };

/** Tolerance for clock drift between this machine and the issuer. */
const CLOCK_SKEW_MS = 60_000;

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
/** Never re-fetch more often than this, so a burst of tokens carrying an
 * unknown `kid` cannot turn into a request flood against the issuer. */
const JWKS_MIN_REFETCH_MS = 30_000;

interface JsonWebKey {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

export class JwksKeyStore {
  readonly #jwksUrl: string;
  readonly #fetchImpl: typeof fetch;
  #keys = new Map<string, KeyObject>();
  #fetchedAtMs = 0;
  #inFlight: Promise<void> | null = null;

  constructor(jwksUrl: string, fetchImpl: typeof fetch = fetch) {
    this.#jwksUrl = jwksUrl;
    this.#fetchImpl = fetchImpl;
  }

  async keyFor(kid: string): Promise<KeyObject | null> {
    const cached = this.#keys.get(kid);
    const fresh = Date.now() - this.#fetchedAtMs < JWKS_CACHE_TTL_MS;
    if (cached && fresh) return cached;
    // An unknown kid usually means the issuer rotated keys, so refresh — but
    // only if we have not just tried.
    if (!cached || !fresh) {
      if (Date.now() - this.#fetchedAtMs >= JWKS_MIN_REFETCH_MS) await this.#refresh();
    }
    return this.#keys.get(kid) ?? null;
  }

  async #refresh(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = (async () => {
      try {
        const response = await this.#fetchImpl(this.#jwksUrl, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return;
        const body = (await response.json()) as { keys?: JsonWebKey[] };
        if (!Array.isArray(body?.keys)) return;
        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys) {
          // Only RSA signing keys are usable for RS256; skip everything else
          // rather than importing keys we would then have to refuse.
          if (!jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
          if (jwk.alg && jwk.alg !== 'RS256') continue;
          if (jwk.use && jwk.use !== 'sig') continue;
          try {
            next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
          } catch {
            // A malformed key in the set must not poison the rest.
          }
        }
        if (next.size > 0) {
          this.#keys = next;
          this.#fetchedAtMs = Date.now();
        }
      } catch {
        // Leave the previous key set in place; a transient network failure
        // should not sign every user out.
      } finally {
        this.#inFlight = null;
      }
    })();
    return this.#inFlight;
  }
}

export async function verifyJwt(
  token: string,
  options: { keyStore: JwksKeyStore; issuer: string; nowMs?: number },
): Promise<JwtVerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let claims: JwtClaims;
  try {
    header = decodeSegment(headerSegment) as { alg?: unknown; kid?: unknown };
    claims = decodeSegment(payloadSegment) as JwtClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') {
    return { ok: false, reason: 'malformed' };
  }

  // Pinned algorithm. Reading `alg` from the token is only ever a reason to
  // reject it — never a reason to pick a different verification strategy.
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported-algorithm' };
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'unknown-key' };

  const key = await options.keyStore.keyFor(header.kid);
  if (!key) return { ok: false, reason: 'jwks-unavailable' };

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerSegment}.${payloadSegment}`);
  verifier.end();
  let signatureValid = false;
  try {
    signatureValid = verifier.verify(key, Buffer.from(signatureSegment, 'base64url'));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: 'bad-signature' };

  const now = options.nowMs ?? Date.now();
  if (typeof claims.exp !== 'number') return { ok: false, reason: 'expired' };
  if (claims.exp * 1000 + CLOCK_SKEW_MS <= now) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 - CLOCK_SKEW_MS > now) {
    return { ok: false, reason: 'not-yet-valid' };
  }
  if (typeof claims.iss !== 'string' || claims.iss !== options.issuer) {
    return { ok: false, reason: 'wrong-issuer' };
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false, reason: 'missing-subject' };

  return { ok: true, claims };
}

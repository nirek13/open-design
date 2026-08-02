// Token verification is where auth bugs hide, so these exercise the refusals
// rather than the happy path alone. Every case here is an attack shape that a
// permissive verifier would wave through.

import { describe, expect, it } from 'vitest';
import { createPublicKey, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { JwksKeyStore, verifyJwt } from '../src/auth/jwt-verify.js';

const ISSUER = 'https://example.clerk.accounts.dev';

function b64url(value: object | Buffer): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
  return buffer.toString('base64url');
}

function signRs256(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${b64url(signer.sign(privateKey))}`;
}

function keyStoreFor(publicKey: KeyObject, kid: string): JwksKeyStore {
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return new JwksKeyStore(`${ISSUER}/.well-known/jwks.json`, fetchImpl);
}

describe('verifyJwt', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const keyStore = keyStoreFor(publicKey, kid);
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

  it('accepts a well-formed token from the configured issuer', async () => {
    const token = signRs256(header, { sub: 'user_123', iss: ISSUER, exp: futureExp() }, privateKey);
    const result = await verifyJwt(token, { keyStore, issuer: ISSUER });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.claims.sub).toBe('user_123');
  });

  it('refuses the alg=none downgrade', async () => {
    const unsigned = `${b64url({ alg: 'none', typ: 'JWT', kid })}.${b64url({
      sub: 'user_123',
      iss: ISSUER,
      exp: futureExp(),
    })}.`;
    const result = await verifyJwt(unsigned, { keyStore, issuer: ISSUER });
    expect(result).toEqual({ ok: false, reason: 'unsupported-algorithm' });
  });

  it('refuses an HMAC token signed with the public key as the secret', async () => {
    // The classic algorithm-confusion attack: swap RS256 for HS256 and sign
    // with the (public) verification key. Pinning the algorithm stops it
    // before any key material is chosen.
    const { createHmac } = await import('node:crypto');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const signingInput = `${b64url({ alg: 'HS256', typ: 'JWT', kid })}.${b64url({
      sub: 'attacker',
      iss: ISSUER,
      exp: futureExp(),
    })}`;
    const forged = `${signingInput}.${createHmac('sha256', publicPem).update(signingInput).digest('base64url')}`;
    const result = await verifyJwt(forged, { keyStore, issuer: ISSUER });
    expect(result).toEqual({ ok: false, reason: 'unsupported-algorithm' });
  });

  it('refuses a token signed by a different key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signRs256(header, { sub: 'user_123', iss: ISSUER, exp: futureExp() }, other.privateKey);
    const result = await verifyJwt(token, { keyStore, issuer: ISSUER });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a token whose kid is not in the key set', async () => {
    const token = signRs256({ alg: 'RS256', typ: 'JWT', kid: 'unknown-kid' }, { sub: 'u', iss: ISSUER, exp: futureExp() }, privateKey);
    const result = await verifyJwt(token, { keyStore, issuer: ISSUER });
    expect(result).toEqual({ ok: false, reason: 'jwks-unavailable' });
  });

  it('refuses an expired token and one that is not yet valid', async () => {
    const expired = signRs256(header, { sub: 'u', iss: ISSUER, exp: Math.floor(Date.now() / 1000) - 3600 }, privateKey);
    expect(await verifyJwt(expired, { keyStore, issuer: ISSUER })).toEqual({
      ok: false,
      reason: 'expired',
    });

    const early = signRs256(
      header,
      { sub: 'u', iss: ISSUER, exp: futureExp(), nbf: Math.floor(Date.now() / 1000) + 3600 },
      privateKey,
    );
    expect(await verifyJwt(early, { keyStore, issuer: ISSUER })).toEqual({
      ok: false,
      reason: 'not-yet-valid',
    });
  });

  it('refuses a token with no expiry at all', async () => {
    const token = signRs256(header, { sub: 'u', iss: ISSUER }, privateKey);
    expect(await verifyJwt(token, { keyStore, issuer: ISSUER })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a valid signature from the wrong issuer', async () => {
    const token = signRs256(header, { sub: 'u', iss: 'https://evil.example', exp: futureExp() }, privateKey);
    expect(await verifyJwt(token, { keyStore, issuer: ISSUER })).toEqual({
      ok: false,
      reason: 'wrong-issuer',
    });
  });

  it('refuses a token with no subject to attribute it to', async () => {
    const token = signRs256(header, { iss: ISSUER, exp: futureExp() }, privateKey);
    expect(await verifyJwt(token, { keyStore, issuer: ISSUER })).toEqual({
      ok: false,
      reason: 'missing-subject',
    });
  });

  it('refuses malformed input rather than throwing', async () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', '%%%.%%%.%%%']) {
      const result = await verifyJwt(bad, { keyStore, issuer: ISSUER });
      expect(result.ok).toBe(false);
    }
  });

  it('keeps working when the JWKS endpoint is unreachable', async () => {
    const failing = new JwksKeyStore(
      `${ISSUER}/.well-known/jwks.json`,
      (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    );
    const token = signRs256(header, { sub: 'u', iss: ISSUER, exp: futureExp() }, privateKey);
    const result = await verifyJwt(token, { keyStore: failing, issuer: ISSUER });
    // No key means no verification — refuse, never fall through to accept.
    expect(result).toEqual({ ok: false, reason: 'jwks-unavailable' });
  });

  it('ignores non-RSA and non-signing keys in the key set', async () => {
    const store = new JwksKeyStore(
      `${ISSUER}/.well-known/jwks.json`,
      (async () =>
        new Response(
          JSON.stringify({
            keys: [
              { kid, kty: 'oct', k: 'secret' },
              { kid: 'enc', kty: 'RSA', use: 'enc', n: 'x', e: 'AQAB' },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    expect(await store.keyFor(kid)).toBeNull();
  });
});

describe('createPublicKey jwk import', () => {
  it('round-trips an RSA public key through JWK, which the key store relies on', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    expect(() => createPublicKey({ key: jwk as never, format: 'jwk' })).not.toThrow();
  });
});

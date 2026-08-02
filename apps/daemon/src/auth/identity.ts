// Who is making this request?
//
// The daemon has two identity modes:
//
//   local-owner (default) — no auth configured. Every interactive request is
//     the machine's owner. This keeps the local dev loop and the packaged
//     single-user app working with zero setup, and it is the mode every
//     existing test runs in.
//
//   clerk — OD_CLERK_ISSUER (and optionally OD_CLERK_PUBLISHABLE_KEY) is set.
//     Requests carry a session JWT which is verified against the issuer's
//     JWKS; the subject is mapped to a directory user row.
//
// Both modes produce the same `Viewer`, so everything downstream — membership
// checks, audit attribution, app sharing — is written once and does not care
// how the person was authenticated.
//
// SECURITY NOTE: in local-owner mode, anyone who can reach the daemon port is
// the owner. That is the historical (and correct) posture for a loopback
// single-user tool, but it means multi-user deployments MUST configure clerk
// mode; see `isMultiUserMode`.

import type { Request } from 'express';
import { LOCAL_OWNER_USER_ID, type AuthMode } from '@open-design/contracts';
import { JwksKeyStore, verifyJwt } from './jwt-verify.js';
import type { SqlExecutor } from '../storage/sql.js';
import { ensureLocalOwnerUser, getUser, upsertExternalUser, type DirectoryUser } from '../workspace-data/tenancy.js';

export interface Viewer {
  userId: string;
  displayName: string;
  email: string | null;
  mode: AuthMode;
}

export interface AuthConfig {
  mode: AuthMode;
  issuer: string | null;
  publishableKey: string | null;
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const issuer = env.OD_CLERK_ISSUER?.trim() || null;
  const publishableKey = env.OD_CLERK_PUBLISHABLE_KEY?.trim() || null;
  if (!issuer) return { mode: 'local-owner', issuer: null, publishableKey: null };
  return { mode: 'clerk', issuer: issuer.replace(/\/+$/, ''), publishableKey };
}

/** True when identities are real and separable — the precondition for
 * treating membership and roles as a security boundary rather than a UI hint. */
export function isMultiUserMode(config: AuthConfig): boolean {
  return config.mode === 'clerk';
}

function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function displayNameFromClaims(claims: Record<string, unknown>, fallback: string): string {
  const candidates = [
    claims.name,
    [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim() || undefined,
    claims.preferred_username,
    claims.username,
    claims.email,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function emailFromClaims(claims: Record<string, unknown>): string | null {
  const email = claims.email ?? claims.primary_email_address;
  return typeof email === 'string' && email.trim() ? email.trim() : null;
}

export class IdentityService {
  readonly config: AuthConfig;
  readonly #keyStore: JwksKeyStore | null;

  constructor(config: AuthConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.#keyStore = config.issuer
      ? new JwksKeyStore(`${config.issuer}/.well-known/jwks.json`, fetchImpl)
      : null;
  }

  /** Resolve the caller. Returns null only in clerk mode with no valid
   * session — local-owner mode always yields the owner. */
  async resolveViewer(req: Request, directory: SqlExecutor): Promise<Viewer | null> {
    if (this.config.mode === 'local-owner') {
      await ensureLocalOwnerUser(directory);
      const user = await getUser(directory, LOCAL_OWNER_USER_ID);
      return {
        userId: LOCAL_OWNER_USER_ID,
        displayName: user?.displayName ?? 'Local Owner',
        email: user?.email ?? null,
        mode: 'local-owner',
      };
    }

    const token = bearerToken(req);
    if (!token || !this.#keyStore || !this.config.issuer) return null;
    const verified = await verifyJwt(token, {
      keyStore: this.#keyStore,
      issuer: this.config.issuer,
    });
    if (!verified.ok) return null;

    const claims = verified.claims;
    const user: DirectoryUser = await upsertExternalUser(directory, {
      externalId: claims.sub,
      displayName: displayNameFromClaims(claims, claims.sub),
      email: emailFromClaims(claims),
    });
    return { userId: user.id, displayName: user.displayName, email: user.email, mode: 'clerk' };
  }
}

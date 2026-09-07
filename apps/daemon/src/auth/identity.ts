// Who is making this request?
//
// The daemon has two identity modes:
//
//   clerk (default) — every person signs in. Requests carry a session JWT
//     verified against OD_CLERK_ISSUER's JWKS; the subject is mapped to a
//     directory user row. `fetch` sends it as `Authorization: Bearer`. Browser
//     navigations (iframe `src`, `<img>`, CSS) cannot set that header, so the
//     SPA also plants an `od_session` cookie and we accept it as a fallback —
//     the same pattern the hosting serve function uses for `__session`. If the
//     issuer is missing, the app still requires sign-in and shows a setup
//     screen rather than silently becoming owner.
//
//   local-owner — opt-in via OD_AUTH_MODE=local-owner, and only when no
//     issuer is set. Every interactive request is the machine's owner. This
//     is for tests and a truly keyless laptop loop, not for a shared app.
//
// Both modes produce the same `Viewer`, so everything downstream — membership
// checks, audit attribution, app sharing — is written once and does not care
// how the person was authenticated.
//
// SECURITY NOTE: in local-owner mode, anyone who can reach the daemon port is
// the owner. That is only for tests and an explicit keyless laptop loop.
// Shared or production use must stay on clerk; see `isMultiUserMode`.

import type { Request } from 'express';
import { LOCAL_OWNER_USER_ID, personLabel, type AuthMode } from '@open-design/contracts';
import { JwksKeyStore, verifyJwt } from './jwt-verify.js';
import type { SqlExecutor } from '../storage/sql.js';
import {
  ensureLocalOwnerUser,
  ensurePersonalOrganization,
  getUser,
  profileAvatarUrl,
  upsertExternalUser,
  type DirectoryUser,
} from '../workspace-data/tenancy.js';

export interface Viewer {
  userId: string;
  displayName: string;
  email: string | null;
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
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
  if (issuer) return { mode: 'clerk', issuer: issuer.replace(/\/+$/, ''), publishableKey };
  // Sign-in is the default. Local-owner is an explicit opt-in so a missing
  // Clerk config cannot silently grant machine-owner powers.
  if (env.OD_AUTH_MODE?.trim() === 'local-owner') {
    return { mode: 'local-owner', issuer: null, publishableKey: null };
  }
  return { mode: 'clerk', issuer: null, publishableKey };
}

/** True when identities are real and separable — the precondition for
 * treating membership and roles as a security boundary rather than a UI hint. */
export function isMultiUserMode(config: AuthConfig): boolean {
  return config.mode === 'clerk' && Boolean(config.issuer);
}

/** Cookie the signed-in SPA plants so browser navigations can authenticate.
 *
 * `fetch` can attach `Authorization: Bearer`, but an iframe `src`, `<img>`,
 * or CSS/font request cannot. Those loads still have to reach `/api/projects/:id/raw/*`
 * (and siblings) as ordinary same-origin GETs. */
export const SESSION_COOKIE_NAME = 'od_session';

/** Clerk's own session cookie, accepted as a fallback when the SPA did not
 * plant `od_session`. Same rationale as the hosting serve function. */
const CLERK_SESSION_COOKIE_NAME = '__session';

function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function cookieValue(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const raw = trimmed.slice(eq + 1);
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function cookieToken(req: Request): string | null {
  const header = req.get('cookie');
  if (typeof header !== 'string' || !header.trim()) return null;
  return (
    cookieValue(header, SESSION_COOKIE_NAME) ??
    cookieValue(header, CLERK_SESSION_COOKIE_NAME)
  );
}

/** Clerk (and other) session JWTs have three non-empty dot-separated segments.
 * Infrastructure tokens such as `OD_API_TOKEN` do not, and must not be treated
 * as a session — a reverse proxy that injects `Authorization: Bearer <api-token>`
 * would otherwise hide a valid `od_session` cookie and 401 every signed-in call. */
function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function sessionJwt(token: string | null): string | null {
  return token && looksLikeJwt(token) ? token : null;
}

/** A JWT Bearer wins so an explicit caller session is never shadowed by a leftover
 * cookie. Opaque Authorization values are skipped so a proxy API token can coexist
 * with the session cookie. */
export function sessionToken(req: Request): string | null {
  return sessionJwt(bearerToken(req)) ?? cookieToken(req);
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
  const candidates = [claims.email, claims.primary_email_address, claims.email_address];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function usernameFromClaims(claims: Record<string, unknown>): string | null {
  const candidates = [claims.username, claims.preferred_username];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
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
        displayName: personLabel({
          displayName: user?.displayName ?? 'Local Owner',
          username: user?.username ?? null,
          email: user?.email ?? null,
        }),
        email: user?.email ?? null,
        username: user?.username ?? 'local-owner',
        bio: user?.bio ?? null,
        avatarUrl: profileAvatarUrl(LOCAL_OWNER_USER_ID, user?.avatarMime),
        mode: 'local-owner',
      };
    }

    const token = sessionToken(req);
    if (!token || !this.#keyStore || !this.config.issuer) return null;
    const verified = await verifyJwt(token, {
      keyStore: this.#keyStore,
      issuer: this.config.issuer,
    });
    if (!verified.ok) return null;

    const claims = verified.claims;
    const email = emailFromClaims(claims);
    const username = usernameFromClaims(claims);
    const user: DirectoryUser = await upsertExternalUser(directory, {
      externalId: claims.sub,
      // Pass Clerk's raw name so a chosen profile name is not replaced by
      // the username we would otherwise derive from a "Member" placeholder.
      displayName: displayNameFromClaims(claims, ''),
      email,
      username,
    });
    // Existing personal orgs may still need a rename off a Clerk user id.
    // New accounts are not auto-enrolled — they join or create after sign-up.
    await ensurePersonalOrganization(directory, {
      userId: user.id,
      displayName: personLabel({
        displayName: user.displayName,
        username: user.username,
        email: user.email,
      }),
    });
    return {
      userId: user.id,
      displayName: personLabel({
        displayName: user.displayName,
        username: user.username,
        email: user.email,
      }),
      email: user.email,
      username: user.username,
      bio: user.bio,
      avatarUrl: profileAvatarUrl(user.id, user.avatarMime),
      mode: 'clerk',
    };
  }
}

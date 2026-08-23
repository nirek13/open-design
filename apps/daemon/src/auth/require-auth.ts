// Deny-by-default API gate.
//
// `IdentityService` answers "who is this?". This middleware answers the
// separate question "is anyone allowed in without answering that?". They are
// deliberately not the same switch: a deployment can run clerk mode while
// still serving a few unauthenticated routes (the invite landing page, a
// shared app link), and a local single-user daemon must keep working with no
// auth configured at all.
//
// The rule:
//   - auth not required  -> every request passes; identity still resolves.
//   - auth required      -> a request to /api/* must carry a verified session,
//                           except for the small, explicit public allowlist.
//
// Required is implied by clerk mode (if you configured real identities, you
// want them enforced) and can be forced off with OD_REQUIRE_AUTH=0 for a
// deployment that intentionally fronts the daemon with its own gateway.

import type { NextFunction, Request, Response } from 'express';
import { createApiError } from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { AuthConfig, IdentityService } from './identity.js';
import type { SqlExecutor } from '../storage/sql.js';

/** Paths that must stay reachable while signed out.
 *
 * Keep this list short and exact. Every entry is a promise that the route
 * itself is safe for an anonymous caller — `/api/auth/context` is how the
 * browser discovers it needs to sign in, so gating it would deadlock the app. */
const PUBLIC_API_PATHS = new Set([
  '/api/auth/context',
  '/api/health',
  '/api/version',
  // AnalyticsProvider sits above the sign-in gate (root layout) so it can
  // install error tracking before a session exists. The payload is the
  // public PostHog key plus consent, not a secret.
  '/api/analytics/config',
]);

/** Prefixes reachable while signed out. `/api/invites/:token/accept` is how a
 * new person joins, and they are by definition not a member of anything yet. */
const PUBLIC_API_PREFIXES = ['/api/invites/'];

export function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_PATHS.has(pathname)) return true;
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function authIsRequired(config: AuthConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.OD_REQUIRE_AUTH?.trim();
  if (explicit === '1' || explicit === 'true') return true;
  if (explicit === '0' || explicit === 'false') return false;
  // No explicit setting: real identities imply enforcement.
  return config.mode === 'clerk';
}

interface Options {
  identity: IdentityService;
  directory: () => SqlExecutor;
  required: boolean;
}

/** Express middleware enforcing the rule above for `/api/*` only.
 *
 * Non-API paths (the SPA itself, static assets, `/s/:token` shared apps) are
 * untouched: the browser has to be able to load the app in order to show a
 * sign-in screen. */
export function requireAuthMiddleware({ identity, directory, required }: Options) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!required) return next();
    const pathname = req.path;
    if (!pathname.startsWith('/api/')) return next();
    if (isPublicApiPath(pathname)) return next();

    let viewer = null;
    try {
      viewer = await identity.resolveViewer(req, directory());
    } catch {
      // A malformed or expired token is not an internal error — it is simply
      // not a session.
      viewer = null;
    }
    if (!viewer) {
      sendApiError(res, 401, createApiError('UNAUTHORIZED', 'sign in to continue'));
      return;
    }
    return next();
  };
}

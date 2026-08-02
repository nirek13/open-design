// Request/response helpers shared by the hosting edge functions.

import { bearerFrom, callerFrom, verifyClerkToken, type Caller } from './jwt.ts';
import { readEnv, type HostingEnv } from './env.ts';

export interface ApiError {
  error: { code: string; message: string };
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...headers },
  });
}

export function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } } satisfies ApiError, status);
}

/**
 * CORS for the management API only.
 *
 * The daemon calls these functions from a loopback origin, and the web UI from
 * the product origin, so a permissive origin is appropriate here — these
 * endpoints carry no cookie-based authority. Every one of them requires an
 * `Authorization` bearer token, which a browser will not attach automatically,
 * so allowing `*` cannot become a confused-deputy path.
 */
export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-client-info, apikey',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '86400',
  };
}

export function preflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export interface AuthedContext {
  env: HostingEnv;
  caller: Caller;
}

/**
 * Establish the caller's identity, or return the response to send instead.
 *
 * Returns a deliberately vague message on failure: distinguishing "expired"
 * from "bad signature" to an unauthenticated caller tells an attacker which
 * half of a forgery attempt worked.
 */
export async function authenticate(
  request: Request,
): Promise<{ ok: true; context: AuthedContext } | { ok: false; response: Response }> {
  let env: HostingEnv;
  try {
    env = readEnv();
  } catch (error) {
    // A misconfigured deployment must fail loudly as a server error, never
    // silently degrade into an unauthenticated success.
    return {
      ok: false,
      response: fail(500, 'MISCONFIGURED', error instanceof Error ? error.message : 'configuration error'),
    };
  }

  const token = bearerFrom(request);
  if (!token) return { ok: false, response: fail(401, 'UNAUTHENTICATED', 'sign in to publish') };

  const verified = await verifyClerkToken(token, env.clerkIssuer);
  if (!verified.ok) {
    if (verified.reason === 'jwks-unavailable') {
      // Upstream identity provider is unreachable. This is our outage, not the
      // caller's bad credential, and it must be retryable rather than look
      // like a rejected sign-in.
      return { ok: false, response: fail(503, 'IDENTITY_UNAVAILABLE', 'identity provider unavailable') };
    }
    return { ok: false, response: fail(401, 'UNAUTHENTICATED', 'sign in to publish') };
  }

  return { ok: true, context: { env, caller: callerFrom(verified.claims) } };
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

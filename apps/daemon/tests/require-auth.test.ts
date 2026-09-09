// The deny-by-default API gate.
//
// This is a security boundary, so the tests are about what it refuses, not
// only what it allows: an unauthenticated call to any /api route must be
// rejected when auth is required, and the handful of public paths must be
// exactly the handful — no prefix tricks, no accidental wildcards.

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

import { authIsRequired, isPublicApiPath, requireAuthMiddleware } from '../src/auth/require-auth.js';
import type { AuthConfig, IdentityService } from '../src/auth/identity.js';

const LOCAL: AuthConfig = { mode: 'local-owner', issuer: null, publishableKey: null };
const CLERK: AuthConfig = {
  mode: 'clerk',
  issuer: 'https://example.clerk.accounts.dev',
  publishableKey: 'pk_test_x',
};

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

function req(path: string): Request {
  return { path } as Request;
}

function identityReturning(viewer: unknown): IdentityService {
  return { resolveViewer: vi.fn(async () => viewer) } as unknown as IdentityService;
}

describe('authIsRequired', () => {
  it('is off for a keyless local daemon', () => {
    expect(authIsRequired(LOCAL, {})).toBe(false);
  });

  it('is on as soon as real identities are configured', () => {
    // Configuring Clerk and then not enforcing it would be a trap.
    expect(authIsRequired(CLERK, {})).toBe(true);
  });

  it('is on in clerk mode even before the issuer is filled in', () => {
    expect(authIsRequired({ mode: 'clerk', issuer: null, publishableKey: null }, {})).toBe(true);
  });

  it('can be forced on for a local daemon', () => {
    expect(authIsRequired(LOCAL, { OD_REQUIRE_AUTH: '1' })).toBe(true);
  });

  it('can be forced off when a gateway in front already authenticates', () => {
    expect(authIsRequired(CLERK, { OD_REQUIRE_AUTH: '0' })).toBe(false);
  });
});

describe('isPublicApiPath', () => {
  it('lets the browser discover that it must sign in', () => {
    // Gating this would deadlock the app: it is how the client learns the mode.
    expect(isPublicApiPath('/api/auth/context')).toBe(true);
  });

  it('lets analytics bootstrap before a session exists', () => {
    // The provider wraps the root layout, above the sign-in gate.
    expect(isPublicApiPath('/api/analytics/config')).toBe(true);
    expect(isPublicApiPath('/api/analytics/mcp/event')).toBe(false);
  });

  it('lets a guest open a public booking link without a session', () => {
    expect(isPublicApiPath('/api/book/abc123')).toBe(true);
    expect(isPublicApiPath('/api/book/abc123/slots')).toBe(true);
    expect(isPublicApiPath('/api/books')).toBe(false);
  });

  it('lets a brand-new person redeem an invite', () => {
    expect(isPublicApiPath('/api/invites/abc123/accept')).toBe(true);
  });

  it('lets an incoming chat webhook post with only its token', () => {
    // The token in the URL is the whole credential; an outside system posting
    // a build result has no session and cannot be given one. The rest of the
    // chat surface stays gated.
    expect(isPublicApiPath('/api/chat/hooks/org-1/sometoken')).toBe(true);
    expect(isPublicApiPath('/api/orgs/org-1/chat/channels')).toBe(false);
    expect(isPublicApiPath('/api/orgs/org-1/chat/webhooks')).toBe(false);
  });

  it('lets Composio finish OAuth without a session cookie', () => {
    expect(isPublicApiPath('/api/connectors/oauth/callback/github')).toBe(true);
    expect(isPublicApiPath('/api/connectors/github/connect')).toBe(false);
  });

  it('lets agent tool wrappers authenticate via OD_TOOL_TOKEN alone', () => {
    expect(isPublicApiPath('/api/tools/live-artifacts/list')).toBe(true);
    expect(isPublicApiPath('/api/tools/connectors/execute')).toBe(true);
    // Near-miss: /api/tool without the trailing s must stay gated.
    expect(isPublicApiPath('/api/tool/live-artifacts/list')).toBe(false);
  });

  it('lets Slack and iMessage webhooks authenticate with the phone inbound token', () => {
    expect(isPublicApiPath('/api/phone/inbound/abc')).toBe(true);
    expect(isPublicApiPath('/api/phone/channels')).toBe(false);
  });

  it('does not leak anything else', () => {
    for (const path of [
      '/api/projects',
      '/api/orgs',
      '/api/data/orgs/ws-1/tables',
      '/api/apps',
      '/api/chat',
      // A near-miss must not pass: the allowlist is exact, not a prefix match.
      '/api/auth/context/../projects',
      '/api/auth/contexts',
      '/api/invites',
    ]) {
      expect(isPublicApiPath(path), path).toBe(false);
    }
  });
});

describe('requireAuthMiddleware', () => {
  const directory = () => ({}) as never;

  it('passes everything through when auth is not required', async () => {
    const next = vi.fn();
    const res = fakeRes();
    await requireAuthMiddleware({
      identity: identityReturning(null),
      directory,
      required: false,
    })(req('/api/projects'), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('refuses an unauthenticated API call when auth is required', async () => {
    const next = vi.fn();
    const res = fakeRes();
    await requireAuthMiddleware({
      identity: identityReturning(null),
      directory,
      required: true,
    })(req('/api/projects'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('admits a verified session', async () => {
    const next = vi.fn();
    const res = fakeRes();
    await requireAuthMiddleware({
      identity: identityReturning({ userId: 'u-1', displayName: 'A', email: null, mode: 'clerk' }),
      directory,
      required: true,
    })(req('/api/projects'), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('treats a token that throws as no session rather than a server error', async () => {
    const next = vi.fn();
    const res = fakeRes();
    const identity = {
      resolveViewer: vi.fn(async () => {
        throw new Error('jwks unreachable');
      }),
    } as unknown as IdentityService;
    await requireAuthMiddleware({ identity, directory, required: true })(
      req('/api/projects'),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('leaves non-API paths alone so the sign-in screen can load', async () => {
    const next = vi.fn();
    const res = fakeRes();
    // The browser must be able to fetch the app itself in order to render a
    // sign-in form; gating static assets would make signing in impossible.
    await requireAuthMiddleware({
      identity: identityReturning(null),
      directory,
      required: true,
    })(req('/index.html'), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });
});

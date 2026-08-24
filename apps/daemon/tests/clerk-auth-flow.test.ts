// The HTTP contract a signed-out browser actually hits: discover that it
// must sign in, then be refused everywhere else until a verified session
// shows up.

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { closeDatabase, openDatabase } from '../src/db.js';
import { registerOrganizationRoutes } from '../src/routes/organizations.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { IdentityService } from '../src/auth/identity.js';
import { requireAuthMiddleware } from '../src/auth/require-auth.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';

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
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

describe('clerk sign-in HTTP flow', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let server: ReturnType<express.Express['listen']> | null = null;
  let base = '';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-clerk-flow-'));
    const db = openDatabase(tempDir, { dataDir: tempDir });
    manager = new WorkspaceDbManager(tempDir);
    await ensureDefaultOrganization(manager.directoryExecutor);

    const identity = new IdentityService(
      { mode: 'clerk', issuer: ISSUER, publishableKey: 'pk_test_x' },
      fetchImpl,
    );
    const app = express();
    app.use(express.json());
    app.use(
      requireAuthMiddleware({
        identity,
        directory: () => manager.directoryExecutor,
        required: true,
      }),
    );
    registerOrganizationRoutes(app, {
      db,
      organizations: {
        manager,
        identity,
        dataDir: tempDir,
        serveAppFile: async (_req: express.Request, res: express.Response) => {
          res.status(200).send('');
        },
      },
    } as any);

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve());
      server!.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
    manager.closeAll();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function json(url: string, token?: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${url}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  it('lets the browser discover clerk mode while signed out', async () => {
    const context = await json('/api/auth/context');
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      mode: 'clerk',
      publishableKey: 'pk_test_x',
      viewer: null,
      organizations: [],
    });
    expect(context.body.appOrigin).toMatch(/^https?:\/\//);
  });

  it('advertises the web sidecar origin so packaged Clerk redirects stay http', async () => {
    const previous = process.env.OD_WEB_PORT;
    process.env.OD_WEB_PORT = '17573';
    try {
      const context = await json('/api/auth/context');
      expect(context.status).toBe(200);
      expect(context.body.appOrigin).toBe('http://127.0.0.1:17573');
    } finally {
      if (previous === undefined) delete process.env.OD_WEB_PORT;
      else process.env.OD_WEB_PORT = previous;
    }
  });

  it('refuses every other API call until a session exists', async () => {
    const orgs = await json('/api/orgs');
    expect(orgs.status).toBe(401);
    expect(orgs.body.error.code).toBe('UNAUTHORIZED');
  });

  it('admits a session cookie so iframe file previews can load', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_iframe',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Ivy',
        email: 'ivy@co.com',
      },
      privateKey,
    );
    const response = await fetch(`${base}/api/orgs`, {
      headers: { cookie: `od_session=${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { organizations?: unknown[] };
    expect(Array.isArray(body.organizations)).toBe(true);
  });

  it('admits a verified session and names the caller', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_signed_in',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Sam',
        email: 'sam@co.com',
      },
      privateKey,
    );
    const context = await json('/api/auth/context', token);
    expect(context.status).toBe(200);
    expect(context.body.viewer).toMatchObject({ displayName: 'Sam', email: 'sam@co.com' });

    const orgs = await json('/api/orgs', token);
    expect(orgs.status).toBe(200);
    expect(orgs.body.organizations).toHaveLength(1);
    expect(orgs.body.organizations[0]).toMatchObject({
      name: "Sam's Organization",
      role: 'owner',
    });
  });
});

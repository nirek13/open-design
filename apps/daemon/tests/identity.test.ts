// Clerk identity: a missing or bad session is "nobody", never the local owner.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Request } from 'express';

import { closeDatabase, openDatabase } from '../src/db.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { IdentityService, readAuthConfig } from '../src/auth/identity.js';
import { personalOrganizationName } from '../src/workspace-data/tenancy.js';

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

function reqWithBearer(token: string | null): Request {
  return {
    get(name: string) {
      if (name.toLowerCase() === 'authorization' && token) return `Bearer ${token}`;
      return undefined;
    },
  } as Request;
}

describe('readAuthConfig', () => {
  it('requires clerk sign-in by default, even with no issuer yet', () => {
    expect(readAuthConfig({})).toEqual({ mode: 'clerk', issuer: null, publishableKey: null });
  });

  it('opts into local-owner only when OD_AUTH_MODE=local-owner', () => {
    expect(readAuthConfig({ OD_AUTH_MODE: 'local-owner' })).toEqual({
      mode: 'local-owner',
      issuer: null,
      publishableKey: null,
    });
  });

  it('prefers clerk when an issuer is set, even if local-owner was requested', () => {
    expect(
      readAuthConfig({
        OD_AUTH_MODE: 'local-owner',
        OD_CLERK_ISSUER: 'https://example.clerk.accounts.dev/',
        OD_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
      }),
    ).toEqual({
      mode: 'clerk',
      issuer: 'https://example.clerk.accounts.dev',
      publishableKey: 'pk_test_x',
    });
  });

  it('enters clerk mode from OD_CLERK_ISSUER and strips a trailing slash', () => {
    expect(
      readAuthConfig({
        OD_CLERK_ISSUER: 'https://example.clerk.accounts.dev/',
        OD_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
      }),
    ).toEqual({
      mode: 'clerk',
      issuer: 'https://example.clerk.accounts.dev',
      publishableKey: 'pk_test_x',
    });
  });
});

describe('personalOrganizationName', () => {
  it('names a personal workspace after the person', () => {
    expect(personalOrganizationName('Ada')).toBe("Ada's Organization");
    expect(personalOrganizationName('ada@co.com')).toBe('My Organization');
    expect(personalOrganizationName('')).toBe('My Organization');
  });
});

describe('IdentityService clerk mode', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' };
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const identity = new IdentityService(
    { mode: 'clerk', issuer: ISSUER, publishableKey: 'pk_test_x' },
    fetchImpl,
  );

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-identity-'));
    openDatabase(tempDir, { dataDir: tempDir });
    manager = new WorkspaceDbManager(tempDir);
  });

  afterEach(() => {
    manager.closeAll();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when there is no session', async () => {
    expect(await identity.resolveViewer(reqWithBearer(null), manager.directoryExecutor)).toBeNull();
  });

  it('maps a verified session onto a directory user', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_abc',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        email: 'a@co.com',
        name: 'Ada',
      },
      privateKey,
    );
    const viewer = await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor);
    expect(viewer).toMatchObject({
      displayName: 'Ada',
      email: 'a@co.com',
      mode: 'clerk',
    });
    expect(viewer?.userId).toMatch(/^user-/);

    const orgs = await manager.directoryExecutor.all<{ name: string; role: string }>(
      `SELECT w.name, m.role
         FROM od_workspaces w
         JOIN od_workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ?`,
      [viewer!.userId],
    );
    expect(orgs).toEqual([{ name: "Ada's Organization", role: 'owner' }]);

    await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor);
    const again = await manager.directoryExecutor.all<{ name: string }>(
      `SELECT w.name
         FROM od_workspaces w
         JOIN od_workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ?`,
      [viewer!.userId],
    );
    expect(again).toHaveLength(1);
  });

  it('stores a Clerk username so teammates can be invited by it', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_ada',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        email: 'ada@co.com',
        name: 'Ada Lovelace',
        username: 'ada',
      },
      privateKey,
    );
    const viewer = await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor);
    const row = await manager.directoryExecutor.get<{ username: string }>(
      'SELECT username FROM od_users WHERE id = ?',
      [viewer!.userId],
    );
    expect(row?.username).toBe('ada');
  });

  it('refuses a token from the wrong issuer', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      { sub: 'user_abc', iss: 'https://evil.example', exp: Math.floor(Date.now() / 1000) + 3600 },
      privateKey,
    );
    expect(await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor)).toBeNull();
  });
});

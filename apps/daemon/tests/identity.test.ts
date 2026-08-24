// Clerk identity: a missing or bad session is "nobody", never the local owner.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Request } from 'express';

import { closeDatabase, openDatabase } from '../src/db.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { IdentityService, readAuthConfig, SESSION_COOKIE_NAME } from '../src/auth/identity.js';
import {
  createOrganization,
  personalOrganizationName,
  setUserUsername,
  updateUserProfile,
} from '../src/workspace-data/tenancy.js';

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

function reqWithAuth(opts: { bearer?: string | null; cookie?: string | null }): Request {
  return {
    get(name: string) {
      const key = name.toLowerCase();
      if (key === 'authorization' && opts.bearer) return `Bearer ${opts.bearer}`;
      if (key === 'cookie' && opts.cookie) return opts.cookie;
      return undefined;
    },
  } as Request;
}

function reqWithBearer(token: string | null): Request {
  return reqWithAuth({ bearer: token });
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
    expect(personalOrganizationName('user_abc123')).toBe('My Organization');
    expect(personalOrganizationName('Member')).toBe('My Organization');
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

  it('maps a session cookie so iframe and img navigations can authenticate', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_cookie',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Ivy',
        email: 'ivy@co.com',
      },
      privateKey,
    );
    const viewer = await identity.resolveViewer(
      reqWithAuth({ cookie: `${SESSION_COOKIE_NAME}=${token}` }),
      manager.directoryExecutor,
    );
    expect(viewer).toMatchObject({
      displayName: 'Ivy',
      email: 'ivy@co.com',
      mode: 'clerk',
    });
  });

  it('accepts Clerk __session as a fallback cookie name', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_clerk_cookie',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Kai',
      },
      privateKey,
    );
    const viewer = await identity.resolveViewer(
      reqWithAuth({ cookie: `__session=${token}` }),
      manager.directoryExecutor,
    );
    expect(viewer?.displayName).toBe('Kai');
  });

  it('prefers a Bearer token over a leftover session cookie', async () => {
    const cookieTok = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_cookie',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Cookie Person',
      },
      privateKey,
    );
    const bearerTok = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_bearer',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Bearer Person',
      },
      privateKey,
    );
    const viewer = await identity.resolveViewer(
      reqWithAuth({
        bearer: bearerTok,
        cookie: `${SESSION_COOKIE_NAME}=${cookieTok}`,
      }),
      manager.directoryExecutor,
    );
    expect(viewer?.displayName).toBe('Bearer Person');
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
    expect(orgs).toEqual([]);

    await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor);
    const again = await manager.directoryExecutor.all<{ name: string }>(
      `SELECT w.name
         FROM od_workspaces w
         JOIN od_workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ?`,
      [viewer!.userId],
    );
    expect(again).toHaveLength(0);
  });

  it('does not store a Clerk subject as a display name or workspace name', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_abc123xyz',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey,
    );
    const viewer = await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor);
    expect(viewer?.displayName).toBe('Member');
    expect(viewer?.displayName).not.toMatch(/^user_/);

    const orgs = await manager.directoryExecutor.all<{ name: string }>(
      `SELECT w.name
         FROM od_workspaces w
         JOIN od_workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ?`,
      [viewer!.userId],
    );
    expect(orgs).toEqual([]);
  });

  it('renames a personal org that was generated from a Clerk user id', async () => {
    const token = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_abc123xyz',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey,
    );
    const viewer = await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor);
    await createOrganization(manager.directoryExecutor, {
      name: "user_abc123xyz's Organization",
      ownerUserId: viewer!.userId,
    });

    const named = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      {
        sub: 'user_abc123xyz',
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
        username: 'nirek',
      },
      privateKey,
    );
    const again = await identity.resolveViewer(reqWithBearer(named), manager.directoryExecutor);
    expect(again?.displayName).toBe('nirek');

    const orgs = await manager.directoryExecutor.all<{ name: string }>(
      `SELECT w.name
         FROM od_workspaces w
         JOIN od_workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = ?`,
      [viewer!.userId],
    );
    expect(orgs).toEqual([{ name: "nirek's Organization" }]);
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

  it('does not overwrite a claimed username when Clerk later sends a different handle', async () => {
    const claims = {
      sub: 'user_ada',
      iss: ISSUER,
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'ada@co.com',
      name: 'Ada Lovelace',
    };
    const first = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      { ...claims, username: 'ada' },
      privateKey,
    );
    const viewer = await identity.resolveViewer(reqWithBearer(first), manager.directoryExecutor);
    expect(viewer?.username).toBe('ada');

    const second = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      { ...claims, username: 'ada-new' },
      privateKey,
    );
    const again = await identity.resolveViewer(reqWithBearer(second), manager.directoryExecutor);
    expect(again?.username).toBe('ada');

    await setUserUsername(manager.directoryExecutor, viewer!.userId, 'jane');
    const third = signRs256(
      { alg: 'RS256', typ: 'JWT', kid },
      { ...claims, username: 'ada' },
      privateKey,
    );
    const afterClaim = await identity.resolveViewer(reqWithBearer(third), manager.directoryExecutor);
    expect(afterClaim?.username).toBe('jane');
  });

  it('does not replace a chosen display name with Clerk Member', async () => {
    const claims = {
      sub: 'user_nirek',
      iss: ISSUER,
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'nirek@co.com',
      name: 'Member',
      username: 'nirek',
    };
    const token = signRs256({ alg: 'RS256', typ: 'JWT', kid }, claims, privateKey);
    const viewer = await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor);
    expect(viewer?.displayName).toBe('nirek');

    await updateUserProfile(manager.directoryExecutor, viewer!.userId, {
      displayName: 'Ada Lovelace',
    });
    const again = await identity.resolveViewer(reqWithBearer(token), manager.directoryExecutor);
    expect(again?.displayName).toBe('Ada Lovelace');
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

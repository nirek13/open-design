import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase } from '../src/db.js';
import { registerOrganizationRoutes } from '../src/routes/organizations.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { IdentityService } from '../src/auth/identity.js';
import {
  createOrganization,
  ensureDefaultOrganization,
  ensureLocalOwnerUser,
  getActiveMemberForUser,
  setUserUsername,
  updateOrgMember,
  upsertExternalUser,
} from '../src/workspace-data/tenancy.js';
import { LOCAL_OWNER_USER_ID } from '@open-design/contracts';

describe('organization routes', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let server: ReturnType<express.Express['listen']> | null = null;
  let base = '';
  let orgId = '';
  const servedFiles: Array<{ projectId: string; filePath: string }> = [];

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-org-routes-'));
    const db = openDatabase(tempDir, { dataDir: tempDir });
    manager = new WorkspaceDbManager(tempDir);
    orgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    servedFiles.length = 0;

    const app = express();
    app.use(express.json());
    registerOrganizationRoutes(app, {
      db,
      organizations: {
        manager,
        identity: new IdentityService({ mode: 'local-owner', issuer: null, publishableKey: null }),
        dataDir: tempDir,
        serveAppFile: async (
          _req: unknown,
          res: express.Response,
          input: { projectId: string; filePath: string },
        ) => {
          servedFiles.push(input);
          res.status(200).send(`<html>${input.filePath}</html>`);
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

  async function json(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  it('bootstraps an organization and reports the caller through /api/auth/context', async () => {
    const context = await json('GET', '/api/auth/context');
    expect(context.status).toBe(200);
    expect(context.body.mode).toBe('local-owner');
    expect(context.body.viewer.userId).toBe(LOCAL_OWNER_USER_ID);
    expect(context.body.organizations).toHaveLength(1);
    expect(context.body.organizations[0].role).toBe('owner');
    expect(context.body.organizations[0].memberCount).toBe(1);
  });

  it('creates organizations and lists only the ones the caller belongs to', async () => {
    const created = await json('POST', '/api/orgs', { name: 'Finance' });
    expect(created.status).toBe(201);

    // An organization the local owner is not a member of must not appear.
    const outsiderUser = await upsertExternalUser(manager.directoryExecutor, {
      externalId: 'ext-outsider',
      displayName: 'Outsider',
      email: null,
    });
    await createOrganization(manager.directoryExecutor, { name: 'Someone else', ownerUserId: outsiderUser.id });

    const mine = await json('GET', '/api/orgs');
    expect(mine.body.organizations.map((org: any) => org.name).sort()).toEqual([
      'Finance',
      'My Organization',
    ]);
  });

  describe('invites', () => {
    it('mints a one-time link, previews it unauthenticated, and admits the visitor', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/invites`, { role: 'admin' });
      expect(created.status).toBe(201);
      expect(created.body.token).toBeTruthy();
      expect(created.body.url).toContain(`/join/${created.body.token}`);

      const preview = await json('GET', `/api/invites/${created.body.token}`);
      expect(preview.body).toMatchObject({ valid: true, orgName: 'My Organization', role: 'admin' });
      expect(created.body.invite.kind).toBe('link');

      // Accepting as the local owner is a no-op: they are already a member,
      // and re-opening a link must not burn a use.
      const accepted = await json('POST', `/api/invites/${created.body.token}/accept`);
      expect(accepted.status).toBe(200);
      const invites = await json('GET', `/api/orgs/${orgId}/invites`);
      expect(invites.body.invites[0].useCount).toBe(0);
    });

    it('points join links at the web origin and redirects daemon-port /join URLs there', async () => {
      const previous = process.env.OD_WEB_PORT;
      process.env.OD_WEB_PORT = '17573';
      try {
        const created = await json('POST', `/api/orgs/${orgId}/invites`, { role: 'member' });
        expect(created.status).toBe(201);
        expect(created.body.url).toBe(`http://127.0.0.1:17573/join/${created.body.token}`);

        const response = await fetch(`${base}/join/${created.body.token}`, { redirect: 'manual' });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe(
          `http://127.0.0.1:17573/join/${created.body.token}`,
        );
      } finally {
        if (previous == null) delete process.env.OD_WEB_PORT;
        else process.env.OD_WEB_PORT = previous;
      }
    });

    it('admits a genuinely new person with the invited role', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/invites`, { role: 'member' });
      const newcomer = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-newcomer',
        displayName: 'Newcomer',
        email: 'new@co.com',
      });
      // Redeeming happens at the service layer here because the HTTP surface
      // resolves the caller to the local owner in keyless mode.
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const result = await acceptOrgInvite(manager.directoryExecutor, created.body.token, newcomer.id);
      expect(result.member.role).toBe('member');
      expect(result.organization.id).toBe(orgId);

      const members = await json('GET', `/api/orgs/${orgId}/members`);
      expect(members.body.members).toHaveLength(2);
    });

    it('refuses revoked, expired, and unknown links', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/invites`, {});
      await json('POST', `/api/orgs/${orgId}/invites/${created.body.invite.id}/revoke`);
      const revoked = await json('GET', `/api/invites/${created.body.token}`);
      expect(revoked.body).toMatchObject({ valid: false, reason: 'revoked' });

      const unknown = await json('GET', '/api/invites/not-a-real-token');
      expect(unknown.body).toMatchObject({ valid: false, reason: 'not-found' });

      const expired = await json('POST', `/api/orgs/${orgId}/invites`, { expiresInHours: -1 });
      expect(expired.status).toBe(422);
    });

    it('stops admitting people once a single-use link is spent', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/invites`, { maxUses: 1 });
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const first = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-a',
        displayName: 'A',
        email: null,
      });
      const second = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-b',
        displayName: 'B',
        email: null,
      });
      await acceptOrgInvite(manager.directoryExecutor, created.body.token, first.id);
      await expect(
        acceptOrgInvite(manager.directoryExecutor, created.body.token, second.id),
      ).rejects.toThrow(/limit/);
    });

    it('invites by email and only admits that address', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/invites`, {
        email: 'Jane@Co.com',
        role: 'admin',
      });
      expect(created.status).toBe(201);
      expect(created.body.invite).toMatchObject({
        kind: 'email',
        targetEmail: 'jane@co.com',
        maxUses: 1,
        role: 'admin',
      });
      expect(created.body.invite.expiresAt).toBeGreaterThan(Date.now());

      const dupPending = await json('POST', `/api/orgs/${orgId}/invites`, { email: 'jane@co.com' });
      expect(dupPending.status).toBe(409);

      const preview = await json('GET', `/api/invites/${created.body.token}`);
      expect(preview.body).toMatchObject({ valid: true, restricted: true, role: 'admin' });
      expect(preview.body).not.toHaveProperty('targetEmail');

      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const stranger = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-stranger',
        displayName: 'Stranger',
        email: 'other@co.com',
      });
      await expect(
        acceptOrgInvite(manager.directoryExecutor, created.body.token, stranger.id),
      ).rejects.toThrow(/someone else/);

      const jane = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-jane',
        displayName: 'Jane',
        email: 'jane@co.com',
      });
      const result = await acceptOrgInvite(manager.directoryExecutor, created.body.token, jane.id);
      expect(result.member.role).toBe('admin');

      const duplicate = await json('POST', `/api/orgs/${orgId}/invites`, { email: 'jane@co.com' });
      expect(duplicate.status).toBe(409);
    });

    it('invites by username and lists the invite as pending for that person', async () => {
      const teammate = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-sam',
        displayName: 'Sam Rivera',
        email: 'sam@co.com',
        username: 'sam',
      });
      const created = await json('POST', `/api/orgs/${orgId}/invites`, { username: 'Sam' });
      expect(created.status).toBe(201);
      expect(created.body.invite).toMatchObject({
        kind: 'username',
        targetUsername: 'sam',
        targetUserId: teammate.id,
        maxUses: 1,
      });

      const { listPendingInvitesForUser, acceptPendingInvite, acceptOrgInvite } = await import(
        '../src/workspace-data/tenancy.js'
      );
      const pending = await listPendingInvitesForUser(manager.directoryExecutor, teammate.id);
      expect(pending).toEqual([
        expect.objectContaining({ id: created.body.invite.id, orgId, kind: 'username' }),
      ]);
      expect(await listPendingInvitesForUser(manager.directoryExecutor, LOCAL_OWNER_USER_ID)).toEqual([]);

      const stranger = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-not-sam',
        displayName: 'Not Sam',
        email: 'not-sam@co.com',
        username: 'notsam',
      });
      await expect(
        acceptPendingInvite(manager.directoryExecutor, created.body.invite.id, stranger.id),
      ).rejects.toThrow(/someone else/);

      // Already-members who open someone else's invite are returned as-is and
      // must not burn the remaining use.
      await acceptPendingInvite(manager.directoryExecutor, created.body.invite.id, LOCAL_OWNER_USER_ID);
      expect((await json('GET', `/api/orgs/${orgId}/invites`)).body.invites[0].useCount).toBe(0);

      const accepted = await acceptPendingInvite(
        manager.directoryExecutor,
        created.body.invite.id,
        teammate.id,
      );
      expect(accepted.member.userId).toBe(teammate.id);

      const link = await json('POST', `/api/orgs/${orgId}/invites`, {});
      await expect(
        acceptPendingInvite(manager.directoryExecutor, link.body.invite.id, teammate.id),
      ).rejects.toThrow(/not valid/);

      const ghost = await json('POST', `/api/orgs/${orgId}/invites`, { username: 'new-hire' });
      const hire = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-hire',
        displayName: 'New Hire',
        email: null,
        username: 'new-hire',
      });
      const joined = await acceptOrgInvite(manager.directoryExecutor, ghost.body.token, hire.id);
      expect(joined.member.userId).toBe(hire.id);
    });
  });

  describe('membership', () => {
    it('never lets the last owner be demoted or removed', async () => {
      const owner = await getActiveMemberForUser(manager.directoryExecutor, orgId, LOCAL_OWNER_USER_ID);
      const demoted = await json('PATCH', `/api/orgs/${orgId}/members/${owner!.id}`, {
        role: 'member',
      });
      expect(demoted.status).toBe(409);
      expect(demoted.body.error.code).toBe('ORG_LAST_OWNER');

      const removed = await json('DELETE', `/api/orgs/${orgId}/members/${owner!.id}`);
      expect(removed.status).toBe(409);
    });

    it('allows demotion once a second owner exists', async () => {
      const second = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-second-owner',
        displayName: 'Second',
        email: null,
      });
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const invite = await json('POST', `/api/orgs/${orgId}/invites`, { role: 'owner' });
      await acceptOrgInvite(manager.directoryExecutor, invite.body.token, second.id);

      const owner = await getActiveMemberForUser(manager.directoryExecutor, orgId, LOCAL_OWNER_USER_ID);
      const demoted = await json('PATCH', `/api/orgs/${orgId}/members/${owner!.id}`, {
        role: 'member',
      });
      expect(demoted.status).toBe(200);
      expect(demoted.body.member.role).toBe('member');
    });

    it('refuses org actions from someone who is not a member', async () => {
      const outsiderUser = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-outsider2',
        displayName: 'Outsider',
        email: null,
      });
      const otherOrg = await createOrganization(manager.directoryExecutor, {
        name: 'Not mine',
        ownerUserId: outsiderUser.id,
      });
      const denied = await json('GET', `/api/orgs/${otherOrg.id}/members`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('ORG_MEMBERSHIP_REQUIRED');
    });

    it('refuses privileged actions when the role is too low', async () => {
      // Add a second owner so the local owner can legally be demoted, then
      // demote them and confirm invites become unavailable.
      const second = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-owner-2',
        displayName: 'Second',
        email: null,
      });
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const invite = await json('POST', `/api/orgs/${orgId}/invites`, { role: 'owner' });
      await acceptOrgInvite(manager.directoryExecutor, invite.body.token, second.id);
      const owner = await getActiveMemberForUser(manager.directoryExecutor, orgId, LOCAL_OWNER_USER_ID);
      await updateOrgMember(manager.directoryExecutor, orgId, owner!.id, { role: 'member' });

      const denied = await json('GET', `/api/orgs/${orgId}/invites`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('ORG_ROLE_REQUIRED');
      expect(denied.body.error.details).toMatchObject({ required: 'admin', actual: 'member' });
    });
  });

  describe('apps and sharing', () => {
    async function publishApp() {
      const created = await json('POST', `/api/orgs/${orgId}/apps`, {
        name: 'Expense form',
        projectId: 'proj-1',
        filePath: 'expenses.html',
      });
      expect(created.status).toBe(201);
      return created.body.app;
    }

    it('publishes an app visible to the organization', async () => {
      const app = await publishApp();
      expect(app.visibility).toBe('org');
      expect(app.openCount).toBe(0);

      const list = await json('GET', `/api/orgs/${orgId}/apps`);
      expect(list.body.apps).toHaveLength(1);
      expect(list.body.apps[0].createdByName).toBe('Local Owner');
    });

    it('hides a private app from everyone but its publisher', async () => {
      const app = await publishApp();
      await json('PATCH', `/api/orgs/${orgId}/apps/${app.id}`, { visibility: 'private' });
      // The publisher still sees it...
      const mine = await json('GET', `/api/orgs/${orgId}/apps`);
      expect(mine.body.apps).toHaveLength(1);

      // ...but a different member does not.
      const other = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-other-member',
        displayName: 'Other',
        email: null,
      });
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const invite = await json('POST', `/api/orgs/${orgId}/invites`, {});
      await acceptOrgInvite(manager.directoryExecutor, invite.body.token, other.id);
      const otherMember = await getActiveMemberForUser(manager.directoryExecutor, orgId, other.id);
      const { listApps } = await import('../src/workspace-data/apps.js');
      const visible = await listApps(manager.workspaceExecutor(orgId), orgId, {
        viewerMemberId: otherMember!.id,
      });
      expect(visible).toHaveLength(0);
    });

    it('rejects a file path that escapes the project', async () => {
      const bad = await json('POST', `/api/orgs/${orgId}/apps`, {
        name: 'Sneaky',
        projectId: 'proj-1',
        filePath: '../../etc/passwd',
      });
      expect(bad.status).toBe(422);
    });

    it('serves a shared app to an anonymous visitor and counts the view', async () => {
      const app = await publishApp();
      const shared = await json('POST', `/api/orgs/${orgId}/apps/${app.id}/shares`);
      expect(shared.status).toBe(201);
      expect(shared.body.url).toContain(`/s/${shared.body.token}`);

      // No credentials at all — the token is the whole capability.
      const page = await fetch(`${base}/s/${shared.body.token}`);
      expect(page.status).toBe(200);
      expect(servedFiles).toEqual([{ projectId: 'proj-1', filePath: 'expenses.html' }]);

      const shares = await json('GET', `/api/orgs/${orgId}/apps/${app.id}/shares`);
      expect(shares.body.shares[0].viewCount).toBe(1);
      // Sharing by link flips visibility so the two can never disagree.
      const reread = await json('GET', `/api/orgs/${orgId}/apps/${app.id}`);
      expect(reread.body.app.visibility).toBe('link');
    });

    it('stops serving a revoked share link', async () => {
      const app = await publishApp();
      const shared = await json('POST', `/api/orgs/${orgId}/apps/${app.id}/shares`);
      await json(
        'POST',
        `/api/orgs/${orgId}/apps/${app.id}/shares/${shared.body.share.id}/revoke`,
      );
      const page = await fetch(`${base}/s/${shared.body.token}`);
      expect(page.status).toBe(404);
    });

    it('refuses an unknown share token', async () => {
      const page = await fetch(`${base}/s/definitely-not-a-token`);
      expect(page.status).toBe(404);
    });

    it('publishes an app to a stable public web URL in one step', async () => {
      const app = await publishApp();
      const first = await json('POST', `/api/orgs/${orgId}/apps/${app.id}/publish-web`);
      expect(first.status).toBe(200);
      expect(first.body.url).toMatch(/\/s\//);
      expect(first.body.app.webUrl).toBe(first.body.url);

      const page = await fetch(first.body.url as string);
      expect(page.status).toBe(200);
      expect(servedFiles).toEqual([{ projectId: 'proj-1', filePath: 'expenses.html' }]);

      const again = await json('POST', `/api/orgs/${orgId}/apps/${app.id}/publish-web`);
      expect(again.status).toBe(200);
      expect(again.body.url).toBe(first.body.url);
    });

    it('rewrites a persisted loopback share URL onto the public origin', async () => {
      const app = await publishApp();
      const first = await json('POST', `/api/orgs/${orgId}/apps/${app.id}/publish-web`);
      expect(first.status).toBe(200);
      const tokenPath = new URL(first.body.url as string).pathname;
      expect(tokenPath).toMatch(/^\/s\//);

      const rewritten = await fetch(`${base}/api/orgs/${orgId}/apps/${app.id}/publish-web`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-host': 'od.example.com',
          'x-forwarded-proto': 'https',
        },
      });
      expect(rewritten.status).toBe(200);
      const body = (await rewritten.json()) as { url: string; app: { webUrl: string } };
      expect(body.url).toBe(`https://od.example.com${tokenPath}`);
      expect(body.app.webUrl).toBe(body.url);
    });

    it('stops serving an archived app even with a live link', async () => {
      const app = await publishApp();
      const shared = await json('POST', `/api/orgs/${orgId}/apps/${app.id}/shares`);
      await json('PATCH', `/api/orgs/${orgId}/apps/${app.id}`, { status: 'archived' });
      const page = await fetch(`${base}/s/${shared.body.token}`);
      expect(page.status).toBe(404);
    });

    it('pins an app and lists it under ?pinned=1', async () => {
      const app = await publishApp();
      const updated = await json('PATCH', `/api/orgs/${orgId}/apps/${app.id}`, { pinned: true });
      expect(updated.body.app.pinned).toBe(true);
      expect(updated.body.app.pinnedAt).toBeTypeOf('number');
      const pinned = await json('GET', `/api/orgs/${orgId}/apps?pinned=1`);
      expect(pinned.body.apps.map((row: { id: string }) => row.id)).toContain(app.id);
    });

    it('hides a restricted app from members without a grant', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/apps`, {
        name: 'Restricted board',
        projectId: 'proj-1',
        filePath: 'board.html',
        accessMode: 'restricted',
      });
      expect(created.status).toBe(201);
      expect(created.body.app.accessMode).toBe('restricted');
      const appId = created.body.app.id;

      const other = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-restricted-peer',
        displayName: 'Peer',
        email: null,
      });
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const invite = await json('POST', `/api/orgs/${orgId}/invites`, {});
      await acceptOrgInvite(manager.directoryExecutor, invite.body.token, other.id);
      const otherMember = await getActiveMemberForUser(manager.directoryExecutor, orgId, other.id);
      const { listApps, canEditApp, getApp } = await import('../src/workspace-data/apps.js');
      const before = await listApps(manager.workspaceExecutor(orgId), orgId, {
        viewerMemberId: otherMember!.id,
        viewerRole: 'member',
      });
      expect(before.find((row) => row.id === appId)).toBeUndefined();

      await json('PUT', `/api/orgs/${orgId}/apps/${appId}/grants`, {
        grants: [{ memberId: otherMember!.id, role: 'view' }],
      });
      const after = await listApps(manager.workspaceExecutor(orgId), orgId, {
        viewerMemberId: otherMember!.id,
        viewerRole: 'member',
      });
      expect(after.find((row) => row.id === appId)?.id).toBe(appId);

      const app = await getApp(manager.workspaceExecutor(orgId), orgId, appId);
      expect(canEditApp(app, { memberId: otherMember!.id, role: 'member' }, 'view')).toBe(false);
      expect(canEditApp(app, { memberId: otherMember!.id, role: 'member' }, 'edit')).toBe(true);
    });

    it('hides an org-wide app from a member on the except list', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/apps`, {
        name: 'Payroll',
        projectId: 'proj-1',
        filePath: 'payroll.html',
        denials: [],
      });
      expect(created.status).toBe(201);
      const appId = created.body.app.id;

      const other = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-except-peer',
        displayName: 'Pat',
        email: null,
      });
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const invite = await json('POST', `/api/orgs/${orgId}/invites`, {});
      await acceptOrgInvite(manager.directoryExecutor, invite.body.token, other.id);
      const otherMember = await getActiveMemberForUser(manager.directoryExecutor, orgId, other.id);

      await json('PUT', `/api/orgs/${orgId}/apps/${appId}/grants`, {
        grants: [],
        denials: [{ memberId: otherMember!.id }],
      });
      const { listApps } = await import('../src/workspace-data/apps.js');
      const hidden = await listApps(manager.workspaceExecutor(orgId), orgId, {
        viewerMemberId: otherMember!.id,
        viewerRole: 'member',
      });
      expect(hidden.find((row) => row.id === appId)).toBeUndefined();
    });

    it('lets a restricted app through a team grant, then hides it with a denial', async () => {
      const other = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-team-peer',
        displayName: 'Kim',
        email: null,
      });
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const invite = await json('POST', `/api/orgs/${orgId}/invites`, {});
      await acceptOrgInvite(manager.directoryExecutor, invite.body.token, other.id);
      const otherMember = await getActiveMemberForUser(manager.directoryExecutor, orgId, other.id);

      const team = await json('POST', `/api/orgs/${orgId}/teams`, {
        name: 'Finance',
        memberIds: [otherMember!.id],
      });
      expect(team.status).toBe(201);
      expect(team.body.team.memberIds).toContain(otherMember!.id);

      const created = await json('POST', `/api/orgs/${orgId}/apps`, {
        name: 'Ledger',
        projectId: 'proj-1',
        filePath: 'ledger.html',
        accessMode: 'restricted',
        teamGrants: [{ teamId: team.body.team.id, role: 'view' }],
      });
      expect(created.status).toBe(201);
      const appId = created.body.app.id;

      const { listApps } = await import('../src/workspace-data/apps.js');
      const viaTeam = await listApps(manager.workspaceExecutor(orgId), orgId, {
        viewerMemberId: otherMember!.id,
        viewerRole: 'member',
        viewerTeamIds: [team.body.team.id],
      });
      expect(viaTeam.find((row) => row.id === appId)?.id).toBe(appId);

      await json('PUT', `/api/orgs/${orgId}/apps/${appId}/grants`, {
        grants: [],
        teamGrants: [{ teamId: team.body.team.id, role: 'view' }],
        denials: [{ memberId: otherMember!.id }],
      });
      const denied = await listApps(manager.workspaceExecutor(orgId), orgId, {
        viewerMemberId: otherMember!.id,
        viewerRole: 'member',
        viewerTeamIds: [team.body.team.id],
      });
      expect(denied.find((row) => row.id === appId)).toBeUndefined();
    });

    it('refuses GET of a private app for a non-creator', async () => {
      const app = await publishApp();
      await json('PATCH', `/api/orgs/${orgId}/apps/${app.id}`, { visibility: 'private' });
      const other = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-private-getter',
        displayName: 'Snoop',
        email: null,
      });
      const { acceptOrgInvite } = await import('../src/workspace-data/tenancy.js');
      const invite = await json('POST', `/api/orgs/${orgId}/invites`, {});
      await acceptOrgInvite(manager.directoryExecutor, invite.body.token, other.id);
      const { assertCanViewApp, getApp } = await import('../src/workspace-data/apps.js');
      const otherMember = await getActiveMemberForUser(manager.directoryExecutor, orgId, other.id);
      const found = await getApp(manager.workspaceExecutor(orgId), orgId, app.id);
      await expect(
        assertCanViewApp(manager.workspaceExecutor(orgId), orgId, found, {
          memberId: otherMember!.id,
          role: 'member',
        }),
      ).rejects.toMatchObject({ code: 'APP_FORBIDDEN' });
    });
  });

  describe('org teams', () => {
    it('creates a named team and replaces its members', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/teams`, { name: 'Finance' });
      expect(created.status).toBe(201);
      expect(created.body.team).toMatchObject({ name: 'Finance', slug: 'finance', memberIds: [] });

      const listed = await json('GET', `/api/orgs/${orgId}/teams`);
      expect(listed.body.teams.map((row: { name: string }) => row.name)).toContain('Finance');

      const owner = await getActiveMemberForUser(manager.directoryExecutor, orgId, LOCAL_OWNER_USER_ID);
      const patched = await json('PATCH', `/api/orgs/${orgId}/teams/${created.body.team.id}`, {
        memberIds: [owner!.id],
      });
      expect(patched.body.team.memberIds).toEqual([owner!.id]);
    });

    it('rejects an app grant for a team that does not exist', async () => {
      const created = await json('POST', `/api/orgs/${orgId}/apps`, {
        name: 'Ledger',
        projectId: 'proj-1',
        filePath: 'ledger.html',
        accessMode: 'restricted',
      });
      const denied = await json('PUT', `/api/orgs/${orgId}/apps/${created.body.app.id}/grants`, {
        grants: [],
        teamGrants: [{ teamId: 'team-missing', role: 'view' }],
      });
      expect(denied.status).toBe(404);
      expect(denied.body.error.code).toBe('ORG_TEAM_NOT_FOUND');
    });
  });

  describe('profile username', () => {
    it('lets the signed-in person claim a unique public handle', async () => {
      const patched = await json('PATCH', '/api/me', { username: 'Jane' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        userId: LOCAL_OWNER_USER_ID,
        username: 'jane',
      });

      const context = await json('GET', '/api/auth/context');
      expect(context.body.viewer.username).toBe('jane');

      const lookedUp = await json('GET', '/api/users/Jane');
      expect(lookedUp.status).toBe(200);
      expect(lookedUp.body).toMatchObject({
        userId: LOCAL_OWNER_USER_ID,
        username: 'jane',
      });
      expect(lookedUp.body).not.toHaveProperty('email');

      const missing = await json('GET', '/api/users/nope');
      expect(missing.status).toBe(404);

      const tooShort = await json('PATCH', '/api/me', { username: 'a' });
      expect(tooShort.status).toBe(422);

      const reserved = await json('PATCH', '/api/me', { username: 'me' });
      expect(reserved.status).toBe(422);

      const members = await json('GET', `/api/orgs/${orgId}/members`);
      expect(members.body.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: LOCAL_OWNER_USER_ID, username: 'jane' }),
        ]),
      );

      const other = await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-other-handle',
        displayName: 'Other',
        email: 'other@co.com',
      });
      await expect(setUserUsername(manager.directoryExecutor, other.id, 'jane')).rejects.toMatchObject({
        code: 'USERNAME_TAKEN',
      });
    });

    it('lets the signed-in person set a name, bio, and photo', async () => {
      const patched = await json('PATCH', '/api/me', {
        displayName: 'Ada Lovelace',
        bio: 'Builds things',
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        userId: LOCAL_OWNER_USER_ID,
        displayName: 'Ada Lovelace',
        bio: 'Builds things',
      });

      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const form = new FormData();
      form.append('file', new Blob([png], { type: 'image/png' }), 'me.png');
      const put = await fetch(`${base}/api/me/avatar`, { method: 'PUT', body: form });
      expect(put.status).toBe(200);
      const profile = (await put.json()) as { avatarUrl: string };
      expect(profile.avatarUrl).toMatch(/\/api\/users\/.+\/avatar/);

      const got = await fetch(`${base}${profile.avatarUrl}`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);
    });

    it('does not bind an invite to a person by display name', async () => {
      await upsertExternalUser(manager.directoryExecutor, {
        externalId: 'ext-jordan',
        displayName: 'Jordan Lee',
        email: 'jordan@co.com',
        username: 'jlee',
      });
      const created = await json('POST', `/api/orgs/${orgId}/invites`, { username: 'jordanlee' });
      expect(created.status).toBe(201);
      expect(created.body.invite).toMatchObject({
        kind: 'username',
        targetUsername: 'jordanlee',
        targetUserId: null,
      });
    });
  });
});

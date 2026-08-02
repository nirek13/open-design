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

      // Accepting as the local owner is a no-op: they are already a member,
      // and re-opening a link must not burn a use.
      const accepted = await json('POST', `/api/invites/${created.body.token}/accept`);
      expect(accepted.status).toBe(200);
      const invites = await json('GET', `/api/orgs/${orgId}/invites`);
      expect(invites.body.invites[0].useCount).toBe(0);
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

    it('stops serving an archived app even with a live link', async () => {
      const app = await publishApp();
      const shared = await json('POST', `/api/orgs/${orgId}/apps/${app.id}/shares`);
      await json('PATCH', `/api/orgs/${orgId}/apps/${app.id}`, { status: 'archived' });
      const page = await fetch(`${base}/s/${shared.body.token}`);
      expect(page.status).toBe(404);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { parseSearchQuery, searchOrganization } from '../src/workspace-data/org-search.js';
import { createPage } from '../src/workspace-data/pages.js';
import {
  acceptOrgInvite,
  createOrgInvite,
  ensureDefaultOrganization,
  getActiveMemberForUser,
  listOrgMembers,
  updateOrgMember,
  upsertExternalUser,
} from '../src/workspace-data/tenancy.js';
import { LOCAL_OWNER_USER_ID } from '@open-design/contracts';

describe('parseSearchQuery', () => {
  it('drops stopwords and keeps kind hints', () => {
    const parsed = parseSearchQuery("find Jane's onboarding page please");
    expect(parsed.tokens).toEqual(['jane', 'onboarding', 'page']);
    expect(parsed.kindHints).toContain('page');
  });

  it('keeps the whole phrase when nothing survives stopword stripping', () => {
    const parsed = parseSearchQuery('the a');
    expect(parsed.tokens.length).toBeGreaterThan(0);
  });
});

describe('organization search scope', () => {
  let tempDir = '';
  let manager: WorkspaceDbManager | undefined;
  let projectsDb: ReturnType<typeof openDatabase> | undefined;
  let orgId = '';
  let ownerId = '';
  let managerId = '';
  let reportId = '';
  let peerId = '';

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-org-search-'));
    projectsDb = openDatabase(tempDir, { dataDir: tempDir });
    const mgr = new WorkspaceDbManager(tempDir);
    manager = mgr;
    orgId = (await ensureDefaultOrganization(mgr.directoryExecutor)).id;
    const owner = await getActiveMemberForUser(mgr.directoryExecutor, orgId, LOCAL_OWNER_USER_ID);
    ownerId = owner!.id;

    async function addMember(name: string, reportsTo: string) {
      const created = await createOrgInvite(mgr.directoryExecutor, orgId, ownerId, {
        role: 'member',
        maxUses: 1,
      });
      const user = await upsertExternalUser(mgr.directoryExecutor, {
        externalId: `ext-${name}`,
        displayName: name,
        email: null,
      });
      const accepted = await acceptOrgInvite(mgr.directoryExecutor, created.token, user.id);
      await updateOrgMember(mgr.directoryExecutor, orgId, accepted.member.id, { reportsTo });
      return accepted.member.id;
    }

    managerId = await addMember('Manager', ownerId);
    reportId = await addMember('Report', managerId);
    peerId = await addMember('Peer', ownerId);

    const db = mgr.workspaceExecutor(orgId);
    await createPage(db, orgId, ownerId, { title: 'Owner handbook' });
    await createPage(db, orgId, managerId, { title: 'Manager notes' });
    await createPage(db, orgId, reportId, { title: 'Report checklist' });
    await createPage(db, orgId, peerId, { title: 'Peer secret' });

    const now = Date.now();
    insertProject(projectsDb, {
      id: 'proj-report',
      name: 'Onboarding deck',
      orgId,
      createdBy: reportId,
      createdAt: now,
      updatedAt: now,
    });
    insertProject(projectsDb, {
      id: 'proj-peer',
      name: 'Peer prototype',
      orgId,
      createdBy: peerId,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(() => {
    manager?.closeAll();
    closeDatabase();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  async function searchAs(memberId: string, query: string) {
    if (!manager || !projectsDb) throw new Error('search fixture not initialized');
    const members = await listOrgMembers(manager.directoryExecutor, orgId);
    const member = members.find((row) => row.id === memberId)!;
    return searchOrganization({
      manager,
      projectsDb,
      projectsRoot: path.join(tempDir, 'projects'),
      orgId,
      viewer: { memberId, userId: member.userId, role: member.role },
      query,
    });
  }

  it('lets someone see work from people above and below them, not peers', async () => {
    const asManager = await searchAs(managerId, 'secret handbook checklist notes');
    const titles = asManager.map((hit) => hit.title);
    expect(titles).toContain('Owner handbook');
    expect(titles).toContain('Manager notes');
    expect(titles).toContain('Report checklist');
    expect(titles).not.toContain('Peer secret');

    const asPeer = await searchAs(peerId, 'secret handbook checklist notes');
    const peerTitles = asPeer.map((hit) => hit.title);
    expect(peerTitles).toContain('Peer secret');
    expect(peerTitles).toContain('Owner handbook');
    expect(peerTitles).not.toContain('Manager notes');
    expect(peerTitles).not.toContain('Report checklist');
  });

  it('scopes project files to the same reporting chain', async () => {
    const asManager = await searchAs(managerId, 'onboarding deck');
    expect(asManager.some((hit) => hit.kind === 'project' && hit.title === 'Onboarding deck')).toBe(true);
    expect(asManager.some((hit) => hit.title === 'Peer prototype')).toBe(false);

    const asPeer = await searchAs(peerId, 'prototype deck');
    expect(asPeer.some((hit) => hit.title === 'Peer prototype')).toBe(true);
    expect(asPeer.some((hit) => hit.title === 'Onboarding deck')).toBe(false);
  });

  it('refuses a reporting cycle', async () => {
    if (!manager) throw new Error('search fixture not initialized');
    await expect(
      updateOrgMember(manager.directoryExecutor, orgId, ownerId, { reportsTo: reportId }),
    ).rejects.toThrow(/cycle/);
  });
});

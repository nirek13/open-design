import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IdentityService } from '../src/auth/identity.js';
import { closeDatabase, insertProject, openDatabase } from '../src/db.js';
import { registerPagesRoutes } from '../src/routes/pages.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { createPage, getPage } from '../src/workspace-data/pages.js';
import {
  createOrganization,
  ensureDefaultOrganization,
  upsertExternalUser,
} from '../src/workspace-data/tenancy.js';

const TEST_TOOL_TOKEN = 'test-tool-token';

describe('pages tool routes', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let projectsDb: ReturnType<typeof openDatabase>;
  let server: ReturnType<express.Express['listen']> | null = null;
  let base = '';
  let localOrgId = '';
  let notesOrgId = '';
  let pageId = '';
  let grant = { runId: 'run-wiki', projectId: 'proj-wiki' };

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-pages-routes-'));
    projectsDb = openDatabase(tempDir, { dataDir: tempDir });
    manager = new WorkspaceDbManager(tempDir);
    localOrgId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;
    grant = { runId: 'run-wiki', projectId: 'proj-wiki' };

    const clerkUser = await upsertExternalUser(manager.directoryExecutor, {
      externalId: 'user_notes_owner',
      displayName: 'Notes Owner',
      email: null,
    });
    notesOrgId = (await createOrganization(manager.directoryExecutor, {
      name: 'Notes Co',
      ownerUserId: clerkUser.id,
    })).id;

    const page = await createPage(manager.workspaceExecutor(notesOrgId), notesOrgId, 'member-notes', {
      title: 'Handbook',
      blocks: [{ type: 'paragraph', content: 'Welcome' }],
    });
    pageId = page.id;

    const now = Date.now();
    insertProject(projectsDb, {
      id: 'proj-wiki',
      name: 'Wiki chat',
      orgId: notesOrgId,
      createdAt: now,
      updatedAt: now,
    });

    const app = express();
    app.use(express.json());
    registerPagesRoutes(app, {
      db: projectsDb,
      auth: {
        authorizeToolRequest: (req: express.Request, res: express.Response) => {
          const header = req.get('authorization');
          if (header === `Bearer ${TEST_TOOL_TOKEN}`) return grant;
          res.status(401).json({ error: { code: 'TOOL_TOKEN_MISSING', message: 'missing token' } });
          return null;
        },
      },
      pages: {
        manager,
        identity: new IdentityService({ mode: 'local-owner', issuer: null, publishableKey: null }),
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
    manager?.closeAll();
    closeDatabase();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  async function tool(verb: string, body: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}/api/tools/pages/${verb}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOOL_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  it('embeds into the chat project org, not the local-owner fallback org', async () => {
    const listed = await tool('list', { tree: true });
    expect(listed.status).toBe(200);
    expect(listed.body.orgId).toBe(notesOrgId);
    expect(listed.body.orgId).not.toBe(localOrgId);

    const embedded = await tool('embed', {
      pageId,
      type: 'embed',
      url: '/api/projects/proj-wiki/raw/hero.png',
    });
    expect(embedded.status).toBe(200);
    expect(embedded.body.page?.id).toBe(pageId);
    expect(embedded.body.page?.blocks.at(-1)).toMatchObject({
      type: 'embed',
      props: { url: '/api/projects/proj-wiki/raw/hero.png' },
    });

    const saved = await getPage(manager.workspaceExecutor(notesOrgId), notesOrgId, pageId);
    expect(saved.blocks.at(-1)?.props.url).toBe('/api/projects/proj-wiki/raw/hero.png');
  });

  it('falls back to metadata.workspaceId when the project has no org_id', async () => {
    const now = Date.now();
    insertProject(projectsDb, {
      id: 'proj-meta',
      name: 'Wiki chat meta',
      metadata: { workspaceId: notesOrgId },
      createdAt: now,
      updatedAt: now,
    });
    grant = { runId: 'run-meta', projectId: 'proj-meta' };

    const embedded = await tool('embed', {
      pageId,
      type: 'embed',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    expect(embedded.status).toBe(200);
    expect(embedded.body.page?.blocks.at(-1)).toMatchObject({
      type: 'embed',
      props: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
  });
});

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDatabase, openDatabase } from '../src/db.js';
import { registerWorkspaceDataRoutes } from '../src/routes/workspace-data.js';
import { WorkspaceDbManager } from '../src/storage/workspace-db.js';
import { WorkspaceDataEvents } from '../src/workspace-data/events.js';
import { ensureDefaultOrganization } from '../src/workspace-data/tenancy.js';
import { IdentityService } from '../src/auth/identity.js';

const TEST_TOOL_TOKEN = 'test-tool-token';
const TEST_GRANT = { runId: 'run-test', projectId: 'proj-test' };

describe('workspace data routes', () => {
  let tempDir: string;
  let manager: WorkspaceDbManager;
  let server: ReturnType<express.Express['listen']> | null = null;
  let base = '';
  let workspaceId = '';

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-workspace-routes-'));
    const db = openDatabase(tempDir, { dataDir: tempDir });
    manager = new WorkspaceDbManager(tempDir);
    workspaceId = (await ensureDefaultOrganization(manager.directoryExecutor)).id;

    const app = express();
    app.use(express.json());
    registerWorkspaceDataRoutes(app, {
      db,
      auth: {
        authorizeToolRequest: (req: express.Request, res: express.Response) => {
          const header = req.get('authorization');
          if (header === `Bearer ${TEST_TOOL_TOKEN}`) return TEST_GRANT;
          res.status(401).json({ error: { code: 'TOOL_TOKEN_MISSING', message: 'missing token' } });
          return null;
        },
      },
      workspaceData: {
        manager,
        events: new WorkspaceDataEvents(),
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
    manager.closeAll();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function json(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  async function createEmployeesTable() {
    const { status, body } = await json('POST', `/api/data/orgs/${workspaceId}/tables`, {
      name: 'employees',
      fields: [
        { name: 'full_name', type: 'text', required: true },
        { name: 'email', type: 'text', required: true, unique: true },
      ],
    });
    expect(status).toBe(201);
    return body.table;
  }

  it('lets an admin open a table to public form submissions', async () => {
    const table = await createEmployeesTable();
    expect(table.publicWrite).toBe(false);

    const opened = await json('PATCH', `/api/data/orgs/${workspaceId}/tables/employees`, {
      publicWrite: true,
    });
    expect(opened.status).toBe(200);
    expect(opened.body.table.publicWrite).toBe(true);

    const closed = await json('PATCH', `/api/data/orgs/${workspaceId}/tables/employees`, {
      publicWrite: false,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.table.publicWrite).toBe(false);
  });

  it('runs the record lifecycle over HTTP with audit and revisions', async () => {
    const table = await createEmployeesTable();

    const created = await json('POST', `/api/data/orgs/${workspaceId}/tables/employees/records`, {
      data: { full_name: 'Ada', email: 'ada@co.com' },
    });
    expect(created.status).toBe(201);
    const recordId = created.body.record.id;

    const updated = await json('PATCH', `/api/data/orgs/${workspaceId}/records/${recordId}`, {
      data: { full_name: 'Ada L.' },
      expectedRevision: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.record.revision).toBe(2);

    const conflict = await json('PATCH', `/api/data/orgs/${workspaceId}/records/${recordId}`, {
      data: { full_name: 'Stale' },
      expectedRevision: 1,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('WORKSPACE_REVISION_CONFLICT');

    const deleted = await json('POST', `/api/data/orgs/${workspaceId}/records/${recordId}/soft-delete`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.record.deletedAt).not.toBeNull();

    const restored = await json('POST', `/api/data/orgs/${workspaceId}/records/${recordId}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.record.deletedAt).toBeNull();

    const revisions = await json('GET', `/api/data/orgs/${workspaceId}/records/${recordId}/revisions`);
    expect(revisions.body.revisions.map((revision: any) => revision.op)).toEqual([
      'create',
      'update',
      'soft-delete',
      'restore',
    ]);

    const audit = await json('GET', `/api/data/orgs/${workspaceId}/audit?tableId=${table.id}`);
    expect(audit.body.events.length).toBeGreaterThanOrEqual(5); // table.create + 4 record ops
    expect(audit.body.events.every((event: any) => event.actorKind === 'user')).toBe(true);
  });

  it('returns the modern error envelope for validation failures', async () => {
    await createEmployeesTable();
    const bad = await json('POST', `/api/data/orgs/${workspaceId}/tables/employees/records`, {
      data: { email: 'missing-name@co.com' },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('WORKSPACE_VALIDATION_FAILED');
    expect(bad.body.error.details.issues[0].path).toBe('data.full_name');
  });

  it('404s unknown organizations and tables', async () => {
    const noWorkspace = await json('GET', '/api/data/orgs/ws-none/tables');
    expect(noWorkspace.status).toBe(404);
    expect(noWorkspace.body.error.code).toBe('ORG_NOT_FOUND');

    const noTable = await json('GET', `/api/data/orgs/${workspaceId}/tables/nope`);
    expect(noTable.status).toBe(404);
    expect(noTable.body.error.code).toBe('WORKSPACE_TABLE_NOT_FOUND');
  });

  describe('agent tool endpoints', () => {
    const authed = { authorization: `Bearer ${TEST_TOOL_TOKEN}` };

    it('rejects calls without a tool token', async () => {
      const denied = await json('POST', '/api/tools/data/list-tables', {});
      expect(denied.status).toBe(401);
    });

    it('creates tables, inserts, and queries with agent attribution', async () => {
      const createdTable = await json(
        'POST',
        '/api/tools/data/create-table',
        {
          name: 'expenses',
          fields: [
            { name: 'label', type: 'text', required: true },
            { name: 'amount', type: 'money' },
          ],
        },
        authed,
      );
      expect(createdTable.status).toBe(201);

      const inserted = await json(
        'POST',
        '/api/tools/data/insert',
        { table: 'expenses', data: { label: 'Team lunch', amount: 42_00 } },
        authed,
      );
      expect(inserted.status).toBe(201);
      expect(inserted.body.record.createdByKind).toBe('agent');

      const queried = await json('POST', '/api/tools/data/query', { table: 'expenses' }, authed);
      expect(queried.status).toBe(200);
      expect(queried.body.records).toHaveLength(1);

      // Agent writes are attributed to the run in the audit trail.
      const audit = await json('GET', `/api/data/orgs/${workspaceId}/audit`);
      const agentEvents = audit.body.events.filter((event: any) => event.actorKind === 'agent');
      expect(agentEvents.length).toBeGreaterThanOrEqual(2);
      expect(agentEvents[0].runId).toBe(TEST_GRANT.runId);
    });
  });
});

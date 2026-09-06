// HTTP surface for the organization's permanent database. Two families:
//
// - /api/data/orgs/:orgId/*  interactive surface (web UI + `od data` CLI).
//   Every request resolves the caller through the identity layer and must be
//   an active member of the target organization.
// - /api/tools/data/*        agent-facing surface, gated by per-run tool
//   tokens. Agent writes are attributed actor_kind='agent' with the
//   run/project ids taken from the grant — never from the request body.

import type { Express, Request as ExpressRequest, Response } from 'express';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';
import {
  createApiError,
  type CreateWorkspaceRecordRequest,
  type CreateWorkspaceTableRequest,
  type QueryWorkspaceRecordsRequest,
  type UpdateWorkspaceRecordRequest,
  type UpdateWorkspaceTableRequest,
} from '@open-design/contracts';
import { getProject } from '../db.js';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError, workspaceValidationError } from '../workspace-data/errors.js';
import type { WorkspaceDataEvents } from '../workspace-data/events.js';
import { listAuditEvents } from '../workspace-data/audit.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
  listOrganizations,
} from '../workspace-data/tenancy.js';
import { createTable, listTables, resolveTable, loadTable, setTablePublicWrite } from '../workspace-data/schema.js';
import {
  createRecord,
  getRecord,
  listRecordRevisions,
  restoreRecord,
  softDeleteRecord,
  updateRecord,
} from '../workspace-data/records.js';
import { queryRecords } from '../workspace-data/query.js';
import { buildImportPlan, commitImport } from '../workspace-data/import.js';
import { fetchImportSource } from '../workspace-data/import-url.js';
import type { WorkspaceActor } from '../workspace-data/types.js';

export interface WorkspaceDataRouteServices {
  manager: WorkspaceDbManager;
  events: WorkspaceDataEvents;
  identity: IdentityService;
}

export interface RegisterWorkspaceDataRoutesDeps extends RouteDeps<'db' | 'auth'> {
  workspaceData: WorkspaceDataRouteServices;
}

function handleWorkspaceDataError(res: Response, err: unknown): void {
  if (err instanceof WorkspaceDataError) {
    sendApiError(
      res,
      err.status,
      createApiError(err.code, err.message, err.details === undefined ? {} : { details: err.details }),
    );
    return;
  }
  sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as any)?.message ?? err)));
}

export function registerWorkspaceDataRoutes(app: Express, ctx: RegisterWorkspaceDataRoutesDeps) {
  const { manager, events, identity } = ctx.workspaceData;
  const { authorizeToolRequest } = ctx.auth;
  const appDb = ctx.db;

  const directory = () => manager.directoryExecutor;

  const handle =
    (fn: (req: Request, res: Response) => void | Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        handleWorkspaceDataError(res, err);
      }
    };

  /** Resolve the caller and confirm they are an active member of the target
   * organization before any table or record is touched. In local-owner mode
   * this always succeeds, but the same path runs in both modes so the guard
   * cannot rot. */
  async function scope(req: Request) {
    const orgId = param(req, 'orgId');
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) {
      throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    }
    await getOrganization(directory(), orgId);
    const member = assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      'member',
      orgId,
    );
    return {
      orgId,
      db: manager.openWorkspace(orgId),
      actor: { kind: 'user', memberId: member.id } as WorkspaceActor,
    };
  }

  // --- Schema --------------------------------------------------------------

  app.get('/api/data/orgs/:orgId/tables', handle(async (req, res) => {
    const { db } = await scope(req);
    res.json({ tables: listTables(db, { includeArchived: req.query.includeArchived === '1' }) });
  }));

  app.post('/api/data/orgs/:orgId/tables', handle(async (req, res) => {
    const { db, actor } = await scope(req);
    const table = createTable(db, (req.body ?? {}) as CreateWorkspaceTableRequest, actor);
    res.status(201).json({ table });
  }));

  app.get('/api/data/orgs/:orgId/tables/:tableRef', handle(async (req, res) => {
    const { db } = await scope(req);
    res.json({ table: resolveTable(db, param(req, 'tableRef')) });
  }));

  app.patch('/api/data/orgs/:orgId/tables/:tableRef', handle(async (req, res) => {
    const orgId = param(req, 'orgId');
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) {
      throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    }
    await getOrganization(directory(), orgId);
    const member = assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      'admin',
      orgId,
    );
    const db = manager.openWorkspace(orgId);
    const table = resolveTable(db, param(req, 'tableRef'));
    const body = (req.body ?? {}) as UpdateWorkspaceTableRequest;
    if (typeof body.publicWrite !== 'boolean') {
      throw workspaceValidationError([
        { path: 'publicWrite', message: 'publicWrite must be true or false' },
      ]);
    }
    const next = setTablePublicWrite(
      db,
      table,
      { kind: 'user', memberId: member.id },
      body.publicWrite,
    );
    res.json({ table: next });
  }));

  // --- Records -------------------------------------------------------------

  app.post('/api/data/orgs/:orgId/tables/:tableRef/records/query', handle(async (req, res) => {
    const { db } = await scope(req);
    const table = resolveTable(db, param(req, 'tableRef'));
    const page = queryRecords(db, table, (req.body ?? {}) as QueryWorkspaceRecordsRequest);
    res.json({ records: page.records, nextCursor: page.nextCursor });
  }));

  app.post('/api/data/orgs/:orgId/tables/:tableRef/records', handle(async (req, res) => {
    const { orgId, db, actor } = await scope(req);
    const table = resolveTable(db, param(req, 'tableRef'));
    const body = (req.body ?? {}) as CreateWorkspaceRecordRequest;
    const record = createRecord(db, table, actor, body.data ?? ({} as any));
    events.emitRecordChange({ workspaceId: orgId, tableId: table.id, recordId: record.id, op: 'create' });
    res.status(201).json({ record });
  }));

  app.patch('/api/data/orgs/:orgId/records/:recordId', handle(async (req, res) => {
    const { orgId, db, actor } = await scope(req);
    const existing = getRecord(db, param(req, 'recordId'));
    const table = loadTable(db, existing.tableId);
    const body = (req.body ?? {}) as UpdateWorkspaceRecordRequest;
    const record = updateRecord(db, table, actor, param(req, 'recordId'), body.data ?? ({} as any), body.expectedRevision);
    events.emitRecordChange({ workspaceId: orgId, tableId: table.id, recordId: record.id, op: 'update' });
    res.json({ record });
  }));

  app.post('/api/data/orgs/:orgId/records/:recordId/soft-delete', handle(async (req, res) => {
    const { orgId, db, actor } = await scope(req);
    const existing = getRecord(db, param(req, 'recordId'));
    const table = loadTable(db, existing.tableId);
    const record = softDeleteRecord(db, table, actor, param(req, 'recordId'));
    events.emitRecordChange({ workspaceId: orgId, tableId: table.id, recordId: record.id, op: 'soft-delete' });
    res.json({ record });
  }));

  app.post('/api/data/orgs/:orgId/records/:recordId/restore', handle(async (req, res) => {
    const { orgId, db, actor } = await scope(req);
    const existing = getRecord(db, param(req, 'recordId'));
    const table = loadTable(db, existing.tableId);
    const record = restoreRecord(db, table, actor, param(req, 'recordId'));
    events.emitRecordChange({ workspaceId: orgId, tableId: table.id, recordId: record.id, op: 'restore' });
    res.json({ record });
  }));

  app.get('/api/data/orgs/:orgId/records/:recordId/revisions', handle(async (req, res) => {
    const { db } = await scope(req);
    res.json({ revisions: listRecordRevisions(db, param(req, 'recordId')) });
  }));

  // --- Audit ---------------------------------------------------------------

  app.get('/api/data/orgs/:orgId/audit', handle(async (req, res) => {
    const { db } = await scope(req);
    const page = listAuditEvents(db, {
      tableId: typeof req.query.tableId === 'string' ? req.query.tableId : undefined,
      subjectId: typeof req.query.subjectId === 'string' ? req.query.subjectId : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    });
    res.json({ events: page.events, nextCursor: page.nextCursor });
  }));

  // --- Live updates --------------------------------------------------------

  app.get('/api/data/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const unsubscribe = events.onRecordChange((payload) => {
      res.write(`event: record-change\ndata: ${JSON.stringify(payload)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 30_000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- Agent-facing tool endpoints ----------------------------------------

  /** Workspace scope for an agent call comes from the grant's project (its
   * metadata may pin a workspace), falling back to the first workspace.
   * Never from the request body. */
  async function workspaceForGrant(grant: { projectId: string }): Promise<string> {
    try {
      const metadata = getProject(appDb, grant.projectId)?.metadata;
      const pinned = (metadata as any)?.workspaceId;
      if (typeof pinned === 'string' && pinned) {
        await getOrganization(directory(), pinned);
        return pinned;
      }
    } catch {
      // fall through to default
    }
    const first = (await listOrganizations(directory()))[0];
    if (!first) {
      throw new WorkspaceDataError('ORG_NOT_FOUND', 404, 'no organization exists');
    }
    return first.id;
  }

  function agentActor(grant: { runId: string; projectId: string }): WorkspaceActor {
    return { kind: 'agent', runId: grant.runId, projectId: grant.projectId };
  }

  const toolHandle = (
    operation: string,
    fn: (
      req: Request,
      res: Response,
      scope: { db: ReturnType<WorkspaceDbManager['openWorkspace']>; workspaceId: string; actor: WorkspaceActor },
    ) => void | Promise<void>,
  ) =>
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, operation);
      if (!grant) return;
      const workspaceId = await workspaceForGrant(grant);
      await fn(req, res, { db: manager.openWorkspace(workspaceId), workspaceId, actor: agentActor(grant) });
    });

  app.post('/api/tools/data/list-tables', toolHandle('data:list-tables', (_req, res, scope) => {
    res.json({ tables: listTables(scope.db) });
  }));

  app.post('/api/tools/data/describe-table', toolHandle('data:describe-table', (req, res, scope) => {
    const ref = typeof req.body?.table === 'string' ? req.body.table : '';
    res.json({ table: resolveTable(scope.db, ref) });
  }));

  app.post('/api/tools/data/create-table', toolHandle('data:create-table', (req, res, scope) => {
    const table = createTable(scope.db, (req.body ?? {}) as CreateWorkspaceTableRequest, scope.actor);
    res.status(201).json({ table });
  }));

  app.post('/api/tools/data/query', toolHandle('data:query', (req, res, scope) => {
    const ref = typeof req.body?.table === 'string' ? req.body.table : '';
    const table = resolveTable(scope.db, ref);
    const page = queryRecords(scope.db, table, (req.body ?? {}) as QueryWorkspaceRecordsRequest);
    res.json({ records: page.records, nextCursor: page.nextCursor });
  }));

  app.post('/api/tools/data/insert', toolHandle('data:insert', (req, res, scope) => {
    const ref = typeof req.body?.table === 'string' ? req.body.table : '';
    const table = resolveTable(scope.db, ref);
    const record = createRecord(scope.db, table, scope.actor, req.body?.data ?? {});
    events.emitRecordChange({ workspaceId: scope.workspaceId, tableId: table.id, recordId: record.id, op: 'create' });
    res.status(201).json({ record });
  }));

  app.post('/api/tools/data/update', toolHandle('data:update', (req, res, scope) => {
    const ref = typeof req.body?.table === 'string' ? req.body.table : '';
    const table = resolveTable(scope.db, ref);
    const recordId = typeof req.body?.recordId === 'string' ? req.body.recordId : '';
    const record = updateRecord(
      scope.db,
      table,
      scope.actor,
      recordId,
      req.body?.data ?? {},
      typeof req.body?.expectedRevision === 'number' ? req.body.expectedRevision : undefined,
    );
    events.emitRecordChange({ workspaceId: scope.workspaceId, tableId: table.id, recordId: record.id, op: 'update' });
    res.json({ record });
  }));

  app.post('/api/tools/data/import-url', toolHandle('data:import-url', async (req, res, scope) => {
    const url = String(req.body?.url ?? '').trim();
    if (!url) throw new WorkspaceDataError('BAD_REQUEST', 400, 'pass the link to import');
    const source = await fetchImportSource(url);
    const plan = buildImportPlan(scope.db, {
      content: source.content,
      fileName: source.fileName,
      sourceUrl: source.url,
      ...(req.body?.tableName ? { tableName: String(req.body.tableName) } : {}),
    });
    const sourceMeta = {
      url: source.url,
      finalUrl: source.finalUrl,
      kind: source.kind,
      fileName: source.fileName,
    };
    if (req.body?.commit === false) {
      res.json({ source: sourceMeta, plan, content: source.content });
      return;
    }
    const result = commitImport(scope.db, scope.actor, plan, source.content);
    res.status(201).json({ source: sourceMeta, plan, ...result });
  }));
}

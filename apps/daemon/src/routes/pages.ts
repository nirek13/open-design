// Organization pages over HTTP — nested notes with typed blocks.
//
// Same membership scoping as team chat and ERP. Agents use /api/tools/pages/*
// with a chat tool token; people use /api/orgs/:orgId/pages/*.

import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  createApiError,
  type AppendPageBlocksRequest,
  type CreatePageRequest,
  type DuplicatePageRequest,
  type EmbedPageBlockRequest,
  type ScaffoldPagesRequest,
  type SetPageBlocksRequest,
  type UpdatePageRequest,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
  listOrganizationsForUser,
} from '../workspace-data/tenancy.js';
import {
  appendPageBlocks,
  archivePage,
  createPage,
  duplicatePage,
  embedInPage,
  ensurePageForRecord,
  findPageByLinkedRecord,
  getPage,
  getPageTree,
  listPages,
  scaffoldPages,
  searchPages,
  setPageBlocks,
  updatePage,
  upsertPageFromAgent,
} from '../workspace-data/pages.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface PagesRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
}

export interface RegisterPagesRoutesDeps extends RouteDeps<'db' | 'auth'> {
  pages: PagesRouteServices;
}

export function registerPagesRoutes(app: Express, ctx: RegisterPagesRoutesDeps) {
  const { manager, identity } = ctx.pages;
  const { authorizeToolRequest } = ctx.auth;
  const directory = () => manager.directoryExecutor;

  function fail(res: Response, err: unknown): void {
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

  const handle =
    (fn: (req: Request, res: Response) => void | Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (err) {
        fail(res, err);
      }
    };

  async function scope(req: Request, minimum: 'member' | 'admin' | 'owner' = 'member') {
    const orgId = param(req, 'orgId');
    const viewer = await identity.resolveViewer(req, directory());
    if (!viewer) throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
    await getOrganization(directory(), orgId);
    const member = assertMemberRole(
      await getActiveMemberForUser(directory(), orgId, viewer.userId),
      minimum,
      orgId,
    );
    return { orgId, member, db: manager.workspaceExecutor(orgId) };
  }

  app.get(
    '/api/orgs/:orgId/pages',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const parent = typeof req.query.parentPageId === 'string' ? req.query.parentPageId : undefined;
      const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
      const tree = req.query.tree === '1' || req.query.tree === 'true';
      if (tree) {
        res.json({ tree: await getPageTree(db, orgId) });
        return;
      }
      res.json({
        pages: await listPages(db, orgId, {
          ...(parent !== undefined ? { parentPageId: parent } : {}),
          includeArchived,
        }),
      });
    }),
  );

  app.get(
    '/api/orgs/:orgId/pages/search',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const q = typeof req.query.q === 'string' ? req.query.q : typeof req.query.query === 'string' ? req.query.query : '';
      const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 25;
      res.json({ hits: await searchPages(db, orgId, q, Number.isFinite(limit) ? limit : 25) });
    }),
  );

  app.post(
    '/api/orgs/:orgId/pages/scaffold',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const result = await scaffoldPages(db, orgId, member.id, (req.body ?? {}) as ScaffoldPagesRequest);
      res.status(201).json(result);
    }),
  );

  app.get(
    '/api/orgs/:orgId/pages/:pageId',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      res.json({ page: await getPage(db, orgId, param(req, 'pageId')) });
    }),
  );

  app.post(
    '/api/orgs/:orgId/pages',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const body = (req.body ?? {}) as CreatePageRequest;
      const page = await createPage(db, orgId, member.id, body);
      res.status(201).json({ page });
    }),
  );

  app.patch(
    '/api/orgs/:orgId/pages/:pageId',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const page = await updatePage(db, orgId, param(req, 'pageId'), (req.body ?? {}) as UpdatePageRequest);
      res.json({ page });
    }),
  );

  app.put(
    '/api/orgs/:orgId/pages/:pageId/blocks',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const page = await setPageBlocks(
        db,
        orgId,
        param(req, 'pageId'),
        (req.body ?? {}) as SetPageBlocksRequest,
      );
      res.json({ page });
    }),
  );

  app.post(
    '/api/orgs/:orgId/pages/:pageId/archive',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const page = await archivePage(db, orgId, param(req, 'pageId'));
      res.json({ page });
    }),
  );

  app.post(
    '/api/orgs/:orgId/pages/:pageId/blocks/append',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const page = await appendPageBlocks(
        db,
        orgId,
        param(req, 'pageId'),
        (req.body ?? {}) as AppendPageBlocksRequest,
      );
      res.json({ page });
    }),
  );

  app.post(
    '/api/orgs/:orgId/pages/:pageId/embed',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const page = await embedInPage(
        db,
        orgId,
        param(req, 'pageId'),
        (req.body ?? {}) as EmbedPageBlockRequest,
      );
      res.json({ page });
    }),
  );

  app.post(
    '/api/orgs/:orgId/pages/:pageId/duplicate',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const page = await duplicatePage(
        db,
        orgId,
        member.id,
        param(req, 'pageId'),
        (req.body ?? {}) as DuplicatePageRequest,
      );
      res.status(201).json({ page });
    }),
  );

  /** Open or create the notes page linked to an ERP record. */
  app.post(
    '/api/orgs/:orgId/pages/for-record',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const recordId = String(req.body?.recordId ?? '');
      const tableId = String(req.body?.tableId ?? '');
      const title = String(req.body?.title ?? 'Untitled').trim() || 'Untitled';
      if (!recordId || !tableId) {
        throw new WorkspaceDataError('BAD_REQUEST', 400, 'recordId and tableId are required');
      }
      const page = await ensurePageForRecord(db, orgId, member.id, {
        recordId,
        tableId,
        title,
        tableName: typeof req.body?.tableName === 'string' ? req.body.tableName : undefined,
      });
      res.status(201).json({ page });
    }),
  );

  app.get(
    '/api/orgs/:orgId/pages/by-record/:recordId',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const page = await findPageByLinkedRecord(db, orgId, param(req, 'recordId'));
      res.json({ page });
    }),
  );

  // --- Agent tools --------------------------------------------------------

  app.post(
    '/api/tools/pages/list',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:list');
      if (!grant) return;
      const orgs = await listOrganizationsForUser(directory(), 'user-local-owner');
      const orgId = (req.body?.orgId as string) || orgs[0]?.id;
      if (!orgId) throw new WorkspaceDataError('ORG_NOT_FOUND', 404, 'no organization to act in');
      const db = manager.workspaceExecutor(orgId);
      const tree = req.body?.tree === true;
      if (tree) {
        res.json({ orgId, tree: await getPageTree(db, orgId) });
        return;
      }
      res.json({
        orgId,
        pages: await listPages(db, orgId, {
          parentPageId: req.body?.parentPageId,
          includeArchived: Boolean(req.body?.includeArchived),
        }),
      });
    }),
  );

  app.post(
    '/api/tools/pages/get',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:get');
      if (!grant) return;
      const orgs = await listOrganizationsForUser(directory(), 'user-local-owner');
      const orgId = (req.body?.orgId as string) || orgs[0]?.id;
      if (!orgId) throw new WorkspaceDataError('ORG_NOT_FOUND', 404, 'no organization to act in');
      const pageId = String(req.body?.pageId ?? '');
      if (!pageId) throw new WorkspaceDataError('PAGE_NOT_FOUND', 404, 'pageId required');
      res.json({ page: await getPage(manager.workspaceExecutor(orgId), orgId, pageId) });
    }),
  );

  app.post(
    '/api/tools/pages/upsert',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:upsert');
      if (!grant) return;
      const orgs = await listOrganizationsForUser(directory(), 'user-local-owner');
      const orgId = (req.body?.orgId as string) || orgs[0]?.id;
      if (!orgId) throw new WorkspaceDataError('ORG_NOT_FOUND', 404, 'no organization to act in');
      const page = await upsertPageFromAgent(
        manager.workspaceExecutor(orgId),
        orgId,
        grant.runId,
        {
          pageId: req.body?.pageId,
          title: req.body?.title,
          parentPageId: req.body?.parentPageId,
          icon: req.body?.icon,
          cover: req.body?.cover,
          blocks: req.body?.blocks,
        },
      );
      res.json({ page });
    }),
  );

  async function toolOrgId(req: Request): Promise<string> {
    const orgs = await listOrganizationsForUser(directory(), 'user-local-owner');
    const orgId = (req.body?.orgId as string) || orgs[0]?.id;
    if (!orgId) throw new WorkspaceDataError('ORG_NOT_FOUND', 404, 'no organization to act in');
    return orgId;
  }

  app.post(
    '/api/tools/pages/search',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:search');
      if (!grant) return;
      const orgId = await toolOrgId(req);
      const query = String(req.body?.query ?? req.body?.q ?? '');
      const limit = typeof req.body?.limit === 'number' ? req.body.limit : 25;
      res.json({
        orgId,
        hits: await searchPages(manager.workspaceExecutor(orgId), orgId, query, limit),
      });
    }),
  );

  app.post(
    '/api/tools/pages/append',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:append');
      if (!grant) return;
      const orgId = await toolOrgId(req);
      const pageId = String(req.body?.pageId ?? '');
      if (!pageId) throw new WorkspaceDataError('PAGE_NOT_FOUND', 404, 'pageId required');
      const page = await appendPageBlocks(
        manager.workspaceExecutor(orgId),
        orgId,
        pageId,
        { blocks: req.body?.blocks ?? [] },
      );
      res.json({ page });
    }),
  );

  app.post(
    '/api/tools/pages/archive',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:archive');
      if (!grant) return;
      const orgId = await toolOrgId(req);
      const pageId = String(req.body?.pageId ?? '');
      if (!pageId) throw new WorkspaceDataError('PAGE_NOT_FOUND', 404, 'pageId required');
      const page = await archivePage(manager.workspaceExecutor(orgId), orgId, pageId);
      res.json({ page });
    }),
  );

  app.post(
    '/api/tools/pages/duplicate',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:duplicate');
      if (!grant) return;
      const orgId = await toolOrgId(req);
      const pageId = String(req.body?.pageId ?? '');
      if (!pageId) throw new WorkspaceDataError('PAGE_NOT_FOUND', 404, 'pageId required');
      const page = await duplicatePage(manager.workspaceExecutor(orgId), orgId, grant.runId, pageId, {
        recursive: Boolean(req.body?.recursive),
      });
      res.status(201).json({ page });
    }),
  );

  app.post(
    '/api/tools/pages/scaffold',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:scaffold');
      if (!grant) return;
      const orgId = await toolOrgId(req);
      const result = await scaffoldPages(manager.workspaceExecutor(orgId), orgId, grant.runId, {
        parentPageId: req.body?.parentPageId ?? null,
        pages: req.body?.pages ?? [],
      });
      res.status(201).json({ orgId, ...result });
    }),
  );

  app.post(
    '/api/tools/pages/embed',
    handle(async (req, res) => {
      const grant = authorizeToolRequest(req, res, 'pages:embed');
      if (!grant) return;
      const orgId = await toolOrgId(req);
      const pageId = String(req.body?.pageId ?? '');
      if (!pageId) throw new WorkspaceDataError('PAGE_NOT_FOUND', 404, 'pageId required');
      const page = await embedInPage(manager.workspaceExecutor(orgId), orgId, pageId, {
        type: req.body?.type,
        targetPageId: req.body?.targetPageId,
        tableId: req.body?.tableId,
        recordId: req.body?.recordId,
        path: req.body?.path,
        url: req.body?.url,
      });
      res.json({ page });
    }),
  );
}

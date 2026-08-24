// Organization-wide natural-language search.
//
// GET /api/orgs/:orgId/find?q= — every surface the caller can see, filtered
// by the reporting chain (self, people above, people below).

import type { Express, Request as ExpressRequest, Response } from 'express';
import { createApiError } from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
} from '../workspace-data/tenancy.js';
import { searchOrganization } from '../workspace-data/org-search.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';

export interface OrgSearchRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
}

export interface RegisterOrgSearchRoutesDeps extends RouteDeps<'db' | 'paths'> {
  orgSearch: OrgSearchRouteServices;
}

export function registerOrgSearchRoutes(app: Express, ctx: RegisterOrgSearchRoutesDeps) {
  const { manager, identity } = ctx.orgSearch;
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

  app.get(
    '/api/orgs/:orgId/find',
    handle(async (req, res) => {
      const orgId = param(req, 'orgId');
      const viewer = await identity.resolveViewer(req, directory());
      if (!viewer) throw new WorkspaceDataError('UNAUTHORIZED', 401, 'sign in to continue');
      await getOrganization(directory(), orgId);
      const member = assertMemberRole(
        await getActiveMemberForUser(directory(), orgId, viewer.userId),
        'member',
        orgId,
      );
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const limit = req.query.limit ? Number(req.query.limit) : 25;
      const hits = await searchOrganization({
        manager,
        projectsDb: ctx.db,
        projectsRoot: ctx.paths.PROJECTS_DIR,
        orgId,
        viewer: { memberId: member.id, userId: viewer.userId, role: member.role },
        query,
        limit: Number.isFinite(limit) ? limit : 25,
      });
      res.json({ query, hits });
    }),
  );
}

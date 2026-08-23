// Organization calendar over HTTP — local events + Google Calendar sync.
//
// Same membership scoping as pages / team chat. People use
// /api/orgs/:orgId/calendar/*; Google sync talks to Composio when connected.

import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  createApiError,
  type UpsertCalendarEventRequest,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import type { RouteDeps } from '../server-context.js';
import type { IdentityService } from '../auth/identity.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';
import type { ConnectorService } from '../connectors/service.js';
import { WorkspaceDataError } from '../workspace-data/errors.js';
import {
  assertMemberRole,
  getActiveMemberForUser,
  getOrganization,
} from '../workspace-data/tenancy.js';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  getCalendarSyncMeta,
  listCalendarEvents,
  setCalendarSyncMeta,
  updateCalendarEvent,
  upsertGoogleCalendarEvent,
} from '../workspace-data/calendar.js';
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  listGoogleCalendarEvents,
  patchGoogleCalendarEvent,
} from '../workspace-data/google-calendar-composio.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';
const GOOGLE_CONNECTOR_ID = 'googlecalendar';

export interface CalendarRouteServices {
  manager: WorkspaceDbManager;
  identity: IdentityService;
  connectors: ConnectorService;
}

export interface RegisterCalendarRoutesDeps extends RouteDeps<'db' | 'auth'> {
  calendar: CalendarRouteServices;
}

function asUpsertBody(value: unknown): UpsertCalendarEventRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'request body is required');
  }
  return value as UpsertCalendarEventRequest;
}

export function registerCalendarRoutes(app: Express, ctx: RegisterCalendarRoutesDeps) {
  const { manager, identity, connectors } = ctx.calendar;
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
    sendApiError(res, 500, createApiError('INTERNAL_ERROR', String((err as Error)?.message ?? err)));
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

  function googleConnected(): boolean {
    try {
      return Boolean(connectors.getCredential(GOOGLE_CONNECTOR_ID)?.credentials);
    } catch {
      return false;
    }
  }

  function googleCredentials() {
    return connectors.getCredential(GOOGLE_CONNECTOR_ID)?.credentials;
  }

  app.get(
    '/api/orgs/:orgId/calendar/events',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const range: { from?: string; to?: string } = {};
      if (typeof req.query.from === 'string') range.from = req.query.from;
      if (typeof req.query.to === 'string') range.to = req.query.to;
      res.json({
        events: await listCalendarEvents(db, orgId, range),
        googleConnected: googleConnected(),
        lastSyncedAt: await getCalendarSyncMeta(db, orgId),
      });
    }),
  );

  app.post(
    '/api/orgs/:orgId/calendar/events',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const body = asUpsertBody(req.body);
      let googleEventId: string | null = null;
      if (body.syncToGoogle !== false && googleConnected()) {
        googleEventId = await createGoogleCalendarEvent(googleCredentials(), {
          title: body.title,
          description: body.description ?? null,
          location: body.location ?? null,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          allDay: Boolean(body.allDay),
        });
      }
      const event = await createCalendarEvent(db, orgId, member.userId, body, {
        googleEventId,
        source: googleEventId ? 'google' : 'local',
      });
      res.status(201).json({ event });
    }),
  );

  app.patch(
    '/api/orgs/:orgId/calendar/events/:eventId',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const body = asUpsertBody(req.body);
      const existing = await getCalendarEvent(db, orgId, param(req, 'eventId'));
      if (!existing) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar event not found');
      if (existing.googleEventId && googleConnected() && body.syncToGoogle !== false) {
        try {
          await patchGoogleCalendarEvent(googleCredentials(), existing.googleEventId, {
            title: body.title,
            description: body.description ?? null,
            location: body.location ?? null,
            startsAt: body.startsAt,
            endsAt: body.endsAt,
            allDay: Boolean(body.allDay),
          });
        } catch (err) {
          throw new WorkspaceDataError(
            'CONNECTOR_EXECUTION_FAILED',
            502,
            err instanceof Error ? err.message : 'Google Calendar update failed',
          );
        }
      }
      const event = await updateCalendarEvent(db, orgId, param(req, 'eventId'), body);
      res.json({ event });
    }),
  );

  app.delete(
    '/api/orgs/:orgId/calendar/events/:eventId',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const existing = await getCalendarEvent(db, orgId, param(req, 'eventId'));
      if (existing?.googleEventId && googleConnected()) {
        await deleteGoogleCalendarEvent(googleCredentials(), existing.googleEventId);
      }
      await deleteCalendarEvent(db, orgId, param(req, 'eventId'));
      res.status(204).end();
    }),
  );

  app.post(
    '/api/orgs/:orgId/calendar/google/sync',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      if (!googleConnected()) {
        throw new WorkspaceDataError(
          'CONNECTOR_NOT_CONNECTED',
          400,
          'Connect Google Calendar under Integrations first',
        );
      }
      const now = new Date();
      const timeMin = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const timeMax = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
      let imported = 0;
      try {
        const items = await listGoogleCalendarEvents(googleCredentials(), { timeMin, timeMax });
        for (const item of items) {
          await upsertGoogleCalendarEvent(db, orgId, member.userId, {
            title: item.title,
            description: item.description,
            location: item.location,
            startsAt: item.startsAt,
            endsAt: item.endsAt,
            allDay: item.allDay,
            googleEventId: item.id,
          });
          imported += 1;
        }
      } catch (err) {
        throw new WorkspaceDataError(
          'CONNECTOR_EXECUTION_FAILED',
          502,
          err instanceof Error ? err.message : 'Google Calendar sync failed',
        );
      }
      const lastSyncedAt = Date.now();
      await setCalendarSyncMeta(db, orgId, lastSyncedAt);
      res.json({
        imported,
        events: await listCalendarEvents(db, orgId),
        lastSyncedAt,
      });
    }),
  );
}

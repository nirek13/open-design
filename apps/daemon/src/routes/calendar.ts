// Organization calendar over HTTP — named calendars, local events, Google / Notion / Apple import.
//
// Same membership scoping as pages / team chat. People use
// /api/orgs/:orgId/calendar/*; Google and Notion sync talk to Composio when connected.

import type { Express, Request as ExpressRequest, Response } from 'express';
import {
  createApiError,
  type ImportCalendarRequest,
  type PatchOrgCalendarRequest,
  type UpsertCalendarBookingTypeRequest,
  type UpsertCalendarEventRequest,
  type UpsertOrgCalendarRequest,
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
  getOrgTeam,
  getOrganization,
  getUser,
  listOrgMembers,
  listOrgTeams,
} from '../workspace-data/tenancy.js';
import {
  createCalendarEvent,
  createOrgCalendar,
  deleteCalendarEvent,
  deleteOrgCalendar,
  ensureDefaultCalendar,
  ensurePersonalCalendar,
  getCalendarEvent,
  getCalendarSyncMeta,
  getOrCreateSourceCalendar,
  listCalendarEvents,
  listCalendars,
  setCalendarSyncMeta,
  teamUserIds,
  updateCalendarEvent,
  updateOrgCalendar,
  upsertGoogleCalendarEvent,
  upsertImportedEvent,
  type CalendarPeopleContext,
} from '../workspace-data/calendar.js';
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  listGoogleCalendarEvents,
  patchGoogleCalendarEvent,
} from '../workspace-data/google-calendar-composio.js';
import { listNotionCalendarEvents } from '../workspace-data/notion-calendar-composio.js';
import { fetchIcsFromUrl, googleCalendarTemplateUrl, parseIcs, serializeIcsInvite } from '../workspace-data/ics.js';
import {
  assertSlotOpen,
  createBookingType,
  listBookingTypes,
  loadPublicBookingType,
  normalizeGuest,
  recordBooking,
  resolveBookingToken,
  revokeBookingType,
  slotsForBookingType,
} from '../workspace-data/calendar-booking.js';
import { browserFacingOrigin } from '../origin-validation.js';

type Request = ExpressRequest<Record<string, string>>;

const param = (req: Request, name: string): string => req.params[name] ?? '';
const GOOGLE_CONNECTOR_ID = 'googlecalendar';
const NOTION_CONNECTOR_ID = 'notion';

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

function asCalendarBody(value: unknown): UpsertOrgCalendarRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'request body is required');
  }
  return value as UpsertOrgCalendarRequest;
}

function asPatchCalendarBody(value: unknown): PatchOrgCalendarRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'request body is required');
  }
  return value as PatchOrgCalendarRequest;
}

function asImportBody(value: unknown): ImportCalendarRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'request body is required');
  }
  const body = value as ImportCalendarRequest;
  if (body.source !== 'google' && body.source !== 'notion' && body.source !== 'apple') {
    throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, 'source must be google, notion, or apple');
  }
  return body;
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

  function connectorConnected(id: string): boolean {
    try {
      return Boolean(connectors.getCredential(id)?.credentials);
    } catch {
      return false;
    }
  }

  function connectorCredentials(id: string) {
    return connectors.getCredential(id)?.credentials;
  }

  async function peopleContext(orgId: string, filterUserId?: string): Promise<CalendarPeopleContext> {
    const [teams, members] = await Promise.all([
      listOrgTeams(directory(), orgId),
      listOrgMembers(directory(), orgId),
    ]);
    const userIdsByTeamId = teamUserIds(teams, members);
    return filterUserId ? { userIdsByTeamId, filterUserId } : { userIdsByTeamId };
  }

  async function assertGuests(orgId: string, body: UpsertCalendarEventRequest): Promise<void> {
    for (const userId of body.guestUserIds ?? []) {
      const member = await getActiveMemberForUser(directory(), orgId, userId);
      if (!member) {
        throw new WorkspaceDataError('WORKSPACE_VALIDATION_FAILED', 422, `guest ${userId} is not an org member`);
      }
    }
    for (const teamId of body.guestTeamIds ?? []) {
      await getOrgTeam(directory(), orgId, teamId);
    }
  }

  async function snapshot(
    db: ReturnType<WorkspaceDbManager['workspaceExecutor']>,
    orgId: string,
    range?: { from?: string; to?: string },
    filterUserId?: string,
  ) {
    const people = await peopleContext(orgId, filterUserId);
    const [events, calendars, lastSyncedAt] = await Promise.all([
      listCalendarEvents(db, orgId, range ? { ...range, expand: true } : { expand: false }, people),
      listCalendars(db, orgId),
      getCalendarSyncMeta(db, orgId),
    ]);
    return {
      events,
      calendars,
      googleConnected: connectorConnected(GOOGLE_CONNECTOR_ID),
      notionConnected: connectorConnected(NOTION_CONNECTOR_ID),
      lastSyncedAt,
    };
  }

  app.get(
    '/api/orgs/:orgId/calendar/events',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      await ensurePersonalCalendar(db, orgId, member.userId);
      const range: { from?: string; to?: string } = {};
      if (typeof req.query.from === 'string') range.from = req.query.from;
      if (typeof req.query.to === 'string') range.to = req.query.to;
      const filterUserId = typeof req.query.user === 'string' && req.query.user.trim()
        ? req.query.user.trim()
        : undefined;
      res.json(await snapshot(db, orgId, range, filterUserId));
    }),
  );

  app.get(
    '/api/orgs/:orgId/calendar/calendars',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      await ensurePersonalCalendar(db, orgId, member.userId);
      res.json({ calendars: await listCalendars(db, orgId) });
    }),
  );

  app.post(
    '/api/orgs/:orgId/calendar/calendars',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const body = asCalendarBody(req.body);
      if (body.kind === 'team' && body.teamId) {
        await getOrgTeam(directory(), orgId, body.teamId);
      }
      const calendar = await createOrgCalendar(db, orgId, body, { ownerUserId: member.userId });
      res.status(201).json({ calendar });
    }),
  );

  app.patch(
    '/api/orgs/:orgId/calendar/calendars/:calendarId',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const calendar = await updateOrgCalendar(db, orgId, param(req, 'calendarId'), asPatchCalendarBody(req.body));
      res.json({ calendar });
    }),
  );

  app.delete(
    '/api/orgs/:orgId/calendar/calendars/:calendarId',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      await deleteOrgCalendar(db, orgId, param(req, 'calendarId'));
      res.status(204).end();
    }),
  );

  app.get(
    '/api/orgs/:orgId/calendar/events/:eventId',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const people = await peopleContext(orgId);
      const event = await getCalendarEvent(db, orgId, param(req, 'eventId'), people);
      if (!event) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar event not found');
      res.json({ event });
    }),
  );

  app.post(
    '/api/orgs/:orgId/calendar/events',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const body = asUpsertBody(req.body);
      await assertGuests(orgId, body);
      let googleEventId: string | null = null;
      if (body.syncToGoogle !== false && connectorConnected(GOOGLE_CONNECTOR_ID)) {
        googleEventId = await createGoogleCalendarEvent(connectorCredentials(GOOGLE_CONNECTOR_ID), {
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
      await assertGuests(orgId, body);
      const existing = await getCalendarEvent(db, orgId, param(req, 'eventId'));
      if (!existing) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar event not found');
      if (existing.googleEventId && connectorConnected(GOOGLE_CONNECTOR_ID) && body.syncToGoogle !== false) {
        try {
          await patchGoogleCalendarEvent(connectorCredentials(GOOGLE_CONNECTOR_ID), existing.googleEventId, {
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
      if (existing?.googleEventId && connectorConnected(GOOGLE_CONNECTOR_ID)) {
        await deleteGoogleCalendarEvent(connectorCredentials(GOOGLE_CONNECTOR_ID), existing.googleEventId);
      }
      await deleteCalendarEvent(db, orgId, param(req, 'eventId'));
      res.status(204).end();
    }),
  );

  app.post(
    '/api/orgs/:orgId/calendar/google/sync',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const imported = await syncGoogle(db, orgId, member.userId);
      const lastSyncedAt = Date.now();
      await setCalendarSyncMeta(db, orgId, lastSyncedAt);
      const snap = await snapshot(db, orgId);
      res.json({ imported, calendarId: undefined, ...snap, lastSyncedAt });
    }),
  );

  app.post(
    '/api/orgs/:orgId/calendar/notion/sync',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { databaseId?: string };
      const imported = await syncNotion(db, orgId, member.userId, body.databaseId);
      const lastSyncedAt = Date.now();
      await setCalendarSyncMeta(db, orgId, lastSyncedAt);
      const snap = await snapshot(db, orgId);
      res.json({ imported, ...snap, lastSyncedAt });
    }),
  );

  app.post(
    '/api/orgs/:orgId/calendar/import',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const body = asImportBody(req.body);
      let imported = 0;
      let calendarId: string | undefined;
      if (body.source === 'google') {
        imported = await syncGoogle(db, orgId, member.userId);
      } else if (body.source === 'notion') {
        imported = await syncNotion(db, orgId, member.userId, body.databaseId);
      } else {
        const result = await importApple(db, orgId, member.userId, body);
        imported = result.imported;
        calendarId = result.calendarId;
      }
      const lastSyncedAt = Date.now();
      await setCalendarSyncMeta(db, orgId, lastSyncedAt);
      const snap = await snapshot(db, orgId);
      res.json({ imported, calendarId, ...snap, lastSyncedAt });
    }),
  );

  app.get(
    '/api/orgs/:orgId/calendar/booking-types',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      await ensurePersonalCalendar(db, orgId, member.userId);
      res.json({
        bookingTypes: await listBookingTypes(db, orgId, member.userId, browserFacingOrigin(req)),
      });
    }),
  );

  app.post(
    '/api/orgs/:orgId/calendar/booking-types',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as UpsertCalendarBookingTypeRequest;
      const created = await createBookingType(
        db,
        directory(),
        orgId,
        member.userId,
        body,
        browserFacingOrigin(req),
      );
      res.status(201).json(created);
    }),
  );

  app.delete(
    '/api/orgs/:orgId/calendar/booking-types/:bookingTypeId',
    handle(async (req, res) => {
      const { orgId, member, db } = await scope(req);
      await revokeBookingType(db, directory(), orgId, member.userId, param(req, 'bookingTypeId'));
      res.status(204).end();
    }),
  );

  app.get(
    '/api/orgs/:orgId/calendar/events/:eventId/invite.ics',
    handle(async (req, res) => {
      const { orgId, db } = await scope(req);
      const people = await peopleContext(orgId);
      const event = await getCalendarEvent(db, orgId, param(req, 'eventId'), people);
      if (!event) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar event not found');
      const host = await getUser(directory(), event.createdBy);
      const invite = {
        uid: event.externalUid || event.id,
        title: event.title,
        description: event.description,
        location: event.location,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        organizerName: host?.displayName ?? null,
        organizerEmail: host?.email ?? null,
      };
      if ((req.query.format as string | undefined) === 'json') {
        res.json({
          ics: serializeIcsInvite(invite),
          googleUrl: googleCalendarTemplateUrl(invite),
        });
        return;
      }
      res.setHeader('content-type', 'text/calendar; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${event.id}.ics"`);
      res.send(serializeIcsInvite(invite));
    }),
  );

  async function publicBooking(req: Request) {
    const resolved = await resolveBookingToken(directory(), param(req, 'token'));
    if (!resolved) throw new WorkspaceDataError('NOT_FOUND', 404, 'booking link not found');
    const db = manager.workspaceExecutor(resolved.orgId);
    const type = await loadPublicBookingType(db, resolved.orgId, resolved.bookingTypeId);
    if (!type) throw new WorkspaceDataError('NOT_FOUND', 404, 'booking link not found');
    const host = await getUser(directory(), type.ownerUserId);
    return { ...resolved, db, type, host };
  }

  app.get(
    '/api/book/:token',
    handle(async (req, res) => {
      const { type, host } = await publicBooking(req);
      res.json({
        title: type.title,
        description: type.description,
        location: type.location,
        durationMinutes: type.durationMinutes,
        hostName: host?.displayName || 'Host',
        availability: type.availability,
      });
    }),
  );

  app.get(
    '/api/book/:token/slots',
    handle(async (req, res) => {
      const { orgId, db, type } = await publicBooking(req);
      const from = typeof req.query.from === 'string' && req.query.from.trim()
        ? req.query.from.trim()
        : new Date().toISOString().slice(0, 10);
      const to = typeof req.query.to === 'string' && req.query.to.trim()
        ? req.query.to.trim()
        : new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
      const people = await peopleContext(orgId, type.ownerUserId);
      res.json({ slots: await slotsForBookingType(db, orgId, type, { from, to }, people) });
    }),
  );

  app.post(
    '/api/book/:token',
    handle(async (req, res) => {
      const { orgId, db, type, host } = await publicBooking(req);
      const guest = normalizeGuest(req.body ?? {});
      const people = await peopleContext(orgId, type.ownerUserId);
      const from = guest.startsAt.slice(0, 10);
      const toDate = new Date(`${from}T00:00:00Z`);
      toDate.setUTCDate(toDate.getUTCDate() + 2);
      const slots = await slotsForBookingType(
        db,
        orgId,
        type,
        { from, to: toDate.toISOString().slice(0, 10) },
        people,
      );
      const slot = assertSlotOpen(type, guest.startsAt, slots);
      let googleEventId: string | null = null;
      if (connectorConnected(GOOGLE_CONNECTOR_ID)) {
        googleEventId = await createGoogleCalendarEvent(connectorCredentials(GOOGLE_CONNECTOR_ID), {
          title: type.title,
          description: [type.description, `Booked by ${guest.name} <${guest.email}>`].filter(Boolean).join('\n\n'),
          location: type.location,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          allDay: false,
        });
      }
      const event = await createCalendarEvent(db, orgId, type.ownerUserId, {
        title: type.title,
        description: type.description,
        location: type.location,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        calendarId: type.calendarId,
        attendees: `${guest.name} <${guest.email}>`,
        timezone: type.availability.timezone,
        syncToGoogle: false,
      }, {
        googleEventId,
        source: googleEventId ? 'google' : 'local',
      });
      await recordBooking(db, orgId, type.id, event.id, {
        name: guest.name,
        email: guest.email,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      });
      const invite = {
        uid: event.id,
        title: type.title,
        description: type.description,
        location: type.location,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        organizerName: host?.displayName ?? null,
        organizerEmail: host?.email ?? null,
        attendeeName: guest.name,
        attendeeEmail: guest.email,
      };
      res.status(201).json({
        title: type.title,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        location: type.location,
        hostName: host?.displayName || 'Host',
        ics: serializeIcsInvite(invite),
        googleUrl: googleCalendarTemplateUrl(invite),
      });
    }),
  );

  async function syncGoogle(
    db: ReturnType<WorkspaceDbManager['workspaceExecutor']>,
    orgId: string,
    userId: string,
  ): Promise<number> {
    if (!connectorConnected(GOOGLE_CONNECTOR_ID)) {
      throw new WorkspaceDataError(
        'CONNECTOR_NOT_CONNECTED',
        400,
        'Connect Google Calendar under Integrations first',
      );
    }
    await ensureDefaultCalendar(db, orgId);
    const calendar = await getOrCreateSourceCalendar(db, orgId, 'google', 'Google Calendar', {
      externalId: 'primary',
    });
    const now = new Date();
    const timeMin = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
    let imported = 0;
    try {
      const items = await listGoogleCalendarEvents(connectorCredentials(GOOGLE_CONNECTOR_ID), { timeMin, timeMax });
      for (const item of items) {
        await upsertGoogleCalendarEvent(db, orgId, userId, {
          title: item.title,
          description: item.description,
          location: item.location,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
          allDay: item.allDay,
          googleEventId: item.id,
          calendarId: calendar.id,
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
    return imported;
  }

  async function syncNotion(
    db: ReturnType<WorkspaceDbManager['workspaceExecutor']>,
    orgId: string,
    userId: string,
    databaseId?: string,
  ): Promise<number> {
    if (!connectorConnected(NOTION_CONNECTOR_ID)) {
      throw new WorkspaceDataError(
        'CONNECTOR_NOT_CONNECTED',
        400,
        'Connect Notion under Integrations first',
      );
    }
    await ensureDefaultCalendar(db, orgId);
    let imported = 0;
    try {
      const items = await listNotionCalendarEvents(
        connectorCredentials(NOTION_CONNECTOR_ID),
        databaseId ? { databaseId } : undefined,
      );
      for (const item of items) {
        const calendar = await getOrCreateSourceCalendar(
          db,
          orgId,
          'notion',
          item.databaseName || 'Notion',
          { externalId: item.databaseId || databaseId || 'notion' },
        );
        await upsertImportedEvent(db, orgId, userId, {
          title: item.title,
          description: item.description,
          location: item.location,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
          allDay: item.allDay,
          source: 'notion',
          calendarId: calendar.id,
          externalUid: item.id,
        });
        imported += 1;
      }
    } catch (err) {
      throw new WorkspaceDataError(
        'CONNECTOR_EXECUTION_FAILED',
        502,
        err instanceof Error ? err.message : 'Notion calendar sync failed',
      );
    }
    return imported;
  }

  async function importApple(
    db: ReturnType<WorkspaceDbManager['workspaceExecutor']>,
    orgId: string,
    userId: string,
    body: ImportCalendarRequest,
  ): Promise<{ imported: number; calendarId: string }> {
    let ics = body.ics?.trim() ?? '';
    if (!ics && body.icsUrl?.trim()) {
      try {
        ics = await fetchIcsFromUrl(body.icsUrl.trim());
      } catch (err) {
        throw new WorkspaceDataError(
          'CONNECTOR_EXECUTION_FAILED',
          502,
          err instanceof Error ? err.message : 'Could not download the calendar URL',
        );
      }
    }
    if (!ics) {
      throw new WorkspaceDataError(
        'WORKSPACE_VALIDATION_FAILED',
        422,
        'Paste an .ics export or a public Apple Calendar / iCloud URL',
      );
    }
    let parsed;
    try {
      parsed = parseIcs(ics);
    } catch (err) {
      throw new WorkspaceDataError(
        'WORKSPACE_VALIDATION_FAILED',
        422,
        err instanceof Error ? err.message : 'Could not parse the .ics file',
      );
    }
    const calendar = await getOrCreateSourceCalendar(
      db,
      orgId,
      'apple',
      body.name?.trim() || parsed.name || 'Apple Calendar',
      {
        ...(body.color ? { color: body.color } : {}),
        externalId: body.icsUrl?.trim() || parsed.name || 'apple',
        icsUrl: body.icsUrl?.trim() || null,
      },
    );
    let imported = 0;
    for (const item of parsed.events) {
      await upsertImportedEvent(db, orgId, userId, {
        title: item.title,
        description: item.description,
        location: item.location,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        allDay: item.allDay,
        recurrence: item.recurrence,
        timezone: item.timezone,
        attendees: item.attendees,
        source: 'apple',
        calendarId: calendar.id,
        externalUid: item.uid,
      });
      imported += 1;
    }
    return { imported, calendarId: calendar.id };
  }
}

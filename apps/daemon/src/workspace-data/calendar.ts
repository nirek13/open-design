// Organization calendar events — named calendars, local CRUD, and Google / Notion / Apple import.

import { randomUUID } from 'node:crypto';
import type {
  CalendarEvent,
  CalendarKind,
  CalendarSource,
  OrgCalendar,
  PatchOrgCalendarRequest,
  UpsertCalendarEventRequest,
  UpsertOrgCalendarRequest,
} from '@open-design/contracts';
import { CALENDAR_COLOR_PALETTE } from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';
import { expandRecurrence } from './recurrence.js';

const DEFAULT_COLOR = CALENDAR_COLOR_PALETTE[0];

const EVENT_COLS = `
  id, workspace_id AS "orgId", calendar_id AS "calendarId", title, description, location,
  starts_at AS "startsAt", ends_at AS "endsAt", all_day AS "allDay",
  color, recurrence, timezone, attendees,
  google_event_id AS "googleEventId", external_uid AS "externalUid",
  source, created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const CALENDAR_COLS = `
  id, workspace_id AS "orgId", name, color, source, kind, visible,
  owner_user_id AS "ownerUserId", team_id AS "teamId",
  external_id AS "externalId", ics_url AS "icsUrl",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export interface CalendarPeopleContext {
  /** Directory user ids for each org team. */
  userIdsByTeamId: Map<string, string[]>;
  /** When set, listCalendarEvents keeps only events on this person's schedule. */
  filterUserId?: string;
}

interface EventRow {
  id: string;
  orgId: string;
  calendarId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: number | boolean;
  color: string | null;
  recurrence: string | null;
  timezone: string | null;
  attendees: string | null;
  googleEventId: string | null;
  externalUid: string | null;
  source: string;
  createdBy: string;
  createdAt: number | string;
  updatedAt: number | string;
}

interface CalendarRow {
  id: string;
  orgId: string;
  name: string;
  color: string;
  source: string;
  kind: string | null;
  visible: number | boolean;
  ownerUserId: string | null;
  teamId: string | null;
  externalId: string | null;
  icsUrl: string | null;
  createdAt: number | string;
  updatedAt: number | string;
}

interface GuestRow {
  eventId: string;
  kind: string;
  subjectId: string;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function asSource(value: string | null | undefined): CalendarSource {
  if (value === 'google' || value === 'notion' || value === 'apple') return value;
  return 'local';
}

function asKind(value: string | null | undefined): CalendarKind {
  if (value === 'team' || value === 'personal') return value;
  return 'shared';
}

function uniqueIds(values: string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash + key.charCodeAt(i) * (i + 1)) % CALENDAR_COLOR_PALETTE.length;
  return CALENDAR_COLOR_PALETTE[hash] ?? DEFAULT_COLOR;
}

export function teamUserIds(
  teams: Array<{ id: string; memberIds: string[] }>,
  members: Array<{ id: string; userId: string }>,
): Map<string, string[]> {
  const userByMemberId = new Map(members.map((member) => [member.id, member.userId]));
  const grouped = new Map<string, string[]>();
  for (const team of teams) {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const memberId of team.memberIds) {
      const userId = userByMemberId.get(memberId);
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      ids.push(userId);
    }
    grouped.set(team.id, ids);
  }
  return grouped;
}

/** Directory user ids this event belongs on (creator, owner, guests, team members). */
export function scheduleUserIdsForEvent(
  event: Pick<CalendarEvent, 'createdBy' | 'guestUserIds' | 'guestTeamIds' | 'calendarId'>,
  calendar: OrgCalendar | null | undefined,
  userIdsByTeamId: Map<string, string[]>,
): string[] {
  const ids = new Set<string>();
  if (event.createdBy) ids.add(event.createdBy);
  for (const userId of event.guestUserIds) ids.add(userId);
  for (const teamId of event.guestTeamIds) {
    for (const userId of userIdsByTeamId.get(teamId) ?? []) ids.add(userId);
  }
  if (calendar?.kind === 'personal' && calendar.ownerUserId) ids.add(calendar.ownerUserId);
  if (calendar?.kind === 'team' && calendar.teamId) {
    for (const userId of userIdsByTeamId.get(calendar.teamId) ?? []) ids.add(userId);
  }
  return [...ids];
}

function mapCalendar(row: CalendarRow): OrgCalendar {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    color: row.color || DEFAULT_COLOR,
    source: asSource(row.source),
    kind: asKind(row.kind),
    ownerUserId: row.ownerUserId,
    teamId: row.teamId,
    visible: asBool(row.visible),
    externalId: row.externalId,
    icsUrl: row.icsUrl,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

function mapEvent(
  row: EventRow,
  calendar: OrgCalendar | null | undefined,
  guests: { userIds: string[]; teamIds: string[] },
  userIdsByTeamId: Map<string, string[]>,
): CalendarEvent {
  const source = asSource(row.source);
  const color = row.color || calendar?.color || DEFAULT_COLOR;
  const guestUserIds = guests.userIds;
  const guestTeamIds = guests.teamIds;
  const event = {
    id: row.id,
    orgId: row.orgId,
    calendarId: row.calendarId || calendar?.id || '',
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: asBool(row.allDay),
    color,
    recurrence: row.recurrence,
    timezone: row.timezone,
    attendees: row.attendees,
    guestUserIds,
    guestTeamIds,
    scheduleUserIds: [] as string[],
    googleEventId: row.googleEventId,
    externalUid: row.externalUid,
    source,
    instanceId: row.id,
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
  event.scheduleUserIds = scheduleUserIdsForEvent(event, calendar, userIdsByTeamId);
  return event;
}

function requireIso(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw workspaceValidationError([{ path: field, message: 'is required' }]);
  }
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.+-Z]+)?$/.test(trimmed)) {
    throw workspaceValidationError([{ path: field, message: 'must be an ISO date or datetime' }]);
  }
  return trimmed;
}

function normalizeColor(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return DEFAULT_COLOR;
}

function normalizeUpsert(input: UpsertCalendarEventRequest): {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  calendarId: string | null;
  color: string | null;
  recurrence: string | null;
  timezone: string | null;
  attendees: string | null;
  guestUserIds: string[] | undefined;
  guestTeamIds: string[] | undefined;
} {
  const title = input.title?.trim() ?? '';
  if (!title) {
    throw workspaceValidationError([{ path: 'title', message: 'is required' }]);
  }
  const startsAt = requireIso(input.startsAt, 'startsAt');
  const endsAt = requireIso(input.endsAt, 'endsAt');
  if (startsAt > endsAt) {
    throw workspaceValidationError([{ path: 'endsAt', message: 'must be on or after startsAt' }]);
  }
  return {
    title,
    description: input.description?.trim() ? input.description.trim() : null,
    location: input.location?.trim() ? input.location.trim() : null,
    startsAt,
    endsAt,
    allDay: Boolean(input.allDay),
    calendarId: input.calendarId?.trim() || null,
    color: input.color ? normalizeColor(input.color) : null,
    recurrence: input.recurrence?.trim() || null,
    timezone: input.timezone?.trim() || null,
    attendees: input.attendees?.trim() || null,
    guestUserIds: input.guestUserIds === undefined ? undefined : uniqueIds(input.guestUserIds),
    guestTeamIds: input.guestTeamIds === undefined ? undefined : uniqueIds(input.guestTeamIds),
  };
}

async function guestsForEvents(
  db: SqlExecutor,
  orgId: string,
  eventIds: string[],
): Promise<Map<string, { userIds: string[]; teamIds: string[] }>> {
  const grouped = new Map<string, { userIds: string[]; teamIds: string[] }>();
  for (const id of eventIds) grouped.set(id, { userIds: [], teamIds: [] });
  if (eventIds.length === 0) return grouped;
  const placeholders = eventIds.map(() => '?').join(', ');
  const rows = await db.all<GuestRow>(
    `SELECT event_id AS "eventId", kind, subject_id AS "subjectId"
     FROM od_calendar_event_guests
     WHERE workspace_id = ? AND event_id IN (${placeholders})
     ORDER BY created_at ASC`,
    [orgId, ...eventIds],
  );
  for (const row of rows) {
    const bucket = grouped.get(row.eventId);
    if (!bucket) continue;
    if (row.kind === 'team') bucket.teamIds.push(row.subjectId);
    else bucket.userIds.push(row.subjectId);
  }
  return grouped;
}

async function replaceEventGuests(
  db: SqlExecutor,
  orgId: string,
  eventId: string,
  guestUserIds: string[],
  guestTeamIds: string[],
): Promise<void> {
  await db.run(`DELETE FROM od_calendar_event_guests WHERE workspace_id = ? AND event_id = ?`, [orgId, eventId]);
  const now = Date.now();
  for (const userId of guestUserIds) {
    await db.run(
      `INSERT INTO od_calendar_event_guests (event_id, workspace_id, kind, subject_id, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
      [eventId, orgId, userId, now],
    );
  }
  for (const teamId of guestTeamIds) {
    await db.run(
      `INSERT INTO od_calendar_event_guests (event_id, workspace_id, kind, subject_id, created_at)
       VALUES (?, ?, 'team', ?, ?)`,
      [eventId, orgId, teamId, now],
    );
  }
}

export async function listCalendars(db: SqlExecutor, orgId: string): Promise<OrgCalendar[]> {
  await ensureDefaultCalendar(db, orgId);
  const rows = await db.all<CalendarRow>(
    `SELECT ${CALENDAR_COLS} FROM od_calendars WHERE workspace_id = ? ORDER BY created_at ASC`,
    [orgId],
  );
  return rows.map(mapCalendar);
}

export async function getCalendar(
  db: SqlExecutor,
  orgId: string,
  calendarId: string,
): Promise<OrgCalendar | null> {
  const row = await db.get<CalendarRow>(
    `SELECT ${CALENDAR_COLS} FROM od_calendars WHERE workspace_id = ? AND id = ?`,
    [orgId, calendarId],
  );
  return row ? mapCalendar(row) : null;
}

export async function ensureDefaultCalendar(db: SqlExecutor, orgId: string): Promise<OrgCalendar> {
  const existing = await db.get<CalendarRow>(
    `SELECT ${CALENDAR_COLS} FROM od_calendars WHERE workspace_id = ? AND source = 'local' AND kind = 'shared' ORDER BY created_at ASC`,
    [orgId],
  );
  if (existing) {
    await db.run(
      `UPDATE od_calendar_events SET calendar_id = ?
       WHERE workspace_id = ? AND (calendar_id IS NULL OR calendar_id = '')`,
      [existing.id, orgId],
    );
    return mapCalendar(existing);
  }
  const fallback = await db.get<CalendarRow>(
    `SELECT ${CALENDAR_COLS} FROM od_calendars WHERE workspace_id = ? AND source = 'local' ORDER BY created_at ASC`,
    [orgId],
  );
  if (fallback) {
    await db.run(
      `UPDATE od_calendar_events SET calendar_id = ?
       WHERE workspace_id = ? AND (calendar_id IS NULL OR calendar_id = '')`,
      [fallback.id, orgId],
    );
    return mapCalendar(fallback);
  }
  const now = Date.now();
  const id = randomUUID();
  await db.run(
    `INSERT INTO od_calendars (
      id, workspace_id, name, color, source, kind, visible, owner_user_id, team_id,
      external_id, ics_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'local', 'shared', 1, NULL, NULL, NULL, NULL, ?, ?)`,
    [id, orgId, 'Organization', DEFAULT_COLOR, now, now],
  );
  await db.run(
    `UPDATE od_calendar_events SET calendar_id = ?
     WHERE workspace_id = ? AND (calendar_id IS NULL OR calendar_id = '')`,
    [id, orgId],
  );
  const created = await getCalendar(db, orgId, id);
  if (!created) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to create default calendar');
  return created;
}

export async function ensurePersonalCalendar(
  db: SqlExecutor,
  orgId: string,
  userId: string,
): Promise<OrgCalendar> {
  const existing = await db.get<CalendarRow>(
    `SELECT ${CALENDAR_COLS} FROM od_calendars
     WHERE workspace_id = ? AND kind = 'personal' AND owner_user_id = ?`,
    [orgId, userId],
  );
  if (existing) return mapCalendar(existing);
  const now = Date.now();
  const id = randomUUID();
  await db.run(
    `INSERT INTO od_calendars (
      id, workspace_id, name, color, source, kind, visible, owner_user_id, team_id,
      external_id, ics_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'local', 'personal', 1, ?, NULL, NULL, NULL, ?, ?)`,
    [id, orgId, 'My calendar', colorForKey(userId), userId, now, now],
  );
  const created = await getCalendar(db, orgId, id);
  if (!created) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to create personal calendar');
  return created;
}

export async function getOrCreateSourceCalendar(
  db: SqlExecutor,
  orgId: string,
  source: Exclude<CalendarSource, 'local'>,
  name: string,
  extras?: { color?: string; externalId?: string | null; icsUrl?: string | null },
): Promise<OrgCalendar> {
  const externalId = extras?.externalId ?? source;
  const existing = await db.get<CalendarRow>(
    `SELECT ${CALENDAR_COLS} FROM od_calendars
     WHERE workspace_id = ? AND source = ? AND (external_id = ? OR (external_id IS NULL AND ? IS NULL))`,
    [orgId, source, externalId, extras?.externalId ?? null],
  );
  if (existing) {
    if (extras?.icsUrl && extras.icsUrl !== existing.icsUrl) {
      await db.run(
        `UPDATE od_calendars SET ics_url = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
        [extras.icsUrl, Date.now(), orgId, existing.id],
      );
    }
    return mapCalendar(existing);
  }
  const now = Date.now();
  const id = randomUUID();
  const colorIndex = source === 'google' ? 4 : source === 'notion' ? 0 : 2;
  await db.run(
    `INSERT INTO od_calendars (
      id, workspace_id, name, color, source, kind, visible, owner_user_id, team_id,
      external_id, ics_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'shared', 1, NULL, NULL, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      name.trim() || source,
      extras?.color ? normalizeColor(extras.color) : CALENDAR_COLOR_PALETTE[colorIndex],
      source,
      externalId,
      extras?.icsUrl ?? null,
      now,
      now,
    ],
  );
  const created = await getCalendar(db, orgId, id);
  if (!created) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to create calendar');
  return created;
}

export async function createOrgCalendar(
  db: SqlExecutor,
  orgId: string,
  input: UpsertOrgCalendarRequest,
  extras?: { ownerUserId?: string },
): Promise<OrgCalendar> {
  const name = input.name?.trim() ?? '';
  if (!name) throw workspaceValidationError([{ path: 'name', message: 'is required' }]);
  const kind = asKind(input.kind);
  const teamId = input.teamId?.trim() || null;
  if (kind === 'team' && !teamId) {
    throw workspaceValidationError([{ path: 'teamId', message: 'is required for a team calendar' }]);
  }
  if (kind === 'personal' && !extras?.ownerUserId) {
    throw workspaceValidationError([{ path: 'kind', message: 'personal calendars are created for the signed-in person' }]);
  }
  if (kind === 'personal' && extras?.ownerUserId) {
    return ensurePersonalCalendar(db, orgId, extras.ownerUserId);
  }
  const now = Date.now();
  const id = randomUUID();
  const color = kind === 'team' && teamId ? colorForKey(teamId) : normalizeColor(input.color);
  await db.run(
    `INSERT INTO od_calendars (
      id, workspace_id, name, color, source, kind, visible, owner_user_id, team_id,
      external_id, ics_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'local', ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
    [id, orgId, name, color, kind, input.visible === false ? 0 : 1, kind === 'team' ? teamId : null, now, now],
  );
  const created = await getCalendar(db, orgId, id);
  if (!created) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to create calendar');
  return created;
}

export async function updateOrgCalendar(
  db: SqlExecutor,
  orgId: string,
  calendarId: string,
  input: PatchOrgCalendarRequest,
): Promise<OrgCalendar> {
  const existing = await getCalendar(db, orgId, calendarId);
  if (!existing) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar not found');
  const name = input.name !== undefined ? input.name.trim() : existing.name;
  if (!name) throw workspaceValidationError([{ path: 'name', message: 'is required' }]);
  const color = input.color !== undefined ? normalizeColor(input.color) : existing.color;
  const visible = input.visible !== undefined ? input.visible : existing.visible;
  await db.run(
    `UPDATE od_calendars SET name = ?, color = ?, visible = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [name, color, visible ? 1 : 0, Date.now(), orgId, calendarId],
  );
  const updated = await getCalendar(db, orgId, calendarId);
  if (!updated) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to update calendar');
  return updated;
}

export async function deleteOrgCalendar(
  db: SqlExecutor,
  orgId: string,
  calendarId: string,
): Promise<void> {
  const existing = await getCalendar(db, orgId, calendarId);
  if (!existing) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar not found');
  await db.run(
    `DELETE FROM od_calendar_event_guests WHERE workspace_id = ? AND event_id IN (
      SELECT id FROM od_calendar_events WHERE workspace_id = ? AND calendar_id = ?
    )`,
    [orgId, orgId, calendarId],
  );
  await db.run(`DELETE FROM od_calendar_events WHERE workspace_id = ? AND calendar_id = ?`, [orgId, calendarId]);
  await db.run(`DELETE FROM od_calendars WHERE workspace_id = ? AND id = ?`, [orgId, calendarId]);
  await ensureDefaultCalendar(db, orgId);
}

async function calendarMap(db: SqlExecutor, orgId: string): Promise<Map<string, OrgCalendar>> {
  const calendars = await listCalendars(db, orgId);
  return new Map(calendars.map((calendar) => [calendar.id, calendar]));
}

function expandEvent(event: CalendarEvent, range?: { from?: string; to?: string }): CalendarEvent[] {
  if (!range?.from || !range.to || !event.recurrence) return [event];
  const occurrences = expandRecurrence(event.startsAt, event.endsAt, event.recurrence, {
    from: range.from,
    to: range.to,
  });
  return occurrences.map((occurrence) => ({
    ...event,
    startsAt: occurrence.startsAt,
    endsAt: occurrence.endsAt,
    instanceId: `${event.id}::${occurrence.startsAt}`,
  }));
}

export async function listCalendarEvents(
  db: SqlExecutor,
  orgId: string,
  range?: { from?: string; to?: string; expand?: boolean },
  people?: CalendarPeopleContext,
): Promise<CalendarEvent[]> {
  await ensureDefaultCalendar(db, orgId);
  const calendars = await calendarMap(db, orgId);
  const params: unknown[] = [orgId];
  let sql = `SELECT ${EVENT_COLS} FROM od_calendar_events WHERE workspace_id = ?`;
  if (range?.from && range.to && range.expand !== false) {
    // Recurring masters may start before the window; still load them and expand.
    sql += ' AND (recurrence IS NOT NULL OR (ends_at >= ? AND starts_at <= ?))';
    params.push(range.from, range.to);
  } else {
    if (range?.from) {
      sql += ' AND ends_at >= ?';
      params.push(range.from);
    }
    if (range?.to) {
      sql += ' AND starts_at <= ?';
      params.push(range.to);
    }
  }
  sql += ' ORDER BY starts_at ASC';
  const rows = await db.all<EventRow>(sql, params);
  const guests = await guestsForEvents(db, orgId, rows.map((row) => row.id));
  const userIdsByTeamId = people?.userIdsByTeamId ?? new Map();
  const mapped = rows.map((row) =>
    mapEvent(
      row,
      row.calendarId ? calendars.get(row.calendarId) : null,
      guests.get(row.id) ?? { userIds: [], teamIds: [] },
      userIdsByTeamId,
    ),
  );
  const expanded = range?.expand === false || !range?.from || !range.to
    ? mapped
    : mapped.flatMap((event) => expandEvent(event, range));
  if (!people?.filterUserId) return expanded;
  return expanded.filter((event) => event.scheduleUserIds.includes(people.filterUserId!));
}

export async function getCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  eventId: string,
  people?: CalendarPeopleContext,
): Promise<CalendarEvent | null> {
  const row = await db.get<EventRow>(
    `SELECT ${EVENT_COLS} FROM od_calendar_events WHERE workspace_id = ? AND id = ?`,
    [orgId, eventId],
  );
  if (!row) return null;
  const calendar = row.calendarId ? await getCalendar(db, orgId, row.calendarId) : null;
  const guests = await guestsForEvents(db, orgId, [row.id]);
  return mapEvent(
    row,
    calendar,
    guests.get(row.id) ?? { userIds: [], teamIds: [] },
    people?.userIdsByTeamId ?? new Map(),
  );
}

export async function createCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: UpsertCalendarEventRequest,
  extras?: {
    googleEventId?: string | null;
    externalUid?: string | null;
    source?: CalendarSource;
    calendarId?: string | null;
  },
): Promise<CalendarEvent> {
  const body = normalizeUpsert(input);
  const requestedId = extras?.calendarId || body.calendarId;
  const calendarId = requestedId || (await ensurePersonalCalendar(db, orgId, createdBy)).id;
  const calendar = await getCalendar(db, orgId, calendarId);
  if (!calendar) throw workspaceValidationError([{ path: 'calendarId', message: 'calendar not found' }]);
  const now = Date.now();
  const id = randomUUID();
  const source = extras?.source ?? calendar.source ?? 'local';
  await db.run(
    `INSERT INTO od_calendar_events (
      id, workspace_id, calendar_id, title, description, location, starts_at, ends_at,
      all_day, color, recurrence, timezone, attendees, google_event_id, external_uid,
      source, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      calendarId,
      body.title,
      body.description,
      body.location,
      body.startsAt,
      body.endsAt,
      body.allDay ? 1 : 0,
      body.color ?? calendar.color,
      body.recurrence,
      body.timezone,
      body.attendees,
      extras?.googleEventId ?? null,
      extras?.externalUid ?? extras?.googleEventId ?? null,
      source,
      createdBy,
      now,
      now,
    ],
  );
  await replaceEventGuests(db, orgId, id, body.guestUserIds ?? [], body.guestTeamIds ?? []);
  const created = await getCalendarEvent(db, orgId, id);
  if (!created) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to create calendar event');
  return created;
}

export async function updateCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  eventId: string,
  input: UpsertCalendarEventRequest,
  extras?: {
    googleEventId?: string | null;
    externalUid?: string | null;
    source?: CalendarSource;
    calendarId?: string | null;
  },
): Promise<CalendarEvent> {
  const existing = await getCalendarEvent(db, orgId, eventId);
  if (!existing) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar event not found');
  const body = normalizeUpsert(input);
  const calendarId = extras?.calendarId || body.calendarId || existing.calendarId;
  const calendar = calendarId ? await getCalendar(db, orgId, calendarId) : null;
  const now = Date.now();
  await db.run(
    `UPDATE od_calendar_events SET
      calendar_id = ?, title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?,
      all_day = ?, color = ?, recurrence = ?, timezone = ?, attendees = ?,
      google_event_id = ?, external_uid = ?, source = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      calendarId,
      body.title,
      body.description,
      body.location,
      body.startsAt,
      body.endsAt,
      body.allDay ? 1 : 0,
      body.color ?? calendar?.color ?? existing.color,
      body.recurrence,
      body.timezone,
      body.attendees,
      extras?.googleEventId !== undefined ? extras.googleEventId : existing.googleEventId,
      extras?.externalUid !== undefined ? extras.externalUid : existing.externalUid,
      extras?.source ?? existing.source,
      now,
      orgId,
      eventId,
    ],
  );
  await replaceEventGuests(
    db,
    orgId,
    eventId,
    body.guestUserIds ?? existing.guestUserIds,
    body.guestTeamIds ?? existing.guestTeamIds,
  );
  const updated = await getCalendarEvent(db, orgId, eventId);
  if (!updated) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to update calendar event');
  return updated;
}

export async function deleteCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  eventId: string,
): Promise<void> {
  const existing = await getCalendarEvent(db, orgId, eventId);
  if (!existing) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar event not found');
  await db.run(`DELETE FROM od_calendar_event_guests WHERE workspace_id = ? AND event_id = ?`, [orgId, eventId]);
  await db.run(
    `DELETE FROM od_calendar_events WHERE workspace_id = ? AND id = ?`,
    [orgId, eventId],
  );
}

export async function upsertImportedEvent(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: UpsertCalendarEventRequest & {
    source: CalendarSource;
    calendarId: string;
    externalUid: string;
    googleEventId?: string | null;
  },
): Promise<CalendarEvent> {
  const existing = await db.get<EventRow>(
    `SELECT ${EVENT_COLS} FROM od_calendar_events
     WHERE workspace_id = ? AND source = ? AND external_uid = ?`,
    [orgId, input.source, input.externalUid],
  );
  if (!existing && input.googleEventId) {
    const byGoogle = await db.get<EventRow>(
      `SELECT ${EVENT_COLS} FROM od_calendar_events
       WHERE workspace_id = ? AND google_event_id = ?`,
      [orgId, input.googleEventId],
    );
    if (byGoogle) {
      return updateCalendarEvent(db, orgId, byGoogle.id, input, {
        googleEventId: input.googleEventId,
        externalUid: input.externalUid,
        source: input.source,
        calendarId: input.calendarId,
      });
    }
  }
  if (existing) {
    return updateCalendarEvent(db, orgId, existing.id, input, {
      googleEventId: input.googleEventId ?? existing.googleEventId,
      externalUid: input.externalUid,
      source: input.source,
      calendarId: input.calendarId,
    });
  }
  return createCalendarEvent(db, orgId, createdBy, input, {
    googleEventId: input.googleEventId ?? null,
    externalUid: input.externalUid,
    source: input.source,
    calendarId: input.calendarId,
  });
}

export async function upsertGoogleCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: UpsertCalendarEventRequest & { googleEventId: string; calendarId?: string },
): Promise<CalendarEvent> {
  const calendar = input.calendarId
    ? await getCalendar(db, orgId, input.calendarId)
    : await getOrCreateSourceCalendar(db, orgId, 'google', 'Google Calendar');
  return upsertImportedEvent(db, orgId, createdBy, {
    ...input,
    source: 'google',
    calendarId: calendar?.id ?? (await ensureDefaultCalendar(db, orgId)).id,
    externalUid: input.googleEventId,
    googleEventId: input.googleEventId,
  });
}

export async function getCalendarSyncMeta(
  db: SqlExecutor,
  orgId: string,
): Promise<number | null> {
  const row = await db.get<{ value: string | null }>(
    `SELECT value FROM od_calendar_meta WHERE workspace_id = ? AND key = 'last_synced_at'`,
    [orgId],
  );
  if (!row?.value) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

export async function setCalendarSyncMeta(
  db: SqlExecutor,
  orgId: string,
  lastSyncedAt: number,
): Promise<void> {
  await db.run(
    `INSERT INTO od_calendar_meta (workspace_id, key, value)
     VALUES (?, 'last_synced_at', ?)
     ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value`,
    [orgId, String(lastSyncedAt)],
  );
}

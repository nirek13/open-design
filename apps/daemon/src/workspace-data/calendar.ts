// Organization calendar events — local CRUD with optional Google Calendar sync.

import { randomUUID } from 'node:crypto';
import type {
  CalendarEvent,
  UpsertCalendarEventRequest,
} from '@open-design/contracts';
import { WorkspaceDataError, workspaceValidationError } from './errors.js';
import type { SqlExecutor } from '../storage/sql.js';

const EVENT_COLS = `
  id, workspace_id AS "orgId", title, description, location,
  starts_at AS "startsAt", ends_at AS "endsAt", all_day AS "allDay",
  google_event_id AS "googleEventId", source, created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

interface EventRow {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: number | boolean;
  googleEventId: string | null;
  source: string;
  createdBy: string;
  createdAt: number | string;
  updatedAt: number | string;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function mapEvent(row: EventRow): CalendarEvent {
  const source = row.source === 'google' ? 'google' : 'local';
  return {
    id: row.id,
    orgId: row.orgId,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: asBool(row.allDay),
    googleEventId: row.googleEventId,
    source,
    createdBy: row.createdBy,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
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

function normalizeUpsert(input: UpsertCalendarEventRequest): {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
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
  };
}

export async function listCalendarEvents(
  db: SqlExecutor,
  orgId: string,
  range?: { from?: string; to?: string },
): Promise<CalendarEvent[]> {
  const params: unknown[] = [orgId];
  let sql = `SELECT ${EVENT_COLS} FROM od_calendar_events WHERE workspace_id = ?`;
  if (range?.from) {
    sql += ' AND ends_at >= ?';
    params.push(range.from);
  }
  if (range?.to) {
    sql += ' AND starts_at <= ?';
    params.push(range.to);
  }
  sql += ' ORDER BY starts_at ASC';
  const rows = await db.all<EventRow>(sql, params);
  return rows.map(mapEvent);
}

export async function getCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  eventId: string,
): Promise<CalendarEvent | null> {
  const row = await db.get<EventRow>(
    `SELECT ${EVENT_COLS} FROM od_calendar_events WHERE workspace_id = ? AND id = ?`,
    [orgId, eventId],
  );
  return row ? mapEvent(row) : null;
}

export async function createCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: UpsertCalendarEventRequest,
  extras?: { googleEventId?: string | null; source?: 'local' | 'google' },
): Promise<CalendarEvent> {
  const body = normalizeUpsert(input);
  const now = Date.now();
  const id = randomUUID();
  await db.run(
    `INSERT INTO od_calendar_events (
      id, workspace_id, title, description, location, starts_at, ends_at,
      all_day, google_event_id, source, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      body.title,
      body.description,
      body.location,
      body.startsAt,
      body.endsAt,
      body.allDay ? 1 : 0,
      extras?.googleEventId ?? null,
      extras?.source ?? 'local',
      createdBy,
      now,
      now,
    ],
  );
  const created = await getCalendarEvent(db, orgId, id);
  if (!created) throw new WorkspaceDataError('INTERNAL_ERROR', 500, 'failed to create calendar event');
  return created;
}

export async function updateCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  eventId: string,
  input: UpsertCalendarEventRequest,
  extras?: { googleEventId?: string | null; source?: 'local' | 'google' },
): Promise<CalendarEvent> {
  const existing = await getCalendarEvent(db, orgId, eventId);
  if (!existing) throw new WorkspaceDataError('NOT_FOUND', 404, 'calendar event not found');
  const body = normalizeUpsert(input);
  const now = Date.now();
  await db.run(
    `UPDATE od_calendar_events SET
      title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?,
      all_day = ?, google_event_id = ?, source = ?, updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      body.title,
      body.description,
      body.location,
      body.startsAt,
      body.endsAt,
      body.allDay ? 1 : 0,
      extras?.googleEventId !== undefined ? extras.googleEventId : existing.googleEventId,
      extras?.source ?? existing.source,
      now,
      orgId,
      eventId,
    ],
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
  await db.run(
    `DELETE FROM od_calendar_events WHERE workspace_id = ? AND id = ?`,
    [orgId, eventId],
  );
}

export async function upsertGoogleCalendarEvent(
  db: SqlExecutor,
  orgId: string,
  createdBy: string,
  input: UpsertCalendarEventRequest & { googleEventId: string },
): Promise<CalendarEvent> {
  const existing = await db.get<EventRow>(
    `SELECT ${EVENT_COLS} FROM od_calendar_events
     WHERE workspace_id = ? AND google_event_id = ?`,
    [orgId, input.googleEventId],
  );
  if (existing) {
    return updateCalendarEvent(db, orgId, existing.id, input, {
      googleEventId: input.googleEventId,
      source: 'google',
    });
  }
  return createCalendarEvent(db, orgId, createdBy, input, {
    googleEventId: input.googleEventId,
    source: 'google',
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
